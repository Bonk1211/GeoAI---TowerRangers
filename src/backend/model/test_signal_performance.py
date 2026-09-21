"""Unit tests for the signal-residual model.

Network-free, and mostly synthetic: the model tests build a small panel in
memory so they neither depend on the generated artifact nor take a second to
run. The guards that matter here are not about accuracy — with a null result
there is no accuracy to guard — but about the three ways this analysis could
quietly become dishonest: leaked groups, zero-variance features presented as
effects, and failure-prediction language.

Run from src/backend:  python3 model/test_signal_performance.py  (or via pytest)
"""

import inspect
import re
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

import numpy as np
import pandas as pd

from model import signal_performance as sp


def _synthetic_panel(n_nodes: int = 10, sessions: int = 4) -> pd.DataFrame:
    """A small panel with a real distance effect, so the machinery is exercised."""
    rng = np.random.default_rng(0)
    rows = []
    for node in range(1, n_nodes + 1):
        for session in range(sessions):
            distance = rng.uniform(50, 800)
            rows.append(
                {
                    "node": node,
                    "SessionID": session,
                    "n_measurements": 40,
                    "median_level_dbm": -60 - 20 * np.log10(distance) + rng.normal(0, 2),
                    "link_distance_m": distance,
                    "median_speed_kmh": rng.uniform(0, 40),
                    "network_tech": rng.choice(["4G", "5G"]),
                    "operator": rng.choice(["Operator A", "Operator B"]),
                    "hand_m": rng.uniform(0, 15),
                    "slope_deg": rng.uniform(0, 20),
                    "tri": rng.uniform(1, 25),
                    "dist_water_m": rng.uniform(25, 680),
                    "dist_power_m": rng.uniform(17, 1080),
                    "physical_site_group": node,
                    "lon": 101.6,
                    "lat": 3.07,
                    "session_ts": f"2024-12-{session + 1:02d}T10:00:00Z",
                }
            )
    panel = pd.DataFrame(rows)
    panel["log_distance"] = np.log10(panel["link_distance_m"].clip(lower=1.0))
    return panel


def test_cross_validation_groups_by_physical_site():
    """The single mistake that would repeat the withdrawn classifier's failure.

    Row-wise CV over a panel whose rows come from 48 masts reports memorisation,
    not generalisation. Asserted against the source because a passing score
    cannot distinguish the two.
    """
    assert "GroupKFold" in inspect.getsource(sp._splitter)
    assert "groups=groups" in inspect.getsource(sp._out_of_fold)
    assert "groups=groups" in inspect.getsource(sp._fold_scores)


def test_no_site_appears_in_both_train_and_test():
    """The property the grouping is supposed to give, checked directly."""
    panel = _synthetic_panel()
    groups = panel[sp.GROUP].to_numpy()
    X = sp._design(panel, with_environment=True)
    for train_idx, test_idx in sp._splitter(groups).split(X, panel[sp.TARGET], groups=groups):
        assert not set(groups[train_idx]) & set(groups[test_idx])


def test_zero_variance_layers_are_not_features():
    """Soil moisture and forecast rainfall are constant across a 5.7 km2 AOI.

    A zero-variance column gets an arbitrary coefficient that then gets
    described as an effect — the same class of error that retired the
    classifier, in a new costume.
    """
    banned = ("soil_moisture", "rain", "precip", "smap", "gfs")
    for feature in [f.lower() for f in sp.ENVIRONMENT_FEATURES + sp.GEOMETRY_FEATURES]:
        assert not any(token in feature for token in banned), feature


def test_geometry_is_entered_before_environment():
    """Environment is only ever scored as an increment over geometry.

    Reporting environment's standalone R2 would credit it with path loss it did
    not explain.
    """
    results = sp.evaluate(_synthetic_panel())
    assert set(results) >= {"null", "geometry", "geometry+environment", "incremental_r2"}
    expected = results["geometry+environment"]["r2"] - results["geometry"]["r2"]
    assert abs(results["incremental_r2"] - expected) < 1e-12


def test_incremental_r2_is_reported_whatever_its_sign():
    """A null or negative result must survive to the caller, not be clipped.

    The whole design allows for environment explaining nothing; a max(0, ...)
    anywhere here would turn a finding into a silence.
    """
    results = sp.evaluate(_synthetic_panel())
    assert isinstance(results["incremental_r2"], float)
    source = inspect.getsource(sp.evaluate)
    assert "max(0" not in source and "clip" not in source


def test_geometry_recovers_a_planted_distance_effect():
    """Sanity: the pipeline can find a signal that is genuinely there.

    Without this, a null result on real data is indistinguishable from a broken
    script. The synthetic panel has a true -20*log10(d) relationship.
    """
    results = sp.evaluate(_synthetic_panel())
    assert results["geometry"]["r2"] > 0.8, results["geometry"]["r2"]
    assert results["geometry"]["r2"] > results["null"]["r2"]


def test_residuals_are_observed_minus_geometry_prediction():
    panel = _synthetic_panel()
    results = sp.evaluate(panel)
    per_site = sp.residuals(panel, results["geometry"]["predictions"])
    assert len(per_site) == panel["node"].nunique()
    assert {"node", "residual_db", "sessions"} <= set(per_site.columns)
    # Sorted worst-first, so head() is the underperformers.
    assert per_site["residual_db"].is_monotonic_increasing


def test_diagnostics_explain_rather_than_assert():
    """A null with no diagnosis is indistinguishable from a broken script."""
    diag = sp.diagnostics(_synthetic_panel())
    assert {"icc", "site_level_distance_corr", "correlations", "n_sites"} <= set(diag)
    assert 0.0 <= diag["icc"] <= 1.0


def test_trend_requires_enough_sessions_and_span():
    """A slope through a handful of points is a scatter plot, and the thresholds
    that keep it from being worse must not be relaxed silently."""
    assert sp.TREND_MIN_SESSIONS >= 3
    assert sp.TREND_MIN_SPAN_DAYS >= 60
    # The synthetic panel spans four days, so nothing should qualify.
    assert sp.trends(_synthetic_panel()).empty


def test_no_failure_prediction_language():
    """This predicts measured signal quality. It does not predict events.

    The project has no failure labels anywhere, and code implying otherwise is
    the one thing docs/Backend_Handoff.md 0.6 forbids outright.
    """
    source = Path(sp.__file__).read_text(encoding="utf-8").lower()
    for pattern in (r"\bpredicts? failure", r"\bfailure probab", r"\boutage\b", r"\bwill fail\b"):
        assert not re.search(pattern, source), pattern


def test_matmul_warning_filter_is_narrow():
    """Suppressing all RuntimeWarnings would hide a real numeric problem.

    The Accelerate BLAS artifact was verified spurious (matmul agrees with
    einsum to 1e-11); the filter must stay scoped to that message alone.
    """
    source = Path(sp.__file__).read_text(encoding="utf-8")
    assert 'message=".*encountered in matmul"' in source
    assert 'filterwarnings("ignore")' not in source


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
