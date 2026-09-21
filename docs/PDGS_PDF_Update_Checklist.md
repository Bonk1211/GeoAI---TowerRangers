# PDGS PDF Update Checklist

Old file `docs/HACK-MY-093_PDGS_v01 (1).pdf` is pre-build proposal draft. `docs/HACK-MY-093_PDGS_v01.md` is the current, correct version — already has all fixes below applied. Use this list to regenerate/replace the PDF from the `.md` source (don't hand-edit the PDF).

## 1. §3 Datasets and Data Sources
PDF lists proposed-but-unused sources as if live: Sentinel-2 water segmentation, Overture buildings, VIIRS+OSM power, ESA WorldCover, NASA LIS/OTD lightning.

Replace with actual split (`.md` §3.1/§3.2, backed by `data/pilot_sunway/source_registry.csv`):
- **Powering pilot today [BUILT]:** Sunway Mendeley tower inventory, Copernicus DEM GLO-30, ASF HAND, OSM Overpass (water + power), WorldPop 100m population.
- **Assessed, sequenced, on roadmap:** OpenCellID (national unlock), Sentinel-2 (feeds §4.2 Tier 2), NASA LIS/OTD (null on pilot AOI, dropped not imputed), Overture buildings (QA layer), JRC Surface Water (sensitivity check), GHSL age proxy (**rejected**, not valid), VIIRS/WorldCover (future grid refinement).

## 2. §4.2 Perception Layer
PDF states segmentation "not yet executed" as a flat claim.

Fix: split into **Tier 1 [BUILT]** (DEM derivatives, HAND, OSM distance fields, WorldPop — feeding the index now) vs **Tier 2 [WIRED]** (Sentinel-2 water/building segmentation — pipeline and UI built, exports still landing). PDF undersells what's actually running.

## 3. §4.3 Tower Health Risk Index
PDF has generic AHP description with no numbers. Missing entirely:
- Actual consistency ratio **CR = 0.0038**
- Weight-rescale rationale (cap on max contribution, not a sum-to-one budget share)
- Which factors are dropped at runtime and why (**lightning**: `flash_density` null on pilot AOI; **age**: no honest install-date exists) — neither imputed
- The **classifier second-opinion** paragraph: logistic regression, `StratifiedGroupKFold` grouped by coordinate, out-of-fold **ROC AUC 0.974 / AP 0.945 / balanced accuracy 0.892**, and the caveat that the target is policy-generated (risk ≥ cutoff), not an observed failure event

## 4. §4.4 Agentic Maintenance Scheduler
PDF objective: `Σ risk × days-until-serviced + λ·travel`
Actual shipped objective: `Σ priority × days-until-serviced + λ·travel`, where `priority = risk × log1p(exposed_pop)` — matches §4.3's own priority definition. **PDF formula is inconsistent with its own earlier section**, fix.

Also missing from PDF:
- Full hard-constraint list: territory coverage, depot range (haversine × road factor), crew-type match, jobs-per-crew-day capacity, SLA deadline, pinned-first, monsoon window
- "Unscheduled work returned explicitly, never silently dropped" rule
- Agent's four named typed tools: `score_towers`, `propose_actions`, `optimize_schedule`, `apply_constraint`
- Deterministic fallback path when no `ANTHROPIC_API_KEY` (same SSE event vocabulary either way)

## 5. §4.5 Architecture Diagram
PDF diagram shows batch inputs as Sentinel-2 / OpenCellID / VIIRS / LIS-OTD — none of these feed the shipped pipeline.

Replace with actual sources: Copernicus DEM, ASF HAND, OSM, WorldPop, Sunway inventory (see `.md` mermaid diagram, already correct).

## 6. §4.6 Evidence — missing section, add whole thing
Not in PDF at all. Add:
- Rank-stability table: weight perturbation ρ = 0.990, membership-curve perturbation ρ = 0.993 (both via `model/validate.py`)
- Ablation table: dropping flood collapses ranking (ρ = 0.40) — load-bearing; dropping lightning barely moves it (ρ = 0.996) — corroborates §3.2 exclusion
- Scheduler policy-comparison claim: risk-weighted response time vs nearest-first dispatch, identical crew capacity/constraints, only sort key differs

## 7. §5.3 Regional Fit
PDF says system "built on a Malaysian area of interest with Kelantan as the reference region" — **wrong**. Actual pilot AOI (real data, index runs here) is **Sunway, Selangor**. Kelantan is only the *scheduler config* region (crew roster/depots), chosen for its monsoon window. Split these two explicitly, per `.md`.

## 8. §6/§7 Limitations
PDF version is thinner — missing perception-specific and optimisation-specific limitation subsections, and doesn't use the `[BUILT]`/`[WIRED]`/`[NEXT]` marker scheme at all.

## 9. Executive Summary
PDF has no build-status marker scheme. `.md` introduces `[BUILT]` / `[WIRED]` / `[NEXT]` tags used consistently system-wide — carry this convention into any PDF re-export.

## 10. Before re-submitting
Spot-check that numbers quoted above (CR 0.0038, AUC 0.974, ρ 0.990/0.993/0.40/0.996) still match current artifacts in `src/backend/model/` and `artifacts/ml/` — the `.md` was correct as of last edit but code may have moved since.
