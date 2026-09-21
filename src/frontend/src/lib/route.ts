import type { Crew, ScheduleEntry, Tower } from '../api/types';
import { haversineKm } from './geo';

/**
 * Turns a crew-day's schedule entries into a drawable route.
 *
 * The geography here was always being computed — EmergencyPanel and
 * UnscheduledBar both rank crews by haversine distance from depot to tower, and
 * whySlot renders the sentence "within N km of <depot>". None of it was ever
 * drawn. This module is the shared derivation so the map and that prose cannot
 * drift apart.
 *
 * Distances are straight-line, not driven. That matters for how the result is
 * labelled: `radiusUsePct` compares a straight line against `max_travel_km`,
 * which is a road budget, so the figure is a floor rather than a measurement.
 * Callers must not present it as the true utilisation.
 */

export interface RouteStop {
  tower_id: string;
  order: number;
  lon: number;
  lat: number;
  /** Undefined when the tower is unscored — the caller draws it neutral. */
  decision?: Tower['decision'];
  /** Straight-line km from the previous point (the depot, for the first stop). */
  legKm: number;
  /** Straight-line km from the depot, which is what max_travel_km bounds. */
  fromDepotKm: number;
}

export interface Route {
  depot: { lon: number; lat: number; name: string };
  stops: RouteStop[];
  /** Depot → stop₁ → … → stopₙ. Does not include the return leg. */
  totalKm: number;
  /** Farthest single stop from the depot — the value max_travel_km constrains. */
  maxFromDepotKm: number;
  maxTravelKm: number;
  /** Null when max_travel_km is missing or zero, rather than dividing by it. */
  radiusUsePct: number | null;
}

export function buildRoute(
  entries: ScheduleEntry[],
  crew: Crew,
  towersById: Map<string, Tower>,
): Route | null {
  if (!crew.depot) return null;

  const stops: RouteStop[] = [];
  let previous = { lon: crew.depot.lon, lat: crew.depot.lat };
  let totalKm = 0;
  let maxFromDepotKm = 0;

  // Sort by `order` rather than trusting arrival order. The grid already does
  // this; a route drawn in array order would silently disagree with the cell
  // it came from.
  const ordered = [...entries].sort((a, b) => a.order - b.order);

  for (const entry of ordered) {
    const tower = towersById.get(entry.tower_id);
    // A scheduled tower with no coordinates cannot be placed. Skipping it would
    // draw a leg straight past it and quietly understate the route, so the
    // whole route is refused instead.
    if (!tower) return null;

    const point = { lon: tower.lon, lat: tower.lat };
    const legKm = haversineKm(previous, point);
    const fromDepotKm = haversineKm(crew.depot, point);
    totalKm += legKm;
    if (fromDepotKm > maxFromDepotKm) maxFromDepotKm = fromDepotKm;

    stops.push({
      tower_id: entry.tower_id,
      order: entry.order,
      lon: tower.lon,
      lat: tower.lat,
      decision: tower.decision,
      legKm,
      fromDepotKm,
    });
    previous = point;
  }

  if (stops.length === 0) return null;

  const maxTravelKm = crew.max_travel_km ?? 0;

  return {
    depot: crew.depot,
    stops,
    totalKm,
    maxFromDepotKm,
    maxTravelKm,
    radiusUsePct: maxTravelKm > 0 ? (maxFromDepotKm / maxTravelKm) * 100 : null,
  };
}

/**
 * Bounding box of depot + every stop, padded so no marker sits on the edge.
 *
 * A single-stop route — which is 13 of the 14 offline fixture entries — has a
 * depot and one tower perhaps 15 km apart, and an unpadded box would clip both
 * markers in half. The pad is a fraction of the span with a floor, because the
 * degenerate case of a stop sitting exactly on its depot has zero span and
 * would otherwise produce an empty box MapLibre cannot fit.
 */
export function routeBounds(route: Route): [[number, number], [number, number]] {
  const lons = [route.depot.lon, ...route.stops.map((s) => s.lon)];
  const lats = [route.depot.lat, ...route.stops.map((s) => s.lat)];
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  const south = Math.min(...lats);
  const north = Math.max(...lats);

  const padLon = Math.max((east - west) * 0.25, 0.01);
  const padLat = Math.max((north - south) * 0.25, 0.01);

  return [
    [west - padLon, south - padLat],
    [east + padLon, north + padLat],
  ];
}
