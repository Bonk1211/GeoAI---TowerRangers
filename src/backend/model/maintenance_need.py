"""Supervised maintenance-need scorer: shared definitions and inference.

Training lives in `notebooks/maintenance_need.ipynb`, because a model that has
to be argued for belongs next to its plots. Serving does not: `adapter/
ml_source.py` runs inside the FastAPI process and cannot import a notebook. So
this module owns everything both sides must agree on — the feature list, its
order, the factor grouping, the hyperparameters, the artifact paths — and the
notebook imports all of it.

Neither side may redefine what this module owns. A notebook that declares its
own FEATURES trains a model the API then feeds different columns to, in a
different order, and LightGBM accepts a positional array without complaint:
nothing raises, the numbers are simply wrong.
`model/test_maintenance_need.py` parses the notebook's AST and fails the build
on any redefinition.

What this module deliberately does NOT import: sklearn, model.flood_eval,
model.risk_index. Those are training- and evaluation-time dependencies. This
sits on the request path and stays cheap.

Not a failure predictor. The target is `needed_corrective_maintenance` — a work
order was raised — never an outage, a fault, or a probability of one
(docs/Backend_Handoff.md 0.6).

A monthly-panel/recency variant of this model was tried and measured, not
merely discussed: `data/prepare_maintenance_records.py` can build
`maintenance_panel.csv` (one row per tower-month, ~35,000 rows, recency
features — months since last visit, cumulative ticket count, monsoon flag —
computed from history strictly BEFORE each row's reference date, so they are
not leakage) and predict need within a 6-month forward window instead of this
module's 36-month "ever" snapshot. It is NOT served: a rarer, forward-looking
event is a strictly harder statistics problem, and every accuracy metric came
back lower (PR-AUC ~0.06-0.07 vs this model's 0.29) purely from that base-rate
arithmetic, independent of feature or model quality. The panel-building code
stays in the repo, tested and working, as a validated alternative framing —
see `docs/SYNTHETIC_MAINTENANCE_LABELS.md` for the comparison and the
reasoning behind keeping this simpler snapshot as the served model.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

try:  # lightgbm lives in requirements-dataset.txt, not requirements.txt
    import lightgbm as lgb
except Exception:  # noqa: BLE001 — pragma: no cover
    # Deliberately broader than ImportError. LightGBM is a Python wrapper around
    # a native library, and an installed-but-unloadable build raises OSError
    # from ctypes, not ImportError — on macOS, `pip install lightgbm` without
    # `brew install libomp` does exactly that. Catching only ImportError there
    # lets the OSError escape at import time and take the whole API down with
    # it, when the correct behaviour is the same as "not installed": serve the
    # physical index instead.
    lgb = None

_THIS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _THIS_DIR.parent
_REPO_ROOT = _BACKEND_DIR.parent.parent
DATA_DIR = _REPO_ROOT / "data" / "malaysia"

MODEL_PATH = DATA_DIR / "maintenance_model.txt"
REPORT_PATH = DATA_DIR / "maintenance_need_report.json"
LAND_FEATURES_CSV = DATA_DIR / "land_features.csv"

# --- the feature contract --------------------------------------------------
# Order is positional against the trained booster. build_matrix() selects by
# NAME and returns this order; it is the only place order is established, and
# nothing downstream may reorder. A shuffled list silently compares EVI against
# slope and raises nothing.
FEATURES: list[str] = [
    # flood — the terrain and wetness that hold water on a site
    "hand_m",
    "dist_water_m",
    "soil_moisture_mean",
    "soil_moisture_p90",
    # terrain / ground
    "slope_deg",
    "tri",
    "elevation_m",
    "clay_pct",
    # vegetation
    "evi_median",
    "evi_p10",
    "land_cover_class",
    # power
    "dist_power_m",
]

# `gsw_occurrence_pct` and `gsw_recurrence_pct` were here, in the flood group,
# and they are gone. JRC GSW was sampled AT THE TOWER POINT
# (data/prepare_land_features.py::gsw_reduction, buffer_m=0), and a mast is
# never built inside a water body, so the centre pixel is 0 for 1,140 of 1,164
# towers (97.9%). Two independent measurements, both damning:
#
#   * Univariate: of the 24 towers ever observed under water, 5 needed
#     corrective work — 20.8% against a 21.0% base rate. Lift 0.99x. Zero
#     information, not weak information.
#   * In the model: 0 splits. With min_data_in_leaf = 25, a split isolating 24
#     rows is ILLEGAL, and 24 is the largest group above zero, so no split on
#     either column is ever legal. Training with and without them gave
#     identical metrics to four decimals (ROC 0.9510, PR 0.8493).
#
# Buffered sampling was tried before dropping, not assumed away — JRC GSW v1.3
# re-fetched at 30 m from Planetary Computer (anonymous, no Earth Engine) over
# 94 tiles, sampled as the max within r of each mast:
#
#   radius   towers with water history   univariate lift   model PR-AUC
#      0 m          24 (2.1%)                 0.99x           0.8493
#    100 m         127 (10.9%)                1.45x           0.8535
#    250 m         338 (29.0%)                1.35x           0.8536
#    500 m         597 (51.3%)                1.19x           0.8565
#   1000 m         873 (75.0%)                1.05x           0.8549
#
# So the fix works — the column becomes live and the model splits on it. It was
# still dropped: +0.004-0.007 PR-AUC did not justify moving that column onto a
# second fetch route. Note the honest caveat on those numbers, in case this is
# revisited: the synthetic label's own flood term reads the POINT value, so the
# generator barely uses GSW either, and this test understates what buffered GSW
# would be worth against real work orders. If real maintenance records arrive,
# re-run that experiment before assuming the column is dead.
#
# `radio` was here too, as the sole member of an `equipment` factor, and it is
# gone for a related but distinct reason.
# Not a judgement call: 1,119 of 1,164 national rows carry `radio = UNKNOWN`
# (96.1%; the rest are 29 NR, 15 LTE, 1 GSM), so the column is one value almost
# everywhere and carries level, not variance. Measured on the trained booster
# before removal: **0 splits across 91 trees**, gain 0.0000 — LightGBM never
# used it. Since factor_shares() sums |SHAP| per group, an unsplit feature
# contributes exactly 0 to every row, so `equipment` rendered as a 0.000 bar in
# the attribution panel and could never be any tower's dominant_factor.
#
# What this does NOT mean: equipment is not a real maintenance factor. The data
# is missing, not the mechanism. Restoring it needs an operator asset register
# (air-interface, install date, power rating), not a modelling change — the same
# shape of gap as `lightning`, which left for the same reason one release
# earlier. `model/risk_index.py`, `scheduler/urgency.py` and the Weights sliders
# keep their own equipment factor: they are the index path, not this one.

# LightGBM handles categoricals natively. One-hot encoding would split each
# level's SHAP mass across dummy columns and break the factor grouping below.
CATEGORICAL_FEATURES: list[str] = ["land_cover_class"]

# Maps model features onto the factors the scheduler and the attribution panel
# speak in. Must partition FEATURES exactly: a feature in two groups is
# double-counted, one in no group vanishes from attribution without a trace.
# Pinned by test_factor_groups_cover_every_feature_exactly_once.
FACTOR_GROUPS: dict[str, list[str]] = {
    "flood": [
        "hand_m",
        "dist_water_m",
        "soil_moisture_mean",
        "soil_moisture_p90",
    ],
    "terrain": ["slope_deg", "tri", "elevation_m", "clay_pct"],
    "vegetation": ["evi_median", "evi_p10", "land_cover_class"],
    "power": ["dist_power_m"],
}

# `lightning` and `equipment` are both absent, for the same reason and neither
# by choice: flash_density is null for all 1,164 national rows, and `radio` is
# UNKNOWN for 96% of them. A factor whose only column is constant or empty is
# not a factor this model can carry. Restoring lightning needs a real
# climatology (WWLLN, GHRC LIS-OTD); restoring equipment needs an asset
# register. Neither is an AHP weight over an empty column.
FACTORS: list[str] = list(FACTOR_GROUPS)

# --- training configuration ------------------------------------------------
# Fixed, not searched. Tuning against a synthetic label is tuning against our
# own imagination. LightGBM's defaults (num_leaves=31, min_data_in_leaf=20)
# overfit at n~1,164; these are the standard small-data settings.
PARAMS: dict = {
    "objective": "binary",
    "num_leaves": 15,
    "min_data_in_leaf": 25,
    "learning_rate": 0.05,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "verbose": -1,
    "seed": 0,
    "deterministic": True,
    "force_row_wise": True,
}
NUM_BOOST_ROUND = 400
EARLY_STOPPING_ROUNDS = 40

# The product's real operating point: the scheduler dispatches a
# crew-capacity-sized slice, so what matters is the purity of that slice rather
# than performance at an arbitrary probability cut. Must stay the complement of
# adapter/ml_source.py's MAINTAIN_QUANTILE (0.90) — the two are one decision.
TOP_K = 0.10


# --- feature matrix --------------------------------------------------------
def build_matrix(df: pd.DataFrame, land: pd.DataFrame | None = None) -> pd.DataFrame:
    """Feature table (+ land features) -> the model's design matrix.

    Joins `land_features.csv` when the frame does not already carry its columns,
    coerces the two categoricals, and returns FEATURES in FEATURES order.
    Selecting by name here is what lets callers hand over a frame with extra or
    reordered columns safely; everything downstream is positional.

    Missing values stay NaN on purpose. LightGBM learns a split direction for
    them, which is the honest treatment of a site Sentinel-2 never saw through
    cloud. Imputing a median would invent an observation.
    """
    frame = df.copy()

    missing = [c for c in FEATURES if c not in frame.columns]
    if missing:
        if land is None and LAND_FEATURES_CSV.exists():
            land = pd.read_csv(LAND_FEATURES_CSV)
        if land is not None and "tower_id" in frame.columns:
            join_columns = ["tower_id"] + [
                c for c in land.columns if c in missing and c != "tower_id"
            ]
            frame = frame.merge(land[join_columns], on="tower_id", how="left")

    still_missing = [c for c in FEATURES if c not in frame.columns]
    if still_missing:
        raise ValueError(
            f"feature matrix is missing columns: {still_missing}. Run "
            "data/prepare_land_features.py, or pass `land=` explicitly."
        )

    matrix = frame[FEATURES].copy()
    for column in CATEGORICAL_FEATURES:
        # The booster stores its own category mapping at train time, so serving
        # must use the same dtype. This is why the notebook trains on exactly
        # this function's output rather than assembling its own frame.
        matrix[column] = matrix[column].astype("category")
    return matrix


# --- inference -------------------------------------------------------------
def load_booster(path: Path = MODEL_PATH):
    """The trained booster, or None when there is no usable artifact.

    Returns None rather than raising, and that is load-bearing: a checkout with
    no trained model must still boot the API, which falls back to the physical
    index. A missing model is a configuration state, not an error.
    """
    if lgb is None or not Path(path).exists():
        return None
    try:
        return lgb.Booster(model_file=str(path))
    except Exception:  # noqa: BLE001 — a corrupt artifact must not take the API down
        return None


def factor_shares(booster, matrix: pd.DataFrame) -> pd.DataFrame:
    """Per-tower factor attribution from exact TreeSHAP, as shares summing to 1.

    `pred_contrib=True` returns n_features + 1 columns; the LAST is the model's
    base value (the expected log-odds), not a feature. Slicing it in silently
    corrupts every share, and since it is large the corruption is not subtle.

    Shares are normalised ABSOLUTE contributions. Raw SHAP is signed, and a
    factor that lowers a site's risk would otherwise render as a negative bar in
    a panel that only draws positives. Magnitude answers the question the panel
    actually asks — which factors decided this score — while sign answers a
    different one the UI has no way to show.
    """
    contributions = np.asarray(booster.predict(matrix, pred_contrib=True))
    if contributions.shape[1] != len(FEATURES) + 1:
        raise ValueError(
            f"pred_contrib returned {contributions.shape[1]} columns for "
            f"{len(FEATURES)} features; expected {len(FEATURES) + 1} "
            "(features plus the trailing base value)."
        )
    magnitude = np.abs(contributions[:, : len(FEATURES)])

    position = {name: i for i, name in enumerate(FEATURES)}
    grouped = np.column_stack(
        [
            magnitude[:, [position[f] for f in FACTOR_GROUPS[factor]]].sum(axis=1)
            for factor in FACTORS
        ]
    )
    # A row where every contribution is zero (a booster that never split) would
    # divide by zero. An equal split is the honest reading of "this model
    # distinguishes nothing here", and it keeps the shares summing to 1.
    totals = grouped.sum(axis=1, keepdims=True)
    shares = np.full_like(grouped, 1.0 / len(FACTORS))
    np.divide(grouped, totals, out=shares, where=totals > 0)
    return pd.DataFrame(shares, columns=FACTORS, index=matrix.index)


def score(
    df: pd.DataFrame, booster=None, land: pd.DataFrame | None = None
) -> tuple[np.ndarray, pd.DataFrame]:
    """Feature table -> (risk, attribution shares).

    Same return signature as model.risk_index.score(), deliberately: the adapter
    swaps between them on one branch rather than a rewrite, and both feed the
    same scored-tower record (docs/Backend_Handoff.md 1).

    `risk` is P(a corrective work order was needed) — not a failure probability,
    not a hazard rate.
    """
    if booster is None:
        booster = load_booster()
    if booster is None:
        raise ValueError(
            f"no trained model at {MODEL_PATH}. Run notebooks/maintenance_need.ipynb, "
            "or call load_booster() first and fall back to model.risk_index.score()."
        )
    matrix = build_matrix(df, land)
    risk = np.asarray(booster.predict(matrix), dtype=float)
    return risk, factor_shares(booster, matrix)


def dominant_factor(shares: pd.DataFrame) -> pd.Series:
    """Largest share per row. Every value must exist as a key in
    config/actions.yaml, or the scheduler has no work order to raise for it."""
    return shares.idxmax(axis=1)
