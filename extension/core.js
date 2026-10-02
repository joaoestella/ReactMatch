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

// When the follower can't seek to the target (a live player with little or no
// rewind), the video that is ahead can still wait: pausing it for the
// difference and resuming lines them up, as long as the player keeps its
// buffer while paused. `canHold` turns that off per side.
export function decideCorrection({ target, follower, reference, tolerance = 0.85, maxSeek = Infinity, lastSeek = -Infinity, now = performance.now(), canHold = { reference: true, follower: true }, maxHold = 180 }) {
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
  if (now - lastSeek < 3000) return { action: 'wait', error, reason: 'Conferindo o último ajuste…' };
  if (!insideRanges(target, follower.ranges)) {
    // error < 0: B is ahead and must wait. error > 0: B can't jump ahead, so A waits.
    const role = error < 0 ? 'follower' : 'reference';
    if (canHold[role] && Math.abs(error) <= maxHold && !(role === 'reference' ? reference : follower).paused) {
      return { action: 'hold', role, seconds: Math.abs(error), error };
    }
    return { action: 'unavailable', error, reason: 'Esse momento não está disponível para voltar ou avançar neste player.' };
  }
  return { action: 'seek', target, error };
}

// Clock-looking tokens ("25:40", "1:02:45") in the words OCR found on a whole
// frame. Boxes are returned in 0..1 coordinates of the frame.
export function clockTokens(words, width, height) {
  const tokens = [];
  for (const word of words) {
    const text = String(word.text);
    for (const match of text.matchAll(/\d{1,3}:\d{2}(?::\d{2})?/g)) {
      // Reject pieces of longer numbers ("1025:30" is not a clock).
      if (/[\d:]/.test(text[match.index - 1] || '') || /[\d:]/.test(text[match.index + match[0].length] || '')) continue;
      const value = parseClock(match[0]);
      if (value === null) continue;
      let box = word.bbox;
      const symbols = word.symbols || [];
      if (symbols.length === text.length && match[0].length < text.length) {
        const part = symbols.slice(match.index, match.index + match[0].length);
        box = { x0: Math.min(...part.map(s => s.x0)), y0: Math.min(...part.map(s => s.y0)), x1: Math.max(...part.map(s => s.x1)), y1: Math.max(...part.map(s => s.y1)) };
      }
      tokens.push({
        text: match[0], value, parts: match[0].split(':').length, confidence: word.confidence ?? 0,
        box: { x: box.x0 / width, y: box.y0 / height, w: (box.x1 - box.x0) / width, h: (box.y1 - box.y0) / height }
      });
    }
  }
  return tokens;
}

// Given clock tokens seen on several frames of the same player (each with the
// player position of that frame), keeps the ones that tick with the video:
// one second of playback moves them one second up (or down, for countdowns).
// Static numbers such as "Replay 12:30" or a score are dropped. Best first:
// mm:ss before h:mm:ss (stream uptime), then bigger, then clearer text.
export function findClocks(frames) {
  if (frames.length < 2) return [];
  const first = frames[0], last = frames.at(-1);
  if (last.time - first.time < 1.5) return [];
  const center = box => [box.x + box.w / 2, box.y + box.h / 2];
  const near = (a, b) => {
    const [ax, ay] = center(a), [bx, by] = center(b);
    return Math.abs(ax - bx) < Math.max(a.w, b.w) * 0.6 && Math.abs(ay - by) < Math.max(a.h, b.h) * 0.6;
  };
  const found = [];
  for (const token of last.tokens) {
    const track = frames.map(frame => frame.tokens.find(other => other.parts === token.parts && near(other.box, token.box)));
    if (!track[0]) continue;
    for (const direction of [1, -1]) {
      const ok = track.every((seen, i) => !seen || Math.abs((seen.value - track[0].value) * direction - (frames[i].time - first.time)) <= 1.2);
      const seenCount = track.filter(Boolean).length;
      if (ok && seenCount >= 2 && track[0].value !== token.value) {
        found.push({ ...token, direction, seen: seenCount });
        break;
      }
    }
  }
  return found.sort((a, b) => (a.parts - b.parts) || (b.box.h - a.box.h) || (b.confidence - a.confidence));
}

// Region to read for a found clock: its box with a little margin.
// `aspect` is the frame's width / height (boxes are relative to each axis).
export function regionAround(box, aspect = 16 / 9) {
  const padX = box.h * 0.5 / aspect, padY = box.h * 0.4;
  const x = Math.max(0, box.x - padX), y = Math.max(0, box.y - padY);
  return { x, y, w: Math.min(1 - x, box.w + padX * 2), h: Math.min(1 - y, box.h + padY * 2) };
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
  reset() { this.previous = null; this.good = 0; this.unreadable = 0; }
  push(value, at, confidence = 100, rate = 1) {
    if (!Number.isFinite(value) || confidence < 65) {
      // One bad read (a blurry frame, a transition) is skipped, not counted
      // against the clock; only readings that disagree start over.
      this.unreadable = (this.unreadable || 0) + 1;
      if (this.unreadable >= 3) this.reset();
      return { valid: false, reason: 'Relógio ilegível. Aguardando uma leitura clara.' };
    }
    this.unreadable = 0;
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
