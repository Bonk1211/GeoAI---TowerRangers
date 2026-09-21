/**
 * Pure rAF-driver state machine for the Disaster Simulation clock.
 * `docs/Disaster_Simulation_Spec.md` §4.
 *
 * This module owns elapsed-ms bookkeeping, play/pause/seek and the speed
 * multiplier. It has no timers, no `requestAnimationFrame` call and no React
 * — a thin hook (added when the transport bar is wired, P1/P2) is the only
 * thing that calls `tick()` on a rAF loop and re-renders from `elapsedMs`.
 * Keeping the maths here rather than inside a hook is what makes it testable
 * with the same `node --experimental-strip-types --test` pattern the other
 * nine `lib/` test files use.
 *
 * The classic bug this guards against: applying the speed multiplier to
 * ACCUMULATED time makes a 1x -> 2x switch jump the clock, because the whole
 * elapsed total gets doubled instead of just what happens next. `tick()`
 * applies `speed` only to the incoming real-time delta, so scenario time
 * already elapsed is untouched by a speed change.
 */

export type ClockStatus = 'idle' | 'running' | 'paused' | 'done';

export interface ClockState {
  status: ClockStatus;
  elapsedMs: number;
  speed: 1 | 2 | 4;
}

export function createClock(): ClockState {
  return { status: 'idle', elapsedMs: 0, speed: 1 };
}

export function play(state: ClockState): ClockState {
  if (state.status === 'done') return { ...state, status: 'running', elapsedMs: 0 };
  return { ...state, status: 'running' };
}

export function pause(state: ClockState): ClockState {
  if (state.status !== 'running') return state;
  return { ...state, status: 'paused' };
}

export function resume(state: ClockState): ClockState {
  if (state.status !== 'paused') return state;
  return { ...state, status: 'running' };
}

export function setSpeed(state: ClockState, speed: 1 | 2 | 4): ClockState {
  // Only the multiplier changes. elapsedMs is untouched, which is the whole
  // fix for the "switching speed jumps the clock" bug: nothing here is
  // scaled by the OLD or NEW speed, so no accumulated time is rewritten.
  return { ...state, speed };
}

/**
 * Clamp `ms` into `[0, totalDurationMs]` and land on `paused` (never
 * `running`/`idle`) so a caller can resume deliberately rather than a seek
 * silently restarting playback. Seeking to or past `totalDurationMs` marks
 * `done`, matching what running the clock to completion would do.
 */
export function seek(state: ClockState, ms: number, totalDurationMs: number): ClockState {
  const clamped = Math.max(0, Math.min(ms, totalDurationMs));
  const status: ClockStatus = clamped >= totalDurationMs ? 'done' : 'paused';
  return { ...state, elapsedMs: clamped, status };
}

export function reset(): ClockState {
  return createClock();
}

/**
 * Advance the clock by one animation frame. `deltaMs` is REAL time elapsed
 * since the last tick (what `performance.now()` differencing gives you) —
 * this function is the only place `speed` is applied, and it applies to
 * `deltaMs` alone, never to `state.elapsedMs`.
 *
 * No-ops when not running, so a caller can tick unconditionally every frame
 * without checking status first.
 */
export function tick(state: ClockState, deltaMs: number, totalDurationMs: number): ClockState {
  if (state.status !== 'running') return state;
  const next = state.elapsedMs + deltaMs * state.speed;
  if (next >= totalDurationMs) {
    return { ...state, elapsedMs: totalDurationMs, status: 'done' };
  }
  return { ...state, elapsedMs: next };
}
