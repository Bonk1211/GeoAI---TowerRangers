import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FilterSpecification,
  RasterLayerSpecification,
} from 'maplibre-gl';

/**
 * Potential flood water, as a stage scenario.
 *
 * Where the hex surface next door paints one factor's *attribution share*, this
 * paints ground: every pixel whose height above nearest drainage is at or below
 * the selected stage. The source is the ASF GLO-30 HAND raster — the same
 * product data/pilot_sunway/tower_feature_table.csv samples per tower for
 * `hand_m` — so the surface and the per-site number cannot disagree.
 *
 * Colour carries derived depth (selected stage minus HAND): green, blue,
 * yellow, then red as water gets deeper. These are depth bins, not risk bands.
 *
 * Thresholding happens server-side in an ArcGIS rendering rule, returning
 * transparent-dry/colour-banded Web-Mercator tiles across Southeast Asia. The
 * committed Sunway PNGs remain the source for the pilot-only 3D volume.
 */

export const INUNDATION_SOURCE_ID = 'inundation';
export const INUNDATION_LAYER_ID = 'inundation-layer';
export const FLOOD_RING_LAYER_ID = 'towers-flood-ring';

/** Pilot tower rings mark inclusion only; they do not claim a site depth. */
export const WATER_BLUE = '#2b6cb8';

/**
 * Rings remain an AOI-scale tower aid even though the water surface is now
 * regional. A 2px stroke would overwhelm the map at country scale.
 */
const RING_ZOOM_GATE: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  9,
  0,
  10.5,
  0.9,
];

export const inundationLayer: Omit<RasterLayerSpecification, 'id' | 'source'> = {
  type: 'raster',
  paint: {
    // Held well under 1 so the basemap's street grid stays readable through the
    // water. The question this layer answers is "which streets and which towers
    // go under", and an opaque sheet answers neither.
    'raster-opacity': 0.75,
    // No cross-fade. The default dissolves one stage into the next, which reads
    // as water *flowing* — a motion nothing in this data supports. Snap instead.
    'raster-fade-duration': 0,
  },
};

/**
 * Ring on towers whose measured ground is at or below the stage.
 *
 * A separate circle layer on the existing tower source rather than a paint
 * change on towers-layer, because circle-stroke-* there is already spoken for
 * by `borderline`. Stroke only: the band colour underneath is the loudest thing
 * on the mark and must stay that way.
 */
export const floodRingPaint: CircleLayerSpecification['paint'] = {
  'circle-color': 'rgba(0,0,0,0)',
  // Three pixels clear of the halo's own radius ramp (towerLayer.ts), so this
  // reads as an annulus around the tower rather than as a fatter dot.
  'circle-radius': [
    '+',
    ['interpolate', ['linear'], ['get', 'risk'], 0, 4, 1, 11],
    3,
  ] as ExpressionSpecification,
  'circle-stroke-color': WATER_BLUE,
  'circle-stroke-width': 2,
  'circle-stroke-opacity': RING_ZOOM_GATE,
};

/** Which towers the ring applies to at a given stage. */
export function floodRingFilter(stage: number | null): FilterSpecification {
  // `has` comes first: an unscored tower carries no hand_m at all, and
  // ['<=', null, h] coerces to true — without the guard every unmeasured tower
  // would be marked as standing in water.
  return stage === null
    ? ['==', ['get', 'tower_id'], ' ']
    : ['all', ['has', 'hand_m'], ['<=', ['get', 'hand_m'], stage]];
}
