# Real-source dataset — scope, provenance, and quality

**As of:** 2026-08-11  
**Project scope:** all eleven ASEAN member states  
**Output:** [`data/real_sources`](../data/real_sources/README.md)

This ASEAN context/discovery extract is now complemented by the real
[`Sunway tower-risk pilot`](PILOT_DATASET.md): 132 operator-site rows with
tower/radio, terrain, HAND, water distance, power distance, and population
exposure populated from open sources.

## Outcome

The repository now contains a reproducible, source-backed dataset prepared
from the three requested pages:

1. [Geospatial Catalog — Data](https://geospatialcatalog.com/categories/data)
2. [ITU DataHub — Data](https://datahub.itu.int/data/)
3. [ITU DataHub — Indicator catalogue](https://datahub.itu.int/indicators/)

The extraction deliberately keeps two different grains separate:

- **Discovery grain:** one row per Geospatial Catalog entry. These records tell
  the batch pipeline where candidate rasters/vectors can be acquired; they are
  not measurements.
- **ITU observation grain:** one row per series × economy × year ×
  disaggregation tuple. These are country-level ICT observations; they are not
  tower features.

No national statistic is copied onto tower rows, and no tower location,
technology generation, or hazard value is fabricated.

## Delivered files

| File | Grain / purpose | Rows |
|---|---|---:|
| `geospatial_catalog_data.csv` | every entry in the catalog's Data category | 474 |
| `geospatial_ml_sources.csv` | keyword-recalled candidate entries for human review | 59 |
| `model_source_mapping.csv` | exact plan-factor mapping with readiness/blockers | 9 |
| `itu_asean_observations.csv` | ITU series × ASEAN economy × year × disaggregation | 39,536 |
| `itu_series_metadata.csv` | unique ITU series dimension | 10,080 |
| `itu_indicator_catalogue.json` | public catalogue hierarchy | 93 top-level families |
| `itu_indicator_details.json` | full definitions, units, collections, disaggregations | 93 detail trees |
| `itu_countries.json` | complete ITU economy dictionary | 236 economies/areas |
| `itu_regions.json` | ITU aggregate-region dictionary | 21 regions/groups |
| `itu_methodology.json` | ITU dataset methodology dictionary | 4 datasets |
| `quality_report.json` | machine-readable QA results | — |
| `manifest.json` | sources, licences, hashes, and limitations | — |

The manifest contains the authoritative byte sizes and SHA-256 hashes; the
counts above describe the current extraction.

## ITU coverage and data contract

The observation export contains all public primary quantitative indicator
series selected from the supplied catalogue and all associated series expanded
by ITU's bulk endpoint, across the complete available history for:

`BRN`, `KHM`, `IDN`, `LAO`, `MYS`, `MMR`, `PHL`, `SGP`, `THA`, `TLS`, `VNM`.

Observation columns are the ITU export contract:

`SeriesID`, `SeriesCode`, `Series`, `Unit`, `Database`, `Year`, `AreaName`,
`AreaCode`, `DisaggregationGroup`, `Disaggregation1`, `Disaggregation2`,
`Value`, `Notes`, `Source`, `LastModifiedOn`.

Join observations to `itu_series_metadata.csv` using `SeriesID` = `series_id`.
All 2,206 observed series have a metadata match. ITU's indicator-detail API
omits 1,341 series that its bulk export expands; those dimension rows are
losslessly derived from the export's own ID, code, name, unit, database, and
year range and carry `metadata_origin=observation_export`. No missing
definitions or family links are guessed.

Blank `Value` cells are retained as explicit ITU no-data records. Consumers
must filter `Value != ''` before numeric analysis rather than treating blanks
as zero.

## Quality assessment

The preparation command enforces these checks:

- exactly 474 unique Geospatial Catalog slugs and no missing provider URL;
- exactly the eleven current ASEAN economy codes after excluding ITU aggregate
  rows;
- valid required identifiers and grain fields;
- zero duplicate rows at series × year × economy × disaggregation grain;
- complete observation-to-series referential coverage;
- deterministic CSV columns and a recorded year range;
- SHA-256 hashes for every delivered data file.

Current results:

- 39,536 ASEAN observation rows, 2,206 observed series, 1950–2025;
- 755 explicit missing-value records (1.91%); no missing required IDs;
- 0 non-numeric populated values in the quantitative observation export;
- missingness is uneven: Timor-Leste 18.40% and the Philippines 7.03%, while
  every other member is below 3%. This is a material caveat for balanced-panel
  comparisons, but not an ingestion failure because the API explicitly emits
  these no-data cells;
- 0 duplicate grain rows and 0 series-dimension orphans;
- latest source modification date in the export: 2026-07-28;
- 1,966 ITU region/group aggregate rows excluded from the country file;
- 2 unquoted multiline source fields repaired without losing content.

The full machine-readable evidence is in
[`quality_report.json`](../data/real_sources/quality_report.json).

## Mapping to the ML feature-table contract

[`model_source_mapping.csv`](../data/real_sources/model_source_mapping.csv)
maps catalogued providers to the raw fields in §1 of the implementation plan.
The strongest immediately downloadable candidates are:

| Feature | Catalogued source | Status |
|---|---|---|
| `slope_deg`, `tri` | Copernicus GLO-30 DEM | downloadable |
| `hand_m` | Global 30 m HAND | downloadable |
| `dist_water_m` | Sentinel-2 L2A COGs + segmentation | downloadable imagery |
| `exposed_pop` | Microsoft Buildings; population layer requires licence/vintage review | mixed |
| `flash_density` | NASA Earthdata Lightning | exact LIS/OTD product must be selected |
| `dist_power_m` | Geofabrik OSM extracts; Open Infrastructure Map for visual QA | downloadable |
| `tower_id`, `lon`, `lat`, `radio` | beaconDB discovery entry | blocked: no bulk dump |

The tower-grain blocker is resolved for one concrete pilot through the CC BY
4.0 Sunway cellular measurement dataset. Its 30,925 real 4G/5G measurements
produce 132 anonymous operator-site rows, documented in
[`PILOT_DATASET.md`](PILOT_DATASET.md). ASEAN-wide scaling still requires a
registered OpenCellID export or operator asset inventory; the Sunway positions
are source-estimated centroids and must not be represented as a national asset
register.

## Reproduce

From the repository root:

```bash
python3 src/backend/data/prepare_real_dataset.py
```

The command uses only Python's standard library, caches raw downloads under
`.cache/real_sources`, and tries ITU's official API first. When ITU CloudFront
rejects direct non-browser clients, `--itu-transport auto` uses the read-only
Jina transport for the official API response. This is transport only; the
manifest continues to cite the official ITU API as the data source.

Useful options:

```bash
python3 src/backend/data/prepare_real_dataset.py --refresh
python3 src/backend/data/prepare_real_dataset.py --itu-transport direct
python3 src/backend/data/prepare_real_dataset.py --output /path/to/output
```

Run QA/tests with:

```bash
ruff check src/backend/data
pytest -q src/backend/data src/backend/model
```

## Licence and citation

ITU DataHub data is published under CC BY-NC-SA 3.0 IGO, with third-party
series retaining their owners' terms. Cite ITU DataHub and the access date.
Geospatial Catalog entries are metadata pointing to independent providers;
acquiring any linked asset requires checking that provider's current licence,
attribution, permitted use, coverage, and update date.
