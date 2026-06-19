import { defineConfig, loadEnv } from 'vite';
import { ViteEjsPlugin } from 'vite-plugin-ejs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import postcss from 'postcss';
import postcssNested from 'postcss-nested';
import postcssLightningcss from 'postcss-lightningcss';
import { browserslistToTargets } from 'lightningcss';
import browserslist from 'browserslist';

// ESM-совместимый __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Брейкпоинты — всегда в px. Можно задавать числом или строкой "NNNpx".
// ---------------------------------------------------------------------------
const breakpoints = {
	desk:       1198,
	desk_l:     1440,
	max_mobile:  640,
};

// ---------------------------------------------------------------------------
// Настройки DSL для @include media(...)
// rootValue — сколько px в 1rem/em у вас в проекте (html { font-size: 62.5% } → 10)
// epsilonPx — сколько вычитать/прибавлять при эксклюзивных операторах < и >
//             (используется только в классическом режиме)
// ---------------------------------------------------------------------------
const mediaDsl = {
	rootValue:  10,
	epsilonPx:  0.02,
};

// ---------------------------------------------------------------------------
// Определяем поддержку Media Queries Level 4 по browserslist проекта.
//
// Level 4 range syntax (width >= N) поддерживается с:
//   Chrome 104+, Edge 104+, Firefox 63+, Samsung 20+, Safari 16.4+
//
// Если все браузеры в списке удовлетворяют этим минимумам —
// генерируем Level 4 и отдаём обработку границ браузеру.
// Иначе — генерируем классический min/max-width с epsilon вручную.
// ---------------------------------------------------------------------------
const LEVEL4_MINIMUMS = {
	chrome:   104,
	edge:     104,
	firefox:   63,
	safari:  16.4,   // 16.4 — первая версия с поддержкой
	ios_saf: 16.4,
	samsung:   20,
	and_chr:  104,
	and_ff:    63,
};

function detectLevel4Support() {
	const browsers = browserslist();  // читает browserslist из package.json / .browserslistrc
	for (const entry of browsers) {
		const [browser, versionRaw] = entry.split(' ');
		// Версии вида "16.4-16.5" — берём минимальную
		const version = parseFloat(versionRaw.split('-')[0]);
		const min = LEVEL4_MINIMUMS[browser];

		if (min === undefined) {
			// Браузер не в таблице поддержки Level 4 (IE, BB, Opera Mini, KaiOS…)
			console.log(`[media-dsl] Level 4 disabled: unknown browser "${browser} ${versionRaw}"`);
			return false;
		}
		if (version < min) {
			console.log(`[media-dsl] Level 4 disabled: ${browser} ${version} < required ${min}`);
			return false;
		}
	}
	return true;
}

const useLevel4 = detectLevel4Support();
console.log(`[media-dsl] Mode: ${useLevel4
	? 'Level 4 — (width >= N) / (width <= N)'
	: 'Classic — (min-width: N) / (max-width: N±epsilon)'
}`);

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Убирает лишние нули: 1197.980 → "1197.98", 640.00 → "640" */
function stripZeros(num) {
	return Number(num.toFixed(5)).toString();
}

/** Парсит строку "Npx" / "Nrem" / "Nem" и возвращает значение в px.
 *  Если передан ключ брейкпоинта — берёт из словаря. */
function resolveToPixels(raw, cfg, atRule) {
	const value = String(raw).trim();

	// Ключ брейкпоинта
	if (Object.prototype.hasOwnProperty.call(cfg.breakpoints, value)) {
		const bp = cfg.breakpoints[value];
		if (typeof bp === 'number') return bp;
		const bpMatch = String(bp).match(/^(-?\d*\.?\d+)(px|rem|em)$/i);
		if (!bpMatch) throw atRule.error(`[media-dsl] Invalid breakpoint value for "${value}": ${bp}`);
		const num = Number(bpMatch[1]);
		const unit = bpMatch[2].toLowerCase();
		if (unit === 'px') return num;
		return num * cfg.mediaDsl.rootValue;
	}

	// Числовое значение с единицей
	const match = value.match(/^(-?\d*\.?\d+)(px|rem|em)$/i);
	if (!match) {
		throw atRule.error(`[media-dsl] Unsupported value "${raw}". Use px, rem, em or a breakpoint alias.`);
	}
	const num = Number(match[1]);
	const unit = match[2].toLowerCase();
	if (unit === 'px') return num;
	return num * cfg.mediaDsl.rootValue; // rem / em → px
}

/** Генерирует строку условия медиа-запроса в зависимости от режима.
 *
 *  Level 4:  "(width >= 640px)", "(width <= 1198px)"  — epsilon не нужен
 *  Classic:  "(min-width: 640px)", "(max-width: 1197.98px)"  — epsilon считаем сами
 */
function buildCondition(operator, px, epsilonPx) {
	if (useLevel4) {
		// Level 4: операторы передаём как есть, браузер сам обрабатывает границы
		switch (operator) {
			case '>=': return `(width >= ${stripZeros(px)}px)`;
			case '<=': return `(width <= ${stripZeros(px)}px)`;
			case '>':  return `(width > ${stripZeros(px)}px)`;
			case '<':  return `(width < ${stripZeros(px)}px)`;
			default:   return null;
		}
	}

	// Classic: max-width не включает границу строго,
	// поэтому вычитаем epsilon для <= и <
	switch (operator) {
		case '>=': return `(min-width: ${stripZeros(px)}px)`;
		case '>':  return `(min-width: ${stripZeros(px + epsilonPx)}px)`;
		case '<=': return `(max-width: ${stripZeros(px - epsilonPx)}px)`;
		case '<':  return `(max-width: ${stripZeros(px - epsilonPx)}px)`;
		default:   return null;
	}
}

// ---------------------------------------------------------------------------
// Разбивка строки по разделителю с учётом вложенных скобок и кавычек
// ---------------------------------------------------------------------------
function splitTopLevel(input, separator = ',') {
	const parts = [];
	let current = '';
	let depth = 0;
	let quote = null;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		const prev = input[i - 1];

		if (quote) {
			current += ch;
			if (ch === quote && prev !== '\\') quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
		if (ch === '(') { depth++; current += ch; continue; }
		if (ch === ')') { depth--; current += ch; continue; }

		if (ch === separator && depth === 0) {
			if (current.trim()) parts.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

/** Снимает обрамляющие кавычки */
function unquote(s) {
	const t = String(s).trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	return t;
}

// ---------------------------------------------------------------------------
// Парсер аргументов @include media(...)
//
// Поддерживает два формата:
//   Плоский:   @include media(">=max_mobile", "<=desk")
//   Групповой: @include media((">=desk", "<=desk_l"), (">=1366px", "screen"))
//
// Возвращает массив групп, каждая группа — массив токенов.
// ---------------------------------------------------------------------------
function parseMediaArgs(params, atRule) {
	const outerMatch = params.trim().match(/^media\s*\(([\s\S]*)\)$/);
	if (!outerMatch) {
		throw atRule.error(`[media-dsl] Expected @include media(...). Got: ${params}`);
	}

	const inner = outerMatch[1].trim();
	if (!inner) throw atRule.error('[media-dsl] Empty media() arguments.');

	const topParts = splitTopLevel(inner, ',');

	// Если каждая часть обёрнута в скобки — это мульти-группа
	const allWrapped = topParts.every(p => p.startsWith('(') && p.endsWith(')'));

	if (allWrapped) {
		return topParts.map(p => {
			const content = p.slice(1, -1).trim();
			return splitTopLevel(content, ',').map(unquote);
		});
	}

	// Плоский вариант — одна группа
	return [topParts.map(unquote)];
}

// ---------------------------------------------------------------------------
// Компиляция одной группы токенов в строку медиа-запроса
// ---------------------------------------------------------------------------
function compileGroup(tokens, cfg, atRule) {
	const MEDIA_TYPES = new Set(['screen', 'print', 'all']);
	const eps = cfg.mediaDsl.epsilonPx;

	let mediaType = null;
	const conditions = [];

	for (const rawToken of tokens) {
		const token = String(rawToken).trim();
		if (!token) continue;

		// Тип медиа
		if (MEDIA_TYPES.has(token)) {
			mediaType = token;
			continue;
		}

		// Операторы диапазона: >=, <=, >, <
		const rangeMatch = token.match(/^(>=|<=|>|<)\s*(.+)$/);
		if (rangeMatch) {
			const operator = rangeMatch[1];
			const px = resolveToPixels(rangeMatch[2].trim(), cfg, atRule);
			const cond = buildCondition(operator, px, eps);
			if (cond) conditions.push(cond);
			continue;
		}

		// Алиасы (portrait, landscape, dark, …)
		if (cfg.aliases[token]) {
			conditions.push(cfg.aliases[token]);
			continue;
		}

		// Произвольное CSS media feature: "color-gamut: p3"
		if (/^[a-z-]+\s*:\s*.+$/i.test(token)) {
			conditions.push(`(${token})`);
			continue;
		}

		throw atRule.error(`[media-dsl] Unknown media token "${token}".`);
	}

	const type = mediaType || 'screen';

	if (useLevel4) {
		// В Level 4 нет "only", тип медиа опционален
		// "screen" опускаем если нет других условий кроме width
		const prefix = type === 'screen' ? 'screen' : type;
		if (!conditions.length) return prefix;
		return `${prefix} and ${conditions.join(' and ')}`;
	}

	// Classic: "only screen and ..."
	const prefix = type === 'screen' ? 'only screen' : type;
	if (!conditions.length) return prefix;
	return `${prefix} and ${conditions.join(' and ')}`;
}

// ---------------------------------------------------------------------------
// Фабрика PostCSS-плагина
// ---------------------------------------------------------------------------
function createMediaDslPlugin(options = {}) {
	const cfg = {
		breakpoints: options.breakpoints || {},
		mediaDsl: { ...mediaDsl, ...(options.mediaDsl || {}) },
		aliases: {
			portrait:               '(orientation: portrait)',
			landscape:              '(orientation: landscape)',
			dark:                   '(prefers-color-scheme: dark)',
			light:                  '(prefers-color-scheme: light)',
			hover:                  '(hover: hover)',
			'no-hover':             '(hover: none)',
			'reduced-motion':       '(prefers-reduced-motion: reduce)',
			'no-preference-motion': '(prefers-reduced-motion: no-preference)',
			...(options.aliases || {}),
		},
	};

	return {
		postcssPlugin: 'postcss-media-dsl',
		AtRule(atRule) {
			if (atRule.name !== 'include') return;
			if (!atRule.params?.trim().startsWith('media(')) return;

			const groups = parseMediaArgs(atRule.params, atRule);
			const compiled = groups
				.map(group => compileGroup(group, cfg, atRule))
				.join(', ');

			const mediaRule = postcss.atRule({ name: 'media', params: compiled });
			if (atRule.nodes?.length) {
				atRule.each(node => mediaRule.append(node.clone()));
			}
			atRule.replaceWith(mediaRule);
		},
	};
}
createMediaDslPlugin.postcss = true;

// ---------------------------------------------------------------------------
// fluid_prop(minScreen, maxScreen, minSize, maxSize)
// Пример: font-size: fluid_prop(320px, 1440px, 16px, 24px)
// ---------------------------------------------------------------------------
function parseValue(raw) {
	if (!raw) return null;
	const value = raw.trim();
	const match = value.match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
	if (!match) return null;
	return { num: Number(match[1]), unit: match[2] || '', raw: value };
}

const vitePostcssFluidProp = () => ({
	postcssPlugin: 'vite-postcss-fluid-prop',
	Declaration(decl) {
		if (!decl.value?.includes('fluid_prop')) return;
		const match = decl.value.match(/fluid_prop\(([^)]+)\)/);
		if (!match) return;
		const params = match[1].split(/[\s,]+/).filter(Boolean);
		if (params.length < 4) return;
		const [minScreen, maxScreen, minSize, maxSize] = params.map(parseValue);
		if (!minScreen || !maxScreen || !minSize || !maxSize) return;

		const slope = (maxSize.num - minSize.num) / (maxScreen.num - minScreen.num);
		const intercept = minSize.num - slope * minScreen.num;
		const slopeVw = (slope * 100).toFixed(3).replace(/\.?0+$/, '');
		// Если intercept равен 0 — единица не нужна
		const interceptStr = intercept === 0
			? '0'
			: `${intercept.toFixed(3).replace(/\.?0+$/, '')}${minSize.unit}`;

		const fluidExpression =
			`max(${minSize.raw}, min(calc(${interceptStr} + ${slopeVw}vw), ${maxSize.raw}))`;
		decl.value = decl.value.replace(match[0], fluidExpression);
	},
});
vitePostcssFluidProp.postcss = true;

// ---------------------------------------------------------------------------
// Cache-busting для картинок в HTML при продакшн-сборке
// ---------------------------------------------------------------------------
const autoVersionImagesPlugin = (imgPrefix) => ({
	name: 'auto-version-images',
	transformIndexHtml(html) {
		const version = Date.now().toString(36);
		return html.replace(
			/(src|srcset)=["']((?:https?:)?\/\/)?([^"'?]+)(\.(?:webp|avif|jpe?g|png|svg|gif))([^"']*)(["'])/gi,
			(match, attribute, protocol, cleanPath, extension, existingQuery, quote) => {
				// Внешние URL не трогаем
				if (protocol) return match;

				// Разделяем query и hash
				const hashIndex = existingQuery.indexOf('#');
				const queryPart = hashIndex !== -1 ? existingQuery.slice(0, hashIndex) : existingQuery;
				const hashPart  = hashIndex !== -1 ? existingQuery.slice(hashIndex) : '';

				// Если query уже есть — не перезаписываем версию
				if (queryPart.includes('?')) {
					return `${attribute}=${quote}${imgPrefix}${cleanPath}${extension}${existingQuery}${quote}`;
				}
				return `${attribute}=${quote}${imgPrefix}${cleanPath}${extension}?${version}${hashPart}${quote}`;
			}
		);
	},
});

// ---------------------------------------------------------------------------
// Основной конфиг
// ---------------------------------------------------------------------------
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	const isProd = mode === 'production';
	const prodImgPrefix = env.VITE_PROD_IMG_PREFIX || 'img/';

	return {
		root: process.cwd(),
		// В продакшене картинки живут на сервере/CDN отдельно — publicDir не нужен
		publicDir: isProd ? false : 'public/img',
		base: isProd ? './' : '/',

		plugins: [
			ViteEjsPlugin({}, { ejsOptions: { root: resolve(__dirname, './') } }),

			isProd && autoVersionImagesPlugin(prodImgPrefix),

			// Фикс бага минификатора: склейка `font: ... inherit` → ломает font-family
			isProd && {
				name: 'fix-final-css-font-inherit',
				enforce: 'post',
				generateBundle(_, bundle) {
					const FONT_INHERIT_RE =
						/font\s*:\s*((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded)\s+)*(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|-?\d*\.?\d+(?:px|r?em|ex|ch|lh|rlh|vw|vh|vmin|vmax|vb|vi|svw|svh|lvw|lvh|dvw|dvh|cm|mm|q|in|pt|pc|%)|(?:calc|min|max|clamp|var)\([^)]+\))(?:\s*\/\s*(?:normal|-?\d*\.?\d+(?:px|r?em|ex|ch|lh|rlh|vw|vh|vmin|vmax|vb|vi|svw|svh|lvw|lvh|dvw|dvh|cm|mm|q|in|pt|pc|%|)|(?:calc|min|max|clamp|var)\([^)]+\)))?)\s+inherit(?=\s*[;}])/gi;

					for (const filename in bundle) {
						if (!filename.endsWith('.css')) continue;
						const chunk = bundle[filename];
						if (!chunk.source || typeof chunk.source !== 'string') continue;
						chunk.source = chunk.source.replace(
							FONT_INHERIT_RE,
							(_, fontPrefix) => `font:${fontPrefix} a;font-family:inherit`
						);
					}
				},
			},

			// Hot-reload для .html и .ejs файлов
			{
				name: 'html-live-reload',
				handleHotUpdate({ file, server }) {
					if (file.endsWith('.html') || file.endsWith('.ejs')) {
						server.ws.send({ type: 'full-reload', path: '*' });
					}
				},
			},
		].filter(Boolean),

		server: {
			host: true,
			open: '/index.html',
		},

		css: {
			devSourcemap: true,
			postcss: {
				plugins: [
					createMediaDslPlugin({ breakpoints, mediaDsl }),
					postcssNested(),
					vitePostcssFluidProp(),
					// В продакшене — минификация через lightningcss
					isProd && postcssLightningcss({
						targets: browserslistToTargets(browserslist()),
						minify: true,
					}),
				].filter(Boolean),
			},
		},

		build: {
			// 'hidden' — sourcemap генерируется, но не раскрывается публично
			sourcemap: 'hidden',
			// Дефолтный CSS-минификатор Vite отключён — используем lightningcss через PostCSS
			cssMinify: false,
			assetsDir: 'assets',
			rollupOptions: {
				input: {
					main: resolve(__dirname, 'index.html'),
				},
				output: {
					chunkFileNames: 'js/[name]-[contenthash].js',
					entryFileNames: 'js/[name]-[contenthash].js',
					assetFileNames: 'css/[name]-[hash][extname]',
				},
			},
		},
	};
});