import { BrowserAdapter } from './browser-adapter.js';
import { DemoAdapter } from './demo-adapter.js';
import { parseClock, formatTime, clockTarget, insideRanges, decideCorrection, ClockTracker, anchorFromClocks, AnchorEstimator, findClocks, regionAround } from './core.js';
import { LocalOCR, loadImage, cropFrame, startTabCapture, selectRegion, scanClocks } from './ocr.js';

const $ = id => document.getElementById(id);
const roles = ['reference', 'follower'];
const installed = !!globalThis.chrome?.scripting;
let adapter = new BrowserAdapter(), demo = false, mode = 'timeline';
let sources = {}, captures = {}, tabList = [], anchor = null, trim = 0, missing = {};
let running = false, busy = false, revision = 0, lastSeek = -Infinity, lastOCR = 0;
let sourceKeys = null, currentKind = 'timeline';
const ocr = new LocalOCR();
const estimator = new AnchorEstimator();
let trackers = { reference: new ClockTracker(), follower: new ClockTracker() };

const direction = () => Number($('direction').value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const seconds = value => `${value > 0 ? '+' : ''}${value.toFixed(1).replace('.', ',')}s`;

function status(title, detail, type = '') {
  $('status-title').textContent = title; $('status-detail').textContent = detail;
  $('status-dot').className = `status-dot ${type}`;
}
function fail(error) {
  stop(false);
  status('Precisamos conferir a conexão', error.message || String(error), 'error');
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
  $('start').textContent = running ? 'Parar acompanhamento' : 'Iniciar acompanhamento →';
  $('read-clocks').disabled = !hasOCR() || demo;
  $('find-clocks').disabled = !connected || demo;
  $('clear-captures').hidden = !Object.keys(captures).length;
  $('trim-value').textContent = seconds(trim).replace('+0,0s', '0,0s');
  for (const role of roles) $(role + '-capture').disabled = !sources[role] || demo || mode !== 'clock';
}
function stop(announce = true) {
  running = false; revision++;
  updateControls();
  if (announce) status('Acompanhamento parado', 'Você pode ajustar os vídeos e iniciar novamente.');
}
function clearAnchor() {
  anchor = null; sourceKeys = null; trim = 0; lastSeek = -Infinity;
  $('anchor-label').textContent = 'Referência ainda não definida';
  resetTrackers(); updateControls();
}
function dropCapture(role) {
  const capture = captures[role];
  if (capture?.stream) { capture.stream.getTracks().forEach(track => track.stop()); capture.video.srcObject = null; }
  delete captures[role];
  $(role + '-capture').textContent = 'Selecionar relógio';
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
    select.replaceChildren(new Option(tabList.length ? 'Selecione uma aba' : 'Abra um vídeo em outra aba', ''));
    for (const tab of tabList) select.add(new Option(tab.title, String(tab.id)));
    select.value = selected;
  }
  if (!installed && !demo) status('Experimente a demonstração', 'Para conectar abas reais, carregue a pasta extension no Chrome. O guia acompanha o projeto.');
}

const host = origin => new URL(origin).hostname;
const sameVideo = (a, b) => a && b && a.tabId === b.tabId && a.frameId === b.frameId && a.videoId === b.videoId;

function showMissing(role) {
  const list = missing[role] || [];
  $(role + '-allow').hidden = !list.length;
  $(role + '-allow').textContent = `Permitir o player de ${list.map(host).join(', ')}`;
}

async function connect(role, forcedId) {
  const tabId = forcedId ?? Number($(role + '-tab').value);
  const tab = tabList.find(t => t.id === tabId);
  if (!tab) throw new Error('Selecione uma aba primeiro.');
  stop(false); clearAnchor();
  const token = revision;
  dropCapture(role);
  delete sources[role];
  if (!demo) {
    const url = new URL(tab.url);
    const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    if (token !== revision) return;
    if (!granted) throw new Error('A permissão para este site não foi concedida. Você pode tentar novamente.');
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
      status('O vídeo está em um player de outro site', `Esta página usa um player de ${found.missing.map(host).join(', ')}. Clique em “${$(role + '-allow').textContent}”.`, 'warning');
      return;
    }
    if (found.videos.length) throw new Error('Escolha dois vídeos diferentes. Essa aba já está conectada do outro lado.');
    throw new Error('Nenhum vídeo encontrado. Dê play na página e tente novamente.');
  }
  sources[role] = available[0].source;
  $(role + '-tab').value = String(tabId);
  const select = $(role + '-player');
  select.replaceChildren(...available.map((video, index) => {
    const option = new Option(`Vídeo ${index + 1} · ${formatTime(video.time)} / ${formatTime(video.duration)}`, String(index));
    option.dataset.source = JSON.stringify(video.source);
    return option;
  }));
  select.hidden = available.length === 1;
  document.querySelector(`[for="${role}-player"]`).hidden = select.hidden;
  $(role + '-title').textContent = tab.title;
  $(role + '-connection').textContent = demo ? 'Simulado' : 'Conectado';
  $(role + '-connection').classList.add('connected');
  $(role + '-info').textContent = demo ? 'Relógio simulado para experimentar.' : 'Player conectado. Disponibilidade de ajuste será conferida.';
  updateControls();
  status(both() ? 'Escolha seu ponto de encontro' : 'Primeiro vídeo conectado', both() ? 'Alinhe os vídeos e marque a referência, ou use os relógios.' : 'Conecte o outro vídeo para continuar.');
}

async function pair() {
  if (!both()) throw new Error('Conecte os dois vídeos primeiro.');
  const [reference, follower] = await Promise.all(roles.map(role => adapter.command(sources[role], 'snapshot')));
  return { reference, follower };
}
function showTimes(states) {
  for (const role of roles) {
    $(role + '-time').textContent = formatTime(states[role].time);
    $(role + '-info').textContent = `${demo ? 'Simulado · ' : ''}${states[role].paused ? 'Pausado' : 'Reproduzindo'} · ${states[role].ranges.length ? 'Possui trecho navegável' : 'Sem trecho navegável'}`;
  }
}
function setAnchor(states, difference) {
  anchor = difference;
  sourceKeys = { reference: states.reference.source, follower: states.follower.source };
  $('anchor-label').textContent = 'Referência definida nesta sessão';
  updateControls();
}

// ---- Reading the clocks ----------------------------------------------------

const GRAB_ERRORS = {
  'not-ready': 'Dê play no vídeo para a imagem carregar.',
  protected: 'Este player não deixa ler a imagem diretamente.'
};

// One still of the clock region of a side, with the player position of that frame.
async function shoot(role) {
  const capture = captures[role];
  if (capture.kind === 'video') {
    const shot = await adapter.command(sources[role], 'grab', { region: capture.region, maxWidth: 1600, minHeight: 90, type: 'image/png' });
    if (shot.error) return { error: GRAB_ERRORS[shot.error] || shot.error };
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
    $(role + '-capture').textContent = readings[role].value === null ? 'Relógio ilegível · trocar' : `Relógio ${formatTime(readings[role].value)} · trocar`;
  }
  return { readings };
}

async function ocrTick(token) {
  if (performance.now() - lastOCR < 1500) return;
  lastOCR = performance.now();
  const result = await readPairClocks(token);
  if (!result || token !== revision || !running) return;
  if (result.error) { status('Não consegui ler o relógio', result.error, 'warning'); return; }
  const { readings } = result;
  // Clocks are checked against the player's own timeline: one second of video
  // must move the clock by one second, whatever the playback speed.
  const checks = roles.map(role => trackers[role].push(readings[role].value, readings[role].time * 1000, readings[role].confidence, 1));
  if (checks.some(check => !check.valid)) {
    if (anchor === null) status('Confirmando os relógios', checks.find(check => !check.valid).reason, 'warning');
    return;
  }
  const value = estimator.push(anchorFromClocks(
    { clock: readings.reference.value, time: readings.reference.time },
    { clock: readings.follower.value, time: readings.follower.time }, direction()));
  if (value === null) return;
  if (anchor !== null && Math.abs(value - anchor) > 30) {
    stop(false); clearAnchor();
    status('Os relógios mudaram de repente', 'Pode ser intervalo, replay ou troca de conteúdo. Confira os dois relógios e inicie de novo.', 'warning');
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
  const result = decideCorrection({ target, ...states, tolerance: currentKind === 'ocr' ? 1 : 0.85, lastSeek, now: performance.now() });
  if (token !== revision || !running) return;
  if (result.action === 'seek') {
    await adapter.command(sources.follower, 'seek', result.target);
    lastSeek = performance.now();
    if (token !== revision) return;
    status('Ajustando o vídeo B', `Correção de ${seconds(result.error)}. Conferindo a sincronização…`, 'active');
  } else if (result.action === 'aligned') {
    status('Vídeos acompanhando juntos', `Diferença estimada de ${Math.abs(result.error).toFixed(1).replace('.', ',')}s${demo ? ' · demonstração' : ''}.`, 'active');
  } else status(result.action === 'unavailable' ? 'Esse trecho não está disponível' : 'Aguardando uma referência segura', result.reason, 'warning');
}

async function calibrate() {
  stop(false); clearAnchor();
  const token = revision;
  const states = await pair();
  if (token !== revision) return;
  if (!states.reference.paused || !states.follower.paused) throw new Error('Pause os dois vídeos antes de marcar a referência. Assim os tempos não mudam durante a configuração.');
  if (states.reference.ad || states.follower.ad) throw new Error('Espere o anúncio terminar antes de calibrar.');
  let target = states.follower.time;
  if (mode === 'clock') {
    const a = parseClock($('clock-reference').value), b = parseClock($('clock-follower').value);
    if (a === null || b === null) throw new Error('Informe os dois relógios no formato 25:40 ou 01:25:40.');
    target = clockTarget(a, b, states.follower.time, direction());
    if (!insideRanges(target, states.follower.ranges)) throw new Error('O vídeo B não permite chegar a esse momento. Tente inverter as abas ou usar um player com histórico.');
    await adapter.command(sources.follower, 'seek', target);
    if (token !== revision) return;
  }
  setAnchor(states, target - states.reference.time);
  status('Referência marcada', 'Ao iniciar, os dois vídeos serão reproduzidos. Só o vídeo B receberá ajustes.', 'active');
}

async function start() {
  if (running) { stop(); return; }
  if (busy) throw new Error('Aguarde a leitura atual terminar antes de iniciar.');
  if (mode === 'clock' && Object.keys(captures).length === 1) throw new Error('Selecione o relógio nas duas abas ou encerre a captura para usar a calibração manual.');
  currentKind = mode === 'clock' && hasOCR() ? 'ocr' : 'timeline';
  if (currentKind === 'timeline' && anchor === null) throw new Error('Marque o mesmo momento primeiro.');
  const token = ++revision;
  const states = await pair();
  if (token !== revision) return;
  if (states.reference.rate !== states.follower.rate) throw new Error('Selecione a mesma velocidade nos dois vídeos.');
  if (states.reference.ad || states.follower.ad) throw new Error('Espere o anúncio terminar antes de iniciar.');
  if (sourceKeys && roles.some(role => sourceKeys[role] !== states[role].source)) {
    clearAnchor(); throw new Error('O conteúdo mudou. Marque uma nova referência.');
  }
  if (anchor !== null) sourceKeys = { reference: states.reference.source, follower: states.follower.source };
  const results = await Promise.allSettled(roles.map(role => adapter.command(sources[role], 'play')));
  if (token !== revision) return;
  const error = results.find(result => result.status === 'rejected');
  if (error) throw error.reason;
  running = true; revision++; resetTrackers(); updateControls();
  status('Acompanhamento iniciado', currentKind === 'ocr' ? 'Lendo os relógios direto dos players. Os ajustes começam depois de algumas leituras iguais.' : 'Mantendo a relação entre os vídeos. Recalibre se o conteúdo tiver cortes ou pausas internas.', 'active');
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
      stop(false); clearAnchor(); status('O conteúdo mudou', 'Conecte o vídeo correto e marque uma nova referência.', 'warning'); return;
    }
    if (states.reference.ad || states.follower.ad) {
      stop(false); clearAnchor(); status('Anúncio detectado', 'Acompanhamento interrompido. Recalibre quando o conteúdo voltar.', 'warning'); return;
    }
    if (currentKind === 'ocr') {
      await ocrTick(token);
      if (token !== revision || anchor === null) return;
      states = await pair();
      if (token !== revision) return;
    }
    if (states.reference.ready < 3 || states.follower.ready < 3 || states.reference.seeking || states.follower.seeking) {
      status('Aguardando carregar', 'Os ajustes retornam quando os dois players estabilizarem.', 'warning'); return;
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
  $(role + '-capture').textContent = label ? `Relógio ${label} · trocar` : 'Relógio selecionado · trocar';
}

// Opens the box editor on a still of the player, pre-selecting what was found.
async function pickOnStill(role, token, found) {
  let still, screen = null, clocks = [], shot = found?.last;
  if (!shot && !found?.error) {
    shot = await adapter.command(sources[role], 'grab', { maxWidth: 1920, type: 'image/jpeg' });
    if (token !== revision) return false;
    if (shot.error === 'not-ready') throw new Error('Dê play no vídeo para a imagem carregar e tente novamente.');
    if (shot.error || shot.blank) shot = null;
  }
  if (found?.clocks) clocks = found.clocks;
  if (!shot) {
    // Protected or cross-site player: read the tab through a capture instead.
    status('Escolha a mesma aba', `Este player não deixa ler a imagem direto. Na janela do Chrome, escolha a aba do vídeo ${role === 'reference' ? 'A' : 'B'}.`, 'warning');
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
    $(role + '-capture').textContent = 'Selecionar relógio';
    status('Captura encerrada', 'Selecione o relógio novamente para continuar a leitura.', 'warning');
  };
  $(role + '-capture').textContent = 'Relógio selecionado · trocar';
  return true;
}

function afterPicking() {
  resetTrackers(); updateControls();
  if (hasOCR()) status('Relógios prontos', 'Clique em “Iniciar acompanhamento”. A extensão lê os dois relógios e ajusta o vídeo B sozinha.', 'active');
  else status('Falta um relógio', 'Selecione o relógio do outro vídeo.', 'warning');
}

async function selectClock(role) {
  stop(false);
  const token = revision;
  status('Procurando o relógio', 'Um instante…');
  const state = await adapter.command(sources[role], 'snapshot');
  const found = state.paused ? null : (await detect([role], token))?.[role];
  if (token !== revision) return;
  if (!(await pickOnStill(role, token, found))) { status('Seleção cancelada', 'Você pode tentar novamente ou usar a calibração manual.'); return; }
  afterPicking();
}

async function findBothClocks() {
  stop(false);
  const token = revision;
  status('Procurando os relógios', 'Deixe os dois vídeos tocando. Leva alguns segundos.', 'active');
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
    if (found[role].error === 'paused' || found[role].error === 'not-ready') throw new Error('Dê play nos dois vídeos e tente de novo.');
    // Several clocks, none, or a protected player: let the user confirm.
    if (!(await pickOnStill(role, token, found[role]))) { status('Seleção cancelada', 'Você pode tentar novamente ou marcar os relógios à mão.'); updateControls(); return; }
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
  $('calibrate').textContent = mode === 'clock' ? 'Aplicar tempos informados' : 'Marcar mesmo momento';
  if (mode !== 'clock') clearCaptures();
  status('Modo selecionado', mode === 'clock' ? 'Selecione os dois relógios ou informe os tempos com os vídeos pausados.' : 'Pause e alinhe os dois vídeos; depois marque a referência.');
  updateControls();
}

function listen(id, action) { $(id).addEventListener('click', event => Promise.resolve(action(event)).catch(fail)); }
for (const role of roles) {
  listen(role + '-connect', () => connect(role));
  listen(role + '-allow', async () => {
    const granted = await chrome.permissions.request({ origins: (missing[role] || []).map(origin => `${origin}/*`) });
    if (!granted) throw new Error('A permissão para o player não foi concedida. Você pode tentar novamente.');
    await connect(role, Number($(role + '-tab').value));
  });
  $(role + '-tab').addEventListener('change', () => {
    stop(false); clearAnchor();
    delete sources[role]; missing[role] = []; showMissing(role);
    dropCapture(role);
    $(role + '-connection').textContent = 'Não conectado'; $(role + '-connection').classList.remove('connected');
    $(role + '-player').hidden = true; document.querySelector(`[for="${role}-player"]`).hidden = true;
    $(role + '-time').textContent = '—:—'; $(role + '-title').textContent = 'Conecte a aba selecionada';
    updateControls(); status('Conecte a aba selecionada', 'A mudança de aba encerra a referência anterior.');
  });
  $(role + '-player').addEventListener('change', () => {
    stop(false); clearAnchor(); clearCaptures();
    sources[role] = JSON.parse($(role + '-player').selectedOptions[0].dataset.source);
    status('Player selecionado', 'Marque uma nova referência para esse vídeo.');
  });
  listen(role + '-capture', () => selectClock(role));
}
listen('refresh', refreshTabs);
listen('find-clocks', findBothClocks);
listen('mode-timeline', () => setMode('timeline'));
listen('mode-clock', () => setMode('clock'));
$('direction').addEventListener('change', () => { stop(false); clearAnchor(); status('Direção atualizada', 'Marque uma nova referência ou inicie a leitura dos dois relógios.'); });
listen('pause-both', async () => {
  stop(false); await Promise.all(roles.map(role => adapter.command(sources[role], 'pause')));
  showTimes(await pair()); status('Vídeos pausados', 'Ajuste os pontos ou informe os relógios antes de marcar a referência.');
});
listen('calibrate', calibrate);
listen('start', start);
listen('clear-captures', () => { stop(false); clearCaptures(); resetTrackers(); status('Capturas encerradas', 'A leitura da imagem foi desligada. A calibração manual continua disponível.'); });
listen('read-clocks', async () => {
  if (busy) throw new Error('Aguarde a leitura atual terminar.');
  stop(false); busy = true;
  const token = revision;
  try {
    const before = await pair();
    if (!before.reference.paused || !before.follower.paused) throw new Error('Pause os dois vídeos para ler e conferir os tempos antes de aplicá-los.');
    status('Lendo no seu dispositivo', 'A primeira leitura pode levar alguns segundos.');
    const result = await readPairClocks(token);
    if (!result) return;
    if (result.error) throw new Error(result.error);
    const fresh = await pair();
    if (token !== revision) return;
    if (roles.some(role => !fresh[role].paused || Math.abs(fresh[role].time - before[role].time) > 0.2)) throw new Error('Os vídeos mudaram durante a leitura. Pause novamente e repita.');
    for (const role of roles) {
      if (result.readings[role].value === null || result.readings[role].confidence < 65) throw new Error('Não foi possível ler com confiança. Marque uma região mais nítida ou informe os tempos.');
      $('clock-' + role).value = formatTime(result.readings[role].value);
    }
    status('Confira os tempos lidos', 'Verifique os números na tela e clique em “Aplicar tempos informados”.', 'active');
  } finally { busy = false; }
});
for (const [id, amount] of [['trim-minus', -0.5], ['trim-plus', 0.5], ['trim-reset', null]]) listen(id, () => {
  trim = amount === null ? 0 : Math.max(-30, Math.min(30, trim + amount)); updateControls();
  if (!running) status('Ajuste fino definido', 'Ele será aplicado ao iniciar o acompanhamento.');
});
listen('demo', async () => {
  stop(false); clearCaptures(); clearAnchor(); sources = {};
  adapter = new DemoAdapter(); demo = true;
  $('demo-banner').hidden = false; $('simulate-drift').hidden = false;
  $('demo').textContent = 'Reiniciar demonstração ↗';
  await refreshTabs(); await connect('reference', 1); await connect('follower', 2);
  setMode('clock'); $('clock-reference').value = '08:14'; $('clock-follower').value = '08:28';
  showTimes(await pair());
  status('Teste uma diferença de 14 segundos', 'Os relógios são simulados. Aplique os tempos informados e inicie o acompanhamento.');
});
listen('leave-demo', async () => {
  stop(false); clearCaptures(); clearAnchor(); sources = {}; demo = false; adapter = new BrowserAdapter();
  $('demo-banner').hidden = true; $('simulate-drift').hidden = true; $('demo').textContent = 'Experimentar demonstração ↗';
  for (const role of roles) {
    $(role + '-connection').textContent = 'Não conectado'; $(role + '-connection').classList.remove('connected');
    $(role + '-title').textContent = 'Escolha um vídeo'; $(role + '-time').textContent = '—:—';
  }
  setMode('timeline'); await refreshTabs(); updateControls();
});
listen('simulate-drift', async () => {
  const state = await adapter.command(sources.follower, 'snapshot');
  await adapter.command(sources.follower, 'seek', state.time - 6);
  status('Atraso de 6s simulado', running ? 'Observe a correção automática no próximo ciclo.' : 'Inicie o acompanhamento para testar a correção.', 'warning');
});
window.addEventListener('pagehide', () => { running = false; revision++; clearCaptures(); ocr.close(); });
setInterval(tick, 1000);
updateControls(); refreshTabs().catch(fail);
