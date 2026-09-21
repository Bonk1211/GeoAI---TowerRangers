"""Scores the flood factor against observed inundation, with a confusion matrix.

    cd src/backend && python3 model/flood_eval.py

Reads data/malaysia/flood_labels_{gsw,event}.csv (see
data/prepare_flood_labels.py) and writes data/malaysia/flood_eval_report.json.

WHAT IS BEING MEASURED, PRECISELY. Not failure. Not maintenance need. The
question is: does the `flood` membership in model/risk_index.py rank ground by
how likely it is to be under water, when checked against ground somebody else
observed under water? That is the one part of the index a satellite can
adjudicate, and it is the part carrying the largest AHP weight.

WHY THIS IS NOT THE WITHDRAWN CLASSIFIER AGAIN. That model's label was a
quantile cut of `technical_risk`, a deterministic function of its own six
inputs, so it was graded on inverting a threshold it had been handed. Here the
label comes from Landsat (1984-2020 water occurrence) and Sentinel-1 (one
analyst-delineated flood, Dec 2019); the features come from Copernicus DEM, ASF
HAND and OpenStreetMap. No feature is derived from any label, and no label is
derived from any feature. The two can therefore disagree, which is the whole
point — and on the shipped parameters they do.

THE HONEST SCOPE OF THE WEIGHT TUNING. `equipment` and `power` have no
inundation signature, so fitting the AHP weights against a water label would
reintroduce exactly the circularity above by another route. This module
therefore tunes only inside the flood factor — the membership shape parameters
and the two sub-signal weights — and reports the full five-factor index
alongside, unfitted, so the dilution the other factors cause is *measured*
rather than optimised away. FLOOD_WEIGHT_SWEEP is diagnostic for the same
reason: it shows what the AHP flood weight buys, it does not propose a new one.

EVERY SPLIT IS GROUPED BY STATE. Points 5 km apart share terrain, rainfall and
river network; a random split would put near-duplicates on both sides and
report a number that means nothing. Folds are GroupKFold on the ADM1 state, so
a test fold is always states the fit never saw. The UNOSAT event set is never
fitted at all — it is scored once, at the end, by parameters chosen on GSW.

THE OPERATING POINT THAT MATTERS IS TOP-K, NOT 0.5. adapter/ml_source.py cuts
its decision bands by quantile (MAINTAIN_QUANTILE = 0.90), because crew
capacity, not a probability, decides how many towers get dispatched. So
precision and recall are reported at the top 10% of scores as well as at a
tuned threshold, and the top-10% numbers are the ones that describe the product.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from model.risk_index import (  # noqa: E402
    AHP_FACTORS,
    PARAMS,
    ahp_weights,
    attribution,
    exp_decay,
    exp_sat,
    inv_logistic,
    logistic,
    noisy_or,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data" / "malaysia"
TOP_K = 0.10  # matches adapter/ml_source.py MAINTAIN_QUANTILE = 0.90
N_SPLITS = 5
FLOOD_WEIGHT_SWEEP = (0.25, 0.5, 0.75, 1.0)


# --- scorers ---------------------------------------------------------------
def flood_ungated(df: pd.DataFrame) -> np.ndarray:
    """The flood membership as it stood before the slope gate — the historical
    baseline every improvement here is measured against. Kept as a named scorer
    rather than deleted, so the report always shows what the change bought."""
    p_hand = inv_logistic(df.hand_m.to_numpy(), PARAMS["hand_h0"], PARAMS["hand_k"])
    p_dist = exp_decay(df.dist_water_m.to_numpy(), PARAMS["water_d0"])
    return 1 - (1 - p_hand) * (1 - p_dist)


def flood_shipped(df: pd.DataFrame) -> np.ndarray:
    """The flood membership exactly as model/risk_index.py ships it today.

    Reproduced here rather than called through memberships(), which also needs
    radio, flash_density and dist_power_m and returns a frame. Equality with
    memberships()["flood"] is pinned by a test, so the reproduction cannot
    drift away from the module it claims to mirror.
    """
    return flood_ungated(df) * exp_decay(df.slope_deg.to_numpy(),
                                         PARAMS["flood_slope_s0"])


def flood_tuned(df: pd.DataFrame, theta: np.ndarray) -> np.ndarray:
    """Shipped functional form, free parameters: (hand_h0, hand_k, water_d0)."""
    h0, k, d0 = np.exp(theta)
    p_hand = inv_logistic(df.hand_m.to_numpy(), h0, k)
    p_dist = exp_decay(df.dist_water_m.to_numpy(), d0)
    return 1 - (1 - p_hand) * (1 - p_dist)


def flood_engineered(df: pd.DataFrame, theta: np.ndarray) -> np.ndarray:
    """Three changes to the shipped form, each with a physical reason.

    1. HAND enters in log space. Nationally HAND spans 0 to ~450 m; a logistic
       on raw metres with hand_h0 = 5 is saturated at 1 across every floodplain
       and at 0 across every hill, so it has no resolution exactly where the
       decision is made. Inside the 5.7 km^2 Sunway box, where HAND's IQR is
       about a metre, this could not have been noticed.
    2. A slope gate. Standing water needs somewhere to stand; a 20-degree
       hillside a short distance above drainage is not flood-exposed the way
       flat ground at the same HAND is. exp(-slope/s0) is a suppression term,
       never an amplifier, so it can only withdraw a claim of exposure.
    3. Explicit sub-signal weights on the noisy-OR. The shipped form combines
       p_hand and p_dist at full strength each, which asserts that proximity to
       a mapped waterway is as strong evidence as height above drainage. That
       is a weighting choice; making it a parameter is what lets the data
       answer it instead of the AHP matrix.
    """
    h0, k, d0, s0, w_hand, w_dist = np.exp(theta)
    w_hand = min(w_hand, 1.0)
    w_dist = min(w_dist, 1.0)
    p_hand = inv_logistic(np.log1p(df.hand_m.to_numpy()), np.log1p(h0), k)
    p_dist = exp_decay(df.dist_water_m.to_numpy(), d0)
    wet = 1 - (1 - w_hand * p_hand) * (1 - w_dist * p_dist)
    return wet * np.exp(-df.slope_deg.to_numpy() / s0)


def flood_slope_gated(df: pd.DataFrame, theta: np.ndarray) -> np.ndarray:
    """The shipped membership times exp(-slope/s0). One new term, one new
    parameter, every shipped parameter untouched.

    This is the minimal form, and the ablation says it is also the whole
    effect: of the three changes flood_engineered makes, log-space HAND moves
    average precision by 0.0003 and explicit sub-signal weights by 0.0000,
    while the slope gate alone moves it from 0.064 to 0.195. The other two are
    reasonable ideas that the data declines.

    The physical argument is factor hygiene rather than curve-fitting. A site
    two metres above drainage on a valley wall is not flood-exposed the way
    flat ground at the same HAND is, but the shipped membership scores them
    identically, because HAND says how far above the water you are and nothing
    about whether water could stand where you are. The index already has a
    `terrain` factor for slope hazard, so an ungated flood membership was
    quietly charging steep sites twice — once as terrain, once as flood.
    Suppression can only withdraw exposure, never add it, so the gate cannot
    invent a hazard.

    It could not have been found on the pilot AOI: Sunway's slope is 3.5 deg at
    the median and 21.7 deg at its single steepest tower, so there was almost
    no slope variation for the flood label to disagree with.
    """
    s0 = float(np.exp(theta[0]))
    return flood_ungated(df) * np.exp(-df.slope_deg.to_numpy() / s0)


SLOPE_GATE_START = np.log([15.0])


def hand_only(df: pd.DataFrame) -> np.ndarray:
    """Sanity floor: -HAND, ranked. Any model that cannot beat this is not
    earning its parameters."""
    return -df.hand_m.to_numpy()


def full_index(df: pd.DataFrame, flood_weight_scale: float = 1.0) -> np.ndarray:
    """The whole five-factor noisy-OR, unfitted, for dilution measurement.

    radio is absent from the evaluation points, so `equipment` takes the same
    0.5 neutral membership EQUIP.map(...).fillna(0.5) gives an unlabelled mast,
    and `lightning` is dropped exactly as adapter/ml_source.py drops it. Those
    two substitutions are why this scorer is a diagnostic and not a claim about
    the deployed index.
    """
    p = pd.DataFrame(index=df.index)
    p["flood"] = flood_shipped(df)
    tri = df.tri.to_numpy()
    p["terrain"] = np.maximum(
        logistic(df.slope_deg.to_numpy(), PARAMS["slope_s0"], PARAMS["slope_k"]),
        (tri - tri.min()) / (tri.max() - tri.min() + 1e-9),
    )
    p["equipment"] = 0.5
    p["power"] = exp_sat(df.dist_power_m.to_numpy(), PARAMS["power_d0"])
    w0, _ = ahp_weights()
    weights = dict(zip(AHP_FACTORS, w0 / w0.max()))
    weights = {c: weights[c] for c in p.columns}
    weights["flood"] *= flood_weight_scale
    risk, _ = attribution(p, weights)
    return risk


# --- metrics ---------------------------------------------------------------
def confusion(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """TP / FP / FN / TN and the rates that follow, as plain integers."""
    tp = int(np.sum((y_true == 1) & (y_pred == 1)))
    fp = int(np.sum((y_true == 0) & (y_pred == 1)))
    fn = int(np.sum((y_true == 1) & (y_pred == 0)))
    tn = int(np.sum((y_true == 0) & (y_pred == 0)))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    specificity = tn / (tn + fp) if tn + fp else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "true_positive": tp, "false_positive": fp,
        "false_negative": fn, "true_negative": tn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "specificity": round(specificity, 4),
        "f1": round(f1, 4),
        "balanced_accuracy": round((recall + specificity) / 2, 4),
        # Accuracy is reported because it is always asked for, and flagged
        # because at a 2% base rate "predict never flooded" scores 0.98 on it.
        "accuracy": round((tp + tn) / max(tp + fp + fn + tn, 1), 4),
    }


def best_f1_threshold(y_true: np.ndarray, score: np.ndarray) -> float:
    """Threshold maximising F1 — chosen on training data only, never on test."""
    candidates = np.unique(np.quantile(score, np.linspace(0.5, 0.999, 120)))
    best, best_f1 = float(candidates[0]), -1.0
    for threshold in candidates:
        stats = confusion(y_true, (score >= threshold).astype(int))
        if stats["f1"] > best_f1:
            best, best_f1 = float(threshold), stats["f1"]
    return best


def top_k_confusion(y_true: np.ndarray, score: np.ndarray, k: float) -> dict:
    """Confusion matrix if exactly the top k fraction is actioned.

    This is the product's real operating point: the scheduler dispatches a
    crew-capacity-sized slice, so what matters is the purity of that slice, not
    performance at an arbitrary probability cut.
    """
    cut = np.quantile(score, 1 - k)
    stats = confusion(y_true, (score >= cut).astype(int))
    stats["threshold"] = round(float(cut), 6)
    stats["selected_fraction"] = round(float((score >= cut).mean()), 4)
    # Lift over dispatching at random: precision divided by the base rate.
    base = float(y_true.mean())
    stats["lift_over_random"] = round(stats["precision"] / base, 3) if base else None
    return stats


def ranking_metrics(y_true: np.ndarray, score: np.ndarray) -> dict:
    if len(np.unique(y_true)) < 2:
        return {"roc_auc": None, "pr_auc": None, "base_rate": float(y_true.mean())}
    return {
        "roc_auc": round(float(roc_auc_score(y_true, score)), 4),
        "pr_auc": round(float(average_precision_score(y_true, score)), 4),
        "base_rate": round(float(y_true.mean()), 5),
    }


# --- fitting ---------------------------------------------------------------
def fit_params(df: pd.DataFrame, scorer, start: np.ndarray) -> np.ndarray:
    """Maximise average precision on the training rows.

    Average precision, not accuracy or ROC-AUC: the positive class is a few
    percent, and both of the alternatives are dominated by the negatives at
    that base rate. Nelder-Mead over log-parameters keeps every shape parameter
    positive without a constraint solver, and the shipped values are one of the
    starts, so a fit can never come back worse than what is already deployed.
    """
    y = df.label.to_numpy()
    if len(np.unique(y)) < 2:
        # A grouped fold can land on states with no positives at all. Average
        # precision is undefined there; returning the shipped start keeps the
        # fold scoreable instead of raising, and the fold contributes only
        # negatives to the pooled out-of-fold metrics, which is correct.
        return start

    def objective(theta):
        try:
            score = scorer(df, theta)
        except FloatingPointError:
            return 1.0
        if not np.all(np.isfinite(score)):
            return 1.0
        return -average_precision_score(y, score)

    best, best_value = start, objective(start)
    rng = np.random.default_rng(0)
    for attempt in range(6):
        guess = start if attempt == 0 else start + rng.normal(0, 0.5, len(start))
        result = minimize(objective, guess, method="Nelder-Mead",
                          options={"maxiter": 1200, "xatol": 1e-3, "fatol": 1e-5})
        if result.fun < best_value:
            best, best_value = result.x, result.fun
    return best


SHIPPED_TUNED_START = np.log([PARAMS["hand_h0"], PARAMS["hand_k"],
                              PARAMS["water_d0"]])
SHIPPED_ENGINEERED_START = np.log([PARAMS["hand_h0"], 1.0, PARAMS["water_d0"],
                                   15.0, 1.0, 1.0])


# --- evaluation ------------------------------------------------------------
def cross_validated(df: pd.DataFrame, name: str, scorer, start) -> dict:
    """Out-of-fold scores over GroupKFold on state, then metrics on the pooled
    out-of-fold predictions. Pooling is safe because every row's score comes
    from a fit that never saw its state."""
    groups = df.state.to_numpy()
    n_splits = min(N_SPLITS, len(np.unique(groups)))
    folds = GroupKFold(n_splits=n_splits)
    out = np.full(len(df), np.nan)
    thresholds, fitted = [], []
    for train_index, test_index in folds.split(df, df.label, groups):
        train, test = df.iloc[train_index], df.iloc[test_index]
        if start is None:
            out[test_index] = scorer(test)
            thresholds.append(best_f1_threshold(train.label.to_numpy(), scorer(train)))
            continue
        theta = fit_params(train, scorer, start)
        fitted.append(np.exp(theta).round(4).tolist())
        out[test_index] = scorer(test, theta)
        thresholds.append(
            best_f1_threshold(train.label.to_numpy(), scorer(train, theta)))
    y = df.label.to_numpy()
    threshold = float(np.median(thresholds))
    report = {
        "scorer": name,
        "folds": int(n_splits),
        "ranking": ranking_metrics(y, out),
        "at_tuned_threshold": {**confusion(y, (out >= threshold).astype(int)),
                               "threshold": round(threshold, 6)},
        "at_top_10_percent": top_k_confusion(y, out, TOP_K),
    }
    if fitted:
        report["fitted_params_per_fold"] = fitted
    return report, out


def evaluate(gsw: pd.DataFrame, event: pd.DataFrame) -> dict:
    report: dict = {
        "dataset": {
            "gsw_rows": int(len(gsw)),
            "gsw_positives": int(gsw.label.sum()),
            "gsw_base_rate": round(float(gsw.label.mean()), 5),
            "gsw_states": int(gsw.state.nunique()),
            "event_rows": int(len(event)),
            "event_positives": int(event.label.sum()),
            "event_base_rate": round(float(event.label.mean()), 5),
        },
        "cross_validated_on_gsw": [],
    }

    specs = [
        ("hand_only_floor", lambda d: hand_only(d), None),
        ("flood_ungated_before", lambda d: flood_ungated(d), None),
        ("flood_shipped_gated", lambda d: flood_shipped(d), None),
        ("full_index_shipped", lambda d: full_index(d), None),
        ("flood_tuned", flood_tuned, SHIPPED_TUNED_START),
        ("flood_engineered", flood_engineered, SHIPPED_ENGINEERED_START),
        ("flood_slope_gated", flood_slope_gated, SLOPE_GATE_START),
    ]
    for name, scorer, start in specs:
        print(f"  {name}...", file=sys.stderr)
        fold_report, _ = cross_validated(gsw, name, scorer, start)
        report["cross_validated_on_gsw"].append(fold_report)

    # One fit on all of GSW, then scored once on the event set. The event set
    # is a different sensor, a different definition of water and a different
    # year, so this is the only number here that is a genuine out-of-domain
    # test rather than an out-of-fold one.
    print("  held-out UNOSAT event...", file=sys.stderr)
    theta_tuned = fit_params(gsw, flood_tuned, SHIPPED_TUNED_START)
    theta_eng = fit_params(gsw, flood_engineered, SHIPPED_ENGINEERED_START)
    theta_gate = fit_params(gsw, flood_slope_gated, SLOPE_GATE_START)
    event_scorers = {
        "flood_ungated_before": flood_ungated(event),
        "flood_shipped_gated": flood_shipped(event),
        "full_index_shipped": full_index(event),
        "flood_tuned": flood_tuned(event, theta_tuned),
        "flood_engineered": flood_engineered(event, theta_eng),
        "flood_slope_gated": flood_slope_gated(event, theta_gate),
    }
    y_event = event.label.to_numpy()
    report["held_out_event_unosat_2019"] = {
        name: {"ranking": ranking_metrics(y_event, score),
               "at_top_10_percent": top_k_confusion(y_event, score, TOP_K)}
        for name, score in event_scorers.items()
    }
    report["fitted_on_all_gsw"] = {
        "flood_tuned": dict(zip(("hand_h0", "hand_k", "water_d0"),
                                np.exp(theta_tuned).round(4).tolist())),
        "flood_engineered": dict(zip(
            ("hand_h0", "hand_k", "water_d0", "slope_s0", "w_hand", "w_dist"),
            np.exp(theta_eng).round(4).tolist())),
        "flood_slope_gated": {"slope_gate_s0_deg":
                              round(float(np.exp(theta_gate[0])), 3)},
        "shipped_for_comparison": {k: PARAMS[k] for k in
                                   ("hand_h0", "hand_k", "water_d0")},
    }

    # Diagnostic only — see the module docstring. Refitting AHP weights against
    # a water label would grade equipment and power on a hazard they have no
    # relationship to.
    report["flood_weight_sweep_diagnostic"] = {
        str(scale): ranking_metrics(gsw.label.to_numpy(),
                                    full_index(gsw, flood_weight_scale=scale))
        for scale in FLOOD_WEIGHT_SWEEP
    }

    # terrain's membership is min-max normalised over whatever rows are passed
    # in, so it is not comparable between two different row sets. Recorded
    # because expanding to national extent is what made the gap visible.
    report["batch_dependent_terrain_membership"] = {
        "tri_range_gsw": [round(float(gsw.tri.min()), 3), round(float(gsw.tri.max()), 3)],
        "tri_range_event": [round(float(event.tri.min()), 3),
                            round(float(event.tri.max()), 3)],
        "note": "risk_index.memberships normalises tri by the min-max of the "
                "rows it is handed, so the same tower scores differently in a "
                "national run than in an AOI subset.",
    }
    return report


def load(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise SystemExit(
            f"{path} not found — run data/prepare_flood_labels.py first.")
    df = pd.read_csv(path)
    df = df[df.label >= 0].reset_index(drop=True)
    df["state"] = df.state.fillna("unassigned").replace("", "unassigned")
    return df


def summary_table(report: dict) -> str:
    lines = ["", "out-of-fold on GSW (GroupKFold by state)", "-" * 78,
             f"{'scorer':22s} {'ROC':>6s} {'PR':>6s} "
             f"{'TP':>5s} {'FP':>6s} {'FN':>5s} {'TN':>6s} {'prec':>6s} {'rec':>6s}"]
    for row in report["cross_validated_on_gsw"]:
        top = row["at_top_10_percent"]
        lines.append(
            f"{row['scorer']:22s} {row['ranking']['roc_auc']:>6} "
            f"{row['ranking']['pr_auc']:>6} {top['true_positive']:>5d} "
            f"{top['false_positive']:>6d} {top['false_negative']:>5d} "
            f"{top['true_negative']:>6d} {top['precision']:>6} {top['recall']:>6}")
    lines += ["(TP/FP/FN/TN at the top-10% operating point)", "",
              "held out: UNOSAT Sentinel-1 flood, 15 Dec 2019, Johor", "-" * 78,
              f"{'scorer':22s} {'ROC':>6s} {'PR':>6s} "
              f"{'TP':>5s} {'FP':>6s} {'FN':>5s} {'TN':>6s} {'prec':>6s} {'rec':>6s}"]
    for name, row in report["held_out_event_unosat_2019"].items():
        top = row["at_top_10_percent"]
        lines.append(
            f"{name:22s} {row['ranking']['roc_auc']:>6} {row['ranking']['pr_auc']:>6} "
            f"{top['true_positive']:>5d} {top['false_positive']:>6d} "
            f"{top['false_negative']:>5d} {top['true_negative']:>6d} "
            f"{top['precision']:>6} {top['recall']:>6}")
    return "\n".join(lines)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--data-dir", type=Path, default=DATA_DIR)
    args = p.parse_args(argv)
    gsw = load(args.data_dir / "flood_labels_gsw.csv")
    event = load(args.data_dir / "flood_labels_event.csv")
    report = evaluate(gsw, event)
    out = args.data_dir / "flood_eval_report.json"
    out.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(summary_table(report))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
