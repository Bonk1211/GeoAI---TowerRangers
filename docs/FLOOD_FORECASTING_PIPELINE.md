# Southeast Asia Flood Mapping Pipeline

## What was built

Starlink combines Malaysia forecast products with Southeast Asia terrain and
satellite flood screening on the existing MapLibre 3D map.

```text
CEMS GloFAS WMS ─┐
Google Earth Engine (GFS, GSMaP, Sentinel-1/2, Landsat, JRC) ─┼─> FastAPI /flood ─> MapLibre 2D/3D
ASF GLO-30 HAND ImageServer ──────────────────────────────────┘
```

This is a live pull-and-cache pipeline, not a separate ingestion daemon:
GloFAS publishes daily products, GSMaP publishes hourly observations, and the
frontend asks the backend for the latest forecast every five minutes. The
backend pins the selected source time into each tile URL so a browser cache
cannot silently retain yesterday's unnamed `latest` layer.

## Available layers

| Layer | Source | Coverage and horizon | Meaning |
|---|---|---|---|
| GloFAS river flood outlook | CEMS `sumAL41EGE` public WMS | ASEAN, days 1–3 | Ensemble river-discharge exceedance of 2-, 5-, and 20-year return-period thresholds. |
| GloFAS rapid flood mapping | CEMS `RapidFloodMapping` public WMS | ASEAN, maximum over the next 30 days | Experimental 1 km potential inundation extent for basins over 5,000 km² where the forecast exceeds a 10-year return period. It assumes no flood defences. |
| Forecast rainfall | NOAA GFS 0.25° through Earth Engine | ASEAN, next 24 hours | Rainfall driver from the latest complete run at +6, +12, +18, and +24 hours. It is not flood extent or depth. |
| Rainfall | JAXA GSMaP 0.1° through Earth Engine | Global, trailing 24 hours | Latest complete 24 consecutive hourly gauge-calibrated precipitation images. |
| Flood extent | Selectable Sentinel-1, Sentinel-2, or Landsat 8/9; JRC Global Surface Water | Southeast Asia, selected observation date | Screened water after permanent water and sea/coastal artefacts are removed. Gray marks land without a usable local sensor observation. |
| Surface water and raw radar | Sentinel-1 | Malaysia, selected observation date | Existing diagnostic context; unlike the selectable flood extent and the forecast layers, these remain Malaysia-scoped — they run a per-scene radar screen, so area is Earth Engine compute. |
| Permanent water | JRC Global Surface Water | Global, undated | Normally wet water used as context and subtracted from flood screening. |
| Potential flood water | ASF GLO-30 HAND ImageServer | Southeast Asia, selected water stage | Scenario depth (`stage − HAND`) in display bins: green 0–<0.5 m, blue 0.5–<1 m, yellow 1–<2 m, red ≥2 m. These are not hazard ratings, dated imagery or a forecast. |
| Ground slope | Copernicus DEM GLO-30 through Earth Engine | Southeast Asia, undated | Terrain slope off the same surface the per-tower slope figure reads. Audit context (MCMC MTSFB TC G041:2023 §6.3.2–3), not a slope-stability study: a compound cut into a hillside can be far steeper than its 30 m pixel. |
| Land cover · 2021 | ESA WorldCover 10 m 2021 v200 through Earth Engine | Southeast Asia, fixed 2021 epoch | What surrounds each structure. One classification, not a current view and not a change detector — clearing or regrowth since 2021 does not appear. |
| Vegetation vigour (EVI) | Sentinel-2 SR harmonized through Earth Engine | Southeast Asia, selected observation date | Cloud-masked EVI over the same window the flood layers use. EVI rather than NDVI, which saturates in dense tropical canopy. Not canopy height and far too coarse for the 1 m perimeter cut §6.3.3(b) requires. |
| Surface soil moisture | NASA SMAP L4 9 km through Earth Engine | Southeast Asia, newest granule at or before the selected date | Antecedent wetness, 0–5 cm — saturated ground is what turns the next rainfall into standing water. Regional state at 9 km, never site bearing capacity. |
| Soil clay content | OpenLandMap 250 m through Earth Engine | Southeast Asia, undated | Modelled clay fraction at 0 cm: shrink-swell ground behind the compound cracking and settlement §6.3.2(a)–(b) ask owners to watch for. Describes an area's ground, not what is under one foundation. |
| Active fire hotspots | NASA FIRMS / LANCE NOAA-20 VIIRS 375 m C2 through Earth Engine | Southeast Asia, the selected day and the two before it | Pixels shaded by how many of those three days carried a nominal- or high-confidence thermal anomaly. A hotspot is an anomaly, not a fire perimeter and not damage: it can be a plantation burn, a flare or hot bare ground. |

The GloFAS layers work anonymously. Earth Engine layers require a project and
credentials.

**This table spans three catalogues, not one.** `flood/` owns the water rows,
`land/` the five ground and vegetation rows, and `thermal/` the fire row. They
are peers on `tiles/engine.py` — none imports another — and each is served from
its own route prefix (`/flood/*`, `/land/*`, `/fire/*`) with its own catalogue,
credential status, fixture and panel tab. Neither the land rows nor the fire row
is a risk factor: the land layers are MCMC audit context, fire is observed
evidence read beside the maintenance score, and enabling either changes no
tower's risk, decision band or attribution. The Python package is `thermal/`
rather than `fire/` because google/python-fire already occupies the name `fire`
in this venv as a hydrafloods dependency; everything user-facing is still fire.

### Optional DSWFP batch layer

DSWFP is an optional 30 m daily-water product for the Klang Valley, not part of
the national live-pull pipeline. Before running the
[`prepare_dswfp.py`](../src/backend/data/prepare_dswfp.py) producer, create a
writable Earth Engine asset folder and set `GEE_DSWFP_ASSET_ROOT` to its full
ID. Run its three batch stages in order, waiting for each output before starting
the next:

```sh
export GEE_PROJECT=<gcp-project-id>
export GEE_DSWFP_ASSET_ROOT=projects/$GEE_PROJECT/assets/dswfp
earthengine --project "$GEE_PROJECT" create folder -p "$GEE_DSWFP_ASSET_ROOT"

python3 src/backend/data/prepare_dswfp.py samples --project "$GEE_PROJECT" --wait
python3 src/backend/data/prepare_dswfp.py harmonics --project "$GEE_PROJECT" --wait
python3 src/backend/data/prepare_dswfp.py daily --project "$GEE_PROJECT" --date YYYY-MM-DD --wait
```

The installed HYDRAFloods release appends `_water` during the final export, so
the actual daily image ID is
`$GEE_DSWFP_ASSET_ROOT/daily_water_YYYYMMDD_water`, not the unsuffixed base path.

## Backend

The FastAPI surface is intentionally small:

- `GET /flood/layers` returns the catalogue, legends, bounds, temporal type,
  and Earth Engine credential status.
- `GET /flood/tiles/{layer_id}?date=...&sensor=...` resolves a tile template and returns
  source metadata including `window`, `forecast.issued_at`, `forecast.valid`,
  `forecast.source_age_seconds`, `tile_access`, `snapshot_id`, and `expires_at`.
- `GET /land/layers` and `GET /land/tiles/{layer_id}?date=...` serve the ground
  and vegetation catalogue. No sensor selector: `parse_sensor` validates against
  the layer's own list, not the flood one.
- `GET /fire/layers` and `GET /fire/tiles/{layer_id}?date=...` serve the single
  `active_fire` layer. It is the one layer that populates `snapshot_id` — the
  identity of the source window, shared with the exposure route below so tiles
  and tower evidence can never describe different windows.
- `GET /fire/exposure?date=...` screens every tower in the active population
  against that same window, buffered 5 km at the collection's native 375 m. It
  returns only towers with at least one detection-day; a tower is never written
  with a zero, because a zero reads as a measurement. When Earth Engine cannot
  be asked it returns `503` rather than an empty body — "we could not ask" and
  "we asked and it is quiet" must not render the same.
- `POST /score` accepts an optional `[west, south, east, north]` bbox, filters
  the real tower feature table, and recomputes risk and band edges for that AOI.
- Invalid dates, or invalid sensors on selectable layers, return `400`; unknown
  layers return `404`, and unavailable or stale upstream data return `503` with
  an operator-readable reason. Other layers ignore the sensor parameter.

Important safeguards:

- GFS runs must contain every required forecast boundary and be no more than
  18 hours old.
- GSMaP accumulation requires 24 consecutive hourly images.
- GloFAS run times come from `GetCapabilities`, are pinned into WMS requests,
  and are rejected after 48 hours.
- Earth Engine collection sums retain the source projection; this avoids the
  synthetic 1° projection produced by a bare `ImageCollection.sum()`.
- Fire detections are masked from `Bright_ti4`, never from `confidence`, which is
  unmasked and 0-filled across the whole footprint; each day is screened before
  the window is combined, never mosaicked. Every reduction passes both
  `.unweighted()` and `crs="SR-ORG:6974"` — without the first the reducer returns
  fractional pixel counts that cannot be called detection-days, and without the
  second it resamples onto the output grid and counts a different pixel set.
- Sensor selection is part of the tile cache key, so changing sensor cannot
  reuse a map ID minted for another source.
- Gray flood-extent pixels mark land with no usable observation after sensor
  coverage and cloud/quality masks; transparent observed land is not screened as flood.
- One representative tile is fetched by the backend before a layer is marked
  `public`; an authentication failure is reported instead of looking like an
  empty flood map.
- Resolved map IDs and WMS templates are cached for one hour and refreshed
  before expiry.

Primary backend files:

- [`src/backend/flood/layers.py`](../src/backend/flood/layers.py) — the water
  catalogue, its builders, source selection and the GloFAS WMS resolver.
- [`src/backend/tiles/engine.py`](../src/backend/tiles/engine.py) — the
  domain-free tile engine every catalogue sits on: the `Layer` record, date and
  sensor validation, map-ID minting, cache, and the tile-access probe. Validation,
  tile generation, probes and cache moved here out of `flood/layers.py` when the
  peer domains were split out.
- [`src/backend/tiles/ee_session.py`](../src/backend/tiles/ee_session.py) —
  optional Earth Engine initialization and credential reporting. It was
  `flood/ee_session.py` before the split; that path no longer exists.
- [`src/backend/land/layers.py`](../src/backend/land/layers.py) — the ground and
  vegetation catalogue, a peer of `flood/` on the same tile engine.
- [`src/backend/thermal/layers.py`](../src/backend/thermal/layers.py) — the fire
  catalogue, and [`src/backend/thermal/exposure.py`](../src/backend/thermal/exposure.py)
  — per-tower hotspot screening over the same window.
- [`src/backend/api/routes/flood.py`](../src/backend/api/routes/flood.py) — API
  routes and HTTP error mapping; [`land.py`](../src/backend/api/routes/land.py)
  and [`fire.py`](../src/backend/api/routes/fire.py) mirror it per prefix.
- [`src/backend/flood/test_layers.py`](../src/backend/flood/test_layers.py) —
  network-free source-selection and metadata checks.

## Frontend and 3D map

The existing map was kept. Earth Engine XYZ templates and GloFAS WMS templates
both use the same MapLibre raster-source path.

- Forecast queries use `date=latest` and refresh every five minutes.
- The selected observation sensor and date both participate in the query key;
  changing either removes the previous raster while the replacement resolves.
- HAND stage and opacity controls update live regional tiles; unreached terrain
  stays transparent and colour shows derived scenario depth. The 3D water
  volume and tower rings remain Sunway-only because tower-level HAND is only
  measured for that pilot, and its depth is a stage-bucket lower bound.
- Forecast rows open when enabled so issue time, validity, freshness, and
  limitations are visible immediately.
- A failed background refresh removes the previously successful raster instead
  of continuing to display it as `latest`.
- Live rasters retry mounting after terrain temporarily puts the map style into
  a loading state.
- Forecast rasters drape over terrain in 3D. Their apparent height is terrain,
  not forecast water depth.
- A transparent current GloFAS layer means no pixels met that product's
  thresholds; it does not prove there is no local flood risk.
- The complete left control stack now scrolls within the viewport, including
  expanded 3D and flood panels.
- **Score current view** sends MapLibre's visible bounds and the current model
  weights to the backend, then reports the AOI's maintain/watch/OK counts.

Primary frontend files:

- [`src/frontend/src/api/queries.ts`](../src/frontend/src/api/queries.ts) —
  catalogue and tile refresh policy.
- [`src/frontend/src/components/map/EeLayers.tsx`](../src/frontend/src/components/map/EeLayers.tsx)
  — shared live-raster lifecycle.
- [`src/frontend/src/components/hud/LayerPanel.tsx`](../src/frontend/src/components/hud/LayerPanel.tsx)
  — controls, legends, source times, errors, and caveats, across four tabs
  (Flood, Rain, Soil, Fire) over the three catalogues. This was `FloodPanel.tsx`;
  that path no longer exists. `categoryOf()` tests `group === 'fire'` first,
  because its tail returns `flood` for anything unrecognised — a fire layer
  tested later would file itself under the Flood tab, with a FloodIcon beside it,
  and look entirely deliberate.
- [`src/frontend/src/pages/Overview.tsx`](../src/frontend/src/pages/Overview.tsx)
  — scrollable left HUD stack.

## Run locally

Requirements: Python 3.10+, Node `^20.19.0 || >=22.12.0`, npm, and `make`.

```sh
python3 -m venv .venv
. .venv/bin/activate
make install
make dev
```

Open <http://localhost:5173>, scroll to **Flood layers**, and enable either
GloFAS forecast. The most recent product can legitimately be transparent.

GloFAS needs no credentials. For GFS, GSMaP, and satellite observation layers,
set an Earth Engine project and authenticate once:

```sh
gcloud auth application-default login
export GEE_PROJECT=<gcp-project-id>
make dev
```

`make backend` uses an explicit `GEE_PROJECT` first and otherwise reuses the
active `gcloud` project when one exists. A service account can instead use
`GEE_SERVICE_ACCOUNT_EMAIL` and `GEE_PRIVATE_KEY_FILE`.

Useful checks:

```sh
curl http://localhost:8000/flood/layers
curl 'http://localhost:8000/flood/tiles/flood_extent?date=2021-12-20&sensor=sentinel-2'
curl 'http://localhost:8000/flood/tiles/glofas_flood_outlook?date=latest'
curl 'http://localhost:8000/flood/tiles/glofas_rapid_flood_extent?date=latest'

cd src/backend && pytest -q -p no:cacheprovider
cd src/frontend && npm run build
cd src/frontend && npm run lint
```

## Verification at handoff

On 30 August 2026:

- The current GloFAS issue time was `2026-08-30T00:00:00Z`.
- River outlook validity ended `2026-09-02T00:00:00Z`; rapid flood mapping
  validity ended `2026-09-29T00:00:00Z`.
- Both WMS routes returned public, time-pinned tile templates.
- The current rapid-flood layer was correctly transparent over Malaysia. A
  historical `2021-12-18` request returned visible Malaysia flood pixels.
- The latest complete GFS run returned four source images and a 24-hour valid
  window.
- Backend tests passed: `42 passed`.
- Sentinel-1, Sentinel-2, and Landsat each returned public tiles outside
  Malaysia; changing the selector replaced the live MapLibre source.
- Flood extent paints unusable local sensor coverage gray, possible flood red,
  and observed non-flood land transparently.
- The frontend production build passed. Lint retained three unrelated existing
  warnings in the live tower/schedule hooks.
- Browser checks mounted each live source together with terrain at 55° pitch
  and ×10 vertical exaggeration, received WMS tiles with HTTP 200, and reported
  no page errors.
- At 1280×720, the left sidebar scrolled from top to its exact bottom with the
  Area of Interest panel fully reachable.

## Limits

The system is operationally useful for national river-flood screening, but it
must not be described as more precise than its sources:

- Rapid Flood Mapping excludes basins at or below 5,000 km² and events below a
  10-year return period. It does not model flood defences.
- GloFAS products cover river flooding, not local flash, pluvial, coastal, or
  compound flooding, and are not official Malaysian warnings.
- The 1 km rapid map is not event timing, probability, or water depth.
- GFS rainfall is a coarse meteorological driver, not a hydrological flood
  model.
- Sentinel-2 and Landsat masks can miss water below cloud and can confuse
  shadow or dark surfaces with water. They are screening layers, not a
  calibrated multi-sensor fusion product.
- HAND marks low ground relative to drainage for a chosen stage. Its colour is
  derived scenario depth (`stage − HAND`), not a hazard class; it does not model
  flow, connectivity, defences, likelihood, arrival time or observed water.
- There is no calibrated Southeast Asia-wide local inundation-depth model.
- The real tower inventory remains the 132-site Sunway pilot. Forecast rasters
  are national; tower-level exposure is not national until a real operator
  inventory is supplied.
- There is no production deployment manifest, process supervisor, persistence
  store, or SLA. The current path is on-demand resolution plus polling and
  caching.

## Delivery commits

| Commit | Change |
|---|---|
| `50fad16` | Compressed project guidance before implementation. |
| `ee89d7d` | Switched observed rainfall to fresher GSMaP data. |
| `6a40231` | Required complete latest rainfall windows. |
| `8c5f899` | Installed and configured live flood dependencies in local setup. |
| `6b2c715` | Added latest complete GFS 24-hour forecast rainfall. |
| `4b8757e` | Preserved native rainfall source resolution. |
| `e27081b` | Added the live GloFAS days 1–3 river outlook. |
| `b1fc1a6` | Documented source semantics and limitations. |
| `b69a489` | Prevented failed refreshes from leaving stale forecasts visible. |
| `82f1b5a` | Replaced placeholder onboarding with the tested startup path. |
| `9c810f0` | Added experimental GloFAS rapid flood extent. |
| `45faef0` | Made the complete left map-control stack scrollable. |

## Source documentation

- [CEMS GloFAS web layers](https://confluence.ecmwf.int/spaces/CEMS/pages/242067378/Web%2BLayers)
- [CEMS flood impact and Rapid Flood Mapping method](https://confluence.ecmwf.int/spaces/CEMS/pages/333791664/CEMS-Flood+flood+impact+forecasting)
- [NOAA GFS 0.25° in Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/NOAA_GFS0P25)
- [JAXA GSMaP v8 operational in Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/JAXA_GPM_L3_GSMaP_v8_operational)
- [Copernicus Sentinel-1 GRD in Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S1_GRD)
- [Copernicus Sentinel-2 SR Harmonized in Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED)
- [USGS Landsat 8 Collection 2 Level 2 in Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC08_C02_T1_L2)
- [USGS Landsat 9 Collection 2 Level 2 in Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC09_C02_T1_L2)
- [JRC Global Surface Water in Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_GlobalSurfaceWater)
- [ASF GLO-30 HAND ImageServer](https://gis.asf.alaska.edu/arcgis/rest/services/GlobalHAND/GLO30_HAND/ImageServer)

Attribution displayed in the application: **Generated using Copernicus
Emergency Management Service information (2026)**.
