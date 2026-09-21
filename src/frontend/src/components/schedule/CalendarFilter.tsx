import { useEffect, useRef, useState } from 'react';
import { useScheduleStore } from '../../state/useScheduleStore';

/**
 * Filter button & popover for the upper Calendar / Timeline section:
 * Allows filtering crew lanes by role team and shift status.
 */
export function CalendarFilter() {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const teamFilter = useScheduleStore((s) => s.calendarTeamFilter);
  const setTeamFilter = useScheduleStore((s) => s.setCalendarTeamFilter);
  const statusFilter = useScheduleStore((s) => s.calendarStatusFilter);
  const setStatusFilter = useScheduleStore((s) => s.setCalendarStatusFilter);

  const activeCount = (teamFilter !== 'all' ? 1 : 0) + (statusFilter !== 'all' ? 1 : 0);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleReset = () => {
    setTeamFilter('all');
    setStatusFilter('all');
  };

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Filter timeline crews"
        className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-micro font-medium transition-colors duration-150 ${
          activeCount > 0
            ? 'border border-accent/50 bg-accent/15 font-semibold text-accent'
            : 'glass-field text-muted hover:text-fg'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        <span>Filter</span>
        {activeCount > 0 && (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white text-[9px] font-bold">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Timeline filters"
          className="glass-menu absolute left-0 top-10 z-40 w-72 rounded-2xl p-3.5"
        >
          <div className="mb-3 flex items-center justify-between border-b border-overlay/10 pb-2">
            <span className="text-ui font-semibold text-fg">Timeline filters</span>
            {activeCount > 0 && (
              <button
                type="button"
                onClick={handleReset}
                className="rounded-md px-1.5 py-0.5 text-micro font-medium text-accent transition-colors duration-150 hover:bg-accent/10"
              >
                Reset
              </button>
            )}
          </div>

          <div className="space-y-3">
            {/* Labels are bound with htmlFor/id rather than wrapping, so the
                helper line can sit between the label and its control without
                falling inside the label's own accessible name. */}
            <div>
              <label htmlFor="filter-capability" className="mb-1 block text-micro font-medium text-fg">
                Crew capability
              </label>
              <select
                id="filter-capability"
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
                className="glass-field h-9 w-full rounded-lg px-2.5 text-ui text-fg focus:outline-none"
              >
                <option value="all">All capabilities</option>
                <option value="civil">Civil</option>
                <option value="power">Power</option>
                <option value="rf">RF</option>
                <option value="electrical">Electrical</option>
              </select>
            </div>

            <div>
              <label htmlFor="filter-shift" className="mb-1 block text-micro font-medium text-fg">
                Shift load
              </label>
              <select
                id="filter-shift"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="glass-field h-9 w-full rounded-lg px-2.5 text-ui text-fg focus:outline-none"
              >
                <option value="all">All shifts</option>
                <option value="booked">With booked jobs</option>
                <option value="reserve">On reserve duty</option>
                <option value="free">Completely free</option>
              </select>
            </div>
          </div>

          {/* Says what the filter will DO, because it dims rather than hides —
              a planner who expects rows to disappear and sees them greyed
              would otherwise read the filter as broken. */}
          <p className="mt-3 border-t border-overlay/10 pt-2 text-micro leading-snug text-dim">
            {activeCount > 0
              ? 'Crews outside the filter stay on the board, dimmed.'
              : 'Filters dim non-matching crews rather than hiding them, so the board keeps its shape.'}
          </p>
        </div>
      )}
    </div>
  );
}
