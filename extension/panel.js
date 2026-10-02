import { BrowserAdapter } from './browser-adapter.js';
import { DemoAdapter } from './demo-adapter.js';
import { parseClock, formatTime, clockTarget, insideRanges, decideCorrection, ClockTracker, anchorFromClocks, AnchorEstimator, findClocks, regionAround } from './core.js';
import { LocalOCR, loadImage, cropFrame, startTabCapture, selectRegion, scanClocks } from './ocr.js';
import { t, setLang, getLang, detectLang, applyStatic, getLocale, LANGUAGES } from './i18n.js';

const $ = id => document.getElementById(id);
const roles = ['reference', 'follower'];
const installed = !!globalThis.chrome?.scripting;
let adapter = new BrowserAdapter(), demo = false, mode = 'clock';
let sources = {}, captures = {}, tabList = [], anchor = null, trim = 0, missing = {};
let running = false, busy = false, revision = 0, lastSeek = -Infinity, lastOCR = 0;
let sourceKeys = null, currentKind = 'timeline';
// A video paused on purpose to let the other catch up, and players known to
// jump back to live when resumed (pausing can't delay those).
let hold = null, resumed = null, canHold = { reference: true, follower: true };
const ocr = new LocalOCR();
const estimator = new AnchorEstimator();
let trackers = { reference: new ClockTracker(), follower: new ClockTracker() };

const direction = () => Number($('direction').value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = value => new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
const seconds = value => `${value > 0.05 ? '+' : ''}${number(Math.abs(value) < 0.05 ? 0 : value)} s`;

function status(title, detail, type = '') {
  $('status-title').textContent = title; $('status-detail').textContent = detail;
  $('status-dot').className = `status-dot ${type}`;
}
function fail(error) {
  stop(false);
  status(t('status.problem'), error.message || String(error), 'error');
}
function resetTrackers() {
  trackers = { reference: new ClockTracker(direction()), follower: new ClockTracker(direction()) };
  estimator.reset();
  lastOCR = 0;
}
function both() { return !!sources.reference && !!sources.follower; }
function hasOCR() { return !!captures.reference && !!captures.follower; }
function updateControls() {
  const connected = both();
  for (const id of ['pause-both', 'calibrate', 'trim-minus', 'trim-plus', 'trim-reset']) $(id).disabled = !connected;
  $('start').disabled = !connected || (anchor === null && !(mode === 'clock' && hasOCR()));
  $('start').textContent = running ? t('start.stop') : t('start.start');
  $('read-clocks').disabled = !hasOCR() || demo;
  $('find-clocks').disabled = !connected || demo;
  $('clear-captures').hidden = !Object.keys(captures).length;
  $('trim-value').textContent = seconds(trim);
  $('trim-minus').textContent = `− ${number(0.5)} s`;
  $('trim-plus').textContent = `+ ${number(0.5)} s`;
  for (const role of roles) $(role + '-capture').disabled = !sources[role] || demo || mode !== 'clock';
}
function stop(announce = true) {
  if (hold) adapter.command(sources[hold.role], 'play').catch(() => {});
  hold = null; resumed = null;
  running = false; revision++;
  updateControls();
  if (announce) status(t('status.stopped'), t('status.stopped.detail'));
}
function clearAnchor() {
  anchor = null; sourceKeys = null; trim = 0; lastSeek = -Infinity;
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
  const tab = tabList.find(t => t.id === tabId);
  if (!tab) throw new Error(t('error.pickTab'));
  stop(false); clearAnchor();
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
  const other = role === 'reference' ? 'follower' : 'reference';
  const available = found.videos
    .map(video => ({ ...video, source: { tabId, frameId: video.frameId, videoId: video.id } }))
    .filter(video => !sameVideo(video.source, sources[other]));
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
  document.querySelector(`[for="${role}-player"]`).hidden = select.hidden;
  $(role + '-title').textContent = tab.title;
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

// ---- Reading the clocks ----------------------------------------------------

const GRAB_ERRORS = { 'not-ready': 'grab.notReady', protected: 'grab.protected' };

// One still of the clock region of a side, with the player position of that frame.
async function shoot(role) {
  const capture = captures[role];
  if (capture.kind === 'video') {
    const shot = await adapter.command(sources[role], 'grab', { region: capture.region, maxWidth: 1600, minHeight: 90, type: 'image/png' });
    if (shot.error) return { error: t(GRAB_ERRORS[shot.error] || 'grab.protected') };
    return { image: shot.image, time: shot.time, paused: shot.paused };
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
  for (let i = 0; i < roles.length; i++) readings[roles[i]] = { ...(await ocr.read(shots[i].image)), time: shots[i].time, paused: shots[i].paused };
  if (token !== revision) return null;
  for (const role of roles) {
    $(role + '-capture').textContent = readings[role].value === null ? t('clock.unreadable') : t('clock.read', { time: formatTime(readings[role].value) });
  }
  return { readings };
}

async function ocrTick(token) {
  if (performance.now() - lastOCR < 1500) return;
  lastOCR = performance.now();
  const result = await readPairClocks(token);
  if (!result || token !== revision || !running) return;
  if (result.error) { status(t('status.cantRead'), result.error, 'warning'); return; }
  const { readings } = result;
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
  if (anchor !== null && Math.abs(value - anchor) > 30) {
    stop(false); clearAnchor();
    status(t('status.jumped'), t('status.jumped.detail'), 'warning');
    return;
  }
  if (anchor === null) {
    const states = await pair();
    if (token !== revision) return;
    setAnchor(states, value);
  } else anchor = value;
}

// ---- Keeping the videos together -------------------------------------------

async function applyTarget(target, states, token) {
  const result = decideCorrection({ target, ...states, tolerance: currentKind === 'ocr' ? (estimator.values.length >= 6 ? 0.7 : 1) : 0.85, lastSeek, now: performance.now(), canHold });
  if (token !== revision || !running) return;
  if (result.action === 'hold') {
    const paused = await adapter.command(sources[result.role], 'pause');
    if (token !== revision) return;
    // Resume on a timer of its own: the 1 s tick would overshoot by up to a second.
    const held = hold = { role: result.role, until: performance.now() + result.seconds * 1000, at: paused.time, seconds: result.seconds };
    setTimeout(() => { if (hold === held && token === revision) endHold(token).catch(fail); }, result.seconds * 1000);
    showHold();
  } else if (result.action === 'seek') {
    await adapter.command(sources.follower, 'seek', result.target);
    lastSeek = performance.now();
    if (token !== revision) return;
    status(t('status.adjusting'), t('status.adjusting.detail', { s: seconds(result.error) }), 'active');
  } else if (result.action === 'aligned') {
    status(t('status.synced'), t('status.synced.detail', { s: `${number(Math.abs(result.error))} s` }) + (demo ? ` · ${t('demo.tag')}` : ''), 'active');
  } else if (result.action === 'unavailable' && roles.some(role => !canHold[role])) {
    showJumped(roles.find(role => !canHold[role]));
  } else status(result.action === 'unavailable' ? t('status.unavailable') : t('status.waiting'), t(`reason.${result.reason}`), 'warning');
}

const sideName = role => role === 'reference' ? 'A' : 'B';
function showHold() {
  const left = Math.max(0, (hold.until - performance.now()) / 1000);
  status(t('status.holding', { side: sideName(hold.role) }), t(`status.holding.${hold.role}`, { n: Math.ceil(left) }), 'active');
}

// Runs while a video is held: resumes it on time, then checks that the player
// really continued from where it paused (some live players jump to live).
async function endHold(token) {
  const { role, at } = hold;
  hold = null;
  await adapter.command(sources[role], 'play');
  if (token !== revision) return;
  resumed = { role, at, when: performance.now() };
  lastSeek = performance.now();
}

function showJumped(role) {
  status(t('status.liveJump', { side: sideName(role) }), t('status.liveJump.detail'), 'warning');
}

// Returns true when the held player jumped instead of continuing.
async function checkResume(states) {
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

async function calibrate() {
  stop(false); clearAnchor();
  const token = revision;
  const states = await pair();
  if (token !== revision) return;
  if (!states.reference.paused || !states.follower.paused) throw new Error(t('error.pauseFirst'));
  if (states.reference.ad || states.follower.ad) throw new Error(t('error.adCalibrate'));
  let target = states.follower.time;
  if (mode === 'clock') {
    const a = parseClock($('clock-reference').value), b = parseClock($('clock-follower').value);
    if (a === null || b === null) throw new Error(t('error.clockFormat'));
    target = clockTarget(a, b, states.follower.time, direction());
    if (!insideRanges(target, states.follower.ranges)) throw new Error(t('error.cantReach'));
    await adapter.command(sources.follower, 'seek', target);
    if (token !== revision) return;
  }
  setAnchor(states, target - states.reference.time);
  status(t('status.marked'), t('status.marked.detail'), 'active');
}

async function start() {
  if (running) { stop(); return; }
  if (busy) throw new Error(t('error.busyStart'));
  if (mode === 'clock' && Object.keys(captures).length === 1) throw new Error(t('error.oneCapture'));
  currentKind = mode === 'clock' && hasOCR() ? 'ocr' : 'timeline';
  if (currentKind === 'timeline' && anchor === null) throw new Error(t('error.markFirst'));
  const token = ++revision;
  const states = await pair();
  if (token !== revision) return;
  if (states.reference.rate !== states.follower.rate) throw new Error(t('error.sameSpeed'));
  if (states.reference.ad || states.follower.ad) throw new Error(t('error.adStart'));
  if (sourceKeys && roles.some(role => sourceKeys[role] !== states[role].source)) {
    clearAnchor(); throw new Error(t('error.contentChanged'));
  }
  if (anchor !== null) sourceKeys = { reference: states.reference.source, follower: states.follower.source };
  const results = await Promise.allSettled(roles.map(role => adapter.command(sources[role], 'play')));
  if (token !== revision) return;
  const error = results.find(result => result.status === 'rejected');
  if (error) throw error.reason;
  running = true; revision++; resetTrackers(); updateControls();
  status(t('status.started'), currentKind === 'ocr' ? t('status.started.ocr') : t('status.started.timeline'), 'active');
}

async function tick() {
  if (!both() || busy) return;
  busy = true;
  const token = revision;
  try {
    let states = await pair();
    if (token !== revision) return;
    showTimes(states);
    if (!running) return;
    if (sourceKeys && roles.some(role => sourceKeys[role] !== states[role].source)) {
      stop(false); clearAnchor(); status(t('status.contentChanged'), t('status.contentChanged.detail'), 'warning'); return;
    }
    if (states.reference.ad || states.follower.ad) {
      stop(false); clearAnchor(); status(t('status.ad'), t('status.ad.detail'), 'warning'); return;
    }
    if (hold) { showHold(); return; }
    if (resumed && await checkResume(states)) return;
    if (currentKind === 'ocr') {
      await ocrTick(token);
      if (token !== revision || anchor === null) return;
      states = await pair();
      if (token !== revision) return;
    }
    if (states.reference.ready < 3 || states.follower.ready < 3 || states.reference.seeking || states.follower.seeking) {
      status(t('status.loading'), t('status.loading.detail'), 'warning'); return;
    }
    if (states.reference.paused !== states.follower.paused) {
      await adapter.command(sources.follower, states.reference.paused ? 'pause' : 'play');
      if (token !== revision) return;
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
    screen?.stream.getTracks().forEach(t => t.stop());
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
  const found = state.paused ? null : (await detect([role], token))?.[role];
  if (token !== revision) return;
  if (!(await pickOnStill(role, token, found))) { status(t('status.cancelled'), t('status.cancelled.detail')); return; }
  afterPicking();
}

async function findBothClocks() {
  stop(false);
  const token = revision;
  status(t('status.finding'), t('status.finding.detail'), 'active');
  await Promise.all(roles.map(role => adapter.command(sources[role], 'play')));
  await sleep(400);
  if (token !== revision) return;
  const found = await detect(roles, token);
  if (!found) return;
  const directions = new Set();
  for (const role of roles) {
    const choice = found[role].clocks && clearChoice(found[role].clocks);
    if (choice) {
      useVideoRegion(role, regionOf(choice, found[role].last), choice.text);
      directions.add(choice.direction);
      continue;
    }
    if (found[role].error === 'paused' || found[role].error === 'not-ready') throw new Error(t('error.playBoth'));
    // Several clocks, none, or a protected player: let the user confirm.
    if (!(await pickOnStill(role, token, found[role]))) { status(t('status.cancelled'), t('status.cancelled.detail')); updateControls(); return; }
    const picked = found[role].clocks?.find(clock => clock.text && $(role + '-capture').textContent.includes(clock.text));
    if (picked) directions.add(picked.direction);
  }
  if (directions.size === 1) $('direction').value = String([...directions][0]);
  afterPicking();
}

function setMode(value) {
  stop(false); clearAnchor(); mode = value;
  $('mode-timeline').classList.toggle('selected', mode === 'timeline');
  $('mode-clock').classList.toggle('selected', mode === 'clock');
  $('mode-timeline').setAttribute('aria-pressed', String(mode === 'timeline'));
  $('mode-clock').setAttribute('aria-pressed', String(mode === 'clock'));
  $('timeline-help').hidden = mode !== 'timeline';
  $('clock-help').hidden = $('clock-fields').hidden = $('read-clocks').hidden = $('find-clocks').hidden = mode !== 'clock';
  $('calibrate').textContent = mode === 'clock' ? t('calibrate.clock') : t('calibrate.timeline');
  if (mode !== 'clock') clearCaptures();
  status(t('status.mode'), mode === 'clock' ? t('status.mode.clock') : t('status.mode.timeline'));
  updateControls();
}

function listen(id, action) { $(id).addEventListener('click', event => Promise.resolve(action(event)).catch(fail)); }
for (const role of roles) {
  listen(role + '-connect', () => connect(role));
  listen(role + '-allow', async () => {
    const granted = await chrome.permissions.request({ origins: (missing[role] || []).map(origin => `${origin}/*`) });
    if (!granted) throw new Error(t('error.permissionPlayer'));
    await connect(role, Number($(role + '-tab').value));
  });
  $(role + '-tab').addEventListener('change', () => {
    stop(false); clearAnchor();
    delete sources[role]; missing[role] = []; showMissing(role);
    dropCapture(role);
    $(role + '-connection').textContent = t('conn.none'); $(role + '-connection').classList.remove('connected');
    $(role + '-player').hidden = true; document.querySelector(`[for="${role}-player"]`).hidden = true;
    $(role + '-time').textContent = '—:—'; $(role + '-title').textContent = t('title.connectSelected');
    updateControls(); status(t('title.connectSelected'), t('status.connectSelected.detail'));
  });
  $(role + '-player').addEventListener('change', () => {
    stop(false); clearAnchor(); clearCaptures();
    sources[role] = JSON.parse($(role + '-player').selectedOptions[0].dataset.source);
    status(t('status.playerPicked'), t('status.playerPicked.detail'));
  });
  listen(role + '-capture', () => selectClock(role));
}
listen('refresh', refreshTabs);
listen('find-clocks', findBothClocks);
listen('mode-timeline', () => setMode('timeline'));
listen('mode-clock', () => setMode('clock'));
$('direction').addEventListener('change', () => { stop(false); clearAnchor(); status(t('status.direction'), t('status.direction.detail')); });
listen('pause-both', async () => {
  stop(false); await Promise.all(roles.map(role => adapter.command(sources[role], 'pause')));
  showTimes(await pair()); status(t('status.paused'), t('status.paused.detail'));
});
listen('calibrate', calibrate);
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
  await refreshTabs(); await connect('reference', 1); await connect('follower', 2);
  setMode('clock'); $('clock-reference').value = '08:14'; $('clock-follower').value = '08:28';
  showTimes(await pair());
  status(t('status.demo'), t('status.demo.detail'));
});
listen('leave-demo', async () => {
  stop(false); clearCaptures(); clearAnchor(); sources = {}; demo = false; adapter = new BrowserAdapter();
  $('demo-banner').hidden = true; $('simulate-drift').hidden = true; $('demo-label').textContent = t('demo.try');
  for (const role of roles) {
    $(role + '-connection').textContent = t('conn.none'); $(role + '-connection').classList.remove('connected');
    $(role + '-title').textContent = t('title.pick'); $(role + '-time').textContent = '—:—';
  }
  setMode('clock'); await refreshTabs(); updateControls();
});
listen('simulate-drift', async () => {
  const state = await adapter.command(sources.follower, 'snapshot');
  await adapter.command(sources.follower, 'seek', state.time - 6);
  status(t('status.drift'), running ? t('status.drift.running') : t('status.drift.idle'), 'warning');
});
window.addEventListener('pagehide', () => { running = false; revision++; clearCaptures(); ocr.close(); });
setInterval(tick, 1000);

// ---- Language ----------------------------------------------------------------

// Texts set from code (connection, labels, buttons) after the static ones.
function refreshDynamic() {
  for (const role of roles) {
    const connected = !!sources[role];
    $(role + '-connection').textContent = connected ? (demo ? t('conn.simulated') : t('conn.connected')) : t('conn.none');
    $(role + '-connection').classList.toggle('connected', connected);
    if (connected) {
      $(role + '-title').textContent = tabList.find(tab => tab.id === sources[role].tabId)?.title ?? '';
      $(role + '-info').textContent = demo ? t('info.demo') : t('info.connected');
    }
    $(role + '-capture').textContent = captures[role] ? t('clock.selected') : t('clock.select');
    showMissing(role);
  }
  $('anchor-label').textContent = anchor === null ? t('anchor.none') : t('anchor.set');
  $('demo-label').textContent = demo ? t('demo.restart') : t('demo.try');
  $('calibrate').textContent = mode === 'clock' ? t('calibrate.clock') : t('calibrate.timeline');
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
  $('version').textContent = globalThis.chrome?.runtime?.getManifest?.().version ?? '';
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
