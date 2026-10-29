// Loads the extension in Chromium and checks the panel without real videos:
// the demo, language switching, bundled OCR under the extension's CSP and a
// narrow window. Run: npm run test:browser
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const extension = path.resolve(__dirname, '../extension');
// Screenshots for a quick look; the store images are made separately (store/README.md).
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'reactmatch-shots-'));

(async () => {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'reactmatch-smoke-')), {
    executablePath: process.env.CHROMIUM || chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--lang=en-US'],
    viewport: { width: 460, height: 1100 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/panel.html`);
    const title = () => page.locator('#status-title').textContent();
    const waitTitle = text => page.waitForFunction(text => document.getElementById('status-title').textContent === text, text, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('start-word').textContent === 'Sync');
    assert.equal(await page.locator('#start').isDisabled(), true);
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'panel-en.png'), fullPage: true });

    // Demo (in the Pro view): a simulated 14 s difference, recovery from a 6 s drift, fine adjustment.
    await page.locator('#view button[data-view="pro"]').click();
    await page.locator('details.help > summary').click();
    await page.locator('#demo').click();
    await waitTitle('Try a 14-second difference');
    await page.locator('#apply-times').click();
    await waitTitle('Reference marked');
    await page.locator('#start').click();
    await waitTitle('In sync');
    await page.locator('#simulate-drift').click();
    await waitTitle('Adjusting video 1');
    await waitTitle('In sync');
    await page.locator('#trim-plus').click();
    assert.equal(await page.locator('#trim-value').textContent(), '+0.5 s');
    await page.locator('#start').click();
    assert.equal(await title(), 'Stopped');
    await page.locator('#leave-demo').click();
    assert.equal(await page.locator('#start').isDisabled(), true);
    await page.locator('#view button[data-view="simple"]').click();

    // Language menu: Portuguese and Spanish, saved for next time.
    await page.locator('#lang').selectOption('pt');
    await page.waitForFunction(() => document.getElementById('arrange').textContent === 'Pôr lado a lado');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'pt-BR');
    await page.screenshot({ path: path.join(shots, 'panel-pt.png'), fullPage: true });
    await page.locator('#lang').selectOption('es');
    await page.waitForFunction(() => document.getElementById('arrange').textContent === 'Lado a lado');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('arrange').textContent === 'Lado a lado');
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

    const spacedClock = await page.evaluate(async () => {
      const { LocalOCR } = await import('./ocr.js');
      const { clockTokens } = await import('./core.js');
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 100;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 100);
      ctx.fillStyle = '#111'; ctx.font = 'bold 56px Arial'; ctx.fillText('25 : 40', 20, 72);
      const reader = new LocalOCR();
      try { const words = await reader.line(canvas); return { words: words.map(w => w.text), tokens: clockTokens(words, 400, 100) }; }
      finally { await reader.close(); }
    });
    assert.deepEqual(spacedClock.tokens.map(token => token.value), [1540], JSON.stringify(spacedClock));

    // A tiny clock inside a full-HD reaction must survive text detection,
    // enlargement and real OCR (the old relative height filter discarded it).
    const smallClock = await page.evaluate(async () => {
      const { LocalOCR, scanClocks, prepareClock } = await import('./ocr.js');
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#151515'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Arial'; ctx.fillText('25:40', 1700, 990);
      const reader = new LocalOCR();
      try {
        const tokens = await scanClocks(reader, canvas.toDataURL('image/png'));
        const crop = document.createElement('canvas'); crop.width = 42; crop.height = 14;
        crop.getContext('2d').drawImage(canvas, 1697, 979, 42, 14, 0, 0, 42, 14);
        return { tokens, enhanced: await reader.read(prepareClock(crop)) };
      } finally { await reader.close(); }
    });
    assert.ok(smallClock.tokens.some(token => token.value === 1540 && token.confidence >= 65), JSON.stringify(smallClock));
    assert.equal(smallClock.enhanced.value, 1540, JSON.stringify(smallClock));

    // Manual selection accepts a tiny, nonempty region and still rejects a
    // near-empty drag. Coordinates come from the full-resolution source.
    await page.evaluate(async () => {
      const { selectRegion } = await import('./ocr.js');
      const still = document.createElement('canvas'); still.width = 1920; still.height = 1080;
      window.selection = selectRegion(document.getElementById('crop-dialog'), still);
    });
    const cropBox = await page.locator('#crop-canvas').boundingBox();
    const drag = async (w, h) => {
      await page.mouse.move(cropBox.x + 20, cropBox.y + 20); await page.mouse.down();
      await page.mouse.move(cropBox.x + 20 + w / 1920 * cropBox.width, cropBox.y + 20 + h / 1080 * cropBox.height);
      await page.mouse.up();
    };
    await drag(30, 7);
    assert.equal(await page.locator('#crop-save').isEnabled(), true);
    await drag(1, 1);
    assert.equal(await page.locator('#crop-save').isEnabled(), false);
    await page.locator('#crop-close').click();

    // Every language fits a narrow window.
    await page.setViewportSize({ width: 360, height: 950 });
    for (const lang of ['en', 'pt', 'es']) {
      await page.locator('#lang').selectOption(lang);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${lang} overflows`);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ extensionLoaded: true, demo: true, languages: ['en', 'pt', 'es'], ocr: reading, spacedClock, smallClock, narrowLayout: true, pageErrors: errors }, null, 2));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
