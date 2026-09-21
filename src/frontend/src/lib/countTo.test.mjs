import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TOTAL_MS,
  MIN_HOLD_MS,
  STEP,
  STEP_MS,
  durationFor,
  holdMs,
  stepCount,
  valueAt,
} from './countTo.ts';

/** Render the count the way a 60fps display would, then drop repeats. */
function render(from, to, fps = 60) {
  const duration = durationFor(from, to);
  const frame = 1000 / fps;
  const out = [];
  for (let t = 0; t <= duration + frame; t += frame) {
    const v = Number(valueAt(from, to, Math.min(t, duration), duration).toFixed(2));
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

test('counts through EVERY intermediate value — none skipped', () => {
  // The whole point of this module. An eased tween sampled at 60fps rendered
  // 0.70 0.68 0.65 0.63 0.60 ... skipping half the steps; a step counter must
  // not.
  const seq = render(0.87, 0.63);
  const expected = [];
  for (let v = 0.87; v >= 0.63 - 1e-9; v -= STEP) expected.push(Number(v.toFixed(2)));
  assert.deepEqual(seq, expected);
  assert.equal(seq.length, 25, `expected 25 values, got ${seq.length}`);
});

test('adjacent rendered values never differ by more than one step', () => {
  for (const [a, b] of [[0.87, 0.63], [0.91, 0.62], [0.2, 0.75], [0.5, 0.48]]) {
    const seq = render(a, b);
    for (let i = 1; i < seq.length; i += 1) {
      const gap = Math.abs(seq[i] - seq[i - 1]);
      assert.ok(gap <= STEP + 1e-9, `jumped ${gap.toFixed(3)} at ${seq[i - 1]} -> ${seq[i]}`);
    }
  }
});

test('a long count compresses the hold rather than dropping steps', () => {
  // 0.98 -> 0.02 is 96 steps; at STEP_MS that would run 4.3s, so the hold
  // compresses. It must not compress past MIN_HOLD_MS, because a step shorter
  // than a display frame is a step that never gets drawn — the cap yields to
  // the floor, and the count runs long rather than losing values.
  const seq = render(0.98, 0.02);
  assert.ok(holdMs(0.98, 0.02) >= MIN_HOLD_MS);
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(Math.abs(seq[i] - seq[i - 1]) <= STEP + 1e-9, 'dropped a step to fit the cap');
  }
  assert.equal(seq.length, 97, `expected every value, got ${seq.length}`);
});

test('any count this app can produce still fits the preferred ceiling', () => {
  // The catalogue's largest measured drop is 0.32 in the maintain band. The
  // floor-vs-ceiling conflict above is real but unreachable from real data.
  assert.ok(durationFor(0.95, 0.63) <= MAX_TOTAL_MS + 1);
  assert.equal(holdMs(0.95, 0.63) > MIN_HOLD_MS, true);
});

test('endpoints are exact — the count lands on the committed value', () => {
  const d = durationFor(0.87, 0.63);
  assert.equal(valueAt(0.87, 0.63, 0, d), 0.87);
  assert.equal(valueAt(0.87, 0.63, d, d), 0.63);
  assert.equal(valueAt(0.87, 0.63, 9999, d), 0.63);
  assert.equal(valueAt(0.87, 0.63, -10, d), 0.87);
});

test('the LAST intermediate value gets a full hold, not a sliver', () => {
  // REGRESSION. With `steps` holds instead of `steps + 1`, the penultimate
  // value owned only the leftover before the target landed — measured at 38ms
  // for a 19-step count, about two frames — so the browser routinely painted
  // the target before it ever appeared and the count read 0.54 0.53 0.51,
  // skipping 0.52 at the one moment the eye is on the number.
  const from = 0.7;
  const to = 0.51;
  const d = durationFor(from, to);
  const hold = holdMs(from, to);
  const last = Number((to + STEP).toFixed(2)); // 0.52

  let firstSeen = null;
  for (let t = 0; t <= d; t += 1) {
    if (Number(valueAt(from, to, t, d).toFixed(2)) === last) {
      firstSeen = t;
      break;
    }
  }
  assert.ok(firstSeen !== null, 'the penultimate value never appears');
  const dwell = d - firstSeen;
  assert.ok(
    dwell >= hold * 0.9,
    `penultimate value held only ${dwell}ms against a ${hold}ms step`,
  );
});

test('the final value arrives only at the end, never early', () => {
  const d = durationFor(0.87, 0.63);
  // At 99% of the duration it must still be short of the target, or the count
  // visibly stalls on its last value.
  assert.notEqual(Number(valueAt(0.87, 0.63, d * 0.99, d).toFixed(2)), 0.63);
});

test('moves only toward the target, and never past it', () => {
  const d = durationFor(0.91, 0.62);
  let prev = 0.91;
  for (let ms = 0; ms <= d; ms += 7) {
    const v = valueAt(0.91, 0.62, ms, d);
    assert.ok(v <= prev + 1e-9, `rose at ${ms}`);
    assert.ok(v >= 0.62 - 1e-9, `overshot at ${ms}`);
    prev = v;
  }
});

test('counts upward just as correctly', () => {
  const seq = render(0.2, 0.31);
  assert.deepEqual(seq, [0.2, 0.21, 0.22, 0.23, 0.24, 0.25, 0.26, 0.27, 0.28, 0.29, 0.3, 0.31]);
});

test('off-grid endpoints still produce every displayed step', () => {
  // REGRESSION, and the one that actually shipped. Real model output is
  // full-precision: this tower committed 0.6974 -> 0.5135. Unsnapped, that is
  // 18.39 steps; rounding the count to 18 and adding whole increments to
  // 0.6974 walked 0.70 0.69 ... 0.53 and then rendered the target as 0.51, so
  // 0.52 never existed — the count visibly jumped two steps at the very end,
  // at the one moment the eye is on the number.
  const seq = render(0.6974, 0.5135);
  const expected = [];
  for (let v = 0.7; v >= 0.51 - 1e-9; v -= STEP) expected.push(Number(v.toFixed(2)));
  assert.deepEqual(seq, expected);
  assert.equal(seq[seq.length - 1], 0.51);
  assert.ok(seq.includes(0.52), '0.52 was skipped');
});

test('displayed values are clean two-decimal steps, not float tails', () => {
  // `from` is a model output with a long tail; every rendered value must still
  // be a clean 0.01 step.
  const d = durationFor(0.8734, 0.6301);
  for (let ms = 0; ms < d; ms += 5) {
    const v = valueAt(0.8734, 0.6301, ms, d);
    if (v === 0.8734) continue; // the exact `from` endpoint
    const cents = v / STEP;
    assert.ok(Math.abs(cents - Math.round(cents)) < 1e-6, `${v} is not a clean step`);
  }
});

test('step count is the number of 0.01 increments between the values', () => {
  assert.equal(stepCount(0.87, 0.63), 24);
  assert.equal(stepCount(0.63, 0.87), 24);
  assert.equal(stepCount(0.5, 0.5), 0);
});

test('hold is never zero — a zero hold is the jump this replaces', () => {
  for (const [a, b] of [[0.5, 0.5], [0.87, 0.63], [0.99, 0.0], [0.5, 0.51]]) {
    assert.ok(holdMs(a, b) > 0, `zero hold for ${a} -> ${b}`);
    assert.ok(holdMs(a, b) <= STEP_MS);
  }
});

test('a same-value change produces no count', () => {
  assert.equal(stepCount(0.42, 0.42), 0);
  assert.equal(durationFor(0.42, 0.42), 0);
  assert.equal(valueAt(0.42, 0.42, 0, 0), 0.42);
});

test('short counts hold each step at the full readable rate', () => {
  // A 5-step move is well under the cap, so it should not be compressed.
  assert.equal(holdMs(0.5, 0.45), STEP_MS);
});
