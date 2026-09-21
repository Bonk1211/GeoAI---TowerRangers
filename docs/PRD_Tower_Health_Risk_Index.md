# PRD — Tower Health Risk Index

**Team TowerRangers (HACK-MY-093)**
**ASEAN GeoAI Fusion 2026 · Innovation track**
**Version:** 1.0 (finalized scope) · **Prototype window:** ~1 day to preliminary submission

---

## 1. One-liner

An **interpretable, physics-grounded vulnerability index** that scores every cell tower by failure risk — where each factor is derived from open geospatial data via `opengeos/geoai`, every score is explainable to a named failure mechanism, and robustness is proven by rank-stability analysis instead of accuracy (because no failure logs exist).

---

## 2. What this is — and deliberately is not

**Is:** a transparent risk *index*. Each tower gets a bounded score `[0,1]`, an uncertainty band, and a per-factor "why." Built from known infrastructure-failure physics.

**Is not:** a trained failure *predictor*. There are no failure logs in the public domain, so there is no ground truth to train or validate a classifier against. **We do not fabricate labels.** Claiming accuracy/AUC on invented labels is the fastest way to lose the technical Q&A; claiming a defensible, auditable index is not.

> Pitch line: *"We deliberately did not fabricate failure labels to train a black box. We built an interpretable index grounded in failure physics, and we prove the ranking is stable rather than claiming an accuracy we cannot honestly measure."*

---

## 3. Users

- **Primary:** field-maintenance planners at ASEAN telecom operators — need *what to inspect and why*, not a raw number.
- **Secondary:** network-ops planners sizing crews / prioritizing hardening capex.
- **Tertiary:** regulators (e.g. MCMC) assessing infrastructure resilience of service-obligation areas.
- **End beneficiaries:** subscribers in degraded/rural areas exposed to long outages.

---

## 4. Product outputs

1. **Ranked tower risk table** — score + 95% uncertainty band per tower.
2. **Per-tower factor attribution** ("high because flood 0.7, power-distance 0.6, despite being new"). This is the feature planners actually act on.
3. **Interactive risk map** — towers coloured by risk; click a tower for its factor breakdown.
4. **Rank-stability figure** — proof the top-risk set survives weight perturbation (our validation substitute).
5. **Exposed-population layer** — shown *beside* risk, never folded into it. Risk answers "how likely to fail"; exposure answers "how much it matters." Combined only as an explicit dispatch tie-break, `priority = risk × log1p(exposed_pop)` (ML plan §C5).

---

## 5. Risk model — structure

Factors are **not** a flat weighted list. They split into two kinds, mirroring standard risk science (`risk = hazard × vulnerability`):

| Class | Factor | Failure mechanism it proxies |
|---|---|---|
| **Hazard** (external stressor) | Flood exposure | Water ingress, foundation scour, power loss |
| | Terrain (slope / ruggedness) | Landslide, wind load, access difficulty |
| | Lightning exposure | Strike damage to electronics |
| **Vulnerability** (asset susceptibility) | Equipment generation | Older radios (2G/3G) fail more |
| | Distance to power / grid | Grid dependence → outage on grid failure |
| | Age *(optional)* | Wear-out failures |

---

## 6. Data + geoai API modules (the backend surface)

All sources are **open and global**, so the pipeline reruns for any AMS with no new collection. geoai is **load-bearing**: two factors (flood, age) and the exposure layer cannot be built without its deep-learning perception.

| Factor / layer | Source | geoai module → function | What we get |
|---|---|---|---|
| Terrain | Copernicus DEM (`cop-dem-glo-30`) | `download.pc_stac_search` / `pc_stac_download` / `download_pc_stac_item` (Planetary Computer STAC) | DEM raster → slope, TRI (ruggedness), HAND |
| Flood exposure | Sentinel-2 imagery + OSM | `water.segment_water(input_path, band_order="sentinel2", output_vector=..., use_osm_water=True)` | Water polygons → distance-to-water; combined with HAND from DEM |
| Exposure / population | Overture Maps (dense areas) | `download.download_overture_buildings` → `download.extract_building_stats` | Building count + footprint area per tile |
| Exposure — dark zones | Sentinel-2 imagery | `extract.BuildingFootprintExtractor(...).process_raster(...)` | Footprints from imagery where Overture is sparse (rural) |
| Land-cover context | ESA WorldCover / imagery | `classify.classify_image(...)` | Built-up vs. vegetation/water context per tile |
| Equipment generation | OpenCellID (`radio` field) | *(direct data, no model)* | GSM / UMTS / LTE / NR → equipment-age proxy |
| Lightning | NASA LIS/OTD flash-rate climatology | *(raster sample at tower point)* | Flash density per tower |
| Power distance | VIIRS night-lights + OSM power | *(raster/vector distance)* | Electrification + distance-to-grid proxy |
| Tower age *(optional)* | Bi-temporal imagery | `change_detection.ChangeStarDetection` / `changestar_detect` | First-appearance estimate → coarse age |
| Text-prompt fallback | Any imagery | `segment.GroundedSAM` / `segment.CLIPSegmentation` | Prompt-driven extraction ("water", "buildings") if a model is missing |
| Visualization | — | `geoai.Map` / `geoai.LeafMap` | Interactive risk map + factor popups |

> Imagery note for **ASEAN AOIs**: `download.download_naip` is **US-only** — NAIP does not cover Malaysia. The imagery path here is **Sentinel-2 via `pc_stac_search`**, and `segment_water` must be called with `band_order="sentinel2"` (valid presets: `"naip"`, `"sentinel2"`, `"landsat"`). NAIP is fine only as a US smoke-test tile.

> Honest note on **age**: nearly unobservable. Either derive a coarse proxy from `ChangeStarDetection` (a genuine geoai flourish) or **drop it and say why**. Four well-grounded factors beat five with one fabricated.

---

## 7. ML / modeling approach

There are **two distinct layers**, and being explicit about which is "AI" is what makes the technical summary credible.

### 7.1 Perception layer — this is the deep learning
The ML that is load-bearing here is **geoai's deep-learning perception**: semantic **water segmentation** (U-Net/SAM-based), **building-footprint extraction** (Mask R-CNN-family), optional **land-cover classification** and **ChangeStar change detection**. These turn raw imagery + DEM into the *risk drivers that exist in no table*. Lead the GeoAI methods section with water-segmentation-for-flood and footprints-for-exposure.

### 7.2 Scoring layer — interpretable index, not a classifier
Because there are no labels, the index is **unsupervised and physics-based**, in three steps:

1. **Membership functions (nonlinear normalization).** Map each raw factor to a failure-contribution `pᵢ ∈ [0,1]` through a **monotonic sigmoid / piecewise curve whose shape is physically justified** — e.g. flood risk rises steeply 0→0.5 m then saturates. *Not* linear min–max, which misrepresents risk.

2. **Probabilistic-OR combination (noisy-OR), not weighted sum.**
   ```
   Risk = 1 − Π (1 − pᵢ · wᵢ)
   ```
   Read as "probability at least one driver triggers failure." Bounded, monotonic, and **any single severe factor dominates** — matching weakest-link infrastructure failure. A weighted average would wrongly average a new tower in a severe flood zone down to "safe." Keep the additive form only as a documented comparison baseline.

3. **Weighting via AHP or literature.** Set `wᵢ` by **AHP** (structured pairwise comparison — documentable and defensible) or from failure-driver importance in telecom/infrastructure reliability literature. Not hand-tuned.

### 7.3 Optional calibration path (only if partial data appears)
If *any* real outage/failure signal can be obtained (even sparse), calibrate weights via **weak supervision / logistic regression** and report it as calibration, not training. Absent that, AHP stands. Do **not** invent labels to enable a classifier.

### 7.4 Validation substitute — rank stability
No labels ⇒ no accuracy ⇒ we prove **robustness** instead. **Monte-Carlo perturb the weights** (few hundred draws) and measure how much the tower ranking moves (rank correlation; share of towers that stay in the top-10% across all perturbations). Stable top-risk set ⇒ the result is not an artefact of arbitrary tuning. **This rank-stability number is the headline defensible metric**, the same role the counterfactual played before.

---

## 8. Backend architecture

Two-tier, so the demo stays responsive and the heavy work runs once:

```
[ Batch geoprocessing tier ]  (GPU / Colab, run once per AOI)
  geoai: pc_stac_download (DEM) · segment_water · BuildingFootprintExtractor
        · extract_building_stats · classify_image · (ChangeStar)
  + raster sampling (lightning, night-lights, power distance)
  → per-tower FEATURE TABLE  (towers × raw factors)  ── cached as GeoParquet/CSV

[ Scoring service tier ]  (lightweight, numpy, real-time)
  membership functions → noisy-OR → AHP weights
  → risk score + factor attribution + Monte-Carlo rank stability
  → served to the map UI; weights adjustable LIVE without re-running geoai
```

The split matters for the demo: a judge can **drag a weight slider and watch the ranking update instantly**, because geoai perception is precomputed and only the fast index recomputes.

---

## 9. Headline metric & demo script

- **Primary metric:** rank stability — *"the top-10% highest-risk towers stay in the top-10% across N weight perturbations (rank-corr ρ = …)."*
- **Demo:** open map → click the top tower → read its factor attribution → drag a weight slider → show the ranking barely moves (stability) → highlight one tower that is high-risk *despite being new* (flood + power distance) as the "the index sees what age-based inspection misses" moment.

---

## 10. Scope for ~1 day (protect two things)

**Must ship:** (1) explainable per-tower factor breakdown, (2) Monte-Carlo rank-stability figure. These are the entire defensible core.

**Ship:** one real AOI · four grounded factors (flood via `segment_water` + DEM-HAND, terrain via DEM, lightning via raster, equipment via OpenCellID) · noisy-OR · AHP/literature weights · explainable output map.

**Cut:** age unless `ChangeStar` is trivial · full-AOI imagery pipelines (sample tiles are fine).

**Scope:** national — all Malaysian towers scored. The four raster/table factors (terrain, lightning, power distance, equipment) compute nationally; flood and population require perception and run per AOI, with partial-factor towers flagged in the UI.

**Language rule.** This is predictive maintenance and we claim the category directly: we predict maintenance **need, priority, and urgency**. What stays off-limits is the failure **probability** — no hazard rates, no accuracy figures, because no failure labels exist to calibrate them. See [ML Implementation Plan §0.0](ML_Implementation_Plan.md).

---

## 11. Limitations (state these openly — they build credibility)

- Risk factors are **proxies**, not failure logs; the model is a vulnerability index, not a validated predictor.
- Flood/terrain rest on DEM resolution and water-segmentation quality; both approximate.
- Pretrained perception models carry a **domain gap** on ASEAN imagery (building styles/materials differ from US/EU training data).
- Equipment generation is a proxy for age/reliability, not a condition assessment.
- OpenCellID tower positions are crowd-sourced and imperfect.
- AHP weights encode expert judgment; the rank-stability analysis is what bounds their arbitrariness.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| "Where's the AI? This is a spreadsheet." | Lead with geoai perception: flood from water segmentation, exposure from footprints — factors that exist in no table. |
| "Validated against what?" | Reframe as interpretable index; present rank stability, never accuracy. |
| Live geoai model fails mid-demo | Precompute the feature table; the scoring tier needs only numpy. Road/age extraction shown on one tile, not the critical path. |
| Weighted-sum objection | Noisy-OR chosen deliberately; weighted-sum kept as documented comparison. |
| Data source unavailable at demo time | All layers cached to GeoParquet/CSV beforehand; nothing fetched live. |
