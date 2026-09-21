"""Unit tests for the supervised maintenance-need scorer.

Network-free and synthetic. This module is the single boundary the notebook and
the serving API must agree across, so the guards here are about the ways that
boundary breaks silently:

  * SHAP's trailing base-value column leaking into a feature's share;
  * feature order drifting between training and serving, which LightGBM accepts
    as a plain positional array and never raises on;
  * a harness bug indistinguishable from a genuine null result — recovering a
    planted signal, interaction, and non-monotone response are the same guard
    model/signal_performance.py uses for its own null;
  * GroupKFold silently training on a fold's own test state;
  * signed SHAP rendering a risk-lowering factor as a positive bar;
  * a feature belonging to zero or two factor groups;
  * a dominant_factor value with no config/actions.yaml entry, which would
    crash the scheduler rather than the model;
  * the notebook declaring its own copy of a constant this module owns.

Run from src/backend:  python3 model/test_maintenance_need.py  (or via pytest)
"""

import ast
import json
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_BACKEND = _THIS_DIR.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import lightgbm as lgb
import numpy as np
import pandas as pd
import yaml

from model.maintenance_need import (
    CATEGORICAL_FEATURES,
    FACTOR_GROUPS,
    FACTORS,
    FEATURES,
    PARAMS,
    build_matrix,
    dominant_factor,
    factor_shares,
    load_booster,
    score,
)

_REPO_ROOT = _BACKEND.parent.parent
NOTEBOOK_PATH = _REPO_ROOT / "notebooks" / "maintenance_need.ipynb"
ACTIONS_YAML = _BACKEND / "config" / "actions.yaml"

# Constants this module owns — the notebook must import all of these and
# declare none of them itself.
#
# NOVELTY_FEATURES and IF_PARAMS are here too, owned by model/novelty.py, for
# the same reason: the notebook fits its own per-fold isolation forest and must
# use the module's parameters rather than a local copy that drifts.
OWNED_CONSTANTS = {
    "FEATURES", "FACTOR_GROUPS", "FACTORS", "CATEGORICAL_FEATURES",
    "PARAMS", "TOP_K", "MODEL_PATH", "REPORT_PATH",
    "NOVELTY_FEATURES", "IF_PARAMS", "TELEMETRY_COLUMNS",
    "CONDITION_BLEND_WEIGHT",
    "CHANGE_BLEND_WEIGHT",
}


def _synthetic_frame(n=300, seed=0):
    """A minimal frame carrying every column build_matrix needs, with no
    dependence on Earth Engine or the real tower table."""
    rng = np.random.default_rng(seed)
    hand = rng.gamma(2.0, 6.0, n)
    return pd.DataFrame(
        {
            "tower_id": [f"T{i:04d}" for i in range(n)],
            "gsw_occurrence_pct": rng.uniform(0, 40, n),
            "gsw_recurrence_pct": rng.uniform(0, 20, n),
            "hand_m": hand,
            "dist_water_m": rng.exponential(200.0, n),
            "soil_moisture_mean": rng.uniform(0.1, 0.5, n),
            "soil_moisture_p90": rng.uniform(0.2, 0.6, n),
            "slope_deg": rng.gamma(2.0, 4.0, n),
            "tri": rng.gamma(2.0, 3.0, n),
            "elevation_m": rng.uniform(0, 1200, n),
            "clay_pct": rng.uniform(5, 55, n),
            "evi_median": rng.uniform(0.05, 0.9, n),
            "evi_p10": rng.uniform(0.02, 0.6, n),
            "land_cover_class": rng.choice([10, 30, 40, 50], n),
            "dist_power_m": rng.exponential(1500.0, n),
            "radio": rng.choice(["UNKNOWN", "LTE", "GSM", "NR"], n, p=[0.9, 0.05, 0.03, 0.02]),
        }
    )


def _train(frame, y, params=None):
    matrix = build_matrix(frame)
    booster = lgb.train(
        {**PARAMS, **(params or {})},
        lgb.Dataset(matrix, y, categorical_feature=CATEGORICAL_FEATURES),
        num_boost_round=60,
    )
    return booster, matrix


# --- attribution correctness -----------------------------------------------
def test_shap_contributions_drop_base_value_column():
    """pred_contrib returns n_features + 1 columns; the last is the model's
    base value, not a feature. Slicing it in silently corrupts every share."""
    frame = _synthetic_frame(200)
    y = (frame["gsw_occurrence_pct"] > 20).astype(int).to_numpy()
    booster, matrix = _train(frame, y)

    raw = np.asarray(booster.predict(matrix, pred_contrib=True))
    assert raw.shape[1] == len(FEATURES) + 1

    shares = factor_shares(booster, matrix)
    assert list(shares.columns) == FACTORS
    np.testing.assert_allclose(shares.sum(axis=1).to_numpy(), 1.0, atol=1e-6)


def test_attribution_shares_are_non_negative():
    """Raw SHAP is signed; a risk-lowering factor must not render as a negative
    bar in a panel that only draws positives."""
    frame = _synthetic_frame(150)
    y = (frame["dist_power_m"] > 2000).astype(int).to_numpy()
    booster, matrix = _train(frame, y)
    shares = factor_shares(booster, matrix)
    assert (shares.to_numpy() >= 0).all()


def test_factor_groups_cover_every_feature_exactly_once():
    """A feature in two groups double-counts; one in no group vanishes from
    attribution without a trace."""
    covered = sum(FACTOR_GROUPS.values(), [])
    assert sorted(covered) == sorted(FEATURES)
    assert len(covered) == len(set(covered))


def test_dominant_factor_values_all_exist_in_actions_yaml():
    """Every value dominant_factor can emit must resolve in actions.yaml, or
    the scheduler raises KeyError trying to build a work order."""
    actions = yaml.safe_load(ACTIONS_YAML.read_text())
    for factor in FACTORS:
        assert factor in actions, f"{factor} has no config/actions.yaml entry"


# --- feature order and stability --------------------------------------------
def test_feature_order_is_positional_and_stable():
    """build_matrix selects by NAME; a caller handing over a shuffled frame
    must still get the model's own column order, not the caller's."""
    frame = _synthetic_frame(100)
    shuffled = frame[list(frame.columns)[::-1]]
    ordered = build_matrix(frame)
    reordered = build_matrix(shuffled)
    assert list(ordered.columns) == FEATURES == list(reordered.columns)
    pd.testing.assert_frame_equal(
        ordered.reset_index(drop=True), reordered.reset_index(drop=True)
    )


def test_categorical_dtype_is_stable_across_calls():
    """The booster stores its own category mapping at train time; serving must
    reproduce the same dtype or predictions silently misalign."""
    frame = _synthetic_frame(80)
    matrix = build_matrix(frame)
    for column in CATEGORICAL_FEATURES:
        assert matrix[column].dtype.name == "category"


# --- harness sanity: can this pipeline recover real structure at all? ------
def test_recovers_a_planted_signal():
    """A fully label-determining single feature must be recovered at high
    accuracy. Without this, a null result on the real data is indistinguishable
    from a broken harness — the same guard model/signal_performance.py uses."""
    frame = _synthetic_frame(400, seed=1)
    y = (frame["gsw_occurrence_pct"] > frame["gsw_occurrence_pct"].median()).astype(int).to_numpy()
    booster, matrix = _train(frame, y, params={"min_data_in_leaf": 5})
    pred = booster.predict(matrix)
    from sklearn.metrics import roc_auc_score

    assert roc_auc_score(y, pred) > 0.90

    shares = factor_shares(booster, matrix)
    assert shares["flood"].mean() > shares.drop(columns=["flood"]).mean(axis=1).mean()


def test_recovers_a_planted_interaction():
    """Label needs feature A AND feature B; neither alone determines it. A
    model that beats a single-factor baseline here can recover interactions.

    The generator no longer plants one (the traps were removed in v2.0), so this
    is now a capability test on the model alone, with its own local label."""
    frame = _synthetic_frame(500, seed=2)
    high_clay = frame["clay_pct"] > frame["clay_pct"].median()
    high_moist = frame["soil_moisture_p90"] > frame["soil_moisture_p90"].median()
    y = (high_clay & high_moist).astype(int).to_numpy()
    booster, matrix = _train(frame, y, params={"min_data_in_leaf": 5, "num_leaves": 31})
    from sklearn.metrics import roc_auc_score

    pred = booster.predict(matrix)
    single = frame["clay_pct"].to_numpy()
    assert roc_auc_score(y, pred) > roc_auc_score(y, single) + 0.15


def test_recovers_a_planted_hump():
    """Label peaks at a MID feature value and falls on both sides. A monotone
    probe (the raw feature itself) cannot separate this; the trained model must.

    As above: the generator's vegetation hump was removed in v2.0, so this tests
    the model's capability against a local label rather than trap recovery."""
    frame = _synthetic_frame(500, seed=3)
    evi = frame["evi_median"].to_numpy()
    peak = np.median(evi)
    y = (np.abs(evi - peak) < 0.08).astype(int)
    booster, matrix = _train(frame, y, params={"min_data_in_leaf": 5, "num_leaves": 31})
    from sklearn.metrics import roc_auc_score

    pred = booster.predict(matrix)
    assert roc_auc_score(y, pred) > 0.75
    assert roc_auc_score(y, evi) < 0.60  # a monotone probe cannot see a hump


# --- cross-validation hygiene ------------------------------------------------
def test_group_kfold_never_trains_on_test_state():
    """The whole point of grouping by state; a leaked split reads as a real
    result instead of an artifact."""
    from sklearn.model_selection import GroupKFold

    frame = _synthetic_frame(300, seed=4)
    groups = np.random.default_rng(0).choice([f"S{i}" for i in range(8)], 300)
    folds = GroupKFold(n_splits=5)
    for train_idx, test_idx in folds.split(frame, groups=groups):
        assert not set(groups[train_idx]) & set(groups[test_idx])


# --- report and artifact contract -------------------------------------------
def test_report_declares_synthetic():
    """The report the Method page reads must self-identify as synthetic and
    carry a non-empty caveat. Skipped rather than failed on a fresh checkout
    with no trained model yet."""
    from model.maintenance_need import REPORT_PATH

    if not REPORT_PATH.exists():
        return
    report = json.loads(REPORT_PATH.read_text())
    assert report.get("synthetic_labels") is True
    assert report.get("caveat", "").strip()


def test_load_booster_returns_none_without_raising_when_absent():
    """A checkout without a trained artifact must still boot the API. A missing
    model is a configuration state, not an error."""
    assert load_booster(Path("/nonexistent/path/model.txt")) is None


def test_score_return_signature_matches_risk_index():
    """The adapter swaps between model.maintenance_need.score() and
    model.risk_index.score() on one branch; both must return (risk, shares)."""
    frame = _synthetic_frame(120, seed=5)
    y = (frame["dist_power_m"] > frame["dist_power_m"].median()).astype(int).to_numpy()
    booster, _ = _train(frame, y)
    risk, shares = score(frame, booster=booster)
    assert isinstance(risk, np.ndarray) and risk.shape == (len(frame),)
    assert list(shares.columns) == FACTORS and len(shares) == len(frame)


def test_dominant_factor_matches_largest_share():
    frame = _synthetic_frame(100, seed=6)
    y = (frame["evi_median"] > frame["evi_median"].median()).astype(int).to_numpy()
    booster, matrix = _train(frame, y)
    shares = factor_shares(booster, matrix)
    dominant = dominant_factor(shares)
    for i in range(len(shares)):
        assert dominant.iloc[i] == shares.iloc[i].idxmax()


# --- notebook / module boundary ---------------------------------------------
def _notebook_code_source() -> str:
    if not NOTEBOOK_PATH.exists():
        return ""
    notebook = json.loads(NOTEBOOK_PATH.read_text())
    lines = []
    for cell in notebook.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        cell_lines = [
            "" if line.lstrip().startswith(("%", "!")) else line
            for line in cell.get("source", [])
        ]
        # A newline between cells, not just within one: each cell's source
        # list has no trailing newline on its last line, so joining cells
        # back to back merges the last statement of one into the first of
        # the next and fails ast.parse() on a perfectly normal notebook.
        lines.append("".join(cell_lines) + "\n")
    return "\n".join(lines)


def test_notebook_defines_no_shared_constants():
    """A notebook that redefines FEATURES trains a model the API then feeds
    different columns to, in a different order, and LightGBM accepts a
    positional array without complaint — nothing raises, the numbers are just
    wrong. This is the single most valuable test in this plan."""
    source = _notebook_code_source()
    if not source.strip():
        return  # notebook not yet created — nothing to check
    tree = ast.parse(source)
    assigned = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assigned.add(target.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            assigned.add(node.target.id)
    collision = assigned & OWNED_CONSTANTS
    assert not collision, f"notebook redefines module-owned constants: {collision}"


def test_notebook_imports_the_module():
    """Guards the inverse of the redefinition check: a notebook that stopped
    importing and inlined everything instead."""
    source = _notebook_code_source()
    if not source.strip():
        return
    tree = ast.parse(source)
    imported_from = {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    }
    assert any("maintenance_need" in m for m in imported_from), imported_from


def test_notebook_outputs_are_cleared():
    """Execution counts and base64 plot payloads make every diff unreadable and
    inflate the repo. jupyter nbconvert --clear-output --inplace before commit."""
    if not NOTEBOOK_PATH.exists():
        return
    notebook = json.loads(NOTEBOOK_PATH.read_text())
    for cell in notebook.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        assert cell.get("outputs", []) == [], "notebook committed with outputs"
        assert cell.get("execution_count") is None, "notebook committed with execution counts"


if __name__ == "__main__":
    import traceback

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"  ok  {test.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL  {test.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
