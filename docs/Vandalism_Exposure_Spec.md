# Vandalism Exposure Layer & Public CCTV View — Build Spec

**Status: planned 2026-09-16, not built.** Every figure below was measured on that date against the
national table (`data/malaysia/tower_feature_table.csv`, 1,164 towers) unless marked *assumed* or
*verify at build*.

---

## 0. The sentence that governs it

**Exposure describes conditions that make a site easier to rob unseen — dark, few people nearby.
It is not a prediction of theft, it never enters `risk`, `priority`, `decision`, `attribution` or
`urgency_days`, and it reaches work only through a planner-reviewed `site_hardening_review` order.
The CCTV view shows where public cameras are and what they see right now; it never says a tower is
monitored.**

This is the fire-exposure pattern (`thermal/`, `/fire/exposure`, `propose_fire_inspection()`)
applied to a second kind of observed evidence. Where this spec is silent, do what fire does.
`docs/Backend_Handoff.md` §0.6 applies in full: no per-tower theft or vandalism record exists
anywhere in this project, so nothing may be fitted to one or worded as if it were.

---

## 1. Why, and what the data allows

**The problem is real and large.** Selangor recorded 1,836 telecom-infrastructure vandalism cases in
2024 and 1,273 in 2025; Sarawak had 1,116 vandalism cases and RM9.3M losses in 2024; Pahang lost
over RM3M in 2025. Operators respond with metal cable trunking, fences and extra cabinet locks.
**Only state totals are published** — no incident has a tower id or coordinates.

**Measurements that shaped every decision below:**

| Signal | Source | At the 1,164 towers |
|---|---|---|
| Night lights, 500 m mean | VIIRS VNL v2.2 annual (`NOAA/VIIRS/DNB/ANNUAL_V22`, image `20250101`, band `average_masked`) | p10 0.49 · median 16.08 · p90 49.49 nW/cm²/sr; **69 towers (5.9%) read 0** |
| Population within 1 km | WorldPop 100 m (`WorldPop/GP/100m/pop`, MYS, 2020 — newest year in the collection) | p10 109 · median 3,607 · p90 15,537; **107 towers (9.2%) under 100** |
| Agreement | — | Spearman ρ(lights, population) **0.909**; both dark and under 100 people: 45 |
| Public camera feed within 200 m / 500 m / 1 km | opencctv.org catalogue, 216 active feeds in the Malaysia bbox | **1** / 11 / 34 towers; median nearest 69 km |
| Mapped camera (not viewable) within 200 m | OSM `man_made=surveillance`, 513 features | 14 towers |

The one tower within 200 m of a public feed (`MY_N13700552576`, Melaka, 145 m) was checked by
pulling the live frame: "CAM03 – Dari Mahkota Medical Center", a junction camera aimed down the
carriageway. The tower is not in view.

**The finding that limits the claim.** The 118 most isolated towers (top decile, mean of both
ranks) sit in Pahang 25, Sarawak 20, Perak 16, Terengganu 14, Negeri Sembilan 12, Sabah 11 —
and **Selangor 3**, although Selangor reports the most vandalism nationally. Two explanations,
not separable with published data: Selangor has more towers (188 in OSM — mapping density, not
deployment, so no per-tower rate can be computed), and urban cable theft is a different mechanism
(access to scrap routes, not darkness) that this signal cannot see. **So the layer is one
mechanism — unwatched remote sites — and the UI says urban cable theft is not covered.** It must
never be presented as "where theft happens".

---

## 2. Decisions already made

| Decision | Reason |
|---|---|
| **Exposure = mean of two percentile ranks** (darker → higher, fewer people → higher), reported as a 0–1 percentile. Not fitted. | No labels exist. The two agree at ρ 0.91, so the score is mostly darkness; population is kept because it breaks the 69-way tie at zero light and resolves 100 m against VIIRS's 464 m. |
| **No road-access component.** | Overpass cannot deliver it: the 3°N 101°E tile holds 262,294 highway ways, and an `around:2000` query for just that tile's 206 towers timed out at 173 s. It would also measure the wrong thing — every tower has an access track by construction, so the distance mostly records whether that track is mapped. |
| **No grid-distance component** (`dist_power_m`). | An off-grid site plausibly holds a bigger battery bank, but `radio`/equipment is `UNKNOWN` for 96% of rows, so the proxy can never be checked. It also moves with lights anyway (ρ −0.57). |
| **No scrap-yard proximity.** | 72 OSM scrap-yard features across the whole bbox, including SG/BN/ID edges. That measures mapping density, not the scrap trade. |
| **No GHSL built-surface.** | Redundant with population. If it is ever added, pin an epoch: the newest image in `JRC/GHSL/P2023A/GHS_BUILT_S` is the **2030 projection**, and `.sort().first()` would silently select modelled future ground. |
| **A nearby public camera never lowers exposure.** | 1 tower within 200 m, and that camera films a road. Crediting proximity would invent surveillance that does not exist. |
| **No detection, no recording, no stored frames.** Frames load in the browser straight from the operator. | opencctv's terms forbid using imagery to "surveil, or identify individuals" and forbid bulk download; running people-detection on public feeds also raises Malaysia PDPA questions this prototype has no basis to answer. |
| **Cameras come from operators, not from opencctv.** | JPS Selangor publishes `https://infobanjirjps.selangor.gov.my/JPSAPI/api/CCTVS` — 93 cameras, **82 with coordinates** (fields `stationId`, `stationName`, `latitude`, `longitude`, `districtName`, `isEnabled`, `isOnline`; lat/lon are strings, `"-"` when absent). Windy's Webcams API is an official, keyed API. |
| **Johor Bahru city council (MBJB) iTrafik (19) and the highway authority LLM (16) are out of v1.** | Both publish snapshots but no coordinates. Hand-copying coordinates from an aggregator is the bulk-copy the aggregator's terms forbid. |
| **Crew type `civil`.** | Fence, trunking and lock surveys are civil work. **Gap:** `config/crews.json` has no civil crew in Melaka, Penang, Perlis, Kuala Lumpur or Labuan (13 civil crews, 11 territories), so orders there come back in `unscheduled`, stated, exactly as fire inspections already do. |
| **The survey discharges existing MCMC checklist items, not new ones.** | `docs/MCMC_Fix_Note_Checklists.md`, "Other" table: item 5 *"no theft/vandalism risk"* and item 6 *"Site access — logbook maintained, access process followed"*. The work order points at those two rows rather than inventing a checklist. |
| **Separate endpoint, not new `/towers` fields.** | Mirrors `/fire/exposure` and keeps the §1 scored-tower contract frozen. |
| **Static layer, rebuilt by hand.** | Both sources are annual or older. Like `land_features.csv`, a producer writes a CSV; no request touches Earth Engine. |

---

## 3. Backend

### 3.1 Producer — `src/backend/data/prepare_vandalism_exposure.py`

- **Import, do not copy**, the helpers `data/prepare_land_features.py` already has:
  `point_collection`, `run_sampler`, `cached_chunk`, `check_missing`, plus its manifest and
  `MAX_MISSING_FRACTION = 0.05` behaviour (raise above it, never report a drop count).
- `lights_reduction(ee)`: `NOAA/VIIRS/DNB/ANNUAL_V22`, image pinned by index in a constant
  (`VNL_IMAGE = "20250101"`, not "newest"), band `average_masked`, `.unmask(0)` (masked means no
  detectable light), mean over a `LIGHTS_BUFFER_M = 500` buffer at the image's own scale (463.83 m).
- `population_reduction(ee)`: `WorldPop/GP/100m/pop` filtered to `country == "MYS"`,
  `year == WORLDPOP_YEAR = 2020`, mosaic, **weighted** sum over `POPULATION_BUFFER_M = 1000` at
  92.77 m. Weighted on purpose, unlike fire's unweighted pixel counts: a pixel half inside the disc
  contributes half its people.
- Output `data/malaysia/vandalism_exposure.csv`: `tower_id, night_lights_nw, pop_1km, dark_rank,
  sparse_rank, exposure`. Missing stays NaN (JSON `null`), never 0.
- Manifest `data/malaysia/vandalism_exposure_manifest.json`: `build_id` (hash of asset ids, image
  index, buffers, input tower table hash), `built_at`, source vintages, row count, missing counts,
  and the measured ρ between the two components, so a later rebuild shows whether they still agree.
- Buffers and weights are **assumed** constants, stated as assumed in comments — same wording
  discipline as `SCREEN_BUFFER_M`.

### 3.2 Package — `src/backend/vandalism/`

The name was checked free in the backend venv on 2026-09-16 (see the `thermal/` vs `fire` collision
in CLAUDE.md). `vandalism/` is a peer of `thermal/` and imports neither `model.risk_index` nor
`model.maintenance_need`.

- `exposure.py` — `load_exposure() -> dict | None`, read once and cached. `None` when the CSV or
  manifest is absent or corrupt ("layer not built" is configuration, not an error). Body:
  `{build_id, built_at, sources, screened_towers, caveat, towers: {tower_id: {exposure,
  night_lights_nw, pop_1km}}}`. Under `USE_FIXTURE=1` no synthetic tower gets an entry, and
  `caveat` says why.
- `cameras.py` — `camera_catalogue() -> dict | None`:
  - JPS Selangor list fetched through `tiles/engine._ssl_context()` (certifi; the python.org build's
    missing CA bundle fails this host exactly as it failed Earth Engine), bounded timeout, cached
    24 h in memory.
  - Windy only when `WINDY_WEBCAMS_API_KEY` is set, via header `x-windy-api-key`. Image URLs are
    tokened and **expire after 10 minutes on the free tier**, so they are resolved per request and
    never cached past that. Every Windy image links to its Windy webcam page and carries the text
    "Webcams provided by Windy.com". *Verify at build:* the v3 nearby-search parameter name and
    response field names.
  - Per-tower nearest camera by haversine over the served population.
  - One source down → listed under `unavailable` with its reason. `None` only when every source
    failed. "No camera within 1 km of this tower" is a populated answer, not `None`.
  - *Verify at build:* which JPS image URL each `stationId` maps to, and whether it is served over
    HTTPS. opencctv's copy used `http://…/InfoBanjir.WebAdmin/CCTV_Image/8.jpg`, and an HTTP-only
    image cannot load in a deployed HTTPS app — link out instead.

### 3.3 Routes — `src/backend/api/routes/vandalism.py`

- `GET /vandalism/exposure` → body, or **503** "exposure layer not built — run
  data/prepare_vandalism_exposure.py". Never an empty 200.
- `GET /vandalism/cameras` → `{cameras: [{camera_id, source, name, lat, lon, direction: null,
  image_url, page_url, attribution, fetched_at}], unavailable: [{source, reason}],
  nearest_by_tower: {tower_id: {camera_id, distance_m}}}`.
- Register it in `api/main.py`, **and add a test that every module in `api/routes/` is registered.**
  Merge `4369f7d` silently dropped `fire`, `maps` and `confluence` — imports kept, routes 404 — and
  nothing failed until someone noticed in the browser (fixed in `4fca127`).

### 3.4 Work order — `site_hardening_review`

- `config/actions.yaml`:
  ```yaml
  # Reviewed site-hardening survey. NOT a risk factor and NOT reachable through
  # propose_action() — exposure is observed evidence beside the score (§0.6).
  # Discharges docs/MCMC_Fix_Note_Checklists.md "Other" items 5 and 6.
  # duration_hours and target_days are assumed demo figures, not operator data.
  site_hardening_review:
    action: site_hardening_review
    label: "Site hardening survey: fence, cabinet locks, cable trunking, lighting, access logbook"
    crew_type: civil
    parts: []
    lead_time_class: days
    duration_hours: 2.0
    target_days: 30
  ```
  A **survey**, not an install: fences and trunking have weeks of lead time, and a survey is what
  tells a planner which parts to order.
- `scheduler/actions.py`: `propose_site_hardening(tower, evidence, action_map)`, a sibling of
  `propose_fire_inspection()` — never routed through `propose_action()`. `urgency_days` from
  `target_days`; `dominant_factor=""`; `why` is an evidence sentence, e.g. *"unwatched-site
  exposure: 0.00 nW/cm²/sr within 500 m, ~40 people within 1 km (WorldPop 2020); planner
  reviewed"* — never a share, never the word "risk".
- `api/schemas.py`: `SiteHardeningRequest {build_id, planner_reviewed}`,
  `SiteHardeningEvidence {build_id, exposure, night_lights_nw, pop_1km, reviewed}`, and
  `WorkOrder.site_hardening: SiteHardeningEvidence | None = None` — declared, because pydantic drops
  undeclared keys (the comment on `fire_inspection` records that).
- `api/routes/schedule.py`: optional `site_hardening` body on preview and pin, beside
  `fire_inspection`. Same shape as the fire branch in `_resolve_work_orders`: runs before the early
  return; evidence built server-side from `load_exposure()`, never taken from the client; `409` on
  a standing order with a different action; `409` when `build_id` no longer matches; `404` for a
  tower with no exposure entry; `400` when `planner_reviewed` is false; crew type and territory
  guarded like `_fire_slot_guard`. **A request carrying both bodies is a 422.**

---

## 4. Frontend

- `api/types.ts` + `api/queries.ts`: `VandalismExposure`, `CameraCatalogue`,
  `useVandalismExposureQuery()`, `useCameraCatalogueQuery()`. Offline fallback is **`null`**, never a
  zeroed struct and never a fixture — these are measurements.
- **Layer panel** (`components/hud/LayerPanel.tsx`): a fifth category, `security`, labelled
  "Theft". The category grid is `grid-cols-4` today; check at real panel width in the browser whether
  five labels fit before choosing `grid-cols-5` or two rows. Two toggles — "Unwatched-site exposure"
  and "Public cameras" — in a small store (`state/useSecurityLayers.ts`), because these are not
  Earth Engine catalogue entries and `useFloodLayers.active` should not pretend they are. Include
  them in the category's enabled-count badge. Below the toggles, `VandalismExposureList`, as
  `FireExposureList` does: the top-decile towers, each with both numbers and units.
- **Map**:
  - `components/map/exposureLayer.ts`: an outline ring on top-decile towers. **It must not recolour
    the band halo** (band colour has one source, `lib/colors.ts`), must use a neutral ink stroke —
    neither warm (severity) nor accent (chrome) — and must take `towerFilterExpr` so band and area
    filters hide rings with their towers. It needs a legend with the numeric meaning: "top 10% of
    1,164 sites by darkness and sparse population".
  - `components/map/cameraLayer.ts`: a neutral camera glyph, above ground overlays and below the
    tower layers.
- **Camera popup** (`components/security/CameraPopup.tsx`): the operator's image
  (`referrerPolicy="no-referrer"`), name, source, fetched time, attribution, a link to the operator
  or Windy page, and — when a tower is within 1 km — *"{d} m from {tower_id}. Direction unknown;
  this is not a view of the site."* No refresh faster than the source updates.
- **Investigation page**: `components/investigation/VandalismExposurePanel.tsx`, beside
  `FireExposurePanel` (`pages/Investigation.tsx:438`). It shows the exposure percentile, both
  measurements with vintages, the nearest public camera with its distance, and one caveat line:
  "Covers dark, remote sites. Does not cover urban cable theft."
- **Schedule**: `components/schedule/SiteHardeningPanel.tsx` mirroring `FireInspectionPanel`
  (review checkbox, `build_id`, pin), and `SITE_HARDENING_KEY` in `lib/actions.ts`. Two similar
  panels are fine; do not extract a shared scaffold for two callers.
- **Copy never says:** "theft risk", "likely to be vandalised", "monitored", "covered by CCTV",
  "safe". It says: "exposure", "unwatched", "public camera nearby".

---

## 5. Honesty surface — non-negotiable

- Evidence beside the score, never inside it: `scored_towers()` records carry no vandalism key,
  pinned by a test (copy `test_scored_towers_carry_no_fire_key_and_their_attribution_is_untouched`).
- Three absences stay distinct in API and UI: **layer not built** (503 / `null`), **camera source
  unavailable** (listed with reason), **no camera within 1 km** (populated answer).
- Vintages are always printed: VIIRS image `20250101`, WorldPop **2020**. A six-year-old population
  grid is shown as such, not hidden.
- The Selangor caveat (§1) appears wherever the exposure percentile appears.
- Camera distance is never rounded into coverage language, and a camera's position is never
  treated as its field of view.

---

## 6. Build order

1. Producer + its tests → run it → commit the CSV and manifest (as `land_features.csv` is).
2. `vandalism/exposure.py`, `/vandalism/exposure`, and the router-registration test.
3. `actions.yaml` key, `propose_site_hardening`, schemas, the schedule branch, and tests.
4. `vandalism/cameras.py` + `/vandalism/cameras` — JPS first; Windy only behind the key.
5. Frontend: types/queries → Investigation panel → Layer panel category + map layers → Schedule panel.
6. Docs: a CLAUDE.md documentation-map row and backend-layout line; a `docs/Backend_Handoff.md` §1
   note that vandalism exposure, like fire, is not in the record.

---

## 7. Tests (backend, network-free)

- `vandalism/test_exposure.py`:
  - darker and emptier sites rank higher
  - the zero-light tie is broken by population
  - missing values stay null and are never 0
  - more than 5% missing raises
  - `build_id` moves with every input
  - `load_exposure()` returns `None` when the CSV is absent
  - an **AST check** that the module imports neither scorer and never writes `attribution`
    (the pattern is in `thermal/test_thermal_exposure.py`)
- `vandalism/test_cameras.py`:
  - a JPS row with `"-"` coordinates is skipped, not placed at 0,0
  - string coordinates parse
  - nearest-distance haversine is correct
  - one failed source is listed as unavailable, not returned as an empty list
  - Windy URLs are never served from cache past token life
- `api/test_site_hardening_schedule.py`, mirroring `api/test_fire_schedule.py`:
  - evidence is built server-side
  - a stale `build_id` is a 409
  - a standing order is never overwritten
  - crew type and territory are guarded
  - preview does not mutate the stored run
  - both bodies on one request is a 422
  - a Penang tower (no civil crew) lands in `unscheduled` explicitly
  - scored towers carry no vandalism key
- `api/test_router_registration.py`: every `api/routes/*.py` router is included in `app`.
- Frontend: `build` + `lint` + a browser check of the popup, rings, filters and category grid. Add a
  `lib/*.test.mjs` only if a pure helper with real logic appears.

---

## 8. Explicitly out of scope

- Detection of any kind on camera feeds (people, vehicles, ALPR), recording, frame archives,
  image-triggered alerts.
- A per-tower theft probability, or tuning weights against news-reported incidents.
- MBJB iTrafik and LLM cameras, until those operators publish coordinates.
- Operators' own on-site CCTV and alarm feeds — the real monitoring answer, but it needs operator data.
- Road access, grid distance, scrap yards, GHSL (reasons in §2).

---

## 9. Open questions

- Is the top decile the right suggestion size? It matches `MAINTAIN_QUANTILE`; crew capacity may
  argue for a count instead.
- Are `target_days: 30` and a 2 h survey acceptable demo figures?
- Is a news-incident sanity check wanted? MCMC statements geocoded to town level (e.g. the May 2026
  Bintulu cable theft) — reported cases only, too few to tune on, useful only as a smell test.
- Does the demo need Windy at all, given JPS Selangor alone gives 82 official, positioned cameras?

---

## Sources

- [MCMC, telcos join police to combat tower cable theft, vandalism – Bernama](https://www.bernama.com/en/general/news.php?id=2489841)
- [MCMC, Selangor govt launch campaign against telecom infrastructure vandalism – Scoop](https://www.scoop.my/news/289588/mcmc-selangor-govt-launch-campaign-against-telecom-infrastructure-vandalism/)
- [Over RM3mil losses from telecom infrastructure theft for Pahang in 2025 – FMT](https://www.freemalaysiatoday.com/category/nation/2026/08/06/over-rm3mil-losses-from-telecommunication-infrastructure-theft-for-pahang-in-2025)
- [MCMC probes alleged cable theft at Bintulu telco tower – Borneo Post](https://www.theborneopost.com/2026/05/28/mcmc-probes-alleged-cable-theft-at-bintulu-telco-tower/)
- [Windy Webcams API – Terms of Use](https://api.windy.com/webcams/terms) · [Documentation](https://api.windy.com/webcams/docs)
- [opencctv.org – Terms](https://opencctv.org/terms)
- [JPS Selangor InfoBanjir](https://infobanjirjps.selangor.gov.my/)
- Inspiration: [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (MIT) — projects public feeds onto 3D tiles; performs no detection.
