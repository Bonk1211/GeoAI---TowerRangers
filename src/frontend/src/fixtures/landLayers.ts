import type { LayerCatalogue } from '../api/types';

/**
 * Offline mirror of the backend land catalogue.
 *
 * Mirrors LAND_LAYERS in src/backend/land/layers.py and must be updated with
 * it. Legitimate as a fallback for the same reason FLOOD_CATALOGUE is: this is
 * static metadata we author, not a measurement.
 *
 * `earth_engine` is null, and that is the important part. Whether the backend
 * can reach Earth Engine is a live fact about a machine we cannot see when the
 * network is down, so the honest offline answer is absence — never a fabricated
 * `configured: false`, which would state as fact something we did not check.
 * Every layer here is `kind: 'ee'`, so offline none of them can be drawn at all.
 */
export const LAND_CATALOGUE: LayerCatalogue = {
  earth_engine: null,
  layers: [
    {
      layer_id: 'ground_slope',
      label: 'Ground slope',
      group: 'land',
      description: 'Terrain slope from Copernicus GLO-30, the same surface the per-tower slope figure comes from. Context for the slope analysis and slope turfing a site audit covers (MCMC MTSFB TC G041:2023 §6.3.2 d, §6.3.3 a), not a slope-stability study: a compound cut into a hillside can be much steeper than its 30 m pixel.',
      kind: 'ee',
      dated: false,
      temporal_kind: 'observation',
      bounds: [92.0, -11.5, 142.0, 29.0],
      sensors: [],
      unit: '°',
      attribution: 'Copernicus DEM GLO-30 (© ESA, ESA/Airbus/DLR)',
      legend: [
        { label: '0–5°', color: '#e8f2e0' },
        { label: '5–15°', color: '#a8d08d' },
        { label: '15–25°', color: '#f2c94c' },
        { label: '25–35°', color: '#e07b39' },
        { label: '≥35°', color: '#b03030' },
      ],
    },
    {
      layer_id: 'land_cover',
      label: 'Land cover · 2021',
      group: 'land',
      description: 'ESA WorldCover 10 m, the 2021 epoch — what surrounds each structure. One fixed classification, not a current view and not a change detector: clearing or regrowth since 2021 does not appear here.',
      kind: 'ee',
      dated: false,
      temporal_kind: 'observation',
      bounds: [92.0, -11.5, 142.0, 29.0],
      sensors: [],
      unit: null,
      attribution: 'ESA WorldCover 10 m 2021 v200 (CC BY 4.0) · Zanaga et al. 2022',
      legend: [
        { label: 'Tree cover', color: '#006400' },
        { label: 'Shrubland', color: '#ffbb22' },
        { label: 'Grassland', color: '#ffff4c' },
        { label: 'Cropland', color: '#f096ff' },
        { label: 'Built-up', color: '#fa0000' },
        { label: 'Bare / sparse vegetation', color: '#b4b4b4' },
        { label: 'Snow and ice', color: '#f0f0f0' },
        { label: 'Permanent water', color: '#0064c8' },
        { label: 'Herbaceous wetland', color: '#0096a0' },
        { label: 'Mangroves', color: '#00cf75' },
        { label: 'Moss and lichen', color: '#fae6a0' },
      ],
    },
    {
      layer_id: 'vegetation_vigour',
      label: 'Vegetation vigour (EVI)',
      group: 'land',
      description: 'Cloud-masked Sentinel-2 EVI over the same window the flood layers use. Greenness of ground cover around a site — context for turfing and grass maintenance (§6.3.3). EVI rather than NDVI because NDVI saturates in dense tropical canopy and stops separating plantation from forest. It is not canopy height, not clearance from the structure, and far too coarse to show the 1 m perimeter cut §6.3.3(b) requires.',
      kind: 'ee',
      dated: true,
      temporal_kind: 'observation',
      bounds: [92.0, -11.5, 142.0, 29.0],
      sensors: [],
      unit: 'EVI',
      attribution: 'Copernicus Sentinel-2 SR (harmonized) · EVI after Huete et al.',
      legend: [
        { label: '0.0 bare/hard', color: '#a1683a' },
        { label: '0.2', color: '#d9c27e' },
        { label: '0.4', color: '#b6d47a' },
        { label: '0.6', color: '#5aa832' },
        { label: '≥0.8 dense', color: '#1f6b1f' },
      ],
    },
    {
      layer_id: 'soil_moisture',
      label: 'Surface soil moisture',
      group: 'land',
      description: 'SMAP L4 surface soil moisture, 0–5 cm, from the most recent granule at or before the selected date. Antecedent wetness — saturated ground is what turns the next rainfall into standing water (§6.3.2 a, c). At 9 km one pixel covers many sites; this is regional state, never site bearing capacity.',
      kind: 'ee',
      dated: true,
      temporal_kind: 'observation',
      bounds: [92.0, -11.5, 142.0, 29.0],
      sensors: [],
      unit: 'm³/m³',
      attribution: 'NASA SMAP L4 Global 3-hourly 9 km (SPL4SMGP v008)',
      legend: [
        { label: '0.05 dry', color: '#b8860b' },
        { label: '0.2', color: '#8fc7c0' },
        { label: '0.35', color: '#3d7fd4' },
        { label: '0.50 saturated', color: '#1d4e89' },
      ],
    },
    {
      layer_id: 'soil_texture',
      label: 'Soil clay content',
      group: 'land',
      description: 'OpenLandMap clay fraction at 0 cm. Clay-rich ground shrinks and swells with wetting and drying, a common driver of the compound cracking and settlement §6.3.2(a) and (b) ask owners to watch for. A 250 m modelled prediction with its own uncertainty — it describes an area\'s ground, not what is under one foundation.',
      kind: 'ee',
      dated: false,
      temporal_kind: 'observation',
      bounds: [92.0, -11.5, 142.0, 29.0],
      sensors: [],
      unit: '% clay',
      attribution: 'OpenLandMap (CC BY-SA 4.0) · Hengl 2018, doi:10.5281/zenodo.1476854',
      legend: [
        { label: '2%', color: '#ffffcc' },
        { label: '20%', color: '#78c679' },
        { label: '≥60%', color: '#006837' },
      ],
    },
  ],
};
