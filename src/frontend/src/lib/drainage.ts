/**
 * A drainage corridor for the Sunway AOI, and each point's proximity to it.
 *
 * Why this exists: tower positions were uniform random draws and flood
 * attribution came from an unrelated `rand()` call, so position and flood risk
 * were independent by construction. Any flood surface drawn over that data —
 * a heatmap, a hex grid, a choropleth — would have been rendering the shape of
 * a random number generator while looking authoritative.
 *
 * The line below traces the Klang/Damansara corridor as it runs south-west
 * through Petaling Jaya and Subang. It is approximate, and it is NOT drawn on
 * the map: the basemap already shows the real watercourses, and a synthetic
 * river laid over real ones would be visibly wrong. It exists only as the
 * cause behind the flood factor, so that "low-lying ground floods" is a
 * statement the data actually supports.
 */

/** Lon/lat control points, north-east to south-west. */
export const DRAINAGE_LINE: [number, number][] = [
  [101.668, 3.138],
  [101.641, 3.116],
  [101.622, 3.094],
  [101.606, 3.073],
  [101.589, 3.055],
  [101.572, 3.032],
  [101.556, 3.004],
];

/**
 * Degrees of longitude are shorter than degrees of latitude away from the
 * equator, so comparing raw degree deltas would stretch the corridor
 * east-west. At 3°N the factor is ~0.9986 — negligible here, but the AOI is
 * small enough that an unscaled error would still bias which side of the line
 * a tower falls on.
 */
const LAT_REF = 3.07;
const LON_SCALE = Math.cos((LAT_REF * Math.PI) / 180);
const KM_PER_DEG = 111.32;

function pointToSegmentDeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const denom = abx * abx + aby * aby;
  // A degenerate segment (repeated control point) would divide by zero; fall
  // back to the endpoint distance rather than returning NaN, which would
  // silently poison every downstream share.
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / denom));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

/** Shortest distance from a point to the drainage corridor, in kilometres. */
export function distanceToDrainageKm(lon: number, lat: number): number {
  const px = lon * LON_SCALE;
  let best = Infinity;
  for (let i = 0; i < DRAINAGE_LINE.length - 1; i++) {
    const [alon, alat] = DRAINAGE_LINE[i];
    const [blon, blat] = DRAINAGE_LINE[i + 1];
    const d = pointToSegmentDeg(px, lat, alon * LON_SCALE, alat, blon * LON_SCALE, blat);
    if (d < best) best = d;
  }
  return best * KM_PER_DEG;
}

/**
 * Flood propensity from proximity to drainage, 1 on the corridor decaying to 0
 * away from it.
 *
 * Exponential rather than linear because flood exposure falls off sharply with
 * height above drainage — a tower 200 m from a river is in a different regime
 * from one 2 km away, while 6 km and 8 km are both simply "dry". A linear ramp
 * would spread the difference evenly and wash the corridor out.
 */
export function floodProximity(lon: number, lat: number): number {
  const DECAY_KM = 1.9;
  return Math.exp(-distanceToDrainageKm(lon, lat) / DECAY_KM);
}
