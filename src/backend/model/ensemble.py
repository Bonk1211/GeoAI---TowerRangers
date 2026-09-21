"""The combination policy: how the three layers become one ordering.

  * `model/maintenance_need.py` (LightGBM, supervised) owns `risk` — the
    probability a corrective work order was needed. Nothing here changes it.
  * `model/novelty.py::condition_scores` (unsupervised, one-sided) reads the
    30-day telemetry block. This is the layer that earns its place.
  * `model/novelty.py::novelty_scores` (Isolation Forest over site environment)
    and `model/profiler.py` (rules) are DESCRIPTIVE and enter nothing.

HOW THE TWO SCORES COMBINE, AND WHY IT IS A BLEND RATHER THAN A GATE. This file
has held three different answers and the wrong two are the instructive part.

  1. A GATE on `novelty` — lift a `watch` tower when the forest calls it
     strange. Removed: a matched-budget comparison (any policy dispatching more
     towers must be scored against a CUT dispatching the same number, never
     against the untouched top-10%) put it at F1 0.5751 against 0.5855.
  2. A GATE on `condition`. Better, but measured on held-out seeds under a
     realistic telemetry-noise model it is **negative**: -0.0125 F1, ahead in
     1 of 5 seeds. A gate touches the second opinion at ONE threshold and never
     reorders anything, so it discards what the condition score says about every
     other tower in the estate. Relaxing its cap changes nothing, because the
     cap was never what bound it — the SHAPE of the combination was.
  3. A rank BLEND, which is what this module now does. Held-out seeds 5-9,
     matched budget of 175 towers, GroupKFold on ADM1 state:

         policy                        F1      TP    vs LightGBM   seeds won
         lightgbm alone            0.6623   138.4         +0.0000
         gate p85 cap5% watch      0.6497   135.8         -0.0125       1/5
         gate p70 cap20% watch+ok  0.6738   140.8         +0.0115       5/5
         rank blend w=0.25         0.6814   142.4         +0.0191       5/5

     Standalone the two are comparable and complementary — model ROC 0.905,
     condition 0.884, a 50/50 rank blend 0.929, above both.

An earlier note in this repo said "blending is worse at every weight". That was
measured on `novelty` and it was true of `novelty`; it was carried over to
`condition` without being re-run, and it was wrong there. Blend weight is swept
on seeds 0-4 (0.2 and 0.3 both win 5/5, 0.5 does not) and CONDITION_BLEND_WEIGHT
is set to the midpoint rather than the argmax, then verified on seeds 5-9.

Ranks, not raw values: `risk` is a probability and `condition` is already a
percentile, so averaging them directly would let the model's scale decide the
weight. Ranking both first makes the weight mean what it says.

Satellite growth is a third candidate rank, measured on generator v2.3 with
encroachment gain 0.30. Its in-band AUC is 0.6072 versus the model's 0.6745:
the necessary condition fails, so CHANGE_BLEND_WEIGHT stays 0.0 and change is
descriptive. At matched budget (116 towers), w=0.15 adds +0.00116 F1 on seeds
0-4 but loses -0.00330 on seeds 5-9 (1/5 wins). Even w=0.10's +0.00446 held-out
mean (2/5 wins) cannot override the required in-band gate. The notebook persists
the full sweep. Missing ranks are excluded and weights renormalised per tower;
no change measurements, or weight zero, preserves the original two-rank path.

This module owns the constants the notebook and adapter/ml_source.py must share.
Neither may redefine them — model/test_maintenance_need.py parses the notebook's
AST and fails the build on a redefinition.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# How much of the dispatch ordering the second opinion carries. Swept on one set
# of seeds and verified on another; 0.2 and 0.3 both won 5/5, 0.5 won 2/5, so
# the usable region is narrow and this sits in the middle of it. Raising it past
# ~0.4 makes the ordering worse than LightGBM alone, because `condition` is the
# weaker standalone ranker (0.884 against 0.905).
CONDITION_BLEND_WEIGHT = 0.25

# Necessary in-band advantage failed (0.6072 vs 0.6745). The measured satellite
# observations and disagreement flags still flow at zero dispatch weight.
CHANGE_BLEND_WEIGHT = 0.0


def _rank(values: np.ndarray) -> np.ndarray:
    return pd.Series(values).rank(pct=True).to_numpy()


def blend_priority(
    risk: np.ndarray, condition: np.ndarray, change: np.ndarray | None = None,
    *, change_weight: float = CHANGE_BLEND_WEIGHT,
) -> np.ndarray:
    """Model, condition and optional growth ranks -> dispatch ordering.

    `change_weight` is an evaluation override for the notebook's sweep; serving
    uses the measured module constant. No ranks are blended into `risk`.

    Returns a percentile rank in [0, 1]. It is NOT a probability and must never
    be served as one: `risk` remains the model's own calibrated output and this
    sits beside it, which is why the adapter emits both.

    A tower with no telemetry (`condition` is NaN — no file, or absent from it)
    keeps its model rank unchanged rather than being pushed down. Missing
    telemetry is not evidence of a healthy site, and a fleet that has only
    partially rolled out monitoring must not see its unmonitored towers quietly
    de-prioritised.
    """
    risk = np.asarray(risk, dtype=float)
    condition = np.asarray(condition, dtype=float)
    if risk.ndim != 1 or condition.shape != risk.shape:
        raise ValueError("risk and condition must be aligned one-dimensional arrays")
    if not 0 <= change_weight < 1 - CONDITION_BLEND_WEIGHT:
        raise ValueError("change weight must leave positive weight on the model")
    if change is not None:
        change = np.asarray(change, dtype=float)
        if change.shape != risk.shape:
            raise ValueError("change must align with risk")
    if len(risk) == 0:
        return np.empty(0, dtype=float)

    model_rank = _rank(risk)
    if change is not None and change_weight and np.isfinite(change).any():
        ranks = np.column_stack([model_rank, _rank(condition), _rank(change)])
        weights = np.array([1 - CONDITION_BLEND_WEIGHT - change_weight,
                            CONDITION_BLEND_WEIGHT, change_weight])
        available = np.isfinite(ranks)
        # Renormalise per tower: missing evidence contributes neither a zero
        # reading nor its weight. Neither optional rank -> bare model rank.
        blended = (np.where(available, ranks, 0) * weights).sum(axis=1)
        blended /= (available * weights).sum(axis=1)
        return _rank(blended)
    known = ~np.isnan(condition)
    if not known.any():
        return model_rank

    blended = model_rank.copy()
    condition_rank = _rank(np.where(known, condition, np.nan))
    blended[known] = (
        (1.0 - CONDITION_BLEND_WEIGHT) * model_rank[known]
        + CONDITION_BLEND_WEIGHT * condition_rank[known]
    )
    # Re-rank so the result is a clean percentile over the whole population and
    # the towers that kept a bare model rank stay comparable with the blended
    # ones. Without this the two groups sit on subtly different scales and the
    # band quantiles cut across the seam.
    return _rank(blended)
