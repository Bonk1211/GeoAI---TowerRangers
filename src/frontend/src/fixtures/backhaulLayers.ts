import type { LayerCatalogue } from '../api/types';

/**
 * Offline mirror of the backend transmission-backbone catalogue.
 *
 * Mirrors BACKBONE_LAYERS in src/backend/backhaul/layers.py and must be updated
 * with it. Legitimate as a fallback for the same reason FLOOD_CATALOGUE,
 * LAND_CATALOGUE and FIRE_CATALOGUE are: this is static metadata we author, not
 * a measurement.
 *
 * `earth_engine` is null here as it is in the other three, but for a different
 * and stronger reason. In those it is null because whether a machine we cannot
 * see holds credentials is unknowable offline. Here the live route returns null
 * too, because this catalogue never touches Earth Engine at all — ITU serves the
 * backbone from its own GeoServer. So this is the one fixture whose
 * `earth_engine` matches the online response exactly.
 *
 * The layer still cannot be drawn offline. `kind: 'wms'` means the tiles come
 * from bbmaps.itu.int, and useLayerTilesQuery is deliberately not wrapped in
 * withOfflineFallback — there is no honest fixture for a tile URL, and inventing
 * one would point the map at a host serving nothing, which is the blank-layer
 * failure the backend's `tile_access` probe exists to prevent.
 *
 * Every caveat in `description` is load-bearing and none of it is decoration:
 * the 2022 vintage, the ~47.6 km median vertex spacing that makes the geometry
 * schematic, the single flat colour, and the flat refusal to feed the risk
 * score. Distance to this backbone was measured at ROC-AUC 0.6075 against the
 * maintenance label — below `dist_power_m` (0.6919) and far below the served
 * model (0.910) — so it is context beside the score and never an input to it.
 */
export const BACKHAUL_CATALOGUE: LayerCatalogue = {
  earth_engine: null,
  layers: [
    {
      layer_id: 'transmission_backbone',
      label: 'Transmission backbone · ITU',
      group: 'backhaul',
      description:
        'Terrestrial fibre and microwave backbone links from the ITU Broadband Maps geocatalogue, published 2022-12-31 and compiled partly from operator websites, annual reports and company presentations — ITU records operator validation as still in progress. The geometry is schematic: across the links covering Malaysia the median spacing between vertices is about 47.6 km, so these are straight lines drawn between endpoints, not surveyed duct routes. Read it as which corridors carry backbone, never as how far a tower sits from cable in the ground. Every link draws in one colour, so operational, planned and microwave corridors are indistinguishable on the map even though the data separates them. It carries no operator, no capacity and no redundancy information, and it does not feed the tower risk score.',
      kind: 'wms',
      dated: false,
      temporal_kind: 'observation',
      bounds: [92.0, -11.5, 142.0, 29.0],
      // Empty for the plainest of reasons: ITU publishes one backbone layer and
      // offers no alternative source. The HUD's sensor control is global and
      // belongs to the flood panel's Sentinel-1/2/Landsat choice.
      sensors: [],
      unit: null,
      attribution: 'ITU Broadband Maps (BBmaps) terrestrial transmission networks, 2022',
      // One row, and the hex must stay in step with BACKBONE_STROKE in
      // src/backend/backhaul/layers.py. The backend ships its own inline SLD
      // with one LineSymbolizer, because the source's default style buries the
      // corridors under point markers and label haloes; that SLD paints every
      // link in this one colour, so a multi-hue key here would describe a
      // picture no tile contains.
      legend: [{ label: 'backbone link (fibre or microwave)', color: '#1d4e89' }],
    },
  ],
};
