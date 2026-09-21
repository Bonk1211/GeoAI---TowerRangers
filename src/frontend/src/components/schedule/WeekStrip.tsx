import { dayLabel } from '../../lib/scheduleDays';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useTerritoryRun } from '../../state/useTerritoryRun';
import { RESERVE_HATCH_STYLE } from '../../lib/reserveHatch';

/**
 * Day selector for the schedule, driven by run.horizon.
 * Renders one column per horizon entry with booked and reserve load bars.
 */
export function WeekStrip() {
  const selectedDay = useScheduleStore((s) => s.selectedDay);
  const setSelectedDay = useScheduleStore((s) => s.setSelectedDay);
  const { run, crews } = useTerritoryRun();
  const { horizon, entries, reserve } = run;
  const capacity = crews.length;

  return (
    <div
      role="tablist"
      aria-label="Schedule day"
      className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-overlay/10 px-4 py-2"
    >
      {horizon.map((day) => {
        const dayEntries = entries.filter((e) => e.day === day);
        const jobs = dayEntries.length;
        const bookedCrewDays = new Set(dayEntries.map((e) => e.crew_id)).size;
        const reserved = reserve.filter((r) => r.day === day).length;
        const filledPct = capacity > 0 ? Math.min(100, (bookedCrewDays / capacity) * 100) : 0;
        const reservedPct =
          capacity > 0 ? Math.min(100 - filledPct, (reserved / capacity) * 100) : 0;
        const active = day === selectedDay;

        return (
          <button
            key={day}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => setSelectedDay(day)}
            className={`-mb-px flex min-w-[92px] flex-1 flex-col gap-1.5 border-b-2 px-2.5 pb-2 pt-1 text-left transition-colors duration-150 ${
              active
                ? 'border-accent bg-accent/[0.07] text-fg'
                : 'border-transparent text-muted hover:border-overlay/20 hover:bg-overlay/[0.02] hover:text-fg'
            }`}
          >
            <span className="text-ui font-medium">{dayLabel(day)}</span>

            <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-overlay/[0.10]">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 rounded-full bg-accent"
                style={{ width: `${filledPct}%` }}
              />
              {reservedPct > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 opacity-60"
                  style={{ left: `${filledPct}%`, width: `${reservedPct}%`, ...RESERVE_HATCH_STYLE }}
                />
              )}
            </span>

            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-eyebrow">
              <span
                className={`tnum rounded-md px-1.5 py-0.5 ${
                  active ? 'bg-accent/15 text-accent' : 'bg-overlay/[0.06] text-dim'
                }`}
              >
                {jobs} job{jobs === 1 ? '' : 's'}
              </span>
              {reserved > 0 && <span className="tnum text-dim">{reserved} reserve left</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
