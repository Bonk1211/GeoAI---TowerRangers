import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSimulation } from '../../state/useSimulation';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useCrewsQuery } from '../../api/queries';
import { apiUrl } from '../../api/client';
import { simulationRoadLegs, simulationResponseLegs, simulationHardeningLegs, simulationRoadRequests, simulationNetworkCrewPosts, type SimulationRoadNetwork, type SimulationRoadResult } from '../../lib/simulationRoads';
import { floodExtentAt, pointInPolygon } from '../../fixtures/scenarios/sabahFlood';
import { simulationCoverageAt } from '../../lib/simulationCoverage';

async function readRoads<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), { signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('Road access could not be assessed.');
  return response.json();
}

/** One road assessment shared by the map, vehicles and dispatch cards. */
export function useSimulationRoads() {
  const elapsedMs = useSimulation(s => Math.floor(s.elapsedMs / 1000) * 1000);
  const runSeq = useSimulation(s => s.runSeq);
  const optimizeRun = useSimulation(s => s.optimizeRun);
  const emergencyRun = useSimulation(s => s.emergencyRun);
  const downIds = useSimulation(s => s.downTowerIds);
  const generatorIds = useSimulation(s => s.generatorSiteIds);
  const weights = useWeights(s => s.weights);
  const { towers } = useLiveTowers(weights);
  const { data: crews = [] } = useCrewsQuery();
  const emergency = elapsedMs >= 54_000;
  const responsePlan = elapsedMs >= 54_000;
  const network = useQuery({ queryKey: ['simulation-road-network', runSeq],
    queryFn: ({ signal }) => readRoads<SimulationRoadNetwork>('/travel/simulation-network', signal), staleTime: Infinity, retry: 1 });
  // Assess the complete maintenance/exit route before the convoy appears.
  const planned = useMemo(() => {
    const saved = simulationRoadLegs(responsePlan ? emergencyRun : optimizeRun, crews, towers, responsePlan, downIds);
    if (responsePlan) return simulationResponseLegs(saved);
    // Anchored to the optimize run's own first horizon day when there is
    // one, so the hardening legs sit on the same date the rest of the
    // pre-event board is drawn against rather than inventing a calendar.
    // Bounded to the flood extent the scenario will actually draw, so the
    // convoy drives to sites inside the corridor the beat is about — and
    // inside the road network this simulation loads. `floodExtentAt(26_000)`
    // is the same FULL_EXTENT the down-tower selector tests against.
    const corridor = floodExtentAt(26_000);
    const hardening = simulationHardeningLegs(towers.filter(tower => generatorIds.has(tower.tower_id)), crews, optimizeRun?.horizon?.[0] ?? '',
      corridor ? (lon, lat) => pointInPolygon(lon, lat, corridor) : undefined);
    // Falls back to the plain optimizer legs rather than emptying the
    // pre-event map — if no Sabah tower carries a flood share, the honest
    // picture is the real assignments, not a blank frame.
    return hardening.length ? hardening : saved;
  }, [responsePlan, emergencyRun, optimizeRun, crews, towers, downIds, generatorIds]);
  const requests = simulationRoadRequests(planned);
  const blocked = elapsedMs >= 24_000 && elapsedMs < 88_000 ? network.data?.blocked_edge_ids ?? [] : [];
  // Keep the same assessed geometry through both flood onset and restoration.
  const routeBlocked = responsePlan ? network.data?.blocked_edge_ids ?? [] : [];
  const routes = useQuery({ queryKey: ['simulation-road-routes', runSeq, requests, routeBlocked],
    queryFn: ({ signal }) => readRoads<{ legs: SimulationRoadResult[] }>('/travel/simulation-routes', signal, {
      legs: requests, blocked_edge_ids: routeBlocked, flood_polygon: floodExtentAt(26_000),
    }),
    enabled: requests.length > 0 && network.data?.status === 'available', staleTime: Infinity, retry: 1 });
  const primary = routes.data?.legs;
  const prime = planned.filter(leg => leg.unitKind === 'mobile-network')
    .map(leg => primary?.find(road => road.id === leg.id));
  const posts = simulationNetworkCrewPosts(prime);
  const networkLegs = planned.filter(leg => leg.unitKind === 'network-crew');
  const crewRequests = networkLegs.flatMap((leg, index) => {
    const { from, to } = posts[index];
    return index >= 2 && from && to ? [{ id: leg.id, from, to, sequence_group: leg.unitId, avoid_flood: true }] : [];
  });
  const crewRoutes = useQuery({ queryKey: ['simulation-network-crew-routes', runSeq, crewRequests, routeBlocked],
    queryFn: ({ signal }) => readRoads<{ legs: SimulationRoadResult[] }>('/travel/simulation-routes', signal, {
      legs: crewRequests, blocked_edge_ids: routeBlocked, flood_polygon: floodExtentAt(26_000),
    }), enabled: crewRequests.length > 0 && network.data?.status === 'available', staleTime: Infinity, retry: 1 });
  const unavailable = network.isError || network.data?.status === 'unavailable' || routes.isError;
  const { assignments, deferred, legs } = useMemo(() => {
    const results = new Map(routes.data?.legs.map(leg => [leg.id, leg]));
    const crewResults = new Map(crewRoutes.data?.legs.map(leg => [leg.id, leg]));
    const prime = planned.filter(leg => leg.unitKind === 'mobile-network').map(leg => results.get(leg.id));
    const posts = simulationNetworkCrewPosts(prime);
    const assignments = planned.map(leg => {
      let road = results.get(leg.id);
      let crewPost = null;
      if (leg.unitKind === 'hardening' && road) {
        const exit = results.get(`${leg.id}:exit`);
        road = { ...road, departure_route: exit ?? null };
        if (road.status === 'routed' && exit?.status !== 'routed') road = { ...road,
          status: 'blocked', coordinates: [], reason: 'No assessed evacuation route; civil crew holds before entering the site.' };
      }
      if (leg.unitKind === 'mobile-network' && road?.status === 'routed' && road.staging) {
        road = { ...road, coordinates: [[road.staging.lon, road.staging.lat]],
          deployment: road.staging, distance_km: 0, duration_minutes: 0, departure_route: null };
      }
      if (leg.unitKind === 'network-crew') {
        const index = Number(leg.unitId?.split('-').at(-1)) - 1;
        const base = prime[index < 2 ? 0 : 1];
        const post = posts[index]?.from;
        crewPost = post;
        const remains = leg.unitId === 'network-crew-1' || leg.unitId === 'network-crew-2';
        const routed = crewResults.get(leg.id);
        road = post && remains && base ? { ...base, id: leg.id, coordinates: [[post.lon, post.lat]],
          staging: post, deployment: post, distance_km: 0, duration_minutes: 0, departure_route: null }
          : post && routed ? { ...routed, staging: post } : undefined;
        if (!road && post && base && crewRoutes.isError) road = { ...base, id: leg.id, status: 'unavailable',
          staging: post, coordinates: [], deployment: null, departure_route: null,
          reason: 'Road assessment failed; crew remains at its mapped dry post.' };
      }
      const staged = leg.unitId && leg.unitKind !== 'hardening';
      return { ...leg, from: staged ? road?.staging ?? crewPost ?? null : leg.from, road };
    });
    const deferred = assignments.filter(leg => unavailable || !leg.from || !leg.to
      || (leg.road && leg.road.status !== 'routed') || (leg.unitKind === 'network-crew' && crewRoutes.isError && !leg.road));
    // Held units stay at their known origin even while a road request is pending.
    return { assignments, deferred, legs: assignments };
  }, [routes.data, crewRoutes.data, crewRoutes.isError, planned, unavailable]);
  // Polygon clipping only changes at outage/arrival/restoration boundaries, not on vehicle frames.
  const coverageTime = elapsedMs < 27_000 ? 0 : elapsedMs < 68_000 ? 27_000 : elapsedMs < 80_000 ? 68_000 : elapsedMs < 88_000 ? 80_000 : 88_000;
  const coverage = useMemo(() => simulationCoverageAt(coverageTime, towers.filter(tower => downIds.has(tower.tower_id)), unavailable ? [] : assignments),
    [coverageTime, towers, downIds, unavailable, assignments]);
  return { network: network.data, legs, assignments, deferred, emergency, blocked, coverage,
    loading: network.isLoading || (requests.length > 0 && routes.isFetching) || (crewRequests.length > 0 && crewRoutes.isFetching),
    unavailable };
}
export type SimulationRoadState = ReturnType<typeof useSimulationRoads>;
