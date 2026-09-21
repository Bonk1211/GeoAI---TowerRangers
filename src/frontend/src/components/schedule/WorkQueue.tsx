import { useMemo, useRef, useState, useEffect } from 'react';
import { CREWS } from '../../fixtures/crews';
import { splitSiteLabel } from '../../fixtures/schedule';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useSelection } from '../../state/useSelection';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useCrewsQuery } from '../../api/queries';
import { useLiveSchedule } from '../../api/useLiveSchedule';
import { useTicketStore } from '../../state/useTicketStore';
import { crewTypeForFactor } from '../../lib/actions';
import { haversineKm } from '../../lib/geo';
import { dayLabel } from '../../lib/scheduleDays';
import { bandColor, bandInk } from '../../lib/colors';
import { roleTeam } from '../../lib/roleTeams';
import { roleColor, roleInk, tintedChip } from '../../lib/roleColors';
import type { ScheduleEntry, UnscheduledDetail, UnscheduledReason } from '../../api/types';

/**
 * Per-tower blocking reason with stylized badge attributes.
 */
const BLOCKED_BY: Record<UnscheduledReason, { label: string; tone: string }> = {
  no_capacity: { label: 'No capacity', tone: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  past_sla: { label: 'Past SLA', tone: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300' },
  monsoon_blocked: { label: 'Monsoon window', tone: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  no_crew_type: { label: 'No crew type', tone: 'border-gray-500/30 bg-gray-500/10 text-gray-700 dark:text-gray-300' },
  reserved: { label: 'Held as reserve', tone: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  // Coverage, not capacity. Deliberately NOT amber: amber is the "fleet was
  // busy, try another day" colour, and that is the exact wrong thing to tell
  // a planner about a tower nobody can drive to.
  out_of_range: { label: 'Out of depot range', tone: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300' },
  out_of_territory: { label: 'Outside crew territory', tone: 'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300' },
  no_route: { label: 'No road access', tone: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300' },
};

/**
 * Annex C factor glyphs, drawn rather than typed.
 *
 * These were emoji. Emoji render as a different picture on every platform,
 * cannot take the stroke weight the rest of the icon set uses, cannot be
 * recoloured to match the row they sit in, and are announced by screen readers
 * as their CLDR name ("water wave") rather than as the factor. 16x16 paths, to
 * match shell/icons.tsx and the crew-type glyphs in lib/gantt.ts.
 */
const FACTOR_GLYPH: Record<string, string> = {
  flood: 'M1.5 11.5c1.6 0 1.6-1.2 3.2-1.2s1.6 1.2 3.2 1.2 1.6-1.2 3.2-1.2 1.6 1.2 3.2 1.2M1.5 8c1.6 0 1.6-1.2 3.2-1.2S6.3 8 7.9 8s1.6-1.2 3.2-1.2S12.7 8 14.3 8',
  lightning: 'M9 1.5 4 8.8h3.2l-1 5.7 5-7.3H8l1-5.7Z',
  power: 'M6 1.5v4M10 1.5v4M4.5 5.5h7v2.2a3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-3.5-3.5V5.5ZM8 11.2v3.3',
  equipment: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4',
  terrain: 'M1 13h14L10.5 4.5 8 8.8 6 5.5 1 13Z',
};

const FACTOR_FALLBACK = FACTOR_GLYPH.equipment;

function FactorGlyph({ factor }: { factor: string | undefined }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 text-dim"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={factor ? FACTOR_GLYPH[factor] ?? FACTOR_FALLBACK : FACTOR_FALLBACK} />
    </svg>
  );
}

type TabId = 'unscheduled' | 'sla' | 'deferred' | 'pinned';

const TABS: { id: TabId; label: string }[] = [
  { id: 'unscheduled', label: 'Unscheduled' },
  { id: 'sla', label: 'SLA at risk' },
  { id: 'deferred', label: 'Deferred' },
  { id: 'pinned', label: 'Pinned' },
];

interface TableFilters {
  factor: string;
  team: string;
  reason: string;
  operator: string;
}

const DEFAULT_FILTERS: TableFilters = {
  factor: 'all',
  team: 'all',
  reason: 'all',
  operator: 'all',
};

type QueueRow =
  | { kind: 'waiting'; detail: UnscheduledDetail }
  | { kind: 'pinned'; entry: ScheduleEntry };

function isSlaAtRisk(detail: UnscheduledDetail, lastHorizonDay: string | undefined): boolean {
  if (detail.reason === 'past_sla') return true;
  if (!detail.deadline || !lastHorizonDay) return false;
  return detail.deadline <= lastHorizonDay;
}

const PAGE_SIZE = 8;

export function WorkQueue() {
  const [tab, setTab] = useState<TabId>('unscheduled');
  /**
   * Collapsed hides the table and keeps the tab strip, so the queue still
   * reports its counts — which is most of what the strip is for — while giving
   * the timeline back the vertical space. Collapsing to nothing would make the
   * planner reopen it just to learn whether anything is waiting.
   */
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<TableFilters>(DEFAULT_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const filterPopoverRef = useRef<HTMLDivElement>(null);

  const run = useScheduleStore((s) => s.run);
  const select = useScheduleStore((s) => s.select);
  const setViewMode = useScheduleStore((s) => s.setViewMode);
  const selectTower = useSelection((s) => s.selectTower);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const crewsQuery = useCrewsQuery();
  const territory = useScheduleStore((s) => s.territory);
  const { refetch, isLoading } = useLiveSchedule();
  const escalateWorkOrder = useTicketStore((s) => s.escalateWorkOrder);

  const lastHorizonDay = run.horizon.length > 0 ? run.horizon[run.horizon.length - 1] : undefined;

  // Close filter popover on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (filterPopoverRef.current && !filterPopoverRef.current.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    if (filterOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [filterOpen]);

  const pinnedEntries = useMemo(() => run.entries.filter((e) => e.pinned), [run.entries]);
  const slaDetails = useMemo(
    () => run.unscheduled_detail.filter((d) => isSlaAtRisk(d, lastHorizonDay)),
    [run.unscheduled_detail, lastHorizonDay],
  );
  const deferredDetails = useMemo(
    () => run.unscheduled_detail.filter((d) => !isSlaAtRisk(d, lastHorizonDay)),
    [run.unscheduled_detail, lastHorizonDay],
  );

  const counts: Record<TabId, number> = {
    unscheduled: run.unscheduled_detail.length,
    sla: slaDetails.length,
    deferred: deferredDetails.length,
    pinned: pinnedEntries.length,
  };

  const rawRows: QueueRow[] = useMemo(() => {
    switch (tab) {
      case 'unscheduled':
        return run.unscheduled_detail.map((detail) => ({ kind: 'waiting' as const, detail }));
      case 'sla':
        return slaDetails.map((detail) => ({ kind: 'waiting' as const, detail }));
      case 'deferred':
        return deferredDetails.map((detail) => ({ kind: 'waiting' as const, detail }));
      case 'pinned':
        return pinnedEntries.map((entry) => ({ kind: 'pinned' as const, entry }));
      default:
        return [];
    }
  }, [tab, run.unscheduled_detail, slaDetails, deferredDetails, pinnedEntries]);

  // Count how many category filters are actively applied
  const activeFilterCount = useMemo(() => {
    let c = 0;
    if (filters.factor !== 'all') c++;
    if (filters.team !== 'all') c++;
    if (filters.reason !== 'all') c++;
    if (filters.operator !== 'all') c++;
    return c;
  }, [filters]);

  // Combined search + category filters
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();

    return rawRows.filter((row) => {
      const tower_id = row.kind === 'waiting' ? row.detail.tower_id : row.entry.tower_id;
      const tower = towers.find((t) => t.tower_id === tower_id);
      const { operator, site } = splitSiteLabel(tower_id);
      const crewType = row.kind === 'waiting' ? row.detail.crew_type : row.entry.work_order.crew_type;
      const factor = tower?.dominant_factor ?? '';
      const reason = row.kind === 'waiting' ? row.detail.reason : 'pinned';

      // Category filters
      if (filters.factor !== 'all' && factor.toLowerCase() !== filters.factor.toLowerCase()) {
        return false;
      }
      if (filters.team !== 'all' && crewType.toLowerCase() !== filters.team.toLowerCase()) {
        return false;
      }
      if (filters.reason !== 'all' && reason.toLowerCase() !== filters.reason.toLowerCase()) {
        return false;
      }
      if (filters.operator !== 'all' && (!operator || operator.toLowerCase() !== filters.operator.toLowerCase())) {
        return false;
      }

      // Search query
      if (q) {
        const matchesSearch =
          tower_id.toLowerCase().includes(q) ||
          site.toLowerCase().includes(q) ||
          (operator && operator.toLowerCase().includes(q)) ||
          crewType.toLowerCase().includes(q) ||
          factor.toLowerCase().includes(q) ||
          reason.toLowerCase().includes(q);
        if (!matchesSearch) return false;
      }

      return true;
    });
  }, [rawRows, search, filters, towers]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, currentPage]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refetch();
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  };

  /**
   * Promote one waiting work order to a ticket by hand.
   *
   * Goes through the same escalateWorkOrder() the automatic path uses, so a
   * manually raised ticket is indistinguishable from an escalated one and
   * inherits the same dedup — pressing this twice on the same row raises one
   * ticket, not two. Unlike the automatic path it does NOT set the Assignee
   * Agent: a planner raising a record deliberately gets to decide whether it
   * goes to Schedule, and silently starting an approval flow they did not ask
   * for would be the surprising half of a two-purpose button.
   */
  const raiseTicket = (tower_id: string, detail: UnscheduledDetail) => {
    const tower = towers.find((t) => t.tower_id === tower_id);
    if (!tower) return;
    escalateWorkOrder({
      tower,
      deadline: detail.deadline,
      reason: detail.reason.replace(/_/g, ' '),
      // The same predicate the SLA-at-risk tab and useRiskEscalation apply.
      // A hand-raised deferred row must not claim its deadline is in danger.
      atRisk: isSlaAtRisk(detail, lastHorizonDay),
    });
  };

  const routeToOperator = (tower_id: string) => {
    selectTower(tower_id);
    const tower = towers.find((t) => t.tower_id === tower_id);
    const crews = (crewsQuery.data ?? CREWS).filter((c) => c.territory === territory);
    const wantedType = tower ? crewTypeForFactor(tower.dominant_factor) : 'civil';
    const byDistance = tower
      ? [...crews].sort((a, b) => haversineKm(a.depot, tower) - haversineKm(b.depot, tower))
      : crews;
    const crew = byDistance.find((c) => c.crew_type === wantedType) ?? byDistance[0];
    if (!crew) return;

    const loadByDay = run.horizon.map((day) => ({
      day,
      count: run.entries.filter((e) => e.crew_id === crew.crew_id && e.day === day).length,
    }));
    if (loadByDay.length === 0) return;
    const day = loadByDay.sort((a, b) => a.count - b.count)[0].day;

    setViewMode('tower');
    select({ kind: 'emergency', tower_id, day });
  };

  const viewPinned = (entry: ScheduleEntry) => {
    selectTower(entry.tower_id);
    setViewMode('crew');
    select({ kind: 'job', crew_id: entry.crew_id, day: entry.day, tower_id: entry.tower_id });
  };

  return (
    <div className="glass-raised glass-sheen flex shrink-0 flex-col border-x-0 border-b-0 px-5 py-2.5 shadow-sm">
      {/* Top Controls Bar: Tabs on Left + Search, Filter & Refresh on Right */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 ${
          collapsed ? '' : 'border-b border-overlay/10 pb-2'
        }`}
      >
        {/* Tab Selection */}
        <div role="tablist" aria-label="Work queue" className="flex items-center gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setTab(t.id);
                  setPage(1);
                }}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-ui font-medium transition-all duration-150 ${
                  active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-overlay/[0.06] hover:text-fg'
                }`}
              >
                {t.label}
                <span
                  className={`tnum rounded-md px-1.5 py-0.5 text-eyebrow font-medium ${
                    active ? 'bg-accent/15 text-accent' : 'bg-overlay/[0.06] text-dim'
                  }`}
                >
                  {counts[t.id]}
                </span>
              </button>
            );
          })}
          {/* THE VERDICT, NEXT TO THE COUNT THAT NEEDS ONE.
              "Unscheduled 62" is the largest number on the schedule tab and
              it reads as 62 problems. It is not: every one of these is
              preventive work the model raised, and what decides whether any
              of it is urgent is whether its deadline falls inside the week on
              screen. Measured on a live run: 62 unscheduled, 0 of them due
              this week. Leaving the reader to infer that from a '0' on a tab
              they have to notice is how a healthy board gets read as a
              failing one. */}
          {counts.unscheduled > 0 && (
            <span
              className={`ml-1 shrink-0 rounded-md border px-2 py-0.5 text-eyebrow font-semibold ${
                counts.sla > 0
                  ? 'border-alert/35 bg-alert/[0.09] text-alert-ink'
                  : 'border-ok/30 bg-ok/[0.08] text-ok-ink'
              }`}
            >
              {counts.sla > 0
                ? `${counts.sla} due this week`
                : 'None due this week'}
            </span>
          )}
        </div>

        {/* Right side: Search Bar + Filter Popover + Refresh Button */}
        <div className="flex items-center gap-2">
          {/* Search Box */}
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
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search queue..."
              aria-label="Search work queue"
              className="h-7 w-40 sm:w-52 rounded-lg border border-overlay/15 bg-white/70 dark:bg-ink-900/70 pl-8 pr-7 text-ui text-fg placeholder:text-muted focus:border-accent/60 focus:bg-white focus:outline-none transition-all shadow-2xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2 text-muted hover:text-fg"
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Functional Category Filter Button & Popover */}
          <div className="relative" ref={filterPopoverRef}>
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              aria-expanded={filterOpen}
              aria-label="Filter by category"
              className={`flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-micro font-medium transition-all duration-150 shadow-2xs ${
                activeFilterCount > 0
                  ? 'border-accent/50 bg-accent/15 text-accent font-semibold'
                  : 'border-overlay/15 bg-white/70 dark:bg-ink-900/70 text-muted hover:bg-white hover:text-fg'
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              <span>Filter</span>
              {activeFilterCount > 0 && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white text-[9px] font-bold">
                  {activeFilterCount}
                </span>
              )}
            </button>

            {/* Filter Popover Dropdown */}
            {filterOpen && (
              <div className="absolute right-0 top-9 z-40 w-72 rounded-2xl border border-overlay/15 bg-white/95 dark:bg-ink-950/95 p-3.5 shadow-2xl backdrop-blur-2xl transition-all">
                <div className="flex items-center justify-between border-b border-overlay/10 pb-2 mb-2.5">
                  <span className="text-ui font-semibold text-fg">Column Filters</span>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setFilters(DEFAULT_FILTERS)}
                      className="text-micro text-accent hover:underline font-medium"
                    >
                      Reset all
                    </button>
                  )}
                </div>

                <div className="space-y-2.5 text-ui">
                  {/* Dominant Factor Filter */}
                  <div>
                    <label className="text-eyebrow text-dim block mb-1 font-medium">Risk Factor</label>
                    <select
                      value={filters.factor}
                      onChange={(e) => {
                        setFilters((prev) => ({ ...prev, factor: e.target.value }));
                        setPage(1);
                      }}
                      className="w-full h-7 rounded-lg border border-overlay/15 bg-white/80 dark:bg-ink-900/80 px-2 text-micro text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="all">All Factors</option>
                      <option value="flood">🌊 Flood</option>
                      <option value="lightning">⚡ Lightning</option>
                      <option value="power">🔌 Power</option>
                      <option value="equipment">⚙️ Equipment</option>
                      <option value="terrain">🏔️ Terrain</option>
                    </select>
                  </div>

                  {/* Required Team Filter */}
                  <div>
                    <label className="text-eyebrow text-dim block mb-1 font-medium">Required Team</label>
                    <select
                      value={filters.team}
                      onChange={(e) => {
                        setFilters((prev) => ({ ...prev, team: e.target.value }));
                        setPage(1);
                      }}
                      className="w-full h-7 rounded-lg border border-overlay/15 bg-white/80 dark:bg-ink-900/80 px-2 text-micro text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="all">All Teams</option>
                      <option value="civil">Civil</option>
                      <option value="power">Power</option>
                      <option value="rf">RF</option>
                      <option value="electrical">Electrical</option>
                    </select>
                  </div>

                  {/* Blocking Reason Filter */}
                  <div>
                    <label className="text-eyebrow text-dim block mb-1 font-medium">Status / Blocked Reason</label>
                    <select
                      value={filters.reason}
                      onChange={(e) => {
                        setFilters((prev) => ({ ...prev, reason: e.target.value }));
                        setPage(1);
                      }}
                      className="w-full h-7 rounded-lg border border-overlay/15 bg-white/80 dark:bg-ink-900/80 px-2 text-micro text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="all">All Statuses</option>
                      <option value="no_capacity">No capacity</option>
                      <option value="out_of_range">Out of depot range</option>
                      <option value="out_of_territory">Outside crew territory</option>
                      <option value="no_route">No road access</option>
                      <option value="past_sla">Past SLA</option>
                      <option value="monsoon_blocked">Monsoon window</option>
                      <option value="reserved">Held as reserve</option>
                    </select>
                  </div>

                  {/* Operator Filter */}
                  <div>
                    <label className="text-eyebrow text-dim block mb-1 font-medium">Operator</label>
                    <select
                      value={filters.operator}
                      onChange={(e) => {
                        setFilters((prev) => ({ ...prev, operator: e.target.value }));
                        setPage(1);
                      }}
                      className="w-full h-7 rounded-lg border border-overlay/15 bg-white/80 dark:bg-ink-900/80 px-2 text-micro text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="all">All Operators</option>
                      <option value="Operator A">Operator A</option>
                      <option value="Operator B">Operator B</option>
                      <option value="Operator C">Operator C</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading || isRefreshing}
            title="Refresh work queue and optimizer schedule"
            aria-label="Refresh schedule"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-overlay/15 bg-white/70 dark:bg-ink-900/70 text-muted transition-all duration-150 hover:border-overlay/30 hover:bg-white hover:text-fg disabled:opacity-40 shadow-2xs"
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-3.5 w-3.5 ${isRefreshing || isLoading ? 'animate-spin text-accent' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
          </button>

          {/* Collapse toggle. The chevron points the way the panel will move,
              which is the only rotation that reads correctly in both states. */}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-controls="work-queue-body"
            title={collapsed ? 'Expand work queue' : 'Collapse work queue to give the calendar more room'}
            aria-label={collapsed ? 'Expand work queue' : 'Collapse work queue'}
            className="glass-field flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:text-fg"
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-3.5 w-3.5 transition-transform duration-200 ${collapsed ? '' : 'rotate-180'}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 15l6-6 6 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Table Section with Sticky Frozen Category Header Row */}
      <div
        id="work-queue-body"
        hidden={collapsed}
        className="scroll-thin mt-2 max-h-56 overflow-y-auto overflow-x-auto rounded-lg border border-overlay/10 bg-white/40 dark:bg-ink-950/40"
      >
        {filteredRows.length === 0 ? (
          <div className="py-8 text-center text-ui text-dim">
            {search || activeFilterCount > 0 ? 'No items found matching the current search or filters.' : 'Nothing in this view.'}
          </div>
        ) : (
          <table className="w-full min-w-[800px] border-collapse text-ui text-left">
            {/* Frozen / Sticky Header Row */}
            <thead className="sticky top-0 z-10 bg-ink-800/85 backdrop-blur-md">
              <tr className="eyebrow border-b border-overlay/15 text-dim">
                <th className="py-2 pl-3.5 pr-2 font-semibold">
                  Site / Subject
                </th>
                <th className="py-2 pr-2 font-semibold">
                  Operator
                </th>
                <th className="py-2 pr-2 font-semibold">
                  Factor / Intervention
                </th>
                <th className="py-2 pr-2 font-semibold">
                  Risk
                </th>
                <th className="py-2 pr-2 font-semibold">
                  Team
                </th>
                <th className="py-2 pr-2 font-semibold">
                  SLA Due
                </th>
                <th className="py-2 pr-2 font-semibold">
                  Status / Blocked by
                </th>
                <th className="py-2 pr-3 text-right font-semibold">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-overlay/[0.06]">
              {pagedRows.map((row) => {
                const tower_id = row.kind === 'waiting' ? row.detail.tower_id : row.entry.tower_id;
                const tower = towers.find((t) => t.tower_id === tower_id);
                const { operator, site } = splitSiteLabel(tower_id);
                const crewType = row.kind === 'waiting' ? row.detail.crew_type : row.entry.work_order.crew_type;
                const team = roleTeam(crewType);
                const due =
                  row.kind === 'waiting'
                    ? row.detail.deadline
                      ? dayLabel(row.detail.deadline)
                      : '—'
                    : dayLabel(row.entry.day);
                const blockedMeta =
                  row.kind === 'waiting'
                    ? BLOCKED_BY[row.detail.reason] ?? { label: row.detail.reason, tone: 'border-overlay/15 bg-overlay/5 text-muted' }
                    : { label: 'Pinned Override', tone: 'border-accent/30 bg-accent/10 text-accent font-medium' };

                const spine = tower ? bandColor(tower.decision) : 'transparent';
                const rowKey =
                  row.kind === 'waiting'
                    ? `waiting-${tower_id}`
                    : `pinned-${row.entry.crew_id}-${row.entry.day}-${tower_id}`;

                // The row's own activation. It used to light the site name on
                // hover and do nothing when pressed — an affordance that lies.
                // Selecting the tower is the non-destructive half of what the
                // action button does, so the row can carry it safely: reading
                // a row should never re-solve the board.
                const activate = () => selectTower(tower_id);

                return (
                  <tr
                    key={rowKey}
                    onClick={activate}
                    onKeyDown={(e) => {
                      // A <tr> is not natively focusable or activatable, so
                      // the keyboard contract has to be written out: Enter and
                      // Space, matching what a button would do.
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        activate();
                      }
                    }}
                    tabIndex={0}
                    aria-label={`${site}, risk ${tower ? tower.risk.toFixed(2) : 'unknown'}, ${blockedMeta.label}`}
                    className="spine group cursor-pointer border-b border-overlay/[0.06] transition-colors duration-100 last:border-b-0 hover:bg-accent/[0.04] focus-visible:bg-accent/[0.06]"
                    style={{ '--spine': spine } as React.CSSProperties}
                  >
                    {/* Identity. The id was a chip beside the name, competing
                        with it at the same size on the same line; it is a
                        lookup key, not a second title, so it drops to a
                        secondary line in the mono face. */}
                    <td className="py-2 pl-3.5 pr-2">
                      <div className="flex flex-col">
                        <span className="font-semibold text-fg transition-colors group-hover:text-accent">
                          {site}
                        </span>
                        <span className="font-mono text-eyebrow text-dim">{tower_id}</span>
                      </div>
                    </td>

                    {/* Operator */}
                    <td className="py-2 pr-2 text-dim">{operator ?? '—'}</td>

                    {/* Dominant Factor */}
                    <td className="py-2 pr-2">
                      <div className="flex items-center gap-1.5 capitalize text-fg">
                        <FactorGlyph factor={tower?.dominant_factor} />
                        <span>{tower?.dominant_factor ?? '—'}</span>
                      </div>
                    </td>

                    {/* Risk. The one figure in the table, so it carries the
                        band ramp at full strength — ink on a band wash inside
                        a band-edged chip, the same construction the calendar
                        bars and the map console's band chip use. */}
                    <td className="py-2 pr-2">
                      <span
                        className="tnum inline-flex items-center rounded border px-1.5 py-0.5 text-micro font-semibold"
                        style={
                          tower
                            ? {
                                color: bandInk(tower.decision),
                                backgroundColor: `${bandColor(tower.decision)}1a`,
                                borderColor: `${bandColor(tower.decision)}59`,
                              }
                            : undefined
                        }
                      >
                        {tower ? tower.risk.toFixed(2) : '—'}
                      </span>
                    </td>

                    {/* Required team, in the same role hue the calendar's
                        group headers and crew rails use — so "Civil" here and
                        the Civil group up there are recognisably one thing. */}
                    <td className="py-2 pr-2">
                      <span
                        className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-micro font-medium"
                        style={tintedChip(roleColor(crewType), roleInk(crewType), '14', '3d')}
                      >
                        {team?.label ?? crewType}
                      </span>
                    </td>

                    {/* SLA Due */}
                    <td className="tnum py-2 pr-2 text-dim font-medium">{due}</td>

                    {/* Blocked by / Status badge */}
                    <td className="py-2 pr-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-micro font-medium ${blockedMeta.tone}`}>
                        {blockedMeta.label}
                      </span>
                    </td>

                    {/* Action button */}
                    <td className="py-2 pr-3 text-right">
                      {/* stopPropagation: the row is activatable now, and
                          without this a press on the button would also fire
                          the row's own handler. */}
                      {row.kind === 'waiting' ? (
                        <div className="flex items-center justify-end gap-1.5">
                        {/* Manual promotion, beside the automatic one.
                            useRiskEscalation raises a ticket only when a job
                            is at SLA risk, which is deliberately a small set.
                            A planner who judges some other deferred job needs
                            a formal owner — a site they know is worse than its
                            score says — should not have to file it by hand
                            from the Tickets tab and retype what the row
                            already knows. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            raiseTicket(tower_id, row.detail);
                          }}
                          title={`Raise a ticket for ${site} from this work order`}
                          className="glass-field rounded-lg px-2.5 py-1 text-micro font-medium text-dim transition-colors duration-150 hover:text-accent"
                        >
                          Raise ticket
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            routeToOperator(tower_id);
                          }}
                          /* "Route" undersold this. routeToOperator resolves
                             the crew type from the dominant factor, sorts the
                             territory's crews by depot distance to the tower,
                             takes the nearest of the right type, then picks
                             that crew's lightest day in the horizon and opens
                             a dispatch there. The label says what it does to
                             the schedule; the title says how it chooses. */
                          title={`Dispatch ${site} to the nearest ${team?.label ?? crewType} crew, on their lightest day this week`}
                          className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-micro font-semibold text-accent shadow-2xs transition-colors duration-150 hover:bg-accent hover:text-white"
                        >
                          Dispatch
                        </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            viewPinned(row.entry);
                          }}
                          title={`Show ${site} on the calendar — ${row.entry.crew_id}, ${dayLabel(row.entry.day)}`}
                          className="glass-field rounded-lg px-2.5 py-1 text-micro font-medium text-dim transition-colors duration-150 hover:text-accent"
                        >
                          Show on board
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination & Summary Footer (matching reference design < 1 - 50 of 350 >).
          Hidden with the table it paginates — a page control for a table that
          is not on screen is a control with nothing to do. */}
      <div
        hidden={collapsed}
        className="flex items-center justify-between border-t border-overlay/8 pt-2 text-micro text-dim"
      >
        <span>
          Showing {filteredRows.length > 0 ? (currentPage - 1) * PAGE_SIZE + 1 : 0}–
          {Math.min(currentPage * PAGE_SIZE, filteredRows.length)} of {filteredRows.length} items
        </span>

        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              aria-label="Previous page"
              className="flex h-6 w-6 items-center justify-center rounded border border-overlay/12 bg-white/60 text-muted hover:bg-white hover:text-fg disabled:opacity-30"
            >
              ‹
            </button>
            <span className="px-1 text-fg font-medium">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              aria-label="Next page"
              className="flex h-6 w-6 items-center justify-center rounded border border-overlay/12 bg-white/60 text-muted hover:bg-white hover:text-fg disabled:opacity-30"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
