export interface PointBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Bounding box of a set of points, or null when there are none.
 *
 * Null rather than a zeroed box: an empty selection has no extent, and
 * {0,0,0,0} is a real place in the Gulf of Guinea that a camera would happily
 * fly to. Callers have to handle the absence.
 *
 * Degenerate boxes come back as-is — two towers 400 m apart really do span
 * almost nothing, and inventing a minimum extent here would hide that from the
 * caller. Framing a degenerate box is the camera's problem, and MapLibre's
 * fitBounds solves it with maxZoom.
 *
 * No antimeridian handling. Every tower in this dataset is between 99E and
 * 119E; a box that wrapped 180 would need a different type, not a wider one.
 */
export function boundsOf(points: { lon: number; lat: number }[]): PointBounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

export function haversineKm(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
