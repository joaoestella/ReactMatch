const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../extension/vendor');
for (const folder of ['tesseract', 'core', 'lang', 'licenses']) fs.mkdirSync(path.join(root, folder), { recursive: true });
const copy = (from, to) => fs.copyFileSync(path.join(__dirname, '../node_modules', from), path.join(root, to));
for (const name of ['tesseract.min.js', 'worker.min.js', 'tesseract.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt']) copy(`tesseract.js/dist/${name}`, `tesseract/${name}`);
for (const name of fs.readdirSync(path.join(__dirname, '../node_modules/tesseract.js-core'))) {
  if (/^tesseract-core.*lstm\.wasm\.js$/.test(name)) copy(`tesseract.js-core/${name}`, `core/${name}`);
}
copy('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz');
for (const [pkg, license] of [['tesseract.js', 'LICENSE.md'], ['tesseract.js-core', 'LICENSE']]) copy(`${pkg}/${license}`, `licenses/${pkg}.txt`);
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../node_modules/@tesseract.js-data/eng/package.json')));
fs.writeFileSync(path.join(root, 'licenses/language-data.txt'), `@tesseract.js-data/eng ${data.version}\nPackage license: ${data.license}\nSource: https://github.com/naptha/tessdata\nTesseract trained data: https://github.com/tesseract-ocr/tessdata (Apache-2.0)\n`);
fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify({ 'tesseract.js': '7.0.0', 'tesseract.js-core': require('tesseract.js-core/package.json').version, '@tesseract.js-data/eng': data.version }, null, 2));
console.log('OCR assets bundled locally.');
