const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'syncvideo-integration-'));
const extension = path.join(scratch, 'extension');
const browserRoot = path.dirname(path.dirname(path.dirname(chromium.executablePath())));
const ffmpegFolder = fs.readdirSync(browserRoot).find(name => name.startsWith('ffmpeg-'));
const ffmpeg = path.join(browserRoot, ffmpegFolder || '', process.platform === 'win32' ? 'ffmpeg-win64.exe' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux');
fs.cpSync(path.resolve(__dirname, '../extension'), extension, { recursive: true });
const manifestPath = path.join(extension, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
manifest.host_permissions = ['http://127.0.0.1/*'];
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
let video;
const fixture = `<!doctype html><html><head><title>SyncVideo fixture</title></head><body style="margin:0;background:#111;color:white"><div id="clock" style="position:relative;width:340px;height:100px;background:white;color:black;font:bold 76px Arial;padding:10px 20px;box-sizing:border-box">00:00</div><h1>SyncVideo local fixture</h1><video width="640" height="360" controls preload="auto" muted src="/fixture.webm"></video><script>setInterval(()=>{const n=Math.floor(document.querySelector('video').currentTime+900);document.getElementById('clock').textContent=String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')},100)</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/fixture.webm')) {
    const range = req.headers.range;
    if (range) {
      const [, first, last] = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(first), end = last ? Math.min(Number(last), video.length - 1) : video.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': `bytes ${start}-${end}/${video.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 }); res.end(video.subarray(start, end + 1));
    } else { res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': video.length, 'Accept-Ranges': 'bytes' }); res.end(video); }
  } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture); }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: chromium.executablePath(),
    headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required', '--auto-select-tab-capture-source-by-title=SyncVideo capture target'],
    viewport: { width: 1160, height: 950 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const panel = await context.newPage();
    const errors = []; panel.on('pageerror', error => errors.push(error.message));
    await panel.goto(`chrome-extension://${id}/panel.html`);
    const png = Buffer.from(await panel.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#163343'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#b7f4ce'; ctx.font = '40px Arial'; ctx.fillText('SyncVideo • teste local', 80, 180);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    }), 'base64');
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '10', '-i', 'pipe:0', '-c:v', 'libvpx', '-b:v', '100k', path.join(scratch, 'fixture.webm')], { windowsHide: true });
      let error = ''; child.stderr.on('data', chunk => error += chunk);
      child.stdin.on('error', () => {});
      child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
      for (let i = 0; i < 1800; i++) child.stdin.write(png);
      child.stdin.end();
    });
    video = fs.readFileSync(path.join(scratch, 'fixture.webm'));
    const pages = [await context.newPage(), await context.newPage()];
    for (let i = 0; i < pages.length; i++) {
      await pages[i].goto(`${base}/${i === 0 ? 'reference' : 'follower'}`);
      await pages[i].waitForFunction(() => document.querySelector('video').readyState >= 3);
      await pages[i].evaluate(time => { document.querySelector('video').currentTime = time; }, i ? 25 : 10);
      await pages[i].waitForFunction(() => !document.querySelector('video').seeking);
    }
    await panel.bringToFront();
    // Grant only our localhost fixture origin through the real permissions API.
    assert.equal(await panel.evaluate(async () => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })), true);
    await panel.locator('#refresh').click();
    const tabs = await panel.evaluate(async () => (await chrome.tabs.query({})).filter(tab => tab.url.startsWith('http://127.0.0.1')));
    const a = tabs.find(tab => tab.url.endsWith('/reference'));
    const b = tabs.find(tab => tab.url.endsWith('/follower'));
    await panel.locator('#reference-tab').selectOption(String(a.id));
    await panel.locator('#reference-connect').click();
    await panel.waitForFunction(() => document.getElementById('reference-connection').textContent === 'Conectado');
    await panel.locator('#follower-tab').selectOption(String(b.id));
    await panel.locator('#follower-connect').click();
    await panel.waitForFunction(() => document.getElementById('follower-connection').textContent === 'Conectado');
    await panel.locator('#calibrate').click();
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Referência marcada');
    await panel.locator('#start').click();
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Vídeos acompanhando juntos');
    await pages[1].evaluate(() => { const v = document.querySelector('video'); v.currentTime -= 6; });
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Ajustando o vídeo B');
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Vídeos acompanhando juntos');
    const time = await Promise.all(pages.map(page => page.evaluate(() => document.querySelector('video').currentTime)));
    assert.ok(Math.abs(time[1] - time[0] - 15) < 0.9, `Offset expected 15, got ${time[1] - time[0]}`);
    await pages[0].evaluate(() => document.querySelector('video').pause());
    await pages[1].waitForFunction(() => document.querySelector('video').paused);
    await pages[0].evaluate(() => document.querySelector('video').play());
    await pages[1].waitForFunction(() => !document.querySelector('video').paused);
    // A replacement source must invalidate calibration, never carry the old offset forward.
    await pages[1].evaluate(() => { const v = document.querySelector('video'); v.src = '/fixture.webm?new-content'; });
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'O conteúdo mudou');
    assert.equal(await panel.locator('#start').isDisabled(), true);
    // Real getDisplayMedia streams of the fixture tabs, with Chromium's test-only source picker.
    for (const page of pages) {
      await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 20; });
      await page.waitForFunction(() => !document.querySelector('video').seeking && document.querySelector('video').readyState >= 3);
    }
    await pages[1].evaluate(() => { document.querySelector('video').currentTime = 25; });
    await panel.locator('#mode-clock').click();
    for (let index = 0; index < pages.length; index++) {
      await pages[index].evaluate(() => document.title = 'SyncVideo capture target');
      await panel.bringToFront();
      await panel.locator(`#${index ? 'follower' : 'reference'}-capture`).click();
      await panel.locator('#crop-dialog').waitFor({ state: 'visible', timeout: 12000 });
      const canvas = await panel.locator('#crop-canvas').boundingBox();
      await panel.mouse.move(canvas.x + canvas.width * 10 / 1160, canvas.y + canvas.height * 5 / 950);
      await panel.mouse.down();
      await panel.mouse.move(canvas.x + canvas.width * 330 / 1160, canvas.y + canvas.height * 95 / 950);
      await panel.mouse.up();
      await panel.locator('#crop-save').click();
      await pages[index].evaluate(() => document.title = 'SyncVideo fixture connected');
    }
    await panel.locator('#read-clocks').click();
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Confira os tempos lidos', null, { timeout: 20000 });
    assert.equal(await panel.locator('#clock-reference').inputValue(), '15:20');
    assert.equal(await panel.locator('#clock-follower').inputValue(), '15:25');
    await panel.locator('#calibrate').click();
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Referência marcada');
    await panel.locator('#start').click();
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Vídeos acompanhando juntos', null, { timeout: 25000 });
    await pages[1].evaluate(() => { document.querySelector('video').currentTime += 5; });
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Ajustando o vídeo B', null, { timeout: 25000 });
    await panel.waitForFunction(() => document.getElementById('status-title').textContent === 'Vídeos acompanhando juntos', null, { timeout: 25000 });
    await panel.locator('#clear-captures').click();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ realTabs: true, localhostPermissionPreGrantedInTestCopy: true, mediaDiscovery: true, calibratedOffset: 15, measuredOffset: time[1] - time[0], driftRecovery: true, pauseFollow: true, resumeFollow: true, contentChangeStopsSync: true, realTabCapture: true, cropAndRead: true, continuousOcrRecovery: true, pageErrors: errors }, null, 2));
  } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
