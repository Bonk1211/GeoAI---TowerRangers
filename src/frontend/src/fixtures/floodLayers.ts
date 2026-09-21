import type { LayerCatalogue } from '../api/types';

/**
 * Offline mirror of the backend flood catalogue (FLOOD_LAYERS in
 * src/backend/flood/layers.py). The land group has its own mirror next door.
 *
 * Legitimate as a fallback for the same reason TOWERS and CREWS are: this is
 * static metadata we author, not a measurement. It mirrors CATALOGUE in
 * src/backend/flood/layers.py and must be updated with it.
 *
 * `earth_engine` is null, and that is the important part. Whether the backend
 * can reach Earth Engine is a live fact about a machine we cannot see when the
 * network is down, so the honest offline answer is absence — never a fabricated
 * `configured: false`, which would state as fact something we did not check.
 * Consumers render null as "unknown", not as "unavailable".
 *
 * The HAND scenario does not need the backend, but its regional tiles still
 * need the public ASF service. Every `ee` layer needs the backend to mint a URL.
 */
export const FLOOD_CATALOGUE: LayerCatalogue = {
  earth_engine: null,
  layers: [
    {
      layer_id: 'potential_depth',
      group: 'water',
      label: 'Potential flood water',
      description:
        'Terrain reached by the selected water level above nearest drainage across Southeast Asia, from GLO-30 HAND. Colours show scenario depth (selected stage minus HAND), not observed water, a forecast or a hazard rating.',
      kind: 'static',
      dated: false,
      temporal_kind: 'scenario',
      bounds: [92, -11.5, 142, 29],
      sensors: [],
      unit: 'm',
      attribution: 'ASF Global 30 m HAND v1 (CC0), derived from Copernicus GLO-30',
      legend: [
        { label: '0–<0.5 m deep', color: '#22c55e' },
        { label: '0.5–<1 m deep', color: '#2563eb' },
        { label: '1–<2 m deep', color: '#facc15' },
        { label: '≥2 m deep', color: '#dc2626' },
      ],
    },
    {
      layer_id: 'flood_extent',
      group: 'water',
      label: 'Flood extent',
      description:
        'Water screened from the selected Sentinel-1, Sentinel-2 or Landsat imagery, minus JRC permanent water. Optical results are screening masks, not calibrated multi-sensor fusion. Gray means no usable local observation.',
      kind: 'ee',
      dated: true,
      temporal_kind: 'observation',
      bounds: [92, -11.5, 142, 29],
      sensors: [
        { id: 'sentinel-1', label: 'Sentinel-1 SAR' },
        { id: 'sentinel-2', label: 'Sentinel-2 optical' },
        { id: 'landsat', label: 'Landsat 8/9 optical' },
      ],
      unit: null,
      attribution:
        'Copernicus Sentinel-1 and Sentinel-2 · USGS/NASA Landsat 8/9 · JRC Global Surface Water',
      legend: [
        { label: 'possible flood', color: '#e63946' },
        { label: 'no usable sensor observation', color: '#808080' },
      ],
    },
    {
      layer_id: 'daily_water',
      group: 'water',
      label: 'Daily water (fused)',
      description:
        'Sentinel-1 and optical imagery fused through a harmonic model at 30 m for the Klang Valley only, so a date with no radar pass still has an answer. Must be exported per date by data/prepare_dswfp.py before it can be drawn.',
      kind: 'ee',
      dated: true,
      temporal_kind: 'observation',
      bounds: null,
      sensors: [],
      unit: null,
      attribution: 'HYDRAFloods DSWFP · Copernicus Sentinel-1 · Sentinel-2/Landsat',
      legend: [{ label: 'flooded', color: '#e63946' }],
    },
    {
      layer_id: 'surface_water',
      group: 'water',
      label: 'Surface water',
      description:
        'Everything Sentinel-1 read as water in this window, rivers and reservoirs included. Radar can also read smooth dry surfaces as water.',
      kind: 'ee',
      dated: true,
      temporal_kind: 'observation',
      bounds: [99.0, 0.5, 119.5, 7.5],
      sensors: [],
      unit: null,
      attribution: 'Copernicus Sentinel-1 · HYDRAFloods edge_otsu',
      legend: [{ label: 'water', color: '#3d7fd4' }],
    },
    {
      layer_id: 'permanent_water',
      group: 'water',
      label: 'Permanent water',
      description:
        'Pixels wet at least 80% of the time in the JRC record. Context for the two layers above, not a flood reading.',
      kind: 'ee',
      dated: false,
      temporal_kind: 'observation',
      bounds: null,
      sensors: [],
      unit: null,
      attribution: 'JRC Global Surface Water v1.4',
      legend: [{ label: 'normally wet', color: '#1d4e89' }],
    },
    {
      layer_id: 'glofas_flood_outlook',
      group: 'water',
      label: 'GloFAS river flood outlook · days 1–3',
      description:
        'Latest daily CEMS GloFAS river-discharge outlook. Colours combine ensemble exceedance of 2-, 5- and 20-year return-period thresholds; lighter shades mean lower confidence. This is not local flash-flood coverage, inundation depth or a replacement for official warnings.',
      kind: 'wms',
      dated: false,
      temporal_kind: 'forecast',
      bounds: [99.0, 0.5, 119.5, 7.5],
      sensors: [],
      unit: null,
      attribution: 'Generated using Copernicus Emergency Management Service information (2026)',
      legend: [
        { label: '>20% chance of ≥2 y', color: '#f4f4a5' },
        { label: '2–5 y', color: '#f2e42a' },
        { label: '5–20 y', color: '#f84a4a' },
        { label: '>20 y', color: '#e266e2' },
      ],
    },
    {
      layer_id: 'glofas_rapid_flood_extent',
      group: 'water',
      label: 'GloFAS rapid flood mapping · next 30 days',
      description:
        'Experimental 1 km CEMS estimate of potentially inundated land where maximum ensemble-median GloFAS discharge in the 30-day forecast exceeds a 10-year return period, matched to modelled inundation maps. Data are only generated for basins greater than 5,000 km²; flood defences are not included. Not local or flash flooding, event timing, probability, depth or an official warning.',
      kind: 'wms',
      dated: false,
      temporal_kind: 'forecast',
      bounds: [99.0, 0.5, 119.5, 7.5],
      sensors: [],
      unit: null,
      attribution: 'Generated using Copernicus Emergency Management Service information (2026)',
      legend: [{ label: 'modelled potential inundation', color: '#72b2ff' }],
    },
    {
      layer_id: 'forecast_rainfall_24h',
      group: 'water',
      label: 'Forecast rainfall · next 24 h',
      description:
        'Rainfall from the latest complete NOAA GFS model run. This is a Malaysia-wide forecast driver, not predicted flood extent or depth.',
      kind: 'ee',
      dated: false,
      temporal_kind: 'forecast',
      bounds: [99.0, 0.5, 119.5, 7.5],
      sensors: [],
      unit: 'mm',
      attribution: 'NOAA/NCEP Global Forecast System 0.25°',
      legend: [
        { label: '1 mm', color: '#c7e9f0' },
        { label: '100 mm', color: '#2c7fb8' },
        { label: '200 mm+', color: '#8b1e8b' },
      ],
    },
    {
      layer_id: 'precipitation',
      group: 'water',
      label: 'Rainfall',
      description:
        'GSMaP rainfall over the latest complete trailing 24 hours at or before the selected date. Rain leads flooding by a day or two — the storm that flooded the Klang Valley fell on 17-18 Dec 2021, by which time the water shown on the 20th was already standing. Expect them to peak on different dates.',
      kind: 'ee',
      dated: true,
      temporal_kind: 'observation',
      bounds: null,
      sensors: [],
      unit: 'mm',
      attribution: 'JAXA GSMaP v8 (gauge-calibrated)',
      legend: [
        { label: '1 mm', color: '#c7e9f0' },
        { label: '100 mm', color: '#2c7fb8' },
        { label: '200 mm+', color: '#8b1e8b' },
      ],
    },
    {
      layer_id: 's1_backscatter',
      group: 'water',
      label: 'Raw radar',
      description:
        'Sentinel-1 VV backscatter in dB, the input to the radar screening layers. Dark is smooth — open water, wet roads, some roofs.',
      kind: 'ee',
      dated: true,
      temporal_kind: 'observation',
      bounds: [99.0, 0.5, 119.5, 7.5],
      sensors: [],
      unit: 'dB',
      attribution: 'Copernicus Sentinel-1 GRD',
      legend: [
        { label: '-25 dB', color: '#000000' },
        { label: '0 dB', color: '#ffffff' },
      ],
    },
  ],
};
