/**
 * Day labelling only.
 *
 * A five-day constant used to live here as hardcoded ISO dates while
 * policy.yaml planned over seven. Anything the solver booked on days 6-7
 * rendered in no tab, no column and no move dropdown — scheduled by the
 * backend and invisible in the UI. Days now come from run.horizon. Do not
 * reintroduce a constant here.
 */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
}

export function formatWeekRange(horizon: string[]): string {
  if (!horizon || horizon.length === 0) return '—';
  const start = new Date(horizon[0]);
  const end = new Date(horizon[horizon.length - 1]);
  const startMonth = start.toLocaleDateString('en-GB', { month: 'short' });
  const endMonth = end.toLocaleDateString('en-GB', { month: 'short' });
  const year = start.getFullYear();

  if (startMonth === endMonth) {
    return `${startMonth} ${start.getDate()} – ${end.getDate()}, ${year}`;
  }
  return `${startMonth} ${start.getDate()} – ${endMonth} ${end.getDate()}, ${year}`;
}

export function shiftIsoDate(iso: string, deltaDays: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Today as an ISO date, in the VIEWER'S timezone.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious spelling and is wrong
 * here: it converts to UTC first, so for a planner in Malaysia (UTC+8) every
 * morning before 08:00 local reports yesterday's date. The schedule would open
 * on the previous week for a third of each working day, and "Today" would jump
 * to a day that had already passed. Built from the local components instead.
 */
export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
