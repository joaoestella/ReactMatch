import { clockFromOCR } from './core.js';

export class LocalOCR {
  constructor() { this.workerPromise = null; this.failure = null; }
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
      }).then(async worker => {
        await worker.setParameters({ tessedit_char_whitelist: '0123456789:', tessedit_pageseg_mode: '7' });
        return worker;
      });
    }
    return this.workerPromise;
  }
  async read(canvas) {
    const worker = await this.worker();
    const { data } = await worker.recognize(canvas);
    return { value: clockFromOCR(data.text), confidence: data.confidence, text: data.text.trim() };
  }
  async close() {
    try { if (this.workerPromise) (await this.workerPromise).terminate(); } catch { /* Already stopped. */ }
  }
}

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

export async function selectCapture(dialog, onEnded) {
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
  const canvas = document.querySelector('#crop-canvas');
  const context = canvas.getContext('2d');
  canvas.width = Math.min(video.videoWidth, 1200);
  canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
  const still = document.createElement('canvas');
  still.width = canvas.width; still.height = canvas.height;
  still.getContext('2d').drawImage(video, 0, 0, still.width, still.height);
  let region = null, start = null;
  const save = document.querySelector('#crop-save');
  const description = document.querySelector('#crop-description');
  save.disabled = true;
  description.textContent = 'Nenhuma região selecionada.';
  function render() {
    context.drawImage(still, 0, 0);
    if (region) {
      const { x, y, w, h } = region;
      context.fillStyle = '#0008'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(still, x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height, x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
      context.strokeStyle = '#b7f4ce'; context.lineWidth = 2;
      context.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
      save.disabled = w * video.videoWidth < 15 || h * video.videoHeight < 8;
      description.textContent = save.disabled ? 'Selecione uma região maior.' : 'Região selecionada. Confirme se contém somente o relógio desejado.';
    }
  }
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
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
    track.onended = () => dialog.close('cancel');
  });
  canvas.onpointerdown = canvas.onpointermove = canvas.onpointerup = canvas.onpointercancel = null;
  if (!accepted) { stream.getTracks().forEach(t => t.stop()); return null; }
  track.onended = onEnded;
  return { stream, video, region };
}
