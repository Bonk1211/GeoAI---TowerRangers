"""Adapter: scores the real Sunway feature table onto the frozen frontend
record shape (Backend_Handoff §1, Integration_Gaps §5.1).

The scheduler backend serves the model routes (/towers, /score, /stability) —
one base URL for the frontend. This module owns the feature-table -> contract
mapping; nothing under src/backend/model/ is modified here, only called.

ONE input:
  - ../../data/malaysia/tower_feature_table.csv       real features, 1,164 towers
    (falls back to data/pilot_sunway/tower_feature_table.csv, 132 towers)

`risk` is served by model.maintenance_need when a trained artifact exists
(data/malaysia/maintenance_model.txt), falling back to the noisy-OR physical
index from model/risk_index.py when it does not — a checkout with no trained
model still boots. This is the SECOND supervised model this file has served.
The first, `maintenance_classifier`, was withdrawn: its label was a quantile
cut on technical_risk, itself a deterministic function of the same six
features the model was given, so its 0.974 AUC measured inversion of
arithmetic rather than prediction — see CLAUDE.md for the full account. This
one is different in kind, not just retrained: its label comes from an
independent simulated process (data/prepare_maintenance_records.py) that
never imports risk_index, and its report carries a measured oracle ceiling
(model/maintenance_need.py's docstring) so a near-perfect score would be
caught as a leak rather than presented as success. It is also explicitly
SYNTHETIC — no real maintenance history was available — and every artifact it
produces says so.

/score (score_with_weights, below) still serves the noisy-OR index under
caller-supplied AHP weight overrides, unconditionally — a trained model has no
per-factor weight to override, so "recompute under adjusted weights" has no
equivalent for it. This means /towers and /score can now disagree even when
the override weights equal the AHP baseline, which is a real product
inconsistency and not an oversight: reconciling it needs a decision about what
the Weights page means once the served score is learned rather than asserted,
which is outside this file's scope to make unilaterally.

Cached in memory at import — static per process, matching the "cache once"
guidance for the 500-draw stability computation (step 3b).
"""
from __future__ import annotations

from pathlib import Path
import logging
from threading import Lock

import numpy as np
import pandas as pd

from flood.forecast import sample_weather_hazard
from model import feedback, maintenance_need
from model.change import change_scores, load_change
from model.ensemble import blend_priority
from model.novelty import condition_scores
from model.novelty import fit as fit_novelty
from model.novelty import novelty_scores
from model.profiler import BehavioralProfiler
from model.risk_index import AGE_WEIGHT, AHP_FACTORS, ahp_weights, attribution, memberships, noisy_or
from scheduler.config_loader import load_policy
from scheduler.urgency import urgency_days as _urgency_days

# --- three-band decision cut points (step 4b) ------------------------------
# Capacity-anchored, not hardcoded against an arbitrary risk value. This AOI is
# flat and low-lying (median HAND 1.1 m) so the flood membership saturates and
# the index piles up near the top of its range — a fixed 0.7/0.4 split would put
# almost everything in one band. Quantiles are taken over the index's actual
# distribution, so the cut adapts to whatever shape it has.
MAINTAIN_QUANTILE = 0.90   # top ~10% -> maintain (one inspection cycle at current crew capacity)
WATCH_QUANTILE = 0.70      # next ~20% -> watch (visible to planners, not dispatched)

# --- D1 weight-stability re-implementation (step 4c) -----------------------
# model/validate.py's d1_weight_stability runs the same 500 perturbed-weight
# draws but discards per-tower spread, returning only aggregate rank-stability
# metrics (rho, top-decile retention). We need the per-tower risk spread
# itself for risk_lo/risk_hi, so this reimplements the same draw loop against
# model.risk_index primitives rather than editing model/validate.py (ML-owned).
N_STABILITY_DRAWS = 500
STABILITY_SIGMA = 0.25
STABILITY_SEED = 1

_THIS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _THIS_DIR.parent
_REPO_ROOT = _BACKEND_DIR.parent.parent

# National first, pilot as the fallback. Both satisfy the same §1 contract, so
# nothing downstream changes shape — only how many rows arrive and how far apart
# they are. The pilot table stays the fallback rather than being deleted: it is
# the AOI every contrast figure and every 3D flood-volume asset was built
# against, and a checkout without data/malaysia still has to boot.
NATIONAL_TABLE_CSV = _REPO_ROOT / "data" / "malaysia" / "tower_feature_table.csv"
PILOT_TABLE_CSV = _REPO_ROOT / "data" / "pilot_sunway" / "tower_feature_table.csv"
FEATURE_TABLE_CSV = (
    NATIONAL_TABLE_CSV if NATIONAL_TABLE_CSV.exists() else PILOT_TABLE_CSV
)

# The pilot table has no `state` column and one known AOI, so its towers keep
# the constant. The national table carries a state per tower and this becomes a
# fallback for the handful whose coordinates land outside every ADM1 outer ring
# (offshore platforms and border noise — 4 of 1,164).
TERRITORY = "Selangor"
UNASSIGNED_TERRITORY = "unassigned"

# geoBoundaries ADM1 spells it Malacca; config/crews.json rosters Melaka. The
# scheduler matches crews to work by exact territory string, so an unmapped
# spelling would not throw — it would silently leave every Malaccan tower
# unschedulable, which is the kind of failure that shows up as an empty column
# in the UI and nowhere else.
TERRITORY_ALIASES = {"Malacca": "Melaka"}


def _territory_for(row) -> str:
    state = row.get("state") if hasattr(row, "get") else None
    if not isinstance(state, str) or not state.strip():
        return TERRITORY if FEATURE_TABLE_CSV == PILOT_TABLE_CSV else UNASSIGNED_TERRITORY
    return TERRITORY_ALIASES.get(state, state)


def _weights_for(w_shares: np.ndarray, columns) -> dict:
    """Same max-rescale as risk_index.factor_weights, for arbitrary shares
    (mirrors model/validate.py's _weights helper, reimplemented here since
    that module is not import-safe as a package — see module docstring)."""
    d = dict(zip(AHP_FACTORS, w_shares / w_shares.max()))
    d["age"] = AGE_WEIGHT
    return {c: d[c] for c in columns}


def _load_feature_table() -> pd.DataFrame:
    if not FEATURE_TABLE_CSV.exists():
        raise FileNotFoundError(
            f"ML feature table not found at {FEATURE_TABLE_CSV}. Adapter resolves "
            "this path from __file__, not the process CWD — confirm the file lives "
            "at data/pilot_sunway/tower_feature_table.csv under the repo root."
        )
    return pd.read_csv(FEATURE_TABLE_CSV)


def _compute_attribution(feat: pd.DataFrame) -> tuple[np.ndarray, pd.DataFrame]:
    """Model.maintenance_need when a trained artifact exists; the noisy-OR
    physical index otherwise. Both return (risk, shares) with the same shape —
    shares summing to 1 across the same factor keys minus `lightning` — so this
    is one branch, not two implementations to keep in sync.

    The model path needs `land_features.csv` (EVI, soil, GSW occurrence) joined
    onto the feature table; maintenance_need.build_matrix() does that join
    itself when the caller's frame lacks those columns, so nothing extra is
    loaded here.

    Falling back to the index (rather than raising) when no model is trained
    is the same "checkout still boots" contract the national/pilot table
    fallback above already keeps.
    """
    booster = maintenance_need.load_booster()
    if booster is not None:
        risk, shares = maintenance_need.score(feat, booster=booster)
        return risk, shares

    # Flood is expected to dominate on this AOI under the index (mean share
    # ~0.92, most towers >0.9) — that is the correct, honest rendering of a
    # flat urban AOI on today's hand_h0 parameter, not a bug to compensate for.
    p = memberships(feat)
    p = p.drop(columns=["lightning"], errors="ignore")  # 100% null on this AOI
    w0, _ = ahp_weights()
    weights = _weights_for(w0, p.columns)
    risk, shares = attribution(p, weights)
    return risk, shares


def _compute_stability_draws(feat: pd.DataFrame) -> np.ndarray | None:
    """Per-tower risk under N_STABILITY_DRAWS perturbed-weight draws — shape
    (N_STABILITY_DRAWS, n_towers) under the index, or None under the model.

    Perturbing AHP weights is meaningless once AHP is not what produces
    `risk`: model.maintenance_need has no per-factor weight to jitter. The
    honest alternative — bootstrap the training set and refit ~500 boosters —
    is a training-time operation (needs maintenance_labels.csv, the full join,
    a real fit loop) and belongs in notebooks/maintenance_need.ipynb under the
    same module/notebook split the training code already follows, not
    re-implemented here on the request path. So the model path returns None
    and `/stability` reports absence, which is the honest answer: a stale rho
    computed against the index while the UI displays the model's score would
    be a calm number that means nothing, the same class of lie the
    zeroed-struct offline fallback bug was (see CLAUDE.md).

    Under the index this is unchanged: the same perturbation model as
    model/validate.py's d1_weight_stability (lognormal jitter on the AHP
    weights), reimplemented here to retain the per-tower spread that function
    discards (step 4c).
    """
    if maintenance_need.load_booster() is not None:
        return None

    rng = np.random.default_rng(STABILITY_SEED)
    p = memberships(feat)
    p = p.drop(columns=["lightning"], errors="ignore")
    w0, _ = ahp_weights()

    draws = np.empty((N_STABILITY_DRAWS, len(feat)))
    for i in range(N_STABILITY_DRAWS):
        w = w0 * rng.lognormal(0.0, STABILITY_SIGMA, len(w0))
        draws[i] = noisy_or(p, _weights_for(w / w.sum(), p.columns))
    return draws


def _rank_pct(values: np.ndarray) -> np.ndarray:
    """Percentile rank, matching ensemble.blend_priority's own scale so the two
    can be banded against the same cut points."""
    return pd.Series(np.asarray(values, dtype=float)).rank(pct=True).to_numpy()


def _band_edges(risk: np.ndarray) -> tuple[float, float]:
    maintain_cut = float(np.quantile(risk, MAINTAIN_QUANTILE))
    watch_cut = float(np.quantile(risk, WATCH_QUANTILE))
    return maintain_cut, watch_cut


def _three_band_decision(risk_value: float, maintain_cut: float, watch_cut: float) -> str:
    """DERIVED — three bands by quantile on the index, capacity-anchored to
    roughly one inspection cycle (top ~10%) plus a planner-visible watch tier
    (next ~20%).

    Pure quantiles. This used to take the withdrawn classifier's own
    MAINTENANCE call as an override, on the reasoning that banding should add a
    middle state rather than overrule the ML team. With that classifier gone
    there is no second opinion to preserve, and an override argument that is
    always empty is worse than none.
    """
    if risk_value >= maintain_cut:
        return "maintain"
    if risk_value >= watch_cut:
        return "watch"
    return "ok"


class _AdapterCache:
    """Computed once at import; static per process (step 3b caching note —
    /stability's 500 noisy-OR draws must not run per request)."""

    def __init__(self) -> None:
        feat = _load_feature_table()

        risk_values, shares = _compute_attribution(feat)
        draws = _compute_stability_draws(feat)

        if draws is not None:
            # Direct quantiles. `risk` and the draws are the same quantity on
            # the same scale, so the perturbation interval brackets it by
            # construction. This used to apply a *ratio* correction, because
            # risk was a model probability (p50~0.12) while the draws were the
            # index (p50~0.95) and a raw interval would not have contained the
            # displayed value. That scaffolding went with the withdrawn
            # classifier and must not be reintroduced here.
            risk_lo = np.minimum(np.quantile(draws, 0.05, axis=0), risk_values)
            risk_hi = np.maximum(np.quantile(draws, 0.95, axis=0), risk_values)
        else:
            # No AHP weights to perturb under the supervised model (see
            # _compute_stability_draws). risk_lo/risk_hi collapse to risk
            # itself rather than inventing an interval — a degenerate [risk,
            # risk] band is honest about "we have not measured uncertainty
            # here"; a fabricated spread would not be.
            risk_lo = risk_values.copy()
            risk_hi = risk_values.copy()

        # One source, so there is no join to reorder and no realignment to
        # protect: shares, draws and features are all row-aligned to `feat`.
        hand_m = feat["hand_m"].to_numpy(dtype=float)
        dominant = shares.idxmax(axis=1).to_numpy()
        # --- layers 2 and 3 --------------------------------------------------
        # Neither touches `risk`, which stays the model's own calibrated
        # probability and the quantity the report's oracle check compares.
        # `condition` DOES touch the dispatch ORDERING, through
        # ensemble.blend_priority, and the bands are cut on that blend.
        #
        # It is a blend rather than a gate, and that is measured. A gate moves a
        # tower at one threshold and reorders nothing, so it discards what the
        # second opinion says about every other site: on held-out seeds the
        # condition gate scored -0.0125 F1 against LightGBM alone, ahead in 1 of
        # 5. The blend scores +0.0191, ahead in 5 of 5, at the same dispatch
        # budget. Standalone the two rankers are complementary — model ROC
        # 0.905, condition 0.884, a 50/50 rank blend 0.929, above both.
        #
        # `novelty` (isolation forest over site environment) enters nothing. It
        # scores |deviation| while maintenance need is monotone, which turns a
        # 0.93-ROC telemetry block into 0.52 inside the band that matters. Kept
        # as a field because it is worth showing a planner — base rate 0.424 in
        # the strangest quintile against 0.061 in the most typical — not worth
        # ranking on. `flags` are descriptive too, and always were.
        #
        # build_matrix runs a second time here — maintenance_need.score() built
        # its own copy internally. It is a column select plus an optional CSV
        # merge, once per process, and the alternative is widening a stable
        # return signature to thread a frame out of score().
        matrix = maintenance_need.build_matrix(feat)
        self.novelty = novelty_scores(matrix, fit_novelty(matrix))
        self.profiler = BehavioralProfiler()
        self.condition = condition_scores(feat["tower_id"].to_numpy())
        change_frame = load_change()
        self.change = change_scores(feat["tower_id"].to_numpy(), change_frame)
        self.priority = blend_priority(risk_values, self.condition, self.change)
        # Bands are cut on the BLENDED priority, not on risk alone — so a tower
        # can sit in `maintain` with a mid `risk`, which is the whole point and
        # is what `escalated` marks.
        maintain_cut, watch_cut = _band_edges(self.priority)

        # Sampled once per process, like everything else in this cache. None
        # when the feature is off or Earth Engine is unreachable — and None
        # rather than {} on purpose, so `weather` reaches the record as null
        # ("we could not ask") instead of an invented quiet forecast.
        self.policy = load_policy()
        self.hazards = sample_weather_hazard(
            feat[["tower_id", "lon", "lat"]].to_dict(orient="records"), self.policy
        )

        records: list[dict] = []
        for i, row in feat.reset_index(drop=True).iterrows():
            shares_row = {f: float(shares.iloc[i][f]) for f in shares.columns}
            risk_value = float(risk_values[i])
            lo, hi = float(risk_lo[i]), float(risk_hi[i])
            # `or {}` at the use site, not at assignment: self.hazards stays
            # None so the record below can still emit weather: null.
            hazard = (self.hazards or {}).get(row["tower_id"])

            decision = _three_band_decision(float(self.priority[i]), maintain_cut, watch_cut)

            # DERIVED — borderline: the [lo, hi] stability interval straddles a
            # band edge, so the band assignment is not robust to AHP weight
            # uncertainty. Flags exactly the tower a planner should sanity
            # check by hand (step 4c). Under the model path lo == hi == risk
            # (no stability measurement — see _compute_stability_draws), so
            # this collapses to "flag nothing" rather than fabricating a
            # robustness signal the model does not have.
            edges = (maintain_cut, watch_cut)
            borderline = any(lo <= edge <= hi for edge in edges)

            record = {
                    "tower_id": row["tower_id"],
                    "lon": float(row["lon"]),
                    "lat": float(row["lat"]),
                    "radio": row["radio"],
                    "risk": risk_value,
                    "risk_lo": lo,
                    "risk_hi": hi,
                    "decision": decision,
                    "borderline": bool(borderline),
                    "dominant_factor": str(dominant[i]),
                    "urgency_days": _urgency_days(shares_row, hazard, self.policy),
                    "attribution": shares_row,
                    "territory": _territory_for(row),
                    # additive, nullable. null means no forecast was applied —
                    # distinct from a forecast that turned out quiet, which
                    # carries a multiplier of 1.0 and an empty driver list.
                    "weather": hazard.to_dict() if hazard else None,
                    # additive — height above nearest drainage, the terrain input
                    # behind p_hand. Surfaced so the map can draw an inundation
                    # stage against it; a measured elevation, not a prediction.
                    "hand_m": float(hand_m[i]),
                    # additive, nullable. How unlike the rest of the estate this
                    # site's environment is, as a percentile rank. NOT a risk
                    # score and not a probability — null (never 0.0) when the
                    # forest could not score the row, because 0.0 would claim
                    # "measured, perfectly typical", the opposite statement.
                    "novelty": None if np.isnan(self.novelty[i]) else float(self.novelty[i]),
                    # additive, nullable. Current-condition rank from the 30-day
                    # telemetry block — the one second-opinion signal that moves
                    # a band. Null when no telemetry exists for this tower.
                    "condition": None if np.isnan(self.condition[i]) else float(self.condition[i]),
                    # Nullable satellite growth rank. Null means no usable
                    # bi-temporal measurement, never a measured zero change.
                    "change": None if np.isnan(self.change[i]) else float(self.change[i]),
                    # additive. The ordering `decision` is actually cut on:
                    # `risk` rank blended with `condition` rank. A percentile,
                    # never a probability — `risk` remains the calibrated number.
                    "priority": float(self.priority[i]),
            }
            # Layer 3 reads the assembled record rather than the frame, so it
            # cannot fall out of step with the row ordering above.
            record["flags"] = self.profiler.flags(record, matrix.iloc[i])
            records.append(record)

        # Capture once when the process cache is built, never per request. Raw
        # window measurements travel with their comparison; all start unlabeled.
        observations = feedback.observations_for(records, change_frame, self.profiler.rules)
        try:
            feedback.append(observations)
        except OSError:
            logging.getLogger(__name__).exception("Could not append satellite observations")

        # `escalated` = the blend put this tower in a higher band than its risk
        # alone would have. Derived by re-banding on the model rank with the SAME
        # cut points, so it answers "did the second opinion move this tower"
        # rather than "is its risk below the maintain cut", which would also fire
        # for towers the blend pushed DOWN.
        risk_only = _rank_pct(risk_values)
        order = {"ok": 0, "watch": 1, "maintain": 2}
        for i, record in enumerate(records):
            alone = _three_band_decision(float(risk_only[i]), maintain_cut, watch_cut)
            record["escalated"] = order[record["decision"]] > order[alone]

        self.records = records
        self.feature_table = feat
        self.maintain_cut = maintain_cut
        self.watch_cut = watch_cut

        if draws is not None:
            # Stability is measured on the index (noisy-OR risk under weight
            # perturbation vs its own unperturbed baseline) — the same
            # quantity model/validate.py's d1_weight_stability reports on, and
            # the same quantity `risk` itself carries under this path.
            rho = np.array(
                [
                    pd.Series(draws[i]).corr(pd.Series(risk_values), method="spearman")
                    for i in range(N_STABILITY_DRAWS)
                ]
            )
            self.stability = {
                "rho_mean": float(np.nanmean(rho)),
                "rho_p05": float(np.nanquantile(rho, 0.05)),
                "top_decile_retention": _top_decile_retention(risk_values, draws),
                "draws": N_STABILITY_DRAWS,
            }
        else:
            # None, not a zeroed struct. `/stability` reporting `rho_mean: 0`
            # here would render as "ranking is pure noise" — the most alarming
            # reading this model can produce — in calm grey, exactly the
            # withdrawn zeroed-fallback bug CLAUDE.md documents. Absence must
            # stay visibly absent.
            self.stability = None


def _top_decile_retention(base: np.ndarray, draws: np.ndarray) -> float:
    k = max(1, int(0.1 * len(base)))
    base_top = set(np.argsort(-base)[:k])
    retentions = []
    for i in range(draws.shape[0]):
        draw_top = set(np.argsort(-draws[i])[:k])
        retentions.append(len(base_top & draw_top) / k)
    return float(np.mean(retentions))


_cache: _AdapterCache | None = None
_cache_lock = Lock()


def _get_cache() -> _AdapterCache:
    global _cache
    if _cache is None:
        # Concurrent first requests must not capture the same startup batch twice.
        with _cache_lock:
            if _cache is None:
                _cache = _AdapterCache()
    return _cache


def load_tower_points() -> list[dict]:
    """[{tower_id, lon, lat}] straight off the feature table, and nothing else.

    Three columns, one read, no scoring. It exists so a geospatial screening
    request does not have to warm the adapter cache, which on its first call
    loads a LightGBM booster, runs TreeSHAP over 1,164 rows, fits a 200-tree
    isolation forest, reads the telemetry CSV, builds the profiler from three
    config files and makes live Earth Engine calls for the weather hazard.
    Paying all of that to find out where the towers are would make the first
    /fire/exposure of a session cost the whole ML pipeline, on a route whose
    name suggests it does nothing of the kind.

    Same source and therefore the same population as load_scored_towers(); it
    simply stops before the part that scores them.
    """
    feat = pd.read_csv(FEATURE_TABLE_CSV, usecols=["tower_id", "lon", "lat"])
    return feat.to_dict(orient="records")


def load_scored_towers() -> list[dict]:
    """List[Tower] per api/types.ts — cached adapter records (step 3a)."""
    return _get_cache().records


def get_stability() -> dict | None:
    """rho_mean, rho_p05, top_decile_retention, draws (step 3b) under the AHP
    index. None under the supervised model, which has no weights to perturb —
    see _compute_stability_draws. FastAPI serialises None as JSON null, which
    is the existing `T | null` contract this route's callers already use for
    "we could not measure this," not a new convention."""
    return _get_cache().stability


def score_with_weights(
    weight_overrides: dict[str, float],
    bbox: tuple[float, float, float, float] | None = None,
) -> list[dict]:
    """POST /score — re-score with client weight overrides (step 3b, gaps
    §5.3: makes the Weights sliders authoritative server-side). Recomputes
    risk + attribution from the feature table via risk_index.attribution()
    with AHP weights overridden by the caller.

    `risk` here is UNCONDITIONALLY the noisy-OR index, regardless of whether
    /towers is currently serving it or the supervised model — see the module
    docstring. A trained gradient-boosted model has no per-factor weight to
    override, so "recompute under adjusted weights" has no equivalent for it;
    this endpoint's whole reason to exist is AHP weight-space exploration.

    Consequence stated plainly: once model.maintenance_need is serving
    /towers, this endpoint can return a DIFFERENT risk for the same tower even
    when `weight_overrides` equals the AHP baseline — the two no longer
    "agree" the way this docstring used to claim. That claim held only while
    both endpoints served the same index. Reconciling it needs a product
    decision (what does moving the Weights sliders mean once the baseline
    score is learned, not asserted?) that this file should not make
    unilaterally; until one is made, /score stays index-only and the
    disagreement should be visible in the UI rather than hidden.

    Decision bands are still re-cut on this response's own risk distribution
    rather than the cached /towers cut points, because re-weighting moves the
    distribution and a capacity-anchored band must follow it.

    Carries NONE of the ensemble fields `/towers` adds — no `novelty`, no
    `flags`, no `escalated`. Layers 2 and 3 sit on the supervised model's design
    matrix and its band cut, neither of which this endpoint has; a
    half-populated contract is worse than an absent one, and the frontend
    already switches wholesale between the two responses the moment a weight
    slider leaves baseline.

    When `bbox` is present, filters the real feature table first so memberships,
    risk and capacity-anchored decision bands all describe the requested AOI.
    An AOI containing no towers returns an empty list.
    """
    cache = _get_cache()
    feat = cache.feature_table
    if bbox is not None:
        west, south, east, north = bbox
        feat = feat[
            feat["lon"].between(west, east) & feat["lat"].between(south, north)
        ]
        if feat.empty:
            return []
    p = memberships(feat)
    p = p.drop(columns=["lightning"], errors="ignore")

    w0, _ = ahp_weights()
    base_weights = _weights_for(w0, p.columns)
    weights = {**base_weights, **{k: v for k, v in weight_overrides.items() if k in base_weights}}

    risk, shares = attribution(p, weights)
    maintain_cut, watch_cut = _band_edges(risk)

    records = []
    for i, tower_id in enumerate(feat["tower_id"]):
        shares_row = {f: float(shares.iloc[i][f]) for f in shares.columns}
        risk_value = float(risk[i])
        # Same hazards /towers used. Re-weighting moves attribution shares, so
        # urgency must be recomputed — but from the same forecast, or the two
        # endpoints would disagree about the weather as well as the weights.
        hazard = (cache.hazards or {}).get(tower_id)
        records.append(
            {
                "tower_id": tower_id,
                "lon": float(feat["lon"].iloc[i]),
                "lat": float(feat["lat"].iloc[i]),
                "radio": feat["radio"].iloc[i],
                "risk": risk_value,
                "risk_lo": risk_value,
                "risk_hi": risk_value,
                "decision": _three_band_decision(risk_value, maintain_cut, watch_cut),
                "borderline": False,  # stability interval not re-derived per re-score request
                "dominant_factor": max(shares_row, key=shares_row.get),
                "urgency_days": _urgency_days(shares_row, hazard, cache.policy),
                "attribution": shares_row,
                "territory": TERRITORY,
                "weather": hazard.to_dict() if hazard else None,
                # additive — same field /towers carries. Both builders or
                # neither: useLiveTowers switches to /score the moment a weight
                # slider leaves baseline, so a one-sided addition makes the
                # flood-stage layer look intermittent rather than missing.
                "hand_m": float(feat["hand_m"].iloc[i]),
            }
        )
    return records
