import type { Crew, ReserveSlot, ScheduleEntry } from '../api/types';

/**
 * Geometry for the crew-day timeline.
 *
 * Every figure here is read from the solver, not invented. `start_min`,
 * `end_min` and `travel_min` are computed in scheduler/optimize.py from the
 * actual route at the policy's road factor and average speed; this module only
 * turns those minutes into percentages. That distinction is the whole point of
 * the rewrite — the previous grid rendered a hardcoded
 * `['09:00 - 13:00', ...]` array indexed by visit order, so the clock times on
 * screen were decoration that no backend figure backed.
 *
 * Consequently: when an entry carries no clock fields (an older run, or the
 * offline fixture before it is laid out), we do NOT synthesise times. The lane
 * reports `untimed` and the board falls back to sequence order, which is
 * honest about what is known.
 */

/** Standard operational working day: 08:00 to 18:00 (6:00 PM). */
// The axis always draws a full working day, not merely the hours that happen
// to carry work. A board clipped to 08:00-18:00 told the planner nothing about
// the shoulders of the day — an early start or a late finish had nowhere to be
// drawn, and the axis silently redefined "the day" as "when the solver
// scheduled things". The window is wider than any shift so those shoulders are
// visible and reachable by scrolling.
const STANDARD_DAY_START_MIN = 6 * 60;
const STANDARD_DAY_END_MIN = 20 * 60;

/** Axis padding so the first bar does not begin flush against the rail. */
const AXIS_PAD_MIN = 20;

export interface GanttBar {
  entry: ScheduleEntry;
  tower_id: string;
  order: number;
  /** Left edge as a percentage of the axis, for the work block. */
  leftPct: number;
  /** Width of the work block. Never below a floor, so short jobs stay clickable. */
  widthPct: number;
  /** Left edge of the travel connector that precedes this block. */
  travelLeftPct: number;
  travelWidthPct: number;
  travelMin: number;
  startMin: number;
  endMin: number;
  durationMin: number;
}

export interface GanttLane {
  crew: Crew;
  bars: GanttBar[];
  /** Minutes of the shift consumed, travel included — the utilisation numerator. */
  bookedMin: number;
  shiftMin: number;
  /** 0–100, clamped. Null when the crew has no work that day, or when reserved. */
  utilisationPct: number | null;
  /** True when entries exist but carry no solver clock fields. */
  untimed: boolean;
  /** True when this crew still holds a free reserve slot on the day this lane represents. */
  reserved: boolean;
  /**
   * Geometry for the reserve band. Null unless `reserved`. A ReserveSlot marks
   * an entire crew-day held free, not a sub-range of the intraday hour axis —
   * there is no clock time at which "reserved" starts or ends within the day
   * — so this always spans the full axis (`leftPct: 0, widthPct: 100`)
   * regardless of how wide or narrow that axis is. It is a struct rather than
   * a bare boolean so a future partial-day reserve model would not need to
   * change every consumer's shape, but today the only span this module ever
   * produces is the full-width one.
   */
  reserveSpan: { leftPct: number; widthPct: number } | null;
}

export interface GanttAxis {
  startMin: number;
  endMin: number;
  /** Whole-hour ticks inside the axis, for the header rule and gridlines. */
  ticks: number[];
}

export function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function isTimed(e: ScheduleEntry): boolean {
  return typeof e.end_min === 'number' && typeof e.start_min === 'number' && e.end_min > e.start_min;
}

/**
 * The axis is derived from the day's actual work rather than pinned to the
 * policy shift, so a light day is not mostly empty rail. Padded and snapped
 * out to whole hours so the tick labels land on round numbers.
 */
export function buildAxis(entries: ScheduleEntry[]): GanttAxis {
  const timed = entries.filter(isTimed);
  let startMin = STANDARD_DAY_START_MIN;
  let endMin = STANDARD_DAY_END_MIN;

  if (timed.length > 0) {
    const earliest = Math.min(...timed.map((e) => (e.start_min as number) - (e.travel_min ?? 0)));
    const latest = Math.max(...timed.map((e) => e.end_min as number));
    // Span at least 08:00 to 18:00, but expand earlier or later if shifts/travel require it
    startMin = Math.min(STANDARD_DAY_START_MIN, Math.floor((earliest - AXIS_PAD_MIN) / 60) * 60);
    endMin = Math.max(STANDARD_DAY_END_MIN, Math.ceil((latest + AXIS_PAD_MIN) / 60) * 60);
  }

  // Guard against a degenerate axis dividing by zero downstream.
  if (endMin - startMin < 60) endMin = startMin + 60;

  const ticks: number[] = [];
  for (let t = startMin; t <= endMin; t += 60) ticks.push(t);

  return { startMin, endMin, ticks };
}

/**
 * Horizontal scale of the timeline, in CSS pixels per hour.
 *
 * The lanes used to size themselves to whatever width the column happened to
 * have, so an hour was as wide as the viewport allowed and a 30-minute job on
 * a narrow window collapsed to an unreadable sliver. Fixing the scale instead
 * means the board has an intrinsic width (`axisWidthPx`) and overflows into a
 * horizontal scroll when the day is longer than the window — which is what
 * makes a full 06:00-20:00 axis usable at all.
 *
 * 88px/hour puts a one-hour job at 88px and the 30-minute floor at 44px, which
 * is exactly the touch-target minimum MIN_WIDTH_PCT was protecting.
 */
export const PX_PER_HOUR = 88;

/** Intrinsic pixel width of the lane area for an axis. */
export function axisWidthPx(axis: GanttAxis): number {
  return ((axis.endMin - axis.startMin) / 60) * PX_PER_HOUR;
}

/** Minimum bar width so a 30-minute job still clears the 44px touch target. */
const MIN_WIDTH_PCT = 4;

/**
 * `buildLanes` is called once per calendar day, mirroring the convention
 * `entries` already follows (callers filter `run.entries` down to one day
 * before ever reaching this module — see TimelineBoard's `dayEntries`).
 * Unlike `entries`, `reserve` is NOT expected to be pre-filtered by the
 * caller: `buildLanes` takes the day it is laying out via the required `day`
 * parameter and selects the matching `ReserveSlot`s itself, matching on
 * `(crew_id, day)` together. This is deliberate, not merely convenient — a
 * caller that passed `run.reserve` (every day in the horizon) unfiltered
 * would make every crew ever reserved on any day appear reserved on every
 * day rendered, a silently wrong board with no compiler or test signal.
 * Filtering inside the function removes that failure mode structurally: the
 * day is a required input, not a documented precondition on the caller.
 *
 * `day` used to default to `''` only so `GanttBoard.tsx`'s legacy 3-arg call
 * kept compiling; that caller is gone (replaced by `TimelineBoard.tsx`,
 * which always passes `day`), so `day` is now required and the compiler
 * enforces the precondition instead of a comment.
 */
export function buildLanes(
  crews: Crew[],
  entries: ScheduleEntry[],
  axis: GanttAxis,
  day: string,
  reserve: ReserveSlot[] = [],
  shiftHoursDefault = 8,
): GanttLane[] {
  const span = axis.endMin - axis.startMin;
  const pct = (minutes: number) => ((minutes - axis.startMin) / span) * 100;
  const reservedCrewIds = new Set(
    reserve.filter((r) => r.day === day).map((r) => r.crew_id),
  );

  return crews.map((crew) => {
    const own = entries
      .filter((e) => e.crew_id === crew.crew_id)
      .sort((a, b) => a.order - b.order);

    const reserved = reservedCrewIds.has(crew.crew_id);

    const timed = own.filter(isTimed);
    const shiftMin = Math.round((crew.shift_hours || shiftHoursDefault) * 60);

    const bars: GanttBar[] = timed.map((entry) => {
      const startMin = entry.start_min as number;
      const endMin = entry.end_min as number;
      const travelMin = entry.travel_min ?? 0;
      const rawWidth = pct(endMin) - pct(startMin);

      return {
        entry,
        tower_id: entry.tower_id,
        order: entry.order,
        leftPct: pct(startMin),
        widthPct: Math.max(MIN_WIDTH_PCT, rawWidth),
        travelLeftPct: pct(startMin - travelMin),
        travelWidthPct: Math.max(0, pct(startMin) - pct(startMin - travelMin)),
        travelMin,
        startMin,
        endMin,
        durationMin: endMin - startMin,
      };
    });

    // Utilisation counts travel, because a crew driving is a crew unavailable.
    // Measured from the first departure to the last finish rather than summing
    // blocks, so idle gaps inside the day are counted as consumed — which is
    // what a dispatcher means by "how full is that crew".
    let bookedMin = 0;
    if (bars.length > 0) {
      const first = Math.min(...bars.map((b) => b.startMin - b.travelMin));
      const last = Math.max(...bars.map((b) => b.endMin));
      bookedMin = last - first;
    }

    return {
      crew,
      bars,
      bookedMin,
      shiftMin,
      utilisationPct:
        bars.length === 0 || reserved
          ? null
          : Math.min(100, Math.round((bookedMin / shiftMin) * 100)),
      untimed: own.length > 0 && timed.length === 0,
      reserved,
      reserveSpan: reserved ? { leftPct: 0, widthPct: 100 } : null,
    };
  });
}

/**
 * Crew-type glyph. Severity band already carries colour on these bars; type
 * needs a channel that survives without it, so it gets a shape rather than a
 * second hue competing with the band ramp.
 */
export const CREW_TYPE_GLYPH: Record<string, string> = {
  civil: 'M2 11h12M4 11V6l4-3 4 3v5',
  power: 'M9 2 4 9h3l-1 5 5-7H8l1-5Z',
  electrical: 'M3 5h10v6H3zM6 11v3M10 11v3',
  rf: 'M8 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4 3a7 7 0 0 0 0 10M12 3a7 7 0 0 1 0 10',
};
