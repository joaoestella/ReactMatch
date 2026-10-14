// Real ReactMatch on illustrated content, for the store screenshots.
// Usage: node capture.cjs <lang en|pt|es> <outdir>
// Needs game.webm and react.webm next to it (see README.md here) and, optionally,
// INTER_CSS pointing to a CSS file with an @font-face named InterV.
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const [LANG, OUT] = process.argv.slice(2);
const SC = __dirname;
const T = {
  pt: { game: 'AO VIVO | Leões x Tigres – Final do Estadual', react: 'REACT AO VIVO: Leões x Tigres com a resenha', d1: 'Bolo de cenoura fofinho – Receitas', d2: 'Caixa de entrada (3)', ch1: 'FutPlay Esportes', ch2: 'Resenha Live', w1: '12 mil assistindo', w2: '3,4 mil assistindo' },
  en: { game: 'LIVE | Lions vs Tigers – Cup Final', react: 'LIVE REACT: Lions vs Tigers watch-along', d1: 'Fluffy carrot cake – Recipes', d2: 'Inbox (3)', ch1: 'FutPlay Sports', ch2: 'Matchday Live', w1: '12K watching', w2: '3.4K watching' },
  es: { game: 'EN VIVO | Leones vs Tigres – Final', react: 'REACCIÓN EN VIVO: Leones vs Tigres', d1: 'Bizcocho de zanahoria – Recetas', d2: 'Bandeja de entrada (3)', ch1: 'FutPlay Deportes', ch2: 'Tertulia Live', w1: '12 mil viendo', w2: '3,4 mil viendo' }
}[LANG];
const files = { '/game.webm': fs.readFileSync(path.join(SC, 'game.webm')), '/react.webm': fs.readFileSync(path.join(SC, 'react.webm')) };
const page = (title, src, channel, watching, color) => `<!doctype html><title>${title}</title><meta charset=utf-8>
<style>::-webkit-scrollbar{display:none}</style><body style="margin:0;background:#0f0f10;color:#f1f1f1;font-family:Arial,sans-serif">
<video id=v src="${src}" muted autoplay loop style="display:block;width:100vw;height:56.25vw;background:#000"></video>
<div style="padding:14px 24px"><div style="font-size:20px;font-weight:700">${title}</div>
<div style="display:flex;align-items:center;gap:10px;margin-top:10px;color:#aaa;font-size:14px"><span style="width:36px;height:36px;border-radius:50%;background:${color};display:inline-block"></span><b style="color:#eee">${channel}</b> · ${watching}</div></div>`;
const pages = {
  '/game': page(T.game, '/game.webm', T.ch1, T.w1, '#1d4ed8'),
  '/react': page(T.react, '/react.webm', T.ch2, T.w2, '#7c3aed'),
  '/d1': `<title>${T.d1}</title><body style="background:#fff8ef;font:20px Georgia;padding:40px">${T.d1}`,
  '/d2': `<title>${T.d2}</title><body style="background:#fff;font:16px Arial;padding:40px">${T.d2}`
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0], file = files[url];
  if (file) {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) { const a = +m[1], b = m[2] ? Math.min(+m[2], file.length - 1) : file.length - 1; res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': `bytes ${a}-${b}/${file.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 }); return res.end(file.subarray(a, b + 1)); }
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': file.length }); return res.end(file);
  }
  res.writeHead(pages[url] ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(pages[url] || '');
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-cap-'));
  const ext = path.join(tmp, 'extension');
  fs.cpSync(path.resolve(__dirname, '../../extension'), ext, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json')));
  mf.host_permissions = ['http://futplay.tv/*', 'http://resenhalive.tv/*'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));
  const id = [...require('crypto').createHash('sha256').update(fs.realpathSync(ext)).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    executablePath: process.env.CHROMIUM, headless: false, viewport: null,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', `--lang=${LANG === 'pt' ? 'pt-BR' : LANG}`, '--window-size=1280,860', '--force-device-scale-factor=2',
      `--allowlisted-extension-id=${id}`, `--unsafely-treat-insecure-origin-as-secure=http://futplay.tv:${port},http://resenhalive.tv:${port}`, `--host-resolver-rules=MAP futplay.tv 127.0.0.1:${port}, MAP resenhalive.tv 127.0.0.1:${port}, MAP receitas.com.br 127.0.0.1:${port}, MAP mail.exemplo.com 127.0.0.1:${port}`]
  });
  const errors = [];
  try {
    const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    console.log('ids', id, new URL(worker.url()).host);
    const open = async url => { const p = await ctx.newPage(); await p.goto(url); return p; };
    const d2 = await open(`http://mail.exemplo.com:${port}/d2`);
    const d1 = await open(`http://receitas.com.br:${port}/d1`);
    const react = await open(`http://resenhalive.tv:${port}/react`);
    const game = await open(`http://futplay.tv:${port}/game`);
    await react.waitForFunction(() => document.getElementById('v').readyState >= 3);
    await game.waitForFunction(() => document.getElementById('v').readyState >= 3);
    await react.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 30; v.play(); });
    await game.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 40; v.play(); });
    // The panel in a window of its own, as the icon opens it.
    await worker.evaluate(async lang => { await chrome.storage.local.set({ lang, view: 'simple' }); await chrome.windows.create({ url: chrome.runtime.getURL('panel.html'), type: 'popup', width: 460, height: 1000, left: 1290, top: 0 }); }, LANG);
    let panel; for (let i = 0; i < 50 && !panel; i++) { panel = ctx.pages().find(p => p.url().endsWith('panel.html')); if (!panel) await sleep(100); }
    panel.on('pageerror', e => errors.push(e.message));
    await (await ctx.newCDPSession(panel)).send('Emulation.setDeviceMetricsOverride', { width: 460, height: 1000, deviceScaleFactor: 2, mobile: false });
    // Inter stands in for Segoe UI (what the panel shows on Windows); this machine only has DejaVu.
    if (process.env.INTER_CSS) await panel.addStyleTag({ content: fs.readFileSync(process.env.INTER_CSS, 'utf8') + ' body, button, input, select, output { font-family: InterV, sans-serif !important; }' });
    await panel.waitForSelector('#follower-list .tab-item');
    await sleep(800);
    await panel.screenshot({ path: `${OUT}/panel-pick-${LANG}.png` });
    const tabs = await panel.evaluate(async () => (await chrome.tabs.query({})).map(t => [t.id, t.url]));
    const tabOf = s => String(tabs.find(t => t[1].includes(s))[0]);
    await panel.click(`#reference-list button[data-tab="${tabOf('futplay')}"]`);
    await panel.waitForFunction(() => document.getElementById('reference-slot').dataset.filled === 'true');
    await panel.click(`#follower-list button[data-tab="${tabOf('resenhalive')}"]`);
    await panel.waitForFunction(() => document.getElementById('follower-slot').dataset.filled === 'true');
    await sleep(500);
    await panel.screenshot({ path: `${OUT}/panel-ready-${LANG}.png` });
    await panel.click('#start');
    await panel.waitForFunction(() => document.getElementById('go').dataset.state === 'running' && document.getElementById('status-dot').classList.contains('active') && /\d/.test(document.getElementById('status-detail').textContent) && !/[1-9]\d* s|-/.test(''), null, { timeout: 60000 });
    for (let i = 0; i < 60; i++) { const title = await panel.locator('#status-text').textContent(); if (/sync|Sincroniz/i.test(title) && !/…/.test(title) && (await panel.locator('#status-detail').textContent()).match(/\d/)) { const d = await panel.locator('#status-detail').textContent(); if (/0[.,][0-4]/.test(d)) break; } await sleep(500); }
    // Stands for the click on the ReactMatch icon in the reaction's tab, which Chrome requires before capturing it.
    await worker.evaluate(id => chrome.runtime.sendMessage({ type: 'reactmatch-invoked', tabId: id }), Number(tabOf('resenhalive')));
    await sleep(1500);
    await panel.click('#pip-toggle');
    await panel.waitForSelector('#crop-dialog[open]');
    await panel.click('#crop-full'); await panel.click('#crop-save');
    await sleep(2500);
    for (let i = 0; i < 40; i++) { const d = await panel.locator('#status-detail').textContent(); if (/0[.,][0-4] s/.test(d)) break; await sleep(500); }
    // Cam in the top-right corner, as people usually keep it (the scoreboard is top-left).
    await panel.click('[data-corner="top-right"]'); await sleep(800);
    await panel.screenshot({ path: `${OUT}/panel-synced-${LANG}.png` });
    await game.bringToFront(); await sleep(1500);
    const shot = async name => game.screenshot({ path: `${OUT}/${name}-${LANG}.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } });
    await shot('game-pip');
    await game.evaluate(() => globalThis.__reactMatchPip?.press('open'));
    await worker.evaluate(async () => {}); // nothing
    const gameTab = Number(tabOf('futplay'));
    await panel.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, func: () => globalThis.__reactMatchPip.press('open') }), gameTab);
    await sleep(800);
    await shot('game-menu');
    console.log(LANG, 'status:', await panel.locator('#status-text').textContent(), '|', await panel.locator('#status-detail').textContent(), 'errors:', errors);
  } finally { await ctx.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; server.close(); });
