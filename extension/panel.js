import { BrowserAdapter } from './browser-adapter.js';
import { DemoAdapter } from './demo-adapter.js';
import { parseClock, formatTime, clockTarget, insideRanges, decideCorrection, ClockTracker, anchorFromClocks, AnchorEstimator, findClocks, regionAround, regionInTab } from './core.js';
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
let running = false, busy = false, revision = 0, lastSeek = -Infinity, lastOCR = 0;
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
const estimator = new AnchorEstimator();
let trackers = { reference: new ClockTracker(), follower: new ClockTracker() };

const direction = () => Number($('direction').value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = value => new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
const seconds = value => `${value > 0.05 ? '+' : ''}${number(Math.abs(value) < 0.05 ? 0 : value)} s`;

function status(title, detail, type = '') {
  $('status-title').textContent = title; $('status-detail').textContent = detail;
  $('status-dot').className = `dot ${type}`;
  // The cam's menu shows the same line, so the panel can stay hidden.
  const line = `${title}${detail ? ` · ${detail}` : ''}`;
  if (cam.on && line !== cam.statusLine) {
    cam.statusLine = line;
    inMainTab(value => globalThis.__syncVideoPip?.set({ status: value }), { text: title, type }).catch(() => {});
  }
}
function fail(error) {
  stop(false);
  status(t('status.problem'), error.message || String(error), 'error');
}
function resetTrackers() {
  trackers = { reference: new ClockTracker(direction()), follower: new ClockTracker(direction()) };
  estimator.reset();
  frozen = { reference: { sig: null, since: 0 }, follower: { sig: null, since: 0 } };
  lastOCR = 0;
}
function both() { return !!sources.reference && !!sources.follower; }
function hasOCR() { return !!captures.reference && !!captures.follower; }
function updateControls() {
  const connected = both();
  for (const id of ['pause-both', 'mark-moment', 'apply-times', 'trim-minus', 'trim-plus', 'trim-reset']) $(id).disabled = !connected;
  $('start').disabled = !connected;
  $('start').textContent = running ? t('start.stop') : t('start.start');
  $('read-clocks').disabled = !hasOCR() || demo;
  $('clear-captures').hidden = !Object.keys(captures).length;
  $('trim-value').textContent = seconds(trim);
  $('trim-minus').textContent = `− ${number(0.5)} s`;
  $('trim-plus').textContent = `+ ${number(0.5)} s`;
  for (const role of roles) $(role + '-capture').disabled = !sources[role] || demo;
  $('pip-pick').disabled = !sources.follower || demo;
  $('pip-pick').textContent = cam.region ? t('pip.picked') : t('pip.pick');
  $('pip-toggle').disabled = !connected || demo;
  $('pip-toggle').textContent = cam.on ? t('pip.hide') : t('pip.show');
  $('pip-toggle').setAttribute('aria-pressed', String(cam.on));
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
  }
  if (!installed && !demo) status(t('status.tryDemo'), t('status.tryDemo.detail'));
}

const host = origin => new URL(origin).hostname;
const sameVideo = (a, b) => a && b && a.tabId === b.tabId && a.frameId === b.frameId && a.videoId === b.videoId;

function showMissing(role) {
  const list = missing[role] || [];
  $(role + '-allow').hidden = !list.length;
  $(role + '-allow').textContent = t('allow.button', { sites: list.map(host).join(', ') });
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
  showMissing(role);
  const available = found.videos
    .map(video => ({ ...video, source: { tabId, frameId: video.frameId, videoId: video.id } }))
    .filter(video => !sameVideo(video.source, sources[other(role)]));
  if (!available.length) {
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
  $(role + '-connection').textContent = demo ? t('conn.simulated') : t('conn.connected');
  $(role + '-connection').classList.add('connected');
  $(role + '-info').textContent = demo ? t('info.demo') : t('info.connected');
  updateControls();
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
}

// Keeps a background tab drawing by capturing it (tiny, video only), so its
// clock can be read while you watch the other video. Chrome allows it once
// the SyncVideo icon was clicked on that tab.
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
// A hidden side is kept drawing when possible; otherwise the user is told how.
async function handleHidden(states) {
  const hidden = hiddenSide(states);
  if (!hidden) return false;
  if (await keepDrawing(hidden)) return false;
  showHidden(hidden);
  return true;
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
  for (const role of roles) {
    $(role + '-capture').textContent = readings[role].value === null ? t('clock.unreadable') : t('clock.read', { time: formatTime(readings[role].value) });
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
  if (stuck) { if (!(await keepDrawing(stuck))) showHidden(stuck); return; }
  // Clocks are checked against the player's own timeline: one second of video
  // must move the clock by one second, whatever the playback speed.
  const checks = roles.map(role => trackers[role].push(readings[role].value, readings[role].time * 1000, readings[role].confidence, 1));
  if (checks.some(check => !check.valid)) {
    if (anchor === null) status(t('status.confirming'), t(`reason.${checks.find(check => !check.valid).reason}`), 'warning');
    return;
  }
  const value = estimator.push(anchorFromClocks(
    { clock: readings.reference.value, time: readings.reference.time },
    { clock: readings.follower.value, time: readings.follower.time }, direction()));
  if (value === null) return;
  if (anchor === null) { setAnchor(states, value); return; }
  if (Math.abs(value - anchor) > 30) {
    // Most recent readings agree on a new relation (halftime, the creator
    // reset their clock…): follow it rather than stopping.
    status(t('status.reclock'), t('status.reclock.detail'), 'warning');
    lastSeek = -Infinity;
  }
  anchor = value;
}

// ---- Keeping the videos together -------------------------------------------

async function applyTarget(target, states, token) {
  const result = decideCorrection({ target, ...states, tolerance: currentKind === 'ocr' ? (estimator.values.length >= 6 ? 0.7 : 1) : 0.85, lastSeek, now: performance.now(), canHold });
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
    status(t('status.synced'), t('status.synced.detail', { s: `${number(Math.abs(result.error))} s` }) + (demo ? ` · ${t('demo.tag')}` : ''), 'active');
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
    if (ocrMode && await handleHidden(states)) return;
    await mirrorPauses(states);
    if (token !== revision) return;
    if (ocrMode) {
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
    // Only lines that held a clock on the first frame are read again later.
    const first = await scanClocks(ocr, list[0].image);
    const lines = [...new Set(first.map(token => token.line))];
    const frames = [{ time: list[0].time, tokens: first }];
    for (const shot of list.slice(1)) frames.push({ time: shot.time, tokens: lines.length ? await scanClocks(ocr, shot.image, lines) : [] });
    if (token !== revision) return null;
    result[role] = { clocks: findClocks(frames), last: list.at(-1) };
  }
  return result;
}

const regionOf = (clock, shot) => regionAround(clock.box, shot.width / shot.height);
// One clear clock: the only mm:ss that ticks (an uptime in h:mm:ss doesn't compete).
const clearChoice = clocks => clocks.length && clocks.filter(clock => clock.parts === clocks[0].parts).length === 1 ? clocks[0] : null;

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
  const region = await selectRegion($('crop-dialog'), still, { suggested: options[0]?.region || null, options, track: screen?.stream.getVideoTracks()[0] });
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
  if (state.hidden) { showHidden(role); return; }
  const found = state.paused ? null : (await detect([role], token))?.[role];
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
  const states = await pair();
  if (await handleHidden(states)) return false;
  if (roles.some(role => keepAlive[role])) await sleep(600);
  status(t('status.finding'), t('status.finding.detail'), 'active');
  await Promise.all(sides.map(role => adapter.command(sources[role], 'play')));
  await sleep(400);
  if (token !== revision) return false;
  const found = await detect(sides, token);
  if (!found) return false;
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
    for (const value of seeds) estimator.push(value);
    if (estimator.value() !== null) setAnchor(states, estimator.value());
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
  const alive = await inMainTab(() => globalThis.__syncVideoPip?.active() ?? false).catch(() => false);
  if (!alive) { cam.on = false; updateControls(); return; }
  if (!force && !cam.region) return;
  const placement = await camPlacement();
  await inMainTab(options => globalThis.__syncVideoPip.set(options), { ...placement, ...camLook() });
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
    try { return { ok: await globalThis.__syncVideoPip.start(id, options) }; } catch (error) { return { error: error.message }; }
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
  await inMainTab(() => globalThis.__syncVideoPip?.stop()).catch(() => {});
  if (announce) status(t('status.pipOff'), t('status.pipOff.detail'));
}

async function setVolume(role, value, fromCam = false) {
  const slider = role === 'reference' ? 'vol-main' : 'vol-react';
  $(slider).value = String(value);
  $(slider + '-value').textContent = `${value}%`;
  // With the cam on, the reaction's sound plays from the main tab.
  if (role === 'follower' && cam.on) { if (!fromCam) await inMainTab(volume => globalThis.__syncVideoPip?.set({ volume }), value / 100); }
  else if (sources[role]) await adapter.command(sources[role], 'volume', value / 100);
  if (role === 'reference' && cam.on && !fromCam) await inMainTab(mainVolume => globalThis.__syncVideoPip?.set({ mainVolume }), value / 100);
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
  if (message?.type === 'syncvideo-invoked') {
    invoked.add(message.tabId);
    const role = roles.find(r => sources[r]?.tabId === message.tabId);
    if (!role) return;
    if (role === 'follower' && cam.wanted) showCam().catch(fail);
    else keepDrawing(role).then(ok => { if (ok) status(t('status.background', { side: sideName(role) }), t('status.background.detail'), 'active'); });
    return;
  }
  if (message?.type !== 'syncvideo-pip') return;
  const { action, value } = message;
  if (action === 'resync') resync().catch(fail);
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
    if (cam.on) inMainTab(size => globalThis.__syncVideoPip?.set({ size }), cam.size).catch(fail);
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
  $(role + '-tab').addEventListener('change', () => {
    stop(false); clearAnchor();
    if (cam.on) hideCam(false).catch(() => {});
    stopDrawing(role);
    if (role === 'follower') cam.region = null;
    delete sources[role]; missing[role] = []; showMissing(role);
    dropCapture(role);
    $(role + '-connection').textContent = t('conn.none'); $(role + '-connection').classList.remove('connected');
    $(role + '-player').hidden = true;
    $(role + '-time').textContent = '—:—';
    updateControls(); status(t('title.connectSelected'), t('status.connectSelected.detail'));
  });
  $(role + '-player').addEventListener('change', () => {
    stop(false); clearAnchor(); clearCaptures();
    sources[role] = JSON.parse($(role + '-player').selectedOptions[0].dataset.source);
    status(t('status.playerPicked'), t('status.playerPicked.detail'));
  });
  listen(role + '-capture', () => selectClock(role));
}
listenCam();
listen('refresh', refreshTabs);
listen('arrange', arrange);
$('direction').addEventListener('change', () => { stop(false); clearAnchor(); status(t('status.direction'), t('status.direction.detail')); });
listen('pause-both', async () => {
  stop(false); await Promise.all(roles.map(role => adapter.command(sources[role], 'pause')));
  showTimes(await pair()); status(t('status.paused'), t('status.paused.detail'));
});
listen('mark-moment', markMoment);
listen('apply-times', applyTimes);
listen('start', start);
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
}

async function init() {
  const select = $('lang');
  for (const [code, name] of LANGUAGES) select.add(new Option(name, code));
  let saved = null;
  try { saved = (await chrome.storage.local.get('lang')).lang; } catch { /* Preview outside the extension. */ }
  await setLang(saved ?? detectLang(globalThis.chrome?.i18n?.getUILanguage?.() ?? navigator.language));
  select.value = getLang();
  applyStatic();
  $('version').textContent = globalThis.chrome?.runtime?.getManifest?.().version ? `v${chrome.runtime.getManifest().version}` : '';
  select.addEventListener('change', async () => {
    await setLang(select.value);
    try { await chrome.storage.local.set({ lang: select.value }); } catch { /* Preview. */ }
    applyStatic();
    refreshDynamic();
    await refreshTabs();
    status(t('status.language'), running ? t('status.started') : t('status.welcome.detail'));
  });
  updateControls();
  await refreshTabs();
}
init().catch(fail);
