"""D4 — unit / sanity tests for the risk index.

    python3 src/backend/model/test_risk_index.py     # or: pytest
"""

import numpy as np
import pandas as pd

from risk_index import (PARAMS, ahp_weights, check_schema, exp_decay,
                        factor_weights, inv_logistic, memberships, noisy_or,
                        score, synthetic_table, weighted_sum)

FACTORS = ["flood", "terrain", "lightning", "equipment", "power"]


def _p(vals):
    return pd.DataFrame([vals], columns=FACTORS)


def test_bounds():
    """All p=0 => Risk 0; p=1 with w=1 => Risk 1."""
    w = {c: 1.0 for c in FACTORS}
    assert noisy_or(_p([0.0] * 5), w)[0] == 0.0
    assert noisy_or(_p([1.0, 0, 0, 0, 0]), w)[0] == 1.0


def test_monotonic_in_p():
    """Raising any hazard never lowers Risk (property test)."""
    rng = np.random.default_rng(0)
    w = factor_weights(FACTORS)
    for _ in range(200):
        p = pd.DataFrame(rng.random((1, 5)), columns=FACTORS)
        j = rng.integers(5)
        q = p.copy()
        q.iloc[0, j] = min(1.0, p.iloc[0, j] + rng.random() * (1 - p.iloc[0, j]))
        assert noisy_or(q, w)[0] >= noisy_or(p, w)[0] - 1e-12


def test_monotonic_in_raw_hazard():
    """Lower HAND / nearer water / farther from power => never less risk.

    Slope is deliberately NOT in this list any more. It used to be, on the
    reasoning that every raw factor is a hazard so worsening one cannot lower
    the score. That reasoning fails for slope, because slope plays two opposite
    roles: it raises `terrain` (landslide, access) and lowers `flood`, since
    water cannot stand on a hillside. The old ungated membership scored a
    valley wall and flat ground at the same HAND identically and so charged the
    wall twice — once as terrain, once as flood. See PARAMS["flood_slope_s0"]
    and model/flood_eval.py for the measurement that motivated the gate, and
    test_slope_raises_terrain_and_lowers_flood below for what replaces this.
    """
    df = synthetic_table(n=200, seed=3)
    base = score(df)[0]
    for col, worse in [("hand_m", -0.5), ("dist_water_m", -0.5),
                       ("dist_power_m", +0.5)]:
        d = df.copy()
        d[col] = d[col] * (1 + worse)
        assert (score(d)[0] >= base - 1e-9).all(), col


def test_slope_raises_terrain_and_lowers_flood():
    """The two roles slope plays, pinned separately.

    The gate is suppression only, so flood is non-increasing in slope and can
    never exceed the ungated value; terrain remains non-decreasing. Between
    them they say a steep site is a terrain problem, not a flood one.
    """
    df = synthetic_table(n=200, seed=3)
    flatter = df.assign(slope_deg=df.slope_deg * 0.5)
    steeper = df.assign(slope_deg=df.slope_deg * 1.5)
    assert (memberships(steeper)["flood"] <= memberships(flatter)["flood"] + 1e-12).all()
    assert (memberships(steeper)["terrain"] >= memberships(flatter)["terrain"] - 1e-12).all()
    # And on perfectly flat ground the gate is inert, so nothing about the
    # pre-existing flood behaviour changed for the ground that actually floods.
    flat = df.assign(slope_deg=0.0)
    ungated = 1 - (1 - inv_logistic(flat.hand_m, PARAMS["hand_h0"], PARAMS["hand_k"])) * (
        1 - exp_decay(flat.dist_water_m, PARAMS["water_d0"]))
    np.testing.assert_allclose(memberships(flat)["flood"], ungated, rtol=1e-12)


def test_face_validity():
    """A hand-placed flood-prone tower ranks top; a safe one ranks bottom."""
    df = synthetic_table(n=200, seed=4)
    # Flat, not steep. A 35 deg slope used to stand in for "hazardous" here,
    # but slope now suppresses flood, so pairing it with hand_m = 0.2 described
    # a site that is 20 cm above drainage on a hillside — a contradiction, not
    # a flood-prone tower. The intent of the fixture is the flood-prone tower.
    df.loc[0, ["hand_m", "dist_water_m", "slope_deg", "dist_power_m"]] = \
        [0.2, 5.0, 1.0, 8000.0]
    df.loc[1, ["hand_m", "dist_water_m", "slope_deg", "dist_power_m"]] = \
        [60.0, 9000.0, 1.0, 50.0]
    df.loc[1, "flash_density"] = df.flash_density.min()
    df.loc[1, "radio"] = "NR"
    risk = score(df)[0]
    rank = (-risk).argsort().argsort()          # 0 = riskiest
    assert rank[0] < 0.05 * len(df)
    assert rank[1] > 0.90 * len(df)


def test_noisy_or_beats_weighted_sum_on_severe_single_factor():
    """One severe factor must dominate — weighted-sum averages it away."""
    df = synthetic_table(n=200, seed=5)
    # Flat as well as low and close: "certain flood zone" is a statement about
    # ground that can hold water, and the slope gate is what makes that
    # explicit rather than assumed.
    df.loc[0, ["hand_m", "dist_water_m", "slope_deg"]] = [0.05, 1.0, 0.5]
    p = memberships(df)
    w = factor_weights(p.columns)
    n_rank = (-noisy_or(p, w)).argsort().argsort()[0]
    s_rank = (-weighted_sum(p, w)).argsort().argsort()[0]
    assert p.loc[0, "flood"] > 0.99
    assert n_rank < 0.02 * len(df) <= s_rank      # sum buries it, noisy-OR flags


def test_attribution_shares():
    """Shares are non-negative and sum to 1 per tower."""
    risk, shares = score(synthetic_table(n=100, seed=6))
    assert (shares.values >= -1e-9).all()
    assert np.allclose(shares.sum(1), 1.0, atol=1e-6)
    assert ((risk >= 0) & (risk <= 1)).all()


def test_ahp_consistency():
    """Saaty CR must be < 0.1 or the judgments are incoherent."""
    w, cr = ahp_weights()
    assert cr < 0.1, cr
    assert np.isclose(w.sum(), 1.0) and (w > 0).all()


def test_schema_contract():
    """No silent zeros: missing column or stray NaN must raise."""
    df = synthetic_table(n=10)
    for bad in [df.drop(columns=["hand_m"]), df.assign(hand_m=np.nan)]:
        try:
            check_schema(bad)
        except ValueError:
            continue
        raise AssertionError("check_schema accepted a broken feature table")
    check_schema(synthetic_table(n=10, with_age=True))   # age populated is fine


def test_age_optional():
    """Age absent-as-NaN drops the factor instead of faking it."""
    assert "age" not in memberships(synthetic_table(n=20)).columns
    assert "age" in memberships(synthetic_table(n=20, with_age=True)).columns


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
