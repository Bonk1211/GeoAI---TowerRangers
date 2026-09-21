import { useEffect, useMemo, useRef } from 'react';
import { useSimulation } from '../../state/useSimulation';
import { beatById } from '../../lib/simulationTimeline';
import { resolveConsoleLine, resolveHeadline } from '../../lib/simulationConsoleLine';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useWeights } from '../../state/useWeights';
import { assignRetuningNeighbors } from '../../lib/responsePhaseGeometry';
import type { SimulationRoadState } from './useSimulationRoads';

/**
 * Transcript of fired beats, streamed as the clock reaches them.
 * `docs/Disaster_Simulation_Spec.md` §4, §8.1.
 *
 * TWO LINES PER BEAT (2026-09-20, operator review: "too difficult to
 * understand when showing to judges"). The primary line is `beat.headline`,
 * plain language in the sans face — no API paths, no raw tower ids, no
 * unexpanded acronyms, one line at the rendered width. The technical
 * transcript (`beat.console`) moved into a collapsed `<details>` beneath
 * it, still carrying every caveat, real-event figure and provenance note
 * that made the honesty surface defensible — one click away rather than
 * competing with the summary for the same eye. `<details>` is not
 * decoration here: the caveats are load-bearing under §0.6 and must stay
 * reachable on screen, not deleted for tidiness.
 *
 * `font-mono` + `.tnum` is now scoped to the clock label and the detail
 * line, which is where API paths and tower ids actually live — that
 * combination is also what turns off Fira Code's ligatures, load-bearing
 * the moment a line contains `->` (several detail lines do).
 *
 * A backend beat whose call failed carries a DEGRADED badge: the
 * line still fires, but visibly marked rather than silently substituting a
 * fixture number.
 */
const BACKEND_BEAT_IDS = new Set(['optimize', 'generator-dispatch']);

export function SimulationConsole({ roads }: { roads: SimulationRoadState }) {
  const elapsedMs = useSimulation((s) => Math.floor(s.elapsedMs / 1000) * 1000);
  const firedBeatIds = useSimulation((s) => s.firedBeatIds);
  const status = useSimulation((s) => s.status);
  const downTowerIds = useSimulation((s) => s.downTowerIds);
  const generatorSiteIds = useSimulation((s) => s.generatorSiteIds);
  const optimizeRun = useSimulation((s) => s.optimizeRun);
  const optimizeStatus = useSimulation((s) => s.optimizeStatus);
  const emergencyRun = useSimulation((s) => s.emergencyRun);
  const emergencyStatus = useSimulation((s) => s.emergencyStatus);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const sabahTowerIds = useMemo(
    () => new Set(towers.filter((t) => t.territory === 'Sabah').map((t) => t.tower_id)),
    [towers],
  );
  const downTowerId = downTowerIds.size > 0 ? [...downTowerIds][0] : null;
  const requestedDroneCount = roads.coverage.missions.length;
  const activeRelayCount = roads.coverage.activeDrones.length;

  // The same assignment SimulationMap draws cones from, so the console's cell
  // count and the cones on screen can never disagree. Null until there is a down tower to
  // compute against: "not worked out yet" is not "zero cells retuned", and the
  // console prints the raw placeholder rather than a number it does not have.
  const retuneNeighborCount = useMemo(() => {
    const down = towers.filter((t) => downTowerIds.has(t.tower_id));
    if (down.length === 0) return null;
    return assignRetuningNeighbors(down, towers, downTowerIds)
      .reduce((sum, a) => sum + a.neighbors.length, 0);
  }, [towers, downTowerIds]);

  // The planned site count includes access holds; only complete routes dispatch a vehicle.
  const hardeningSiteCount = useMemo(() => {
    if (roads.unavailable) return null;
    const units = new Set(roads.assignments
      .filter(leg => leg.unitKind === 'hardening')
      .map(leg => leg.unitId ?? leg.crewId));
    return units.size || null;
  }, [roads.assignments, roads.unavailable]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Always snap to the newest beat — the console is a live feed, and the
    // latest line is the one that matters as the clock runs.
    el.scrollTop = el.scrollHeight;
  }, [firedBeatIds.length]);

  return (
    <div
      className="flex h-full min-h-0 flex-col rounded-xl border border-overlay/20 bg-overlay/[0.06] p-3 shadow-1"
      role="log"
      aria-live="polite"
      aria-label="Simulation transcript"
    >
      <h2 className="eyebrow mb-2">Console</h2>
      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-0.5">
        {firedBeatIds.length === 0 ? (
          <p className="font-mono tnum text-dim">
            {status === 'idle' ? 'Press Play to run the scenario.' : 'Waiting for the first beat…'}
          </p>
        ) : (
          <ol className="flex flex-col">
            {firedBeatIds.map((id, i) => {
              const beat = beatById(id);
              if (!beat) return null;
              const lineContext = {
                optimizeRun,
                emergencyRun,
                sabahTowerIds,
                downTowerId,
                cowClusterCount: activeRelayCount,
                generatorSiteCount: generatorSiteIds.size,
                retuneNeighborCount,
                hardeningSiteCount,
              };
              const headline = id !== 'cow' ? resolveHeadline(beat, lineContext)
                : elapsedMs >= 92_000 ? 'Drones landed at their original vehicles'
                  : elapsedMs >= 88_000 ? 'Drones returning to their original vehicles'
                    : activeRelayCount ? `${activeRelayCount} drone relays active; launch vehicles hold`
                      : roads.unavailable ? 'Drone launch held for access confirmation'
                        : 'Drones launch from fixed vehicles at the flood edge';
              const line = id !== 'cow' ? resolveConsoleLine(beat, lineContext)
                : elapsedMs >= 92_000 ? 'All drones have landed at their original PRIME jeeps. All ground vehicles remain outside the flood.'
                  : elapsedMs >= 88_000 ? 'Each drone returns to the same PRIME jeep it launched from. All ground vehicles remain outside the flood.'
                  : `${activeRelayCount} of ${requestedDroneCount} airborne relays on station. Both PRIME jeeps stay at their fixed dry launch positions to maintain all drone links. Drones spread across the outage zone; green shows their coverage and red shows any remaining gaps.`;
              // Degraded: this specific beat is a live-call beat AND that
              // call's status is 'error'. A beat still pending (the call
              // hasn't resolved yet, even though the clock reached it) shows
              // a resolving hint rather than a false degraded badge — the
              // call may still succeed.
              const backendStatus =
                id === 'optimize' ? optimizeStatus : id === 'generator-dispatch' ? emergencyStatus : null;
              const degraded = backendStatus === 'error';
              const pending = backendStatus === 'pending' || backendStatus === 'idle';
              const isLast = i === firedBeatIds.length - 1;
              return (
                <li key={id} className="flex gap-2.5">
                  {/* Marker column: dot + connector, same shape family as
                      PhaseStrip's stepper so the two timelines read as one
                      idiom (spec §10 visual-language consistency). */}
                  <div className="flex flex-col items-center">
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        degraded ? 'bg-alert' : 'bg-accent'
                      }`}
                    />
                    {!isLast && <span aria-hidden="true" className="my-0.5 w-px flex-1 bg-overlay/20" />}
                  </div>
                  <div className={`min-w-0 flex-1 ${isLast ? 'pb-0' : 'pb-3'}`}>
                    <span className="font-mono text-micro tnum text-dim">{beat.clockLabel}</span>
                    {/* Headline first, in the SANS face at body size: this is
                        the line a judge or a first-time viewer reads
                        (2026-09-20). The technical transcript moved below it
                        into `<details>` — it is still one click away and still
                        carries every caveat and real-event figure, but it no
                        longer competes with the plain-language summary for the
                        same eye. Mono is reserved for the detail, where API
                        paths and tower ids actually need it. */}
                    <p className="text-body font-medium leading-snug text-fg">
                      {headline}
                      {BACKEND_BEAT_IDS.has(id) && pending && !degraded && (
                        <span className="ml-1 font-sans text-micro font-normal text-dim">(resolving…)</span>
                      )}
                    </p>
                    {line !== headline && (
                      <details className="group/detail mt-0.5">
                        <summary className="cursor-pointer list-none text-micro text-dim transition-colors hover:text-muted">
                          <span className="group-open/detail:hidden">Technical detail</span>
                          <span className="hidden group-open/detail:inline">Hide detail</span>
                        </summary>
                        <p className="mt-1 font-mono text-micro leading-snug text-muted">{line}</p>
                      </details>
                    )}
                    {degraded && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                          className="rounded border border-alert/40 bg-alert/10 px-1 py-px text-micro font-sans font-semibold uppercase tracking-wide text-alert"
                          title="This call to the backend failed — the beat fired, but its figures could not be confirmed live."
                        >
                          DEGRADED — OFFLINE
                        </span>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
