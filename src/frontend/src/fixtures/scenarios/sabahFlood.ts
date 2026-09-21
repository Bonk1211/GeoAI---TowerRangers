import type { Polygon } from 'geojson';
import type { Tower } from '../../api/types';

/**
 * The Sabah flood scenario definition. `docs/Disaster_Simulation_Spec.md` §12.
 *
 * `downTowerSelector` is a FUNCTION over the live population, never a
 * hardcoded id list — tower ids come from OpenStreetMap and a hardcoded id
 * that vanishes on the next `data/malaysia` rebuild would break the demo
 * silently. Selecting by geography (inside the flood polygon) and band
 * (highest flood-share among the maintain/watch set) keeps the scenario
 * alive across a data refresh.
 *
 * Flood polygons are hand-authored, coarse, and labelled as scenario premise
 * everywhere they render (never as an observation) — they approximate the
 * real **July 2024** event's affected districts (Penampang, Kota Kinabalu,
 * Tuaran, Kota Marudu — 41 transmission towers down per MCMC/Bernama, see
 * `docs/Disaster_Response_Actions.md`) at a resolution appropriate for a
 * console-sized map, not at survey accuracy. The September 2025 event (266
 * towers, 6 districts) is the larger, later flood cited alongside it in that
 * doc's timeline — this scenario's geometry and beat numbers follow the
 * July 2024 event specifically because it is the one with district-level
 * tower counts AND a cause breakdown (power cut by utility vs flooded road
 * vs equipment damage), which is what makes a beat table defensible rather
 * than invented.
 */

export interface FloodExtentFrame {
  /** Offset from run start, in ms, matching the beat this extent should be
   *  visible from — the caller looks up the LATEST frame whose atMs has
   *  passed, the same pattern as `beatsUpTo`. */
  atMs: number;
  /** `null` (2026-09-17) means fully receded — the honest end state of a
   *  recession, distinct from "no frame has fired yet" (which `floodExtentAt`
   *  already represents as `null` before the first frame's `atMs`). Both
   *  cases render identically (no flood shading), which is correct: "not
   *  arrived yet" and "arrived, then receded" are visually the same ground
   *  truth at the moment either holds. */
  polygon: Polygon | null;
}

export interface Scenario {
  id: 'sabah-flood-2024';
  label: string;
  territory: 'Sabah';
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  floodExtents: FloodExtentFrame[];
  downTowerSelector: (towers: Tower[]) => string[];
  /** Higher-ground sites where civil crews pre-position backup power. */
  generatorSiteSelector: (towers: Tower[]) => string[];
}

/** Ring helper: closes the polygon by repeating the first point, which
 *  GeoJSON requires and is easy to forget when hand-authoring coordinates. */
function ring(points: [number, number][]): Polygon {
  return { type: 'Polygon', coordinates: [[...points, points[0]]] };
}

/**
 * Standard ray-casting point-in-polygon test, single ring only (every
 * polygon in this file is a simple hand-authored ring with no holes).
 * `selectDownTowers` needs this rather than the scenario's outer bbox
 * (`SCENARIO_BOUNDS`) — the bbox is a coarse rectangle covering the whole
 * KK/Penampang/Putatan corridor, far larger than the drawn flood shape, so
 * a tower could be "in bounds" and picked as down while sitting nowhere
 * near the polygon the map actually shades blue. That shipped as a visible
 * bug: an OFFLINE tower with the flood extent nowhere near it on screen.
 */
export function pointInPolygon(lon: number, lat: number, polygon: Polygon): boolean {
  const ringPoints = polygon.coordinates[0];
  let inside = false;
  for (let i = 0, j = ringPoints.length - 1; i < ringPoints.length; j = i++) {
    const [xi, yi] = ringPoints[i];
    const [xj, yj] = ringPoints[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Coarse footprint over the KK west-coast / Penampang corridor. Authored
// from the districts named in docs/Disaster_Response_Actions.md, at a scale
// that reads on a console map, not a surveyed inundation extent.
//
// Redrawn (2026-09-16) to enclose the FULL real Sabah tower cluster, not
// just its southern edge. The live /towers population (queried 2026-09-16)
// carries 25 Sabah towers between lon 116.067-116.125, lat 5.953-6.071 —
// two sub-groups roughly 7 towers around lat 5.95-6.00 (nearer KK/Bundusan)
// and roughly 18 towers around lat 6.065-6.071 (further north, nearer
// Menggatal/Telipok — this project's tower positions are OSM points, not
// operator sites, so "which named village" is illustrative). The previous
// revision (2026-09-15) fixed SMALL_EXTENT touching zero towers but only
// widened it far enough to catch the southern 7; the northern 18 (72% of
// the cluster) still sat outside both rings, which is why the scenario
// could only ever produce 2-4 down towers against a real event's 41.
// Irregular many-point rings rather than rectangles — a flood plain is not
// a box, and a hard rectangle reads as fabricated precision. SMALL_EXTENT
// covers the southern sub-group (flood onset, near-shore); FULL_EXTENT
// grows north to cover both, matching the real event's multi-day spread
// across Penampang into the KK fringe.
const SMALL_EXTENT = ring([
  [116.05, 5.965],
  [116.062, 5.975],
  [116.08, 5.978],
  [116.1, 5.975],
  [116.118, 5.965],
  [116.122, 5.953],
  [116.105, 5.943],
  [116.08, 5.938],
  [116.058, 5.943],
  [116.045, 5.953],
]);

const FULL_EXTENT = ring([
  [116.04, 5.96],
  [116.055, 5.985],
  [116.075, 5.995],
  [116.095, 5.998],
  [116.11, 6.01],
  [116.115, 6.04],
  [116.118, 6.065],
  [116.128, 6.078],
  [116.135, 6.06],
  [116.132, 6.03],
  [116.128, 5.995],
  [116.125, 5.965],
  [116.115, 5.94],
  [116.09, 5.925],
  [116.06, 5.928],
  [116.038, 5.94],
]);

/** Scenario capacity, not the historical event's tower count. */
const MAX_DOWN_TOWERS = 12;
// Match the four civil maintenance units visible before flood onset.
const MAX_GENERATOR_SITES = 4;

/** Reuse the warning panel's low-ground threshold; this is an authored
 * placement rule, not a measured flood depth or a field safety assessment. */
function generatorSuitable(tower: Tower): boolean {
  return Number.isFinite(tower.hand_m) && tower.hand_m! > 5;
}

function floodPriority(a: Tower, b: Tower): number {
  return (b.attribution.flood ?? 0) - (a.attribution.flood ?? 0)
    || a.tower_id.localeCompare(b.tower_id);
}

/** Low or unassessed ground cannot host a generator in this scenario.
 * Select outages here so map marks, dispatch and drone coverage all agree. */
function selectDownTowers(towers: Tower[]): string[] {
  return towers
    .filter(t => t.territory === 'Sabah' && pointInPolygon(t.lon, t.lat, FULL_EXTENT)
      && !generatorSuitable(t))
    .sort(floodPriority)
    .slice(0, MAX_DOWN_TOWERS)
    .map(t => t.tower_id);
}

/** Civil crews prepare higher-ground sites within this flood corridor.
 * Missing terrain data never establishes suitability for backup power. */
function selectGeneratorSites(towers: Tower[]): string[] {
  return towers
    // Operator excluded this northern Telipok/Menggatal site from generator placement.
    .filter(t => t.tower_id !== 'MY_N12462360044')
    .filter(t => t.territory === 'Sabah' && pointInPolygon(t.lon, t.lat, FULL_EXTENT)
      && (t.attribution.flood ?? 0) > 0 && generatorSuitable(t))
    .sort(floodPriority)
    .slice(0, MAX_GENERATOR_SITES)
    .map(t => t.tower_id);
}

const SCENARIO_BOUNDS: [number, number, number, number] = [115.95, 5.82, 116.2, 6.12];

export const SABAH_FLOOD_SCENARIO: Scenario = {
  id: 'sabah-flood-2024',
  label: 'Sabah flood — Jul 2024',
  territory: 'Sabah',
  bounds: SCENARIO_BOUNDS,
  // FULL_EXTENT must be showing by the time `tower-down` fires (27000ms),
  // since `selectDownTowers` now tests against FULL_EXTENT (2026-09-16) to
  // reach the wider 25-tower cluster instead of SMALL_EXTENT's 7 — a down
  // tower drawn while the map still shows only the small early polygon
  // would visibly sit outside the blue shape, the exact bug the original
  // SMALL_EXTENT-alignment comment (still on `selectDownTowers` above)
  // existed to avoid. Growth now completes at 26000ms, ahead of 27000.
  //
  // Recession added 2026-09-17 (operator review: "after T+36 the flood
  // should drop off"). The map's flood extent grew and then simply stayed
  // FULL for the rest of a 96-second run, including past the beats that
  // narrate recovery — 'restore' (T+24h, a tower comes back), 'withdraw'
  // (T+36h, COWs stand down, sectors return to nominal) and 'ledger' (T+48h,
  // outcome recorded) all fired over a map still showing the flood at its
  // worst, which contradicts the very narration playing over it. Recedes in
  // reverse of onset — FULL back to SMALL at 'withdraw' (T+36h), matching
  // the operator's own stated beat; SMALL down to nothing at 'ledger'
  // (T+48h), so the map is dry by the time the run reports its outcome.
  // SMALL_EXTENT genuinely covers the southern, near-shore sub-cluster
  // (see that constant's own comment) while FULL_EXTENT additionally
  // covers the northern, further-inland Menggatal/Telipok group — so this
  // recession order (north drains first, near-shore lingers longest) is
  // the plausible hydrological direction, not an arbitrary reversal of the
  // onset frames for its own sake.
  floodExtents: [
    { atMs: 24000, polygon: SMALL_EXTENT }, // flood-onset beat — southern sub-cluster first
    { atMs: 26000, polygon: FULL_EXTENT }, // grows north before tower-down fires
    { atMs: 88000, polygon: SMALL_EXTENT }, // withdraw beat (T+36h) — north recedes first
    { atMs: 96000, polygon: null }, // ledger beat (T+48h) — dry by the closing beat
  ],
  downTowerSelector: selectDownTowers,
  generatorSiteSelector: selectGeneratorSites,
};

/** The extent visible at `elapsedMs`, or `null` before onset. Mirrors
 *  `beatsUpTo`'s "latest frame whose time has passed" logic. */
export function floodExtentAt(elapsedMs: number): Polygon | null {
  let current: Polygon | null = null;
  for (const frame of SABAH_FLOOD_SCENARIO.floodExtents) {
    if (elapsedMs >= frame.atMs) current = frame.polygon;
  }
  return current;
}
