import { clockFromOCR, clockTokens } from './core.js';
import { textBoxes } from './finder.js';
import { t } from './i18n.js';

// Tesseract runs locally, from the files bundled in vendor/.

// Characters allowed when reading a line of a frame. Letters are kept so that
// text next to a clock ("ARG 25:40") isn't misread as more digits.
const TEXT_CHARS = '0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+-\'"().,/';
export class LocalOCR {
  constructor() { this.workerPromise = null; this.failure = null; this.mode = null; }
  async worker() {
    if (this.failure) throw new Error(this.failure);
    if (!globalThis.Tesseract) throw new Error(t('ocr.missing'));
    if (!this.workerPromise) {
      const base = new URL('vendor/', import.meta.url).href;
      this.workerPromise = Tesseract.createWorker('eng', 1, {
        workerPath: `${base}tesseract/worker.min.js`,
        corePath: `${base}core`, langPath: `${base}lang`,
        workerBlobURL: false, gzip: true,
        errorHandler: error => { this.failure = t('ocr.failed', { message: error.message || error }); }
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
    const first = { value: clockFromOCR(data.text), confidence: data.confidence, text: data.text.trim() };
    if (first.value !== null && first.confidence >= 65) return first;
    // Thin, small digits on dark scoreboards need more contrast and a margin.
    // Retry only uncertain reads, and retain the same confidence requirement.
    const source = typeof image === 'string' ? await loadImage(image) : image;
    const { data: retry } = await worker.recognize(prepareClock(source));
    const second = { value: clockFromOCR(retry.text), confidence: retry.confidence, text: retry.text.trim() };
    return second.value !== null && (first.value === null || second.confidence > first.confidence) ? second : first;
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
    image.onerror = () => reject(new Error(t('image.failed')));
    image.src = src;
  });
}

export function prepareClock(image) {
  const w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
  const scale = Math.min(8, Math.max(1, 96 / h));
  const crop = document.createElement('canvas');
  crop.width = Math.round(w * scale); crop.height = Math.round(h * scale);
  const ctx = crop.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, crop.width, crop.height);
  const pixels = ctx.getImageData(0, 0, crop.width, crop.height);
  const histogram = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = (pixels.data[i] * 77 + pixels.data[i + 1] * 150 + pixels.data[i + 2] * 29) >> 8;
    pixels.data[i] = gray; histogram[gray]++; sum += gray;
  }
  const total = crop.width * crop.height;
  let count = 0, partial = 0, best = -1, threshold = 127;
  for (let i = 0; i < 255; i++) {
    count += histogram[i]; partial += i * histogram[i];
    if (!count || count === total) continue;
    const difference = partial / count - (sum - partial) / (total - count);
    const variance = count * (total - count) * difference * difference;
    if (variance > best) { best = variance; threshold = i; }
  }
  const darkBackground = histogram.slice(0, threshold + 1).reduce((a, b) => a + b, 0) > total / 2;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const white = (pixels.data[i] > threshold) !== darkBackground;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = white ? 255 : 0;
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  const padded = document.createElement('canvas');
  padded.width = crop.width + 24; padded.height = crop.height + 24;
  const out = padded.getContext('2d');
  out.fillStyle = '#fff'; out.fillRect(0, 0, padded.width, padded.height);
  out.drawImage(crop, 12, 12);
  return padded;
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
    const scale = Math.min(8, Math.max(1, 64 / line.h));
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
    throw new Error(t('capture.stopped'));
  }
  const width = Math.max(1, Math.round(region.w * video.videoWidth));
  const height = Math.max(1, Math.round(region.h * video.videoHeight));
  const scale = Math.min(8, Math.max(1, 90 / height));
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
    throw new Error(t('capture.pickTab'));
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
export async function selectRegion(dialog, still, { suggested = null, options = [], track = null, note = '' } = {}) {
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
  description.textContent = region ? t('crop.found') : (note || t('crop.none'));
  function render() {
    context.drawImage(frozen, 0, 0);
    if (!region) return;
    const { x, y, w, h } = region;
    context.fillStyle = '#0008'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frozen, x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height, x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
    context.strokeStyle = '#b7f4ce'; context.lineWidth = 2;
    context.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
    // Reject empty drags, but let OCR try a tiny clock after enlargement.
    save.disabled = w * sourceWidth < 4 || h * sourceHeight < 3;
    if (!start && region === suggested) return;
    description.textContent = save.disabled ? t('crop.bigger') : t('crop.selected');
  }
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const choices = document.querySelector('#crop-options');
  choices.hidden = options.length < 2;
  choices.replaceChildren();
  if (options.length > 1) {
    choices.append(t('crop.options'));
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
