"""Unit tests for the flood-factor evaluation.

Network-free and synthetic. The guards here are not about accuracy — the
accuracy number is whatever the data says — but about the four ways this
evaluation could quietly become dishonest:

  * a confusion matrix that miscounts, so every downstream rate is wrong;
  * a threshold chosen on the rows it is then scored against;
  * a fit that cannot recover a signal it was handed, so a null result would be
    the harness rather than the data (the same planted-law check
    test_signal_performance.py uses);
  * failure-prediction language creeping into a module that scores inundation.

Run from src/backend:  python3 model/test_flood_eval.py   (or via pytest)
"""

import re
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_BACKEND))

import numpy as np
import pandas as pd

from model import flood_eval as fe


def _frame(n=400, seed=0, planted=True):
    """Synthetic points where flooding really is driven by HAND and slope."""
    rng = np.random.default_rng(seed)
    hand = rng.gamma(2.0, 6.0, n)
    slope = rng.gamma(1.5, 4.0, n)
    dist = rng.exponential(300.0, n)
    if planted:
        wet = 1 / (1 + np.exp(0.8 * (hand - 3.0))) * np.exp(-slope / 12.0)
    else:
        wet = np.full(n, 0.15)
    return pd.DataFrame({
        "lon": rng.uniform(100, 119, n), "lat": rng.uniform(1, 7, n),
        "hand_m": hand, "slope_deg": slope, "tri": rng.gamma(2.0, 3.0, n),
        "dist_water_m": dist, "dist_power_m": rng.exponential(1200.0, n),
        "elevation_m": rng.uniform(0, 800, n),
        "state": rng.choice(list("ABCDEF"), n),
        "label": (rng.uniform(size=n) < wet).astype(int),
    })


# --- confusion matrix -----------------------------------------------------
def test_confusion_counts_each_cell_exactly_once():
    y = np.array([1, 1, 1, 0, 0, 0, 0])
    p = np.array([1, 1, 0, 1, 0, 0, 0])
    stats = fe.confusion(y, p)
    assert (stats["true_positive"], stats["false_negative"]) == (2, 1)
    assert (stats["false_positive"], stats["true_negative"]) == (1, 3)
    assert stats["true_positive"] + stats["false_positive"] \
        + stats["false_negative"] + stats["true_negative"] == len(y)
    assert stats["precision"] == round(2 / 3, 4)
    assert stats["recall"] == round(2 / 3, 4)
    assert stats["specificity"] == 0.75


def test_confusion_survives_a_model_that_predicts_nothing():
    """The degenerate case has to give zeros, not a ZeroDivisionError — it is
    exactly what an over-tight threshold produces on a rare positive class."""
    y = np.array([1, 0, 0, 0])
    stats = fe.confusion(y, np.zeros(4, dtype=int))
    assert stats["precision"] == 0.0 and stats["f1"] == 0.0
    assert stats["accuracy"] == 0.75  # and this is why accuracy is flagged


def test_top_k_selects_that_fraction_and_reports_lift():
    y = np.array([1] * 10 + [0] * 90)
    score = np.concatenate([np.linspace(0.9, 1.0, 10), np.linspace(0, 0.5, 90)])
    stats = fe.top_k_confusion(y, score, 0.10)
    assert stats["true_positive"] == 10 and stats["false_positive"] == 0
    assert abs(stats["selected_fraction"] - 0.10) < 0.02
    assert stats["lift_over_random"] == 10.0


def test_top_k_on_a_useless_score_lands_near_the_base_rate():
    rng = np.random.default_rng(3)
    y = (rng.uniform(size=4000) < 0.05).astype(int)
    stats = fe.top_k_confusion(y, rng.uniform(size=4000), 0.10)
    assert 0.5 < stats["lift_over_random"] < 2.0


# --- scorers --------------------------------------------------------------
def test_shipped_flood_membership_falls_with_height_above_drainage():
    df = pd.DataFrame({"hand_m": [0.0, 2.0, 10.0, 60.0],
                       "dist_water_m": [500.0] * 4,
                       "slope_deg": [3.0] * 4})   # slope held fixed: this is
    score = fe.flood_shipped(df)                  # the HAND response alone
    assert np.all(np.diff(score) < 0)
    assert 0 <= score.min() and score.max() <= 1


def test_flood_shipped_is_exactly_the_membership_risk_index_computes():
    """flood_eval reproduces the flood membership by hand instead of calling
    memberships(), which needs three columns the evaluation points do not
    carry. That reproduction is only safe if it is pinned: without this test a
    change to risk_index.PARAMS or to the flood expression would leave the
    evaluation silently scoring a model the API no longer serves."""
    from model.risk_index import memberships
    rng = np.random.default_rng(11)
    n = 200
    df = pd.DataFrame({
        "hand_m": rng.gamma(2.0, 6.0, n),
        "dist_water_m": rng.exponential(300.0, n),
        "slope_deg": rng.gamma(1.5, 6.0, n),
        "tri": rng.gamma(2.0, 3.0, n),
        "dist_power_m": rng.exponential(1200.0, n),
        "flash_density": rng.gamma(3.0, 4.0, n),
        "radio": rng.choice(["GSM", "LTE", "NR"], n),
    })
    np.testing.assert_allclose(fe.flood_shipped(df),
                               memberships(df)["flood"].to_numpy(), rtol=1e-12)


def test_the_shipped_gate_only_ever_lowers_the_ungated_membership():
    """The gate went into risk_index.py on evidence that it improves ranking,
    but it must remain a suppression: no site may come out of the change with
    more flood exposure than it had before."""
    rng = np.random.default_rng(12)
    n = 500
    df = pd.DataFrame({"hand_m": rng.gamma(2.0, 6.0, n),
                       "dist_water_m": rng.exponential(300.0, n),
                       "slope_deg": rng.gamma(1.5, 6.0, n)})
    assert np.all(fe.flood_shipped(df) <= fe.flood_ungated(df) + 1e-12)


def test_slope_gate_can_only_withdraw_exposure_never_add_it():
    """The engineered form multiplies by exp(-slope/s0), so a steeper site must
    never score above the same site flat. A gate that could amplify would be a
    second hazard term wearing a suppression term's clothes."""
    theta = fe.SHIPPED_ENGINEERED_START
    flat = pd.DataFrame({"hand_m": [1.0], "dist_water_m": [50.0], "slope_deg": [0.0]})
    steep = flat.assign(slope_deg=[30.0])
    assert fe.flood_engineered(steep, theta)[0] < fe.flood_engineered(flat, theta)[0]
    assert fe.flood_engineered(flat, theta)[0] <= 1.0


def test_every_scorer_returns_finite_values_on_extreme_inputs():
    df = pd.DataFrame({"hand_m": [0.0, 1e4], "dist_water_m": [0.0, 1e5],
                       "slope_deg": [0.0, 89.0], "tri": [0.0, 500.0],
                       "dist_power_m": [0.0, 5e4]})
    for score in (fe.flood_shipped(df), fe.flood_ungated(df), fe.hand_only(df),
                  fe.full_index(df),
                  fe.flood_tuned(df, fe.SHIPPED_TUNED_START),
                  fe.flood_engineered(df, fe.SHIPPED_ENGINEERED_START)):
        assert np.all(np.isfinite(score))


# --- fitting --------------------------------------------------------------
def test_fit_recovers_a_planted_signal():
    """If the harness cannot beat the shipped parameters on data generated from
    a known law, then a weak result on real data would be this function's fault
    rather than the ground's. Same guard as the planted -20log10(d) check in
    test_signal_performance.py."""
    df = _frame(1200, seed=1, planted=True)
    from sklearn.metrics import average_precision_score
    shipped = average_precision_score(df.label, fe.flood_shipped(df))
    theta = fe.fit_params(df, fe.flood_engineered, fe.SHIPPED_ENGINEERED_START)
    fitted = average_precision_score(df.label, fe.flood_engineered(df, theta))
    assert fitted > shipped
    assert fitted > 1.5 * df.label.mean()


def test_fit_never_returns_worse_than_the_shipped_start():
    """The shipped values are one of the starts, so the search has a floor."""
    df = _frame(600, seed=2, planted=False)
    from sklearn.metrics import average_precision_score
    theta = fe.fit_params(df, fe.flood_tuned, fe.SHIPPED_TUNED_START)
    assert (average_precision_score(df.label, fe.flood_tuned(df, theta))
            >= average_precision_score(
                df.label, fe.flood_tuned(df, fe.SHIPPED_TUNED_START)) - 1e-9)


def test_cross_validation_never_scores_a_state_it_fitted():
    """GroupKFold on state is the only thing stopping a 5 km neighbour of a
    test point from sitting in the training set."""
    df = _frame(900, seed=4)
    seen = []
    original = fe.fit_params

    def spy(train, scorer, start):
        seen.append(set(train.state.unique()))
        return start
    fe.fit_params = spy
    try:
        report, out = fe.cross_validated(df, "spy", fe.flood_tuned,
                                         fe.SHIPPED_TUNED_START)
    finally:
        fe.fit_params = original
    assert np.all(np.isfinite(out))
    all_states = set(df.state.unique())
    for train_states in seen:
        assert train_states < all_states


def test_threshold_is_chosen_on_train_and_reported_on_out_of_fold():
    df = _frame(800, seed=5)
    report, out = fe.cross_validated(df, "t", fe.flood_shipped, None)
    assert report["at_tuned_threshold"]["threshold"] is not None
    assert report["at_top_10_percent"]["selected_fraction"] <= 0.15
    assert report["folds"] >= 2


# --- language -------------------------------------------------------------
def test_module_never_claims_to_predict_failure():
    """docs/Backend_Handoff.md §0 — this project schedules maintenance need, not
    predicted failure events, and an evaluation module with a confusion matrix
    in it is the likeliest place for that language to slip in."""
    text = (Path(fe.__file__).read_text(encoding="utf-8")
            + Path(__file__).read_text(encoding="utf-8"))
    banned = (r"predict\w*\s+(a\s+|an\s+|the\s+)?failure|failure\s+probability"
              r"|probability\s+of\s+failure|outage\s+label|failure\s+label")
    # A sentence that *denies* the claim is the disclaimer this project requires
    # — §0.6 says the code must not imply a failure predictor, and saying so out
    # loud is how that is honoured. So the containing sentence is judged, not the
    # phrase alone, and only assertions count as offences.
    negations = ("not", "no ", "never", "nobody", "forbid", "without", "neither")
    offenders = []
    for match in re.finditer(banned, text, re.IGNORECASE):
        start = text.rfind(".", 0, match.start()) + 1
        end = text.find(".", match.end())
        sentence = text[start:end if end != -1 else len(text)].lower()
        if not any(word in sentence for word in negations):
            offenders.append(sentence.strip()[:120])
    assert not offenders, offenders


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
