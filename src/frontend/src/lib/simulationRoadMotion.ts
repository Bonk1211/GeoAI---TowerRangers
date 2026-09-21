import { haversineKm } from './geo.ts';
import type { SimulationRoadLeg } from './simulationRoads';

export function prepareRoadMotion(coordinates: [number, number][]) {
  if (!coordinates.length || coordinates.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90)) return null;
  const distances = [0];
  for (let i = 1; i < coordinates.length; i++) {
    const [lon, lat] = coordinates[i];
    const [previousLon, previousLat] = coordinates[i - 1];
    distances.push(distances[i - 1] + haversineKm({ lon: previousLon, lat: previousLat }, { lon, lat }));
  }
  return { coordinates, distances };
}

/** Interpolate only within road segments: splines can cut across bends and inaccessible land. */
export function roadPositionAt(road: NonNullable<ReturnType<typeof prepareRoadMotion>>, progress: number) {
  const { coordinates, distances } = road;
  const distance = distances[distances.length - 1] * Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  let low = 1;
  let high = coordinates.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (distances[mid] <= distance) low = mid + 1;
    else high = mid;
  }
  let end = Math.min(low, coordinates.length - 1);
  while (end > 1 && distances[end] === distances[end - 1]) end--;
  const start = Math.max(0, end - 1);
  const segment = distances[end] - distances[start];
  const part = segment > 0 ? (distance - distances[start]) / segment : 0;
  const from = coordinates[start];
  const to = coordinates[end];
  return { lon: from[0] + (to[0] - from[0]) * part, lat: from[1] + (to[1] - from[1]) * part, from, to };
}

/** An unavailable leg leaves the crew at its last mapped endpoint, never at the next tower. */
export function roadHoldPoint(legs: SimulationRoadLeg[], held: SimulationRoadLeg) {
  const sameDay = legs.filter(leg => held.unitId ? leg.unitId === held.unitId : leg.entry.day === held.entry.day);
  // Hardening units fall back to their depot origin like an ordinary crew:
  // they are routed without `stage_outside_flood` (no flood exists at
  // T-36h), so they have no staging point to hold at and reading one would
  // park a blocked vehicle at null instead of at the depot it left from.
  const staged = held.unitId && held.unitKind !== 'hardening';
  let point = staged ? sameDay[0]?.road?.staging ?? (held.unitKind === 'network-crew' ? sameDay[0]?.from : null) ?? null : sameDay[0]?.from ?? null;
  for (const leg of sameDay) {
    if (leg === held || leg.road?.status !== 'routed') break;
    const endpoint = leg.road.coordinates.at(-1);
    if (!endpoint) break;
    point = { lon: endpoint[0], lat: endpoint[1] };
  }
  return point;
}
