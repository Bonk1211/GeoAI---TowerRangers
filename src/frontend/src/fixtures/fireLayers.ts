import type { LayerCatalogue } from '../api/types';

/**
 * Offline mirror of the backend fire catalogue.
 *
 * Mirrors FIRE_LAYERS in src/backend/thermal/layers.py and must be updated with
 * it. Legitimate as a fallback for the same reason FLOOD_CATALOGUE and
 * LAND_CATALOGUE are: this is static metadata we author, not a measurement.
 *
 * `earth_engine` is null, and that is the important part. Whether the backend
 * can reach Earth Engine is a live fact about a machine we cannot see when the
 * network is down, so the honest offline answer is absence — never a fabricated
 * `configured: false`, which would state as fact something we did not check.
 * The one layer here is `kind: 'ee'`, so offline it cannot be drawn at all.
 *
 * There is deliberately NO offline mirror of GET /fire/exposure beside this
 * one, and there must not be. A catalogue entry describes a layer; a detection
 * near a tower is an observation. A fixture carrying detections would put
 * hotspots next to towers no satellite looked at, and a fixture carrying none
 * would render as "no fire detections within 5 km" — a fabricated all-clear,
 * which is the worse of the two. useFireExposureQuery falls back to null.
 */
export const FIRE_CATALOGUE: LayerCatalogue = {
  earth_engine: null,
  layers: [
    {
      layer_id: 'active_fire',
      label: 'Active fire hotspots',
      group: 'fire',
      description:
        'NOAA-20 VIIRS 375 m thermal anomalies over the selected day and the two before it, nominal and high confidence only. Each pixel is shaded by how many of those days carried a detection. A hotspot is a thermal anomaly, not a fire perimeter and not damage: it can be a plantation burn, a flare or hot bare ground, and it says nothing about any structure. It does not feed the tower risk score.',
      kind: 'ee',
      dated: true,
      temporal_kind: 'observation',
      bounds: [92.0, -11.5, 142.0, 29.0],
      // Empty, and not for want of sources: the HUD's sensor control is global,
      // so a fire source list would fight the flood layer's Sentinel-1/2/Landsat
      // selection over the same widget. One fixed source, no choice offered.
      sensors: [],
      unit: 'detection-days',
      attribution: 'NASA FIRMS / LANCE · NOAA-20 VIIRS 375 m active fire, C2 near real-time',
      legend: [
        { label: '1 detection-day', color: '#fde047' },
        { label: '2 detection-days', color: '#f97316' },
        { label: '3 detection-days', color: '#b91c1c' },
      ],
    },
  ],
};
