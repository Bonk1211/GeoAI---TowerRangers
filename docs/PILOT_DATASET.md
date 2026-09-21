# Sunway real tower-risk pilot dataset

**Built:** 2026-08-11  
**AOI:** dense urban area around Sunway University, Selangor, Malaysia  
**Output:** [`data/pilot_sunway`](../data/pilot_sunway)  
**Build command:** `python3 src/backend/data/prepare_pilot_dataset.py`

## Outcome

The repository contains a real, source-backed pilot table with 132 anonymous
operator-site rows derived from 30,925 cellular measurements. Ten of the twelve
model-contract fields are populated from open sources at tower/site grain:

| Contract field | Source | Definition |
|---|---|---|
| `tower_id`, `lon`, `lat`, `radio` | Sunway cellular dataset, DOI `10.17632/dx5xyyfz2y.1` | anonymous operator + source node; source-estimated node centroid; highest observed 4G/5G generation |
| `slope_deg`, `tri` | Copernicus DEM GLO-30 Public | 30 m DEM window; gradient slope and Riley-style 3×3 ruggedness |
| `hand_m` | ASF Global 30 m HAND v1 | provider sample at each unique site coordinate; also served on `/towers` and `/score`, and rendered as a surface (see below) |
| `dist_water_m` | OpenStreetMap | shortest local planar distance to a mapped water polygon/waterway |
| `dist_power_m` | OpenStreetMap | shortest local planar distance to a mapped line, cable, substation, plant, or generator |
| `exposed_pop` | WorldPop Malaysia R2025A | 2025 population summed in a 1 km square centered on the site |

`flash_density` and `age_years` are explicit nulls, not zeros. NASA's open
lightning climatology download requires an Earthdata login and its 0.1°–0.5°
cells cannot discriminate sites within this roughly 2 km AOI. No open source
establishes tower installation dates; measurement first-seen dates and nearby
building age are not valid substitutes.

## Delivered files

| File | Grain / purpose | Rows |
|---|---|---:|
| `tower_feature_table.csv` | one anonymous operator-site with features and row-level provenance | 132 |
| `operator_sites.csv` | normalized site dimension and measurement diagnostics | 132 |
| `osm_communications.csv` | independent OSM communications-feature cross-check | 10 |
| `source_registry.csv` | used, optional, blocked, and rejected sources with licences and limitations | 10 |
| `quality_report.json` | machine-readable coverage, ranges, missingness, and source QA | — |
| `manifest.json` | file sizes, SHA-256 hashes, attribution, and limitations | — |
| `raw/mendeley/*` | complete source archive: raw/processed CSV, preprocessing code, README | 30,925 rows in each CSV |
| `raw/copernicus_dem.npy` | exact DEM window used for derivatives | 1 × 97 × 95 cells |
| `raw/asf_hand_samples.json` | verbatim HAND samples | 84 unique coordinates |
| `raw/osm_infrastructure.json` | verbatim Overpass response with geometry and source timestamp | 1,125 elements |
| `raw/worldpop_exposure.json` | verbatim completed population tasks | 84 unique coordinates |

The 132 operator-site rows resolve to 84 unique coordinate locations because
multiple anonymous operators can share a coordinate. The source has 86 unique
node identifiers; identifiers are operator-scoped, so the stable row key is
operator + node rather than node alone.

## Quality results

- 30,925 measurement rows, 51 source columns, 23 sessions, 3 anonymous
  operators, and no duplicate full measurement rows;
- 9,893 4G and 21,032 5G measurements;
- 41 LTE-only and 91 NR-observed operator-sites;
- 0 duplicate derived tower IDs and 0 missing values in the ten populated
  contract fields;
- 805 OSM water elements, 310 power elements, and 10 communications features
  in the extraction envelope, timestamped `2026-08-11T15:39:59Z`;
- HAND range 0.00–15.96 m, slope 0.45–21.72°, TRI 1.05–28.98,
  water distance 25.15–682.81 m, power distance 17.32–1,085.83 m, and
  exposed population 4,815.09–8,527.00;
- all 15 files recorded in the manifest pass SHA-256 verification.

This is suitable for the current source-backed four-factor pilot after the
lightning factor is disabled in scoring. It is not an operator asset register:
site locations are source-estimated centroids, OSM means nearest *mapped*
infrastructure, WorldPop is modeled exposure, and Copernicus GLO-30 is a DSM
that includes surface objects.

## Reproduce

Install the model's existing NumPy/Pandas dependencies, then run:

```bash
python3 src/backend/data/prepare_pilot_dataset.py
```

Raw downloads are cached under `.cache/pilot_sunway`. The command validates
provider schemas, official Mendeley file hashes, coordinate/grain uniqueness,
numeric ranges, expected missingness, and output hashes. Useful options:

```bash
python3 src/backend/data/prepare_pilot_dataset.py --refresh
python3 src/backend/data/prepare_pilot_dataset.py --worldpop-workers 2
python3 src/backend/data/prepare_pilot_dataset.py --output /path/to/output
```

Run code QA with:

```bash
ruff check src/backend/data src/backend/model
pytest -q
```

## HAND as a surface, not only a per-site sample

`hand_m` is sampled per site above, but the same ASF service can return the
raster itself. `src/backend/data/prepare_flood_surface.py` exports one
transparent PNG per flood stage (0.5, 1, 2, 3, 5 m above nearest drainage) over
a padded AOI box and writes them to `src/frontend/public/flood/` with a
provenance manifest. The map console lays them over the basemap as a scrubbable
scenario, and rings the towers whose `hand_m` falls at or below the selected
stage.

Measured on this table, the share of sites at or below each stage runs 40.2 %,
49.2 %, 62.9 %, 75.0 %, 82.6 % — the AOI really is that flat.

This is a terrain threshold. It states which ground sits below a given water
level and nothing more: not whether such a level will occur, not how water would
arrive, and not what would happen to a structure standing there.
`prepare_flood_observed.py` renders an *observed* Sentinel-1 water extent over
the same box for comparison, but it needs an authenticated Earth Engine session
and is developer-run only — its dependencies live in `requirements-flood.txt`,
deliberately outside `requirements.txt`.

## Attribution and reuse

- Kabeer, M., Nordin, R., Behjati, M. (2025), DOI
  `10.17632/dx5xyyfz2y.1`, CC BY 4.0.
- Copernicus DEM GLO-30 Public, accessed through Microsoft Planetary Computer.
- Global 30 m HAND © 2022 Alaska Satellite Facility, CC0 1.0.
- © OpenStreetMap contributors, ODbL 1.0.
- WorldPop Malaysia R2025A 2025, DOI `10.5258/SOTON/WP00839`.

The exact source URLs, versions, licences, roles, caveats, and rejected proxy
decisions are in [`source_registry.csv`](../data/pilot_sunway/source_registry.csv).
