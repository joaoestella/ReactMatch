import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, clockFromOCR, clockTarget, decideCorrection, ClockTracker, anchorFromClocks, AnchorEstimator, clockTokens, findClocks, regionAround, regionInTab } from '../extension/core.js';
import { textBoxes } from '../extension/finder.js';

test('reads long timers and hours; rejects invalid seconds and ambiguous OCR', () => {
  assert.equal(parseClock('125:42'), 7542);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('45:99'), null);
  assert.equal(parseClock('1:72:00'), null);
  assert.equal(clockFromOCR(' 25 : 40\n'), 1540);
  assert.equal(clockFromOCR('25:40 12:05'), null);
});

test('corrects either direction and countdown without confusing media and content time', () => {
  assert.equal(clockTarget(100, 112, 600), 588);
  assert.equal(clockTarget(112, 100, 600), 612);
  assert.equal(clockTarget(100, 112, 600, -1), 612);
  assert.equal(clockTarget(100, 100, 600, 1, -0.5), 599.5);
});

const state = { time: 100, ready: 4, rate: 1, seeking: false, ranges: [[50, 200]], paused: false };
const decide = (target, overrides = {}) => decideCorrection({ target, reference: state, follower: state, now: 10000, ...overrides });

test('the video that is ahead goes back, or waits; only then the other skips ahead', () => {
  // B 12 s behind: A (ahead) rewinds 12 s.
  assert.deepEqual(decide(112), { action: 'seek', role: 'reference', to: 88, error: 12 });
  // B 12 s ahead: B rewinds.
  assert.deepEqual(decide(88), { action: 'seek', role: 'follower', to: 88, error: -12 });
  // A is ahead but a live with no rewind: A pauses for the difference…
  const live = { ...state, ranges: [[99, 100.5]] };
  assert.deepEqual(decide(112, { reference: live }), { action: 'hold', role: 'reference', seconds: 12, error: 12 });
  // …unless its player can't be held (jumps to live): then B skips ahead.
  assert.deepEqual(decide(112, { reference: live, canHold: { reference: false, follower: true } }), { action: 'seek', role: 'follower', to: 112, error: 12 });
  assert.deepEqual(decide(88, { reference: live, follower: live }), { action: 'hold', role: 'follower', seconds: 12, error: -12 });
  assert.deepEqual(decide(112, { reference: live, follower: live }), { action: 'hold', role: 'reference', seconds: 12, error: 12 });
  const noHold = { reference: false, follower: false };
  assert.equal(decide(88, { reference: live, follower: live, canHold: noHold }).action, 'unavailable');
  assert.equal(decide(110, { reference: live, follower: { ...state, ranges: [[0, 100], [120, 200]] }, canHold: noHold }).action, 'unavailable');
  assert.equal(decide(400, { reference: live, follower: live }).action, 'unavailable', 'never pauses for more than 3 minutes');
});

test('does not chase tiny differences or repeatedly seek, buffer, or ads', () => {
  assert.equal(decide(100.5).action, 'aligned');
  assert.equal(decide(112).action, 'seek');
  assert.equal(decide(112, { lastSeek: 9000 }).action, 'wait');
  assert.equal(decide(112, { reference: { ...state, ready: 2 } }).action, 'wait');
  assert.equal(decide(112, { reference: { ...state, ad: true } }).action, 'wait');
  assert.equal(decide(112, { follower: { ...state, rate: 1.5 } }).action, 'wait');
  assert.equal(decide(145, { maxSeek: 30 }).action, 'wait');
});

test('requires consistent observations and rejects jumps, unreadable and stale clocks', () => {
  const tracker = new ClockTracker();
  assert.equal(tracker.push(100, 0).valid, false);
  assert.equal(tracker.push(102, 2000).valid, false);
  assert.equal(tracker.push(104, 4000).valid, true);
  assert.equal(tracker.push(504, 6000).valid, false);
  assert.equal(tracker.push(506, 8000, 20).valid, false);
  assert.equal(tracker.push(108, 10000).valid, false);
  assert.equal(tracker.push(130, 30000).valid, false);
});

test('frozen clocks cannot produce valid automatic adjustments', () => {
  const tracker = new ClockTracker();
  for (let n = 0; n < 5; n++) assert.equal(tracker.push(100, n * 2000).valid, false);
});

test('accepts countdown clocks and matching playback speed', () => {
  const tracker = new ClockTracker(-1);
  tracker.push(100, 0); tracker.push(98, 2000);
  assert.equal(tracker.push(96, 4000).valid, true);
  const faster = new ClockTracker();
  faster.push(100, 0, 100, 2); faster.push(104, 2000, 100, 2);
  assert.equal(faster.push(108, 4000, 100, 2).valid, true);
});

test('anchor comes from each frame\'s own player position, not from when OCR finished', () => {
  // Reaction shows 25:10 at 40 s; the game shows 25:30 at 50 s. Game must be 10 s behind
  // the reaction's position (30 s when the reaction is at 40 s).
  assert.equal(anchorFromClocks({ clock: 1510, time: 40 }, { clock: 1530, time: 50 }), -10);
  assert.equal(anchorFromClocks({ clock: 100, time: 0 }, { clock: 90, time: 0 }, -1), -10);
});

test('anchor estimates average out whole-second clocks and ignore outliers', () => {
  const estimator = new AnchorEstimator();
  assert.equal(estimator.push(-20.4), null);
  assert.equal(estimator.push(-19.6), null);
  assert.ok(Math.abs(estimator.push(-20.1) - -20.033) < 0.01);
  assert.ok(Math.abs(estimator.push(-35) - -20.033) < 0.01, 'a single misread does not move the anchor');
});

test('clock tokens skip pieces of longer numbers and locate the clock inside a line', () => {
  const sym = (x0, x1) => ({ x0, x1, y0: 10, y1: 30 });
  const words = [
    { text: 'ARG25:30', confidence: 90, bbox: { x0: 0, y0: 10, x1: 160, y1: 30 }, symbols: [0, 20, 40, 60, 80, 100, 120, 140].map(x => sym(x, x + 18)) },
    { text: '1025:30', confidence: 90, bbox: { x0: 200, y0: 10, x1: 300, y1: 30 }, symbols: [] }
  ];
  const tokens = clockTokens(words, 1000, 100);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].value, 1530);
  assert.equal(tokens[0].box.x, 0.06);
});

test('only clocks that tick with the video are found; mm:ss beats an uptime', () => {
  const at = (text, x, value, parts = 2) => ({ text, value, parts, confidence: 90, box: { x, y: 0.9, w: 0.06, h: 0.03 } });
  const frames = [0, 1.1, 2.2].map((time, i) => ({
    time,
    tokens: [at('12:30', 0.8, 750), at('x', 0.1, 1510 + i), at('y', 0.5, 3765 + i, 3), at('z', 0.3, 300 - i)]
  }));
  const found = findClocks(frames);
  assert.deepEqual(found.map(c => [c.box.x, c.direction]), [[0.1, 1], [0.3, -1], [0.5, 1]]);
  assert.deepEqual(findClocks(frames.slice(0, 1)), []);
  const region = regionAround({ x: 0.5, y: 0.5, w: 0.1, h: 0.04 });
  assert.ok(region.x < 0.5 && region.x + region.w > 0.6 && region.y < 0.5 && region.y + region.h > 0.54);
});

test('text finder marks a line of glyphs and ignores flat or noisy areas', () => {
  const width = 400, height = 200, data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const v = 60 + (seed % 20);
    data.set([v, v, v, 255], i * 4);
  }
  // Five "glyphs" made of vertical bars, 20 px tall, at y = 100.
  for (let g = 0; g < 5; g++) for (let y = 100; y < 120; y++) for (const x of [0, 1, 8, 9]) {
    const px = 50 + g * 14 + x;
    data.set([240, 240, 240, 255], (y * width + px) * 4);
  }
  const boxes = textBoxes({ data, width, height });
  assert.equal(boxes.length, 1);
  assert.ok(Math.abs(boxes[0].y - 100) <= 1 && Math.abs(boxes[0].h - 20) <= 1 && boxes[0].x <= 50 && boxes[0].x + boxes[0].w >= 115);
});

test('a region of the video is found in a capture of the whole tab, letterbox included', () => {
  // 16:9 video in a 1000x800 element at (100, 50) of a 1200x900 page: 1000x562.5, centred vertically.
  const layout = { rect: { x: 100, y: 50, width: 1000, height: 800 }, videoWidth: 1920, videoHeight: 1080, viewport: { width: 1200, height: 900 }, fit: 'contain' };
  const r = regionInTab(layout, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  assert.ok(Math.abs(r.x - 600 / 1200) < 1e-9 && Math.abs(r.w - 500 / 1200) < 1e-9);
  assert.ok(Math.abs(r.y - (50 + 118.75) / 900) < 1e-9 && Math.abs(r.h - 281.25 / 900) < 1e-9);
  const off = regionInTab({ ...layout, rect: { x: 900, y: 50, width: 1000, height: 562.5 } }, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  assert.equal(off.x, 1);
});
