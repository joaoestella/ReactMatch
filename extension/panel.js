import { BrowserAdapter } from './browser-adapter.js';
import { DemoAdapter } from './demo-adapter.js';
import { parseClock, formatTime, clockTarget, insideRanges, decideCorrection, ClockTracker, anchorFromClocks, OffsetLock, findClocks, regionAround, regionInTab } from './core.js';
import { LocalOCR, loadImage, cropFrame, startTabCapture, selectRegion, scanClocks } from './ocr.js';
import { t, setLang, getLang, detectLang, applyStatic, getLocale, LANGUAGES } from './i18n.js';

// Two videos: "reference" (1, the game/movie) and "follower" (2, the reaction).
// The names only say which offset is measured from which; corrections are
// symmetric and move whichever video is ahead.
const $ = id => document.getElementById(id);
const roles = ['reference', 'follower'];
const other = role => role === 'reference' ? 'follower' : 'reference';
const sideName = role => role === 'reference' ? '1' : '2';
const installed = !!globalThis.chrome?.scripting;
let adapter = new BrowserAdapter(), demo = false;
let sources = {}, captures = {}, tabList = [], anchor = null, trim = 0, missing = {};
let background = null;
let running = false, working = false, busy = false, revision = 0, lastSeek = -Infinity, lastOCR = 0;
let sourceKeys = null, currentKind = 'timeline', lastPaused = null;
// First offset estimates, from the frames used to find the clocks.
let seeds = [];
// The creator's cam shown over the main video (picture-in-picture).
const cam = { region: null, on: false, corner: 'bottom-right', free: null, size: 0.28, checked: 0, wanted: false };
// Tabs captured only to keep them drawing while in the background, so their
// clock can still be read (video only, small: their sound keeps playing there).
const keepAlive = { reference: null, follower: null };
// Tabs where the user has clicked the icon: Chrome lets us capture those.
const invoked = new Set();
// A video paused on purpose to let the other catch up, and players known to
// jump back to live when resumed (pausing can't delay those).
let hold = null, resumed = null, canHold = { reference: true, follower: true };
// Last frame signature per side, to notice a picture that stopped updating.
let frozen = { reference: { sig: null, since: 0 }, follower: { sig: null, since: 0 } };
const ocr = new LocalOCR();
// Turns clock readings into a steady offset (see OffsetLock in core.js).
const lock = new OffsetLock();
let clocksSeenAt = 0;
const misses = { reference: 0, follower: 0 };
// A message that stays up for a while instead of the usual "in sync" line.
let notice = null;
let trackers = { reference: new ClockTracker(), follower: new ClockTracker() };

const direction = () => Number($('direction').value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = value => new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
const seconds = value => `${value > 0.05 ? '+' : ''}${number(Math.abs(value) < 0.05 ? 0 : value)} s`;

function status(title, detail, type = '') {
  $('status-text').textContent = title; $('status-detail').textContent = detail;
  $('status-dot').className = `dot ${type}`;
  // The cam's menu shows the same line, so the panel can stay hidden.
  const line = `${title}${detail ? ` · ${detail}` : ''}`;
  if (cam.on && line !== cam.statusLine) {
    cam.statusLine = line;
    inMainTab(value => globalThis.__reactMatchPip?.set({ status: value }), { text: title, type }).catch(() => {});
  }
}
function fail(error) {
  stop(false);
  status(t('status.problem'), error.message || String(error), 'error');
}
function resetTrackers() {
  trackers = { reference: new ClockTracker(direction()), follower: new ClockTracker(direction()) };
  lock.reset(); clocksSeenAt = 0; notice = null; showClockChoice(null);
  frozen = { reference: { sig: null, since: 0 }, follower: { sig: null, since: 0 } };
  lastOCR = 0;
}
function both() { return !!sources.reference && !!sources.follower; }
function hasOCR() { return !!captures.reference && !!captures.follower; }
function updateControls() {
  const connected = both();
  for (const id of ['pause-both', 'mark-moment', 'apply-times', 'trim-minus', 'trim-plus', 'trim-reset']) $(id).disabled = !connected;
  $('start').disabled = !connected;
  $('start-word').textContent = running ? t('go.stop') : t('go.start');
  $('start').setAttribute('aria-label', running ? t('start.stop') : t('start.start'));
  $('go').dataset.state = working ? 'working' : running ? 'running' : connected ? 'ready' : 'idle';
  $('arrange').disabled = !connected;
  $('read-clocks').disabled = !hasOCR() || demo;
  $('clear-captures').hidden = !Object.keys(captures).length;
  $('trim-value').textContent = seconds(trim);
  $('trim-minus').textContent = `− ${number(0.5)} s`;
  $('trim-plus').textContent = `+ ${number(0.5)} s`;
  for (const role of roles) $(role + '-capture').disabled = !sources[role] || demo;
  $('pip-pick').disabled = !sources.follower || demo;
  $('pip-pick').textContent = cam.region ? t('pip.picked') : t('pip.pick');
  $('pip-toggle').disabled = !connected || demo;
  $('pip-toggle').setAttribute('aria-checked', String(cam.on));
  $('pip-toggle').setAttribute('aria-pressed', String(cam.on));
  $('cam').dataset.on = String(cam.on);
  for (const role of roles) renderSlot(role);
  $('vol-main').disabled = !sources.reference || demo;
  $('vol-react').disabled = !sources.follower || demo;
  for (const button of document.querySelectorAll('[data-corner]')) button.setAttribute('aria-pressed', String(button.dataset.corner === cam.corner));
}
function stop(announce = true) {
  if (hold) adapter.command(sources[hold.role], 'play').catch(() => {});
  hold = null; resumed = null; lastPaused = null;
  running = false; revision++;
  updateControls();
  if (announce) status(t('status.stopped'), t('status.stopped.detail'));
}
function clearAnchor() {
  seeds = [];
  anchor = null; sourceKeys = null; lastSeek = -Infinity;
  canHold = { reference: true, follower: true };
  $('anchor-label').textContent = t('anchor.none');
  resetTrackers(); updateControls();
}
function dropCapture(role) {
  const capture = captures[role];
  if (capture?.stream) { capture.stream.getTracks().forEach(track => track.stop()); capture.video.srcObject = null; }
  delete captures[role];
  $(role + '-capture').textContent = t('clock.select');
}
function clearCaptures() {
  for (const role of roles) dropCapture(role);
  updateControls();
}

async function refreshTabs() {
  tabList = demo || installed ? await adapter.tabs() : [];
  for (const role of roles) {
    const select = $(role + '-tab');
    const selected = select.value;
    select.replaceChildren(new Option(tabList.length ? t('tabs.pick') : t('tabs.none'), ''));
    for (const tab of tabList) select.add(new Option(tab.title, String(tab.id)));
    select.value = selected;
    renderList(role);
  }
  if (!installed && !demo) status(t('status.tryDemo'), t('status.tryDemo.detail'));
}

const host = origin => new URL(origin).hostname;
const sameVideo = (a, b) => a && b && a.tabId === b.tabId && a.frameId === b.frameId && a.videoId === b.videoId;

function showMissing(role) {
  // Embedded players are only worth asking about when no video was found.
  const list = sources[role] ? [] : missing[role] || [];
  $(role + '-allow').hidden = !list.length;
  $(role + '-allow').textContent = t('allow.button', { sites: list.map(host).join(', ') });
}

// Forgets the video connected on one side (a new tab was picked, or "Change").
function release(role) {
  stop(false); clearAnchor();
  if (cam.on) hideCam(false).catch(() => {});
  stopDrawing(role);
  if (role === 'follower') cam.region = null;
  delete sources[role]; missing[role] = []; showMissing(role);
  dropCapture(role);
  $(role + '-connection').textContent = t('conn.none'); $(role + '-connection').classList.remove('connected');
  $(role + '-player').hidden = true;
  $(role + '-time').textContent = '—:—';
  updateControls();
}

// A small colored badge with the site's initial (favicons would need another permission).
const SITES = { youtube: ['▶', '#ff0033'], twitch: ['T', '#9146ff'], kick: ['K', '#2fb80f'], globo: ['g', '#e3261c'], ge: ['g', '#06aa48'], cazetv: ['C', '#111'],
  facebook: ['f', '#1877f2'], instagram: ['I', '#d62976'], tiktok: ['♪', '#111'], x: ['X', '#111'], twitter: ['X', '#111'], netflix: ['N', '#e50914'],
  primevideo: ['P', '#00a8e1'], amazon: ['P', '#00a8e1'], disneyplus: ['D', '#113ccf'], max: ['M', '#002be7'], hbomax: ['M', '#002be7'], dazn: ['D', '#111'], espn: ['E', '#d00'], star: ['S', '#c724b1'] };
function siteOf(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\.|^m\./, ''); } catch { /* demo */ }
  const parts = host.split('.');
  const key = parts.find(part => SITES[part]) || parts[0] || '';
  const [glyph, color] = SITES[key] || [(key[0] || '•').toUpperCase(), `hsl(${[...key].reduce((h, c) => h + c.charCodeAt(0) * 37, 0) % 360} 45% 38%)`];
  return { host, glyph, color };
}
function paintSite(el, url) {
  const { glyph, color } = siteOf(url);
  el.textContent = glyph; el.style.setProperty('--site', color);
}

function renderSlot(role) {
  const slot = $(role + '-slot');
  const tab = sources[role] && tabList.find(item => item.id === sources[role].tabId);
  slot.dataset.filled = String(!!sources[role]);
  if (!sources[role]) return;
  $(role + '-title').textContent = tab?.title || '';
  $(role + '-title').title = tab?.title || '';
  paintSite($(role + '-site'), tab?.url || '');
}

// The tabs to pick from, most likely first: playing sound, then (for the
// reaction) titles that look like a react or a live.
const REACT_WORDS = /react|reage|reacc|watch ?along|resenha|assistindo junto|com a galera/i;
const VIDEO_PLACES = /youtube|youtu\.be|twitch|kick\.com|globo|cazetv|dazn|espn|hbomax|max\.com|primevideo|netflix|disneyplus|star\.|tiktok|facebook\.com\/watch/i;
const VIDEO_WORDS = /\b(ao vivo|live|en vivo|directo|vs\.?|x|jogo|partida|match|game|final)\b/i;
const listOpen = { reference: false, follower: false };
function renderList(role) {
  const list = $(role + '-list');
  const taken = sources[other(role)]?.tabId;
  const score = tab => (tab.audible ? 2 : 0) + (VIDEO_PLACES.test(tab.url) || VIDEO_WORDS.test(tab.title) ? 1 : 0)
    + (REACT_WORDS.test(tab.title) ? (role === 'follower' ? 2 : -2) : 0);
  const tabs = tabList.filter(tab => tab.id !== taken).sort((a, b) => score(b) - score(a));
  const shown = listOpen[role] ? tabs : tabs.slice(0, 4);
  // Rebuild only when something visible changed, so a click isn't lost to a
  // re-render (pages like YouTube retitle their tabs all the time).
  const key = [getLang(), tabs.length, ...shown.map(tab => `${tab.id}|${tab.title}|${tab.audible}`)].join('\n');
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren();
  if (!tabs.length) {
    const empty = document.createElement('li');
    empty.className = 'tab-empty'; empty.textContent = t('slot.empty');
    list.append(empty);
    return;
  }
  for (const tab of shown) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'tab-item'; button.dataset.tab = String(tab.id);
    const site = document.createElement('span'); site.className = 'site'; paintSite(site, tab.url);
    const text = document.createElement('span'); text.className = 'tab-text';
    const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = tab.title;
    const host = document.createElement('span'); host.className = 'tab-host'; host.textContent = siteOf(tab.url).host;
    text.append(title, host);
    button.append(site, text);
    if (tab.audible) {
      const sound = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sound.setAttribute('viewBox', '0 0 24 24'); sound.classList.add('sound');
      for (const d of ['M4 9v6h4l5 4V5L8 9z', 'M16.5 8.5a5 5 0 0 1 0 7']) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d); sound.append(path);
      }
      button.append(sound);
    }
    const go = document.createElement('span'); go.className = 'go-arrow'; go.textContent = t('slot.use');
    button.append(go);
    button.addEventListener('click', () => {
      button.classList.add('busy'); go.textContent = t('slot.connecting');
      $(role + '-tab').value = String(tab.id);
      connect(role, tab.id).catch(fail).finally(() => { button.classList.remove('busy'); go.textContent = t('slot.use'); });
    });
    li.append(button);
    list.append(li);
  }
  if (tabs.length > shown.length) {
    const more = document.createElement('li'); more.className = 'tab-more';
    const button = document.createElement('button'); button.textContent = t('slot.more', { n: tabs.length - shown.length });
    button.addEventListener('click', () => { listOpen[role] = true; renderList(role); });
    more.append(button); list.append(more);
  }
}

async function connect(role, forcedId) {
  const tabId = forcedId ?? Number($(role + '-tab').value);
  const tab = tabList.find(item => item.id === tabId);
  if (!tab) throw new Error(t('error.pickTab'));
  stop(false); clearAnchor();
  if (cam.on) await hideCam(false);
  stopDrawing(role);
  if (role === 'follower') cam.region = null;
  const token = revision;
  dropCapture(role);
  delete sources[role];
  if (!demo) {
    const url = new URL(tab.url);
    const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    if (token !== revision) return;
    if (!granted) throw new Error(t('error.permission'));
  }
  const found = await adapter.connect(tabId);
  if (token !== revision) return;
  missing[role] = found.missing;
  const available = found.videos
    .map(video => ({ ...video, source: { tabId, frameId: video.frameId, videoId: video.id } }))
    .filter(video => !sameVideo(video.source, sources[other(role)]));
  if (!available.length) {
    showMissing(role);
    if (found.missing.length) {
      status(t('status.embedded'), t('status.embedded.detail', { sites: found.missing.map(host).join(', '), button: $(role + '-allow').textContent }), 'warning');
      return;
    }
    if (found.videos.length) throw new Error(t('error.sameVideo'));
    throw new Error(t('error.noVideo'));
  }
  sources[role] = available[0].source;
  $(role + '-tab').value = String(tabId);
  const select = $(role + '-player');
  select.replaceChildren(...available.map((video, index) => {
    const option = new Option(t('player.option', { n: index + 1, time: formatTime(video.time), duration: formatTime(video.duration) }), String(index));
    option.dataset.source = JSON.stringify(video.source);
    return option;
  }));
  select.hidden = available.length === 1;
  showMissing(role);
  $(role + '-connection').textContent = demo ? t('conn.simulated') : t('conn.connected');
  $(role + '-connection').classList.add('connected');
  $(role + '-info').textContent = demo ? t('info.demo') : t('info.connected');
  updateControls();
  renderList(other(role));
  status(both() ? t('status.bothConnected') : t('status.oneConnected'), both() ? t('status.bothConnected.detail') : t('status.oneConnected.detail'));
}

async function pair() {
  if (!both()) throw new Error(t('error.connectBoth'));
  const [reference, follower] = await Promise.all(roles.map(role => adapter.command(sources[role], 'snapshot')));
  return { reference, follower };
}
function showTimes(states) {
  for (const role of roles) {
    $(role + '-time').textContent = formatTime(states[role].time);
    $(role + '-info').textContent = [demo && t('info.simulated'), states[role].paused ? t('info.paused') : t('info.playing'), states[role].ranges.length ? t('info.seekable') : t('info.notSeekable')].filter(Boolean).join(' · ');
  }
}
function setAnchor(states, difference) {
  anchor = difference;
  sourceKeys = { reference: states.reference.source, follower: states.follower.source };
  $('anchor-label').textContent = t('anchor.set');
  updateControls();
}
// A side whose tab is in the background (or whose window is covered) shows a
// frozen picture: Chrome stops drawing it, so its clock can't be read.
const captured = role => !!keepAlive[role] || (cam.on && role === 'follower');
function hiddenSide(states) {
  // A tab being captured (for the cam, or to keep it drawing) draws even in the background.
  return roles.find(role => states[role].hidden && !captured(role));
}
function showHidden(role) {
  status(t('status.hidden', { side: sideName(role) }), t('status.hidden.detail'), 'warning');
  $('arrange').classList.add('attention');
  offerAction(t('pipmenu.resync'), () => { stop(false); return start(); });
}
// One button under the status line, for whatever the status suggests.
let statusAction = null;
function offerAction(label, run) {
  statusAction = run;
  $('status-action').hidden = !label;
  $('status-action').textContent = label || '';
}

// A side whose tab is in the background (or covered) and can't be kept
// drawing: its clock is read by showing that tab for a moment ("peek").
async function sideAway(states) {
  for (const role of roles) {
    if (!states[role].hidden || captured(role)) continue;
    if (!(await keepDrawing(role))) return role;
  }
  return null;
}

// Shows a background tab for a couple of seconds so its picture is drawn,
// runs work() (reading its clock), then puts everything back as it was.
async function peek(role, work) {
  const tabId = sources[role].tabId;
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  const [before] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  status(t('status.peek', { side: sideName(role) }), t('status.peek.detail'), 'active');
  try {
    if (win.state === 'minimized') await chrome.windows.update(win.id, { state: 'normal' });
    await chrome.tabs.update(tabId, { active: true });
    if (!focused || focused.id !== win.id) await chrome.windows.update(win.id, { focused: true });
    // Chrome stops decoding hidden videos; wait until the picture moves again.
    let last = null, changes = 0;
    for (let i = 0; i < 20 && changes < 2; i++) {
      await sleep(150);
      const shot = await adapter.command(sources[role], 'grab', { maxWidth: 320, type: 'image/jpeg' }).catch(() => ({}));
      if (shot.sig !== undefined && shot.sig !== last) { if (last !== null) changes++; last = shot.sig; }
    }
    return await work();
  } finally {
    if (before && before.id !== tabId) await chrome.tabs.update(before.id, { active: true }).catch(() => {});
    if (win.state === 'minimized') await chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
    if (focused && focused.id !== win.id) await chrome.windows.update(focused.id, { focused: true }).catch(() => {});
  }
}

// Looks for the clocks of these sides: the visible ones together, then each
// background one through a quick peek.
async function look(sides, token) {
  const states = await pair();
  const away = [];
  for (const role of sides) if (states[role].hidden && !captured(role) && !(await keepDrawing(role))) away.push(role);
  if (sides.some(role => keepAlive[role])) await sleep(600);
  const near = sides.filter(role => !away.includes(role));
  const found = {};
  if (near.length) { const result = await detect(near, token); if (!result) return null; Object.assign(found, result); }
  // A covered window looks visible but its picture doesn't move: peek too.
  for (const role of [...away, ...near.filter(role => found[role]?.error === 'hidden')]) {
    const result = await peek(role, () => detect([role], token));
    if (!result) return null;
    found[role] = result[role];
  }
  return found;
}

// Keeps a background tab drawing by capturing it (tiny, video only), so its
// clock can be read while you watch the other video. Chrome allows it once
// the ReactMatch icon was clicked on that tab.
async function keepDrawing(role) {
  if (captured(role)) return true;
  try {
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: sources[role].tabId });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id, maxWidth: 640, maxHeight: 360, maxFrameRate: 5 } }
    });
    const video = document.createElement('video');
    video.muted = true; video.srcObject = stream;
    await video.play().catch(() => {});
    keepAlive[role] = { stream, video, tabId: sources[role].tabId };
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (keepAlive[role]?.stream === stream) keepAlive[role] = null; });
    frozen[role] = { sig: null, since: 0 };
    return true;
  } catch { return false; }
}
function stopDrawing(role) {
  keepAlive[role]?.stream.getTracks().forEach(track => track.stop());
  keepAlive[role] = null;
}

// ---- Reading the clocks ----------------------------------------------------

const GRAB_ERRORS = { 'not-ready': 'grab.notReady', protected: 'grab.protected' };

// One still of the clock region of a side, with the player position of that frame.
async function shoot(role) {
  const capture = captures[role];
  if (capture.kind === 'video') {
    const shot = await adapter.command(sources[role], 'grab', { region: capture.region, maxWidth: 1600, minHeight: 90, type: 'image/png' });
    if (shot.error) return { error: t(GRAB_ERRORS[shot.error] || 'grab.protected') };
    return { image: shot.image, time: shot.time, paused: shot.paused, sig: shot.sig };
  }
  const state = await adapter.command(sources[role], 'snapshot');
  return { image: cropFrame(capture), time: state.time, paused: state.paused };
}

async function readPairClocks(token) {
  // Both stills are taken before OCR starts, and each carries its own player
  // position, so the time spent reading never turns into an offset.
  const shots = await Promise.all(roles.map(shoot));
  if (token !== revision) return null;
  const failed = shots.find(shot => shot.error);
  if (failed) return { error: failed.error };
  const readings = {};
  for (let i = 0; i < roles.length; i++) readings[roles[i]] = { ...(await ocr.read(shots[i].image)), time: shots[i].time, paused: shots[i].paused, sig: shots[i].sig };
  if (token !== revision) return null;
  // The label keeps the last good reading; one bad frame isn't worth a flicker.
  for (const role of roles) {
    misses[role] = readings[role].value === null ? misses[role] + 1 : 0;
    if (readings[role].value !== null) $(role + '-capture').textContent = t('clock.read', { time: formatTime(readings[role].value) });
    else if (misses[role] >= 3) $(role + '-capture').textContent = t('clock.unreadable');
  }
  return { readings };
}

// True when a side's clock picture hasn't changed for 3 s while its video
// played on: the tab is hidden or its window covered.
function pictureStuck(role, reading) {
  const entry = frozen[role];
  if (reading.sig === undefined || reading.paused) { entry.sig = null; return false; }
  if (entry.sig !== reading.sig) { entry.sig = reading.sig; entry.since = reading.time; return false; }
  return reading.time - entry.since > 3;
}

async function ocrTick(token, states) {
  if (performance.now() - lastOCR < 1500) return;
  lastOCR = performance.now();
  const result = await readPairClocks(token);
  if (!result || token !== revision || !running) return;
  if (result.error) { status(t('status.cantRead'), result.error, 'warning'); return; }
  const { readings } = result;
  const stuck = roles.find(role => pictureStuck(role, readings[role]));
  if (stuck) { if (!(await keepDrawing(stuck))) { if (anchor === null) showHidden(stuck); else background = stuck; } return; }
  // Clocks are checked against the player's own timeline: one second of video
  // must move the clock by one second, whatever the playback speed.
  const checks = roles.map(role => trackers[role].push(readings[role].value, readings[role].time * 1000, readings[role].confidence, 1));
  if (checks.some(check => !check.valid)) {
    if (anchor === null) status(t('status.confirming'), t(`reason.${checks.find(check => !check.valid).reason}`), 'warning');
    // Halftime, a replay, a stopped clock: keep the offset we have.
    else if (clocksSeenAt && performance.now() - clocksSeenAt > 15000) notice = { title: t('status.break'), detail: t('status.break.detail'), until: Infinity };
    return;
  }
  clocksSeenAt = performance.now();
  if (notice?.until === Infinity) notice = null;
  const out = lock.push(anchorFromClocks(
    { clock: readings.reference.value, time: readings.reference.time },
    { clock: readings.follower.value, time: readings.follower.time }, direction()));
  if (out.anchor === null) return;
  if (anchor === null) { setAnchor(states, out.anchor); return; }
  anchor = out.anchor;
  if (out.event === 'period') notice = { title: t('status.period'), detail: t('status.period.detail', { m: Math.abs(out.minutes) }), until: performance.now() + 20000 };
  showClockChoice(out.event === 'pending' ? out.diff : null);
}

// The clocks moved apart in a way the videos can't have (the creator restarted
// their clock late, say). Keep the sync, and offer to follow the clocks.
function showClockChoice(diff) {
  const button = $('status-action');
  if (!button) return;
  const label = diff === null ? null : t('clock.useNew', { s: seconds(diff) });
  if (label) offerAction(label, acceptNewClock);
  else if (statusAction === acceptNewClock || !statusAction) offerAction(null);
  if (label) {
    status(t('status.clockMoved'), t('status.clockMoved.detail', { s: seconds(diff) }), 'warning');
  }
  if (cam.on && label !== cam.actionLabel) {
    cam.actionLabel = label;
    inMainTab(action => globalThis.__reactMatchPip?.set({ action }), label).catch(() => {});
  }
}
function acceptNewClock() {
  if (!lock.pending) return;
  anchor = lock.accept();
  lastSeek = -Infinity;
  showClockChoice(null);
  status(t('status.started'), t('status.started.ocr'), 'active');
}

// ---- Keeping the videos together -------------------------------------------

async function applyTarget(target, states, token) {
  const result = decideCorrection({ target, ...states, tolerance: currentKind === 'ocr' ? (lock.estimator.values.length >= 6 ? 0.7 : 1) : 0.85, lastSeek, now: performance.now(), canHold });
  if (token !== revision || !running) return;
  if (result.action === 'hold') {
    const paused = await adapter.command(sources[result.role], 'pause');
    if (token !== revision) return;
    // Resume on a timer of its own: the 1 s tick would overshoot by up to a second.
    const held = hold = { role: result.role, until: performance.now() + result.seconds * 1000, at: paused.time };
    setTimeout(() => { if (hold === held && token === revision) endHold(token).catch(fail); }, result.seconds * 1000);
    showHold();
  } else if (result.action === 'seek') {
    await adapter.command(sources[result.role], 'seek', result.to);
    lastSeek = performance.now();
    if (token !== revision) return;
    const moved = result.to - states[result.role].time;
    status(t('status.adjusting', { side: sideName(result.role) }), t('status.adjusting.detail', { s: seconds(moved) }), 'active');
  } else if (result.action === 'aligned') {
    $('arrange').classList.remove('attention');
    if (statusAction && !lock.pending) offerAction(null);
    if (notice && performance.now() < notice.until) status(notice.title, notice.detail, 'active');
    else if (background) status(t('status.synced'), t('status.syncedBg.detail', { s: `${number(Math.abs(result.error))} s`, side: sideName(background) }), 'active');
    else status(t('status.synced'), t('status.synced.detail', { s: `${number(Math.abs(result.error))} s` }) + (demo ? ` · ${t('demo.tag')}` : ''), 'active');
  } else if (result.action === 'unavailable' && roles.some(role => !canHold[role])) {
    showJumped(roles.find(role => !canHold[role]));
  } else status(result.action === 'unavailable' ? t('status.unavailable') : t('status.waiting'), t(`reason.${result.reason}`), 'warning');
}

function showHold() {
  const left = Math.max(0, (hold.until - performance.now()) / 1000);
  status(t('status.holding', { side: sideName(hold.role) }), t('status.holding.detail', { side: sideName(hold.role), n: Math.ceil(left) }), 'active');
}

// Resumes a held video, then checks that the player really continued from
// where it paused (some live players jump to live).
async function endHold(token) {
  const { role, at } = hold;
  hold = null;
  await adapter.command(sources[role], 'play');
  if (token !== revision) return;
  resumed = { role, at, when: performance.now() };
  lastSeek = performance.now();
  lastPaused = null;
}

function showJumped(role) {
  status(t('status.liveJump', { side: sideName(role) }), t('status.liveJump.detail'), 'warning');
}

// Returns true when the held player jumped instead of continuing.
function checkResume(states) {
  const { role, at, when } = resumed;
  const elapsed = (performance.now() - when) / 1000;
  if (elapsed < 1) return false;
  resumed = null;
  if (states[role].time - at > elapsed * states[role].rate + 3) {
    canHold[role] = false;
    showJumped(role);
    return true;
  }
  return false;
}

// Pausing or resuming one video does the same to the other.
async function mirrorPauses(states) {
  const before = lastPaused;
  lastPaused = { reference: states.reference.paused, follower: states.follower.paused };
  if (!before || states.reference.paused === states.follower.paused) return;
  for (const role of roles) {
    if (states[role].paused !== before[role] && states[other(role)].paused === before[other(role)]) {
      await adapter.command(sources[other(role)], states[role].paused ? 'pause' : 'play');
      lastPaused[other(role)] = states[role].paused;
      return;
    }
  }
}

async function tick() {
  if (!both() || busy) return;
  busy = true;
  const token = revision;
  try {
    let states = await pair();
    if (token !== revision) return;
    showTimes(states);
    if (cam.on && performance.now() - cam.checked > 2000) await followCam();
    if (!running) return;
    const ocrMode = currentKind === 'ocr';
    if (roles.some(role => states[role].ad)) {
      if (ocrMode) { status(t('status.adWait', { side: sideName(roles.find(role => states[role].ad)) }), t('status.adWait.detail'), 'warning'); return; }
      stop(false); clearAnchor(); status(t('status.ad'), t('status.ad.detail'), 'warning'); return;
    }
    if (sourceKeys && roles.some(role => sourceKeys[role] !== states[role].source)) {
      // With clocks, a new source (after an ad, a reload) is simply learned again.
      if (ocrMode) { anchor = null; sourceKeys = null; resetTrackers(); }
      else { stop(false); clearAnchor(); status(t('status.contentChanged'), t('status.contentChanged.detail'), 'warning'); return; }
    }
    if (hold) { showHold(); return; }
    if (resumed && checkResume(states)) return;
    // A side in the background can't be read; once the offset is known, the
    // videos' own timelines keep them together until it can be read again.
    background = ocrMode ? await sideAway(states) : null;
    if (background && anchor === null) { showHidden(background); return; }
    await mirrorPauses(states);
    if (token !== revision) return;
    if (ocrMode && !background) {
      await ocrTick(token, states);
      if (token !== revision || anchor === null) return;
      states = await pair();
      if (token !== revision) return;
    }
    if (states.reference.ready < 3 || states.follower.ready < 3 || states.reference.seeking || states.follower.seeking) {
      status(t('status.loading'), t('status.loading.detail'), 'warning'); return;
    }
    await applyTarget(states.reference.time + anchor + trim, states, token);
  } catch (error) { if (token === revision) fail(error); }
  finally { busy = false; }
}

// ---- Picking the clock -------------------------------------------------------

// Looks for clocks on a few frames of each side, ~1 s apart, while playing.
// Returns, per side, the clocks that tick with the video (best first) and the
// last frame, or the reason it couldn't look.
async function detect(sidesToCheck, token) {
  const shots = Object.fromEntries(sidesToCheck.map(role => [role, []]));
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(1100);
    const taken = await Promise.all(sidesToCheck.map(role => adapter.command(sources[role], 'grab', { maxWidth: 1920, type: 'image/jpeg' })));
    if (token !== revision) return null;
    taken.forEach((shot, index) => shots[sidesToCheck[index]].push(shot));
  }
  const result = {};
  for (const role of sidesToCheck) {
    const list = shots[role];
    const bad = list.find(shot => shot.error || shot.blank);
    if (bad) { result[role] = { error: bad.error === 'not-ready' ? 'not-ready' : 'protected' }; continue; }
    if (list.some(shot => shot.paused)) { result[role] = { error: 'paused' }; continue; }
    // The video played but the picture never changed: hidden tab or covered window.
    if (list.every(shot => shot.sig === list[0].sig) && list.at(-1).time - list[0].time > 1.5) { result[role] = { error: 'hidden' }; continue; }
    // The first and last frames are searched in full (a clock missed once is
    // still found); the middle one only where those found clocks.
    const first = await scanClocks(ocr, list[0].image);
    const last = await scanClocks(ocr, list[2].image);
    const lines = [...new Set([...first, ...last].map(token => token.line))];
    const middle = lines.length ? await scanClocks(ocr, list[1].image, lines) : [];
    const frames = [{ time: list[0].time, tokens: first }, { time: list[1].time, tokens: middle }, { time: list[2].time, tokens: last }];
    if (token !== revision) return null;
    result[role] = { clocks: findClocks(frames), last: list.at(-1) };
  }
  return result;
}

const regionOf = (clock, shot) => regionAround(clock.box, shot.width / shot.height);
// One clear clock: the only mm:ss that ticks. An uptime in h:mm:ss doesn't
// compete, and is never picked on its own (a live always shows one).
const clearChoice = clocks => clocks.length && clocks[0].parts === 2 && clocks.filter(clock => clock.parts === 2).length === 1 ? clocks[0] : null;

function useVideoRegion(role, region, label) {
  dropCapture(role);
  captures[role] = { kind: 'video', region };
  $(role + '-capture').textContent = label ? t('clock.read', { time: label }) : t('clock.selected');
}

// Opens the box editor on a still of the player, pre-selecting what was found.
async function pickOnStill(role, token, found) {
  let still, screen = null, clocks = [], shot = found?.last;
  if (!shot && !found?.error) {
    shot = await adapter.command(sources[role], 'grab', { maxWidth: 1920, type: 'image/jpeg' });
    if (token !== revision) return false;
    if (shot.error === 'not-ready') throw new Error(t('error.playToGrab'));
    if (shot.error || shot.blank) shot = null;
  }
  if (found?.clocks) clocks = found.clocks;
  if (!shot) {
    // Protected or cross-site player: read the tab through a capture instead.
    status(t('status.pickSameTab'), t('status.pickSameTab.detail', { side: sideName(role) }), 'warning');
    screen = await startTabCapture();
    still = screen.video;
  } else still = await loadImage(shot.image);
  const options = shot ? clocks.map(clock => ({ label: clock.text, region: regionOf(clock, shot) })) : [];
  // No clock moving at all: often halftime, or a break in the broadcast.
  const note = found?.clocks && !found.clocks.length ? t('crop.noTicking') : '';
  const region = await selectRegion($('crop-dialog'), still, { suggested: options[0]?.region || null, options, track: screen?.stream.getVideoTracks()[0], note });
  if (!region || token !== revision) {
    screen?.stream.getTracks().forEach(track => track.stop());
    return false;
  }
  if (!screen) {
    useVideoRegion(role, region, options.find(option => option.region === region)?.label);
    return true;
  }
  dropCapture(role);
  captures[role] = { kind: 'screen', region, ...screen };
  screen.stream.getVideoTracks()[0].onended = () => {
    delete captures[role]; stop(false); resetTrackers(); updateControls();
    $(role + '-capture').textContent = t('clock.select');
    status(t('status.captureEnded'), t('status.captureEnded.detail'), 'warning');
  };
  $(role + '-capture').textContent = t('clock.selected');
  return true;
}

function afterPicking() {
  resetTrackers(); updateControls();
  if (hasOCR()) status(t('status.clocksReady'), t('status.clocksReady.detail'), 'active');
  else status(t('status.oneClock'), t('status.oneClock.detail'), 'warning');
}

async function selectClock(role) {
  stop(false);
  const token = revision;
  status(t('status.findingOne'), t('status.moment'));
  const state = await adapter.command(sources[role], 'snapshot');
  const found = state.paused ? null : (await look([role], token))?.[role];
  if (token !== revision) return;
  if (found?.error === 'hidden') { showHidden(role); return; }
  if (!(await pickOnStill(role, token, found))) { status(t('status.cancelled'), t('status.cancelled.detail')); return; }
  afterPicking();
}

// Finds the clock of each side that doesn't have one yet. Returns false if
// the user cancelled or something needs fixing first (status says what).
async function findMissingClocks(token) {
  const sides = roles.filter(role => !captures[role]);
  if (!sides.length) return true;
  status(t('status.finding'), t('status.finding.detail'), 'active');
  await Promise.all(sides.map(role => adapter.command(sources[role], 'play')));
  await sleep(400);
  if (token !== revision) return false;
  const found = await look(sides, token);
  if (!found) return false;
  // A side without one clear clock gets a second look before asking the user
  // (a frame caught mid-change or a blurry one is enough to miss it).
  const unclear = sides.filter(role => !found[role].error && !clearChoice(found[role].clocks || []));
  if (unclear.length) {
    const again = await look(unclear, token);
    if (!again) return false;
    for (const role of unclear) if (again[role].clocks && clearChoice(again[role].clocks)) found[role] = again[role];
  }
  const directions = new Set();
  const chosen = {};
  seeds = [];
  for (const role of sides) {
    if (found[role].error === 'hidden') { showHidden(role); return false; }
    if (found[role].error === 'paused' || found[role].error === 'not-ready') throw new Error(t('error.playBoth'));
    const choice = found[role].clocks && clearChoice(found[role].clocks);
    if (choice) {
      useVideoRegion(role, regionOf(choice, found[role].last), choice.text);
      directions.add(choice.direction);
      chosen[role] = choice;
      continue;
    }
    // Several clocks, none, or a protected player: let the user confirm.
    if (!(await pickOnStill(role, token, found[role]))) { status(t('status.cancelled'), t('status.cancelled.detail')); updateControls(); return false; }
    const picked = found[role].clocks?.find(clock => $(role + '-capture').textContent.includes(clock.text));
    if (picked) directions.add(picked.direction);
  }
  if (directions.size === 1) $('direction').value = String([...directions][0]);
  // Both clocks found on frames taken at the same moments: those readings
  // already give the offset, so syncing can start right away.
  if (chosen.reference && chosen.follower && directions.size === 1) {
    for (let i = 0; i < 3; i++) {
      const a = chosen.reference.readings[i], b = chosen.follower.readings[i];
      if (a && b) seeds.push(anchorFromClocks({ clock: a.value, time: a.time }, { clock: b.value, time: b.time }, direction()));
    }
  }
  resetTrackers(); updateControls();
  return true;
}

// "Sync now": with a manual reference, keep it; otherwise find the clocks
// (only the missing ones) and start reading them.
async function start() {
  if (running) { stop(); return; }
  // A routine check may be running; wait for it instead of refusing the click.
  for (let i = 0; i < 50 && busy; i++) await sleep(100);
  if (busy) throw new Error(t('error.busyStart'));
  stop(false);
  const token = revision;
  if (anchor === null || hasOCR()) {
    if (demo) throw new Error(t('error.markFirst'));
    if (!(await findMissingClocks(token)) || token !== revision) return;
  }
  currentKind = hasOCR() ? 'ocr' : 'timeline';
  const states = await pair();
  if (token !== revision) return;
  if (states.reference.rate !== states.follower.rate) throw new Error(t('error.sameSpeed'));
  if (currentKind === 'timeline' && sourceKeys && roles.some(role => sourceKeys[role] !== states[role].source)) {
    clearAnchor(); throw new Error(t('error.contentChanged'));
  }
  if (currentKind === 'ocr') { anchor = null; sourceKeys = null; }
  const results = await Promise.allSettled(roles.map(role => adapter.command(sources[role], 'play')));
  if (token !== revision) return;
  const error = results.find(result => result.status === 'rejected');
  if (error) throw error.reason;
  running = true; revision++; resetTrackers(); updateControls();
  if (currentKind === 'ocr') {
    let out = null;
    for (const value of seeds) out = lock.push(value);
    if (out?.anchor != null) setAnchor(states, out.anchor);
  }
  seeds = [];
  status(t('status.started'), currentKind === 'ocr' ? t('status.started.ocr') : t('status.started.timeline'), 'active');
}

async function markMoment() {
  stop(false); clearCaptures(); clearAnchor();
  const token = revision;
  const states = await pair();
  if (token !== revision) return;
  if (!states.reference.paused || !states.follower.paused) throw new Error(t('error.pauseFirst'));
  if (states.reference.ad || states.follower.ad) throw new Error(t('error.adCalibrate'));
  setAnchor(states, states.follower.time - states.reference.time);
  status(t('status.marked'), t('status.marked.detail'), 'active');
}

async function applyTimes() {
  stop(false);
  const token = revision;
  const states = await pair();
  if (token !== revision) return;
  if (!states.reference.paused || !states.follower.paused) throw new Error(t('error.pauseFirst'));
  const a = parseClock($('clock-reference').value), b = parseClock($('clock-follower').value);
  if (a === null || b === null) throw new Error(t('error.clockFormat'));
  // Keep the captures (if any) only as a way to read the clocks; the typed
  // times become a fixed reference.
  clearCaptures(); clearAnchor();
  const target = clockTarget(a, b, states.follower.time, direction());
  if (insideRanges(target, states.follower.ranges)) await adapter.command(sources.follower, 'seek', target);
  else if (insideRanges(states.reference.time - (target - states.follower.time), states.reference.ranges)) await adapter.command(sources.reference, 'seek', states.reference.time - (target - states.follower.time));
  else throw new Error(t('error.cantReach'));
  if (token !== revision) return;
  setAnchor(states, target - states.reference.time);
  status(t('status.marked'), t('status.marked.detail'), 'active');
}

// Puts each video in its own window, both visible, and docks this panel on
// the right: Chrome only draws videos that are on screen.
async function arrange() {
  const ids = roles.map(role => sources[role]?.tabId ?? Number($(role + '-tab').value)).filter(Boolean);
  if (ids.length < 2 || ids[0] === ids[1]) throw new Error(t('error.pickTab'));
  const W = screen.availWidth, H = screen.availHeight, L = screen.availLeft ?? 0, T = screen.availTop ?? 0;
  const panelWidth = Math.min(460, Math.round(W * 0.32));
  // Positions are a best effort: Chrome refuses bounds it finds off screen,
  // and what matters most is that each video gets a window of its own.
  const place = (id, bounds) => chrome.windows.update(id, { state: 'normal' })
    .then(() => chrome.windows.update(id, bounds)).catch(() => {});
  const me = await chrome.windows.getCurrent();
  await place(me.id, { left: L + W - panelWidth, top: T, width: panelWidth, height: H });
  const areaWidth = W - panelWidth, firstHeight = Math.round(H * 0.6);
  const slots = [
    { left: L, top: T, width: areaWidth, height: firstHeight },
    { left: L, top: T + firstHeight, width: areaWidth, height: H - firstHeight }
  ];
  for (let i = 0; i < 2; i++) {
    const tab = await chrome.tabs.get(ids[i]);
    const win = await chrome.windows.get(tab.windowId, { populate: true });
    if (win.tabs.length > 1) {
      const created = await chrome.windows.create({ tabId: tab.id, focused: false });
      await place(created.id, slots[i]);
    } else await place(win.id, slots[i]);
  }
  $('arrange').classList.remove('attention');
  await refreshTabs();
  status(t('status.arranged'), t('status.arranged.detail'), 'active');
}

// ---- The creator's cam over the main video -----------------------------------

// Runs pip.js in the main video's tab (top frame, where the capture can be used).
async function inMainTab(func, ...args) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId: sources.reference.tabId, frameIds: [0] }, func, args });
  return result?.result;
}

async function pickCam() {
  const token = revision;
  const shot = await adapter.command(sources.follower, 'grab', { maxWidth: 1920, type: 'image/jpeg' });
  if (token !== revision) return false;
  if (shot.error === 'not-ready') throw new Error(t('error.playToGrab'));
  if (shot.error || shot.blank) throw new Error(t('grab.protected'));
  $('crop-title').textContent = t('crop.camTitle');
  try {
    const region = await selectRegion($('crop-dialog'), await loadImage(shot.image), { suggested: cam.region });
    if (!region) return false;
    cam.region = region;
  } finally { $('crop-title').textContent = t('crop.title'); }
  updateControls();
  if (cam.on) await followCam(true);
  return true;
}

// Where the cam is in a capture of the reaction's tab, and where the main
// video is, both of which can change (layout, theater mode, fullscreen…).
async function camPlacement() {
  const [react, main] = await Promise.all([adapter.command(sources.follower, 'layout'), adapter.command(sources.reference, 'layout')]);
  const target = sources.reference.frameId ? { frameOrigin: main.origin, innerRect: main.rect } : { videoId: sources.reference.videoId };
  return { crop: regionInTab(react, cam.region), tabAspect: react.viewport.width / react.viewport.height, target };
}

async function followCam(force = false) {
  cam.checked = performance.now();
  const alive = await inMainTab(() => globalThis.__reactMatchPip?.active() ?? false).catch(() => false);
  if (!alive) { cam.on = false; updateControls(); return; }
  if (!force && !cam.region) return;
  const placement = await camPlacement();
  await inMainTab(options => globalThis.__reactMatchPip.set(options), { ...placement, ...camLook() });
}
// Corner (or dragged position) and size, as last set in the panel or on the cam.
const camLook = () => ({ corner: cam.corner, size: cam.size, ...(cam.corner === 'custom' && cam.free ? { free: cam.free } : {}) });
const camLabels = () => ({
  menu: t('pipmenu.menu'), resync: t('pipmenu.resync'), game: t('audio.main'), react: t('audio.react'), position: t('pip.position'),
  size: t('pip.size'), close: t('pip.hide'), 'top-left': t('pip.topLeft'), 'top-right': t('pip.topRight'), 'bottom-left': t('pip.bottomLeft'), 'bottom-right': t('pip.bottomRight')
});

async function showCam() {
  if (sources.reference.tabId === sources.follower.tabId) throw new Error(t('error.pipSameTab'));
  if (!cam.region && !(await pickCam())) return;
  // One capture per tab: the cam's capture replaces the keep-drawing one.
  stopDrawing('follower');
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: sources.follower.tabId, consumerTabId: sources.reference.tabId });
  } catch {
    // Shown as soon as the icon is clicked on the reaction's tab.
    cam.wanted = true;
    throw new Error(t('error.pipInvoke'));
  }
  cam.wanted = false;
  await chrome.scripting.executeScript({ target: { tabId: sources.reference.tabId, frameIds: [0] }, files: ['media-bridge.js', 'pip.js'] });
  const placement = await camPlacement();
  const result = await inMainTab(async (id, options) => {
    try { return { ok: await globalThis.__reactMatchPip.start(id, options) }; } catch (error) { return { error: error.message }; }
  }, streamId, { ...placement, ...camLook(), volume: Number($('vol-react').value) / 100, mainVolume: Number($('vol-main').value) / 100, labels: camLabels(), status: { text: t('status.pipOn'), type: 'active' } });
  if (!result?.ok) throw new Error(t('error.pipCapture', { message: result?.error || '' }));
  cam.on = true; cam.checked = performance.now(); cam.statusLine = '';
  updateControls();
  status(t('status.pipOn'), t('status.pipOn.detail'), 'active');
}

async function hideCam(announce = true) {
  if (!cam.on) return;
  cam.on = false;
  updateControls();
  await inMainTab(() => globalThis.__reactMatchPip?.stop()).catch(() => {});
  if (announce) status(t('status.pipOff'), t('status.pipOff.detail'));
}

async function setVolume(role, value, fromCam = false) {
  const slider = role === 'reference' ? 'vol-main' : 'vol-react';
  $(slider).value = String(value);
  $(slider + '-value').textContent = `${value}%`;
  // With the cam on, the reaction's sound plays from the main tab.
  if (role === 'follower' && cam.on) { if (!fromCam) await inMainTab(volume => globalThis.__reactMatchPip?.set({ volume }), value / 100); }
  else if (sources[role]) await adapter.command(sources[role], 'volume', value / 100);
  if (role === 'reference' && cam.on && !fromCam) await inMainTab(mainVolume => globalThis.__reactMatchPip?.set({ mainVolume }), value / 100);
}

// "Sync again" from the cam's menu: learn the offset again from the clocks,
// or start from scratch when not syncing.
async function resync() {
  if (running && currentKind === 'ocr') {
    anchor = null; sourceKeys = null; lastSeek = -Infinity; resetTrackers();
    status(t('status.started'), t('status.started.ocr'), 'active');
  } else {
    if (running) stop(false);
    await start();
  }
}

// What the viewer does on the cam (menu and dragging), and the icon clicks
// relayed by the background script.
chrome.runtime?.onMessage?.addListener(message => {
  if (message?.type === 'reactmatch-invoked') {
    invoked.add(message.tabId);
    const role = roles.find(r => sources[r]?.tabId === message.tabId);
    if (!role) return;
    if (role === 'follower' && cam.wanted) showCam().catch(fail);
    else keepDrawing(role).then(ok => {
      if (!ok) return;
      notice = { title: t('status.background', { side: sideName(role) }), detail: t('status.background.detail'), until: performance.now() + 8000 };
      status(notice.title, notice.detail, 'active');
    });
    return;
  }
  if (message?.type !== 'reactmatch-pip') return;
  const { action, value } = message;
  if (action === 'resync') resync().catch(fail);
  else if (action === 'accept-clock') acceptNewClock();
  else if (action === 'close') hideCam().catch(fail);
  else if (action === 'ended') { cam.on = false; updateControls(); }
  else if (action === 'corner') { cam.corner = value; cam.free = null; updateControls(); }
  else if (action === 'position') { cam.corner = 'custom'; cam.free = value; updateControls(); }
  else if (action === 'size') { cam.size = value; $('pip-size').value = String(Math.round(value * 100)); $('pip-size-value').textContent = `${Math.round(value * 100)}%`; }
  else if (action === 'volume-main') setVolume('reference', Math.round(value * 100), true).catch(fail);
  else if (action === 'volume-react') setVolume('follower', Math.round(value * 100), true).catch(fail);
});

function listenCam() {
  listen('pip-pick', pickCam);
  listen('pip-toggle', () => (cam.on ? hideCam() : showCam()));
  for (const button of document.querySelectorAll('[data-corner]')) listen(button, async () => {
    cam.corner = button.dataset.corner; cam.free = null; updateControls();
    if (cam.on) await followCam(true);
  });
  $('pip-size').addEventListener('input', () => {
    cam.size = Number($('pip-size').value) / 100;
    $('pip-size-value').textContent = `${$('pip-size').value}%`;
    if (cam.on) inMainTab(size => globalThis.__reactMatchPip?.set({ size }), cam.size).catch(fail);
  });
  for (const [id, role] of [['vol-main', 'reference'], ['vol-react', 'follower']]) {
    $(id).addEventListener('input', () => setVolume(role, Number($(id).value)).catch(fail));
  }
}

function listen(id, action) { (typeof id === 'string' ? $(id) : id).addEventListener('click', event => Promise.resolve(action(event)).catch(fail)); }
for (const role of roles) {
  listen(role + '-connect', () => connect(role));
  listen(role + '-allow', async () => {
    const granted = await chrome.permissions.request({ origins: (missing[role] || []).map(origin => `${origin}/*`) });
    if (!granted) throw new Error(t('error.permissionPlayer'));
    await connect(role, Number($(role + '-tab').value));
  });
  $(role + '-tab').addEventListener('change', () => { release(role); status(t('title.connectSelected'), t('status.connectSelected.detail')); });
  listen(role + '-change', () => { release(role); $(role + '-tab').value = ''; renderSlot(role); renderList(role); status(t('status.pickAgain'), t('status.pickAgain.detail')); });
  $(role + '-player').addEventListener('change', () => {
    stop(false); clearAnchor(); clearCaptures();
    sources[role] = JSON.parse($(role + '-player').selectedOptions[0].dataset.source);
    status(t('status.playerPicked'), t('status.playerPicked.detail'));
  });
  listen(role + '-capture', () => selectClock(role));
}
listenCam();
listen('refresh', refreshTabs);
listen('status-action', () => (statusAction || acceptNewClock)());
listen('arrange', arrange);
$('direction').addEventListener('change', () => { stop(false); clearAnchor(); status(t('status.direction'), t('status.direction.detail')); });
listen('pause-both', async () => {
  stop(false); await Promise.all(roles.map(role => adapter.command(sources[role], 'pause')));
  showTimes(await pair()); status(t('status.paused'), t('status.paused.detail'));
});
listen('mark-moment', markMoment);
listen('apply-times', applyTimes);
listen('start', async () => {
  working = !running; updateControls();
  try { await start(); } finally { working = false; updateControls(); }
});
listen('clear-captures', () => { stop(false); clearCaptures(); resetTrackers(); status(t('status.capturesCleared'), t('status.capturesCleared.detail')); });
listen('read-clocks', async () => {
  if (busy) throw new Error(t('error.busy'));
  stop(false); busy = true;
  const token = revision;
  try {
    const before = await pair();
    if (!before.reference.paused || !before.follower.paused) throw new Error(t('error.pauseToRead'));
    status(t('status.reading'), t('status.reading.detail'));
    const result = await readPairClocks(token);
    if (!result) return;
    if (result.error) throw new Error(result.error);
    const fresh = await pair();
    if (token !== revision) return;
    if (roles.some(role => !fresh[role].paused || Math.abs(fresh[role].time - before[role].time) > 0.2)) throw new Error(t('error.changedWhileReading'));
    for (const role of roles) {
      if (result.readings[role].value === null || result.readings[role].confidence < 65) throw new Error(t('error.lowConfidence'));
      $('clock-' + role).value = formatTime(result.readings[role].value);
    }
    status(t('status.checkRead'), t('status.checkRead.detail'), 'active');
  } finally { busy = false; }
});
for (const [id, amount] of [['trim-minus', -0.5], ['trim-plus', 0.5], ['trim-reset', null]]) listen(id, () => {
  trim = amount === null ? 0 : Math.max(-30, Math.min(30, trim + amount)); updateControls();
  if (!running) status(t('status.trim'), t('status.trim.detail'));
});
listen('demo', async () => {
  stop(false); clearCaptures(); clearAnchor(); sources = {};
  adapter = new DemoAdapter(); demo = true;
  $('demo-banner').hidden = false; $('simulate-drift').hidden = false;
  $('demo-label').textContent = t('demo.restart');
  $('advanced').open = true;
  await refreshTabs(); await connect('reference', 1); await connect('follower', 2);
  $('clock-reference').value = '08:14'; $('clock-follower').value = '08:28';
  showTimes(await pair());
  status(t('status.demo'), t('status.demo.detail'));
});
listen('leave-demo', async () => {
  stop(false); clearCaptures(); clearAnchor(); sources = {}; demo = false; adapter = new BrowserAdapter();
  $('demo-banner').hidden = true; $('simulate-drift').hidden = true; $('demo-label').textContent = t('demo.try');
  for (const role of roles) {
    $(role + '-connection').textContent = t('conn.none'); $(role + '-connection').classList.remove('connected');
    $(role + '-time').textContent = '—:—';
  }
  await refreshTabs(); updateControls();
  status(t('status.welcome'), t('status.welcome.detail'));
});
listen('simulate-drift', async () => {
  const state = await adapter.command(sources.follower, 'snapshot');
  await adapter.command(sources.follower, 'seek', state.time - 6);
  status(t('status.drift'), running ? t('status.drift.running') : t('status.drift.idle'), 'warning');
});
window.addEventListener('pagehide', () => { if (cam.on) hideCam(false).catch(() => {}); for (const role of roles) stopDrawing(role); running = false; revision++; clearCaptures(); ocr.close(); });
setInterval(tick, 1000);

// ---- Language ----------------------------------------------------------------

// Texts set from code (connection, labels, buttons) after the static ones.
function refreshDynamic() {
  for (const role of roles) {
    const connected = !!sources[role];
    $(role + '-connection').textContent = connected ? (demo ? t('conn.simulated') : t('conn.connected')) : t('conn.none');
    $(role + '-connection').classList.toggle('connected', connected);
    if (connected) $(role + '-info').textContent = demo ? t('info.demo') : t('info.connected');
    $(role + '-capture').textContent = captures[role] ? t('clock.selected') : t('clock.select');
    showMissing(role);
  }
  $('anchor-label').textContent = anchor === null ? t('anchor.none') : t('anchor.set');
  $('demo-label').textContent = demo ? t('demo.restart') : t('demo.try');
  updateControls();
  for (const role of roles) renderList(role);
}

function renderLangCode() { $('lang-code').textContent = getLang().toUpperCase(); }

// "Simple" shows the two tabs, the big button and the cam; "Pro" adds the
// players, clocks, fine adjustment, manual calibration and the demo.
let view = 'simple';
function renderView() {
  document.body.classList.toggle('pro-view', view === 'pro');
  document.body.classList.toggle('simple-view', view === 'simple');
  for (const button of document.querySelectorAll('#view button')) button.setAttribute('aria-checked', String(button.dataset.view === view));
}
for (const button of document.querySelectorAll('#view button')) button.addEventListener('click', () => {
  view = button.dataset.view; renderView();
  try { chrome.storage.local.set({ view }); } catch { /* Preview. */ }
});

// The tab lists follow what is open, without a refresh button.
let tabsTimer = null;
const tabsChanged = () => { clearTimeout(tabsTimer); tabsTimer = setTimeout(() => { if (!demo) refreshTabs().then(() => roles.forEach(renderSlot)).catch(() => {}); }, 300); };
for (const event of ['onCreated', 'onRemoved', 'onUpdated']) globalThis.chrome?.tabs?.[event]?.addListener(tabsChanged);

async function init() {
  const select = $('lang');
  for (const [code, name] of LANGUAGES) select.add(new Option(name, code));
  let saved = null;
  try { saved = (await chrome.storage.local.get('lang')).lang; } catch { /* Preview outside the extension. */ }
  await setLang(saved ?? detectLang(globalThis.chrome?.i18n?.getUILanguage?.() ?? navigator.language));
  select.value = getLang();
  renderLangCode();
  try { view = (await chrome.storage.local.get('view')).view || 'simple'; } catch { /* Preview. */ }
  renderView();
  applyStatic();
  $('version').textContent = globalThis.chrome?.runtime?.getManifest?.().version ? `v${chrome.runtime.getManifest().version}` : '';
  select.addEventListener('change', async () => {
    await setLang(select.value);
    try { await chrome.storage.local.set({ lang: select.value }); } catch { /* Preview. */ }
    applyStatic();
    refreshDynamic();
    await refreshTabs();
    renderLangCode();
    if (cam.on) inMainTab(labels => globalThis.__reactMatchPip?.set({ labels }), camLabels()).catch(() => {});
    if (running) status(t('status.started'), t('status.started.ocr'), 'active');
    else if (both()) status(t('status.bothConnected'), t('status.bothConnected.detail'));
    else if (sources.reference || sources.follower) status(t('status.oneConnected'), t('status.oneConnected.detail'));
    else status(t('status.welcome'), t('status.welcome.detail'));
  });
  updateControls();
  await refreshTabs();
}
init().catch(fail);
