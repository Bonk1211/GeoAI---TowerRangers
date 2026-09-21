import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { isScored } from '../../fixtures/towers';
import { placeName, splitSiteLabel } from '../../fixtures/schedule';
import { dayLabel } from '../../lib/scheduleDays';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useTerritoryRun } from '../../state/useTerritoryRun';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { bandColor, bandInk, ALERT, ALERT_INK } from '../../lib/colors';
import { roleColor, roleInk, tintedChip } from '../../lib/roleColors';
import { roleTeam } from '../../lib/roleTeams';
import { clockLabel, durationLabel } from '../../lib/gantt';
import { RESERVE_HATCH_STYLE } from '../../lib/reserveHatch';
import { SLIDE_MS, LAND_MS, moveDelaySec, emergencyDelaySec } from '../../lib/dispatchAnimation';

/** Spring feel for a crew token travelling between cells — snappy, not bouncy. */
const TRAVEL_SPRING = { type: 'spring', stiffness: 380, damping: 34 } as const;

export function ScheduleGridByTower() {
  const run = useScheduleStore((s) => s.run);
  const selection = useScheduleStore((s) => s.selection);
  const select = useScheduleStore((s) => s.select);
  const searchQuery = useScheduleStore((s) => s.searchQuery);
  const territory = useScheduleStore((s) => s.territory);
  // Only the reserve figure is territory-scoped here. The tower rows
  // themselves are not a per-territory board — they are every site the run
  // touched — so their entries stay as the solver reported them.
  const { run: territoryRun } = useTerritoryRun();
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);

  // The routed-dispatch target (emergency selection): drives the scroll-
  // into-view below and the row/cell highlight. Not a tower-row concept —
  // it is whichever cell the emergency flow is pointing at right now.
  const dispatchTarget = selection?.kind === 'emergency' ? selection : null;
  const dispatchAnimation = useScheduleStore((s) => s.dispatchAnimation);

  const relevantTowers = searchQuery
    ? towers
        .filter((t) => {
          const q = searchQuery.toLowerCase();
          return t.tower_id.toLowerCase().includes(q) || placeName(t.tower_id).toLowerCase().includes(q);
        })
        .slice(0, 30)
    : (() => {
        const maintainOrTouched = towers.filter(
          (t) =>
            isScored(t) &&
            (t.decision === 'maintain' ||
              run.entries.some((e) => e.tower_id === t.tower_id) ||
              run.unscheduled.includes(t.tower_id)),
        );
        const watchSample = towers.filter((t) => isScored(t) && t.decision === 'watch').slice(0, 3);
        const base = [...maintainOrTouched, ...watchSample].slice(0, 30);
        // A routed dispatch target must be visible even if it fell outside
        // the top-30 sample, or the scroll-into-view below has nothing to
        // find. The same holds for every tower the last dispatch MOVED: the
        // confirmation names them, so a board that does not contain them
        // reads as the board disagreeing with the panel.
        const forced: typeof base = [];
        const needed = new Set<string>(dispatchAnimation?.moves.map((m) => m.tower_id) ?? []);
        if (dispatchTarget) needed.add(dispatchTarget.tower_id);
        // The dispatched tower itself. It is usually caught by the
        // maintain-or-touched filter now that it holds an entry, but "usually"
        // is not good enough for the one row the confirmation is about — the
        // sample is capped at 30 and a low-risk site can fall off the end.
        if (dispatchAnimation) needed.add(dispatchAnimation.emergency.tower_id);
        for (const id of needed) {
          if (base.some((t) => t.tower_id === id)) continue;
          const found = towers.find((t) => t.tower_id === id);
          if (found) forced.push(found);
        }
        return forced.length > 0 ? [...forced, ...base] : base;
      })();

  const targetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (dispatchTarget) targetRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [dispatchTarget]);

  const horizon = run.horizon;

  const shouldReduceMotion = useReducedMotion();

  // Neither cell that takes part in a swap has ever rendered a `layoutId`
  // before the dispatch it is illustrating — the very first time a job
  // appears at its origin, Motion has no prior position to travel FROM. So
  // the travel is staged in two frames using data we already have (the
  // move's `from`/`to`), not recovered from real DOM history: 'pre' renders
  // every moved job at its OLD cell for one frame, then 'post' releases it
  // to its real cell and Motion's layoutId animates the measured delta. This
  // is also what makes Replay work — it re-runs the same two frames without
  // the underlying data changing at all.
  const [replayPhase, setReplayPhase] = useState<'pre' | 'post'>('post');
  const animToken = dispatchAnimation?.token ?? 0;
  useLayoutEffect(() => {
    if (!dispatchAnimation || shouldReduceMotion) {
      setReplayPhase('post');
      return;
    }
    setReplayPhase('pre');
    // rAF, not a timeout: the 'pre' frame must be committed to the DOM
    // before 'post' renders, or Motion has nothing to measure it against.
    const raf = requestAnimationFrame(() => setReplayPhase('post'));
    return () => cancelAnimationFrame(raf);
  }, [animToken, dispatchAnimation, shouldReduceMotion]);

  // Bring the dispatched row to the planner rather than making them hunt for
  // it. The existing scroll above only fires for an `emergency` SELECTION,
  // and it hangs off the empty-cell branch — the moment the dispatch is
  // committed that cell holds an entry, so the ref it needed no longer
  // exists and the board stayed wherever it happened to be scrolled.
  const emergencyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dispatchAnimation) return;
    emergencyRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [animToken, dispatchAnimation]);

  // Index preserved (not the filtered position) so a same-day crew-only swap
  // still gets its place in the ripple even though it never travels.
  const movesByTower = useMemo(
    () =>
      new Map(
        (dispatchAnimation?.moves ?? []).map((move, index) => [move.tower_id, { move, index }]),
      ),
    [dispatchAnimation],
  );

  return (
    <div className="overflow-x-auto p-4">
      <div
        className="grid min-w-[780px] gap-2"
        style={{ gridTemplateColumns: `190px repeat(${horizon.length}, 1fr)` }}
      >
        <div className="eyebrow pb-1">Tower</div>
        {horizon.map((day) => {
          // run.reserve is a per-crew-day slot, not a tower row — marking
          // every empty cell in this by-site grid would falsely imply that
          // *tower* is reserved. The day column header is the only place
          // in this view that can honestly carry it. Same hatch treatment
          // as WeekStrip's day-load meter (lib/reserveHatch.ts), so
          // "reserve" reads as one consistent mark across the schedule.
          // Scoped to the selected territory — the raw run.reserve is
          // national, so it reported cover no crew on this screen holds.
          const reservedCount = territoryRun.reserve.filter((r) => r.day === day).length;
          return (
            <div key={day} className="eyebrow flex items-center gap-1.5 px-1 pb-1">
              <span>{dayLabel(day)}</span>
              {reservedCount > 0 && (
                <span
                  className="flex items-center gap-1 normal-case text-dim"
                  title={`${reservedCount} reserve crew-day${reservedCount === 1 ? '' : 's'} held open in ${territory}`}
                >
                  <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm opacity-60" style={RESERVE_HATCH_STYLE} />
                  <span className="tnum">{reservedCount}</span>
                </span>
              )}
            </div>
          );
        })}

        {relevantTowers.map((tower) => {
          const unscheduled = run.unscheduled.includes(tower.tower_id);
          const band = bandColor(tower.decision);
          const towerEntries = run.entries.filter((e) => e.tower_id === tower.tower_id);
          const isScheduledAnyDay = towerEntries.length > 0;
          const isRoutedRow = dispatchTarget?.tower_id === tower.tower_id;
          const { operator, site } = splitSiteLabel(tower.tower_id);
          // Computed once per row: every cell in it needs to know whether
          // THIS tower's job is part of the dispatch being animated, and if
          // so, whether it changed day (travels the board) or only changed
          // crew in place (badge only — nothing to travel between).
          const moveEntry = movesByTower.get(tower.tower_id);
          const move = moveEntry?.move;
          const moveIndex = moveEntry?.index ?? -1;
          const travels = Boolean(move && move.from !== move.to);
          return (
            // Key belongs on the fragment — it is the element of this array.
            <Fragment key={tower.tower_id}>
              <div
                className={`flex flex-col justify-center rounded-lg pr-3 ${isRoutedRow ? 'route-pulse' : ''}`}
              >
                {/* Site leads, operator follows. The joined label puts the
                    only difference between three co-located towers
                    ("Operator A/B/C · site 701753") at the START of the
                    string, which is the worst place to scan a column by. */}
                <div className="flex items-center gap-2 text-ui font-semibold text-fg">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: band }} />
                  <span className="truncate">{site}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-micro">
                  {/* Risk on the band ramp — the same chip the calendar bars
                      and the work queue draw, so one tower reads identically
                      on all three surfaces. */}
                  {/* White chip with a band edge, not a band wash. On the
                      page ground a maintain wash put its own ink at 4.50:1 —
                      right on the AA line and failing once rounded. Lifting
                      the chip toward white puts the worst case at 5.43:1, and
                      matches how the crew timeline draws the same value. */}
                  <span
                    className="tnum rounded border bg-white/70 px-1 font-semibold"
                    style={{ color: bandInk(tower.decision), borderColor: `${band}59` }}
                  >
                    {tower.risk.toFixed(2)}
                  </span>
                  <span className="truncate capitalize text-dim">{tower.dominant_factor}</span>
                </div>
                {operator && <div className="mt-0.5 truncate pl-3.5 text-micro text-dim">{operator}</div>}
                {!isScheduledAnyDay && (
                  /* Solver output, so it is stated as a status rather than as
                     a grey aside: "no capacity" is the answer to why this row
                     is empty, and it was styled to look like a caption. */
                  <div className="mt-1 pl-3.5">
                    {unscheduled ? (
                      <span className="inline-flex rounded border border-watch/35 bg-watch/10 px-1.5 py-0.5 text-eyebrow font-medium text-watch-ink">
                        No capacity this week
                      </span>
                    ) : (
                      <span className="text-micro text-dim">Not due — watch only</span>
                    )}
                  </div>
                )}
              </div>

              {horizon.map((day) => {
                // Rest state: the real filter. Mid-swap ('pre' frame) a
                // travelling job is shown one cell early — still at its OLD
                // day — so Motion has a real position to measure before
                // 'post' releases it to where it actually lives now. Nothing
                // about run.entries changes for this; it is a one-frame
                // rendering detour, not a data mutation.
                let dayEntries = towerEntries.filter(e => e.day === day).sort((a, b) => a.order - b.order);
                if (travels && replayPhase === 'pre' && move) {
                  if (day === move.from) {
                    dayEntries = towerEntries.filter(e => e.day === move.to).sort((a, b) => a.order - b.order);
                  } else if (day === move.to) {
                    dayEntries = [];
                  }
                }
                const hasEntries = dayEntries.length > 0;

                if (hasEntries) {
                  const landedHere = move?.to === day;
                  const isEmergencyCell =
                    dispatchAnimation?.emergency.tower_id === tower.tower_id &&
                    dispatchAnimation?.emergency.day === day;
                  const revealed = replayPhase === 'post';
                  const innerContent = (
                    <>
                      {isEmergencyCell && (
                        <span
                          className="self-start rounded border px-1.5 text-eyebrow font-semibold"
                          style={{
                            color: ALERT_INK,
                            borderColor: `${ALERT}59`,
                            backgroundColor: `${ALERT}1f`,
                          }}
                        >
                          ▲ Emergency dispatch
                        </span>
                      )}
                      {move && landedHere && revealed && (
                        <span className="self-start rounded border border-accent/35 bg-accent/10 px-1.5 text-eyebrow font-semibold text-accent">
                          {travels ? `moved from ${dayLabel(move.from)}` : 'crew reassigned'}
                          {move.from_crew_id !== move.to_crew_id
                            ? ` · now ${move.to_crew_id}`
                            : ''}
                        </span>
                      )}
                      {dayEntries.map(entry => {
                        const isSelected =
                          selection?.kind === 'job' &&
                          selection.crew_id === entry.crew_id &&
                          selection.day === day &&
                          selection.tower_id === entry.tower_id;
                        // Solver clock, not a lookup table. This view keeps its
                        // day-column shape (a tower takes at most one job a day,
                        // so an hour axis buys nothing), but the times it prints
                        // must come from the same start_min/end_min the crew
                        // timeline draws — otherwise the two views disagree about
                        // the same entry by a handful of minutes.
                        const timed =
                          typeof entry.start_min === 'number' && typeof entry.end_min === 'number';
                        // WHAT A CELL'S COLOUR ANSWERS ON THIS BOARD.
                        //
                        // Every cell used to be washed in its SITE's risk
                        // band. On a board whose rows are already sorted by
                        // risk that is the one thing the cell did not need to
                        // say — the row header carries the same value twice
                        // over, as a dot and as a numeric chip — and it cost
                        // the grid the ability to say anything else. Seven
                        // red cells in a row are seven different crews doing
                        // four different kinds of work, drawn identically.
                        //
                        // Severity belongs to the TOWER, which is the row.
                        // Capability belongs to the VISIT, which is the cell.
                        // So the cell now takes the cool role ramp
                        // (lib/roleColors.ts) and severity stays on the row
                        // where it was already stated. The two ramps were
                        // built not to collide: cool = who, warm = how bad.
                        //
                        // The emergency pin is the exception and keeps the
                        // warm alert ramp, which is now the only warm mark
                        // among the cells and so reads instantly as the thing
                        // that does not belong to the routine plan.
                        //
                        // Colour is never the only carrier — the team is also
                        // named in the chip below (WCAG color-not-only).
                        const isEmergencyEntry =
                          entry.pinned && entry.pin_reason === 'emergency';
                        const crewType = entry.work_order.crew_type;
                        const cell = isEmergencyEntry ? ALERT : roleColor(crewType);
                        const cellInk = isEmergencyEntry ? ALERT_INK : roleInk(crewType);
                        const teamLabel = roleTeam(crewType)?.label ?? crewType;
                        const timeLabel = timed
                          ? `${clockLabel(entry.start_min as number)} - ${clockLabel(entry.end_min as number)}`
                          : 'Time not set';
                        // Only a travelling job's button gets a layoutId —
                        // everything else on the board stays a plain button,
                        // so Motion is only ever measuring the handful of
                        // cells this one dispatch actually touched.
                        const CellButton = travels ? motion.button : 'button';
                        return (
                          <CellButton
                            key={entry.crew_id}
                            type="button"
                            title={tower.tower_id}
                            aria-pressed={isSelected}
                            onClick={() =>
                              select({ kind: 'job', crew_id: entry.crew_id, day, tower_id: entry.tower_id })
                            }
                            {...(travels
                              ? {
                                  layout: true,
                                  layoutId: `entry-${tower.tower_id}-${animToken}`,
                                  transition: {
                                    layout: { ...TRAVEL_SPRING, delay: moveDelaySec(moveIndex) },
                                  },
                                }
                              : null)}
                            /* Band wash plus band spine, the same construction
                               the crew timeline's bars use — the two views draw
                               the same entry, so they must look like the same
                               entry. It was `glass` over a plain white cell,
                               which shared nothing with the other board. */
                            className={`spine flex flex-1 flex-col justify-center gap-1 rounded-lg px-2 py-2 text-ui font-medium text-fg transition-[background-color,box-shadow] duration-150 ${
                              isEmergencyEntry ? 'border-2' : 'border'
                            } ${
                              isSelected ? 'shadow-[var(--shadow-2)] ring-2 ring-accent' : 'hover:shadow-[var(--shadow-1)]'
                            }`}
                            style={{
                              '--spine': cell,
                              minHeight: '68px',
                              backgroundColor: isSelected ? `${cell}2e` : `${cell}1a`,
                              borderColor: isEmergencyEntry ? `${cell}b3` : `${cell}66`,
                            } as React.CSSProperties}
                          >
                            {/* Neither line uses text-dim. On a selected cell
                                the band wash deepens to 2e, where dim measures
                                4.08:1 — under AA for a clock time a planner
                                reads off the grid. The clock takes text-fg and
                                the duration text-muted, which both clear it and
                                give the two figures a hierarchy the single grey
                                did not. */}
                            <div className="tnum -mb-0.5 w-full pl-1 text-left text-eyebrow font-semibold text-fg">
                              {timeLabel}
                              {timed && (
                                <span className="ml-1.5 font-medium text-muted">
                                  {durationLabel((entry.end_min as number) - (entry.start_min as number))}
                                  {entry.travel_min ? ` · ${entry.travel_min}m drive` : ''}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 w-full text-left pl-1">
                              {entry.pinned && (
                                <span
                                  aria-hidden="true"
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                    entry.pin_reason === 'emergency' ? 'bg-alert' : 'bg-accent'
                                  }`}
                                />
                              )}
                              {/* Names the team in words as well as in hue.
                                  The cell wash now carries capability, and a
                                  wash on its own is unreadable to anyone who
                                  cannot separate indigo from cyan — so the
                                  team is spelled out here and the crew id
                                  follows it. */}
                              <span
                                className="truncate rounded border px-1.5 py-0.5 text-eyebrow font-semibold"
                                style={tintedChip(cell, cellInk, '1f', '59')}
                              >
                                {isEmergencyEntry ? 'Emergency' : teamLabel} · {entry.crew_id}
                              </span>
                            </div>
                          </CellButton>
                        );
                      })}
                    </>
                  );
                  return (
                    <div
                      key={`${tower.tower_id}-${day}`}
                      data-day-cell
                      ref={isEmergencyCell ? emergencyRef : undefined}
                      className={`flex h-full w-full flex-col gap-1 py-0.5 ${
                        isEmergencyCell && revealed ? 'route-pulse rounded-lg' : ''
                      }`}
                    >
                      {isEmergencyCell ? (
                        <motion.div
                          className="flex flex-1 flex-col gap-1"
                          initial={false}
                          animate={{ opacity: revealed ? 1 : 0, scale: revealed ? 1 : 0.94 }}
                          transition={{
                            duration: shouldReduceMotion ? 0 : LAND_MS / 1000,
                            delay: shouldReduceMotion ? 0 : emergencyDelaySec(dispatchAnimation?.moves.length ?? 0),
                          }}
                        >
                          {innerContent}
                        </motion.div>
                      ) : (
                        innerContent
                      )}
                    </div>
                  );
                }

                const isEmergencyTarget =
                  dispatchTarget?.tower_id === tower.tower_id && dispatchTarget?.day === day;
                // The cell this tower's job used to occupy, once it has
                // actually left — the other half of the swap the confirmation
                // panel calls "rescheduled to make room". Fades out once its
                // replacement (or its own later slot) has finished landing.
                const isVacatedOrigin = travels && move && day === move.from && replayPhase === 'post';
                return (
                  <div
                    key={`${tower.tower_id}-${day}`}
                    data-day-cell
                    ref={isEmergencyTarget ? targetRef : undefined}
                    className={`relative flex h-full min-h-[72px] w-full flex-col rounded-lg py-0.5 ${
                      isEmergencyTarget ? 'route-pulse' : ''
                    }`}
                  >
                    {isVacatedOrigin && move && (
                      <motion.div
                        key={`vacated-${tower.tower_id}-${animToken}`}
                        className="pointer-events-none absolute inset-x-1 top-1 z-10 flex justify-center"
                        initial={{ opacity: shouldReduceMotion ? 0 : 1 }}
                        animate={{ opacity: 0 }}
                        transition={{
                          duration: shouldReduceMotion ? 0 : LAND_MS / 1000,
                          delay: shouldReduceMotion ? 0 : moveDelaySec(moveIndex) + SLIDE_MS / 1000,
                        }}
                      >
                        <span className="rounded border border-watch/40 bg-watch/10 px-1.5 text-eyebrow font-semibold text-watch-ink">
                          picked up{move.from_crew_id !== move.to_crew_id ? ` · now ${move.to_crew_id}` : ''}
                        </span>
                      </motion.div>
                    )}
                    {/* Quiet at rest, labelled on approach.

                        Every empty cell used to render a full "Dispatch" call
                        to action — seven a row, sixty on screen — so the grid
                        read as a wall of identical red buttons and the handful
                        of cells that actually held work were the quietest
                        things on it. An empty cell is the DEFAULT state of this
                        grid; it should not shout. The affordance is still a
                        real button with a permanent accessible name, so nothing
                        is lost to a screen reader or to the keyboard — only the
                        visible label waits for hover or focus. */}
                    <button
                      type="button"
                      title={`Dispatch a crew to ${site} on ${dayLabel(day)}`}
                      aria-label={`Dispatch to ${placeName(tower.tower_id)} on ${dayLabel(day)}`}
                      onClick={() => select({ kind: 'emergency', tower_id: tower.tower_id, day })}
                      className={`group/cell flex flex-1 items-center justify-center rounded-lg border border-dashed text-micro transition-colors duration-150 ${
                        isEmergencyTarget
                          ? 'border-alert/60 bg-alert/12 text-alert-ink'
                          : 'border-overlay/[0.07] hover:border-alert/40 hover:bg-alert/[0.07]'
                      }`}
                    >
                      {isEmergencyTarget ? (
                        'Dispatching'
                      ) : (
                        <span className="text-alert-ink opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100 group-focus-visible/cell:opacity-100">
                          Dispatch
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
