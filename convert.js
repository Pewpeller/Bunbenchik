import { Command } from 'commander';
import sharp from 'sharp';
import { glob } from 'glob';
import path from 'path';
import fs from 'fs/promises';
import readline from 'readline';

const program = new Command();

program
	.name('bun run convert.js')
	.description('Конвертер изображений для фиксированной структуры папок')
	.option('--formats <list>', 'Кодировать в форматы через запятую (jpg, png, png8, webp, avif)')
	.option('--sizes <list>', 'Целевые ширины через запятую (e.g., 1600w,1200w,640w)')
	.option('--aspect <ratio>', 'Соотношение сторон холста (e.g., 16/9, 4/3, 1/1)')
	.option('--bg <color>', 'Цвет заливки полей для JPG при использовании --aspect', '#ffffff')
	.option('--upscale', 'Разрешить увеличение изображений, если они меньше целевой ширины', false)
	.option('--clean', 'Интерактивная очистка папок целевых размеров перед конвертацией или как отдельная команда', false)
	.parse(process.argv);

const options = program.opts();

// Жёстко зафиксированные папки внутри проекта
const BASE_SRC_DIR    = path.resolve('./public/src/img');
const BASE_OUTPUT_DIR = path.resolve('./public/img');

// Валидация: нужны либо --clean, либо оба --formats и --sizes
if (!options.clean && (!options.formats || !options.sizes)) {
	console.log('\n[!] Ошибка: Не указаны обязательные параметры --formats и --sizes (или флаг --clean).\n');
	program.outputHelp();
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Интерактивный вопрос в консоли, возвращает ответ строкой */
function askQuestion(query) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise(resolve => rl.question(query, ans => {
		rl.close();
		resolve(ans.trim().toLowerCase());
	}));
}

/** Парсит "#rrggbb" → { r, g, b, alpha } для sharp */
function parseBgColor(hex) {
	const c = hex.replace('#', '');
	if (c.length !== 6 || !/^[0-9a-f]+$/i.test(c)) {
		console.error(`[Ошибка] Неверный формат цвета фона: ${hex}. Используйте формат #rrggbb.`);
		process.exit(1);
	}
	return {
		r:     parseInt(c.slice(0, 2), 16),
		g:     parseInt(c.slice(2, 4), 16),
		b:     parseInt(c.slice(4, 6), 16),
		alpha: 1,
	};
}

/** Парсит "16/9" → число (соотношение ширины к высоте) */
function parseAspectRatio(aspectStr) {
	if (!aspectStr) return null;
	const parts = aspectStr.split('/');
	if (parts.length !== 2) {
		console.error(`[Ошибка] Неверный формат пропорции: ${aspectStr}. Используйте формат 16/9.`);
		process.exit(1);
	}
	const w = parseFloat(parts[0]);
	const h = parseFloat(parts[1]);
	if (isNaN(w) || isNaN(h) || h === 0) {
		console.error(`[Ошибка] Некорректные числа в пропорции: ${aspectStr}`);
		process.exit(1);
	}
	return w / h;
}

/** Парсит "1600w,1200w,640w" → [1600, 1200, 640] */
function parseSizes(sizesStr) {
	return sizesStr.split(',').map(s => {
		const val = parseInt(s.trim().replace(/w$/i, ''), 10);
		if (isNaN(val)) {
			console.error(`[Ошибка] Неверный размер: ${s}`);
			process.exit(1);
		}
		return val;
	});
}

/** Находит все существующие папки размеров вида "NNNw" в BASE_OUTPUT_DIR */
async function findExistingSizeFolders() {
	try {
		const items = await fs.readdir(BASE_OUTPUT_DIR, { withFileTypes: true });
		return items
			.filter(item => item.isDirectory() && /^\d+w$/.test(item.name))
			.map(item => item.name);
	} catch {
		return [];
	}
}

/** Безопасно удаляет только графические файлы из папок размеров,
 *  затем удаляет опустевшие папки */
async function cleanImageFilesOnly(folderNames) {
	const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

	for (const folderName of folderNames) {
		const sizeFolderPath = path.join(BASE_OUTPUT_DIR, folderName);

		try {
			await fs.access(sizeFolderPath);
		} catch {
			// Папки ещё нет — пропускаем
			continue;
		}

		const files = await glob(
			`${sizeFolderPath.replace(/\\/g, '/')}/**/*.*`,
			{ nodir: true }
		);

		let deletedCount  = 0;
		let skippedCount  = 0;

		for (const filePath of files) {
			const ext = path.extname(filePath).toLowerCase();
			if (allowedExtensions.has(ext)) {
				await fs.unlink(filePath);
				deletedCount++;
			} else {
				skippedCount++;
				console.warn(
					`  [ПРЕДУПРЕЖДЕНИЕ] Сторонний файл сохранён: ${path.relative(process.cwd(), filePath)}`
				);
			}
		}

		if (deletedCount > 0) {
			console.log(`  ${folderName}: удалено файлов: ${deletedCount}.`);
		}

		if (skippedCount === 0) {
			await fs.rm(sizeFolderPath, { recursive: true, force: true });
			console.log(`  Пустая директория ${folderName} удалена.`);
		} else {
			console.log(`  Директория ${folderName} не удалена — содержит сторонние файлы.`);
		}
	}
}

// ---------------------------------------------------------------------------
// Основной процесс
// ---------------------------------------------------------------------------

async function main() {
	console.log(`\n Исходники:      ${BASE_SRC_DIR}`);
	console.log(` Результат:      ${BASE_OUTPUT_DIR}\n`);

	// --- Очистка ---
	if (options.clean) {
		let foldersToClean;

		if (options.sizes) {
			foldersToClean = parseSizes(options.sizes).map(w => `${w}w`);
		} else {
			foldersToClean = await findExistingSizeFolders();
		}

		if (foldersToClean.length === 0) {
			console.log('Папки для очистки не обнаружены.\n');
			if (!options.formats) process.exit(0);
		} else {
			const answer = await askQuestion(
				`Удалить изображения из папок (${foldersToClean.join(', ')})? (y/n): `
			);

			if (answer === 'y' || answer === 'yes') {
				console.log('Выполняется очистка...');
				await cleanImageFilesOnly(foldersToClean);
				console.log('Очистка завершена.\n');
			} else {
				console.log('Очистка отменена.\n');
				if (!options.formats || !options.sizes) process.exit(0);
			}
		}
	}

	// Если после очистки нет задания на конвертацию — выходим
	if (!options.formats || !options.sizes) {
		console.log('Работа завершена.');
		process.exit(0);
	}

	// --- Конвертация ---
	const targetFormats = options.formats.split(',').map(f => f.trim().toLowerCase());
	const targetWidths  = parseSizes(options.sizes);
	const aspectRatio   = parseAspectRatio(options.aspect);
	const bgColor       = parseBgColor(options.bg);
	const allowUpscale  = options.upscale;

	const srcPattern    = `${BASE_SRC_DIR.replace(/\\/g, '/')}/**/*.*`;
	const ignorePattern = `${BASE_OUTPUT_DIR.replace(/\\/g, '/')}/**/*.*`;

	const files = await glob(srcPattern, {
		nodir: true,
		ignore: [ignorePattern, '**/node_modules/**'],
	});

	if (files.length === 0) {
		console.log(' Изображения в папке ./public/src/img/ не найдены.');
		return;
	}

	console.log(` Найдено файлов: ${files.length}`);
	console.log(` Форматы:        ${targetFormats.join(', ')}`);
	console.log(` Ширины:         ${targetWidths.map(w => `${w}px`).join(', ')}\n`);

	for (const file of files) {
		const relativePath        = path.relative(BASE_SRC_DIR, path.dirname(file));
		const filenameWithoutExt  = path.basename(file, path.extname(file));

		console.log(`Обработка: ${path.relative(process.cwd(), file)}`);

		let imageMetadata;
		try {
			imageMetadata = await sharp(file).metadata();
		} catch (err) {
			console.error(`  [Ошибка] Не удалось прочитать файл: ${err.message}`);
			continue;
		}

		const origWidth = imageMetadata.width;
		if (!origWidth) continue;

		for (const targetWidth of targetWidths) {
			// Вычисляем финальные размеры с учётом upscale и aspectRatio
			let finalWidth, finalHeight;

			if (origWidth < targetWidth && !allowUpscale) {
				// Изображение меньше целевой ширины и upscale запрещён —
				// берём оригинальную ширину и пересчитываем высоту под aspectRatio
				finalWidth  = origWidth;
				finalHeight = aspectRatio ? Math.round(origWidth / aspectRatio) : null;
			} else {
				finalWidth  = targetWidth;
				finalHeight = aspectRatio ? Math.round(targetWidth / aspectRatio) : null;
			}

			// Фон: непрозрачный для JPG с aspectRatio, прозрачный для остальных
			// (переопределяется на уровне формата ниже)
			const transparentBg = { r: 0, g: 0, b: 0, alpha: 0 };

			const targetDir = path.join(BASE_OUTPUT_DIR, `${targetWidth}w`, relativePath);
			await fs.mkdir(targetDir, { recursive: true });

			for (const format of targetFormats) {
				const ext            = format === 'png8' ? 'png' : format;
				const outputFilePath = path.join(targetDir, `${filenameWithoutExt}.${ext}`);
				const isJpg         = format === 'jpg' || format === 'jpeg';

				try {
					// Для JPG с aspectRatio используем непрозрачный фон,
					// для всех остальных — прозрачный (PNG/WebP/AVIF сохранят альфа-канал)
					const bg = (isJpg && aspectRatio) ? bgColor : transparentBg;

					let pipeline = sharp(file).resize({
						width:              finalWidth,
						height:             finalHeight ?? undefined,
						fit:                aspectRatio ? 'contain' : 'inside',
						position:           'center',
						background:         bg,
						withoutEnlargement: !allowUpscale,
					});

					if (isJpg) {
						pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
					} else if (format === 'webp') {
						pipeline = pipeline.webp({ quality: 80, effort: 4 });
					} else if (format === 'avif') {
						pipeline = pipeline.avif({ quality: 65, effort: 4 });
					} else if (format === 'png') {
						pipeline = pipeline.png({ compressionLevel: 9 });
					} else if (format === 'png8') {
						pipeline = pipeline.png({ compressionLevel: 9, palette: true, colors: 256 });
					}

					await pipeline.toFile(outputFilePath);
				} catch (err) {
					console.error(`  [Ошибка] ${file} → ${ext}: ${err.message}`);
				}
			}
		}
	}

	console.log('\n Конвертация успешно завершена!');
}

main();