import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { placeName } from '../../fixtures/schedule';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useTerritoryRun } from '../../state/useTerritoryRun';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { PX_PER_HOUR, buildAxis, buildLanes, clockLabel, type GanttLane } from '../../lib/gantt';
import { ROLE_TEAMS } from '../../lib/roleTeams';
import { RAIL, RoleGroup } from './RoleGroup';

/**
 * The crew day, drawn on an hour axis and grouped by capability.
 *
 * Replaces the flat per-crew list `GanttBoard` drew. Every figure on screen —
 * bar position, bar width, the travel gap between two bars, the utilisation
 * percentage — resolves to `start_min` / `end_min` / `travel_min` computed by
 * scheduler/optimize.py against the real route; this component only turns
 * those minutes into percentages (via `lib/gantt.ts`) and lays the result out
 * under a role header.
 *
 * Grouping by `crew.crew_type` (civil / power / rf / electrical, the
 * `ROLE_TEAMS` order) is what makes the Annex C → crew-type mapping legible:
 * on the Sunway AOI almost every maintain-band tower resolves to flood work,
 * so a flat crew list read as one undifferentiated pool. Empty groups still
 * render, carrying their `emptyReason`, so a capability with nothing to do
 * today reads as "nothing to do" rather than as a missing feature.
 *
 * Selection is per-job, not per-crew-day: clicking a bar calls select() with
 * a {kind: 'job', crew_id, day, tower_id} selection so a crew-day with two or
 * more bars can address each one individually. A reserved crew-day renders a
 * <ReserveBand> instead of the free-day affordance and selects
 * {kind: 'reserve', crew_id, day}.
 */
export function TimelineBoard() {
  const selectedDay = useScheduleStore((s) => s.selectedDay);
  const selection = useScheduleStore((s) => s.selection);
  const select = useScheduleStore((s) => s.select);
  const searchQuery = useScheduleStore((s) => s.searchQuery);
  const calendarTeamFilter = useScheduleStore((s) => s.calendarTeamFilter);
  const calendarStatusFilter = useScheduleStore((s) => s.calendarStatusFilter);
  const territory = useScheduleStore((s) => s.territory);
  const hourZoom = useScheduleStore((s) => s.hourZoom);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  // One shared derivation of "this territory's crews, and the run narrowed
  // to them" — the same hook the readiness chips and the WeekStrip meters
  // read, so the board and the counts above it never describe different
  // rosters.
  const { run, crews: territoryCrews } = useTerritoryRun();

  const dayEntries = useMemo(
    () => run.entries.filter((e) => e.day === selectedDay),
    [run.entries, selectedDay],
  );

  // Search still REMOVES lanes — a planner typing a crew id is asking to see
  // that crew, and leaving twenty greyed rows around it answers a different
  // question. The capability/status filters below only dim, because those are
  // "show me the shape of the board through this lens" rather than "find this".
  let crews = territoryCrews;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    crews = crews.filter(
      (crew) =>
        crew.crew_id.toLowerCase().includes(q) ||
        (crew.depot?.name?.toLowerCase() ?? '').includes(q) ||
        dayEntries.some(
          (e) =>
            e.crew_id === crew.crew_id &&
            (e.tower_id.toLowerCase().includes(q) || placeName(e.tower_id).toLowerCase().includes(q)),
        ),
    );
  }

  const towersById = useMemo(() => new Map(towers.map((t) => [t.tower_id, t])), [towers]);
  const axis = useMemo(() => buildAxis(dayEntries), [dayEntries]);
  const rawLanes = useMemo(
    () => buildLanes(crews, dayEntries, axis, selectedDay, run.reserve),
    [crews, dayEntries, axis, selectedDay, run.reserve],
  );

  const lanes = rawLanes;

  /**
   * Which crew ids the capability/status filters match, or `null` when neither
   * filter is narrowing anything.
   *
   * The filters used to drop non-matching lanes out of the board entirely.
   * That is the one interaction the map console deliberately does not do: its
   * band filter dims the bands you did not pick and leaves them in place, so
   * the shape of the whole population stays visible and you keep your position
   * in it. Removing rows from a role-grouped timeline is worse than on a flat
   * list, because whole capability groups collapse and the board reflows under
   * the pointer that just clicked the filter.
   */
  const matchedCrewIds = useMemo(() => {
    const teamOn = Boolean(calendarTeamFilter) && calendarTeamFilter !== 'all';
    const statusOn = Boolean(calendarStatusFilter) && calendarStatusFilter !== 'all';
    if (!teamOn && !statusOn) return null;

    const matched = new Set<string>();
    for (const lane of rawLanes) {
      if (teamOn && lane.crew.crew_type.toLowerCase() !== calendarTeamFilter.toLowerCase()) continue;
      if (statusOn) {
        if (calendarStatusFilter === 'booked' && lane.bars.length === 0) continue;
        if (calendarStatusFilter === 'reserve' && !lane.reserved) continue;
        if (calendarStatusFilter === 'free' && (lane.bars.length > 0 || lane.reserved)) continue;
      }
      matched.add(lane.crew.crew_id);
    }
    return matched;
  }, [rawLanes, calendarTeamFilter, calendarStatusFilter]);

  const lanesByRole = useMemo(() => {
    const byType = new Map<string, GanttLane[]>();
    for (const lane of lanes) {
      const list = byType.get(lane.crew.crew_type);
      if (list) list.push(lane);
      else byType.set(lane.crew.crew_type, [lane]);
    }
    return byType;
  }, [lanes]);

  /**
   * Which crew types have any work at all behind them this run — booked on
   * any day, or waiting in unscheduled_detail. A role staffed here but with
   * nothing in either list is genuinely workless, and RoleGroup states its
   * reason at the lane instead of offering "Free — assign work" (which for
   * electrical leads to an assign list that can only ever be empty).
   */
  const typesWithWork = useMemo(() => {
    const typeOf = new Map(territoryCrews.map((c) => [c.crew_id, c.crew_type]));
    const types = new Set<string>();
    for (const e of run.entries) {
      const t = typeOf.get(e.crew_id);
      if (t) types.add(t);
    }
    for (const d of run.unscheduled_detail) types.add(d.crew_type);
    return types;
  }, [territoryCrews, run.entries, run.unscheduled_detail]);

  const span = axis.endMin - axis.startMin;
  const tickPct = (t: number) => ((t - axis.startMin) / span) * 100;
  const ticks = axis.ticks;
  const lastTick = ticks.length > 0 ? ticks[ticks.length - 1] : axis.endMin;

  /**
   * The first and last hour labels sit on the axis edges, so centring them
   * pushes half a label outside the scroll container and produces a phantom
   * horizontal scrollbar. Anchor the end labels inward instead of centring
   * them — the tick line itself stays exactly on the hour either way.
   */
  const tickAnchor = (t: number) =>
    t === axis.startMin ? 'translateX(0)' : t === lastTick ? 'translateX(-100%)' : 'translateX(-50%)';

  /**
   * Width of the lane area in pixels.
   *
   * At a fixed scale this is just hours x PX_PER_HOUR and the board scrolls
   * when it exceeds the column. At `fit` it is instead solved from the
   * measured column width, so the whole day lands inside the window with no
   * horizontal scroll — which is the setting the board opens in, and the one
   * that makes it adapt when the work queue collapses and hands the calendar
   * more room.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);

  // ResizeObserver, not a window resize listener: the column changes width
  // when the detail panel opens and when the work queue collapses, and neither
  // of those resizes the window.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hours = (axis.endMin - axis.startMin) / 60;
  // RAIL is authored as a px string in RoleGroup; parse rather than duplicate
  // the number, so widening the rail cannot silently desync the fit maths.
  const railPx = parseFloat(RAIL);
  const laneWidth =
    hourZoom === 'fit'
      ? // Until the first measurement lands, fall back to the fixed scale
        // rather than to 0 — a zero-width lane would divide by zero in the
        // tick maths on the very first paint.
        Math.max(available > 0 ? available - railPx : hours * PX_PER_HOUR, hours * 28)
      : hours * hourZoom;

  // Reset the scroll to the start of the day whenever the scale changes, so a
  // zoom does not leave the planner looking at 19:00 with no idea how they got
  // there.
  useEffect(() => {
    scrollRef.current?.scrollTo({ left: 0 });
  }, [hourZoom, selectedDay]);

  return (
    <div ref={scrollRef} className="scroll-thin overflow-x-auto">
      {/* Rail width + lane width, so the scroll container has a real content
          width to scroll through rather than a percentage that can never
          overflow. */}
      <div style={{ minWidth: `calc(${RAIL} + ${laneWidth}px)` }}>
        {/* Hour axis */}
        {/* z-10: above the crew rails (z-4) and the group headers (z-5) it
            has to cover while scrolling, and deliberately BELOW the page
            header's stacking context. At z-20 it tied with PageHeader and won
            on DOM order, so the header's filter popover was sliced in half by
            the hour axis painting through it. */}
        <div className="sticky top-0 z-10 flex border-b border-overlay/10 bg-ink-950/90 backdrop-blur-sm">
          {/* The rail column's header. Sticky on BOTH axes — it is the corner
              cell of a two-way scrolling grid, so it has to outrank the axis
              (which is only sticky vertically) and the rails below it. */}
          <div
            className="sticky left-0 z-10 shrink-0 border-r border-overlay/[0.07] bg-ink-950"
            style={{ width: RAIL }}
          />
          <div className="relative h-9 shrink-0" style={{ width: laneWidth }}>
            {ticks.map((t) => (
              <span
                key={t}
                className="tnum absolute top-1/2 text-eyebrow text-dim"
                style={{ left: `${tickPct(t)}%`, transform: `${tickAnchor(t)} translateY(-50%)` }}
              >
                {clockLabel(t)}
              </span>
            ))}
          </div>
        </div>

        {crews.length === 0 && (
          // Two different absences, two different reasons: a search that
          // matched nothing is not the same as a territory with no roster,
          // and reporting the first for the second is a false explanation.
          <p className="p-6 text-body text-dim">
            {searchQuery ? `No crews match “${searchQuery}”.` : `No crews in ${territory}.`}
          </p>
        )}

        {/* A third absence, and it needs saying because the filters now dim
            rather than remove: if nothing matches, the board below looks
            uniformly greyed and gives no reason for it. */}
        {crews.length > 0 && matchedCrewIds !== null && matchedCrewIds.size === 0 && (
          <p className="border-b border-overlay/[0.07] bg-watch/[0.06] px-4 py-2.5 text-micro text-watch-ink">
            No crew matches the active filter — every lane below is shown dimmed.
          </p>
        )}

        {ROLE_TEAMS.map((team) => (
          <RoleGroup
            key={team.crewType}
            team={team}
            hasWork={typesWithWork.has(team.crewType)}
            lanes={lanesByRole.get(team.crewType) ?? []}
            axis={axis}
            selectedDay={selectedDay}
            selection={selection}
            select={select}
            towersById={towersById}
            matchedCrewIds={matchedCrewIds}
            laneWidth={laneWidth}
          />
        ))}
      </div>
    </div>
  );
}
