import type { FeatureCollection, LineString } from 'geojson';
import type { Crew, ScheduleEntry, ScheduleRun, Tower } from '../api/types';
import { simulationCrewStepAt } from './simulationVisuals.ts';
import { haversineKm } from './geo.ts';

export interface RoadPoint { lon: number; lat: number }
export interface SimulationRoadNetwork {
  status: 'available' | 'unavailable';
  source_updated_at: string | null;
  bounds: [number, number, number, number] | null;
  roads: FeatureCollection<LineString, { edge_id: string; name: string; highway: string; way_id: number }>;
  rivers: FeatureCollection;
  blocked_edge_ids: string[];
  limitations: string[];
}
export interface SimulationRoadResult {
  id: string;
  status: 'routed' | 'blocked' | 'unreachable' | 'outside_network' | 'unavailable';
  coordinates: [number, number][];
  distance_km: number | null;
  duration_minutes: number | null;
  origin_snap: (RoadPoint & { distance_m: number }) | null;
  destination_snap: (RoadPoint & { distance_m: number }) | null;
  last_mile: 'unverified';
  reason: string | null;
  staging?: RoadPoint | null;
  deployment?: RoadPoint | null;
  departure_route?: Pick<SimulationRoadResult, 'status' | 'coordinates' | 'distance_km' | 'duration_minutes' | 'reason'> | null;
}
export interface SimulationRoadLeg {
  id: string;
  crewId: string;
  entry: ScheduleEntry;
  from: RoadPoint | null;
  to: RoadPoint | null;
  road?: SimulationRoadResult;
  /** Authored reinforcement vehicle; the saved assignment's crewId stays unchanged. */
  unitId?: string;
  unitLabel?: string;
  unitKind?: 'repair' | 'mobile-network' | 'network-crew' | 'hardening';
  coverageTowerIds?: string[];
}

/**
 * The `actions.yaml` key a pre-event hardening leg is labelled with. This is
 * the REAL flood work order — "Raise equipment cabinet, seal ingress,
 * clear/install drainage", civil crew, 4h — which is genuinely what
 * weatherproofing a site against flood ingress consists of.
 *
 * It is a LABEL here, not a solver commitment, and that distinction is the
 * whole reason the `harden` beat stays `illustrative`. Measured against the
 * live national run (2026-09-21): the optimizer emits 32
 * `raise_cabinet_and_seal` orders nationally and **none of them in Sabah** —
 * Sabah's 5 maintain-band entries are 3 `vegetation_clearance` and 2
 * `battery_genset_service`. Sabah's genuinely flood-dominant towers (flood
 * share 0.53-0.59) all sit in the `ok` band, so they never enter the
 * maintain run the optimizer schedules at all.
 *
 * That is the real shape of the gap: `propose_action()` emits flood work
 * from a tower's STANDING risk, and nothing in this codebase proposes
 * pre-emptive work because a storm is inbound — `flood/forecast.py` shortens
 * `urgency_days` and stops there (CLAUDE.md, "the live forecast enters at
 * urgency, never at risk"). A forecast-driven dispatch to an `ok`-band
 * tower has no mechanism behind it whatsoever.
 *
 * So: the towers, the crew, the depot and every metre of road geometry are
 * real; the DECISION to send anyone is scenario narration. The beat's
 * console line and the legend row both state that split rather than letting
 * routed vehicles imply a mechanism that does not exist.
 */
const HARDENING_ACTION = 'raise_cabinet_and_seal';
const HARDENING_LABEL = 'Raise equipment cabinet, seal ingress, clear/install drainage';

/** Cap on hardening vehicles drawn, matching `simulationResponseLegs`' own
 *  `Math.min(4, …)`. Four is a readable pre-event map; more vehicles at
 *  T-36h would also start implying a fleet-wide pre-emptive programme this
 *  run never commits to. */
const MAX_HARDENING_UNITS = 4;

/**
 * Pre-event site-hardening legs (the `harden` beat, T-36h).
 *
 * Selects by the tower's own STANDING flood attribution share, exactly as
 * `sabahFlood.ts`'s `generatorSiteSelector` does and for the same stated
 * reason: pre-positioning and pre-emptive hardening are both standing-risk
 * decisions taken before an event, not reactions to a flood polygon that
 * narratively has not been drawn yet at this beat's timestamp.
 *
 * Deliberately NOT read off the optimizer's entries — see `HARDENING_ACTION`
 * above for the measurement showing Sabah's maintain-band run contains no
 * flood work at all, so a filter over solver output selects nothing and the
 * convoy never appears. The synthesised `entry` carries the real flood
 * action and the real civil crew that WOULD do this work; it is scenario
 * geometry the optimizer was never asked to confirm, which is what the
 * beat's `illustrative` badge declares.
 *
 * Each site becomes its own unit, so crews fan out to separate towers
 * rather than one vehicle touring them. Ordering is deterministic (flood
 * share, then tower id) so a replay draws the same vehicles in the same
 * order.
 */
export function simulationHardeningLegs(
  towers: Tower[],
  crews: Crew[],
  day: string,
  inCorridor: (lon: number, lat: number) => boolean = () => true,
): SimulationRoadLeg[] {
  // The Sabah civil crew — hardening is civil work (cabinet risers,
  // sealant, drainage), never a power crew's genset service.
  const crew = crews.find(c => c.territory === 'Sabah' && c.crew_type === 'civil');
  if (!crew?.depot) return [];
  return towers
    // Bounded to the scenario's own flood corridor, not to Sabah at large.
    // Measured 2026-09-21: ranking all 62 Sabah towers by flood share puts
    // the top site at lon 118.10 — Sandakan, ~220 km east of the Kota
    // Kinabalu depot, outside both this scenario's corridor and the road
    // network `/travel/simulation-network` actually loads. Those legs route
    // to nothing and the convoy drives off-screen. A crew weatherproofing
    // sites ahead of THIS flood goes to sites THIS flood threatens.
    .filter(t => t.territory === 'Sabah' && (t.attribution.flood ?? 0) > 0
      && inCorridor(t.lon, t.lat))
    .sort((a, b) => (b.attribution.flood ?? 0) - (a.attribution.flood ?? 0)
      || a.tower_id.localeCompare(b.tower_id))
    .slice(0, MAX_HARDENING_UNITS)
    .map((tower, index) => {
      const unitId = `hardening-${index + 1}`;
      return {
        id: `${unitId}:${crew.crew_id}:${tower.tower_id}`,
        crewId: crew.crew_id,
        entry: {
          crew_id: crew.crew_id,
          day,
          order: index + 1,
          tower_id: tower.tower_id,
          pinned: false,
          work_order: {
            tower_id: tower.tower_id,
            action: HARDENING_ACTION,
            label: HARDENING_LABEL,
            crew_type: 'civil',
            priority: 0,
            urgency_days: 0,
            why: 'Scenario: pre-emptive flood hardening ahead of the forecast',
          },
        } as unknown as ScheduleEntry,
        from: { lon: crew.depot.lon, lat: crew.depot.lat },
        to: { lon: tower.lon, lat: tower.lat },
        unitId,
        unitLabel: `Civil crew ${index + 1}`,
        unitKind: 'hardening' as const,
      };
    });
}

/** Keep missing/unroutable assignments in place: a missing leg cannot teleport a crew to its next job. */
export function simulationRoadLegs(run: ScheduleRun | null, crews: Crew[], towers: Tower[], emergency: boolean, downIds: Set<string>): SimulationRoadLeg[] {
  const byId = new Map(towers.map(tower => [tower.tower_id, tower]));
  return crews.filter(crew => crew.territory === 'Sabah').flatMap(crew => {
    const entries = run?.entries.filter(entry => entry.crew_id === crew.crew_id && (!emergency || (entry.pin_reason === 'emergency' && downIds.has(entry.tower_id))))
      .sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order) ?? [];
    return entries.map(entry => {
      // Each grouped request starts from the real depot; the router advances
      // only after a reachable stop, including when a missing job was omitted.
      const origin = crew.depot;
      const destination = byId.get(entry.tower_id);
      return { id: `${crew.crew_id}:${entry.day}:${entry.order}:${entry.tower_id}`, crewId: crew.crew_id, entry,
        from: origin ? { lon: origin.lon, lat: origin.lat } : null,
        to: destination ? { lon: destination.lon, lat: destination.lat } : null };
    });
  });
}

/** Two fixed PRIME bases cover the southern and northern outage pockets. */
export function simulationResponseLegs(planned: SimulationRoadLeg[]): SimulationRoadLeg[] {
  const ordered = [...planned].sort((a, b) => (a.to?.lat ?? Infinity) - (b.to?.lat ?? Infinity)
    || (a.to?.lon ?? Infinity) - (b.to?.lon ?? Infinity) || a.id.localeCompare(b.id));
  const located = ordered.filter(leg => leg.to);
  if (!located.length) return [];
  const anchors = [located[0], located.at(-1)!];
  const mobile = anchors.map((leg, index) => ({ ...leg, id: `mobile-network-${index + 1}:${leg.id}`,
    unitId: `mobile-network-${index + 1}`, unitLabel: `PRIME ${index + 1}`, unitKind: 'mobile-network' as const,
    coverageTowerIds: located.filter(item => (haversineKm(anchors[0].to!, item.to!) <= haversineKm(anchors[1].to!, item.to!) ? 0 : 1) === index)
      .map(item => item.entry.tower_id) }));
  const crews = Array.from({ length: 4 }, (_, index) => {
    const leg = anchors[index < 2 ? 0 : 1];
    const unitId = `network-crew-${index + 1}`;
    return { ...leg, id: `${unitId}:${leg.id}`, unitId, unitLabel: `Network crew ${index + 1}`, unitKind: 'network-crew' as const };
  });
  return [...mobile, ...crews];
}

/** Scenario timing: maintenance and evacuation both finish before the water rises. */
export const HARDENING_START_MS = 15_000;
export const HARDENING_WORK_MS = 18_500;
export const HARDENING_EXIT_MS = 20_500;
export const HARDENING_SAFE_MS = 23_500;
export const HARDENING_END_MS = 54_000;
export const NETWORK_CREW_START_MS = 72_000;
export const NETWORK_CREW_ARRIVE_MS = 78_000;

/** Route geometry depends on the plan, never on a playback boundary. */
export function simulationRoadRequests(legs: SimulationRoadLeg[]) {
  return legs.filter(leg => leg.from && leg.to && leg.unitKind !== 'network-crew').flatMap(leg => {
    const request = { id: leg.id, from: leg.from!, to: leg.to!,
      sequence_group: leg.unitId ?? `${leg.crewId}:${leg.entry.day}`,
      stage_outside_flood: Boolean(leg.unitId) && leg.unitKind !== 'hardening',
      destination_outside_flood: Boolean(leg.unitId) && leg.unitKind !== 'hardening',
      avoid_flood: Boolean(leg.unitId) && leg.unitKind !== 'hardening' };
    return leg.unitKind === 'hardening' ? [request, { ...request, id: `${leg.id}:exit`,
      from: leg.to!, destination_outside_flood: true }] : [request];
  });
}

/** The southern pair holds; the moving pair follows extended dry approaches to the northern flood edge. */
export function simulationNetworkCrewPosts(prime: (SimulationRoadResult | undefined)[]) {
  // Mapped northern road origins add about 10km to each approach to the same flood-edge posts.
  const northernStarts = [{ lon: 116.1763966, lat: 6.1132752 }, { lon: 116.1780247, lat: 6.1264231 }];
  const coordinate = (road: SimulationRoadResult | undefined, fraction: number): RoadPoint | null => {
    if (road?.status !== 'routed' || !road.coordinates.length) return null;
    const point = road.coordinates[Math.round((road.coordinates.length - 1) * fraction)];
    return { lon: point[0], lat: point[1] };
  };
  return Array.from({ length: 4 }, (_, index) => {
    const from = index < 2 ? coordinate(prime[0], index === 0 ? 0.2 : 0.4)
      : prime[1]?.status === 'routed' ? northernStarts[index - 2] : null;
    return { from, to: index < 2 ? from : coordinate(prime[1], index === 2 ? 0.9 : 1) };
  });
}

/** Shared by the vehicle and its dispatch card; hold at the first inaccessible job that day. */
export function simulationRoadCrewAt(elapsedMs: number, emergency: boolean, legs: SimulationRoadLeg[], reducedMotion = false) {
  const fleet = Boolean(legs[0]?.unitId);
  const mobile = legs[0]?.unitKind === 'mobile-network';
  const hardening = legs[0]?.unitKind === 'hardening';
  const networkCrew = legs[0]?.unitKind === 'network-crew';
  const base = { placing: false, returning: false, departureHeld: false, deployed: false,
    working: false, exiting: false, stationary: false };
  if (hardening) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < HARDENING_START_MS || elapsedMs >= HARDENING_END_MS) return null;
    const leg = legs[0];
    // Never send a crew into the future flood without an assessed exit.
    const held = leg.road?.status !== 'routed' || leg.road.departure_route?.status !== 'routed';
    const returning = !held && elapsedMs >= HARDENING_EXIT_MS;
    const start = returning ? HARDENING_EXIT_MS : HARDENING_START_MS;
    const end = returning ? HARDENING_SAFE_MS : HARDENING_WORK_MS;
    const travel = held ? 0 : reducedMotion ? 1 : Math.max(0, Math.min(1, (elapsedMs - start) / (end - start)));
    return { ...base, leg, travel, held, staged: false, returning,
      working: !held && elapsedMs >= HARDENING_WORK_MS && elapsedMs < HARDENING_EXIT_MS,
      exiting: returning && elapsedMs < HARDENING_SAFE_MS, stationary: !held && elapsedMs >= HARDENING_SAFE_MS };
  }
  if (mobile || networkCrew) {
    if (!emergency || !Number.isFinite(elapsedMs) || elapsedMs < (networkCrew ? NETWORK_CREW_START_MS : 54_000)) return null;
    const leg = legs[0];
    const held = leg.road?.status !== 'routed';
    const remains = mobile || leg.unitId === 'network-crew-1' || leg.unitId === 'network-crew-2';
    const start = NETWORK_CREW_START_MS + (leg.unitId === 'network-crew-4' ? 400 : 0);
    const travel = held || remains ? 0 : reducedMotion ? 1 : Math.max(0, Math.min(1, (elapsedMs - start) / (NETWORK_CREW_ARRIVE_MS - start)));
    return { ...base, leg, travel, held, staged: !held && (mobile ? elapsedMs < 62_000 : remains),
      placing: mobile && !held && elapsedMs >= 62_000 && elapsedMs < 68_000,
      deployed: mobile && !held && elapsedMs >= 68_000,
      stationary: !held && (remains || elapsedMs >= NETWORK_CREW_ARRIVE_MS) };
  }
  const staged = fleet && elapsedMs < 58_000;
  if (fleet && (!emergency || !Number.isFinite(elapsedMs) || elapsedMs < 54_000 || elapsedMs >= 88_000)) return null;
  const step = simulationCrewStepAt(fleet ? 54_000 + Math.max(0, elapsedMs - 58_000) / 30_000 * 32_500 : elapsedMs, emergency, legs.length, reducedMotion);
  if (!step) return null;
  const current = legs[step.legIndex];
  const held = legs.slice(0, step.legIndex + 1).find(leg => (fleet || leg.entry.day === current.entry.day) && leg.road?.status !== 'routed');
  const travel = held || staged ? 0 : step.travel;
  return { ...base, leg: held ?? current, travel, held: Boolean(held), staged: staged && !held };
}
