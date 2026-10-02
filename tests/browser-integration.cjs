// End to end with real tabs: a "creator live" and a "game" whose clocks are
// burned into the video, 20 s apart. Needs ffmpeg with drawtext on PATH to
// build the fixtures. Run: npm run test:browser
//
// 1. The game is embedded from another site (iframe). "Find clocks" must pick
//    the match clocks (not the uptime nor a static "Replay 12:30"), sync, and
//    recover from a 7 s jump.
// 2. The game is a live with a 3 s rewind window: B has to pause to wait.
// 3. Same live, but the player jumps back to live when resumed: detected.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'syncvideo-it-'));
const extension = path.join(scratch, 'extension');
fs.cpSync(path.resolve(__dirname, '../extension'), extension, { recursive: true });
// Test copy only: pre-grant the two local origins so no permission prompt appears.
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));

function fixture(name, seconds, clockStart, overlay) {
  const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C\\:/Windows/Fonts/arialbd.ttf'].find(f => fs.existsSync(f.replace('\\', ''))) || 'DejaVuSans-Bold.ttf';
  const clock = start => `%{eif\\:floor((t+${start})/60)\\:d\\:2}\\:%{eif\\:mod(floor(t+${start})\\,60)\\:d\\:2}`;
  const filters = ['format=yuv420p', 'noise=alls=10:allf=t', ...overlay(font, clock(clockStart))].join(',');
  const script = path.join(scratch, `${name}.txt`);
  fs.writeFileSync(script, filters);
  const out = path.join(scratch, `${name}.webm`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=1280x720:r=10:speed=0.015:n=2`, '-t', String(seconds),
    '-filter_complex_script', script, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '900k', '-g', '10', out]);
  return fs.readFileSync(out);
}

const game = fixture('game', 120, 1500, (font, clock) => [
  'drawbox=x=40:y=30:w=330:h=56:color=0x101820@0.92:t=fill',
  `drawtext=fontfile=${font}:text='BRA 1 - 0 ARG':x=56:y=44:fontsize=26:fontcolor=white`,
  `drawtext=fontfile=${font}:text='${clock}':x=270:y=44:fontsize=26:fontcolor=0xffe066`,
  `drawtext=fontfile=${font}:text='Replay 12\\:30':x=1040:y=660:fontsize=22:fontcolor=white`
]);
const reaction = fixture('reaction', 120, 1480, (font, clock) => [
  'drawbox=x=60:y=120:w=420:h=420:color=0x3b2f2f@1:t=fill',
  `drawtext=fontfile=${font}:text='CREATOR CAM':x=150:y=320:fontsize=30:fontcolor=0xd8c7b0`,
  'drawbox=x=1010:y=20:w=250:h=44:color=black@0.6:t=fill',
  `drawtext=fontfile=${font}:text='LIVE %{eif\\:1+floor((t+135)/3600)\\:d}\\:%{eif\\:mod(floor((t+135)/60)\\,60)\\:d\\:2}\\:%{eif\\:mod(floor(t+135)\\,60)\\:d\\:2}':x=1025:y=30:fontsize=24:fontcolor=white`,
  'drawbox=x=1080:y=640:w=170:h=50:color=0x0b0b0b@0.85:t=fill',
  `drawtext=fontfile=${font}:text='${clock}':x=1110:y=650:fontsize=30:fontcolor=white`
]);

let port;
const files = { '/game.webm': game, '/reaction.webm': reaction };
// A live player: the file is fed through Media Source as if it were arriving
// in real time, with only 3 s of rewind. ?jump makes it jump to live on play.
const live = `<title>Live game</title><body style="margin:0"><video id=v muted width=960 height=540></video><script>
const v = document.getElementById('v'), ms = new MediaSource(); v.src = URL.createObjectURL(ms);
ms.addEventListener('sourceopen', async () => {
  ms.duration = Infinity;
  const sb = ms.addSourceBuffer('video/webm; codecs="vp8"');
  const data = new Uint8Array(await (await fetch('/game.webm')).arrayBuffer());
  let pos = 0; const t0 = performance.now(), START = 28;
  const edge = () => START + (performance.now() - t0) / 1000;
  (function pump() {
    if (!sb.updating) {
      const end = sb.buffered.length ? sb.buffered.end(0) : 0;
      if (end < edge() + 1 && pos < data.length) { sb.appendBuffer(data.subarray(pos, pos + 65536)); pos += 65536; }
      else if (sb.buffered.length && sb.buffered.start(0) < edge() - 4 && v.currentTime > edge() - 3) sb.remove(0, edge() - 4);
      if (ms.readyState === 'open') ms.setLiveSeekableRange(Math.max(0, edge() - 3), edge());
    }
    setTimeout(pump, 30);
  })();
  if (location.search.includes('jump')) v.addEventListener('play', () => { if (window.ready) v.currentTime = edge() - 0.3; });
  const go = setInterval(() => { if (sb.buffered.length && sb.buffered.end(0) > START + 0.5) { clearInterval(go); v.currentTime = START; v.play(); window.ready = true; } }, 50);
});
</script>`;
const pages = {
  '/reaction': '<title>Creator live</title><body style="margin:0;background:#000"><video id=v src="/reaction.webm" muted width=960 height=540></video>',
  '/game': () => `<title>Game page</title><body style="margin:0;background:#222;color:#fff"><h3>Some site</h3><iframe src="http://localhost:${port}/embed" width=960 height=540></iframe>`,
  '/embed': '<body style="margin:0"><video id=v src="/game.webm" muted width=960 height=540></video>',
  '/live': live
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = files[url];
  if (file) {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      res.end(file.subarray(start, end + 1));
    } else { res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': file.length, 'Accept-Ranges': 'bytes' }); res.end(file); }
    return;
  }
  const page = pages[url];
  res.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(typeof page === 'function' ? page() : page || '');
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required', '--lang=en-US'],
    viewport: { width: 1160, height: 950 }
  });
  const report = {};
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const panelUrl = `chrome-extension://${new URL(worker.url()).host}/panel.html`;
    const errors = [];

    async function scenario(gamePath, frameOf) {
      const panel = await context.newPage();
      panel.on('pageerror', error => errors.push(error.message));
      await panel.goto(panelUrl);
      const creator = await context.newPage();
      await creator.goto(`${base}/reaction`);
      const gamePage = await context.newPage();
      await gamePage.goto(`${base}${gamePath}`);
      await creator.waitForFunction(() => document.getElementById('v').readyState >= 3);
      await creator.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 40; v.play(); });
      let frame;
      for (let i = 0; i < 50 && !(frame = frameOf(gamePage)); i++) await sleep(100);
      await frame.waitForFunction(() => window.ready || document.getElementById('v').readyState >= 3, null, { timeout: 20000 });
      if (!gamePath.startsWith('/live')) await frame.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 50; v.play(); });
      await sleep(800);
      await panel.bringToFront();
      await panel.locator('#refresh').click();
      const tabs = await panel.evaluate(async () => (await chrome.tabs.query({})).map(tab => [tab.id, tab.url]));
      const tabOf = suffix => String(tabs.find(tab => tab[1].endsWith(suffix))[0]);
      for (const [role, suffix] of [['reference', '/reaction'], ['follower', gamePath]]) {
        await panel.locator(`#${role}-tab`).selectOption(tabOf(suffix));
        await panel.locator(`#${role}-connect`).click();
        await panel.waitForFunction(role => document.getElementById(`${role}-connection`).textContent === 'Connected', role);
      }
      const waitTitle = (test, timeout = 30000) => panel.waitForFunction(test => document.getElementById('status-title').textContent.startsWith(test), test, { timeout })
        .catch(async error => { throw new Error(`${error.message}\nstatus: ${await panel.locator('#status-title').textContent()} | ${await panel.locator('#status-detail').textContent()}`); });
      const started = Date.now();
      await panel.locator('#find-clocks').click();
      await waitTitle('Clocks ready');
      const found = [await panel.locator('#reference-capture').textContent(), await panel.locator('#follower-capture').textContent()];
      const offset = async () => (await frame.evaluate(() => document.getElementById('v').currentTime)) - (await creator.evaluate(() => document.getElementById('v').currentTime));
      return { panel, creator, gamePage, frame, waitTitle, offset, found, findMs: Date.now() - started };
    }

    // 1. Embedded player on another site.
    const embedded = await scenario('/game', page => page.frames().find(frame => frame.url().includes('/embed')));
    assert.match(embedded.found[0], /^Clock 25:\d\d · change$/, 'reaction: the match clock, not the uptime');
    assert.match(embedded.found[1], /^Clock 25:\d\d · change$/, 'game: the match clock, not "Replay 12:30"');
    await embedded.panel.locator('#start').click();
    await embedded.waitTitle('Videos in sync');
    const synced = await embedded.offset();
    assert.ok(Math.abs(synced + 20) < 0.6, `offset after sync ${synced}`);
    await embedded.frame.evaluate(() => { document.getElementById('v').currentTime += 7; });
    await embedded.waitTitle('Adjusting video B');
    await embedded.waitTitle('Videos in sync');
    await sleep(3000);
    const recovered = await embedded.offset();
    assert.ok(Math.abs(recovered + 20) < 0.6, `offset after drift ${recovered}`);
    report.embedded = { found: embedded.found, findMs: embedded.findMs, offsetAfterSync: +synced.toFixed(2), offsetAfterDrift: +recovered.toFixed(2) };
    await embedded.panel.close(); await embedded.creator.close(); await embedded.gamePage.close();

    // 2. Live game with 3 s of rewind: B waits by pausing.
    const live = await scenario('/live', page => page.mainFrame());
    await live.panel.locator('#start').click();
    await live.waitTitle('Holding video B');
    const holdText = await live.panel.locator('#status-detail').textContent();
    await live.waitTitle('Videos in sync', 40000);
    await sleep(3000);
    const held = await live.offset();
    assert.ok(Math.abs(held + 20) < 0.8, `offset after hold ${held}`);
    report.liveHold = { found: live.found, hold: holdText, offsetAfterHold: +held.toFixed(2) };
    await live.panel.close(); await live.creator.close(); await live.gamePage.close();

    // 3. A live player that jumps to live when resumed.
    const jumpy = await scenario('/live?jump', page => page.mainFrame());
    await jumpy.panel.locator('#start').click();
    await jumpy.waitTitle('Holding video B');
    await jumpy.waitTitle('Video B jumps back to live', 40000);
    report.liveJumpDetected = true;

    assert.deepEqual(errors, []);
    report.pageErrors = errors;
    console.log(JSON.stringify(report, null, 2));
  } finally { await context.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
