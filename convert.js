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
  .option('--aspect <ratio>', 'Соотношение сторон холста (e.g., 16/9, 4/3, 1/1)') // Обновили подсказку
  .option('--bg <color>', 'Цвет заливки полей для JPG', '#ffffff')
  .option('--upscale', 'Разрешить увеличение изображений, если они меньше целевой ширины', false)
  .option('--clean', 'Интерактивная очистка папок целевых размеров перед конвертацией или как отдельная команда', false)
  .parse(process.argv);

const options = program.opts();

// Жестко зафиксированные папки внутри проекта
const BASE_SRC_DIR = path.resolve('./public/src/img');
const BASE_OUTPUT_DIR = path.resolve('./public/img');

// ИНТЕРАКТИВНАЯ ПОМОЩЬ И ВАЛИДАЦИЯ:
if (!options.clean && (!options.formats || !options.sizes)) {
	console.log('\n[!] Ошибка: Не указаны обязательные параметры --formats и --sizes (или флаг --clean).\n');
	program.outputHelp();
	process.exit(0);
}

// Функция для интерактивного вопроса в консоли
function askQuestion(query) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise(resolve => rl.question(query, ans => {
		rl.close();
		resolve(ans.trim().toLowerCase());
	}));
}

// Парсинг соотношения сторон (например "16/9")
function parseAspectRatio(aspectStr) {
	if (!aspectStr) return null;
	const parts = aspectStr.split('/'); // Меняем разделитель на слэш
	if (parts.length !== 2) {
		console.error(`[Ошибка] Неверный формат пропорции: ${aspectStr}. Используйте формат со слэшем, например 16/9.`);
		process.exit(1);
	}
	const width = parseFloat(parts[0]);
	const height = parseFloat(parts[1]);
	if (isNaN(width) || isNaN(height) || height === 0) {
		console.error(`[Ошибка] Некорректные числа в пропорции: ${aspectStr}`);
		process.exit(1);
	}
	return width / height;
}

// Парсинг размеров (например, "1600w,1200w")
function parseSizes(sizesStr) {
	return sizesStr.split(',').map(s => {
		const val = parseInt(s.trim().replace(/w$/, ''), 10);
		if (isNaN(val)) {
			console.error(`[Ошибка] Неверный размер: ${s}`);
			process.exit(1);
		}
		return val;
	});
}

// Поиск всех существующих папок размеров (шаблон: число + w) в директории converted
async function findExistingSizeFolders() {
	try {
		const items = await fs.readdir(BASE_OUTPUT_DIR, { withFileTypes: true });
		return items
			.filter(item => item.isDirectory() && /^\d+w$/.test(item.name))
			.map(item => item.name);
	} catch (err) {
		return [];
	}
}

// Очистка файлов изображений и последующее удаление пустых папок размеров
async function cleanImageFilesOnly(targetWidths) {
	const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

	for (const width of targetWidths) {
		const sizeFolderName = String(width).endsWith('w') ? width : `${width}w`;
		const sizeFolderPath = path.join(BASE_OUTPUT_DIR, sizeFolderName);

		try {
			await fs.access(sizeFolderPath);
			
			const filesInSizeDir = await glob(`${sizeFolderPath.replace(/\\/g, '/')}/**/*.*`, { nodir: true });
			let deletedCount = 0;
			let skippedCount = 0;

			for (const filePath of filesInSizeDir) {
				const ext = path.extname(filePath).toLowerCase();
				
				if (allowedExtensions.includes(ext)) {
					await fs.unlink(filePath);
					deletedCount++;
				} else {
					skippedCount++;
					const relativeAlertPath = path.relative(process.cwd(), filePath);
					console.warn(`  [ПРЕДУПРЕЖДЕНИЕ] В папке результатов найден сторонний файл: ${relativeAlertPath}. Он НЕ будет удален.`);
				}
			}
			
			if (deletedCount > 0) {
				console.log(`  Папка ${sizeFolderName} безопасно очищена от старых изображений (удалено файлов: ${deletedCount}).`);
			}

			if (skippedCount === 0) {
				await fs.rm(sizeFolderPath, { recursive: true, force: true });
				console.log(`  Пустая директория ${sizeFolderName} успешно удалена.`);
			} else {
				console.log(`  Директория ${sizeFolderName} не удалена, так как содержит сторонние файлы.`);
			}

		} catch (err) {
			// Если папки еще нет — просто идем дальше
		}
	}
}

async function main() {
	console.log(` Рабочая директория исходников: ${BASE_SRC_DIR}`);
	console.log(` Рабочая директория готовых фото: ${BASE_OUTPUT_DIR}\n`);

	// Интерактивная очистка перед стартом (или как самостоятельная команда)
	if (options.clean) {
		let foldersToClean = [];
		
		if (options.sizes) {
			foldersToClean = parseSizes(options.sizes).map(w => `${w}w`);
		} else {
			foldersToClean = await findExistingSizeFolders();
		}

		if (foldersToClean.length > 0) {
			const answer = await askQuestion(`Удалить только готовые изображения вместе с папками размеров (${foldersToClean.join(', ')})? (y/n): `);
			
			if (answer === 'y' || answer === 'yes') {
				console.log('Выполняется точечная очистка старых изображений и папок...');
				await cleanImageFilesOnly(foldersToClean);
				console.log('Очистка завершена.\n');
			} else {
				console.log('Очистка отменена пользователем.\n');
				if (!options.formats || !options.sizes) {
					process.exit(0);
				}
			}
		} else {
			console.log('Папки готовых размеров для очистки не обнаружены.\n');
			if (!options.formats || !options.sizes) {
				process.exit(0);
			}
		}
	}

	if (!options.formats || !options.sizes) {
		console.log('Работа скрипта завершена.');
		process.exit(0);
	}

	// --- Стандартный процесс конвертации ---
	const targetFormats = options.formats.split(',').map(f => f.trim().toLowerCase());
	const targetWidths = parseSizes(options.sizes);
	const aspectRatio = parseAspectRatio(options.aspect);
	const bgColor = options.bg;
	const allowUpscale = options.upscale;

	const srcPattern = `${BASE_SRC_DIR.replace(/\\/g, '/')}/**/*.*`;
	const ignorePattern = `${BASE_OUTPUT_DIR.replace(/\\/g, '/')}/**/*.*`;
	
	const files = await glob(srcPattern, { 
		nodir: true,
		ignore: [ignorePattern, '**/node_modules/**']
	});

	if (files.length === 0) {
		console.log(' Изображения в папке ./public/src/img/ не найдены.');
		return;
	}

	console.log(` Найдено исходных файлов для обработки: ${files.length}`);
	console.log(` Целевые форматы: ${targetFormats.join(', ')}`);
	console.log(` Целевые ширины: ${targetWidths.join('px, ')}px\n`);

	for (const file of files) {
		const relativePath = path.relative(BASE_SRC_DIR, path.dirname(file));
		const filenameWithoutExt = path.basename(file, path.extname(file));

		console.log(`Обработка: ${path.relative(process.cwd(), file)}`);

		try {
			const imageMetadata = await sharp(file).metadata();
			const origWidth = imageMetadata.width;
			const origHeight = imageMetadata.height;

			if (!origWidth || !origHeight) {
				continue;
			}

			for (const targetWidth of targetWidths) {
				const sizeFolderName = `${targetWidth}w`;
				
				let targetHeight = null;
				if (aspectRatio) {
					targetHeight = Math.round(targetWidth / aspectRatio);
				}

				let finalWidth = targetWidth;
				let finalHeight = targetHeight;

				if (origWidth < targetWidth && !allowUpscale) {
					if (aspectRatio) {
						finalWidth = targetWidth;
						finalHeight = targetHeight;
					} else {
						finalWidth = origWidth;
						finalHeight = null;
					}
				}

				const targetDir = path.join(BASE_OUTPUT_DIR, sizeFolderName, relativePath);
				await fs.mkdir(targetDir, { recursive: true });

				for (const format of targetFormats) {
					let ext = format === 'png8' ? 'png' : format;
					const outputFilePath = path.join(targetDir, `${filenameWithoutExt}.${ext}`);

					let pipeline = sharp(file);

					if (aspectRatio) {
						pipeline = pipeline.resize({
							width: finalWidth,
							height: finalHeight,
							fit: 'contain',
							position: 'center',
							background: { r: 0, g: 0, b: 0, alpha: 0 }
						});
					} else {
						pipeline = pipeline.resize({
							width: finalWidth,
							fit: 'inside',
							withoutEnlargement: !allowUpscale
						});
					}

					if (format === 'jpg' || format === 'jpeg') {
						if (aspectRatio) {
							pipeline = sharp(file).resize({
								width: finalWidth,
								height: finalHeight,
								fit: 'contain',
								position: 'center',
								background: bgColor
							});
						}
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
				}
			}
		} catch (err) {
			console.error(`  [Ошибка] Не удалось обработать файл ${file}:`, err.message);
		}
	}

	console.log('\n Конвертация успешно завершена!');
}

main();