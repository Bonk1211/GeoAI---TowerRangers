interface TimelineStripProps {
  scheduledDate?: string; // ISO date
  urgencyDays: number;
  today?: Date;
}

const MS_PER_DAY = 86_400_000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function fmt(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function nextMonsoonStart(from: Date): Date {
  const year = from.getMonth() >= 10 ? from.getFullYear() : from.getFullYear();
  const candidate = new Date(year, 10, 1); // Nov 1
  return candidate >= from ? candidate : new Date(year + 1, 10, 1);
}

export function TimelineStrip({ scheduledDate, urgencyDays, today = new Date() }: TimelineStripProps) {
  const due = addDays(today, urgencyDays);
  const monsoon = nextMonsoonStart(today);
  const scheduled = scheduledDate ? new Date(scheduledDate) : undefined;

  const span = due.getTime() - today.getTime() || 1;
  const pct = (d: Date) => Math.min(100, Math.max(0, ((d.getTime() - today.getTime()) / span) * 100));

  return (
    <div className="p-4">
      <h3 className="eyebrow mb-4">Timeline</h3>

      <div className="relative mx-1 h-[3px] rounded-full bg-overlay/10">
        {scheduled && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-accent/60"
            style={{ width: `${pct(scheduled)}%` }}
          />
        )}

        {/* now */}
        <span className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted" />

        {scheduled && (
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-950 bg-accent"
            style={{ left: `${pct(scheduled)}%` }}
          />
        )}

        {/* due */}
        <span
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-maintain"
          style={{ left: '100%' }}
        />
      </div>

      <div className="mt-3 flex items-baseline justify-between text-micro">
        <span className="text-dim">Today</span>
        {scheduled && <span className="tnum text-accent">Visit {fmt(scheduled)}</span>}
        <span className="tnum text-maintain-ink">Due {fmt(due)}</span>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-overlay/10 pt-2.5 text-micro">
        <span className="text-dim">Next monsoon window</span>
        <span className="tnum text-muted">{fmt(monsoon)}</span>
      </div>
    </div>
  );
}
