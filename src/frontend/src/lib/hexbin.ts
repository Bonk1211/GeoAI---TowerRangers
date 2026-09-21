import type { Feature, FeatureCollection, Polygon } from 'geojson';

/**
 * Aggregate scored towers into a hex grid, one mean factor share per cell.
 *
 * Hexagons rather than Voronoi polygons: a Voronoi cell would tessellate the
 * whole AOI and hand every tower a territory it has no authority over, which
 * reads as a zoning map drawn by the model. A hex is a fixed, arbitrary
 * container — it claims nothing about where influence ends, and it can report
 * how many towers it actually holds, so a cell built on one sample is visibly
 * weaker than one built on twelve.
 */

export interface HexCell {
  /** Mean share of the chosen factor across the towers in this cell, 0–1. */
  mean: number;
  /** How many towers the mean is computed from. */
  count: number;
}

export interface HexbinPoint {
  lon: number;
  lat: number;
  value: number;
}

const LAT_REF = 3.07;
const LON_SCALE = Math.cos((LAT_REF * Math.PI) / 180);

/** Cube-rounds fractional axial coordinates to the nearest hex centre. */
function axialRound(q: number, r: number): [number, number] {
  const x = q;
  const z = r;
  const y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  // Discard whichever axis moved furthest, so the three cube coordinates still
  // sum to zero — rounding all three independently would drift off the lattice
  // and produce overlapping or gapped cells.
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return [rx, rz];
}

function hexCentre(q: number, r: number, radius: number): [number, number] {
  return [radius * Math.sqrt(3) * (q + r / 2), radius * 1.5 * r];
}

function hexRing(cx: number, cy: number, radius: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i + 30);
    pts.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  pts.push(pts[0]);
  return pts;
}

/**
 * @param radiusDeg Hex circumradius in degrees of latitude. Larger cells mean
 *   steadier means and a coarser picture; the caller picks the trade.
 * @param minCount Cells holding fewer towers than this are dropped rather than
 *   drawn pale. A one-tower cell is a single reading, not a regional estimate,
 *   and drawing it invites reading a coloured area as evidence.
 */
export function hexbin(
  points: HexbinPoint[],
  radiusDeg: number,
  minCount = 2,
): FeatureCollection<Polygon, HexCell> {
  const buckets = new Map<string, { sum: number; count: number; q: number; r: number }>();

  for (const p of points) {
    const x = p.lon * LON_SCALE;
    const y = p.lat;
    const qf = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / radiusDeg;
    const rf = ((2 / 3) * y) / radiusDeg;
    const [q, r] = axialRound(qf, rf);
    const key = `${q},${r}`;
    const b = buckets.get(key) ?? { sum: 0, count: 0, q, r };
    b.sum += p.value;
    b.count += 1;
    buckets.set(key, b);
  }

  const features: Feature<Polygon, HexCell>[] = [];
  for (const b of buckets.values()) {
    if (b.count < minCount) continue;
    const [cx, cy] = hexCentre(b.q, b.r, radiusDeg);
    const ring = hexRing(cx, cy, radiusDeg).map(
      ([x, y]) => [x / LON_SCALE, y] as [number, number],
    );
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { mean: b.sum / b.count, count: b.count },
    });
  }

  return { type: 'FeatureCollection', features };
}
