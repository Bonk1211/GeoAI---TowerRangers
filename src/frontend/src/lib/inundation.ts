import type { Tower } from '../api/types';

/**
 * Flood stage as a scenario, not a forecast.
 *
 * A stage of h metres means "water standing h metres above the nearest
 * drainage". A site is inside that stage when its HAND — height above nearest
 * drainage, measured per tower in the pilot feature table and served as
 * `hand_m` — is at or below h. That is a statement about terrain: it says which
 * ground sits below a given water level, and nothing about whether the level
 * will occur or what would happen to anything standing there.
 *
 * Pure and dependency-free, so it can be checked with a short node script — the
 * closest thing to a unit test this frontend has.
 */

/**
 * Stage ladder, metres above nearest drainage.
 *
 * Mirrors STAGES_M in src/backend/data/prepare_flood_surface.py. The two must
 * stay in step: the asset filename is the only join between the producer and
 * the map layer, and a MapLibre `image` source pointed at a 404 renders nothing
 * and reports nothing anyone will see.
 */
export const FLOOD_STAGES_M = [0.5, 1, 2, 3, 5] as const;

/** Derived scenario depth: selected stage minus local HAND. */
export const WATER_DEPTH_BANDS = [
  {
    min: 0,
    max: 0.5,
    value: 1,
    color: '#22c55e',
    rgb: [34, 197, 94],
  },
  {
    min: 0.5,
    max: 1,
    value: 2,
    color: '#2563eb',
    rgb: [37, 99, 235],
  },
  {
    min: 1,
    max: 2,
    value: 3,
    color: '#facc15',
    rgb: [250, 204, 21],
  },
  {
    min: 2,
    max: Infinity,
    value: 4,
    color: '#dc2626',
    rgb: [220, 38, 38],
  },
] as const;

/** `0.5 -> "0p5"`, `2 -> "2"`. Mirrors stage_slug() in the producer. */
export function stageSlug(stage: number): string {
  return String(stage).replace('.', 'p');
}

/** Path under public/, not a bundled import — the assets are copied verbatim. */
export function stageAssetPath(stage: number): string {
  return `/flood/hand_le_${stageSlug(stage)}.png`;
}

/**
 * How many towers have measured ground at or below the stage.
 *
 * Towers with no `hand_m` (unscored ones carry none) are not counted, and are
 * not thereby implied to be dry — they are simply not measured. A `null` stage
 * means no scenario is selected, which is zero sites rather than all of them.
 */
export function sitesBelowStage(towers: Tower[], stage: number | null): number {
  if (stage === null) return 0;
  return towers.filter((t) => typeof t.hand_m === 'number' && t.hand_m <= stage).length;
}

/** The lowest ladder stage that reaches this site, or null if none does. */
export function submergingStage(handM: number | undefined): number | null {
  if (typeof handM !== 'number') return null;
  return FLOOD_STAGES_M.find((stage) => handM <= stage) ?? null;
}

/** Web Mercator northing for a latitude, in radians of the projected plane. */
function mercatorY(latDeg: number): number {
  return Math.log(Math.tan(((45 + latDeg / 2) * Math.PI) / 180));
}

/**
 * Pixel size whose aspect matches a lon/lat box's *Mercator* extent.
 *
 * The frontend twin of mercator_image_size() in the producer, kept here so the
 * agreement between the two can be checked without running Python. A plain
 * degree ratio is the tempting wrong answer: it differs by only ~1.5 px over
 * this AOI, which is exactly why it survives a glance.
 */
export function mercatorImageSize(
  bbox: readonly [number, number, number, number],
  widthPx: number,
): [number, number] {
  const [lonMin, latMin, lonMax, latMax] = bbox;
  const spanX = ((lonMax - lonMin) * Math.PI) / 180;
  const spanY = mercatorY(latMax) - mercatorY(latMin);
  return [widthPx, Math.round((widthPx * spanY) / spanX)];
}
