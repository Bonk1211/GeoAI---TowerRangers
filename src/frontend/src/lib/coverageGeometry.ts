import type { LineString, Polygon } from 'geojson';

/**
 * Pure trig for the Disaster Simulation's coverage-gap and sector-cone
 * geometry. `docs/Disaster_Simulation_Spec.md` §4, §9.
 *
 * No React, no MapLibre — this module only computes bearings and polygons.
 * Everything it returns is display geometry, explicitly labelled
 * illustrative wherever it renders (spec §8): a sector cone's bearing here
 * is invented, not measured, because this project holds no sector-level RF
 * data to compute a real one (`docs/Disaster_Response_Actions.md`).
 */

const EARTH_RADIUS_KM = 6371;

export interface LonLat {
  lon: number;
  lat: number;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Initial bearing from `a` to `b`, in degrees clockwise from true north,
 * in `[0, 360)`. Returns `0` (rather than `NaN`) when `a` and `b` are the
 * same point — there is no defined direction between identical points, and
 * a caller animating a cone toward "nowhere" is better served by a stable
 * fallback than a poisoned value that propagates into every downstream
 * calculation.
 */
export function bearingDeg(a: LonLat, b: LonLat): number {
  if (a.lon === b.lon && a.lat === b.lat) return 0;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  // Antimeridian-safe: the raw longitude difference is never normalised
  // separately, because atan2(y, x) below already handles the wrap — a
  // point at 179.9 and one at -179.9 differ by 0.2 degrees of true bearing,
  // and atan2 resolves that correctly from dLon = -359.8 without any extra
  // modulo step.
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

/** Destination point `distanceKm` from `origin` along `bearing` degrees. */
export function destination(origin: LonLat, bearing: number, distanceKm: number): LonLat {
  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const bearingRad = toRad(bearing);
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearingRad),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lon: toDeg(lon2), lat: toDeg(lat2) };
}

/**
 * A circular footprint around `center`, as a GeoJSON polygon. Used for the
 * coverage-gap dead-zone mark — a coarse illustrative radius, never a
 * calibrated RF propagation model (explicitly out of scope, spec §15).
 */
export function circlePolygon(center: LonLat, radiusKm: number, steps = 48): Polygon {
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (360 * i) / steps;
    const point = destination(center, bearing, radiusKm);
    coords.push([point.lon, point.lat]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

/**
 * A pie-slice sector polygon: `center`, opening at `bearingDeg` with a
 * `widthDeg` spread, out to `radiusKm`. Used for the sector-cone visual —
 * a neighbouring tower's illustrative retuned coverage, per spec §9's
 * "animate the bearing value, regenerate the cone polygon per frame".
 */
export function sectorPolygon(
  center: LonLat,
  bearing: number,
  widthDeg: number,
  radiusKm: number,
  steps = 16,
): Polygon {
  const half = widthDeg / 2;
  const coords: [number, number][] = [[center.lon, center.lat]];
  for (let i = 0; i <= steps; i++) {
    const b = bearing - half + (widthDeg * i) / steps;
    const point = destination(center, b, radiusKm);
    coords.push([point.lon, point.lat]);
  }
  coords.push([center.lon, center.lat]);
  return { type: 'Polygon', coordinates: [coords] };
}

/**
 * A curved line between two points, bowed toward `bowSide` by
 * `bowFraction` of the straight-line distance. Used for the crew-dispatch
 * route line — the dispatch itself is real optimizer output, but this
 * project holds no road-network geometry (only measured travel minutes/km,
 * `docs/Backend_Handoff.md`'s travel matrix), so a literal straight line
 * would read as a claimed road path it is not. A single bowed quadratic
 * curve reads as "a route" without asserting a specific road shape.
 */
export function curvedLine(from: LonLat, to: LonLat, bowFraction = 0.12, steps = 32): LineString {
  const control = curveControl(from, to, bowFraction);

  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Quadratic Bezier through from -> control -> to.
    const lon = (1 - t) ** 2 * from.lon + 2 * (1 - t) * t * control.lon + t ** 2 * to.lon;
    const lat = (1 - t) ** 2 * from.lat + 2 * (1 - t) * t * control.lat + t ** 2 * to.lat;
    coords.push([lon, lat]);
  }
  return { type: 'LineString', coordinates: coords };
}

/** Point at parameter `t` (0..1) along the same quadratic curve `curvedLine`
 *  draws, for animating a marker along it rather than in a straight line. */
export function pointOnCurve(from: LonLat, to: LonLat, t: number, bowFraction = 0.12): LonLat {
  const control = curveControl(from, to, bowFraction);
  const lon = (1 - t) ** 2 * from.lon + 2 * (1 - t) * t * control.lon + t ** 2 * to.lon;
  const lat = (1 - t) ** 2 * from.lat + 2 * (1 - t) * t * control.lat + t ** 2 * to.lat;
  return { lon, lat };
}

/** Shared control point for `curvedLine`/`pointOnCurve`'s quadratic Bezier —
 *  offset perpendicular to the from->to bearing by `bowFraction` of the
 *  straight-line distance, so both functions trace the identical curve. */
function curveControl(from: LonLat, to: LonLat, bowFraction: number): LonLat {
  const R = EARTH_RADIUS_KM;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
  const distanceKm = 2 * R * Math.asin(Math.sqrt(a));

  const bearing = bearingDeg(from, to);
  const midLon = (from.lon + to.lon) / 2;
  const midLat = (from.lat + to.lat) / 2;
  return destination({ lon: midLon, lat: midLat }, bearing + 90, distanceKm * bowFraction);
}
