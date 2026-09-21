# Starlink — Team TowerRangers (HACK-MY-093)

**ASEAN GeoAI Fusion 2026 · Innovation track**

## Overview

Predictive maintenance for Malaysian telecom towers: **detect → decide → dispatch**. A Tower Health Risk Index scores every site from open geospatial data with per-factor attribution, and an agentic scheduler turns that attribution into work orders and a crew schedule.

Start with [`docs/HACK-MY-093_PDGS_v01.md`](docs/important/HACK-MY-093_PDGS_v01.md) (submission canvas) or [`docs/Concept_Overview.md`](docs/important/Concept_Overview.md) (full narrative). Build and test commands are in [`CLAUDE.md`](CLAUDE.md).

## Getting started

Requires Python 3.10+, Node `^20.19.0 || >=22.12.0`, npm, and `make`.

```sh
python3 -m venv src/backend/.venv
. src/backend/.venv/bin/activate
make install
make dev
```

Open <http://localhost:5173> and enable **GloFAS river flood outlook · days
1–3**. GloFAS is live without credentials. If `gcloud` has an active project,
`make backend` also reuses it for the optional Earth Engine layers; otherwise
those layers report unavailable without preventing startup.

## Flood mapping

The map console renders flood in two registers. **Attribution** shades how much
of a tower's risk the model assigns to flood, averaged per 2 km hex.
**Inundation** shades ground: HAND threshold tiles across Southeast Asia,
binned by derived depth (0–0.5 m, 0.5–1 m, 1–2 m, ≥2 m), with a 3D extrusion
mode over the Sunway pilot area.

Live layers — GSMaP rainfall, Sentinel-1/2 and Landsat flood extent, NOAA GFS
rainfall forecast, and the CEMS GloFAS river outlook — come from Earth Engine
and public WMS. They are optional: every other route works without them, and a
layer that cannot be drawn says so rather than rendering empty.
[`docs/FLOOD_FORECASTING_PIPELINE.md`](docs/FLOOD_FORECASTING_PIPELINE.md)
covers the sources, windows, and their limits.

The map uses saved imagery. Startup, layer selection, date changes, panning and
zooming never contact Earth Engine or other imagery providers. Missing tiles
remain unavailable until you click **Reload all maps**. `POST /maps/preload`
only records the current viewport for that next manual reload.
`GET /maps/status` reports which layers are ready, preparing, or unavailable.
The map opens the latest saved observation date, shown in the layer panel.
Selecting another date stays explicit; unavailable dates never trigger a fetch.
Missing source data (including unexported DSWFP dates) remain explicitly unavailable.

**Reload all maps** in the Map layers panel starts a fresh pass for the selected
date, all flood/land/fire overlays, all sensors and all five HAND stages
(`POST /maps/reload?date=YYYY-MM-DD`). It renders every zoom from 0 through 8
across ASEAN (within each source's coverage), one variant at a time, and stores
all 31,326 tiles in Supabase. Deeper camera zooms magnify the saved zoom-8 images;
they do not fetch extra detail. The panel reports tile progress and cloud saving.
The panel shows progress; existing maps stay visible until replacements finish.
Repeated clicks coalesce with an active reload. There is no daily refresh, no
automatic retry against the imagery provider, and no age-based deletion of saved
maps. Expired source URLs do not expire saved images. Rendering-code or source
changes invalidate the cache; compute-project or scheduling changes do not. Set `MAP_CACHE_PATH`
for the local buffer. The API also blocks uncached fire-exposure and weather
screening calls from reaching Earth Engine outside a manual reload.

To switch the compute project, update `GEE_PROJECT` in `src/backend/.env` and
restart the backend. Its configured identity needs Earth Engine Resource Viewer,
Service Usage Consumer, and `earthengine.maps.create` permission on the destination
project (a custom role can grant just map creation). Keep
`GEE_DSWFP_ASSET_ROOT` pointing to the existing datasets when they remain in the
old project; changing the compute project does not move those assets.

With `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `src/backend/.env`, Postgres
stores snapshot metadata and tile checksums, and the private `map-cache` Storage
bucket stores the images. The backend restores metadata on startup and downloads
saved images into SQLite on demand. Local images remain usable during a Supabase
outage. Failed uploads stay in a persistent outbox and retry without re-fetching
the imagery; replacements become ready only after their tiles are uploaded.
Without these variables, the cache runs locally in SQLite.

To configure another Supabase project, apply the SQL in `supabase/migrations/`,
then set its URL and a backend `sb_secret_...` key in `.env`. Never use a `VITE_`
variable for this key. Stop the backend before importing its existing cache:

```bash
cd src/backend
.venv/bin/python -m tiles.migrate_cache
```

The import preserves `maps-before-supabase.sqlite3`, is safe to rerun, and verifies
every uploaded image by downloading and checking SHA-256 before publishing the
snapshots. It makes no Earth Engine requests. Run one backend process for the
serial reload queue. The background worker only synchronizes saved data with
Supabase. This stores fetched tiles, not complete source rasters: fetching an
uncached area requires an explicit reload, and Supabase cannot restore exhausted
Earth Engine quotas.

To continue an interrupted batch without refetching completed coverage, call
`POST /maps/reload?date=YYYY-MM-DD&resume=true`. This is a manual operation:
it reuses saved tiles and fetches only missing coordinates. If a source's
observation or forecast has changed, it keeps the old snapshot and builds a new
one so tiles from different runs cannot mix. Normal Reload all maps still
requests fresh imagery. Temporary network and HTTP 502/503/504 failures get up
to three attempts within the manual batch.

All map requests run one at a time. An HTTP 429 pauses all Earth Engine
map work with exponential backoff (one minute up to 30 minutes), respecting a
longer `Retry-After`. The cooldown survives restarts; click Reload all maps again
after it ends to retry. Cached tiles remain available. This reduces
repeated requests but does not restore exhausted compute quota. See Google's
[noncommercial tiers](https://developers.google.com/earth-engine/guides/noncommercial_tiers#restricted_mode)
for restricted mode and quota options.

```bash
src/backend/.venv/bin/python -m pip install -r src/backend/requirements-flood.txt
export GEE_PROJECT=<gcp-project-id>          # needs the Earth Engine API enabled
curl http://127.0.0.1:8001/flood/layers       # catalogue + credential status
```

The backend service account needs Earth Engine Resource Viewer and Service Usage
Consumer access, plus `earthengine.maps.create` to render overlays. Viewer alone
does not include map creation; a custom role can add just that permission without
granting asset editing or deletion. See [Google's IAM role definitions](https://docs.cloud.google.com/iam/docs/roles-permissions/earthengine).

## Real-source data

The real tower-risk pilot for Sunway, Selangor is in
[`data/pilot_sunway`](data/pilot_sunway), with its field definitions, quality
results, licences, and known gaps documented in
[`docs/PILOT_DATASET.md`](docs/PILOT_DATASET.md). It contains 132 operator-site
rows derived from 30,925 real 4G/5G measurements and open terrain, HAND, OSM,
and WorldPop layers. Regenerate it with:

```bash
python3 src/backend/data/prepare_pilot_dataset.py
```

The prepared ASEAN ITU observations, complete series metadata, Geospatial
Catalog inventory, source-to-feature mapping, checksums, and QA report are in
[`data/real_sources`](data/real_sources/README.md). Regenerate them with:

```bash
python3 src/backend/data/prepare_real_dataset.py
```

## Maintenance-decision notebook

[`notebooks/maintenance_decision_training.ipynb`](notebooks/maintenance_decision_training.ipynb)
is the executed, end-to-end ML workflow. It builds an auditable maintenance
policy target from the real Sunway feature table, compares a baseline,
logistic regression, and random forest with physical-site-grouped validation,
then exports the selected classifier and per-site decisions to `artifacts/ml/`.

The current source has no historical work orders, inspection results, outages,
or failure labels. The model therefore learns the documented priority policy;
its metrics measure policy fidelity, not future-failure accuracy.
