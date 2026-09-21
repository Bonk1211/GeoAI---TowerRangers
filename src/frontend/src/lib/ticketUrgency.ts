/**
 * Whether a proposed dispatch day actually satisfies the ticket's SLA, and
 * how old the report is.
 *
 * The approval panel asks the planner to prioritise an emergency over booked
 * work without ever showing them the deadline that justifies it. These two
 * figures are the missing half of that decision: a dispatch that lands after
 * the SLA is not a fix, it is a slower miss, and a report filed a week ago is
 * a different kind of urgent from one filed an hour ago.
 */

/**
 * `breach` — the dispatch lands AFTER the deadline.
 * `due`    — it lands exactly on it, with no slack at all.
 * `tight`  — one or two days of slack; a single re-solve can erase it.
 * `ok`     — three or more days of slack.
 * `none`   — the ticket carries no usable deadline. Stated, never assumed met.
 */
export type SlaLevel = 'breach' | 'due' | 'tight' | 'ok' | 'none';

export interface SlaStatus {
  level: SlaLevel;
  /** Whole days of slack. Negative means late. Null when there is no SLA. */
  days: number | null;
  label: string;
}

const DAY_MS = 86_400_000;

/** Midnight UTC for an ISO date or datetime, or null if it will not parse. */
function dayStart(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * @param targetSla   the ticket's deadline (ISO date), or null
 * @param dispatchDay the day the crew would actually attend (ISO date)
 */
export function slaStatus(
  targetSla: string | null | undefined,
  dispatchDay: string,
): SlaStatus {
  const sla = dayStart(targetSla);
  const day = dayStart(dispatchDay);
  // An unparseable deadline is reported as absent rather than guessed at. A
  // wrong deadline is worse than a missing one: it would be used to justify
  // displacing real work.
  if (sla === null || day === null) {
    return { level: 'none', days: null, label: 'No SLA set on this ticket' };
  }
  const days = Math.round((sla - day) / DAY_MS);
  if (days < 0) {
    return { level: 'breach', days, label: `Misses SLA — ${plural(-days, 'day')} late` };
  }
  if (days === 0) return { level: 'due', days, label: 'Lands on the SLA date' };
  if (days <= 2) return { level: 'tight', days, label: `${plural(days, 'day')} inside SLA` };
  return { level: 'ok', days, label: `${plural(days, 'day')} inside SLA` };
}

/** How long ago the report was filed, in the planner's words. */
export function reportedAgeLabel(createdAt: string, now: Date = new Date()): string {
  const created = dayStart(createdAt);
  const today = dayStart(now.toISOString());
  if (created === null || today === null) return 'unknown';
  // A clock skew or a fixture dated in the future must not print "-3 days
  // ago", which reads as a bug rather than as the skew it is.
  const days = Math.max(0, Math.round((today - created) / DAY_MS));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
