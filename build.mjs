// Bundles the sandbox code and inlines the UI script into a single HTML file,
// since a Figma plugin UI is loaded from a string and cannot fetch sibling files.
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
await mkdir('dist', { recursive: true });

const common = { bundle: true, minify: !watch, sourcemap: watch ? 'inline' : false, logLevel: 'info' };

// pdf-lib bundles metrics for the 14 standard PDF fonts (127 KB) and a PNG codec (24 KB). This plugin
// never draws text with standard fonts or embeds PNGs, so the UI bundle gets small stand-ins. pdf-lib
// reads only the font *names* at load time; anything that reaches the rest fails loudly.
const unused = (what) => `throw new Error('${what} is not included in this plugin build.')`;
const slimPdfLib = {
  name: 'slim-pdf-lib',
  setup(b) {
    b.onResolve({ filter: /^@pdf-lib\/(standard-fonts|upng)$/ }, (args) => ({ path: args.path, namespace: 'slim' }));
    b.onLoad({ filter: /standard-fonts/, namespace: 'slim' }, () => ({
      contents: `
        export var FontNames = { Courier: 'Courier', CourierBold: 'Courier-Bold', CourierOblique: 'Courier-Oblique',
          CourierBoldOblique: 'Courier-BoldOblique', Helvetica: 'Helvetica', HelveticaBold: 'Helvetica-Bold',
          HelveticaOblique: 'Helvetica-Oblique', HelveticaBoldOblique: 'Helvetica-BoldOblique', TimesRoman: 'Times-Roman',
          TimesRomanBold: 'Times-Bold', TimesRomanItalic: 'Times-Italic', TimesRomanBoldItalic: 'Times-BoldItalic',
          Symbol: 'Symbol', ZapfDingbats: 'ZapfDingbats' };
        export var EncodingType = {};
        export var Encodings = new Proxy({}, { get: function () { ${unused('Standard-font encoding')} } });
        export var Font = { load: function () { ${unused('Standard-font metrics')} } };`,
      loader: 'js',
    }));
    b.onLoad({ filter: /upng/, namespace: 'slim' }, () => ({
      contents: `export default { decode: function () { ${unused('PNG decoding')} }, toRGBA8: function () { ${unused('PNG decoding')} } };`,
      loader: 'js',
    }));
  },
};

async function buildUI() {
  const result = await esbuild.build({
    ...common,
    entryPoints: ['src/ui.ts'],
    format: 'iife',
    target: 'es2020',
    write: false,
    plugins: [slimPdfLib],
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = (await readFile('src/ui.html', 'utf8')).replace('<!--SCRIPT-->', () => `<script>${js}</script>`);
  await writeFile('dist/ui.html', html);
}

const code = {
  ...common,
  entryPoints: ['src/code.ts'],
  outfile: 'dist/code.js',
  format: 'iife',
  // The Figma sandbox is conservative about newer syntax; lower it.
  target: 'es2017',
};

if (watch) {
  const ctx = await esbuild.context(code);
  await ctx.watch();
  const ui = await esbuild.context({
    ...common,
    entryPoints: ['src/ui.ts'],
    format: 'iife',
    target: 'es2020',
    write: false,
    plugins: [slimPdfLib, { name: 'inline', setup: (b) => b.onEnd(() => buildUI()) }],
  });
  await ui.watch();
} else {
  await esbuild.build(code);
  await buildUI();
}
