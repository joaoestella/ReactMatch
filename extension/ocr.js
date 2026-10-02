import { clockFromOCR, clockTokens } from './core.js';
import { textBoxes } from './finder.js';

// Tesseract runs locally, from the files bundled in vendor/.

// Characters allowed when reading a line of a frame. Letters are kept so that
// text next to a clock ("ARG 25:40") isn't misread as more digits.
const TEXT_CHARS = '0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+-\'"().,/';
export class LocalOCR {
  constructor() { this.workerPromise = null; this.failure = null; this.mode = null; }
  async worker() {
    if (this.failure) throw new Error(this.failure);
    if (!globalThis.Tesseract) throw new Error('Os arquivos de leitura local não foram encontrados. Use a pasta completa da extensão.');
    if (!this.workerPromise) {
      const base = new URL('vendor/', import.meta.url).href;
      this.workerPromise = Tesseract.createWorker('eng', 1, {
        workerPath: `${base}tesseract/worker.min.js`,
        corePath: `${base}core`, langPath: `${base}lang`,
        workerBlobURL: false, gzip: true,
        errorHandler: error => { this.failure = `Falha na leitura local: ${error.message || error}`; }
      });
    }
    return this.workerPromise;
  }
  async setMode(mode) {
    const worker = await this.worker();
    if (this.mode === mode) return worker;
    // 'clock': a crop around one clock, digits only. 'text': one line of any text.
    await worker.setParameters(mode === 'clock'
      ? { tessedit_char_whitelist: '0123456789:', tessedit_pageseg_mode: '7' }
      : { tessedit_char_whitelist: TEXT_CHARS, tessedit_pageseg_mode: '7' });
    this.mode = mode;
    return worker;
  }
  // image: canvas, <img> or data URL of the clock region.
  async read(image) {
    const worker = await this.setMode('clock');
    const { data } = await worker.recognize(image);
    return { value: clockFromOCR(data.text), confidence: data.confidence, text: data.text.trim() };
  }
  // The words of a crop holding one line of text, with boxes in crop pixels.
  async line(image) {
    const worker = await this.setMode('text');
    const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
    const words = [];
    for (const block of data.blocks || []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
      for (const word of line.words) {
        words.push({ text: word.text, confidence: word.confidence, bbox: word.bbox, symbols: (word.symbols || []).map(s => s.bbox) });
      }
    }
    return words;
  }
  async close() {
    try { if (this.workerPromise) (await this.workerPromise).terminate(); } catch { /* Already stopped. */ }
    this.workerPromise = null; this.mode = null;
  }
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Não foi possível abrir a imagem do vídeo.'));
    image.src = src;
  });
}

// Clock-looking tokens on one frame. Text lines are located first (finder.js)
// and each is read on its own, enlarged; `lines` reuses known line positions.
export async function scanClocks(ocr, src, lines = null) {
  const image = await loadImage(src);
  const W = image.naturalWidth, H = image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  lines ??= textBoxes(context.getImageData(0, 0, W, H));
  const tokens = [];
  for (const line of lines) {
    const pad = Math.round(line.h * 0.4);
    const x = Math.max(0, line.x - pad), y = Math.max(0, line.y - pad);
    const w = Math.min(W - x, line.w + 2 * pad), h = Math.min(H - y, line.h + 2 * pad);
    const scale = Math.min(4, Math.max(1, 64 / line.h));
    const crop = document.createElement('canvas');
    crop.width = Math.round(w * scale); crop.height = Math.round(h * scale);
    crop.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, crop.width, crop.height);
    const back = b => ({ x0: x + b.x0 / scale, y0: y + b.y0 / scale, x1: x + b.x1 / scale, y1: y + b.y1 / scale });
    const words = (await ocr.line(crop)).map(word => ({ ...word, bbox: back(word.bbox), symbols: word.symbols.map(back) }));
    for (const token of clockTokens(words, W, H)) tokens.push({ ...token, line });
  }
  return tokens;
}

// Crop of a tab capture (fallback path, used when the player can't be read directly).
export function cropFrame(capture) {
  const { video, region } = capture;
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || capture.stream.getVideoTracks()[0]?.readyState !== 'live') {
    throw new Error('A captura parou. Selecione o relógio novamente.');
  }
  const width = Math.max(1, Math.round(region.w * video.videoWidth));
  const height = Math.max(1, Math.round(region.h * video.videoHeight));
  const scale = Math.min(4, Math.max(1, 90 / height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, region.x * video.videoWidth, region.y * video.videoHeight, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Fallback: asks Chrome for a capture of the tab. Returns the stream and a still.
export async function startTabCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', frameRate: 5 }, audio: false,
    selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude'
  });
  const track = stream.getVideoTracks()[0];
  if (track.getSettings().displaySurface !== 'browser') {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('Selecione uma aba do navegador, em vez da tela inteira ou de uma janela.');
  }
  const video = document.createElement('video');
  video.muted = true; video.srcObject = stream;
  try { await video.play(); } catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
  return { stream, video };
}

// Lets the user drag a box over the clock on a still image (an <img>, a
// <video> or a canvas). Resolves to a region in 0..1 coordinates, or null.
// `suggested` pre-selects a region, e.g. one found automatically.
// `options` lists other clocks found ({ label, region }), shown as buttons.
export async function selectRegion(dialog, still, { suggested = null, options = [], track = null } = {}) {
  const sourceWidth = still.videoWidth || still.naturalWidth || still.width;
  const sourceHeight = still.videoHeight || still.naturalHeight || still.height;
  const canvas = document.querySelector('#crop-canvas');
  const context = canvas.getContext('2d');
  canvas.width = Math.min(sourceWidth, 1200);
  canvas.height = Math.round(canvas.width * sourceHeight / sourceWidth);
  const frozen = document.createElement('canvas');
  frozen.width = canvas.width; frozen.height = canvas.height;
  frozen.getContext('2d').drawImage(still, 0, 0, frozen.width, frozen.height);
  let region = suggested, start = null;
  const save = document.querySelector('#crop-save');
  const description = document.querySelector('#crop-description');
  save.disabled = !region;
  description.textContent = region ? 'Relógio encontrado. Confirme ou arraste para ajustar.' : 'Nenhuma região selecionada.';
  function render() {
    context.drawImage(frozen, 0, 0);
    if (!region) return;
    const { x, y, w, h } = region;
    context.fillStyle = '#0008'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frozen, x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height, x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
    context.strokeStyle = '#b7f4ce'; context.lineWidth = 2;
    context.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
    save.disabled = w * sourceWidth < 15 || h * sourceHeight < 8;
    if (!start && region === suggested) return;
    description.textContent = save.disabled ? 'Selecione uma região maior.' : 'Região selecionada. Confirme se contém somente o relógio desejado.';
  }
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const choices = document.querySelector('#crop-options');
  choices.hidden = options.length < 2;
  choices.replaceChildren();
  if (options.length > 1) {
    choices.append('Relógios encontrados:');
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      button.setAttribute('aria-pressed', String(option.region === suggested));
      button.onclick = () => {
        region = suggested = option.region; render();
        for (const other of choices.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      };
      choices.append(button);
    }
  }
  canvas.onpointerdown = event => { start = point(event); canvas.setPointerCapture(event.pointerId); };
  canvas.onpointermove = event => {
    if (!start) return;
    const p = point(event);
    region = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    render();
  };
  canvas.onpointerup = () => { start = null; };
  canvas.onpointercancel = () => { start = null; };
  render(); dialog.showModal();
  const accepted = await new Promise(resolve => {
    save.onclick = () => { dialog.returnValue = 'save'; dialog.close(); };
    document.querySelector('#crop-close').onclick = () => dialog.close('cancel');
    document.querySelector('#crop-full').onclick = () => { region = { x: 0, y: 0, w: 1, h: 1 }; render(); };
    dialog.onclose = () => resolve(dialog.returnValue === 'save' && region);
    dialog.oncancel = () => { dialog.returnValue = 'cancel'; };
    dialog.returnValue = '';
    if (track) track.onended = () => dialog.close('cancel');
  });
  canvas.onpointerdown = canvas.onpointermove = canvas.onpointerup = canvas.onpointercancel = null;
  return accepted || null;
}
