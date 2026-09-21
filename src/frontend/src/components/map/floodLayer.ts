import type { ExpressionSpecification, FillLayerSpecification, LineLayerSpecification } from 'maplibre-gl';

/**
 * Flood exposure as a hex surface.
 *
 * Colour note, because this deliberately introduces a hue the theme does not
 * have. The cool accent means interface chrome and the warm tower triad means
 * severity. This surface is neither: it is one factor's share, not a
 * maintain/watch/ok verdict, and it has no numeric bin key like the HAND depth
 * raster. It therefore gets a single-hue sequential blue — conventional for
 * water, far from both the violet chrome and the warm bands, and readable as a
 * ground surface rather than a verdict.
 *
 * It sits above the hillshade and below every tower layer, at low opacity, so
 * the band colours it sits under stay the brightest thing on the map.
 */

export const FLOOD_SOURCE_ID = 'flood-hex';
export const FLOOD_FILL_LAYER_ID = 'flood-hex-fill';
export const FLOOD_LINE_LAYER_ID = 'flood-hex-line';

/** Hex circumradius in degrees — about 2 km at this latitude. */
export const FLOOD_HEX_RADIUS_DEG = 0.018;

/**
 * Cells below this are dropped rather than drawn faintly: a mean over one
 * tower is a single reading, and a coloured area reads as evidence.
 */
export const FLOOD_HEX_MIN_COUNT = 2;

/**
 * Ramp over mean flood share.
 *
 * Anchored at 0.15 rather than 0 because attribution over four factors puts
 * the uninformative middle at 0.25 — starting the ramp at zero would tint the
 * entire AOI and make "average" look like "exposed".
 */
const FLOOD_RAMP: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['get', 'mean'],
  0.15,
  '#cfe0f5',
  0.3,
  '#9cc2ea',
  0.45,
  '#5b96d8',
  0.6,
  '#2b6cb8',
];

export const floodFillLayer: Omit<FillLayerSpecification, 'id' | 'source'> = {
  type: 'fill',
  paint: {
    'fill-color': FLOOD_RAMP,
    // Opacity carries confidence as well as zoom: a two-tower cell is drawn
    // weaker than a six-tower one, so a thin sample cannot look authoritative.
    // It also fades out as the icons come in, so the densest view is not read
    // through a tinted sheet.
    //
    // MapLibre accepts ['zoom'] ONLY as the direct input of a top-level `step`
    // or `interpolate`. This was previously a ['*'] of a count ramp and a zoom
    // ramp — legal-looking, rejected at style validation, and the layer never
    // drew at all. Same curve, inverted nesting: zoom is the outer input and the
    // count ramp is evaluated at each zoom stop, with the 0.35 far-zoom fade
    // folded into that stop's outputs (0.36*0.35=0.126, 0.62*0.35=0.217).
    'fill-opacity': [
      'interpolate',
      ['linear'],
      ['zoom'],
      12.5,
      ['interpolate', ['linear'], ['get', 'count'], 2, 0.36, 6, 0.62],
      13.5,
      ['interpolate', ['linear'], ['get', 'count'], 2, 0.126, 6, 0.217],
    ] as ExpressionSpecification,
  },
};

export const floodLineLayer: Omit<LineLayerSpecification, 'id' | 'source'> = {
  type: 'line',
  paint: {
    'line-color': '#1f5aa0',
    'line-width': 0.6,
    'line-opacity': 0.35,
  },
};
