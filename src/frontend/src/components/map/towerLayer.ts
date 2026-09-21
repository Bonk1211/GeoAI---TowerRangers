import type { FeatureCollection } from 'geojson';
import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  GeoJSONSourceSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import type { Tower } from '../../api/types';
import { isScored } from '../../fixtures/towers';
import { COLORS, INK_COLORS, UNSCORED_COLOR } from '../../lib/colors';

export const TOWER_SOURCE_ID = 'towers';
export const TOWER_LAYER_ID = 'towers-layer';
export const TOWER_ICON_LAYER_ID = 'towers-icon-layer';
export const TOWER_ICON_IMAGE_ID = 'tower-icon';
export const TOWER_CLUSTER_LAYER_ID = 'tower-clusters';
export const TOWER_CLUSTER_LABEL_ID = 'tower-cluster-count';
export const TOWER_DETAIL_ZOOM = 9;

export const towerClustering: Partial<GeoJSONSourceSpecification> = {
  cluster: true,
  clusterMaxZoom: TOWER_DETAIL_ZOOM - 1,
  clusterRadius: 65,
  clusterProperties: {
    maintain_count: ['+', ['case', ['all', ['get', 'scored'], ['==', ['get', 'decision'], 'maintain']], 1, 0]],
  },
};

// Aggregate counts are neutral; a red outline flags a nonzero maintain count.
// Zero maintain is not an assertion that the remaining sites are OK or scored.
export const towerClusterPaint: CircleLayerSpecification['paint'] = {
  'circle-color': '#ffffff',
  'circle-radius': ['step', ['get', 'point_count'], 29, 100, 33, 1000, 37],
  'circle-stroke-color': ['case', ['>', ['get', 'maintain_count'], 0], COLORS.maintain, UNSCORED_COLOR],
  'circle-stroke-width': 2,
};

export const towerClusterLayout: SymbolLayerSpecification['layout'] = {
  'text-field': ['format',
    ['concat', ['to-string', ['get', 'point_count_abbreviated']], ' sites'], { 'font-scale': 1 },
    '\n', {},
    ['concat', ['to-string', ['get', 'maintain_count']], ' maintain'], {
      'font-scale': 0.8,
      'text-color': ['case', ['>', ['get', 'maintain_count'], 0], INK_COLORS.maintain, '#52616b'],
    },
  ],
  'text-font': ['Noto Sans Regular'],
  'text-size': 12,
  'text-line-height': 1.3,
  'text-allow-overlap': true,
  'text-ignore-placement': true,
};

export function towersToGeoJSON(towers: Tower[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: towers.map((t) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      properties: {
        tower_id: t.tower_id,
        decision: t.decision,
        risk: t.risk,
        borderline: t.borderline,
        scored: isScored(t),
        // Keep territory on individual features for inspection and filtering.
        territory: t.territory ?? 'unassigned',
        // Carried so the flood-stage ring can filter on it in the style rather
        // than rebuilding a filtered FeatureCollection on every stage change.
        // Omitted rather than defaulted when absent: `has` is the first test in
        // floodRingFilter, and a 0 default would mark every unmeasured tower as
        // standing in water.
        ...(typeof t.hand_m === 'number' ? { hand_m: t.hand_m } : {}),
        // Whether this tower's score describes a MODELLED site rather than the
        // one the backend scored. Carried into the style so the protected ring
        // is a filter rather than a second FeatureCollection — same reasoning
        // as `territory` above.
        protected: Boolean(t.protection),
      },
    })),
  };
}

export const towerPaint: CircleLayerSpecification['paint'] = {
  // Band colours come from lib/colors so the map, the legend and the drawer
  // cannot drift apart — this layer previously carried its own hardcoded triad.
  'circle-color': [
    'case',
    ['==', ['get', 'scored'], false],
    UNSCORED_COLOR,
    ['match', ['get', 'decision'], 'maintain', COLORS.maintain, 'watch', COLORS.watch, COLORS.ok],
  ],
  'circle-radius': [
    'case',
    ['==', ['get', 'scored'], false],
    2.5,
    ['interpolate', ['linear'], ['get', 'risk'], 0, 4, 1, 11],
  ],
  'circle-stroke-width': ['case', ['get', 'borderline'], 1.5, 0],
  // LIGHT THEME: the borderline ring was white to separate a tower from Dark
  // Matter. On Positron white is the background, so the ring inverts to the
  // app's ink — it has to read against both the pale basemap and the tower's
  // own band fill.
  'circle-stroke-color': '#0d1526',
  'circle-stroke-opacity': 0.55,
  'circle-opacity': ['case', ['==', ['get', 'scored'], false], 0.32, 0.88],
};

// Keep the simulation's marker sizing intact; the overview needs smaller
// individual marks between country-wide clusters and the close-up icon view.
export const overviewTowerPaint: CircleLayerSpecification['paint'] = {
  ...towerPaint,
  'circle-radius': ['interpolate', ['linear'], ['zoom'],
    4, ['case', ['get', 'scored'], ['interpolate', ['linear'], ['get', 'risk'], 0, 2.5, 1, 4], 2],
    9, ['case', ['get', 'scored'], ['interpolate', ['linear'], ['get', 'risk'], 0, 3, 1, 7], 2.5],
    13, towerPaint['circle-radius'] as ExpressionSpecification,
  ],
};

// icon-size is relative to the source PNG's own pixel size, and the asset is
// 500x500. The halo underneath tops out at circle-radius 11 (22px across), so
// sizes here are chosen to keep the icon in the same visual register as the
// halo — anything much larger buries the band colour, which is the actual
// signal (Tower_Icon_Layer_Plan.md §0).
export const towerIconLayout: SymbolLayerSpecification['layout'] = {
  'icon-image': TOWER_ICON_IMAGE_ID,
  'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.035, 15, 0.09],
  // Collision culling back ON. With both of these true MapLibre skipped
  // placement entirely, so at AOI zoom ~130 icons stacked into confetti and
  // buried the band colour — the exact outcome the note above warns against.
  // Thinning only removes decoration: the coloured halo is a circle layer,
  // which never collides, so every tower keeps its risk reading either way.
  'icon-allow-overlap': false,
  'icon-ignore-placement': false,
};

// Zoom gate: no icons until the towers have room for them. The gate used to
// open at z9-z10, which put icons on screen at the AOI zoom of 11 where the
// cluster is dense — so the motif arrived exactly where it did the most damage
// to legibility. Opening at z12.5-13.5 keeps z9-z12 as clean coloured dots,
// which is the zoom range the band colours are actually read at, and brings
// the icons in only once you are close enough for them to be distinct.
// MapView uses the same curve with the slider value as its upper stop.
export function towerIconOpacity(opacity: number): ExpressionSpecification {
  // MapLibre requires zoom to be the input of a top-level interpolation.
  return ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.5, opacity];
}

export const TOWER_ICON_ZOOM_GATE = towerIconOpacity(1);

export const towerIconPaint: SymbolLayerSpecification['paint'] = {
  'icon-opacity': TOWER_ICON_ZOOM_GATE,
};

export const ISOLATED_RING_SOURCE_ID = 'towers-isolated';
export const ISOLATED_RING_LAYER_ID = 'towers-isolated-ring';

/**
 * A ring around flood-exposed towers that no neighbour could stand in for.
 *
 * Deliberately NOT a band colour. CLAUDE.md gives lib/colors.ts exactly one
 * job — the tower severity triad — and a ring drawn in one of those three
 * hues would read as a fourth band. This is a different KIND of statement
 * (about consequence, not condition), so it gets a different visual language:
 * an unfilled stroked circle, wider than the band halo it surrounds.
 *
 * Its own layer rather than a filter change: CLAUDE.md requires towers-layer
 * and towers-icon-layer to move together, and the safest way to honour that is
 * to touch neither. This layer is added BENEATH the band halo so decoration
 * never outranks data — the same ordering rule the icon-confetti fix
 * established.
 */
export const isolatedRingPaint: CircleLayerSpecification['paint'] = {
  'circle-radius': 13,
  'circle-color': 'transparent',
  'circle-stroke-width': 1.5,
  // The app's ink, not white, for the reason towerPaint's borderline ring
  // records above: this console runs on Positron, where white IS the
  // background. A white ring was drawn first and verified invisible against
  // the pale basemap — the stroke has to read against both the basemap and the
  // band fill it surrounds, and only the ink does. Not theme-conditional
  // because there is no second theme to be conditional about; if a dark
  // basemap ever returns, this inverts alongside the borderline ring, not
  // separately from it.
  'circle-stroke-color': '#0d1526',
  'circle-stroke-opacity': 0.85,
};

export const PROTECTED_RING_LAYER_ID = 'towers-protected-ring';

/**
 * A ring around towers whose score describes MODELLED protection.
 *
 * Without it, a tower that has been modelled down into `watch` is pixel-for-
 * pixel identical to a tower the backend actually scored at `watch`, and the
 * map silently mixes a hypothetical into the live population. That is the
 * failure this ring exists to prevent, and it is why the ring is not optional
 * decoration — `ProtectionBanner` says the map contains modelled scores, and
 * this says WHICH ONES.
 *
 * VIOLET, WHICH IS ORDINARILY CHROME, AND DELIBERATELY SO. The app's rule is
 * that warm hue carries tower severity and the cool accent carries interface.
 * This mark is neither a severity reading nor a control: it is a statement
 * that the thing underneath it came from the interface rather than from the
 * data. Drawing it in a band colour would read as a fourth band; drawing it in
 * the neutral ink would collide with the isolated-ring above, which already
 * means something else. The accent is the honest choice precisely because it
 * is the app's "this is us, not the world" colour.
 *
 * Dashed, not solid, for the same reason: a broken line reads as provisional
 * at a glance, and it survives being photographed off a projector where a hue
 * distinction may not.
 */
export const protectedRingPaint: CircleLayerSpecification['paint'] = {
  'circle-radius': ['interpolate', ['linear'], ['get', 'risk'], 0, 9, 1, 16],
  'circle-color': 'transparent',
  'circle-stroke-width': 2,
  'circle-stroke-color': '#7c3aed',
  'circle-stroke-opacity': 0.9,
};

/** Only towers carrying a modelled mitigation. */
export const protectedRingFilter: ExpressionSpecification = ['==', ['get', 'protected'], true];
