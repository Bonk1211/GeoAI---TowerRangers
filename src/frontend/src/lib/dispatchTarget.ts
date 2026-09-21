import type { ScheduleRun } from '../api/types.ts';

/**
 * The day a "Dispatch now" from the map should target, or `null` when there
 * is not one yet.
 *
 * `useScheduleStore.run` is populated only when /schedule mounts, so a
 * session that opens on `/` and has never visited the Schedule tab holds
 * `run.horizon === []`. The three dispatch buttons used to fall back to `''`
 * there, which produced a Selection with an empty day: no cell highlighted,
 * and a dispatch that posted `target_day: ""` for the backend to blow up on
 * inside `date.fromisoformat("")`. Returning null instead lets each caller
 * say the dispatch is not available yet rather than offering one it cannot
 * perform — and `noUncheckedIndexedAccess` is off, so `run.horizon[0]` needs
 * the explicit guard below to be honest about being possibly absent.
 */
export function dispatchDayFor(run: ScheduleRun, tower_id: string): string | null {
  const entry = run.entries.find((e) => e.tower_id === tower_id);
  if (entry?.day) return entry.day;
  const first: string | undefined = run.horizon[0];
  return first ?? null;
}

/** Why the dispatch button is not offering anything. Stated, never silent. */
export const NO_DISPATCH_DAY_REASON =
  'Open the Schedule tab first — no plan is loaded, so there is no crew-day to dispatch into.';
