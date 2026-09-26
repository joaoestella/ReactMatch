import { BrowserAdapter } from './browser-adapter.js';
import { DemoAdapter } from './demo-adapter.js';
import { parseClock, formatTime, clockTarget, insideRanges, decideCorrection, ClockTracker } from './core.js';
import { LocalOCR, selectCapture, cropFrame } from './ocr.js';

const $ = id => document.getElementById(id);
const roles = ['reference', 'follower'];
const installed = !!globalThis.chrome?.scripting;
let adapter = new BrowserAdapter(), demo = false, mode = 'timeline';
let sources = {}, captures = {}, tabList = [], anchor = null, trim = 0;
let running = false, busy = false, revision = 0, lastSeek = -Infinity, lastOCR = 0;
let lastStates = null, sourceKeys = null, currentKind = 'timeline';
const ocr = new LocalOCR();
let trackers = { reference: new ClockTracker(), follower: new ClockTracker() };

function status(title, detail, type = '') {
  $('status-title').textContent = title; $('status-detail').textContent = detail;
  $('status-dot').className = `status-dot ${type}`;
}
function fail(error) {
  stop(false);
  status('Precisamos conferir a conexão', error.message || String(error), 'error');
}
function resetTrackers() {
  const direction = Number($('direction').value);
  trackers = { reference: new ClockTracker(direction), follower: new ClockTracker(direction) };
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
  $('clear-captures').hidden = !Object.keys(captures).length;
  $('trim-value').textContent = `${trim > 0 ? '+' : ''}${trim.toFixed(1).replace('.', ',')}s`;
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
function clearCaptures() {
  for (const capture of Object.values(captures)) { capture.stream.getTracks().forEach(track => track.stop()); capture.video.srcObject = null; }
  captures = {};
  for (const role of roles) $(role + '-capture').textContent = 'Selecionar relógio';
  updateControls();
}

async function refreshTabs() {
  tabList = demo ? await adapter.tabs() : installed ? await adapter.tabs() : [];
  for (const role of roles) {
    const select = $(role + '-tab');
    const selected = select.value;
    select.replaceChildren(new Option(tabList.length ? 'Selecione uma aba' : 'Abra um vídeo em outra aba', ''));
    for (const tab of tabList) select.add(new Option(tab.title, String(tab.id)));
    select.value = selected;
  }
  if (!installed && !demo) status('Experimente a demonstração', 'Para conectar abas reais, carregue a pasta extension no Chrome. O guia acompanha o projeto.');
}

async function connect(role, forcedId) {
  const tabId = forcedId ?? Number($(role + '-tab').value);
  const tab = tabList.find(t => t.id === tabId);
  if (!tab) throw new Error('Selecione uma aba primeiro.');
  stop(false); clearAnchor();
  const token = revision;
  if (captures[role]) { captures[role].stream.getTracks().forEach(t => t.stop()); delete captures[role]; }
  if (!demo) {
    const url = new URL(tab.url);
    const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    if (token !== revision) return;
    if (!granted) throw new Error('A permissão para este site não foi concedida. Você pode tentar novamente.');
  }
  const videos = await adapter.connect(tabId);
  if (token !== revision) return;
  const other = role === 'reference' ? 'follower' : 'reference';
  const available = videos.filter(video => sources[other]?.tabId !== tabId || sources[other]?.videoId !== video.id);
  if (!available.length) throw new Error('Escolha dois vídeos diferentes. Essa aba já está conectada do outro lado.');
  sources[role] = { tabId, videoId: available[0].id };
  $(role + '-tab').value = String(tabId);
  const select = $(role + '-player');
  select.replaceChildren(...available.map((video, index) => new Option(`Vídeo ${index + 1} · ${formatTime(video.time)} / ${formatTime(video.duration)}`, video.id)));
  select.hidden = available.length === 1;
  document.querySelector(`[for="${role}-player"]`).hidden = select.hidden;
  $(role + '-title').textContent = tab.title;
  $(role + '-connection').textContent = demo ? 'Simulado' : 'Conectado';
  $(role + '-connection').classList.add('connected');
  $(role + '-capture').textContent = 'Selecionar relógio';
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
  lastStates = states;
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
    target = clockTarget(a, b, states.follower.time, Number($('direction').value));
    if (!insideRanges(target, states.follower.ranges)) throw new Error('O vídeo B não permite chegar a esse momento. Tente inverter as abas ou usar um player com histórico.');
    await adapter.command(sources.follower, 'seek', target);
    if (token !== revision) return;
  }
  setAnchor(states, target - states.reference.time);
  resetTrackers();
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
  sourceKeys = { reference: states.reference.source, follower: states.follower.source };
  const results = await Promise.allSettled(roles.map(role => adapter.command(sources[role], 'play')));
  if (token !== revision) return;
  const error = results.find(result => result.status === 'rejected');
  if (error) throw error.reason;
  running = true; revision++; resetTrackers(); updateControls();
  status('Acompanhamento iniciado', currentKind === 'ocr' ? 'Confirmando leituras antes de ajustar. Mantenha os relógios visíveis nas capturas.' : 'Mantendo a relação entre os vídeos. Recalibre se o conteúdo tiver cortes ou pausas internas.', 'active');
}

async function applyTarget(target, states, token, maxSeek = Infinity) {
  const result = decideCorrection({ target, ...states, maxSeek, tolerance: currentKind === 'ocr' ? 1.25 : 0.85, lastSeek, now: performance.now() });
  if (token !== revision || !running) return;
  if (result.action === 'seek') {
    await adapter.command(sources.follower, 'seek', result.target);
    lastSeek = performance.now();
    if (token !== revision) return;
    status('Ajustando o vídeo B', `Correção de ${result.error > 0 ? '+' : ''}${result.error.toFixed(1).replace('.', ',')}s. Conferindo a sincronização…`, 'active');
  } else if (result.action === 'aligned') {
    status('Vídeos acompanhando juntos', `Diferença estimada de ${Math.abs(result.error).toFixed(1).replace('.', ',')}s${demo ? ' · demonstração' : ''}.`, 'active');
  } else status(result.action === 'unavailable' ? 'Esse trecho não está disponível' : 'Aguardando uma referência segura', result.reason, 'warning');
}

async function readPairClocks(token) {
  const states = await pair();
  if (token !== revision) return null;
  const at = performance.now();
  const frames = roles.map(role => cropFrame(captures[role]));
  const readings = {};
  // Both images are sampled before OCR begins; processing delay does not become an offset.
  for (let i = 0; i < roles.length; i++) readings[roles[i]] = await ocr.read(frames[i]);
  if (token !== revision) return null;
  for (const role of roles) {
    $(role + '-capture').textContent = readings[role].value === null ? 'Relógio ilegível · trocar' : `Relógio ${formatTime(readings[role].value)} · trocar`;
  }
  return { states, at, readings };
}

async function ocrTick(token) {
  if (performance.now() - lastOCR < 2000) return;
  lastOCR = performance.now();
  const result = await readPairClocks(token);
  if (!result || token !== revision || !running) return;
  const { states, at, readings } = result;
  const checks = roles.map(role => trackers[role].push(readings[role].value, at, readings[role].confidence, states[role].rate));
  if (checks.some(check => !check.valid)) {
    status('Confirmando os relógios', checks.find(check => !check.valid).reason, 'warning'); return;
  }
  const fresh = await pair();
  if (token !== revision || !running) return;
  const elapsed = (performance.now() - at) / 1000;
  if (elapsed > 8 || roles.some(role => {
    const before = states[role], after = fresh[role];
    const expected = before.time + (before.paused ? 0 : elapsed * before.rate);
    return before.source !== after.source || before.paused !== after.paused || after.seeking || after.ready < 3 || Math.abs(after.time - expected) > 0.8;
  })) {
    resetTrackers(); status('Aguardando estabilizar', 'O vídeo mudou durante a leitura. Conferindo novamente.', 'warning'); return;
  }
  const target = clockTarget(readings.reference.value, readings.follower.value, fresh.follower.time, Number($('direction').value), trim);
  await applyTarget(target, fresh, token, 30);
}

async function tick() {
  if (!both() || busy) return;
  busy = true;
  const token = revision;
  try {
    const states = await pair();
    if (token !== revision) return;
    showTimes(states);
    if (!running) return;
    if (sourceKeys && roles.some(role => sourceKeys[role] !== states[role].source)) {
      stop(false); clearAnchor(); status('O conteúdo mudou', 'Conecte o vídeo correto e marque uma nova referência.', 'warning'); return;
    }
    if (states.reference.ad || states.follower.ad) {
      stop(false); clearAnchor(); status('Anúncio detectado', 'Acompanhamento interrompido. Recalibre quando o conteúdo voltar.', 'warning'); return;
    }
    if (currentKind === 'ocr') { await ocrTick(token); return; }
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

function setMode(value) {
  stop(false); clearAnchor(); mode = value;
  $('mode-timeline').classList.toggle('selected', mode === 'timeline');
  $('mode-clock').classList.toggle('selected', mode === 'clock');
  $('mode-timeline').setAttribute('aria-pressed', String(mode === 'timeline'));
  $('mode-clock').setAttribute('aria-pressed', String(mode === 'clock'));
  $('timeline-help').hidden = mode !== 'timeline';
  $('clock-help').hidden = $('clock-fields').hidden = $('read-clocks').hidden = mode !== 'clock';
  $('calibrate').textContent = mode === 'clock' ? 'Aplicar tempos informados' : 'Marcar mesmo momento';
  if (mode !== 'clock') clearCaptures();
  status('Modo selecionado', mode === 'clock' ? 'Selecione os dois relógios ou informe os tempos com os vídeos pausados.' : 'Pause e alinhe os dois vídeos; depois marque a referência.');
  updateControls();
}

function listen(id, action) { $(id).addEventListener('click', event => Promise.resolve(action(event)).catch(fail)); }
for (const role of roles) {
  listen(role + '-connect', () => connect(role));
  $(role + '-tab').addEventListener('change', () => {
    stop(false); clearAnchor();
    delete sources[role];
    if (captures[role]) { captures[role].stream.getTracks().forEach(t => t.stop()); delete captures[role]; }
    $(role + '-connection').textContent = 'Não conectado'; $(role + '-connection').classList.remove('connected');
    $(role + '-player').hidden = true; document.querySelector(`[for="${role}-player"]`).hidden = true;
    $(role + '-time').textContent = '—:—'; $(role + '-title').textContent = 'Conecte a aba selecionada';
    $(role + '-capture').textContent = 'Selecionar relógio';
    updateControls(); status('Conecte a aba selecionada', 'A mudança de aba encerra a referência anterior.');
  });
  $(role + '-player').addEventListener('change', () => {
    stop(false); clearAnchor(); clearCaptures();
    sources[role].videoId = $(role + '-player').value;
    status('Player selecionado', 'Marque uma nova referência para esse vídeo.');
  });
  listen(role + '-capture', async () => {
    stop(false);
    const token = revision;
    status('Selecione a aba correta', 'Na janela do navegador, escolha a mesma aba conectada neste lado.');
    const capture = await selectCapture($('crop-dialog'), () => {
      delete captures[role]; stop(false); resetTrackers(); updateControls();
      $(role + '-capture').textContent = 'Selecionar relógio';
      status('Captura encerrada', 'Selecione o relógio novamente para continuar a leitura.', 'warning');
    });
    if (!capture) { status('Seleção cancelada', 'Você pode tentar novamente ou usar a calibração manual.'); return; }
    if (token !== revision) { capture.stream.getTracks().forEach(t => t.stop()); return; }
    captures[role]?.stream.getTracks().forEach(t => t.stop()); captures[role] = capture;
    $(role + '-capture').textContent = 'Relógio selecionado · trocar';
    resetTrackers(); updateControls();
    status('Região selecionada', hasOCR() ? 'Você pode ler os relógios pausados ou iniciar a leitura contínua.' : 'Selecione agora o relógio do outro vídeo.', 'active');
  });
}
listen('refresh', refreshTabs);
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
    const fresh = await pair();
    if (token !== revision) return;
    if (roles.some(role => !fresh[role].paused || Math.abs(fresh[role].time - result.states[role].time) > 0.2)) throw new Error('Os vídeos mudaram durante a leitura. Pause novamente e repita.');
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
