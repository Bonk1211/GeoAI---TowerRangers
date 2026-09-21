import { useState } from 'react';
import { formatWeekRange, shiftIsoDate, todayIso } from '../../lib/scheduleDays';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useTerritoryRun } from '../../state/useTerritoryRun';
import { useLiveSchedule } from '../../api/useLiveSchedule';

/**
 * Top header Date Navigator:
 *   [ ◀ ] [ 📅 Aug 17 – 23, 2026 ] [ ▶ ] [ Today ]
 *
 * Placed in the PageHeader so planners can shift weeks and pick dates
 * without consuming vertical space in the schedule grid.
 */
export function DateNavigator() {
  const currentWeekStart = useScheduleStore((s) => s.currentWeekStart);
  const { run } = useTerritoryRun();
  const { refetch, isLoading } = useLiveSchedule();
  const { horizon } = run;

  // Real-world system date, in the viewer's timezone — see todayIso() for why
  // toISOString() is the wrong call here.
  const realTodayIso = todayIso();
  const isRealToday = currentWeekStart === realTodayIso;
  const isDemoWeek = currentWeekStart === '2026-08-17';

  const [dateInputVal, setDateInputVal] = useState(currentWeekStart);

  const handlePrevWeek = () => {
    const prev = shiftIsoDate(currentWeekStart, -7);
    setDateInputVal(prev);
    void refetch(prev);
  };

  const handleNextWeek = () => {
    const next = shiftIsoDate(currentWeekStart, 7);
    setDateInputVal(next);
    void refetch(next);
  };

  const handleToday = () => {
    // Syncs directly with real-world current date & month
    setDateInputVal(realTodayIso);
    void refetch(realTodayIso);
  };

  const handleDemoWeek = () => {
    const demoDate = '2026-08-17';
    setDateInputVal(demoDate);
    void refetch(demoDate);
  };

  const handleCustomDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val) {
      setDateInputVal(val);
      void refetch(val);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {/* Previous Week */}
      <button
        type="button"
        onClick={handlePrevWeek}
        disabled={isLoading}
        title="Previous week"
        aria-label="Previous week"
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-overlay/12 bg-white/70 dark:bg-ink-900/70 text-muted transition-all duration-150 hover:border-overlay/30 hover:bg-white hover:text-fg disabled:opacity-40 shadow-2xs active:scale-95"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Formatted Date Range Pill with calendar picker */}
      <div className="relative flex h-8 items-center gap-1.5 rounded-lg border border-overlay/15 bg-white/80 dark:bg-ink-900/80 px-2.5 text-ui font-medium text-fg shadow-2xs hover:border-accent/40 transition-colors">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="tracking-tight font-semibold text-ui">{formatWeekRange(horizon)}</span>

        {isLoading && (
          <svg className="h-3 w-3 animate-spin text-accent ml-1" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
        )}

        {/* Hidden native date input for direct calendar picking */}
        <input
          type="date"
          value={dateInputVal}
          onChange={handleCustomDateChange}
          title="Pick any date from calendar"
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </div>

      {/* Next Week */}
      <button
        type="button"
        onClick={handleNextWeek}
        disabled={isLoading}
        title="Next week"
        aria-label="Next week"
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-overlay/12 bg-white/70 dark:bg-ink-900/70 text-muted transition-all duration-150 hover:border-overlay/30 hover:bg-white hover:text-fg disabled:opacity-40 shadow-2xs active:scale-95"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Today Button (Real-World System Date) */}
      <button
        type="button"
        onClick={handleToday}
        disabled={isLoading || isRealToday}
        title={`Jump to today's real date (${realTodayIso})`}
        className="h-8 rounded-lg border border-overlay/12 bg-white/70 dark:bg-ink-900/70 px-2.5 text-micro font-medium text-fg transition-all duration-150 hover:border-accent/40 hover:bg-accent/10 hover:text-accent disabled:opacity-40 shadow-2xs active:scale-95"
      >
        Today
      </button>

      {/* Demo Flood Week Quick Button */}
      {!isDemoWeek && (
        <button
          type="button"
          onClick={handleDemoWeek}
          disabled={isLoading}
          title="Jump to flood simulation demo week (Aug 17, 2026)"
          className="h-8 rounded-lg border border-accent/30 bg-accent/10 px-2.5 text-micro font-medium text-accent transition-all duration-150 hover:bg-accent hover:text-white shadow-2xs active:scale-95"
        >
          Demo Week
        </button>
      )}
    </div>
  );
}
