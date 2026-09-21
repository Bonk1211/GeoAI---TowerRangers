import type {
  ExpressionSpecification,
  FillExtrusionLayerSpecification,
  FilterSpecification,
  SkySpecification,
} from 'maplibre-gl';
import { WATER_DEPTH_BANDS } from '../../lib/inundation';

/**
 * Flood water as an extruded volume.
 *
 * The 2D layers answer "where"; this answers "how deep". Each cell carries
 * `hand` — the first stage bucket at which it turns wet — so h - hand is a
 * banded lower-bound scenario depth. One geometry serves every stage on the
 * ladder without pretending the pilot GeoJSON contains continuous HAND.
 *
 * Vector, not raster, because MapLibre extrudes geometry and not images. A
 * raster draped on terrain follows the ground exactly and shows no volume at
 * all, which is the one thing this layer exists to show.
 *
 * ── On vertical exaggeration ──────────────────────────────────────────────
 * The flood ladder tops out at 5 m across an AOI 14 km wide. At true scale
 * that is 0.035% of the frame — invisible. Every 3D flood view therefore
 * exaggerates, and the honest question is only whether it says so.
 *
 * Two rules keep this defensible. The factor is shown in the HUD, never
 * silent. And terrain and water are stretched by the SAME factor, so the scene
 * is uniformly scaled in z and the banded lower-bound water estimate stays
 * aligned with the ground. Exaggerating them differently would falsify that
 * relationship.
 */

export const FLOOD_VOLUME_SOURCE_ID = 'flood-volume';
export const FLOOD_VOLUME_LAYER_ID = 'flood-volume-extrusion';

/** Where prepare_flood_volume.py writes its output. */
export const FLOOD_VOLUME_URL = '/flood/flood_volume.geojson';

/**
 * Default z stretch.
 *
 * Chosen by looking, not by taste. The tower AOI carries 82 m of real relief
 * (SRTM: -22 m to 60 m). At x20 that becomes 1.6 km of apparent relief and the
 * Klang Valley — a coastal plain — renders as an alpine range, which is a
 * stronger falsehood than a flat map. At x10 the ground reads as the rolling
 * terrain it is while 2 m of water still resolves as a visible block at AOI
 * zoom. The slider goes to 60 for anyone who wants to exaggerate further, and
 * the HUD always shows the number in force.
 */
export const DEFAULT_EXAGGERATION = 10;
export const EXAGGERATION_RANGE = { min: 1, max: 60 } as const;

/**
 * Depth in metres at a given stage, as a style expression.
 *
 * `stage` is app state rather than a feature property, so it is baked in as a
 * literal and the paint property re-set when it changes — cheaper than
 * rewriting the source, which would re-upload every polygon on each step of the
 * slider.
 */
export function depthExpression(stage: number, exaggeration: number): ExpressionSpecification {
  return [
    '*',
    // max(0, stage - hand): the filter already drops dry cells, but a negative
    // extrusion height is a rendering artefact waiting to happen if the filter
    // and the paint property ever disagree for a frame.
    ['max', 0, ['-', stage, ['get', 'hand']]],
    exaggeration,
  ];
}

/** Only cells the water has actually reached. */
export function volumeFilter(stage: number | null): FilterSpecification {
  return stage === null ? ['==', ['get', 'hand'], -1] : ['<=', ['get', 'hand'], stage];
}

export function depthColour(stage: number): ExpressionSpecification {
  return [
    'step',
    ['max', 0, ['-', stage, ['get', 'hand']]],
    WATER_DEPTH_BANDS[0].color,
    ...WATER_DEPTH_BANDS.slice(1).flatMap((band) => [band.min, band.color]),
  ] as ExpressionSpecification;
}

export function floodVolumeLayer(
  stage: number,
  exaggeration: number,
): Omit<FillExtrusionLayerSpecification, 'id' | 'source'> {
  return {
    type: 'fill-extrusion',
    paint: {
      'fill-extrusion-color': depthColour(stage),
      'fill-extrusion-height': depthExpression(stage, exaggeration),
      'fill-extrusion-base': 0,
      // Translucent so the ground, the streets and the tower marks stay visible
      // underneath. Opaque water would hide precisely what the layer exists to
      // put at risk.
      'fill-extrusion-opacity': 0.62,
    },
  };
}

/**
 * Sky for the pitched camera.
 *
 * Without it, tilting reveals the page ground above the horizon, which reads as
 * the map having fallen over rather than as a view along the ground. Kept pale
 * to match the light theme — a dark sky would put the heaviest value on screen
 * exactly where there is no information.
 */
export const skyLayer: SkySpecification = {
  'sky-color': '#c8daf0',
  'sky-horizon-blend': 0.6,
  'horizon-color': '#eef3fa',
  'horizon-fog-blend': 0.7,
  'fog-color': '#f2f5fa',
  'fog-ground-blend': 0.6,
};
