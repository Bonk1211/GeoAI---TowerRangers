"""Does site environment explain measured signal quality, once geometry is controlled?

The first non-circular model in this project. The label is median RSRP from
operator drive tests — measured by somebody else, for their own purposes, before
this system existed. Nothing here reproduces a threshold we invented.

    python3 src/backend/model/signal_performance.py

Reads data/pilot_sunway/signal_panel.csv (built by data/prepare_signal_panel.py)
and writes data/pilot_sunway/signal_residuals.csv. Not a route, not served: this
ends at a table and a residual per site. Wiring the residual into the
scored-tower contract is a separate decision that should follow a result, not
precede one.

THE PRODUCT IS THE RESIDUAL, NOT THE PREDICTION. Predicting RSRP from distance
is a path-loss model; radio engineering settled that in the 1960s and it tells a
maintenance planner nothing. The useful quantity is what geometry fails to
explain — a site delivering well below what its distance, technology and
operator predict is a site worth looking at. That ranks by underperformance,
which is orthogonal to the risk index's ranking by environmental severity, so
where the two disagree there is something to see that neither shows alone.

GEOMETRY IS ENTERED FIRST, AND ITS EFFECT IS REPORTED. Omit it and the
environment coefficients absorb it, yielding "HAND predicts signal" when the
truth is "low-lying sites happened to be measured closer". The headline is the
*incremental* R2 of environment over geometry alone, never environment's R2 on
its own.

VALIDATION IS GROUPED BY PHYSICAL SITE. The panel's rows come from 48 nodes.
Row-wise CV would put the same mast in train and test and report memorisation —
which is how a model gets a beautiful score for no reason, the exact failure
that retired the previous classifier.

A NULL RESULT IS A RESULT. If environment adds nothing over geometry, that is
worth writing down: it bounds what the risk index can claim about signal impact.
The comparison table prints whatever it finds, and `main` exits 0 either way.

FOUR LIMITATIONS THAT SHAPE HOW ANY NUMBER HERE SHOULD BE READ.

1. n is small. 48 groups, ~315 rows. Held-out R2 on 48 groups has wide error
   bars; the per-fold spread is printed for that reason.
2. `link_distance_m` is measured with error — node positions are estimates
   ("signal centroid mapping", then OpenCellID and field validation). A control
   with error under-controls, so some path loss remains for correlated
   predictors to absorb. Environment's increment is therefore an upper bound on
   its true contribution, not a point estimate.
3. The AOI is 5.7 km2. Environmental gradient across it is small, which limits
   how much environment *could* explain regardless of whether it does.
4. Soil moisture and forecast rainfall are deliberately absent: at 9 km and
   27.75 km per pixel they are constant across this AOI, and a zero-variance
   column gets an arbitrary coefficient that then gets described as an effect.

Attribution: Kabeer, M., Nordin, R., Behjati, M. (2025), DOI
10.17632/dx5xyyfz2y.1, CC BY 4.0.
"""

from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

_THIS_DIR = Path(__file__).resolve().parent
_DATA = _THIS_DIR.parent.parent.parent / "data" / "pilot_sunway"
PANEL_CSV = _DATA / "signal_panel.csv"
RESIDUALS_CSV = _DATA / "signal_residuals.csv"

# numpy 2.2 on Apple Accelerate emits spurious "divide by zero / overflow /
# invalid encountered in matmul" from inside Ridge's Cholesky solver, on inputs
# verified finite. Checked rather than assumed: X.T @ y agrees with the
# equivalent np.einsum to 1.3e-11, so the arithmetic is correct and only the
# warning is wrong. Narrowly scoped to matmul so a genuine numeric problem
# anywhere else still surfaces.
warnings.filterwarnings("ignore", message=".*encountered in matmul", category=RuntimeWarning)

TARGET = "median_level_dbm"
GROUP = "physical_site_group"

# Entered first. Distance in log space because path loss is logarithmic in
# range; technology and operator because RSRP is not comparable across either.
GEOMETRY_FEATURES = ["log_distance", "median_speed_kmh"]
GEOMETRY_CATEGORICALS = ["network_tech", "operator"]

# Terrain and proximity from the tower feature table. Land cover and EVI are not
# here: sampling them per tower needs an Earth Engine pass that has not been
# run, so claiming them as features would be describing a model nobody fitted.
ENVIRONMENT_FEATURES = ["hand_m", "slope_deg", "tri", "dist_water_m", "dist_power_m"]

# Ridge, not a forest. With 48 groups a linear model's coefficients are
# interpretable and a forest's are not, and interpretability is the entire point
# of asking whether environment explains anything.
ALPHA = 1.0
N_SPLITS = 5

# Exploratory trend, reported with its n every time it appears.
TREND_MIN_SESSIONS = 3
TREND_MIN_SPAN_DAYS = 60


def load_panel(path: Path = PANEL_CSV) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(
            f"signal panel not found at {path}. Build it first:\n"
            "  python3 src/backend/data/prepare_signal_panel.py"
        )
    panel = pd.read_csv(path)
    panel["log_distance"] = np.log10(panel["link_distance_m"].clip(lower=1.0))
    return panel


def _design(panel: pd.DataFrame, with_environment: bool) -> pd.DataFrame:
    columns = list(GEOMETRY_FEATURES)
    if with_environment:
        columns += ENVIRONMENT_FEATURES
    frame = panel[columns].copy()
    for column in GEOMETRY_CATEGORICALS:
        dummies = pd.get_dummies(panel[column], prefix=column, drop_first=True, dtype=float)
        frame = pd.concat([frame, dummies], axis=1)
    return frame.fillna(frame.median(numeric_only=True))


def _splitter(groups: np.ndarray) -> GroupKFold:
    return GroupKFold(n_splits=min(N_SPLITS, len(np.unique(groups))))


def _out_of_fold(X: pd.DataFrame, y: np.ndarray, groups: np.ndarray) -> np.ndarray:
    """Predictions for every row, each made by a model that never saw its site.

    GroupKFold on the physical site is the whole validity of this exercise; a
    plain KFold here would report how well the model memorised a mast.
    """
    predictions = np.empty(len(y))
    for train_idx, test_idx in _splitter(groups).split(X, y, groups=groups):
        model = make_pipeline(StandardScaler(), Ridge(alpha=ALPHA))
        model.fit(X.iloc[train_idx], y[train_idx])
        predictions[test_idx] = model.predict(X.iloc[test_idx])
    return predictions


def _fold_scores(X: pd.DataFrame, y: np.ndarray, groups: np.ndarray) -> list[float]:
    """Per-fold held-out R2, so the spread is visible rather than averaged away."""
    scores = []
    for train_idx, test_idx in _splitter(groups).split(X, y, groups=groups):
        model = make_pipeline(StandardScaler(), Ridge(alpha=ALPHA))
        model.fit(X.iloc[train_idx], y[train_idx])
        scores.append(r2_score(y[test_idx], model.predict(X.iloc[test_idx])))
    return scores


def evaluate(panel: pd.DataFrame) -> dict:
    """Null -> geometry -> geometry+environment, all scored on held-out sites."""
    y = panel[TARGET].to_numpy(dtype=float)
    groups = panel[GROUP].to_numpy()

    results: dict = {}
    # Null model: the training-fold mean, predicted out of fold. Its R2 is
    # slightly negative by construction, which is the correct baseline — it is
    # what "no information" actually scores on held-out groups.
    null_pred = np.empty(len(y))
    for train_idx, test_idx in _splitter(groups).split(panel, y, groups=groups):
        null_pred[test_idx] = y[train_idx].mean()
    results["null"] = {
        "r2": r2_score(y, null_pred),
        "mae": mean_absolute_error(y, null_pred),
        "folds": [],
    }

    for name, with_env in (("geometry", False), ("geometry+environment", True)):
        X = _design(panel, with_environment=with_env)
        pred = _out_of_fold(X, y, groups)
        results[name] = {
            "r2": r2_score(y, pred),
            "mae": mean_absolute_error(y, pred),
            "folds": _fold_scores(X, y, groups),
            "predictions": pred,
        }

    results["incremental_r2"] = results["geometry+environment"]["r2"] - results["geometry"]["r2"]
    return results


def residuals(panel: pd.DataFrame, geometry_predictions: np.ndarray) -> pd.DataFrame:
    """Per-site underperformance: observed minus what geometry predicts.

    Negative means the site delivers worse signal than its distance, technology
    and operator account for. Averaged across that site's sessions.
    """
    frame = panel[["node", GROUP, "lon", "lat", TARGET]].copy()
    frame["geometry_predicted_dbm"] = geometry_predictions
    frame["residual_db"] = frame[TARGET] - frame["geometry_predicted_dbm"]
    return (
        frame.groupby(["node", "lon", "lat"], as_index=False)
        .agg(
            sessions=("residual_db", "size"),
            median_level_dbm=(TARGET, "mean"),
            residual_db=("residual_db", "mean"),
        )
        .sort_values("residual_db")
    )


def trends(panel: pd.DataFrame) -> pd.DataFrame:
    """Exploratory per-node dB/month slope. Reported with its n, always.

    A slope from three sessions over sixty days is a scatter plot with error
    bars, not a model. It is computed because it is nearly free once the panel
    exists, and labelled so nobody quotes it as a finding.
    """
    frame = panel.copy()
    frame["ts"] = pd.to_datetime(frame["session_ts"], format="%Y-%m-%dT%H:%M:%SZ")
    rows = []
    for node, group in frame.groupby("node"):
        span_days = (group["ts"].max() - group["ts"].min()).days
        if group["SessionID"].nunique() < TREND_MIN_SESSIONS or span_days < TREND_MIN_SPAN_DAYS:
            continue
        months = (group["ts"] - group["ts"].min()).dt.total_seconds() / (30 * 86400)
        slope = float(np.polyfit(months, group[TARGET], 1)[0])
        rows.append(
            {
                "node": node,
                "sessions": group["SessionID"].nunique(),
                "span_days": span_days,
                "trend_db_per_month": slope,
            }
        )
    return pd.DataFrame(rows).sort_values("trend_db_per_month") if rows else pd.DataFrame()


def diagnostics(panel: pd.DataFrame) -> dict:
    """Why the models score as they do — so a null is explained, not asserted.

    A null result with no diagnosis is indistinguishable from a broken script.
    These three numbers say where the variance actually is and how much signal
    the features could carry at their very best.
    """
    y = panel[TARGET]
    between = panel.groupby("node")[TARGET].mean().var()
    within = panel.groupby("node")[TARGET].transform(lambda s: s - s.mean()).var()
    site = panel.groupby("node").agg(level=(TARGET, "mean"), distance=("link_distance_m", "mean"))
    return {
        "target_sd": float(y.std()),
        "icc": float(between / (between + within)),
        "site_level_distance_corr": float(np.corrcoef(site["distance"], site["level"])[0, 1]),
        "n_sites": int(panel[GROUP].nunique()),
        "correlations": {
            column: float(np.corrcoef(panel[column], y)[0, 1])
            for column in ["log_distance", *ENVIRONMENT_FEATURES]
        },
    }


def _print_diagnostics(diag: dict) -> None:
    print("\n  why these scores — variance structure and univariate signal:")
    print(f"    ICC (between-site share of variance)   {diag['icc']:.2f}"
          "   most variance is between sites, so site-level prediction is the right frame")
    print(f"    site-level corr(distance, level)       {diag['site_level_distance_corr']:+.2f}"
          f"   over {diag['n_sites']} sites -> an R2 ceiling near "
          f"{diag['site_level_distance_corr'] ** 2:.2f} before any CV")
    print("    univariate correlations with the target:")
    for column, value in sorted(diag["correlations"].items(), key=lambda kv: -abs(kv[1])):
        print(f"      {column:18s} {value:+.3f}")


def _print_table(results: dict, panel: pd.DataFrame) -> None:
    print(
        f"\npanel: {len(panel)} rows, {panel[GROUP].nunique()} sites, "
        f"{panel['SessionID'].nunique()} sessions"
    )
    print(f"target: {TARGET}  (sd {panel[TARGET].std():.2f} dB)")
    print(f"validation: GroupKFold({min(N_SPLITS, panel[GROUP].nunique())}) on {GROUP}\n")
    print(f"  {'model':22s} {'held-out R2':>12s} {'MAE dB':>8s}   per-fold R2")
    print("  " + "-" * 68)
    for name in ("null", "geometry", "geometry+environment"):
        row = results[name]
        folds = " ".join(f"{s:5.2f}" for s in row["folds"]) or "—"
        print(f"  {name:22s} {row['r2']:12.3f} {row['mae']:8.2f}   {folds}")
    print("  " + "-" * 68)
    print(f"  {'incremental R2 (env)':22s} {results['incremental_r2']:12.3f}")


def main() -> None:
    panel = load_panel()
    results = evaluate(panel)
    _print_table(results, panel)

    _print_diagnostics(diagnostics(panel))

    increment = results["incremental_r2"]
    if increment <= 0.01:
        print("\n  READING: environment adds nothing over geometry at this AOI.")
        print("  That is a finding, not a failure — it bounds what the risk index can")
        print("  claim about signal impact. See the limitations in this module's")
        print("  docstring; a 5.7 km2 AOI leaves little environmental gradient to detect.")
    else:
        print(f"\n  READING: environment adds {increment:.3f} R2 over geometry alone.")
        print("  Upper bound, not a point estimate: link_distance_m is measured with error")
        print("  (estimated node positions), so it under-controls and correlated terrain")
        print("  features absorb some residual path loss.")

    # Sensitivity: the panel's node threshold was set on measurement error, but
    # a conclusion that only survives one threshold is not a conclusion.
    totals = panel.groupby("node")["n_measurements"].sum()
    strict = panel[panel["node"].isin(totals[totals >= 30].index)]
    if strict[GROUP].nunique() >= N_SPLITS:
        strict_increment = evaluate(strict)["incremental_r2"]
        print(
            f"\n  sensitivity (nodes with >=30 obs: {strict[GROUP].nunique()} sites, "
            f"{len(strict)} rows): incremental R2 {strict_increment:.3f}"
        )

    per_site = residuals(panel, results["geometry"]["predictions"])
    per_site.to_csv(RESIDUALS_CSV, index=False)
    print(f"\n  wrote {RESIDUALS_CSV}  ({len(per_site)} sites)")
    print("  worst underperformers vs geometry (negative = worse than predicted):")
    for _, row in per_site.head(5).iterrows():
        print(
            f"    node {int(row['node']):>7d}  residual {row['residual_db']:+6.2f} dB  "
            f"({int(row['sessions'])} sessions)"
        )

    trend = trends(panel)
    if len(trend):
        print(
            f"\n  EXPLORATORY trend, n={len(trend)} nodes with >={TREND_MIN_SESSIONS} "
            f"sessions and >={TREND_MIN_SPAN_DAYS}d span."
        )
        print("  Not a model — a slope through a handful of points. Never quote without this n.")
        print(
            f"    median {trend['trend_db_per_month'].median():+.2f} dB/month, "
            f"range {trend['trend_db_per_month'].min():+.2f} to "
            f"{trend['trend_db_per_month'].max():+.2f}"
        )


if __name__ == "__main__":
    main()
