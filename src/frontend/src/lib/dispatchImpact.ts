import type { OverridePreview } from '../api/types';

/**
 * Turning `/schedule/preview` into something a planner can decide from.
 *
 * WHY THIS EXISTS, AND WHAT IT IS COMPENSATING FOR.
 *
 * Pinning an emergency re-solves the WHOLE national board, and the greedy
 * solver is not stable — it re-packs everything, so most of what comes back in
 * `moved` is churn rather than a consequence of the crew that was picked.
 * Measured on a live run (tower MY_N13331200716, day 2026-09-12):
 *
 *     TRG-C1   moved 24   dropped 2   wait +0.5%
 *     PHG-C1   moved 28   dropped 3   wait +3.4%
 *     shared moves: 23    ·    TRG-only: 1    ·    PHG-only: 5
 *
 * So the two choices differ by about four rows out of twenty-eight, and a
 * planner reading the raw list correctly concludes it is not changing. The
 * quantities that DO separate the two crews are the wait delta and the dropped
 * count, and in the old layout those were the two least prominent things on
 * screen — one line at the bottom, and a couple of rows lost inside the dump.
 *
 * This module puts those first and reduces the list to its shape. It cannot do
 * better than that: `preview.moved` carries `tower_id / from / to / delta_days`
 * and NO crew id, so nothing here can separate "displaced by your choice" from
 * "solver churn". Doing that honestly needs the backend to widen
 * OverridePreview.moved; until then this must not pretend otherwise, and the
 * UI says the list is a re-solve rather than a displacement chain.
 */

export interface MovedRow {
  tower_id: string;
  from: string;
  to: string;
  delta_days: number;
}

/** One bar of the distribution: `delta` days shifted, `count` towers. */
export interface ImpactBucket {
  delta: number;
  count: number;
}

export interface ImpactSummary {
  /** The pinned tower's own slot change — the ACTION, never a cost. */
  ownMove: MovedRow | null;
  /** Everything else that changed slot. */
  moved: MovedRow[];
  /** Booked work that fell off the schedule entirely. Excludes the pin. */
  dropped: string[];
  /** Moved to an earlier day. */
  earlier: number;
  /** Moved to a later day. */
  later: number;
  /**
   * Same crew-day pair reported as a move with delta 0 — a crew swap without a
   * date change. Counted, not bucketed: a zero-width bar is not a bar.
   */
  sameDay: number;
  /** Non-zero deltas, ascending. Drives the distribution bars. */
  buckets: ImpactBucket[];
  /** Largest bucket count, so bars can be scaled without a second pass. */
  maxBucket: number;
  /** Percent change in risk-weighted wait, rounded. Null when unmeasurable. */
  waitDeltaPct: number | null;
  /** True when approving displaces nothing at all. */
  costsNothing: boolean;
}

const EMPTY: ImpactSummary = {
  ownMove: null,
  moved: [],
  dropped: [],
  earlier: 0,
  later: 0,
  sameDay: 0,
  buckets: [],
  maxBucket: 0,
  waitDeltaPct: null,
  costsNothing: true,
};

export function summarizeImpact(
  preview: OverridePreview | null | undefined,
  ownTowerId: string,
): ImpactSummary {
  if (!preview) return EMPTY;

  let ownMove: MovedRow | null = null;
  const moved: MovedRow[] = [];
  for (const m of preview.moved) {
    const row: MovedRow = {
      tower_id: m.tower_id,
      from: m.from,
      to: m.to,
      delta_days: m.delta_days,
    };
    if (m.tower_id === ownTowerId) ownMove = row;
    else moved.push(row);
  }

  const dropped = preview.dropped.filter((id) => id !== ownTowerId);

  let earlier = 0;
  let later = 0;
  let sameDay = 0;
  const byDelta = new Map<number, number>();
  for (const m of moved) {
    if (m.delta_days < 0) earlier += 1;
    else if (m.delta_days > 0) later += 1;
    else {
      sameDay += 1;
      continue; // a zero-width bar carries no length to read
    }
    byDelta.set(m.delta_days, (byDelta.get(m.delta_days) ?? 0) + 1);
  }

  const buckets = [...byDelta.entries()]
    .map(([delta, count]) => ({ delta, count }))
    .sort((a, b) => a.delta - b.delta);
  const maxBucket = buckets.reduce((max, b) => (b.count > max ? b.count : max), 0);

  // Guarded against a zero baseline rather than allowed to produce Infinity:
  // an empty board has nothing to be a percentage OF, and "+Infinity%" beside
  // an Approve button is worse than saying nothing.
  const before = preview.risk_weighted_wait_before;
  const waitDeltaPct =
    before > 0 ? Math.round(((preview.risk_weighted_wait_after - before) / before) * 100) : null;

  return {
    ownMove,
    moved,
    dropped,
    earlier,
    later,
    sameDay,
    buckets,
    maxBucket,
    waitDeltaPct,
    costsNothing: moved.length === 0 && dropped.length === 0,
  };
}

/**
 * The one-line cost of a candidate, for the crew row that offers it.
 *
 * Deliberately two facts and no verdict. Ranking candidates by "best" would
 * hide that the cheapest plan can be the wrong dispatch — the nearest crew
 * carries the SLA, and the planner holds information the solver does not
 * (override.py's own "never blocked" contract is the backend half of this).
 */
export function costLabel(summary: ImpactSummary): string {
  const parts: string[] = [];
  if (summary.waitDeltaPct !== null) {
    parts.push(`${summary.waitDeltaPct > 0 ? '+' : ''}${summary.waitDeltaPct}% wait`);
  }
  if (summary.dropped.length > 0) {
    parts.push(`${summary.dropped.length} dropped`);
  } else if (summary.costsNothing) {
    parts.push('displaces nothing');
  } else {
    parts.push(`${summary.moved.length} moved`);
  }
  return parts.join(' · ');
}
