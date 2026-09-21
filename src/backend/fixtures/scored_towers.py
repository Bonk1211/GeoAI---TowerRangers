"""Mock scored-tower fixture — stands in for the ML side's /score output (Backend_Handoff §1).

Deterministic (seeded) so downstream scheduler tests are stable. Swap for the
real ML endpoint when it lands; nothing downstream should need to change shape.

The fixture is a synthetic FEATURE TABLE plus the real scorer, not a table of
finished scores. It used to draw `risk` directly per decision band and sample
attribution shares from a Dirichlet, which made it unscoreable: POST /score
had nothing to recompute against, so on the USE_FIXTURE branch the Weights
sliders moved and nothing changed. Now `synthetic_feature_table()` emits a
§1-conformant feature table over the Sunway AOI and `score_feature_table()`
pushes it through exactly the pipeline the real adapter uses —
risk_index.memberships() -> attribution() with AHP weights — so weight
overrides are authoritative here for the same reason they are on the real
branch: they change the actual computation, not a re-normalisation of stored
shares. /towers and /score agree by construction because both describe the
same feature table.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from model.risk_index import EQUIP, attribution, check_schema, factor_weights, memberships
from scheduler.urgency import urgency_days as _shared_urgency_days

RNG_SEED = 42

RADIOS = ["GSM", "UMTS", "LTE", "NR"]
RADIO_WEIGHTS = [0.10, 0.15, 0.55, 0.20]

# The §1 factor set. risk_index.memberships() is the producer; listed here so
# a record's `attribution` keys are checkable against the contract.
FACTORS = ["flood", "power", "terrain", "equipment", "lightning"]

# Selangor (Sunway pilot) AOI bounding box (the scored reference region; Frontend_Build_Plan §6).
AOI_LON_RANGE = (101.55, 101.68)
AOI_LAT_RANGE = (3.00, 3.14)
AOI_TERRITORY = "Selangor"

# Not in Backend_Handoff §1's frozen shape — but the optimizer's territory
# constraint (§4) needs *some* territory field to filter on, and it is known
# from which AOI was scored, not computed risk. Attached here; if the real
# ML endpoint lands without it, derive it from AOI metadata at the join, not
# by reimplementing scoring.

N_TOWERS = 500
MAINTAIN_FRACTION = 0.07
WATCH_FRACTION = 0.17  # -> ok is the remainder

# Half-width of the synthetic risk_lo/risk_hi interval. Fixture uncertainty,
# not a re-derived stability spread: the real adapter's interval comes from
# 500 perturbed-weight noisy-OR draws (adapter/ml_source.py), which is far too
# much work to redo per /score request for a mock population. Drawn from the
# fixture seed so it is stable run to run.
#
# Narrower than the (0.03, 0.09) the drawn-risk fixture used, because risk is
# now packed into a narrower live range: at the old width 21% of towers came
# out `borderline`, against 8% before and 8% on the real adapter. This width
# restores ~8.6%, so the badge keeps meaning "check this one by hand".
RISK_INTERVAL_HALF_WIDTH = (0.01, 0.03)

# --- synthetic feature-table shape ----------------------------------------
# Distribution parameters for the §1 feature columns. Started from
# risk_index.synthetic_table()'s defaults and retuned on three levers so the
# derived risk keeps a usable dynamic range across [0.1, 1.0] instead of
# bunching in the top third:
#   - hand_m / dist_water_m up   -> fewer towers sitting in the flood membership's
#                                   saturated region
#   - flash_density more skewed  -> lightning is normalised against its own p95,
#                                   so only skew (not scale) moves that membership
#   - dist_power_m down          -> exp_sat() reads distance-from-grid as risk
# Terrain's TRI term is min-max normalised within the population, so its shape
# is likewise only movable by skew. Tuned against the decision mix and the
# dominant-factor spread, not against any single tower.
FEATURE_PARAMS = {
    "hand_shape": 2.5, "hand_scale": 7.0,       # height above nearest drainage, m
    "water_base_m": 150.0, "water_per_hand_m": 50.0,
    "slope_shape": 2.0, "slope_scale": 4.0,     # degrees
    "tri_shape": 1.3, "tri_scale": 3.0,         # terrain ruggedness index
    "flash_shape": 1.5, "flash_scale": 4.0,     # flashes/km2/yr
    "power_dist_m": 800.0,                      # distance to grid, m
    "pop_mu": 6.0, "pop_sigma": 1.2,            # exposed population, lognormal
}


def synthetic_feature_table(n: int = N_TOWERS, seed: int = RNG_SEED) -> pd.DataFrame:
    """§1-conformant synthetic feature table over the Sunway AOI.

    Deliberately a fixture-local builder rather than a call to
    risk_index.synthetic_table(): every identity column that function emits
    (tower_id T0000+, lon/lat over a Thai bbox, its own radio mix) has to be
    replaced for this AOI anyway, and the physical columns are retuned per
    FEATURE_PARAMS. Same schema, same check_schema() gate, so the scorer
    cannot tell the two apart.
    """
    q = FEATURE_PARAMS
    rng = np.random.default_rng(seed)

    hand = rng.gamma(q["hand_shape"], q["hand_scale"], n)
    df = pd.DataFrame(
        {
            "tower_id": [f"MY_{1000 + i}" for i in range(n)],
            "lon": np.round(rng.uniform(*AOI_LON_RANGE, size=n), 5),
            "lat": np.round(rng.uniform(*AOI_LAT_RANGE, size=n), 5),
            "radio": rng.choice(RADIOS, size=n, p=RADIO_WEIGHTS),
            "hand_m": hand,
            # towers low above drainage tend to sit nearer water
            "dist_water_m": rng.exponential(q["water_base_m"] + q["water_per_hand_m"] * hand, n),
            "slope_deg": rng.gamma(q["slope_shape"], q["slope_scale"], n),
            "tri": rng.gamma(q["tri_shape"], q["tri_scale"], n),
            "flash_density": rng.gamma(q["flash_shape"], q["flash_scale"], n),
            "dist_power_m": rng.exponential(q["power_dist_m"], n),
            "age_years": np.nan,  # A5 is cut first; the fixture does not fake it
            "exposed_pop": rng.lognormal(q["pop_mu"], q["pop_sigma"], n),
        }
    )
    assert set(RADIOS) <= set(EQUIP), "fixture radio mix must be scoreable by risk_index.EQUIP"
    return check_schema(df)


_urgency_days = _shared_urgency_days


def _resolve_dominant(shares_row: dict[str, float]) -> str:
    """Deterministic argmax; ties broken by a fixed factor priority order so
    the same input always resolves the same way (Backend_Handoff §1)."""
    max_share = max(shares_row.values())
    tied = [f for f in shares_row if abs(shares_row[f] - max_share) < 1e-9]
    if len(tied) == 1:
        return tied[0]
    # fixed priority: faster-acting mechanisms win ties
    priority = ["lightning", "flood", "power", "terrain", "equipment"]
    for f in priority:
        if f in tied:
            return f
    return sorted(tied)[0]


def _band_cuts(risk: np.ndarray) -> tuple[float, float]:
    """Capacity-anchored decision cut points, exactly as the real adapter cuts
    them (adapter/ml_source.py::_band_edges): top MAINTAIN_FRACTION maintain,
    next WATCH_FRACTION watch, rest ok.

    Quantiles, not the fixed 0.70/0.40 the old drawn-risk fixture used. Risk
    is now the noisy-OR physical index — a different quantity from the number
    that fixture drew — so a fixed cut would not land anywhere near the same
    mix, and the mix is what the scheduler tests depend on. Cutting by
    fraction pins the mix exactly, under any weight overrides.
    """
    maintain_cut = float(np.quantile(risk, 1.0 - MAINTAIN_FRACTION))
    watch_cut = float(np.quantile(risk, 1.0 - MAINTAIN_FRACTION - WATCH_FRACTION))
    return maintain_cut, watch_cut


def score_feature_table(
    feat: pd.DataFrame,
    weight_overrides: dict[str, float] | None = None,
    seed: int = RNG_SEED,
) -> pd.DataFrame:
    """Feature table -> §1 scored-tower records, through the real scorer.

    Same three steps as adapter/ml_source.py::score_with_weights():
    memberships() -> AHP factor weights, overridden by the caller ->
    attribution(). Unknown override keys are ignored rather than injected, so
    a stray slider name cannot add a factor the model has no membership for.
    """
    p = memberships(feat)
    weights = dict(factor_weights(p.columns))
    if weight_overrides:
        weights.update({k: v for k, v in weight_overrides.items() if k in weights})

    risk, shares = attribution(p, weights)
    risk = np.asarray(risk, dtype=float)
    maintain_cut, watch_cut = _band_cuts(risk)

    rng = np.random.default_rng(seed)
    half_width = rng.uniform(*RISK_INTERVAL_HALF_WIDTH, size=len(feat))
    risk_lo = np.clip(risk - half_width, 0.0, 1.0)
    risk_hi = np.clip(risk + half_width, 0.0, 1.0)

    # Materialise once instead of .iloc-ing per row: this runs on every
    # /towers and /score request on the fixture branch, and per-row .iloc on a
    # 500-row frame is most of the wall clock if you let it.
    feat = feat.reset_index(drop=True)
    factors = list(shares.columns)
    share_rows = shares.reset_index(drop=True).to_dict(orient="records")
    tower_ids = feat["tower_id"].tolist()
    lons, lats = feat["lon"].tolist(), feat["lat"].tolist()
    radios, hands = feat["radio"].tolist(), feat["hand_m"].tolist()

    rows = []
    for i in range(len(feat)):
        shares_row = {f: float(share_rows[i][f]) for f in factors}
        risk_value = float(risk[i])
        lo, hi = float(risk_lo[i]), float(risk_hi[i])
        if risk_value >= maintain_cut:
            decision = "maintain"
        elif risk_value >= watch_cut:
            decision = "watch"
        else:
            decision = "ok"
        rows.append(
            {
                "tower_id": tower_ids[i],
                "lon": round(float(lons[i]), 5),
                "lat": round(float(lats[i]), 5),
                "territory": AOI_TERRITORY,
                "radio": radios[i],
                "risk": round(risk_value, 4),
                "risk_lo": round(lo, 4),
                "risk_hi": round(hi, 4),
                "decision": decision,
                # the [lo, hi] interval straddles a band edge, so the band
                # assignment is not robust to that uncertainty
                "borderline": bool(any(lo <= edge <= hi for edge in (maintain_cut, watch_cut))),
                "dominant_factor": _resolve_dominant(shares_row),
                "urgency_days": _urgency_days(shares_row),
                "attribution": {f: round(shares_row[f], 4) for f in factors},
                # additive — the terrain input behind p_flood's HAND term, the
                # same field the real adapter carries so the map's inundation
                # layer does not look intermittent across the two branches.
                "hand_m": round(float(hands[i]), 3),
                # hazard=None deliberately: the offline fixture must stay
                # deterministic, and a live forecast would make it drift
                # between runs. `weather: None` says "no forecast applied",
                # which is the truth here rather than a fabricated quiet one.
                "weather": None,
                # No telemetry behind a mock record, so there is nothing to
                # blend and `priority` is the risk itself — never a fabricated
                # ordering. scheduler.optimize.priority() would fall back to
                # `risk` anyway; stating it keeps the fixture and the real
                # record the same shape, which is the point of the fixture.
                "priority": round(risk_value, 4),
                "condition": None,
                "novelty": None,
                "flags": [],
                "escalated": False,
            }
        )

    return pd.DataFrame(rows)


def generate_scored_towers(
    n: int = N_TOWERS,
    seed: int = RNG_SEED,
    weight_overrides: dict[str, float] | None = None,
) -> pd.DataFrame:
    """The fixture population at baseline AHP weights (or under overrides)."""
    return score_feature_table(
        synthetic_feature_table(n=n, seed=seed), weight_overrides=weight_overrides, seed=seed
    )


def scored_towers_records(
    n: int = N_TOWERS,
    seed: int = RNG_SEED,
    weight_overrides: dict[str, float] | None = None,
) -> list[dict]:
    """Convenience: same data as JSON-ready dicts, matching §1's record shape."""
    return generate_scored_towers(
        n=n, seed=seed, weight_overrides=weight_overrides
    ).to_dict(orient="records")


def score_fixture_with_weights(
    weight_overrides: dict[str, float],
    bbox: tuple[float, float, float, float] | None = None,
    n: int = N_TOWERS,
    seed: int = RNG_SEED,
) -> list[dict]:
    """POST /score on the USE_FIXTURE branch — the mirror of
    adapter/ml_source.py::score_with_weights().

    When `bbox` is present the feature table is filtered *before* scoring, so
    memberships, risk and the capacity-anchored bands all describe the
    requested AOI — same ordering as the real adapter, and same consequence:
    two of the memberships (terrain's TRI term, lightning's p95) and the band
    cuts are population-relative, so a scoped request is scored against its
    own scope. An AOI containing no towers returns an empty list.
    """
    feat = synthetic_feature_table(n=n, seed=seed)
    if bbox is not None:
        west, south, east, north = bbox
        feat = feat[feat["lon"].between(west, east) & feat["lat"].between(south, north)]
        if feat.empty:
            return []
    return score_feature_table(feat, weight_overrides=weight_overrides, seed=seed).to_dict(
        orient="records"
    )


if __name__ == "__main__":
    df = generate_scored_towers()
    print(df["decision"].value_counts(normalize=True))
    print(df["dominant_factor"].value_counts())
    print(df["risk"].describe())
    print(df.head(3).to_dict(orient="records"))
