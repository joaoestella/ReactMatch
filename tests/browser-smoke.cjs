// Loads the extension in Chromium and checks the panel without real videos:
// the demo, language switching, bundled OCR under the extension's CSP and a
// narrow window. Run: npm run test:browser
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const extension = path.resolve(__dirname, '../extension');
const shots = path.resolve(__dirname, '../docs/images');

(async () => {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'syncvideo-smoke-')), {
    executablePath: process.env.CHROMIUM || chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--lang=en-US'],
    viewport: { width: 1160, height: 1050 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/panel.html`);
    const title = () => page.locator('#status-title').textContent();
    const waitTitle = text => page.waitForFunction(text => document.getElementById('status-title').textContent === text, text, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('find-clocks').textContent === 'Find clocks');
    assert.equal(await page.locator('#start').isDisabled(), true);
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'panel-en.png'), fullPage: true });

    // Demo: a simulated 14 s difference, recovery from a 6 s drift, fine adjustment.
    await page.locator('#demo').click();
    await waitTitle('Try a 14-second difference');
    await page.locator('#calibrate').click();
    await waitTitle('Reference marked');
    await page.locator('#start').click();
    await waitTitle('Videos in sync');
    await page.locator('#simulate-drift').click();
    await waitTitle('Adjusting video B');
    await waitTitle('Videos in sync');
    await page.locator('#trim-plus').click();
    assert.equal(await page.locator('#trim-value').textContent(), '+0.5 s');
    await page.locator('#start').click();
    assert.equal(await title(), 'Syncing stopped');
    await page.locator('#leave-demo').click();
    assert.equal(await page.locator('#start').isDisabled(), true);

    // Language menu: Portuguese and Spanish, saved for next time.
    await page.locator('#lang').selectOption('pt');
    await page.waitForFunction(() => document.getElementById('find-clocks').textContent === 'Encontrar relógios');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'pt-BR');
    await page.screenshot({ path: path.join(shots, 'panel-pt.png'), fullPage: true });
    await page.locator('#lang').selectOption('es');
    await page.waitForFunction(() => document.getElementById('find-clocks').textContent === 'Encontrar relojes');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('find-clocks').textContent === 'Encontrar relojes');
    await page.locator('#lang').selectOption('en');

    // The bundled OCR, under the extension's real CSP and without network.
    const reading = await page.evaluate(async () => {
      const { LocalOCR } = await import('./ocr.js');
      const canvas = document.createElement('canvas');
      canvas.width = 440; canvas.height = 110;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 440, 110);
      ctx.fillStyle = '#000'; ctx.font = 'bold 76px Arial'; ctx.fillText('25:40', 30, 82);
      const reader = new LocalOCR();
      try { return await reader.read(canvas); } finally { await reader.close(); }
    });
    assert.equal(reading.value, 1540);
    assert.ok(reading.confidence >= 65, JSON.stringify(reading));

    // Every language fits a narrow window.
    await page.setViewportSize({ width: 480, height: 950 });
    for (const lang of ['en', 'pt', 'es']) {
      await page.locator('#lang').selectOption(lang);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${lang} overflows`);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ extensionLoaded: true, demo: true, languages: ['en', 'pt', 'es'], ocr: reading, narrowLayout: true, pageErrors: errors }, null, 2));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
