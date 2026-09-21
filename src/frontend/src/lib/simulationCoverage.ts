import { union } from '@turf/union';
import { difference } from '@turf/difference';
import { featureCollection } from '@turf/helpers';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import { circlePolygon } from './coverageGeometry.ts';
import { droneFlightAt } from './droneFlight.ts';
import { boundsOf } from './geo.ts';
import { pointInPolygon } from '../fixtures/scenarios/sabahFlood.ts';
import type { RoadPoint, SimulationRoadLeg } from './simulationRoads.ts';

/** Authored display radii, not measured radio propagation. */
export const OUTAGE_COVERAGE_RADIUS_KM = 3.5;
export const MOBILE_COVERAGE_RADIUS_KM = 3.5;

function footprint(points: RoadPoint[], radius: number): Feature<Polygon | MultiPolygon> | null {
  const circles: Feature<Polygon>[] = points.map(point => ({ type: 'Feature', properties: {}, geometry: circlePolygon(point, radius) }));
  return circles.length > 1 ? union(featureCollection(circles)) : circles[0] ?? null;
}

function polygons(shape: Feature<Polygon | MultiPolygon>) {
  return shape.geometry.type === 'Polygon' ? [shape.geometry.coordinates] : shape.geometry.coordinates;
}

/** Spherical polygon area; subtract holes and count overlapping outages only once. */
function areaKm2(shape: Feature<Polygon | MultiPolygon> | null): number {
  const rad = Math.PI / 180;
  return shape ? polygons(shape).reduce((total, rings) => total + rings.reduce((sum, ring, index) => {
    const area = Math.abs(ring.slice(1).reduce((value, point, i) => value
      + (point[0] - ring[i][0]) * rad * (Math.sin(point[1] * rad) + Math.sin(ring[i][1] * rad)), 0)) * 6371 ** 2 / 2;
    return sum + (index === 0 ? area : -area);
  }, 0), 0) : 0;
}

/** Spread relays over each connected outage area, including its outer boundary. */
function relayPositions(shape: Feature<Polygon | MultiPolygon>, sites: RoadPoint[]) {
  return polygons(shape).flatMap(rings => {
    const polygon: Feature<Polygon> = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } };
    const inside = (point: RoadPoint) => pointInPolygon(point.lon, point.lat, polygon.geometry)
      && !rings.slice(1).some(ring => pointInPolygon(point.lon, point.lat, { type: 'Polygon', coordinates: [ring] }));
    const members = sites.filter(inside);
    if (members.length === 1) return members;
    const boundary = rings[0].map(([lon, lat]) => ({ lon, lat }));
    const { west, east, south, north } = boundsOf(boundary)!;
    const origin = { lon: (west + east) / 2, lat: (south + north) / 2 };
    // ponytail: local Sabah projection; use a geodesic grid for continental scenarios.
    const kmLat = Math.PI * 6371 / 180, kmLon = kmLat * Math.cos(origin.lat * Math.PI / 180);
    const width = (east - west) * kmLon, height = (north - south) * kmLat;
    const point = (x: number, y: number): RoadPoint => ({ lon: origin.lon + x / kmLon, lat: origin.lat + y / kmLat });
    const edge = boundary.map(p => [(p.lon - origin.lon) * kmLon, (p.lat - origin.lat) * kmLat]);
    const radius = MOBILE_COVERAGE_RADIUS_KM;
    // A regular square grid covers the bounding box if no sparser staggered layout fits.
    const cell = radius * Math.SQRT2 * 0.99;
    const columns = Math.ceil(width / cell), rows = Math.ceil(height / cell);
    let best = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, col) =>
      point(width * ((col + 0.5) / columns - 0.5), height * ((row + 0.5) / rows - 0.5)))).flat();
    let bestInside = false;
    const minimum = Math.ceil(areaKm2(polygon) / (Math.PI * radius ** 2));
    // Try evenly spaced triangular lattices. Exact clipping rejects layouts with any red sliver.
    for (let scale = 17; scale >= 9 && best.length > minimum; scale--) {
      const dx = radius * scale / 10, dy = dx * Math.sqrt(3) / 2;
      for (let offsetX = 0; offsetX < 8; offsetX++) for (let offsetY = 0; offsetY < 8; offsetY++) {
        const candidates: { x: number; y: number; hover: RoadPoint }[] = [];
        for (let row = -Math.ceil(height / dy); row <= Math.ceil(height / dy); row++) {
          for (let col = -Math.ceil(width / dx); col <= Math.ceil(width / dx); col++) {
            const x = (col + (row % 2) / 2 + offsetX / 8) * dx, y = (row + offsetY / 8) * dy;
            const hover = point(x, y);
            if (inside(hover)) candidates.push({ x, y, hover });
          }
        }
        if (!candidates.length || candidates.length > best.length || (bestInside && candidates.length === best.length)) continue;
        const innerRadius = radius * Math.cos(Math.PI / 48) * 0.999;
        if (!edge.every(([x, y]) => candidates.some(c => (c.x - x) ** 2 + (c.y - y) ** 2 < innerRadius ** 2))) continue;
        const hovers = candidates.map(c => c.hover);
        if (!difference(featureCollection([polygon, footprint(hovers, radius)!]))) {
          best = hovers;
          bestInside = true;
        }
      }
    }
    return best;
  });
}

export function simulationDroneMissions(sites: (RoadPoint & { tower_id?: string })[], legs: SimulationRoadLeg[]) {
  const assigned = new Set<string>();
  return legs.filter(leg => leg.unitKind === 'mobile-network').toSorted((a, b) => (a.unitId ?? a.crewId).localeCompare(b.unitId ?? b.crewId)).flatMap(base => {
    if (base.road?.status !== 'routed' || !base.road.staging) return [];
    const ids = base.coverageTowerIds ?? [base.entry.tower_id];
    const members = sites.toSorted((a, b) => a.lat - b.lat || a.lon - b.lon).filter(site => {
      const key = `${site.lon}:${site.lat}`;
      if (!ids.includes(site.tower_id ?? '') || assigned.has(key)) return false;
      assigned.add(key);
      return true;
    });
    const shape = footprint(members, OUTAGE_COVERAGE_RADIUS_KM);
    if (!shape) return [];
    const unitId = base.unitId ?? base.crewId;
    return relayPositions(shape, members).map((hover, index) => ({ id: `${unitId}:drone:${index + 1}`, unitId,
      label: `${base.unitLabel ?? unitId} · drone ${index + 1}`, staging: base.road!.staging!, hover }));
  });
}

/**
 * Subtract arrived mobile footprints from outage areas; towers themselves
 * remain offline.
 *
 * Coverage is carried by the PRIME drone relay, not by a device on the
 * ground: while the flood stands the jeep holds at its outside-flood
 * staging point (MCMC practice — no ground crew through standing water,
 * enforced by the router's `avoid_flood`), so the relay flies to a hover
 * point over the gap and radiates from there. `droneFlightAt` decides when
 * that is true; a unit whose drone is still outbound or already recalled
 * contributes nothing, exactly as an unarrived ground device did.
 */
export function simulationCoverageAt(
  elapsedMs: number,
  // Tower assignments choose the launch vehicle; the union area chooses relay positions.
  downSites: (RoadPoint & { tower_id?: string })[],
  legs: SimulationRoadLeg[],
) {
  const missions = simulationDroneMissions(downSites, legs);
  const activeDrones = missions.filter(mission => droneFlightAt(elapsedMs, mission.staging, mission.hover)?.covering);
  const deployments = legs.filter(leg => activeDrones.some(mission => mission.unitId === (leg.unitId ?? leg.crewId)));
  const outage = footprint(downSites, OUTAGE_COVERAGE_RADIUS_KM);
  const gap = elapsedMs >= 27_000 && elapsedMs < 80_000 ? outage : null;
  // The map flies these exact missions; coverage cannot appear where no relay is on station.
  const reach = activeDrones.length
    ? footprint(activeDrones.map(mission => mission.hover), MOBILE_COVERAGE_RADIUS_KM)
    : null;
  const remaining = gap && reach ? difference(featureCollection([gap, reach])) : gap;
  const supported = gap && reach ? remaining ? difference(featureCollection([gap, remaining])) : gap : null;
  return { gap, remaining, supported, reach, missions, activeDrones, deployments, affectedCount: downSites.length, areaKm2: areaKm2(outage) };
}
