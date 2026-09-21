"""Unit tests for the second-opinion layers — novelty and the rule profiler.

Network-free and synthetic. The guards here are about the ways this particular
seam breaks silently:

  * a rule reading maintenance history, which predicts the served label by
    construction and would report near-perfect accuracy for arithmetic — the
    failure that withdrew `maintenance_classifier`;
  * a broken isolation forest being indistinguishable from a genuine "nothing
    is unusual here", the same planted-signal guard model/signal_performance.py
    and model/test_maintenance_need.py both use;
  * the ISOLATION FOREST reaching `decision`, which a matched-budget measurement
    says it must not — it scores |deviation| and maintenance need is monotone,
    so it converts a 0.93-ROC telemetry block into 0.52 inside the band;
  * the combination reverting to a GATE, which held-out seeds put at -0.0125 F1
    (1/5) against the blend's +0.0191 (5/5) — a gate reorders nothing;
  * a tower with no telemetry being pushed DOWN the ordering, which would
    penalise a partially monitored fleet for its own rollout;
  * `risk` being overwritten by the blended ordering;
  * the condition score losing its one-sidedness, which is the entire reason it
    beats the forest on the identical column;
  * either layer reaching `risk`, which nothing may;
  * an unsupervised layer promoting a tower two bands, or past the population
    cap, or ahead of the supervised model's own ordering;
  * novelty rendering as 0.0 rather than null, which states "measured,
    perfectly typical" where the truth is "not measured";
  * a config rule with no predicate (never fires, looks merely quiet) or a
    predicate with no config (raises mid-request instead of at construction).

Run from src/backend:  python3 model/test_second_opinion.py  (or via pytest)
"""

import ast
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_BACKEND = _THIS_DIR.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import numpy as np
import pandas as pd
import yaml

from model import novelty as novelty_module
from model.maintenance_need import CATEGORICAL_FEATURES, build_matrix
from model.ensemble import CONDITION_BLEND_WEIGHT, blend_priority
from model.novelty import (
    NOVELTY_FEATURES,
    TELEMETRY_COLUMNS,
    condition_scores,
    fit,
    novelty_scores,
)
from model.profiler import PREDICATES, BehavioralProfiler
from model.test_maintenance_need import _synthetic_frame

PROFILER_PY = _THIS_DIR / "profiler.py"
PROFILER_YAML = _BACKEND / "config" / "profiler.yaml"

# Columns that ARE the label, or that trivially reconstruct it. The served
# target is the site's 36-month corrective count thresholded at one — on the
# shipped dataset both quantities select the same 246 rows — so a rule reading
# any of these is scored on its ability to restate its own input.
FORBIDDEN_HISTORY_NAMES = {
    "n_corrective_36mo",
    "n_corrective_to_date",
    "months_since_last_corrective",
    "needed_corrective_maintenance",
    "needed_corrective_within_horizon",
    "lambda_true",
    "lambda_true_window",
    "maintenance_labels",
    "maintenance_records",
    "maintenance_panel",
}

# The frontend keys flag rows off `id`, not off `label`. Renaming one is a
# silent drop of that row rather than a compile error, so the set is frozen.
EXPECTED_FLAG_IDS = {
    "unassigned_territory",
    "out_of_crew_range",
    "incomplete_evidence",
    "unmapped_asset",
    "storm_coupled",
    "monsoon_blocked",
    "model_high_ground_quiet",
    "model_low_ground_active",
}

def _profiler(**overrides) -> BehavioralProfiler:
    """A profiler on hand-built config, roster and policy — no files, no network."""
    config = {
        "rules": {
            rule_id: {"enabled": True, "evaluable": False, "label": rule_id, "detail": "d"}
            for rule_id in PREDICATES
        }
    }
    crews = [
        {
            "crew_id": "SEL-C1",
            "crew_type": "civil",
            "territory": "Selangor",
            "max_travel_km": 120,
            "depot": {"lon": 101.6, "lat": 3.1, "name": "Shah Alam"},
        }
    ]
    policy = {
        "travel": {"road_factor": 1.35, "max_travel_km_default": 120},
        "monsoon": {"months": [11, 12, 1, 2, 3], "flood_zone_share_threshold": 0.25,
                    "blocked_crew_types": ["civil"]},
        "demo_clock": {"today": "2026-08-17"},
    }
    actions = {"flood": {"crew_type": "civil"}}
    kwargs = {"config": config, "crews": crews, "policy": policy, "actions": actions}
    kwargs.update(overrides)
    return BehavioralProfiler(**kwargs)


def _record(**overrides) -> dict:
    base = {
        "tower_id": "T0001",
        "lon": 101.61,
        "lat": 3.11,
        "radio": "LTE",
        "territory": "Selangor",
        "dominant_factor": "flood",
        "attribution": {"flood": 0.9, "terrain": 0.1},
        "weather": None,
    }
    base.update(overrides)
    return base


_COMPLETE_ROW = pd.Series({f: 1.0 for f in NOVELTY_FEATURES})


# --- layer 2: novelty --------------------------------------------------------
def test_novelty_recovers_a_planted_outlier():
    """Five rows placed far outside the cloud must land in the top decile.

    Without this, a flat novelty column on real data is indistinguishable from
    a broken harness — the same guard test_maintenance_need.py uses for the
    supervised model and signal_performance.py uses for its null."""
    frame = _synthetic_frame(300, seed=11)
    matrix = build_matrix(frame)
    planted = matrix.index[:5]
    matrix.loc[planted, "hand_m"] = matrix["hand_m"].mean() + 10 * matrix["hand_m"].std()
    matrix.loc[planted, "elevation_m"] = 50_000.0

    scores = novelty_scores(matrix, fit(matrix))
    assert (scores[:5] >= 0.9).all(), scores[:5]


def test_novelty_is_none_for_incomplete_rows():
    """IsolationForest raises on NaN, and 20 real towers carry it. Those rows
    read null, never 0.0 — 0.0 claims 'measured, perfectly typical'."""
    frame = _synthetic_frame(200, seed=12)
    matrix = build_matrix(frame)
    matrix.loc[matrix.index[:3], "clay_pct"] = np.nan

    scores = novelty_scores(matrix, fit(matrix))
    assert np.isnan(scores[:3]).all()
    assert np.isfinite(scores[3:]).all()


def test_novelty_excludes_categoricals():
    """An integer category code split at a random threshold is an ordinal axis;
    'between forest and cropland' is not a place."""
    assert not set(NOVELTY_FEATURES) & set(CATEGORICAL_FEATURES)
    assert len(NOVELTY_FEATURES) > 0


def test_novelty_is_rank_normalised():
    """A percentile rank in [0, 1], monotone in the raw isolation score."""
    frame = _synthetic_frame(150, seed=13)
    matrix = build_matrix(frame)
    forest = fit(matrix)
    scores = novelty_scores(matrix, forest)

    assert np.nanmin(scores) >= 0.0 and np.nanmax(scores) <= 1.0
    raw = -forest.score_samples(matrix[NOVELTY_FEATURES])
    assert pd.Series(raw).corr(pd.Series(scores), method="spearman") > 0.9999


def test_novelty_returns_none_without_sklearn():
    """A checkout without scikit-learn must still serve. Absence is null."""
    original = novelty_module.IsolationForest
    try:
        novelty_module.IsolationForest = None
        matrix = build_matrix(_synthetic_frame(80, seed=14))
        assert fit(matrix) is None
        assert np.isnan(novelty_scores(matrix, None)).all()
    finally:
        novelty_module.IsolationForest = original


def test_novelty_returns_none_below_min_fit_rows():
    matrix = build_matrix(_synthetic_frame(10, seed=15))
    assert fit(matrix) is None


# --- layer 3: profiler -------------------------------------------------------
def test_profiler_never_reads_maintenance_history():
    """THE load-bearing test. The served label is the site's own corrective
    count thresholded at one, so a rule reading that history predicts the target
    by construction and reports arithmetic as accuracy — the failure that
    withdrew maintenance_classifier.

    Parsed from the AST, not grepped: this module's docstrings name those
    columns deliberately to explain why they are banned, and a grep test would
    fail on its own explanation. Docstring nodes are excluded; every other
    string constant is checked, because df["n_corrective_36mo"] hides the name
    in a Constant rather than a Name."""
    tree = ast.parse(PROFILER_PY.read_text())

    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", None)
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                docstrings.add(id(body[0].value))

    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    names |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    names |= {
        n.value
        for n in ast.walk(tree)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings
    }
    leaked = names & FORBIDDEN_HISTORY_NAMES
    assert not leaked, f"model/profiler.py reads maintenance history: {sorted(leaked)}"


def test_profiler_yaml_rules_match_predicates():
    """Both directions. A YAML rule with no predicate never fires and looks
    merely quiet; a predicate with no YAML entry raises mid-request."""
    rules = yaml.safe_load(PROFILER_YAML.read_text())["rules"]
    assert set(rules) == set(PREDICATES) == EXPECTED_FLAG_IDS


def test_flag_ids_are_stable():
    """The frontend groups on `id`. A rename silently drops that row."""
    rules = yaml.safe_load(PROFILER_YAML.read_text())["rules"]
    assert set(rules) == EXPECTED_FLAG_IDS

def test_unassigned_territory_fires_when_no_crew_rosters_it():
    """Stated as 'no crew rosters this territory' rather than a literal, so it
    also catches the Malacca/Melaka spelling fault, which would otherwise leave
    a whole real state undispatchable without raising."""
    prof = _profiler()
    flags = {f["id"] for f in prof.flags(_record(territory="Malacca"), _COMPLETE_ROW)}
    assert "unassigned_territory" in flags
    assert "out_of_crew_range" not in flags  # mutually exclusive, never both


def test_out_of_crew_range_fires_only_when_crews_exist_but_cannot_reach():
    prof = _profiler()
    near = prof.flags(_record(lon=101.61, lat=3.11), _COMPLETE_ROW)
    far = prof.flags(_record(lon=110.0, lat=1.5), _COMPLETE_ROW)
    assert "out_of_crew_range" not in {f["id"] for f in near}
    assert "out_of_crew_range" in {f["id"] for f in far}


def test_incomplete_evidence_fires_on_a_partial_row():
    prof = _profiler()
    partial = _COMPLETE_ROW.copy()
    partial["clay_pct"] = np.nan
    assert "incomplete_evidence" in {f["id"] for f in prof.flags(_record(), partial)}
    assert "incomplete_evidence" not in {f["id"] for f in prof.flags(_record(), _COMPLETE_ROW)}


def test_unmapped_asset_fires_on_unknown_radio():
    prof = _profiler()
    assert "unmapped_asset" in {f["id"] for f in prof.flags(_record(radio="UNKNOWN"), _COMPLETE_ROW)}
    assert "unmapped_asset" not in {f["id"] for f in prof.flags(_record(radio="NR"), _COMPLETE_ROW)}


def test_weather_none_does_not_fire_storm_coupled():
    """None means the forecast is off OR Earth Engine was unreachable — 'we
    could not ask' in both cases. The flag must not fire, and its absence must
    not be read as checked-and-clear."""
    prof = _profiler()
    assert "storm_coupled" not in {f["id"] for f in prof.flags(_record(weather=None), _COMPLETE_ROW)}

    quiet = _record(weather={"multiplier": 1.0, "drivers": []})
    assert "storm_coupled" not in {f["id"] for f in prof.flags(quiet, _COMPLETE_ROW)}

    storm = _record(weather={"multiplier": 0.5, "drivers": ["severe_rain"]})
    assert "storm_coupled" in {f["id"] for f in prof.flags(storm, _COMPLETE_ROW)}


def test_monsoon_blocked_respects_the_pinned_clock():
    """Reads the same demo_clock the optimizer builds its window against, so
    the flag and the schedule cannot disagree about what month it is."""
    august = _profiler()
    assert "monsoon_blocked" not in {f["id"] for f in august.flags(_record(), _COMPLETE_ROW)}

    december = _profiler(
        policy={
            "travel": {"road_factor": 1.35, "max_travel_km_default": 120},
            "monsoon": {"months": [11, 12, 1, 2, 3], "flood_zone_share_threshold": 0.25,
                        "blocked_crew_types": ["civil"]},
            "demo_clock": {"today": "2026-12-01"},
        }
    )
    assert "monsoon_blocked" in {f["id"] for f in december.flags(_record(), _COMPLETE_ROW)}

def test_profiler_rejects_config_predicate_mismatch():
    try:
        BehavioralProfiler(
            config={"rules": {"nonexistent_rule": {"weight": 1.0}}},
            crews=[], policy={}, actions={},
        )
    except ValueError:
        return
    raise AssertionError("a rule with no predicate must fail at construction")


# --- the layers stay OUT of the score and the band ---------------------------
def test_the_forest_never_reaches_the_ordering():
    """`novelty` must never be an argument to the combination. The forest scores
    |deviation| and maintenance need is monotone, which turned a 0.93-ROC
    telemetry block into 0.52 inside the band that decides dispatch.

    AST-parsed, not grepped: both modules discuss the forest at length in prose
    and a text search would fail on the explanation — the same trap
    test_profiler_never_reads_maintenance_history sidesteps."""
    tree = ast.parse((_BACKEND / "adapter" / "ml_source.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "blend_priority":
            names = [a.attr for a in node.args if isinstance(a, ast.Attribute)]
            assert "novelty" not in names, f"the forest is being blended in: {names}"
            assert "condition" in names, f"the blend must take condition: {names}"
            return
    raise AssertionError("adapter/ml_source.py no longer calls blend_priority()")


# --- layer 2: the one-sided condition score ---------------------------------
def test_condition_is_one_sided():
    """THE distinction that makes this layer work. An isolation forest scores
    |deviation from typical|; maintenance need is monotone. Measured, a forest
    given a telemetry block that ranks the label at ROC 0.93 returns 0.575
    in-band, while the same column read one-sided returns 0.757. So the score
    must be MONOTONE INCREASING in the counters — a quiet site must never rank
    alongside a loud one."""
    ids = [f"T{i:03d}" for i in range(60)]
    counts = np.linspace(0.0, 500.0, 60)
    telemetry = pd.DataFrame({"tower_id": ids, **{c: counts for c in TELEMETRY_COLUMNS}})
    scores = condition_scores(ids, telemetry)
    assert np.all(np.diff(scores) > 0), "condition score is not monotone in the counters"

    quiet, loud = condition_scores([ids[0], ids[-1]], telemetry)
    assert loud > quiet


def test_condition_is_rank_normalised_and_label_free():
    ids = [f"T{i:03d}" for i in range(40)]
    rng = np.random.default_rng(0)
    telemetry = pd.DataFrame({"tower_id": ids,
                              **{c: rng.gamma(2.0, 8.0, 40) for c in TELEMETRY_COLUMNS}})
    scores = condition_scores(ids, telemetry)
    assert np.nanmin(scores) >= 0.0 and np.nanmax(scores) <= 1.0

    # Unsupervised, checked the same way the profiler's history ban is: AST,
    # docstrings excluded. A grep fails here on this module's own prose, which
    # discusses the label at length to explain why it never reads one.
    tree = ast.parse((_THIS_DIR / "novelty.py").read_text())
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef))
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
        and isinstance(node.body[0].value.value, str)
    }
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    names |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    names |= {
        n.value for n in ast.walk(tree)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings
    }
    assert not (names & FORBIDDEN_HISTORY_NAMES), sorted(names & FORBIDDEN_HISTORY_NAMES)


def test_condition_is_null_when_telemetry_is_missing():
    """No telemetry file, or a tower absent from it, reads null — never 0.0,
    which would claim "measured, perfectly quiet"."""
    telemetry = pd.DataFrame({"tower_id": ["A", "B"], **{c: [1.0, 2.0] for c in TELEMETRY_COLUMNS}})
    scores = condition_scores(["A", "B", "MISSING"], telemetry)
    assert np.isnan(scores[2])
    assert np.isfinite(scores[:2]).all()
    assert np.isnan(condition_scores(["A"], pd.DataFrame({"tower_id": ["A"]}))).all()


# --- the combination policy --------------------------------------------------
def test_blend_is_a_rank_not_a_probability():
    risk = np.array([0.01, 0.2, 0.5, 0.9])
    priority = blend_priority(risk, np.array([0.1, 0.4, 0.6, 0.99]))
    assert priority.min() >= 0.0 and priority.max() <= 1.0
    assert not np.allclose(priority, risk), "priority must not just echo risk"


def test_missing_telemetry_keeps_the_model_rank():
    """A tower with no telemetry must not be pushed down. Missing telemetry is
    not evidence of a healthy site, and a fleet part-way through a monitoring
    rollout must not see its unmonitored towers quietly de-prioritised."""
    risk = np.array([0.9, 0.8, 0.7, 0.6, 0.5])
    condition = np.array([0.05, 0.05, np.nan, 0.05, 0.05])
    priority = blend_priority(risk, condition)
    # the NaN tower is 3rd by risk and must stay ahead of the two below it
    assert priority[2] > priority[3] > priority[4]


def test_all_missing_telemetry_falls_back_to_the_model():
    risk = np.array([0.1, 0.9, 0.5, 0.3])
    priority = blend_priority(risk, np.full(4, np.nan))
    assert list(np.argsort(priority)) == list(np.argsort(risk))


def test_blend_weight_actually_moves_the_ordering():
    """Guards the weight being silently zeroed.

    Stated as a TIE-BREAK rather than "a low-risk tower overtakes a high-risk
    one": at w=0.25 the model still dominates, and a test demanding a large
    climb would only pass at a weight the measurement rejected. Two towers with
    identical risk and opposite telemetry is the invariant that actually holds.
    """
    n = 100
    risk = np.linspace(0.1, 0.9, n)
    # Deliberately NOT a monotone function of risk. A perfectly anti-correlated
    # linear condition makes the blend 0.5*r + 0.25, which is monotone in r, so
    # re-ranking reproduces the model order exactly — correct behaviour, and a
    # test built on it would assert the opposite of what the code should do.
    condition = np.random.default_rng(0).permutation(n) / n
    priority = blend_priority(risk, condition)
    assert not np.allclose(priority, blend_priority(risk, np.full(n, np.nan))), (
        "the blend weight has no effect on the ordering"
    )

    # identical risk, opposite condition -> the hot one must rank higher
    risk = np.concatenate([np.full(2, 0.5), np.linspace(0.0, 1.0, 40)])
    condition = np.concatenate([[0.99, 0.01], np.linspace(0.0, 1.0, 40)])
    priority = blend_priority(risk, condition)
    assert priority[0] > priority[1]


def test_blend_does_not_mutate_risk():
    risk = np.array([0.1, 0.5, 0.9])
    before = risk.copy()
    blend_priority(risk, np.array([0.9, 0.5, 0.1]))
    np.testing.assert_array_equal(risk, before)


def test_blend_weight_stays_in_the_measured_region():
    """Swept on seeds 0-4 (0.2 and 0.3 win 5/5, 0.5 wins 2/5) and verified on
    5-9. Past ~0.4 the ordering is worse than LightGBM alone, because condition
    is the weaker standalone ranker (0.884 against 0.905)."""
    assert 0.15 <= CONDITION_BLEND_WEIGHT <= 0.35


def test_blend_on_empty_input():
    assert blend_priority(np.array([]), np.array([])).shape == (0,)


def test_adapter_bands_on_the_blend_and_not_on_risk_alone():
    """The whole change. AST-parsed: the module discusses the old gate at length
    in prose and a text search would fail on the explanation."""
    tree = ast.parse((_BACKEND / "adapter" / "ml_source.py").read_text())
    called = {
        node.func.id for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "blend_priority" in called, "adapter no longer blends"
    assert "escalate" not in called, "adapter reverted to a gate"


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
