export function parseClock(text) {
  const cleaned = String(text).trim().replace(/\s/g, '');
  if (!/^\d{1,3}:\d{2}(:\d{2})?$/.test(cleaned)) return null;
  const parts = cleaned.split(':').map(Number);
  if (parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

export function clockFromOCR(text) {
  // A crop with multiple clocks is ambiguous. Never choose one silently.
  const candidates = String(text).trim().match(/\d{1,3}\s*:\s*\d{2}(?:\s*:\s*\d{2})?/g) || [];
  if (candidates.length !== 1) return null;
  return parseClock(candidates[0]);
}

export function formatTime(value) {
  if (!Number.isFinite(value)) return '—';
  const n = Math.max(0, Math.floor(value));
  const s = String(n % 60).padStart(2, '0');
  const m = Math.floor(n / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

export function insideRanges(target, ranges) {
  return Number.isFinite(target) && ranges.some(([start, end]) => target >= start && target <= end - 0.08);
}

export function clockTarget(referenceClock, followerClock, followerPosition, direction = 1, trim = 0) {
  if (![referenceClock, followerClock, followerPosition, trim].every(Number.isFinite) || ![1, -1].includes(direction)) {
    throw new Error('Tempos inválidos.');
  }
  return followerPosition + (referenceClock - followerClock) * direction + trim;
}

export function decideCorrection({ target, follower, reference, tolerance = 0.85, maxSeek = Infinity, lastSeek = -Infinity, now = performance.now() }) {
  if (!Number.isFinite(target)) return { action: 'wait', reason: 'Referência ainda não definida.' };
  if (reference.ad || follower.ad) return { action: 'wait', reason: 'Anúncio detectado. Recalibre após o anúncio.' };
  if (reference.ended || follower.ended) return { action: 'wait', reason: 'Um dos vídeos terminou.' };
  if (reference.ready < 3 || follower.ready < 3 || reference.seeking || follower.seeking) {
    return { action: 'wait', reason: 'Aguardando o vídeo carregar.' };
  }
  if (Math.abs(reference.rate - follower.rate) > 0.01) return { action: 'wait', reason: 'Use a mesma velocidade nos dois vídeos.' };
  const error = target - follower.time;
  if (Math.abs(error) <= tolerance) return { action: 'aligned', error };
  if (Math.abs(error) > maxSeek) return { action: 'wait', error, reason: 'Diferença acima de 30s. Pause, confira os relógios e aplique os tempos manualmente.' };
  if (!insideRanges(target, follower.ranges)) return { action: 'unavailable', error, reason: 'Esse momento não está disponível para voltar ou avançar neste player.' };
  if (now - lastSeek < 3000) return { action: 'wait', error, reason: 'Conferindo o último ajuste…' };
  return { action: 'seek', target, error };
}

// Offset to keep between the two players (follower.time - reference.time) so
// both clocks show the same moment. Each side gives the clock it showed and
// the player position of that exact frame, so OCR delays don't matter.
export function anchorFromClocks(reference, follower, direction = 1) {
  return follower.time + (reference.clock - follower.clock) * direction - reference.time;
}

// Clocks only show whole seconds, so one reading is off by up to a second.
// Readings taken at random points within the second average out: this keeps
// the last few estimates and returns the mean of those close to the median.
export class AnchorEstimator {
  constructor(size = 8, need = 3) { this.size = size; this.need = need; this.values = []; }
  reset() { this.values = []; }
  push(value) {
    if (!Number.isFinite(value)) return this.value();
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
    return this.value();
  }
  value() {
    if (this.values.length < this.need) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const close = this.values.filter(v => Math.abs(v - median) <= 1.2);
    if (close.length < this.need) return null;
    return close.reduce((a, b) => a + b, 0) / close.length;
  }
}

export class ClockTracker {
  constructor(direction = 1) { this.direction = direction; this.reset(); }
  reset() { this.previous = null; this.good = 0; }
  push(value, at, confidence = 100, rate = 1) {
    if (!Number.isFinite(value) || confidence < 65) {
      this.reset();
      return { valid: false, reason: 'Relógio ilegível. Aguardando uma leitura clara.' };
    }
    const old = this.previous;
    this.previous = { value, at };
    if (!old) { this.good = 1; return { valid: false, reason: 'Confirmando o relógio…' }; }
    const elapsed = (at - old.at) / 1000;
    const moved = (value - old.value) * this.direction;
    if (elapsed <= 0 || elapsed > 8 || Math.abs(moved - elapsed * rate) > 1.4 || moved < 0) {
      this.good = 1;
      return { valid: false, reason: 'Relógio mudou ou parou. Confirmando a nova referência…' };
    }
    // Do not infer a ticking clock from a frozen broadcast image.
    if (moved === 0 && elapsed >= 1.4) {
      this.good = 1;
      return { valid: false, reason: 'Relógio parado. Aguardando avanço…' };
    }
    this.good += 1;
    return { valid: this.good >= 3, reason: this.good >= 3 ? '' : 'Confirmando o relógio…', value };
  }
}
