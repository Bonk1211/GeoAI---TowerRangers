# Real-source dataset

Generated on 2026-08-11 from the Geospatial Catalog and ITU DataHub sources
specified for the Tower Health Risk Index. See
[`docs/REAL_DATASET.md`](../../docs/REAL_DATASET.md) for grain, provenance,
quality results, limitations, and regeneration instructions.

Start with:

- `manifest.json` — source roles, licences, SHA-256 checksums, limitations.
- `quality_report.json` — row counts and validation evidence.
- `model_source_mapping.csv` — exact mapping from model features to catalogued
  providers, including readiness and blockers.
- `itu_asean_observations.csv` — full-history ITU observations for all eleven
  ASEAN members.
- `itu_series_metadata.csv` — the series dimension for joining by `SeriesID`.
- `geospatial_catalog_data.csv` — all 474 entries in the catalog's Data
  category, including provider URLs and catalogue descriptions.

These files do **not** constitute the one-row-per-tower feature table. ITU data
is country-level context, and the Geospatial Catalog is a discovery directory.
The requested sources do not expose a bulk tower/radio-generation download, so
no tower coordinates or local hazard values were fabricated in this directory.
The separate CC BY 4.0 Sunway pilot resolves that grain for one real AOI; see
[`data/pilot_sunway`](../pilot_sunway) and
[`docs/PILOT_DATASET.md`](../../docs/PILOT_DATASET.md).
