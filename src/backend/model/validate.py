"""Phase D — label-free validation of the risk index.

No failure labels exist, so this proves *robustness, not accuracy*: the
ranking is not an artefact of the arbitrary choices (weights, curve knots,
factor set).

    python3 src/backend/model/validate.py    # prints D1-D3, writes D5 figure

See docs/ML_Implementation_Plan.md §6.
"""

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from risk_index import (AGE_WEIGHT, AHP_FACTORS, PARAMS, ahp_weights,
                        memberships, noisy_or, synthetic_table)

FIGURE = "data/rank_stability.png"


def _weights(w_shares, columns):
    """Same max-rescale as risk_index.factor_weights, for arbitrary shares."""
    d = dict(zip(AHP_FACTORS, w_shares / w_shares.max()))
    d["age"] = AGE_WEIGHT
    return {c: d[c] for c in columns}


def top_decile_retention(base, other):
    """Share of baseline top-10% towers still in top-10% under `other`."""
    k = max(1, int(0.1 * len(base)))
    a = set(np.argsort(-base)[:k])
    b = set(np.argsort(-other)[:k])
    return len(a & b) / k


# --- D1 Monte-Carlo weight rank-stability (primary metric) ---------------
def d1_weight_stability(df, n=500, sigma=0.25, seed=1):
    rng = np.random.default_rng(seed)
    p = memberships(df)
    w0, _ = ahp_weights()
    base = noisy_or(p, _weights(w0, p.columns))

    rho, ret = [], []
    for _ in range(n):
        w = w0 * rng.lognormal(0.0, sigma, len(w0))
        r = noisy_or(p, _weights(w / w.sum(), p.columns))
        rho.append(spearmanr(base, r).statistic)
        ret.append(top_decile_retention(base, r))
    return np.array(rho), np.array(ret)


# --- D2 membership-parameter sensitivity ---------------------------------
KNOTS = ["hand_h0", "water_d0", "slope_s0", "power_d0", "age_a0"]


def d2_param_stability(df, n=200, frac=0.30, seed=2):
    rng = np.random.default_rng(seed)
    p0 = memberships(df)
    w = _weights(ahp_weights()[0], p0.columns)
    base = noisy_or(p0, w)

    rho, ret = [], []
    for _ in range(n):
        q = {k: PARAMS[k] * rng.uniform(1 - frac, 1 + frac) for k in KNOTS}
        r = noisy_or(memberships(df, q), w)
        rho.append(spearmanr(base, r).statistic)
        ret.append(top_decile_retention(base, r))
    return np.array(rho), np.array(ret)


# --- D3 ablation ----------------------------------------------------------
def d3_ablation(df):
    """Drop each factor; a factor that shifts nothing is dead weight."""
    p = memberships(df)
    w = _weights(ahp_weights()[0], p.columns)
    base = noisy_or(p, w)
    rows = []
    for c in p.columns:
        keep = [x for x in p.columns if x != c]
        r = noisy_or(p[keep], {k: w[k] for k in keep})
        rows.append({"dropped": c,
                     "spearman": spearmanr(base, r).statistic,
                     "top_decile_retention": top_decile_retention(base, r)})
    return pd.DataFrame(rows).sort_values("spearman")


# --- D5 deliverable figure ------------------------------------------------
def d5_figure(d1, d2, path=FIGURE):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    (r1, t1), (r2, t2) = d1, d2
    fig, ax = plt.subplots(1, 2, figsize=(9, 4))
    ax[0].violinplot([r1, r2], showmedians=True)
    ax[0].set_xticks([1, 2], ["weights ±lognormal", "curve knots ±30%"])
    ax[0].set_ylabel("Spearman ρ vs baseline ranking")
    ax[0].set_title("Rank stability under perturbation")
    ax[0].axhline(0.9, ls="--", c="grey", lw=1)

    ax[1].bar(["weights", "knots"], [t1.mean(), t2.mean()],
              yerr=[t1.std(), t2.std()], color="#4c72b0", capsize=6)
    ax[1].set_ylim(0, 1)
    ax[1].set_ylabel("top-decile retention")
    ax[1].set_title("Top-risk towers stay top-risk")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    return path


if __name__ == "__main__":
    df = synthetic_table(n=500)
    r1, t1 = d1_weight_stability(df)
    r2, t2 = d2_param_stability(df)
    print(f"D1 weights : rho median={np.median(r1):.3f} "
          f"[{np.quantile(r1, .05):.3f}, {np.quantile(r1, .95):.3f}]  "
          f"top-decile retention={t1.mean():.1%}")
    print(f"D2 knots   : rho median={np.median(r2):.3f} "
          f"[{np.quantile(r2, .05):.3f}, {np.quantile(r2, .95):.3f}]  "
          f"top-decile retention={t2.mean():.1%}")
    print("D3 ablation:")
    print(d3_ablation(df).to_string(index=False))
    print("D5 figure  :", d5_figure((r1, t1), (r2, t2)))
