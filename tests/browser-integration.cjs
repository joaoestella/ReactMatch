// End to end with real tabs: a "creator live" and a "game" whose clocks are
// burned into the video, 20 s apart. Needs ffmpeg with drawtext on PATH to
// build the fixtures. Run: npm run test:browser
//
// Video 1 is the game, video 2 the reaction; one click on "Sync now".
// 1. The game is embedded from another site (iframe). It must pick the match
//    clocks (not the uptime nor a static "Replay 12:30"), sync, and recover
//    from a 7 s jump.
// 2. The game is a live with a 3 s rewind window: being ahead, it pauses.
// 3. Same live, but the player jumps back to live when resumed: detected,
//    and the reaction skips ahead instead.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reactmatch-it-'));
const extension = path.join(scratch, 'extension');
fs.cpSync(path.resolve(__dirname, '../extension'), extension, { recursive: true });
// Test copy only: pre-grant the two local origins so no permission prompt appears.
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));

function fixture(name, seconds, clockStart, overlay) {
  const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C\\:/Windows/Fonts/arialbd.ttf'].find(f => fs.existsSync(f.replace('\\', ''))) || 'DejaVuSans-Bold.ttf';
  const clock = start => `%{eif\\:floor((t+${start})/60)\\:d\\:2}\\:%{eif\\:mod(floor(t+${start})\\,60)\\:d\\:2}`;
  const filters = ['format=yuv420p', 'noise=alls=10:allf=t', ...overlay(font, clock(clockStart), clock)].join(',');
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

// Halftime. The game's clock reaches 45:00 at 50 s, disappears for the break,
// and restarts at 00:00 for the second half at 70 s ("2T 00:00"). The
// creator's own clock goes on counting from 45:00 when they restart it, 20 s
// later in their video, like the first half. Same match moments, clocks 45 min apart.
const gameHalf = fixture('game-half', 120, 2650, (font, first, clock) => [
  'drawbox=x=40:y=30:w=330:h=56:color=0x101820@0.92:t=fill',
  `drawtext=fontfile=${font}:text='BRA 1 - 0 ARG':x=56:y=44:fontsize=26:fontcolor=white`,
  `drawtext=fontfile=${font}:text='${first}':x=270:y=44:fontsize=26:fontcolor=0xffe066:enable='lt(t\,50)'`,
  `drawtext=fontfile=${font}:text='${clock(-70)}':x=270:y=44:fontsize=26:fontcolor=0xffe066:enable='gte(t\,70)'`
]);
const reactionHalf = fixture('reaction-half', 120, 2630, (font, first, clock) => [
  'drawbox=x=60:y=120:w=420:h=420:color=0x3b2f2f@1:t=fill',
  `drawtext=fontfile=${font}:text='CREATOR CAM':x=150:y=320:fontsize=30:fontcolor=0xd8c7b0`,
  'drawbox=x=1080:y=640:w=170:h=50:color=0x0b0b0b@0.85:t=fill',
  `drawtext=fontfile=${font}:text='${first}':x=1110:y=650:fontsize=30:fontcolor=white:enable='lt(t\,70)'`,
  `drawtext=fontfile=${font}:text='${clock(2610)}':x=1110:y=650:fontsize=30:fontcolor=white:enable='gte(t\,90)'`
]);

let port;
const files = { '/game.webm': game, '/reaction.webm': reaction, '/game-half.webm': gameHalf, '/reaction-half.webm': reactionHalf };
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
  '/game-half': '<title>Game, halftime</title><body style="margin:0;background:#000"><video id=v src="/game-half.webm" muted style="width:100vw;height:56.25vw"></video>',
  '/reaction-half': '<title>Creator, halftime</title><body style="margin:0;background:#000"><video id=v src="/reaction-half.webm" muted style="width:100vw;height:56.25vw"></video>',
  '/reaction': '<title>Creator live</title><body style="margin:0;background:#000"><video id=v src="/reaction.webm" muted style="width:100vw;height:56.25vw"></video>',
  '/game': () => `<title>Game page</title><body style="margin:0;background:#222;color:#fff"><h3>Some site</h3><iframe src="http://localhost:${port}/embed" width=960 height=540></iframe>`,
  '/embed': '<body style="margin:0"><video id=v src="/game.webm" muted width=960 height=540></video>',
  '/game-top': '<title>Game here</title><body style="margin:0;background:#000"><video id=v src="/game.webm" muted style="width:100vw;height:56.25vw"></video>',
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
const extensionId = dir => [...require('node:crypto').createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 32)]
  .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM || chromium.executablePath(), headless: !process.env.HEADFUL,
    // Unpacked extensions get their ID from their path. The allowlist switch
    // stands in for clicking the icon on the reaction's tab (tab capture).
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required', '--lang=en-US', '--window-size=1280,900', `--allowlisted-extension-id=${extensionId(extension)}`],
    viewport: null, // real window sizes, so a tab capture matches the page's own size
  });
  const report = {};
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const panelUrl = `chrome-extension://${new URL(worker.url()).host}/panel.html`;
    const errors = [];

    async function scenario(gamePath, frameOf, arrange = false, { reactionPath = '/reaction', gameAt = 50, reactionAt = 40 } = {}) {
      const panel = await context.newPage();
      panel.on('pageerror', error => errors.push(error.message));
      await panel.goto(panelUrl);
      const creator = await context.newPage();
      await creator.goto(`${base}${reactionPath}`);
      const gamePage = await context.newPage();
      await gamePage.goto(`${base}${gamePath}`);
      await creator.waitForFunction(() => document.getElementById('v').readyState >= 3);
      await creator.evaluate(at => { const v = document.getElementById('v'); v.currentTime = at; v.play(); }, reactionAt);
      let frame;
      for (let i = 0; i < 50 && !(frame = frameOf(gamePage)); i++) await sleep(100);
      await frame.waitForFunction(() => window.ready || document.getElementById('v').readyState >= 3, null, { timeout: 20000 });
      if (!gamePath.startsWith('/live')) await frame.evaluate(at => { const v = document.getElementById('v'); v.currentTime = at; v.play(); }, gameAt);
      await sleep(800);
      await panel.bringToFront();
      await panel.locator('#refresh').click();
      const tabs = await panel.evaluate(async () => (await chrome.tabs.query({})).map(tab => [tab.id, tab.url]));
      const tabOf = suffix => String(tabs.find(tab => tab[1].endsWith(suffix))[0]);
      for (const [role, suffix] of [['reference', gamePath], ['follower', reactionPath]]) {
        await panel.locator(`#${role}-tab`).selectOption(tabOf(suffix));
        await panel.locator(`#${role}-connect`).click();
        await panel.waitForFunction(role => document.getElementById(`${role}-connection`).textContent === 'Connected', role);
      }
      const waitTitle = (test, timeout = 30000) => panel.waitForFunction(test => document.getElementById('status-title').textContent.startsWith(test), test, { timeout })
        .catch(async error => { throw new Error(`${error.message}\nstatus: ${await panel.locator('#status-title').textContent()} | ${await panel.locator('#status-detail').textContent()}`); });
      const offset = async () => (await frame.evaluate(() => document.getElementById('v').currentTime)) - (await creator.evaluate(() => document.getElementById('v').currentTime));
      const labels = async () => [await panel.locator('#reference-capture').textContent(), await panel.locator('#follower-capture').textContent()];
      if (arrange) {
        // Each video gets its own window, so neither is a background tab.
        await panel.locator('#arrange').click();
        await waitTitle('Videos side by side');
        const windows = await panel.evaluate(async ids => Promise.all(ids.map(async id => (await chrome.tabs.get(id)).windowId)), [Number(tabOf(gamePath)), Number(tabOf(reactionPath))]);
        assert.notEqual(windows[0], windows[1]);
      }
      // One click: finds both clocks and starts syncing.
      await panel.locator('#start').click();
      return { panel, creator, gamePage, frame, waitTitle, offset, labels, started: Date.now() };
    }

    // 1. Embedded player on another site.
    const embedded = await scenario('/game', page => page.frames().find(frame => frame.url().includes('/embed')), true);
    await embedded.waitTitle('Videos in sync');
    const syncMs = Date.now() - embedded.started;
    const found = await embedded.labels();
    assert.match(found[0], /^Clock 2[5-7]:\d\d · change$/, 'game: the match clock, not "Replay 12:30": ' + found[0]);
    assert.match(found[1], /^Clock 2[5-7]:\d\d · change$/, 'reaction: the match clock, not the uptime');
    const synced = await embedded.offset();
    assert.ok(Math.abs(synced + 20) < 0.6, `offset after sync ${synced}`);
    await embedded.frame.evaluate(() => { document.getElementById('v').currentTime += 7; });
    await embedded.waitTitle('Adjusting video 1');
    await embedded.waitTitle('Videos in sync');
    await sleep(3000);
    const recovered = await embedded.offset();
    assert.ok(Math.abs(recovered + 20) < 0.6, `offset after drift ${recovered}`);
    report.embedded = { found, msToSync: syncMs, offsetAfterSync: +synced.toFixed(2), offsetAfterDrift: +recovered.toFixed(2) };
    await embedded.panel.close(); await embedded.creator.close(); await embedded.gamePage.close();

    // 2. Live game with 3 s of rewind, ahead of the reaction: it waits by pausing.
    const live = await scenario('/live', page => page.mainFrame());
    await live.waitTitle('Holding video 1');
    const holdText = await live.panel.locator('#status-detail').textContent();
    await live.waitTitle('Videos in sync', 40000);
    await sleep(3000);
    const held = await live.offset();
    assert.ok(Math.abs(held + 20) < 0.8, `offset after hold ${held}`);
    report.liveHold = { found: await live.labels(), hold: holdText, offsetAfterHold: +held.toFixed(2) };
    await live.panel.close(); await live.creator.close(); await live.gamePage.close();

    // 3. A live player that jumps to live when resumed.
    //    Then the reaction, which can, skips ahead instead.
    const jumpy = await scenario('/live?jump', page => page.mainFrame());
    await jumpy.waitTitle('Holding video 1');
    await jumpy.waitTitle('Video 1 jumps back to live', 40000);
    await jumpy.waitTitle('Adjusting video 2', 30000);
    await jumpy.waitTitle('Videos in sync', 30000);
    await sleep(3000);
    const skipped = await jumpy.offset();
    assert.ok(Math.abs(skipped + 20) < 0.8, `offset after the reaction skipped ahead ${skipped}`);
    report.liveJump = { detected: true, offsetAfterSkip: +skipped.toFixed(2) };
    await jumpy.panel.close(); await jumpy.creator.close(); await jumpy.gamePage.close();

    // 4. The creator's cam over the game, with the reaction's sound mixed in.
    const pipCase = await scenario('/game-top', page => page.mainFrame());
    await pipCase.waitTitle('Videos in sync');
    const p = pipCase.panel;
    assert.equal(new URL(await p.evaluate(() => chrome.runtime.getURL(''))).host, extensionId(extension));
    // Clicking the icon on the reaction's tab lets it be read in the background
    // (the background script relays the click; here it's sent by hand).
    const reactionTab = await p.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url.endsWith('/reaction')).id);
    await worker.evaluate(id => chrome.runtime.sendMessage({ type: 'reactmatch-invoked', tabId: id }), reactionTab);
    await pipCase.waitTitle('Video 2 in the background');
    await p.locator('#pip-pick').click();
    await p.locator('#crop-dialog').waitFor({ state: 'visible' });
    const canvas = await p.locator('#crop-canvas').boundingBox();
    // The "CREATOR CAM" box of the reaction video: (60, 120) to (480, 540) of 1280x720.
    await p.mouse.move(canvas.x + canvas.width * 60 / 1280, canvas.y + canvas.height * 120 / 720); await p.mouse.down();
    await p.mouse.move(canvas.x + canvas.width * 480 / 1280, canvas.y + canvas.height * 540 / 720); await p.mouse.up();
    await p.locator('#crop-save').click();
    await p.locator('#pip-toggle').click();
    await pipCase.waitTitle('Cam on the game');
    const gameTab = await p.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url.endsWith('/game-top')).id);
    const stats = () => p.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => globalThis.__reactMatchPip?.stats() ?? null }))[0].result, gameTab);
    await sleep(1500);
    const shown = await stats();
    if (process.env.SHOTS) { await pipCase.gamePage.screenshot({ path: path.join(process.env.SHOTS, 'pip.png') }); }
    const videoRect = await pipCase.gamePage.evaluate(() => { const r = document.getElementById('v').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    // The cam is #3b2f2f with a little light text: that's its average colour.
    assert.ok(shown.colour.every((v, i) => Math.abs(v - [0x3b, 0x2f, 0x2f][i]) < 30), `cam colour ${shown.colour}`);
    assert.ok(shown.box.x + shown.box.width <= videoRect.x + videoRect.width && shown.box.x > videoRect.x + videoRect.width / 2, 'bottom-right of the game');
    assert.ok(Math.abs(shown.box.width / shown.box.height - 1) < 0.1, 'keeps the cam square: ' + JSON.stringify(shown));
    await p.locator('[data-corner="top-left"]').click();
    await sleep(500);
    const moved = await stats();
    assert.ok(moved.box.x < videoRect.x + videoRect.width / 2 && moved.box.y < videoRect.y + videoRect.height / 2, 'top-left of the game');
    await p.locator('#vol-react').fill('30');
    await p.locator('#vol-main').fill('50');
    await sleep(400);
    assert.ok(Math.abs((await stats()).volume - 0.3) < 0.01, 'reaction volume');
    assert.equal(await pipCase.gamePage.evaluate(() => document.getElementById('v').volume), 0.5);
    // The ⋯ menu on the cam: corner, volumes and size, kept in step with the panel.
    const press = (what, value) => p.evaluate(async ([id, w, v]) => { await chrome.scripting.executeScript({ target: { tabId: id }, func: (a, b) => globalThis.__reactMatchPip.press(a, b), args: [w, v ?? null] }); }, [gameTab, what, value]);
    await press('open');
    const opened = await stats();
    if (process.env.SHOTS) await pipCase.gamePage.screenshot({ path: path.join(process.env.SHOTS, 'pip-menu.png') });
    assert.ok(opened.menu && opened.menu.width > 200, 'menu open');
    assert.ok(opened.status, 'menu shows the sync status');
    await press('corner', 'bottom-left');
    await press('react', 70);
    await press('game', 80);
    await press('size', 40);
    await sleep(600);
    const viaMenu = await stats();
    assert.equal(viaMenu.corner, 'bottom-left');
    assert.ok(Math.abs(viaMenu.volume - 0.7) < 0.01 && Math.abs(viaMenu.size - 0.4) < 0.01);
    assert.equal(await p.locator('[data-corner="bottom-left"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await p.locator('#vol-react').inputValue(), '70');
    assert.equal(await p.locator('#pip-size').inputValue(), '40');
    assert.equal(await pipCase.gamePage.evaluate(() => document.getElementById('v').volume), 0.8);
    await press('resync');
    await pipCase.waitTitle('Syncing started');
    await pipCase.waitTitle('Videos in sync');
    await press('close');
    await pipCase.waitTitle('Cam removed');
    assert.equal(await stats(), null);
    report.pip = { box: shown.box, colour: shown.colour, corners: true, volumes: true, menu: true, background: true };

    // 5. Halftime: the clocks vanish, then come back 45 min apart. The videos
    //    must stay where they are, not jump 45 minutes.
    const half = await scenario('/game-half', page => page.mainFrame(), false, { reactionPath: '/reaction-half', gameAt: 28, reactionAt: 40 });
    await half.waitTitle('Videos in sync');
    const beforeBreak = await half.offset();
    assert.ok(Math.abs(beforeBreak + 20) < 0.6, `offset before halftime ${beforeBreak}`);
    await half.waitTitle('Clock stopped or gone', 40000);
    await half.waitTitle('New half, same sync', 60000);
    await sleep(4000);
    const afterBreak = await half.offset();
    assert.ok(Math.abs(afterBreak + 20) < 0.6, `offset after halftime ${afterBreak}`);
    report.halftime = { offsetBefore: +beforeBreak.toFixed(2), offsetAfter: +afterBreak.toFixed(2) };

    assert.deepEqual(errors, []);
    report.pageErrors = errors;
    console.log(JSON.stringify(report, null, 2));
  } finally { await context.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
