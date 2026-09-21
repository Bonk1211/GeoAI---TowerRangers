/**
 * Step-by-step interpolation for a number the user is watching change.
 *
 * WHY A NUMBER NEEDS TO BE WATCHED CHANGE AT ALL.
 *
 * A risk score that jumps 0.87 -> 0.63 between two renders shows a RESULT. The
 * same score ticking down through 0.86, 0.85, 0.84 ... shows that something
 * MOVED it, and how far — which is the reading the protection surface exists
 * to produce. Same argument as the console transcript one level up: the
 * mechanism is the claim, and a value that teleports hides it.
 *
 * THIS IS A STEP COUNTER, NOT A TWEEN, and the difference is the whole point.
 *
 * An eased tween samples a continuous curve once per animation frame and
 * rounds for display, so at 60fps a 24-step count renders maybe a dozen of its
 * values and skips the rest — measured on the first version of this file:
 * 0.70 0.68 0.65 0.63 0.60 0.58 ... Every skipped value is a step the eye does
 * not see, and the count reads as a blur rather than as a descent.
 *
 * So the unit of animation here is the STEP, not the frame. The value moves by
 * exactly one increment at a time, every value between the endpoints is
 * rendered, and each is held long enough to register. The number of steps is
 * decided by the data; the duration follows from it.
 */

/** Display granularity: the risk index is read to two decimals everywhere. */
export const STEP = 0.01;

/**
 * How long each individual step is held, in milliseconds.
 *
 * 45ms is about three frames at 60Hz — long enough that a digit is genuinely
 * drawn and seen rather than passed through, short enough that a long count
 * still finishes briskly. Below ~30ms the steps stop being individually
 * legible and this degenerates back into the blur it exists to avoid.
 */
export const STEP_MS = 45;

/**
 * Preferred ceiling on total run time, because this plays while someone is
 * presenting. It is a PREFERENCE, not a guarantee — see `MIN_HOLD_MS`.
 */
export const MAX_TOTAL_MS = 1400;

/**
 * The floor no compression may cross, and the reason the cap above is soft.
 *
 * A step held for less than one display frame cannot be drawn, so squeezing a
 * long count into a fixed budget does not speed it up — it silently deletes
 * the steps that fall between frames, which is precisely the skipping this
 * module exists to prevent. Measured: 96 steps forced into 1400ms is 14.6ms
 * per step, below a 16.7ms frame at 60Hz, so roughly one step in eight never
 * renders.
 *
 * 20ms clears a 60Hz frame with margin. When a count is long enough that
 * honouring both the floor and the ceiling is impossible, the FLOOR wins and
 * the count simply runs longer: every value visible is the requirement, and
 * finishing quickly is the preference. The longest count the protection
 * catalogue can produce is about 32 steps (a 0.32 drop), which lands at 1400ms
 * anyway — the conflict only arises for moves larger than anything this app
 * can generate.
 */
export const MIN_HOLD_MS = 20;

/**
 * Snap a raw value onto the display grid.
 *
 * Model output is a full-precision float — 0.6974, 0.5135 — while the readout
 * shows two decimals. Every calculation here works on the SNAPPED values,
 * because the count is a walk across displayed values and an unsnapped
 * endpoint is not one of them.
 *
 * Skipping this is what made the last step disappear. With raw endpoints,
 * 0.6974 -> 0.5135 is 18.39 steps; rounding the COUNT to 18 and adding whole
 * increments to 0.6974 walks 0.70, 0.69 ... 0.53, and then the target renders
 * as 0.51 — so 0.52 is never produced, because neither endpoint sits on the
 * grid the display uses. Snapping first makes it 0.70 -> 0.51, exactly 19
 * steps, every one of them a value the readout can show.
 */
export function snap(value: number): number {
  return Math.round(value / STEP) * STEP;
}

/** Number of discrete steps between two values, at `STEP` granularity. */
export function stepCount(from: number, to: number): number {
  return Math.max(0, Math.round(Math.abs(snap(to) - snap(from)) / STEP));
}

/**
 * How long to hold each step for a count between these two values.
 *
 * Constant at STEP_MS until the total would exceed MAX_TOTAL_MS, then shortens
 * to fit — but never below MIN_HOLD_MS, because a step shorter than a display
 * frame is a step that does not get drawn. Past that point the count runs
 * longer rather than losing values.
 */
export function holdMs(from: number, to: number): number {
  const steps = stepCount(from, to);
  if (steps === 0) return STEP_MS;
  // `steps + 1`, matching `durationFor` — the budget has to cover the extra
  // hold that gives the last intermediate value its full dwell, or fitting the
  // ceiling here still overshoots it there.
  const fitted = MAX_TOTAL_MS / (steps + 1);
  return Math.max(MIN_HOLD_MS, Math.min(STEP_MS, fitted));
}

/**
 * Total duration of the count.
 *
 * `steps + 1` holds, not `steps`, and the extra one is a rendering fix rather
 * than padding. `valueAt` reaches its last intermediate value at
 * `steps-1`/`steps` of the way through, so with `steps` holds that value owns
 * the final slice and the target lands immediately after it. Observed on a
 * real run: the penultimate step had 38ms — about two frames — and the browser
 * routinely painted the target before it ever appeared, so the count read
 * 0.54 0.53 0.51, skipping 0.52 at the one moment the eye is on the number.
 * The extra hold gives the last intermediate value the same dwell as every
 * other step.
 */
export function durationFor(from: number, to: number): number {
  const steps = stepCount(from, to);
  if (steps === 0) return 0;
  return Math.round((steps + 1) * holdMs(from, to));
}

/**
 * The value to display after `elapsed` ms of a count from `from` to `to`.
 *
 * Quantised to `STEP` and advanced LINEARLY — one step per hold, no easing.
 * Easing is what caused the skipping described above: a curve spends its early
 * frames crossing several steps at once, so those steps are never drawn. A
 * constant rate is also the honest reading here, since no part of the
 * underlying change is faster than another.
 *
 * Exact at both ends. `elapsed >= duration` gives `to` itself rather than a
 * rounded approximation of it, because this number is read beside the
 * committed score and 0.6299999 would disagree with it.
 */
export function valueAt(from: number, to: number, elapsed: number, duration: number): number {
  // Duration first: a zero-length count is already finished, and testing
  // `elapsed <= 0` ahead of it would return `from` for duration 0 — leaving a
  // caller that disabled the animation showing the OLD number forever.
  if (duration <= 0 || elapsed >= duration) return to;
  if (elapsed <= 0) return from;

  const steps = stepCount(from, to);
  if (steps === 0) return to;

  // Walk from the SNAPPED start, not the raw one — see `snap`. Adding whole
  // increments to an off-grid value produces off-grid values, and the readout
  // then rounds several of them onto the same displayed step while skipping
  // another entirely.
  const origin = snap(from);
  const direction = to > from ? 1 : -1;
  // Divided into `steps + 1` slices, matching `durationFor` — so each
  // intermediate value, INCLUDING the last one, owns a full slice rather than
  // being squeezed into whatever remains before the target lands. floor, not
  // round: the value must not reach `to` before `elapsed` reaches `duration`,
  // or the count stalls on its final value.
  const taken = Math.min(steps - 1, Math.floor((elapsed / duration) * (steps + 1)));
  // Re-snap after the arithmetic: repeated float addition accumulates a tail
  // even from an already-snapped origin.
  return snap(origin + direction * taken * STEP);
}
