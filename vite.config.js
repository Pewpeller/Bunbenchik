import { defineConfig, loadEnv } from 'vite';
import { ViteEjsPlugin } from 'vite-plugin-ejs';
import { resolve } from 'node:path';
import browserslist from 'browserslist';
import { browserslistToTargets } from 'lightningcss';
import postcss from 'postcss';
import postcssMixins from 'postcss-mixins';
import postcssNested from 'postcss-nested';

// Настройки адаптивных контрольных точек
const breakpoints = {
	desk: 1025,
	desk_l: 1441,
	desk_l_gap: 1521,
	desk_xl: 1920
};

// Хелпер для парсинга значений в fluid_prop
function parseValue(raw) {
	if (!raw) return null;
	const value = raw.trim();
	const match = value.match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
	if (!match) return null;
	return {
		num: Number(match[1]),
		unit: match[2] || '',
		raw: value,
	};
}

// Ваш кастомный PostCSS плагин для расчета резиновых свойств
const vitePostcssFluidProp = () => {
	return {
		postcssPlugin: 'vite-postcss-fluid-prop',
		Declaration(decl) {
			if (!decl.value || !decl.value.includes('fluid_prop')) return;

			const match = decl.value.match(/fluid_prop\(([^)]+)\)/);
			if (!match) return;

			const params = match[1].split(/[\s,]+/).filter(Boolean);
			if (params.length < 4) return;

			const [minScreen, maxScreen, minSize, maxSize] = params.map(parseValue);
			if (!minScreen || !maxScreen || !minSize || !maxSize) return;

			const slope = (maxSize.num - minSize.num) / (maxScreen.num - minScreen.num);
			const intercept = minSize.num - slope * minScreen.num;

			const slopeVw = (slope * 100).toFixed(3).replace(/\.?0+$/, '');
			const interceptValue = intercept.toFixed(3).replace(/\.?0+$/, '');
			const targetUnit = minSize.unit;

			const fluidExpression = `max(${minSize.raw}, min(calc(${interceptValue}${targetUnit} + ${slopeVw}vw), ${maxSize.raw}))`;
			
			decl.value = decl.value.replace(match[0], fluidExpression);
		},
	};
};
vitePostcssFluidProp.postcss = true;

// Плагин автоматической трансформации путей и версионирования картинок на проде
const autoVersionImagesPlugin = (imgPrefix) => {
	return {
		name: 'auto-version-images',
		transformIndexHtml(html) {
			const version = Date.now().toString(36);

			return html.replace(
				/(src|srcset)=["']([^"'\?]+)(\.(?:webp|avif|jpe?g|png|svg|gif))([^"']*)(["'])/gi,
				(match, attribute, cleanPath, extension, existingQuery, quote) => {
					if (existingQuery.includes('?')) {
						return `${attribute}=${quote}${imgPrefix}${cleanPath}${extension}${existingQuery}${quote}`;
					}

					return `${attribute}=${quote}${imgPrefix}${cleanPath}${extension}?${version}${quote}`;
				}
			);
		}
	};
};

export default defineConfig(({ mode }) => {
	// Загружаем переменные окружения (.env.production в режиме build)
	const env = loadEnv(mode, process.cwd(), '');
	
	const isProd = mode === 'production';
	
	// ЗАЩИТА ОТ ДУРАКА: если файла конфигурации нет, по дефолту уводим пути в папку img/
	const prodImgPrefix = env.VITE_PROD_IMG_PREFIX || 'img/';

	return {
		root: process.cwd(),
		
		// Динамическая обработка папки статики (локально работаем напрямую, на проде исключаем из сборки)
		publicDir: isProd ? false : 'public/img',

		base: isProd ? './' : '/',

		plugins: [
			// Настройка EJS с путями инклудов от корня проекта
			ViteEjsPlugin({
				// Здесь можно передать глобальные переменные для шаблонов
			}, {
				ejsOptions: {
					root: resolve(__dirname, './')
				}
			}),

			// Подключаем версионирование картинок только на проде
			isProd && autoVersionImagesPlugin(prodImgPrefix),

			// Живая перезагрузка HTML и EJS
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
			// раскомментить host/port, чтобы открывалось и под vpn
			host: true,
			port: 5173,
			open: '/index.html',
		},

		css: {
			devSourcemap: true,
			transformer: 'postcss',
			postcss: {
				plugins: [
					postcssMixins({
						mixins: {
							media: function (mixin, ...args) {
								const queryStr = args.join(' '); 
								let minWidth = null;
								let maxWidth = null;

								const minMatch = queryStr.match(/from\s+(\w+)/);
								if (minMatch) {
									const key = minMatch[1];
									if (!breakpoints[key]) throw mixin.error(`Unknown breakpoint: ${key}`);
									minWidth = breakpoints[key];
								}

								const maxMatch = queryStr.match(/to\s+(\w+)/);
								if (maxMatch) {
									const key = maxMatch[1];
									if (!breakpoints[key]) throw mixin.error(`Unknown breakpoint: ${key}`);
									maxWidth = breakpoints[key] - 0.02; // Магический вычет для идеального стыка
								}

								const mediaConditions = [];
								if (minWidth) mediaConditions.push(`(min-width: ${minWidth}px)`);
								if (maxWidth) mediaConditions.push(`(max-width: ${maxWidth}px)`);

								const finalParams = `only screen and ${mediaConditions.join(' and ')}`;

								const mediaRule = postcss.atRule({
									name: 'media',
									params: finalParams
								});

								mediaRule.append(mixin.nodes);
								mixin.replaceWith(mediaRule);
							}
						}
					}),
					postcssNested(),
					vitePostcssFluidProp()
				]
			}
		},

		build: {
			sourcemap: true,
			cssMinify: 'lightningcss',
			assetsDir: 'assets',
			lightningcss: {
				// ВАЖНО: Указываем LightningCSS, где искать файлы импортов, начинающиеся со слэша "/"
				projectRoot: resolve(__dirname, './'),
				targets: browserslistToTargets(browserslist(['last 4 versions', '> 2% in RU', 'Safari >= 13'])),
			},
			rollupOptions: {
				input: {
					main: resolve(__dirname, 'index.html'),
					interview: resolve(__dirname, 'interview.html'),
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