import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, clockFromOCR, clockTarget, decideCorrection, ClockTracker } from '../extension/core.js';

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

test('refuses unavailable live footage and seekable gaps', () => {
  assert.equal(decide(30).action, 'unavailable');
  assert.equal(decide(220).action, 'unavailable');
  assert.equal(decide(110, { follower: { ...state, ranges: [[0, 100], [120, 200]] } }).action, 'unavailable');
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
