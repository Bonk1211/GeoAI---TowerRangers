# Implementation Plan — ML side

**Audience: the ML/modelling owners.** Derived from [Integration_Gaps.md](Integration_Gaps.md); the scheduler/frontend half is [Implementation_Plan_Scheduler_Frontend.md](Implementation_Plan_Scheduler_Frontend.md).

**Your list got shorter, not longer.** [Integration_Gaps.md](Integration_Gaps.md) assigned ML five items. Four are now routed around scheduler-side — derived from data already on disk, into the exact record shape you would emit. When yours lands, they delete a block and read your column. Nothing downstream moves.

**One item is genuinely blocking, and it is the only one a judge sees.**

---

## 0. Status of the five original ML items

| Gaps item | Was | Now | Why |
|---|---|---|---|
| §1.2 flood recalibration | blocking | **🔴 STILL BLOCKING** | Visible on screen. No workaround exists |
| §1.1 attribution shares | blocking | 🟡 optional | Scheduler recomputes via `risk_index.attribution()` |
| §1.3 `watch` band | blocking | 🟡 optional | Scheduler bands on a continuous column |
| §2 `risk_lo`/`risk_hi`/`borderline` | blocking | 🟡 optional | Scheduler derives from `d1_weight_stability` draws |
| §2 `urgency_days` | open owner | ⛔ **do not emit** | Scheduler owns it. See §5 |
| §4 AHP over 4 factors | not raised | 🟡 correctness | New below — a reviewer would find this |

**If you only do one thing, do §1.**

---

## 1. 🔴 Recalibrate the flood membership — the only blocking item

### The problem, measured

```
risk quantiles     p10 0.568   p50 0.948   p75 0.974   p90 0.987   max 0.995
IQR                0.091                    ← the entire middle half of towers spans 9 risk points
mean flood share   0.916       flood share > 0.9 on 104 / 132 towers
dominant factor    flood 130   terrain 2   (of 132)
```

Half the towers score above 0.948. **There is effectively no ranking.** The attribution bars render as one full-width flood bar on 104 of 132 towers, and rank-stability — the project's headline metric — is close to meaningless over a near-constant score.

### Cause: a calibration mismatch, not a bug

Sunway is dense, flat, urban. Measured from `data/pilot_sunway/tower_feature_table.csv` (n=132):

```
hand_m   p05 0.00   p25 0.00   p50 1.12   p75 3.01   p95 8.38   max 15.96
         15 towers sit at exactly 0.0    (real ASF GLO-30 HAND v1 values, not a fill)
```

Against `hand_h0 = 5.0`, `hand_k = 0.6` ([risk_index.py:44](../src/backend/model/risk_index.py#L44)):

```python
p_hand = inv_logistic(df.hand_m, 5.0, 0.6)     # -> ~0.95 at hand_m=0, ~0.92 at 1.12
```

**Three-quarters of the AOI sits below the curve's midpoint**, so `p_hand` saturates near 1.0 almost everywhere, mean flood membership lands at 0.835, and noisy-OR with flood weight 1.0 pins the composite to the ceiling.

The parameters were chosen for terrain with real elevation variation ([ML_Implementation_Plan §C1](ML_Implementation_Plan.md)). This AOI has none. **Nothing is wrong with the code** — the curve is being asked a question it was not shaped for.

### Fix, in order of preference

**Option 1 — recentre `hand_h0` on the AOI's own hydrology. Recommended.**

The curve midpoint should sit where "safely elevated" actually flips for *this* terrain. With p50 at 1.12 m and p75 at 3.01 m, something in the **1.5–2.5 m** range puts the transition inside the data's real range instead of above nearly all of it. Steepen `hand_k` (0.6 → ~1.0–1.5) so the curve discriminates across a 0–8 m span rather than a 0–20 m one.

Sweep it rather than guessing:

```python
import numpy as np, pandas as pd
from risk_index import memberships, factor_weights, noisy_or

feat = pd.read_csv("data/pilot_sunway/tower_feature_table.csv")
for h0 in [1.5, 2.0, 2.5, 3.0]:
    for k in [0.6, 1.0, 1.5]:
        p = memberships(feat, {"hand_h0": h0, "hand_k": k}).drop(columns=["lightning"], errors="ignore")
        r = noisy_or(p, factor_weights(p.columns))
        q = np.quantile(r, [.1, .25, .5, .75, .9])
        print(f"h0={h0} k={k}  p10={q[0]:.3f} p50={q[2]:.3f} p90={q[4]:.3f}  IQR={q[3]-q[1]:.3f}")
```

**Target: IQR ≳ 0.25** (currently 0.091) and p50 somewhere near the middle of the range, not at 0.95.

Also check `water_d0 = 150.0` against measured `dist_water_m` (p05 37 m, p50 221 m, p95 473 m) — `exp_decay(221, 150)` = 0.23, so that one is behaving reasonably. **Likely `hand_h0` alone is the culprit.** Change one thing.

**Document the change the way the existing params are documented.** The inline justifications in `PARAMS` are one of the strongest things in this codebase — a recalibration with a stated physical reason continues that; a silently retuned constant undoes it.

Defensible framing, and true: *what counts as "safely elevated above drainage" differs between a floodplain city and hill terrain. The curve is recentred on the AOI's own hydrology, and the parameter is declared, not hidden.*

**Option 2 — percentile-relative membership within the AOI.** Guarantees spread, but weakens the "physically grounded, not relative" claim that distinguishes this index from a z-score. **A real trade-off, not a free win.** Only if option 1 does not produce usable spread.

**Option 3 — score a second AOI with genuine terrain variation.** Best scientifically, most expensive, and the pilot dataset work would need repeating.

### ✅ Check

Re-run the sweep, confirm IQR ≳ 0.25, then re-run `validate.py` — rank stability should stay high (recentring a curve should not scramble the ranking; if ρ collapses, something else broke).

**Expect the dominant-factor mix to shift.** flood 130/132 should fall as terrain, power, and equipment start winning towers. That is the fix working, not a regression.

---

## 2. 🟡 Export attribution shares

Shares are computed at [`generate_maintenance_decision_notebook.py:330`](../notebooks/generate_maintenance_decision_notebook.py) and then discarded — only the argmax survives at line 347:

```python
technical_risk, factor_shares = attribution(membership, factor_weight_map)
...
df["dominant_factor"] = factor_shares.idxmax(axis=1)     # line 347
```

**Fix:** add the shares to the export column list (line ~724) — one column per factor:

```python
for f in factor_shares.columns:
    df[f"share_{f}"] = factor_shares[f]
```

**Cost: minutes.** No new computation; the values already exist in memory.

**Why bother, given the scheduler recomputes them:** the recompute calls the *same* `risk_index` functions, so the numbers agree — but two code paths that must stay in sync are a latent divergence, and there is no reason to keep one when the fix is three lines.

---

## 3. 🟡 Three decision bands

Current output is two states:

```
MAINTENANCE            37
NO_MAINTENANCE_NOW     95
```

The frozen contract wants `maintain | watch | ok` ([Frontend_Build_Plan §5](Frontend_Build_Plan.md), [ML plan §6.5 E1](ML_Implementation_Plan.md)).

`MAINTENANCE_CAPACITY_RATE = 0.25` at [notebook:146](../notebooks/generate_maintenance_decision_notebook.py) already anchors the top band to capacity, which is the right construction. Add the middle band the same way — a second, lower threshold — so `watch` means *"visible to planners, not dispatched this cycle"* rather than a cosmetic amber.

**Do this after §1.** Banding a distribution whose middle half spans 0.09 is meaningless; the cut points would be noise.

---

## 4. 🟡 Per-tower risk intervals

[`validate.py:38`](../src/backend/model/validate.py#L38) already runs 500 perturbed draws and then **reduces them away**:

```python
for _ in range(n):
    w = w0 * rng.lognormal(0.0, sigma, len(w0))
    r = noisy_or(p, _weights(w / w.sum(), p.columns))
    rho.append(spearmanr(base, r).statistic)      # keeps only the correlation
```

Each `r` is a full per-tower risk vector, thrown away after one scalar is extracted from it.

**Fix:** retain the draws and take quantiles.

```python
draws = np.array(draws)                          # (500, n_towers)
risk_lo = np.quantile(draws, 0.05, axis=0)
risk_hi = np.quantile(draws, 0.95, axis=0)
```

`borderline` = the interval straddles a band edge, meaning the band assignment is not robust to weight uncertainty. That is precisely the tower a planner should check by hand, and it is what the drawer's borderline ring communicates.

**Cost: ~30 min.** The expensive part — 500 draws — already runs.

---

## 5. ⛔ Do not emit `urgency_days`

[Gaps §2](Integration_Gaps.md) left this owner open. **Settled: the scheduler owns it.**

It is mechanism-weighted from attribution shares — lightning arrives in days, flood over a wet season, equipment over quarters — using per-factor base timescales in scheduler config.

**If both sides emit it, the numbers silently disagree and the schedule contradicts the tower drawer on screen.** One or the other, never both.

---

## 6. 🟡 AHP weights are not re-derived after dropping lightning

Not in the gaps doc. **A sharp reviewer would find this.**

`flash_density` is 100% null in the pilot table — correctly asserted rather than imputed, which is the right call. So the index runs on **4 factors**: flood, terrain, equipment, power.

But `AHP_MATRIX` is 5×5 including lightning ([risk_index.py:94](../src/backend/model/risk_index.py#L94)), and the lightning *column* is dropped after `memberships()`. The eigenvector is still solved over the 5×5 matrix, so the remaining four weights carry a share derived from pairwise comparisons against a factor that is not in the model.

**Two acceptable fixes:**

1. Solve the eigenvector over the **4×4 submatrix** with lightning's row and column removed, when lightning is absent. Cleanest — the weights then mean what AHP says they mean.
2. Keep the 5×5 and **explicitly redistribute** lightning's share, documenting the rule.

Either is defensible. **Silently dropping the column is not**, because the effective weighting changes without the derivation changing.

The consistency ratio should be re-asserted `< 0.1` on whichever matrix is used — the existing test already does this, so point it at the same matrix the scorer uses.

---

## 7. Method page must reflect reality

Two statements the frontend renders that need to be true — coordinate the wording, the frontend owner will implement it:

- **Lightning: mark it *not available for this AOI*, not absent.** `flash_density` is 100% null. The absence is honest and the reason is documented; deleting the row hides a limitation that a judge would rather see declared.
- **The index runs on 4 factors, not 5.**

---

## 8. Answer one question for the scheduler side

**Is `dispatch_priority_score` intended as the field that orders dispatch?**

The formula at [notebook:298](../notebooks/generate_maintenance_decision_notebook.py) is:

```
dispatch_priority_score = technical_risk × ((1 − exposure_weight) + exposure_weight × exposure_percentile)
```

which reads as exactly that. But measured, it barely separates:

| Column | p10 | p50 | p90 | IQR |
|---|---|---|---|---|
| `technical_risk` | 0.568 | 0.948 | 0.987 | 0.091 |
| `dispatch_priority_score` | 0.542 | 0.871 | 0.937 | **0.113** |
| `oof_maintenance_probability` | 0.005 | 0.124 | 0.942 | **0.529** |

Multiplying a degenerate score by an exposure factor inherits the degeneracy. **After §1 lands, `dispatch_priority_score` should become the right choice** — it carries the operational meaning, and exposure-weighting dispatch order is correct.

Until then the scheduler displays `oof_maintenance_probability`, because it is the only column with usable spread and it is honestly out-of-fold. **This is a temporary substitution and it will be reverted once §1 lands** — flagged so nobody is surprised that the demo shows a model probability rather than the physical index.

**This is the strongest argument for doing §1 first:** it puts the physically-grounded index back at the centre of the demo, where the whole method narrative depends on it.

---

## 9. Nice-to-have: `model_policy_disagreement` is already useful

The CSV carries it. **6 of 132 towers** are cases where the learned model and the policy rule disagree — exactly the towers a planner should review by hand.

The frontend will badge these in the drawer. **Nothing to build on your side** — it exports already. Worth knowing it is being surfaced, because it demonstrates the human-in-the-loop claim with real output instead of asserting it.

---

## 10. Summary

| # | Item | Priority | Cost |
|---|---|---|---|
| 1 | Recalibrate `hand_h0` / `hand_k` (§1) | 🔴 **blocking** | ~1 h |
| 2 | Export attribution shares (§2) | 🟡 | minutes |
| 3 | Confirm `dispatch_priority_score` intent (§8) | 🟡 answer | minutes |
| 4 | Add `watch` band (§3) | 🟡 after §1 | ~30 min |
| 5 | Per-tower `risk_lo`/`risk_hi` (§4) | 🟡 | ~30 min |
| 6 | Re-derive AHP over 4 factors (§6) | 🟡 correctness | ~30 min |
| — | `urgency_days` (§5) | ⛔ do not emit | — |

**Item 1 is the whole job if time is short.** Everything else has been routed around; the demo runs without them. A degenerate risk distribution is the one gap visible on screen, and it invites the question *"then what does your index actually distinguish?"* — which currently has no good answer.

---

## 11. What is already right

Worth recording so none of it gets damaged during the fixes:

- **The pilot dataset is real and source-backed** — Copernicus DEM, ASF GLO-30 HAND v1, OSM, WorldPop, operator measurements. Stronger than the plan assumed.
- **Nulls are declared, not imputed**, and asserted in code.
- **The out-of-fold evaluation is honest** — `oof_maintenance_probability` is held-out, not fitted.
- **`MAINTENANCE_CAPACITY_RATE` is declared as an operational scenario**, not presented as a discovered optimum ([notebook:179](../notebooks/generate_maintenance_decision_notebook.py)).
- **The `PARAMS` physical justifications** are the single most defensible artefact in the modelling. §1 should extend that practice, not break it.
- Attribution, rank stability, and the AHP consistency ratio all exist and work. The gaps are in **calibration and serialization**, not in the method.
