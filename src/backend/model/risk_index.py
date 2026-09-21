"""Tower Health Risk Index — unsupervised, physics-based scorer (Phase C).

Not a predictor. Raw factors -> membership curves (C1) -> noisy-OR (C2) with
AHP weights (C3) -> leave-one-out attribution (C4). numpy/pandas only.

See docs/ML_Implementation_Plan.md.
"""

import numpy as np
import pandas as pd

# --- §1 feature table contract -------------------------------------------
# The interface between perception/feature-engineering (A+B) and this module.
SCHEMA = {
    "tower_id": "str", "lon": "float", "lat": "float", "radio": "cat",
    "dist_water_m": "float", "hand_m": "float", "slope_deg": "float",
    "tri": "float", "flash_density": "float", "dist_power_m": "float",
    "age_years": "float|NaN", "exposed_pop": "float",
}


def check_schema(df):
    """Raise if the feature table breaks the §1 contract."""
    missing = [c for c in SCHEMA if c not in df.columns]
    if missing:
        raise ValueError(f"feature table missing columns: {missing}")
    # age_years is the one column allowed to be NaN (A5 is cut first).
    for c in SCHEMA:
        if c != "age_years" and df[c].isna().any():
            raise ValueError(f"column {c} has NaN — no silent defaults allowed")
    return df


# --- C1 membership functions ---------------------------------------------
def logistic(x, x0, k):      return 1 / (1 + np.exp(-k * (x - x0)))
def inv_logistic(x, x0, k):  return 1 / (1 + np.exp(k * (x - x0)))
def exp_decay(x, x0):        return np.exp(-x / x0)
def exp_sat(x, x0):          return 1 - np.exp(-x / x0)

EQUIP = {"GSM": 0.8, "UMTS": 0.6, "LTE": 0.3, "NR": 0.1}

# Editable + auditable: shape params with their physical justification.
PARAMS = {
    "hand_h0": 5.0,     "hand_k": 0.6,    # risk high near drainage level
    "water_d0": 150.0,                    # ingress/scour decays with distance
    "slope_s0": 25.0,   "slope_k": 0.25,  # landslide/access past a threshold
    "flash_q": 0.95,                      # saturate at high regional percentile
    "power_d0": 2000.0,                   # grid dependence + backup strain
    "age_a0": 15.0,     "age_k": 0.3,     # wear-out accelerates with age
    # Water has to stand somewhere. HAND says how far above drainage a site
    # sits and nothing about whether the ground there could hold water, so the
    # ungated membership scored a valley wall and flat ground at the same HAND
    # identically — and charged the wall twice, once here and once as `terrain`.
    # Measured against observed inundation (model/flood_eval.py): 60 deg is the
    # strongest gate that degrades no metric on either label set, lifting
    # average precision x1.60 nationally and x1.45 on a held-out Sentinel-1
    # flood while leaving ROC-AUC unmoved. Stronger gates keep improving
    # average precision and start costing overall ranking; fitting on average
    # precision alone runs away to 0.15 deg — "flat ground only" — which is why
    # this is a dominance-selected value and not the fitted one.
    "flood_slope_s0": 60.0,
}


def memberships(df, params=None):
    """Raw factors -> per-factor failure contribution p in [0,1]."""
    q = {**PARAMS, **(params or {})}
    p = pd.DataFrame(index=df.index)

    p_hand = inv_logistic(df.hand_m, q["hand_h0"], q["hand_k"])
    p_dist = exp_decay(df.dist_water_m, q["water_d0"])
    wet = 1 - (1 - p_hand) * (1 - p_dist)          # noisy-OR of sub-signals
    # Slope gate: suppression only, so it can withdraw exposure but never
    # invent it. See PARAMS["flood_slope_s0"].
    p["flood"] = wet * exp_decay(df.slope_deg, q["flood_slope_s0"])

    tri_rng = df.tri.max() - df.tri.min()
    p["terrain"] = np.maximum(
        logistic(df.slope_deg, q["slope_s0"], q["slope_k"]),
        (df.tri - df.tri.min()) / (tri_rng + 1e-9),
    )
    p["lightning"] = np.minimum(
        df.flash_density / (df.flash_density.quantile(q["flash_q"]) + 1e-9), 1)
    p["equipment"] = df.radio.map(EQUIP).fillna(0.5)
    p["power"] = exp_sat(df.dist_power_m, q["power_d0"])
    if "age_years" in df and df.age_years.notna().any():
        p["age"] = logistic(df.age_years.fillna(df.age_years.median()),
                            q["age_a0"], q["age_k"])
    return p.clip(0, 1)


# --- C2 combination -------------------------------------------------------
def noisy_or(p, w):
    """Risk = 1 - prod(1 - p_i*w_i). Bounded, monotonic, weakest-link."""
    W = np.array([w[c] for c in p.columns])
    return 1 - np.prod(1 - p.values * W, axis=1)


def weighted_sum(p, w):
    """Baseline for comparison only (§D4) — averages away severe factors."""
    W = np.array([w[c] for c in p.columns])
    return p.values @ W / W.sum()


# --- C3 AHP weights -------------------------------------------------------
# Saaty pairwise judgments, order = AHP_FACTORS. Flood dominates; lightning
# least. Consistency ratio is asserted < 0.1 in the tests.
AHP_FACTORS = ["flood", "terrain", "lightning", "equipment", "power"]
AHP_MATRIX = np.array([
    [1,   3,   5,   2,   2  ],   # flood
    [1/3, 1,   2,   1/2, 1/2],   # terrain
    [1/5, 1/2, 1,   1/2, 1/3],   # lightning
    [1/2, 2,   2,   1,   1  ],   # equipment
    [1/2, 2,   3,   1,   1  ],   # power
])
AGE_WEIGHT = 0.5  # ponytail: age is optional (A5); flat prior, not in the AHP


def ahp_weights(M=AHP_MATRIX):
    """Principal eigenvector + Saaty consistency ratio."""
    val, vec = np.linalg.eig(M)
    i = np.argmax(np.real(val))
    w = np.real(vec[:, i])
    w = w / w.sum()
    n, lmax = len(M), np.real(val[i])
    CI = (lmax - n) / (n - 1)
    RI = {3: 0.58, 4: 0.90, 5: 1.12, 6: 1.24}.get(n, 1.12)
    return w, CI / RI


def factor_weights(columns):
    """AHP weights rescaled so max = 1 — noisy-OR w_i is a *max contribution*
    cap, not a share, so a sum-to-1 vector would squash the whole range."""
    w, _ = ahp_weights()
    w = w / w.max()
    d = dict(zip(AHP_FACTORS, w))
    d["age"] = AGE_WEIGHT
    return {c: d[c] for c in columns}


# --- C4 attribution -------------------------------------------------------
def attribution(p, w):
    """Exact additive decomposition of the noisy-OR, normalized to shares.

    Noisy-OR is exactly additive in log-survival space:

        1 - risk = prod(1 - p_i*w_i)
        -log(1 - risk) = sum_i -log(1 - p_i*w_i)

    so each factor's hazard -log(1 - p_i*w_i) is its true additive share of
    the total, with no interaction residual to hide.

    This replaces a leave-one-out drop, which is unusable once any factor
    saturates: with p_flood*w ~ 0.95 the OR is already near 1, so zeroing any
    *other* factor barely moves the output and LOO renormalization pushed ~98%
    of the share onto flood regardless of what the other factors were doing.
    On the Sunway AOI that rendered the whole attribution panel as one bar.
    Flood still leads there (median HAND is 1.1 m — the AOI really is flat and
    low-lying), but at ~91% rather than ~98%, and the remaining factors are
    now separable instead of being rounded to zero.
    """
    full = noisy_or(p, w)
    W = np.array([w[c] for c in p.columns])
    # clip below 1 so a saturated factor yields a large finite hazard, not inf.
    hazard = -np.log(np.clip(1 - p.values * W, 1e-12, None))
    shares = hazard / (hazard.sum(1, keepdims=True) + 1e-12)
    return full, pd.DataFrame(shares, columns=p.columns, index=p.index)


def score(df, params=None):
    """Feature table -> (risk, attribution shares). The whole Phase C path."""
    p = memberships(df, params)
    w = factor_weights(p.columns)
    return attribution(p, w)


def explain(df, risk, shares, i):
    """'Tower X: 0.82 — flood 0.41, power 0.28, ...' (planner-facing output)."""
    parts = shares.iloc[i].sort_values(ascending=False)
    body = ", ".join(f"{c} {v:.2f}" for c, v in parts.items() if v > 0.01)
    return f"{df.tower_id.iloc[i]}: {risk[i]:.2f} — {body}"


# --- synthetic feature table (stands in until A+B land) -------------------
def synthetic_table(n=500, seed=0, with_age=False):
    """§1-conformant fake towers. Lets C+D exist before perception does."""
    rng = np.random.default_rng(seed)
    hand = rng.gamma(2.0, 6.0, n)
    df = pd.DataFrame({
        "tower_id": [f"T{i:04d}" for i in range(n)],
        "lon": rng.uniform(100.0, 101.0, n),
        "lat": rng.uniform(13.0, 14.0, n),
        "radio": rng.choice(list(EQUIP), n, p=[0.15, 0.2, 0.55, 0.1]),
        "hand_m": hand,
        # towers low above drainage tend to sit nearer water
        "dist_water_m": rng.exponential(80.0 + 40.0 * hand, n),
        "slope_deg": rng.gamma(2.0, 6.0, n),
        "tri": rng.gamma(2.0, 3.0, n),
        "flash_density": rng.gamma(3.0, 4.0, n),
        "dist_power_m": rng.exponential(1200.0, n),
        "age_years": rng.uniform(1, 25, n) if with_age else np.nan,
        "exposed_pop": rng.lognormal(6.0, 1.2, n),
    })
    return check_schema(df)


if __name__ == "__main__":
    df = synthetic_table()
    risk, shares = score(df)
    w, cr = ahp_weights()
    print("AHP weights:", dict(zip(AHP_FACTORS, np.round(w, 3))), f"CR={cr:.3f}")
    print(f"risk: mean={risk.mean():.3f} p90={np.quantile(risk, 0.9):.3f}")
    for i in np.argsort(-risk)[:5]:
        print(" ", explain(df, risk, shares, i))
