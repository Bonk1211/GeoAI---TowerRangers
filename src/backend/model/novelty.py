"""Layer 2: how unlike the rest of the estate a site's environment is.

An Isolation Forest over the same site-environment columns the supervised model
reads, fit on the towers themselves. It answers a question the supervised model
structurally cannot: LightGBM interpolates inside the region its training rows
covered, and says nothing about a site that sits outside it. This says how far
outside.

What it is NOT, and the naming here is deliberate:

  * Not a risk score. A tower can be the strangest site in Malaysia and need no
    work. `novelty` is a statement about the TRAINING DISTRIBUTION, not about
    the tower's condition.
  * Not a failure signal. Nothing here predicts an outage or a fault
    (docs/Backend_Handoff.md 0.6).
  * Not a term in `risk`. Blending it in was measured and is worse at every
    weight — see model/ensemble.py's docstring for the table. It is consumed
    only by `escalate()`.

The score returned is a PERCENTILE RANK in [0, 1] over the towers scored in the
same call, so 0.97 reads as "stranger than 97% of them". The raw Isolation
Forest score is an unbounded average path length with no interpretable unit, and
it would show up in the UI as a number nobody could read. The cost of ranking is
that the value is population-relative — the same caveat the decision bands
already carry, since those are quantiles too.

Sits on the request path via adapter/ml_source.py, fit once per process inside
_AdapterCache. There is deliberately no persisted artifact: 200 trees over
1,144 x 11 fits in well under a second, and a model file on disk would buy a
staleness problem and nothing else.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

try:  # scikit-learn lives in requirements-dataset.txt, not requirements.txt
    from sklearn.ensemble import IsolationForest
except Exception:  # noqa: BLE001 — pragma: no cover
    # Deliberately broader than ImportError, for the reason
    # model/maintenance_need.py documents at its lightgbm import: scikit-learn
    # is a Python wrapper over a compiled scipy/OpenMP stack, and an
    # installed-but-unloadable build raises OSError from ctypes rather than
    # ImportError. Catching only ImportError lets that escape at import time and
    # takes the whole API down, when the correct behaviour is identical to "not
    # installed": serve without novelty.
    IsolationForest = None

from model.maintenance_need import CATEGORICAL_FEATURES, DATA_DIR, FEATURES

TELEMETRY_CSV = DATA_DIR / "site_telemetry.csv"

# The 30-day on-site counters. Read here and NOWHERE in the supervised path:
# model/maintenance_need.py's FEATURES excludes them because the counters cover
# 30 days while the label covers 36 months, so this dataset contains no aligned
# (telemetry, outcome) pair to fit. An unsupervised layer needs no labels, so it
# can use a column the day it starts flowing. That asymmetry is the only reason
# measured in this project that gives Layer 2 an information advantage — see
# `condition_scores` below.
TELEMETRY_COLUMNS: list[str] = [
    "rectifier_alarms_30d",
    "battery_sag_events_30d",
    "door_open_hours_30d",
]

# The model's features minus its categoricals. An Isolation Forest splits at
# random thresholds inside each column's observed range, so an integer category
# code like `land_cover_class` (10, 30, 40, 50) is treated as an ORDINAL axis —
# "between forest and cropland" is not a place. One-hot encoding is the usual
# repair and is worse here: it inflates dimensionality with near-constant
# columns and dilutes the path length the whole method is built on.
#
# Derived, never hand-listed: a hand-copy drifts the moment FEATURES changes,
# and nothing would raise.
NOVELTY_FEATURES: list[str] = [f for f in FEATURES if f not in CATEGORICAL_FEATURES]

# n_estimators is the only knob that matters here and 200 is the measured
# setting. `contamination` is irrelevant by construction: it moves only the
# offset_ that predict() cuts +1/-1 at, and this module never calls predict() —
# it ranks score_samples(). Left at "auto" rather than removed so it is visible
# that the choice was considered.
IF_PARAMS: dict = {
    "n_estimators": 200,
    "random_state": 0,
    "contamination": "auto",
}

# Below this many complete rows an isolation forest is describing sampling noise
# rather than a distribution. Returns None instead, and every tower reads null.
MIN_FIT_ROWS = 50


def _complete(matrix: pd.DataFrame) -> np.ndarray:
    """Boolean mask of rows with no missing value in NOVELTY_FEATURES.

    IsolationForest RAISES on NaN — unlike LightGBM, it has no missing-value
    branch. 20 of the 1,164 national towers hit this (soil_moisture 7, clay_pct
    16, overlapping). They are excluded rather than imputed, for the reason
    maintenance_need.build_matrix() states about its own NaN: imputing a median
    invents an observation of a site Sentinel-2 never saw through cloud.
    """
    return ~matrix[NOVELTY_FEATURES].isna().any(axis=1).to_numpy()


def fit(matrix: pd.DataFrame):
    """An Isolation Forest over the complete rows, or None.

    None rather than raising, for the same reason maintenance_need.load_booster
    returns None: a checkout without scikit-learn, or a table too small or too
    incomplete to fit, is a configuration state and must still boot the API.
    """
    if IsolationForest is None:
        return None
    complete = _complete(matrix)
    if int(complete.sum()) < MIN_FIT_ROWS:
        return None
    return IsolationForest(**IF_PARAMS).fit(matrix.loc[complete, NOVELTY_FEATURES])


def novelty_scores(matrix: pd.DataFrame, forest=None) -> np.ndarray:
    """Design matrix -> per-tower novelty as a percentile rank in [0, 1].

    `np.nan` for any row the forest cannot score — an incomplete feature row, or
    no forest at all. The adapter maps NaN to JSON `null`, and null is the point:
    0.0 would mean "measured, perfectly typical", which is the opposite claim
    (the zeroed-struct fallback bug CLAUDE.md documents).

    Columns are sliced in NOVELTY_FEATURES order on both the fit and the score
    path, so sklearn's "feature names unseen at fit time" warning cannot fire.
    """
    out = np.full(len(matrix), np.nan)
    if forest is None:
        return out

    complete = _complete(matrix)
    if not complete.any():
        return out

    # score_samples is NEGATED by sklearn's convention: LOWER means more
    # anomalous. Negating here makes higher = stranger, which is the direction
    # every caller, threshold and UI string in this project assumes.
    raw = -forest.score_samples(matrix.loc[complete, NOVELTY_FEATURES])
    out[complete] = pd.Series(raw).rank(pct=True).to_numpy()
    return out


# --- the one-sided condition score ------------------------------------------
def condition_scores(
    tower_ids, telemetry: pd.DataFrame | None = None
) -> np.ndarray:
    """Per-tower current-condition score as a percentile rank in [0, 1].

    A mean standardised log-count over TELEMETRY_COLUMNS. Unsupervised — it
    never touches a label, exactly like the isolation forest above — but ONE
    SIDED, and that is the whole point.

    Why not feed telemetry to the isolation forest instead. Measured, and the
    answer is decisive: the raw telemetry block ranks the label at ROC 0.93-0.96,
    and an isolation forest given the same block scores 0.55-0.59 inside the
    escalation band — barely better than a coin. A forest measures |deviation
    from typical|, and maintenance need is MONOTONE: a site with unusually few
    alarms is exactly as anomalous as one with unusually many, so a two-sided
    statistic aimed at a one-sided target cancels most of the signal. The same
    column read one-sided scores 0.757. That single distinction is what moved
    this layer from "measurably harmful" to "measurably useful"; nothing about
    the dataset did it.

    log1p first: the counters are over-dispersed counts, and a raw mean lets one
    alarm-storm site dominate the standardisation for everybody.

    Returns all-NaN when the telemetry file is absent, which the adapter maps to
    JSON null — the same "we could not measure this" contract `novelty` keeps.
    """
    ids = pd.Index(np.asarray(tower_ids))
    if telemetry is None:
        if not TELEMETRY_CSV.exists():
            return np.full(len(ids), np.nan)
        telemetry = pd.read_csv(TELEMETRY_CSV)

    present = [c for c in TELEMETRY_COLUMNS if c in telemetry.columns]
    if not present or "tower_id" not in telemetry.columns:
        return np.full(len(ids), np.nan)

    aligned = telemetry.set_index("tower_id").reindex(ids)[present]
    counts = np.log1p(aligned.astype(float))
    z = (counts - counts.mean()) / (counts.std() + 1e-12)
    combined = z.mean(axis=1)

    out = np.full(len(ids), np.nan)
    usable = combined.notna().to_numpy()
    if usable.any():
        out[usable] = pd.Series(combined[usable].to_numpy()).rank(pct=True).to_numpy()
    return out
