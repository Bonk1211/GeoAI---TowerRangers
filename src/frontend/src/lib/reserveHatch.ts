import type { CSSProperties } from 'react';

/**
 * Shared hatch pattern for "this capacity is deliberately held open."
 *
 * `run.reserve` is still-free capacity a crew-day is holding open, not a
 * consumed quota — the reserve treatment marks protected *absence*, so it
 * must carry neither a band colour (severity) nor the accent
 * (chrome/control identity). A `repeating-linear-gradient` over the neutral
 * `overlay` token is the only mark that says "held clear" without
 * accidentally saying "risk" or "control."
 *
 * Four consumers draw from this single definition: `ReserveBand.tsx` (the
 * timeline's full-width reserve band), `ReserveDetail.tsx`, `WeekStrip.tsx`
 * (the reserve-remaining segment of its day-load meter), and
 * `ScheduleGridByTower.tsx` (the reserve marker in its day-column header).
 * A duplicate of this pattern used to live hardcoded in WeekStrip alone.
 */
export const RESERVE_HATCH_STYLE: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(45deg, var(--color-overlay) 0 3px, transparent 3px 6px)',
};
