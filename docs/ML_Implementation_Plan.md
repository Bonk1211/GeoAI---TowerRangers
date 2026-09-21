# ML Implementation Plan — Tower Health Risk Index

**Scope:** the ML component only — (A) perception models, (B) feature engineering, (C) the risk-index model, (D) label-free validation, (E) the maintenance decision layer. Excluded: map UI, API server, data-catalog plumbing (marked as handoff points ▶).

**Honest framing:** almost no model *training* happens here. Perception is **pretrained inference**; the index is an **unsupervised, physics-based scorer**; validation proves **robustness, not accuracy** (no failure labels exist).

**Implementation status (2026-08-11):** the concrete pilot AOI is the dense
urban area around Sunway University, Selangor. The source-backed dataset in
[`data/pilot_sunway`](../data/pilot_sunway) fills 10/12 contract fields for
132 operator-sites from real 4G/5G measurements, Copernicus DEM, ASF HAND,
OpenStreetMap, and WorldPop. `flash_density` and `age_years` remain explicit
nulls for the documented reasons in [`PILOT_DATASET.md`](PILOT_DATASET.md).

---

## 0.0 What this delivers in predictive-maintenance terms

This project is **condition-based predictive maintenance**. Classical PdM reads vibration, temperature, and current off a machine to judge its condition. Cell towers across an ASEAN footprint have no such telemetry in the public domain — so we substitute **remotely sensed environmental condition**, derived by deep learning from imagery and elevation data. *That substitution is the innovation claim*, and it is what makes the perception stage load-bearing rather than decorative.

The full PdM pipeline and where each stage lives:

| PdM stage | Classical equivalent | Here | Owner |
|---|---|---|---|
| Condition sensing | Vibration/thermal sensors | Perception from imagery + DEM | **(A)** this doc |
| Condition indicators | Feature extraction from signal | Per-tower factor table | **(B)** this doc |
| Health assessment | Health index / RUL model | Risk index + attribution | **(C)** this doc |
| **Maintenance decision** | Alarm thresholds | **Maintain / watch / OK + urgency** | **(E)** this doc |
| Work-order generation | CMMS rule set | Action mapping | Scheduler PRD |
| Scheduling | Planner / CMMS | Constrained optimizer + agent | Scheduler PRD |

**What we predict, precisely:** maintenance *need* and *priority* — which towers warrant intervention, driven by which mechanism, and how soon. **What we do not predict:** failure events or failure probabilities. A statement like "30% chance of failure within six months" is a hazard rate; it requires failure logs to calibrate and none exist publicly. Both are predictive maintenance; only the first is defensible with open data. Say the first, decline the second, and say why.

---

## 0. Architecture of the ML pipeline

```
   IMAGERY + DEM + POINT DATA
            │
   (A) PERCEPTION  ── geoai pretrained inference ──► raw geospatial layers
            │                                        (water polygons, footprints,
            │                                         DEM derivatives, land cover)
   (B) FEATURE ENGINEERING ── raster math + spatial joins ──► FEATURE TABLE
            │                                        (towers × raw factor values)
   ─────────┼───────────  ⟵ CONTRACT: the feature table is the interface ⟶
            │
   (C) INDEX MODEL ── membership → noisy-OR → AHP weights ──► score + attribution
            │
   (E) DECISION LAYER ── bands + urgency ──► maintain/watch/OK + urgency_days
            │                                (handoff ▶ scheduler)
   (D) VALIDATION ── Monte-Carlo rank stability + ablations + unit tests
```

**Critical decoupling:** the **feature table schema (§1)** is a hard contract. Build (C)+(D) against a *synthetic* feature table on hour one — they need only numpy/pandas and no GPU — so the defensible core (score + rank-stability figure) exists **regardless of whether perception finishes**. Swap real features in when (A)+(B) land.

**Suggested 2-person split:**
- **Person 1 (GPU/Colab):** (A) perception + (B) feature engineering.
- **Person 2 (laptop):** (C) index + (D) validation on synthetic table, then integrate.

---

## 1. Data contract — the feature table

One row per tower. Raw (un-normalized) factor values + provenance.

| Column | Type | Units | Source stage |
|---|---|---|---|
| `tower_id` | str | — | OpenCellID |
| `lon`, `lat` | float | deg | OpenCellID |
| `radio` | cat | GSM/UMTS/LTE/NR | OpenCellID |
| `dist_water_m` | float | m | (B) from water polygons |
| `hand_m` | float | m | (B) HAND from DEM |
| `slope_deg` | float | deg | (B) from DEM |
| `tri` | float | — | (B) from DEM |
| `flash_density` | float | fl/km²/yr | (B) raster sample |
| `dist_power_m` | float | m | (B) distance-to-grid |
| `age_years` | float\|NaN | yr | (A) ChangeStar *(optional)* |
| `exposed_pop` | float | count | (A/B) footprint stats — **consequence, not a risk factor** |

**Acceptance:** every column populated (or explicit NaN with a documented default), no silent zeros. Cache as GeoParquet + CSV.

> **`exposed_pop` is not an input to the index.** It measures *how much it matters if this tower fails*, not *how likely it is to fail*. Feeding it into the noisy-OR alongside hazard factors would conflate likelihood with consequence and make both the score and its attribution uninterpretable — a large village next to a structurally sound tower would read as "high risk." It travels through the pipeline as a **parallel column**, used for display and for explicit dispatch tie-breaking (§C5). Never add it to `memberships()`.

---

## 2. Phase A — Perception (pretrained inference)

No training. Run geoai pretrained models to produce raw layers. Env: Colab GPU; `pip install geoai-py`. **All outputs cached to disk** — perception never runs in the live path.

### A1 · Imagery + DEM acquisition ▶ (borderline infra, but needed to feed models)
- `download.pc_stac_search(collection="cop-dem-glo-30", bbox=...)` → `pc_stac_download` → DEM raster.
- `download.pc_stac_search(collection="sentinel-2-l2a", bbox=..., time_range=..., query={"eo:cloud_cover": {"lt": 10}})` → imagery.
- **Malaysia AOI ⇒ Sentinel-2 is the only imagery path.** `download.download_naip` is **US-only** (NAIP has no ASEAN coverage) — usable for a smoke-test tile, never for the real AOI. Do not drift to NAIP because the upstream tutorials use it.
- **Acceptance:** DEM + one cloud-free image mosaic covering the AOI on disk.

### A2 · Water segmentation → flood driver
- `water.segment_water(input_path=img, band_order="sentinel2", output_vector="water.geojson", use_osm_water=True)`.
- **Band-order presets are exact strings** (verified against source): `"naip"` `[1,2,3,4]` · `"sentinel2"` `[3,2,1,4]` · `"landsat"` `[4,3,2,5]`. A list of 4 one-based band indices also works. `"s2"` is **not** valid — it fails at runtime.
- Backed by **OmniWaterMask**: deep model fused with NDWI + OSM, sensor-agnostic, 0.2–50 m resolution. `use_osm_water` / `use_osm_building` / `use_osm_roads` all default `True`.
- Tunables if output is noisy over the AOI: `patch_size=1000`, `overlap_size=300`, `min_size=10`, `smooth=True`.
- Output: water polygons. **Acceptance:** visual check water bodies are captured; export non-empty GeoJSON.

### A3 · Building footprints → exposure
- Dense areas: `download.download_overture_buildings(bbox=...)` → `download.extract_building_stats(gdf)`.
- Dark/rural tiles: `extract.BuildingFootprintExtractor(...).process_raster(img)`.
- Output: footprint polygons + per-area counts. **Acceptance:** footprint count sane vs. eyeball.

### A4 · Land cover *(context, optional)*
- `classify.classify_image(image_path, model_path, output_path=...)` → built-up/veg/water raster.

### A5 · Tower age *(optional, cut first)*
- `change_detection.ChangeStarDetection` / `changestar_detect` on bi-temporal imagery → first-appearance estimate.
- **If not trivial, drop `age_years` (set NaN) and document.** Four grounded factors beat five with one fabricated.

**Fallback if a model fails:** `segment.GroundedSAM` / `CLIPSegmentation` with a text prompt ("water", "buildings") as a drop-in for A2/A3 on the demo tile.

---

## 3. Phase B — Feature engineering (raster → per-tower factors)

Pure geospatial math; no deep learning. Libs: `rasterio`, `numpy`, `geopandas`, `scipy.ndimage`, and `richdem` **or** `xarray-spatial` for terrain/HAND.

- **Terrain:** `slope_deg` and `tri` (Terrain Ruggedness Index = mean abs elevation diff to 8 neighbours) from DEM. `richdem.TerrainAttribute(dem, attrib="slope_degrees")`.
- **HAND** (Height Above Nearest Drainage): flow-accumulation → drainage → per-cell height above it (`pysheds` or `richdem`). Primary flood driver alongside distance-to-water.
- **Flood inputs:** `dist_water_m` = distance from each tower to nearest water polygon (`gpd.sjoin_nearest`); `hand_m` = sample HAND raster at tower point.
- **Lightning:** sample flash-density raster at tower point (`rasterio.sample`).
- **Power distance:** distance-to-grid from OSM power lines / VIIRS night-lights threshold (`sjoin_nearest` / distance transform).
- **Exposure:** footprint count/area within tower service buffer (spatial join).

**Acceptance:** feature table (§1) fully populated; run monotonic spot-checks (a tower in a valley by a river has high HAND-risk + low `dist_water_m`).

---

## 4. Phase C — Index model (the core ML deliverable)

Unsupervised, interpretable, three steps. Lib: numpy/pandas only → runs anywhere, real-time.

### C1 · Membership functions (raw → failure-contribution `pᵢ ∈ [0,1]`)
Nonlinear, monotonic, **physically justified shapes** (not linear min–max). Each factor gets a config with shape + params + justification:

| Factor | raw → p | Shape & params | Justification |
|---|---|---|---|
| Flood (HAND) | `p = 1/(1+exp(k*(hand - h0)))`, `h0≈5 m, k≈0.6` | logistic, **decreasing** in HAND | risk high near drainage level, saturates when safely elevated |
| Flood (dist-water) | `p = exp(-d / d0)`, `d0≈150 m` | exponential decay | proximity to water raises ingress/scour risk |
| → combine two flood sub-signals | `p_flood = 1-(1-p_hand)(1-p_dist)` | noisy-OR of sub-signals | either mechanism suffices |
| Terrain (slope) | `p = 1/(1+exp(-k*(s - s0)))`, `s0≈25°, k≈0.25` | logistic, increasing | landslide/access risk rises past a slope threshold |
| Terrain (TRI) | min-max within AOI, capped | monotone increasing | ruggedness → access + wind |
| Lightning | `p = min(f / f_ref, 1)`, `f_ref` = high regional percentile | linear-saturating | strike damage ∝ flash density |
| Equipment | lookup: GSM 0.8, UMTS 0.6, LTE 0.3, NR 0.1 | categorical | older generations less reliable |
| Power distance | `p = 1 - exp(-d / d0)`, `d0≈2 km` | increasing saturating | grid dependence + backup strain |
| Age *(opt)* | `p = 1/(1+exp(-k*(a - a0)))`, `a0≈15 yr` | logistic increasing | wear-out failures accelerate with age |

Store as an editable config dict so shapes/params are tunable and auditable.

### C2 · Combination — noisy-OR (not weighted sum)
```
Risk = 1 − Π_i (1 − pᵢ · wᵢ)        # wᵢ ∈ [0,1] = max contribution of factor i
```
Bounded, monotonic, **one severe factor dominates** (weakest-link). Keep additive weighted-sum only as a documented comparison baseline for §6.

### C3 · Weights — AHP
1. Build pairwise comparison matrix over the ~5 factors (expert/literature judgment, Saaty 1–9 scale).
2. Weights = principal eigenvector (normalized). `numpy.linalg.eig`.
3. **Consistency ratio CR < 0.1** (else revise). Report CR in the writeup.
- Alternative seed: importance from telecom/infrastructure reliability literature. Document whichever.

### C4 · Explainability — factor attribution
Per tower, report each factor's contribution to the noisy-OR. Practical attribution: **leave-one-out drop** — `Δᵢ = Risk − Risk_without_i` — normalized to shares. Output: `"Tower X: 0.82 — flood 0.41, power 0.28, terrain 0.19, equip 0.12"`. This is the planner-facing deliverable and the demo's memorable moment.

### C5 · Consequence — kept outside the score

`risk` (C2) is **likelihood only**. Consequence is carried separately and combined only where ordering demands it, visibly:

```python
def priority(risk, exposed_pop):
    """Dispatch ordering only. NOT the risk score, never displayed as 'risk'."""
    return risk * np.log1p(exposed_pop)
```

**Rules:**
- `exposed_pop` never enters `memberships()` or `noisy_or()`.
- The UI shows `risk` and `exposed_pop` as **two columns and two map layers**; `priority` appears only in the schedule view, labelled as an ordering key.
- The scheduler (§6.5) orders by `priority` when exposure is available, and falls back to `risk` when it is not — so a missing exposure layer degrades the ordering, never the score.

**Acceptance:** dropping `exposed_pop` entirely changes the schedule order but leaves every risk score and every attribution byte-identical. This is the test that proves the separation holds.

---

## 5. Core code skeleton (Phase C)

```python
import numpy as np, pandas as pd

# ---- C1 membership ------------------------------------------------------
def logistic(x, x0, k):           return 1/(1+np.exp(-k*(x-x0)))
def inv_logistic(x, x0, k):       return 1/(1+np.exp( k*(x-x0)))
def exp_decay(x, x0):             return np.exp(-x/x0)
def exp_sat(x, x0):               return 1-np.exp(-x/x0)

EQUIP = {"GSM":0.8,"UMTS":0.6,"LTE":0.3,"NR":0.1}

def memberships(df):
    p = pd.DataFrame(index=df.index)
    p_hand = inv_logistic(df.hand_m, 5, 0.6)
    p_dist = exp_decay(df.dist_water_m, 150)
    p["flood"] = 1-(1-p_hand)*(1-p_dist)
    p["terrain"] = np.maximum(logistic(df.slope_deg,25,0.25),
                              (df.tri-df.tri.min())/(df.tri.max()-df.tri.min()+1e-9))
    p["lightning"] = np.minimum(df.flash_density/df.flash_density.quantile(0.95),1)
    p["equipment"] = df.radio.map(EQUIP).fillna(0.5)
    p["power"] = exp_sat(df.dist_power_m, 2000)
    if df.age_years.notna().any():
        p["age"] = logistic(df.age_years.fillna(df.age_years.median()),15,0.3)
    return p.clip(0,1)

# ---- C2 noisy-OR + C4 attribution --------------------------------------
def noisy_or(p, w):               # p:(n,f) DataFrame, w:dict
    W = np.array([w[c] for c in p.columns])
    return 1 - np.prod(1 - p.values*W, axis=1)

def attribution(p, w):
    full = noisy_or(p, w)
    shares = np.zeros_like(p.values)
    for j,c in enumerate(p.columns):
        p2 = p.copy(); p2[c] = 0.0
        shares[:,j] = full - noisy_or(p2, w)     # leave-one-out drop
    shares = shares/ (shares.sum(1,keepdims=True)+1e-9)
    return full, pd.DataFrame(shares, columns=p.columns, index=p.index)

# ---- C3 AHP -------------------------------------------------------------
def ahp_weights(M):               # M: (f,f) Saaty pairwise matrix
    val,vec = np.linalg.eig(M)
    w = np.real(vec[:,np.argmax(np.real(val))]); w = w/w.sum()
    n=len(M); lmax=np.real(val.max()); CI=(lmax-n)/(n-1)
    RI={3:0.58,4:0.90,5:1.12,6:1.24}.get(n,1.12); CR=CI/RI
    return w, CR
```

---

## 6. Phase D — Validation (label-free)

No labels ⇒ no accuracy. Prove the ranking is **not an artefact of arbitrary choices**. This is the headline ML result.

### D1 · Monte-Carlo weight rank-stability (primary metric)
- Perturb AHP weights N≈500× (multiplicative lognormal noise σ≈0.25, renormalize; or Dirichlet around AHP weights).
- Recompute risk + ranks each draw.
- Report: **Spearman ρ** vs baseline ranking (distribution), and **top-decile retention** (share of baseline top-10% towers that stay in top-10% across draws).
- **Target headline:** *"top-risk towers stay top-risk across weight perturbation — ρ = 0.9x, top-decile retention = xx%."*

### D2 · Membership-parameter sensitivity (second axis)
- Perturb curve thresholds (`h0, s0, a0`) ±30%; confirm ranking stable. Shows the result isn't hostage to a single hand-picked knot.

### D3 · Ablation (shows each factor earns its place)
- Drop each factor; measure rank shift. A factor that changes nothing is dead weight; a factor that changes everything needs a defense.

### D4 · Unit / sanity tests (correctness)
- All `pᵢ=0` ⇒ Risk 0; any `pᵢ=1, wᵢ=1` ⇒ Risk 1.
- **Monotonicity:** increasing any hazard never decreases Risk (property test over random inputs).
- Face validity: a hand-placed flood-prone tower ranks high.
- Noisy-OR vs weighted-sum comparison: show a new tower in a severe flood zone that weighted-sum wrongly averages to "safe" but noisy-OR flags — this *justifies the model choice* on one slide.

### D5 · Deliverable figure
Bar/violin of ρ distribution + top-decile retention. This is your validation substitute, the analogue of the earlier counterfactual figure.

---

## 6.5 Phase E — Maintenance decision layer (score → decision)

A score is not a decision. PdM requires a **maintain / watch / OK** call and an **urgency**, and that step must be as auditable as the index itself. This is the ML deliverable that makes the track claim literal, and it is the handoff point to the scheduler (E1 action mapping consumes `decision` + `urgency_days` + the dominant factor).

### E1 · Decision bands (maintain / watch / OK)

Thresholds must be **stated policy, never arbitrary cutoffs** — a judge will probe the legend. Two defensible options; pick one and document it:

- **Capacity-anchored (preferred).** The band boundary is set so the "maintain" set matches inspection capacity — e.g. top decile = what the crews can actually service in the cycle. Defensible because it is an operational statement, not a claim about absolute risk.
- **Absolute-risk-anchored.** Fixed score thresholds (e.g. ≥0.70 maintain, 0.45–0.70 watch). Simpler, but implies the score is calibrated to a probability — which it is not. If used, say so explicitly.

Default: capacity-anchored, reported as *"top 10% by risk, which equals one inspection cycle at current crew capacity."*

### E2 · Urgency (how soon)

Urgency is **not** the risk score rescaled. It combines severity with how fast the driving mechanism acts:

```
urgency_days = base_days[dominant_factor] × (1 - risk)
```

`base_days` comes from the mechanism's own timescale — lightning and power faults degrade in days, flood ingress over a wet season, equipment obsolescence over quarters. A high-risk lightning tower is genuinely more urgent than an equally-scored equipment-generation tower, because the failure mode arrives sooner. Cap to the SLA policy ceiling.

Store `base_days` in the same editable, auditable config as the membership curves.

### E3 · Uncertainty band → decision confidence

The Monte-Carlo draws from D1 already give a risk **distribution** per tower, not a point value. Reuse it here at no extra cost: a tower whose band straddles a decision boundary is flagged **"borderline"** rather than silently binned. This is the honest use of the uncertainty band and it costs one comparison.

### E4 · Outputs (contract to the scheduler)

```python
{
  "tower_id": "MY_1042",
  "risk": 0.82, "risk_lo": 0.76, "risk_hi": 0.88,   # from D1 draws
  "decision": "maintain",            # maintain | watch | ok
  "borderline": False,               # band crosses a threshold
  "dominant_factor": "flood",        # argmax of C4 attribution
  "urgency_days": 14,
  "why": "flood 0.41, power 0.28, terrain 0.19, equipment 0.12",
}
```

**Acceptance:** decision bands reproduce from config alone (no hand-edits); every `maintain` row carries a dominant factor and an urgency; borderline flags appear where bands cross thresholds.

---

## 7. Timeline & cut-lines (~1 day)

| Block | Task | Owner | Est |
|---|---|---|---|
| 0–2 h | Freeze feature schema; build synthetic feature table; stand up C1–C4 + D1 on it | P2 | 2 h |
| 0–3 h | Colab: DEM + imagery via STAC; run `segment_water` + footprints | P1 | 3 h |
| 2–4 h | Feature engineering: slope/TRI/HAND, distances, raster samples → real table | P1 | 2 h |
| 2–4 h | AHP matrix + CR; membership config finalized w/ justifications | P2 | 2 h |
| 4–5 h | Integrate real feature table into scorer; attribution output | both | 1 h |
| 4–5 h | Decision layer E1–E2: bands + urgency config → `decision`/`urgency_days` | P2 | 0.5 h |
| 5–7 h | Validation suite D1–D4; produce D5 figure | P2 | 2 h |
| 5–7 h | Ablation + noisy-OR-vs-sum slide; face-validity checks | P1 | 2 h |

**Must ship:** C1–C4 (score + attribution), E1–E2 (decision + urgency), and D1 (rank stability). Those are the defensible ML core.
**Cut in order:** age (A5) → land cover (A4) → E3 borderline flags → D2 → full-AOI perception (sample tiles suffice).
**Never cut:** attribution (C4), the decision layer (E1–E2), and rank stability (D1).

**Language rule (revised).** This *is* predictive maintenance — condition-based rather than calendar-based — and we claim that use case directly. What stays off-limits is the narrower claim: we predict maintenance **need, priority, and urgency**; we never state a failure **probability**, hazard rate, or accuracy figure, because no failure labels exist to calibrate one. Claim the category, decline the number, and say why.

---

## 8. Dependencies

`geoai-py` (perception, GPU) · `rasterio`, `richdem`/`xarray-spatial`, `pysheds` (terrain/HAND) · `geopandas`, `shapely` (spatial joins) · `numpy`, `pandas`, `scipy` (index + AHP + stats) · `matplotlib` (figure). Scoring + validation tiers depend on **numpy/pandas/scipy only** — no GPU, no geoai — so they run on any laptop and in the live demo.

---

## 9. Optional: the one legitimate "trained model" path

Only if *real* outage/failure signal appears (even sparse): calibrate weights via **weak-supervision logistic regression** on that signal and report as *calibration*, not training. Absent it, AHP stands. **Do not fabricate labels to enable a classifier** — an unvalidated predictor is weaker than an honest index, and the panel will ask "validated against what?"

### ~~Implemented operational policy surrogate (2026-08-12)~~ — WITHDRAWN 2026-08-31

A binary classifier was trained as a deployable surrogate for the explicit
physics-based maintenance-queue policy, and its out-of-fold probability was
served as the displayed `risk`. It has been removed, along with the notebook
that produced it and the `model_policy_disagreement` badge that compared it
against the policy it was fitted to.

**Why.** Its label was a quantile cut on `technical_risk`, which is the noisy-OR
over membership curves of the same six features the model was given. Asking a
logistic regression to reproduce a monotone threshold on a deterministic
function of its own inputs is not a learning problem, and its 0.974 out-of-fold
ROC AUC measured inversion of arithmetic rather than prediction. The surrogate
was careful in every other respect — grouped CV by colocated site, exposure
excluded from the target, the policy origin stated plainly in its metadata — but
none of that changes what the metric was measuring.

This is what §9 above warns against, four lines earlier: *"Do not fabricate
labels to enable a classifier — an unvalidated predictor is weaker than an
honest index."* The section is kept rather than deleted so the reasoning is on
the record and the surrogate is not rebuilt from the same premise.

`risk` is now the noisy-OR index itself, computed in `adapter/ml_source.py` by
calling `model/risk_index.py`. The `MAINTENANCE` / `NO_MAINTENANCE_NOW`
interface is served by the capacity-anchored quantile bands, which is where it
was already coming from for every tower the classifier did not force.

**What replaces it:** a supervised model over a label we did not generate — and
its result is null. See §10.

---

## 10. Signal residual over observed operator measurements (2026-08-31)

The first non-circular supervised work in this project, and the honest answer is
that environment does not explain measured signal quality at this AOI.

**Design.** `data/prepare_signal_panel.py` aggregates the 30,925 drive-test
measurements in `data/pilot_sunway/raw/mendeley/` into one row per (node, drive
session): median RSRP, median SNR/CQI, and `link_distance_m` from the handset to
the node it was served by. `model/signal_performance.py` then fits three nested
Ridge models, each scored out-of-fold with `GroupKFold` on the physical site, so
no mast appears in both train and test:

| model | held-out R² | MAE (dB) | per-fold R² |
|---|---|---|---|
| null (training-fold mean) | −0.044 | 7.38 | — |
| geometry | −0.038 | 7.23 | 0.05, −0.06, −0.17, −0.44, −0.00 |
| geometry + environment | −0.096 | 7.41 | −0.25, −0.03, −0.44, −0.50, 0.22 |
| **incremental R² (environment)** | **−0.058** | | |

Panel: 315 rows, 48 sites, 22 sessions. Target sd 8.80 dB.

**The result is null, and so is the baseline.** Environment adds nothing over
geometry — but geometry adds essentially nothing over the mean either. Nothing
here predicts a held-out site's median RSRP.

**Why, diagnosed rather than asserted.** 61% of the target's variance is between
sites, so site-level prediction is the right frame; but the site-level
correlation between mean link distance and mean level is only −0.26 across 48
sites, an R² ceiling near 0.07 before any cross-validation. Every univariate
correlation is weak (strongest: `dist_water_m` +0.20, `log_distance` −0.12).
Once measurements are aggregated to per-session medians over drive routes inside
a 2.4 km AOI, the distance leverage that makes path loss predictable is largely
averaged away, and what separates sites is antenna tilt, height, power and
sector — none of which this project has.

**The sign flips with an arbitrary threshold.** Incremental R² is −0.058 with
nodes at ≥20 measurements and +0.024 at ≥30. An effect that changes sign on the
inclusion rule is noise, and the sensitivity check exists to catch exactly that.

**What was ruled out.** The pipeline recovers a planted −20·log10(d) law at
R² > 0.8 on synthetic data (`test_geometry_recovers_a_planted_distance_effect`),
so the null is a property of the data rather than a broken script. Grouping is
asserted directly: no site appears in both folds.

**Limitations, in order of how much they matter.** The AOI is 5.7 km², leaving
almost no environmental gradient to detect. n is 48 groups. `link_distance_m`
derives from centroid-estimated node positions, so it is a control measured with
error that under-controls path loss. Soil moisture and forecast rainfall are
excluded because at 9 km and 27.75 km per pixel they are constant across this
AOI — a zero-variance column would receive an arbitrary coefficient that then
gets described as an effect.

**What this is worth.** It bounds what the risk index may claim: on this AOI,
site environment demonstrably does not predict delivered signal quality, so the
index should not be presented as if it did. The per-site residual from the
geometry model is written to `data/pilot_sunway/signal_residuals.csv` and is
**not served** — with a geometry model this weak, "underperforms its geometry"
is mostly unexplained variance, and promoting it into the scored-tower contract
would dress noise as a second opinion.

**The path to a real result is a wider AOI, not a better model.** At ~9 km the
soil-moisture layer begins to vary; at ~30 km the forecast layer does; and
environmental gradient large enough to detect needs tens of kilometres. No
change of estimator fixes 5.7 km².
