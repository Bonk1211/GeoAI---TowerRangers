# Integration Gaps — ML ↔ Scheduler ↔ Frontend

**Status as of 2026-08-12.** All three streams build and run independently. **None are connected** — there is not a single HTTP call between them. This document lists what has to close, who owns each item, and what it costs.

Contracts referenced: [Backend_Handoff §1](Backend_Handoff.md) (scored-tower record), [Frontend_Build_Plan §5](Frontend_Build_Plan.md) (frozen API types), [ML_Implementation_Plan §6.5](ML_Implementation_Plan.md) (decision layer).

---

## 0. Where things stand

| Stream | State | Data source today |
|---|---|---|
| Frontend | 5 pages, all components built | Its own TypeScript fixtures — **no `fetch` anywhere** |
| Scheduler API | Verified working over HTTP (`/crews`, `/schedule/*` all 200) | Its own Python fixture, `fixtures/scored_towers.py` |
| ML index | Scores 132 Sunway sites; `.joblib` + CSV artefacts | CSV on disk — **no HTTP surface** |

Three working islands. The wiring is the remaining work, and two of the gaps below are substantive rather than plumbing.

---

## 1. Blocking gaps — the demo cannot show its core claim without these

### 1.1 Attribution shares are computed, then discarded ⚠ highest priority

**Owner: ML.** `risk_index.score()` returns full per-factor shares, and the notebook computes them at `generate_maintenance_decision_notebook.py:330`:

```python
technical_risk, factor_shares = attribution(membership, factor_weight_map)
...
df["dominant_factor"] = factor_shares.idxmax(axis=1)   # line 347 — argmax only
```

Only the argmax survives into `maintenance_decisions.csv`. The shares themselves are dropped.

**Why this is the top item.** Attribution is the join key of the whole product. It decides *which* intervention a tower needs (flood → drainage and cabinet raising; equipment → radio refresh), and it is what the tower drawer's bars render. Both PRDs mark it "never cut." Without shares, the frontend's single most defensible component has nothing real to display.

**Fix:** serialize the shares alongside `dominant_factor` — either one column per factor (`share_flood`, `share_terrain`, …) or a JSON blob. **Verified recoverable** from the existing pilot table with no new computation. Estimated cost: minutes.

---

### 1.2 Risk distribution is degenerate on the Sunway AOI ⚠ substantive

**Owner: ML.** Running the index over `data/pilot_sunway/tower_feature_table.csv`:

```
risk quantiles      p10 0.572   p25 0.882   p50 0.948   p75 0.974   p90 0.987   max 0.995
mean flood share    0.916       towers with flood share > 0.9:  104 / 132
dominant factor     flood 130   terrain 2   (out of 132)
```

**Half the towers score above 0.948.** There is effectively no ranking, no band separation, and attribution bars would render as a single full-width flood bar on 104 of 132 towers.

**Cause — not a bug, a calibration mismatch.** Sunway is dense, flat, urban: `hand_m` has median **1.12 m** against a curve centred at `hand_h0 = 5.0`. `inv_logistic(hand, 5.0, 0.6)` saturates near 1.0 for nearly every site, mean flood membership lands at **0.835**, and noisy-OR with flood weight 1.0 pins the composite near ceiling. The curve params were chosen for terrain with real elevation variation ([ML plan §C1](ML_Implementation_Plan.md)), and this AOI has none.

**Why it matters beyond aesthetics.** "Almost every tower is critical" is not a defensible output. A judge asking *"so what does the index actually distinguish?"* has no answer, and the rank-stability result — the project's headline metric — is far less meaningful over a near-constant score.

**Options, in order of preference:**

1. **Recalibrate `hand_h0` / `water_d0` for the AOI** and document the change with its justification, exactly as the existing params are documented. Physically defensible: what counts as "safely elevated" differs between a floodplain city and hill terrain.
2. **Use percentile-relative membership within the AOI** rather than absolute thresholds. Guarantees spread, but weakens the "physically grounded, not relative" claim — a real trade-off, not a free win.
3. **Score a second AOI with genuine terrain variation** so the index has something to differentiate. Best scientifically, most expensive.

**Recommendation: option 1**, plus stating the recalibration openly on the Method page. Option 2 only if 1 does not produce usable spread.

---

### 1.3 Decision layer emits two states; the contract needs three

**Owner: ML.** Current output:

```
MAINTENANCE            37
NO_MAINTENANCE_NOW     95
```

The frozen contract is `maintain | watch | ok` ([Frontend_Build_Plan §5](Frontend_Build_Plan.md)), and [ML plan §6.5 E1](ML_Implementation_Plan.md) specifies three bands.

**Consequence:** the bands tile has no amber category, the map has no `watch` colour, and the "watch-band towers visible but idle" behaviour in the tower schedule view has nothing to show.

**Fix:** add the middle band, capacity-anchored per §6.5 — *maintain = top 10% ≈ one inspection cycle at current crew capacity*, `watch` beneath it, `ok` the remainder. Cost: small, once 1.2 is resolved (banding a degenerate distribution is meaningless).

---

## 2. Contract gaps — mechanical, but each blocks a UI element

**Owner: ML** unless noted. Comparing `maintenance_decisions.csv` against [Backend_Handoff §1](Backend_Handoff.md):

| Contract field | Present? | Notes |
|---|---|---|
| `tower_id`, `lon`, `lat`, `radio` | ✅ | |
| `risk` | ⚠ | Present as `technical_risk` — rename or map at the adapter |
| `risk_lo`, `risk_hi` | ❌ | **Already computable** — `validate.py:d1_weight_stability` runs 500 draws; expose the per-tower quantiles instead of discarding them |
| `decision` | ⚠ | Two states, see §1.3 |
| `borderline` | ❌ | Derivable once `risk_lo/hi` exist: does the interval straddle a band edge |
| `dominant_factor` | ✅ | |
| `urgency_days` | ❌ | See below |
| `attribution` | ❌ | See §1.1 |

**`urgency_days` — decide the owner.** [Backend_Handoff §1](Backend_Handoff.md) flagged this as a coordination point. It must be **mechanism-weighted, not the risk score rescaled**: lightning and power failures arrive in days, flood over a wet season, equipment over quarters. Two acceptable resolutions:

- ML emits it, using per-factor base timescales, or
- The scheduler derives it from `dominant_factor` + `risk` using its own config.

The scheduler fixture already implements the second (`fixtures/scored_towers.py:FACTOR_BASE_URGENCY_DAYS`), so **defaulting to scheduler-side is the cheaper path** — but it must be one or the other, not silently both.

---

## 3. AOI — RESOLVED: Sunway, Selangor

**Decision (2026-08-12): the AOI is Sunway, Selangor.** The real, source-backed pilot dataset ([PILOT_DATASET.md](PILOT_DATASET.md)) sets the AOI; everything mock moves to meet it. Kelantan is dropped from the demo path.

Why this way round: the Sunway data is real (Copernicus DEM, ASF HAND, OSM, WorldPop, operator measurements); the Kelantan crews and towers are invented. Move the invented thing.

**What must change.** The optimizer enforces a **territory constraint**, so a Kelantan crew cannot service a Selangor tower — leave this unfixed and the schedule returns *empty*, silently, with no error.

| File | Change | Owner |
|---|---|---|
| `src/backend/config/crews.json` | Rewrite roster as Selangor: `SEL-C1`/`SEL-C2` civil, `SEL-P1` power, `SEL-E1` electrical, `SEL-R1` RF. Depots at Petaling Jaya / Shah Alam / Subang. `territory: "Selangor"`. | scheduler |
| `src/backend/fixtures/scored_towers.py` | `AOI_LON_RANGE` → ~`(101.55, 101.68)`, `AOI_LAT_RANGE` → ~`(3.00, 3.14)`, `AOI_TERRITORY` → `"Selangor"` | scheduler |
| `src/frontend/src/fixtures/towers.ts` | Scored cluster moves to Sunway; map initial view centres there | frontend |
| Map default view | Centre ≈ `[101.61, 3.07]`, zoom ~11 (urban AOI, tighter than a state view) | frontend |

**Unscored towers stay national.** The greyed-Malaysia layer is unaffected and still carries the scalability claim — only the *scored* cluster relocates.

**Narrative consequence — decide deliberately.** The monsoon weather-window constraint was written around Kelantan's northeast monsoon (Nov–Mar). Selangor's flood exposure is urban flash flooding, not seasonal inundation. Options: re-frame the constraint as urban-flood-specific, or keep the seasonal rule as a nationally-applicable policy that simply does not bind hard in this AOI. Either is defensible; leaving the docs saying "Kelantan monsoon" while the data says Selangor is not.

**Docs still referencing Kelantan as the reference AOI** — update when convenient, they are narrative rather than blocking: [Concept_Overview.md §9](Concept_Overview.md), [Frontend_Build_Plan.md §6](Frontend_Build_Plan.md), [PRD_Agentic_Maintenance_Scheduler.md §7.3](PRD_Agentic_Maintenance_Scheduler.md).

---

## 4. Missing factors — accepted, worth stating

`flash_density` and `age_years` are **100% null** in the pilot table. The notebook asserts this rather than imputing (`assert df["flash_density"].isna().all()`), which is the correct call and consistent with the project's no-fabrication stance.

**Consequence:** the index runs on **4 factors** — flood, terrain, equipment, power — not 5. Two places must reflect that:

- The **Method page** factor table currently lists lightning. Mark it *not available for this AOI* rather than removing it — the absence is honest and the reason is documented.
- The **AHP matrix** is 5×5 with lightning included. Weights should be recomputed over the 4 present factors, or the lightning weight explicitly redistributed. Currently the code drops the lightning column after `memberships()`, which silently changes the effective weighting without re-deriving the eigenvector. Minor, but a sharp reviewer would find it.

---

## 5. Wiring gaps — plumbing, no decisions needed

**5.1 ML has no HTTP surface.** ⚠ `GET /towers`, `POST /score`, `GET /stability` do not exist anywhere. [Backend_Handoff §6](Backend_Handoff.md) left the owner open.

**Recommendation: an adapter in the scheduler backend** rather than the ML side standing up a second service. One module that reads the ML artefacts, maps them to the §1 shape, and serves the three routes from the existing FastAPI app. The frontend then needs exactly one base URL, and the ML team keeps working in notebooks. **Owner: scheduler (me).**

**5.2 Frontend makes no network calls.** Every page reads from `src/fixtures/`. Needs an API client, `VITE_API_BASE`, TanStack Query wiring, and loading/error states per [Frontend_Handoff §5](Frontend_Handoff.md). Fixtures should be retained as the documented offline fallback. **Owner: frontend.**

**5.3 Client-side scorer will diverge.** `lib/scorer.ts` reimplements noisy-OR in TypeScript so the weight sliders respond instantly. Once `POST /score` is live, decide which is authoritative — recommend server-side, with the client scorer kept only for the offline fallback path, or the two will drift.

---

## 6. Suggested order

| # | Item | Owner | Cost | Unblocks |
|---|---|---|---|---|
| 1 | Export attribution shares (§1.1) | ML | minutes | Drawer bars, action mapping |
| 2 | Move crews + fixtures to Selangor (§3) | scheduler / frontend | ~20 min | Any non-empty schedule |
| 3 | Recalibrate flood membership (§1.2) | ML | ~1 h | Meaningful ranking, bands, stability |
| 4 | Add `watch` band (§1.3) | ML | ~30 min | Bands tile, amber dots |
| 5 | Expose `risk_lo`/`risk_hi` + `borderline` (§2) | ML | ~30 min | Intervals, borderline rings |
| 6 | Adapter serving `/towers`, `/score`, `/stability` (§5.1) | scheduler | ~1 h | Frontend integration |
| 7 | Frontend API client + query wiring (§5.2) | frontend | ~1.5 h | End-to-end demo |

**Item 1 is the unlock on the ML side; item 2 is yours and needs nothing from anyone.**

**Items 2, 6, 7 are entirely within your control** — the AOI move, the adapter, and the frontend wiring. Those three produce a working end-to-end demo against whatever the ML side currently emits. Items 1, 3, 4, 5 then improve the quality of what flows through it, and each can land independently without re-wiring.

That ordering matters under time pressure: **do not block integration on the ML fixes.** Wire it end-to-end with today's ML output — degenerate risk distribution and all — then let their improvements arrive through a pipe that already works.

---

## 7. What is already right

Worth recording, so none of it gets "fixed" during integration:

- The scheduler API works end-to-end over HTTP against its fixture — routes, override preview, emergency dispatch, baseline comparison.
- The ML pilot dataset is **real and source-backed** — Copernicus DEM, ASF HAND, OSM, WorldPop, operator measurements — not synthetic. That is a stronger position than the plan assumed.
- Nulls are declared rather than imputed, and asserted in code.
- The frontend implements every component the build plan specifies, including override, both schedule views, and the evidence pages.
- Attribution, rank stability, and the AHP consistency ratio all exist in code; the gaps are in **serialization and wiring**, not in the modelling.
