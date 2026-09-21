import { useEffect } from 'react';
import { TimelineBoard } from '../components/schedule/TimelineBoard';
import { WeekStrip } from '../components/schedule/WeekStrip';
import { ScheduleGridByTower } from '../components/schedule/ScheduleGridByTower';
import { WorkQueue } from '../components/schedule/WorkQueue';
import { ViewToggle } from '../components/schedule/ViewToggle';
import { ZoomControl } from '../components/schedule/ZoomControl';
import { TerritorySelect } from '../components/schedule/TerritorySelect';
import { DetailPanel } from '../components/schedule/DetailPanel';
import { AgentDock } from '../components/schedule/AgentDock';
import { PageHeader, Button } from '../components/ui/Panel';
import { useScheduleStore } from '../state/useScheduleStore';
import { useScheduleSelection } from '../state/useScheduleSelection';
import { useLiveSchedule } from '../api/useLiveSchedule';
import { useRiskEscalation } from '../state/useRiskEscalation';
import { useAutoDispatch } from '../state/useAutoDispatch';

import { DateNavigator } from '../components/schedule/DateNavigator';
import { CalendarFilter } from '../components/schedule/CalendarFilter';

export function Schedule() {
  // Closes the risk-model -> ticket -> schedule loop on the page that owns
  // the run. Escalation raises the ticket and sets its agent; useAutoDispatch
  // turns that into schedule_pending, which is what the Ranger dock's
  // approval strip watches. It is mounted here as well as on Tickets because
  // the flag has to be set on whichever page the escalation happened on —
  // otherwise an escalation raised while looking at the schedule would sit
  // inert until someone happened to open the Tickets tab. Both hooks are
  // idempotent and only ever touch the ticket store, so the double mount
  // costs nothing (routes render one at a time in any case).
  useRiskEscalation();
  useAutoDispatch();
  const viewMode = useScheduleStore((s) => s.viewMode);
  const select = useScheduleStore((s) => s.select);
  const offlineRun = useScheduleStore((s) => s.offlineRun);
  const offlineUnpinAll = useScheduleStore((s) => s.offlineUnpinAll);
  const setRun = useScheduleStore((s) => s.setRun);
  const highlightedTowerId = useScheduleSelection((s) => s.highlightedTowerId);
  const setHighlightedTower = useScheduleSelection((s) => s.setHighlightedTower);
  const searchQuery = useScheduleStore((s) => s.searchQuery);
  const setSearchQuery = useScheduleStore((s) => s.setSearchQuery);
  const { run, isLoading } = useLiveSchedule();

  // Sync the live (or offline-fallback) run into the store so all schedule
  // child components (TimelineBoard, ScheduleGridByTower, WhySlotPanel,
  // etc.) can access it via useScheduleStore without any prop-drilling.
  useEffect(() => {
    if (!isLoading) setRun(run);
  }, [run, isLoading, setRun]);

  useEffect(() => {
    if (!highlightedTowerId) return;
    const entry = run.entries.find((e) => e.tower_id === highlightedTowerId);
    if (entry) select({ kind: 'job', crew_id: entry.crew_id, day: entry.day, tower_id: entry.tower_id });
    setHighlightedTower(null);
  }, [highlightedTowerId, run.entries, select, setHighlightedTower]);

  // Only show initial splash when there is no schedule data at all on initial startup.
  // Subsequent week changes, refetches, and overrides keep the UI mounted with smooth in-place transitions.
  if (isLoading && !run.run_id && !offlineRun) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          leftContent={
            <div className="flex items-center gap-2">
              <DateNavigator />
            </div>
          }
        />
        <div className="flex flex-1 items-center justify-center text-body text-muted">
          <div className="flex items-center gap-2.5">
            <svg className="h-4 w-4 animate-spin text-accent" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <span>Loading schedule…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* National, not Sunway: the optimizer now packs the maintain band of
          all 1,164 towers against the 30 crews in config/crews.json, which
          roster all 16 territories. More work than fits is the normal result
          and comes back in `unscheduled` rather than being dropped. */}
      <PageHeader
        leftContent={
          <div className="flex flex-wrap items-center gap-2">
            <DateNavigator />
            <div className="relative flex items-center">
              <svg
                viewBox="0 0 24 24"
                className="absolute left-2.5 h-3.5 w-3.5 text-muted pointer-events-none"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="Search timeline..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="glass-field h-8 w-48 rounded-lg pl-8 pr-7 text-ui text-fg placeholder:text-dim focus:outline-none sm:w-56"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear timeline search"
                  className="absolute right-2 text-muted hover:text-fg"
                >
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <CalendarFilter />
          </div>
        }
      >
        <ZoomControl />
        <ViewToggle />
        <TerritorySelect />
        {offlineRun && (
          <Button onClick={offlineUnpinAll}>Unpin all</Button>
        )}
      </PageHeader>

      <div className="flex min-h-0 flex-1 relative">
        {/* Subtle top hairline loading indicator during background refetches/date shifts */}
        {isLoading && (
          <div className="absolute top-0 inset-x-0 z-30 h-[2px] overflow-hidden bg-accent/20">
            <div className="h-full w-full bg-gradient-to-r from-violet-500 via-indigo-500 to-purple-500 animate-pulse" />
          </div>
        )}

        <div className={`relative flex min-w-0 flex-1 flex-col transition-opacity duration-200 ${isLoading ? 'opacity-90' : 'opacity-100'}`}>
          <WeekStrip />

          {/* The dock is anchored to THIS wrapper — the calendar area — rather
              than to the viewport, so it can never cover the work queue's
              controls below it (which is what made the collapsed queue
              impossible to reopen). */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {viewMode === 'crew' ? <TimelineBoard /> : <ScheduleGridByTower />}
            </div>

            <AgentDock />
          </div>

          <WorkQueue />
        </div>

        {/* Outside the column, so the panel stands beside the work queue as
            well as the calendar and stays full height however the queue is
            sized. */}
        <DetailPanel />
      </div>
    </div>
  );
}
