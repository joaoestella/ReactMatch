const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const extension = path.resolve(__dirname, '../extension');
const output = path.resolve(__dirname, '..');
(async () => {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'syncvideo-smoke-')), {
    executablePath: chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1160, height: 1050 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/panel.html`);
    await page.screenshot({ path: path.join(output, 'interface.png'), fullPage: true });
    assert.equal(await page.locator('#start').isDisabled(), true);
    await page.locator('#demo').click();
    await page.waitForFunction(() => document.getElementById('status-title').textContent.includes('14 segundos'));
    await page.locator('#calibrate').click();
    await page.waitForFunction(() => document.getElementById('status-title').textContent === 'Referência marcada');
    assert.equal(await page.locator('#start').isEnabled(), true, 'Zero offset is a valid calibrated anchor');
    await page.locator('#start').click();
    await page.waitForFunction(() => document.getElementById('status-title').textContent === 'Vídeos acompanhando juntos');
    await page.locator('#simulate-drift').click();
    await page.waitForFunction(() => document.getElementById('status-title').textContent === 'Ajustando o vídeo B', null, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('status-title').textContent === 'Vídeos acompanhando juntos');
    await page.locator('#trim-plus').click();
    assert.equal(await page.locator('#trim-value').textContent(), '+0,5s');
    await page.locator('#start').click();
    assert.equal(await page.locator('#status-title').textContent(), 'Acompanhamento parado');
    await page.locator('#leave-demo').click();
    assert.equal(await page.locator('#start').isDisabled(), true);
    // Exercise the bundled OCR in the actual extension CSP, without network.
    const ocrResult = await page.evaluate(async () => {
      const { LocalOCR } = await import('./ocr.js');
      const canvas = document.createElement('canvas');
      canvas.width = 440; canvas.height = 110;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 440, 110);
      ctx.fillStyle = '#000'; ctx.font = 'bold 76px Arial'; ctx.fillText('25:40', 30, 82);
      const reader = new LocalOCR();
      try { return await reader.read(canvas); } finally { await reader.close(); }
    });
    assert.equal(ocrResult.value, 1540);
    assert.ok(ocrResult.confidence >= 65, JSON.stringify(ocrResult));
    await page.setViewportSize({ width: 480, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ extensionLoaded: true, demoCalibration: true, driftRecovery: true, zeroOffset: true, trim: true, stop: true, ocr: ocrResult, narrowLayout: true, pageErrors: errors }, null, 2));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
