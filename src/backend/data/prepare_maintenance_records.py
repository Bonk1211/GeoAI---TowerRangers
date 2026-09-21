"""Synthetic tower maintenance records — the ground truth this project lacks.

No operator or MCMC maintenance history was obtainable for this prototype, and
without one the risk ranking has never been scored against the thing it claims
to rank. This producer simulates that history so a confusion matrix can exist.
Everything it writes is labelled `"synthetic": true`, and the figures it enables
validate the *pipeline*, never real-world accuracy.

WHY THIS IS NOT THE WITHDRAWN CLASSIFIER AGAIN
----------------------------------------------
`maintenance_classifier` reported 0.974 AUC and meant nothing: its label was a
quantile cut on `technical_risk`, a deterministic function of the same features
the model was given, so it was scored on inverting a threshold it had been
handed. Five rules keep this different, and the first is mechanical:

  1. This module NEVER imports model.risk_index. Not memberships(), not
     noisy_or(), not PARAMS. Pinned by an AST-parsing test rather than a grep,
     because this docstring legitimately mentions the index.
  2. Hazard is driven by OBSERVED MEASUREMENTS (JRC GSW occurrence, sampled
     EVI, sampled clay and soil moisture) through functional forms deliberately
     unlike the index's membership curves — ramps and exponentials, never the
     index's logistic memberships combined by noisy-OR. `hand_m` and
     `slope_deg` DO drive hazard here now (they did not before this retune):
     low ground holds water and steep ground erodes, and excluding the two most
     informative terrain columns was costing accuracy the retune was asked to
     recover. The forms are still ours, not the index's.
  3. Latent site attributes the model never sees (build quality, drainage,
     genset age, foundation, access road) still carry variance, so no model can
     reach PR-AUC 1.0 — but LATENT_STRENGTH now attenuates them to 0.15 of
     their natural spread, which is most of why the reported accuracy is high.
  4. `lambda_true` — the clean intensity before reporting noise — is written
     out, so the notebook can score the ORACLE and show the ceiling. A model
     landing at the oracle means this generator leaked, not that it is good.
  5. The label column and `lambda_true` are the only target-derived columns
     written. The former leakage-bait column `n_site_visits_36mo` — a near-copy
     of the target — has been removed rather than left excluded.

WHAT IS PLANTED
---------------
DEMO CASES are individual sites given unusual latent draws — never hand-written
labels. The Poisson simulation then runs unchanged. A forced latent is a site
with an unusual history, which real registers are full of; an edited ticket
count is a fabrication. They are registered to `demo_cases.json` before any
model exists, so "the model fell for this" is a finding rather than a story
assembled afterward.

The earlier PLANTED TRAPS — a clay x wetness interaction, a non-monotone
vegetation hump, a power-distance cliff, a per-state contractor effect, and a
leakage-bait column — have been REMOVED at the project's request, in favour of
a dataset a supervised model can score well on. What that costs is stated
plainly: each trap was a mechanism the physical index structurally could not
represent, and they were the evidence that the supervised model earned its
place rather than merely restating the index. The hazard forms below are now
smooth and monotone in the observed columns, the latent multipliers are
attenuated by LATENT_STRENGTH, and reporting noise is off by default. The
headline accuracy is correspondingly higher and correspondingly less
informative: it measures how learnable this generator made itself.

Network-free — every input is on disk, which is what lets the tests stay
offline. Run after data/prepare_land_features.py:

    cd src/backend/data && python3 prepare_maintenance_records.py
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

_THIS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _THIS_DIR.parent
for _p in (str(_BACKEND_DIR), str(_THIS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from model.maintenance_need import build_matrix  # noqa: E402
from prepare_pilot_dataset import write_json  # noqa: E402
from scheduler.config_loader import load_policy  # noqa: E402

_REPO_ROOT = _BACKEND_DIR.parent.parent
DATA_DIR = _REPO_ROOT / "data" / "malaysia"
TOWER_TABLE = DATA_DIR / "tower_feature_table.csv"
LAND_FEATURES = DATA_DIR / "land_features.csv"
LAND_CHANGE = DATA_DIR / "land_change.csv"

RECORDS_CSV = DATA_DIR / "maintenance_records.csv"
LABELS_CSV = DATA_DIR / "maintenance_labels.csv"
PANEL_CSV = DATA_DIR / "maintenance_panel.csv"
TELEMETRY_CSV = DATA_DIR / "site_telemetry.csv"
MANIFEST = DATA_DIR / "maintenance_manifest.json"
DEMO_CASES = DATA_DIR / "demo_cases.json"

GENERATOR_VERSION = "2.3"
HISTORY_MONTHS = 36

# Share of towers with at least one corrective order in the window. Too rare and
# the top-10% operating point has no positives to find; too common and
# everything is positive. The intensity scale is bisected to hit this.
TARGET_BASE_RATE = 0.21
BASE_RATE_TOLERANCE = 0.003

# Reporting noise, applied LAST — after lambda_true is recorded. Both are 0.0
# after the retune, and not only because noise costs accuracy.
#
# SPURIOUS_RATE scatters `len(tickets) * rate` misfiled tickets UNIFORMLY over
# towers, and OBSERVABLE_LOG_SPREAD concentrates the ticket count onto a small
# number of very heavy sites. At 0.08 that means ~8% of a now-large ticket pile
# lands on randomly chosen towers, which pushed the measured base rate from
# 0.21 to 0.66 — the label stopped meaning "this site needs work" and started
# meaning "somebody filed something". Restore either rate only alongside a
# misfile model that respects the site distribution.
DROP_RATE = 0.0         # raised but never filed
SPURIOUS_RATE = 0.0     # filed against the wrong site
PREVENTIVE_PER_YEAR = 0.30

# --- causes -> the scheduler's own vocabulary ------------------------------
# Keys match model.maintenance_need.FACTOR_GROUPS and config/actions.yaml, so a
# synthetic ticket speaks the same language as a real work order. `vegetation`
# must exist in actions.yaml or the scheduler has nothing to raise for it.
CAUSE_ACTIONS = {
    "flood": ("raise_cabinet_and_seal", "civil"),
    "terrain": ("slope_stabilize_and_tension", "civil"),
    "vegetation": ("vegetation_clearance", "civil"),
    "power": ("battery_genset_service", "power"),
    "equipment": ("radio_unit_refresh", "rf"),
}
CAUSES = list(CAUSE_ACTIONS)

# Older air interfaces need more hands-on work. 96% of OSM masts carry no radio
# tag, so UNKNOWN is the modal value and equipment is expected to be a WEAK
# factor here — a true property of the input, not a modelling failure.
RADIO_BURDEN = {"GSM": 0.85, "UMTS": 0.65, "LTE": 0.30, "NR": 0.12, "UNKNOWN": 0.45}

# --- hazard shape ----------------------------------------------------------
# The gates, humps and cliffs that used to live here (the planted traps) are
# gone; every response below is smooth and monotone in its driver. Thresholds
# are still sited on the national distribution of the column they read, because
# a ramp centred outside the data's own range is a constant, not a response.
# Percentiles are from data/malaysia/land_features.csv.
CLAY_ONSET, CLAY_SPAN = 20.0, 25.0          # clay_pct p25 ~ 20, p95 ~ 45
MOISTURE_ONSET, MOISTURE_SPAN = 0.30, 0.25  # soil_moisture_p90 p10 ~ 0.354
EVI_ONSET, EVI_SPAN = 0.15, 0.35            # evi_median p50 ~ 0.335
# Regrowth adds work independently of standing greenness. This deliberately
# gives the synthetic label a time dimension; it is not evidence of real lift.
ENCROACHMENT_ONSET = 0.02  # EVI/year below which no regrowth is charged
ENCROACHMENT_SPAN = 0.18   # ramp width, saturating at 0.20 EVI/year
# 0.70 failed calibration on the 200-tower smoke and seed 5; 0.60/0.50/0.40
# also missed the fixed tolerance. 0.30 passes the smoke and all seeds 0-9.
ENCROACHMENT_GAIN = 0.30
POWER_SCALE_M = 2500.0                      # dist_power_m p75 ~ 1936
HAND_SCALE_M, HAND_SHAPE = 4.0, 1.5         # hand_m national median ~ 3.9
WATER_SCALE_M = 1500.0
SLOPE_FULL_DEG = 25.0

# How much of the latent multipliers' natural spread survives. Each latent m is
# applied as 1 + LATENT_STRENGTH*(m - 1), so 1.0 is the original generator and
# 0.0 removes hidden variance entirely.
#
# A lever on the DATA, not on the model. Measured out-of-fold on the real
# 1,164-tower national data at OBSERVABLE_LOG_SPREAD = 5.5: strength 1.0 gives
# the served model ROC 0.857, strength 0.15 gives 0.955, with the oracle
# unmoved at ~0.985. Kept non-zero so hidden site history still perturbs the
# ranking; note that at this spread it no longer holds the oracle meaningfully
# below 1 the way it did in v1.0 — the observable side carries ~30 units of log
# variance against the latents' fraction of one, so the ceiling argument is
# much weaker than it was, and that is a cost of the retune, not an oversight.
LATENT_STRENGTH = 0.15

# Spread of the observable side, in standard deviations of log-intensity. The
# summed cause intensity is renormalised to exp(SPREAD * z), z the standardised
# log-total, so the mean level is set by the base-rate bisection and this
# controls only contrast.
#
# It replaces the old CAUSE_INTENSITY_EXPONENT power law, which set spread only
# indirectly and saturated. Measured on the real 1,164-tower national data
# (GroupKFold on state, 5 folds), with LATENT_STRENGTH 0.15:
#   1.0 -> ROC 0.665   2.0 -> 0.849   3.0 -> 0.900
#   4.5 -> 0.940       5.5 -> 0.955   (oracle 0.986)
# 5.5 is where the model tracks the oracle closely without the label becoming
# a deterministic function of the features. Above ~6 the Poisson draw stops
# mattering at all and the exercise is no longer a statistics problem.
OBSERVABLE_LOG_SPREAD = 5.5

# --- current-period site telemetry (v2.2) ----------------------------------
# A 30-day rolling block of on-site counters — rectifier alarms, battery voltage
# sag events, door-open hours. Written to site_telemetry.csv, one row per tower.
#
# WHY IT EXISTS, and it is not a feature for the supervised model. Telemetry
# reflects the site's CURRENT condition, so it is genuinely predictive: measured
# on the shipped settings it carries ROC 0.93 against the label on its own. What
# it does not carry is HISTORY. The counters started 30 days ago; the label is a
# 36-month window. There is no aligned (telemetry, outcome) training pair
# anywhere in this dataset, so a supervised model cannot fit it — and
# model/maintenance_need.py's FEATURES deliberately does not include it.
#
# An unsupervised layer has no such problem: it needs no labels, so it can read
# a column the day it starts flowing. That is the standard reason an
# unsupervised member earns a place in an ensemble, and it is the only reason
# measured in this project that actually works — see model/novelty.py.
#
# Derived from the site's own total hazard intensity plus gaussian noise, which
# is the physically right shape: environmental and latent causes both surface as
# alarms. TELEMETRY_NOISE is therefore a TELEMETRY QUALITY knob and the result
# is sensitive to it. Measured, 5 seeds x 5 dispatch budgets, ensemble F1 minus
# matched-budget LightGBM:
#
#   noise   telemetry ROC   one-sided layer 2   delta F1   cells won
#    0.25          0.969               0.845     +0.0232       23/25
#    0.50          0.933               0.757     +0.0104       20/25    <- shipped
#    0.75          0.888               0.699     +0.0012       12/25
#    1.00          0.845               0.661     -0.0034        8/25
#
# 0.50 is chosen for PLAUSIBILITY, not for the delta: a 30-day alarm count that
# ranks maintenance need at ROC ~0.93 is what real telco site telemetry looks
# like. The honest reading of the table is that the ensemble's advantage is a
# function of telemetry quality and disappears by noise 0.75.
TELEMETRY_COLUMNS = ["rectifier_alarms_30d", "battery_sag_events_30d", "door_open_hours_30d"]
TELEMETRY_NOISE = 0.5
TELEMETRY_LOADINGS = {"rectifier_alarms_30d": 1.0, "battery_sag_events_30d": 1.0,
                      "door_open_hours_30d": 0.5}

# --- rare-configuration hazard (v2.1) --------------------------------------
# Sites whose environmental configuration is UNUSUAL carry extra maintenance
# need, over and above what any single column says. A mast in a combination of
# terrain, wetness and vegetation that almost nothing else in the estate shares
# is a non-standard build: bespoke foundation, custom power arrangement,
# atypical access, no spares commonality, and a crew that has not seen one
# before. That is a real mechanism in asset registers, and it is one no single
# feature carries.
#
# OFF BY DEFAULT (BOOST = 1.0), AND THE REASON IS THE POINT. This was added to
# answer a direct question: can the dataset be changed so the three-layer
# ensemble outperforms LightGBM alone? v2.0 had removed every planted trap and
# made the hazard smooth and monotone in exactly the observables the supervised
# model reads, so the dataset no longer contained the PHENOMENON an
# unsupervised layer exists to detect. Putting it back looked like the fix.
#
# It is not, and the measurement says so. Out-of-fold, GroupKFold on state,
# ensemble F1 minus LightGBM-alone F1 (higher = the ensemble helps more):
#
#   boost  quantile  pocket    lgb PR-AUC   delta F1
#     OFF         -       0        0.7650    +0.0407     <- no planting at all
#     2.0      0.90     117        0.7071    +0.0461
#     4.0      0.90     117        0.7504    +0.0382
#    10.0      0.90     117        0.7747    +0.0453
#     4.0      0.95      59        0.7391    +0.0278
#    10.0      0.95      59        0.7791    +0.0346
#     4.0      0.97      35        0.7628    +0.0617
#    10.0      0.97      35        0.7736    +0.0397
#     4.0      0.985     18        0.7941    +0.0111
#    10.0      0.985     18        0.7936    +0.0175
#
# Every planted cell sits in the same band as no planting at all, and the
# strongest boost RAISES LightGBM's PR-AUC (0.765 -> 0.775) — the tree simply
# learns the mechanism. Shrinking the pocket to beat min_data_in_leaf does not
# help either: the generator/detector rank correlation FALLS with it (0.42 at
# q=0.90, 0.16 at q=0.985), so the isolation forest finds less of the planted
# structure, not more. A separate test — biasing the LABEL by under-reporting
# tickets on unusual sites, scored against true need — moved delta F1 only from
# +0.041 to +0.058 at a 60% drop rate.
#
# THE STRUCTURAL REASON, which no dataset knob reaches: model/novelty.py reads
# NOVELTY_FEATURES, which is FEATURES minus the categoricals — the SAME columns
# LightGBM reads. An isolation forest cannot see structure a gradient-boosted
# tree cannot, on identical inputs, at n = 1,164. Whatever is planted in those
# columns, the supervised model gets it first, because it also has the label.
# The ensemble's real and repeatable gain (delta F1 ~ +0.04) comes from the
# ESCALATION POLICY dispatching further down a pool that still holds a 14% hit
# rate, and that gain is present with the boost off.
#
# What would actually change the answer is an architecture change, not a data
# change: give Layer 2 columns Layer 1 does not have. Kept here, inert, so the
# next person to have this idea can read the numbers instead of re-running it.
#
# It is NOT a v1.0-style trap. The traps were non-monotone (a mid-EVI hump), an
# interaction (clay x wetness), or a cliff (power distance) — shapes chosen
# because the physical index could not represent them. This is smooth and
# strictly monotone in its driver. What makes it hard for a boosted tree is not
# its shape but its SUPPORT: the driver is a multivariate distance, so it is
# axis-aligned nowhere, and by construction there are few rows in any one
# unusual configuration. With min_data_in_leaf = 25 over 1,164 towers, a tree
# cannot isolate them.
#
# WHAT KEEPS THIS OFF THE CIRCULARITY PATH. The generator measures unusualness
# by MAHALANOBIS DISTANCE — global, elliptical, covariance-based, computed with
# numpy alone. model/novelty.py measures it with an ISOLATION FOREST — local,
# axis-aligned, path-length based. Two different estimators of a shared
# concept, which is the same relationship model/flood_eval.py has with observed
# water: the label and the detector are not the same computation. The generator
# must never import sklearn or model.novelty, and the AST test in
# test_maintenance_records.py fails the build if it does. The realised rank
# correlation between the two is reported in the manifest — near 1.0 would mean
# the detector had been handed its own answer key.
RARE_CONFIG_QUANTILE = 0.90   # Mahalanobis rank above which the boost applies
RARE_CONFIG_BOOST = 1.0       # DISABLED — see the note above. >1.0 enables.

# Columns defining "configuration". The generator's own list, deliberately not
# imported from model.maintenance_need: these are the columns it already reads
# individually above, and a shared constant would couple label generation to
# the model's feature contract.
# `elevation_m` is deliberately NOT here. test_hazard_ignores_elevation pins
# that elevation drives no hazard in this generator — it is a descriptor, not a
# mechanism, and a site is not harder to maintain for being high up. Including
# it would leave that invariant true only by accident, holding while the boost
# is off and breaking the moment anyone enables it.
RARE_CONFIG_COLUMNS = [
    "hand_m", "slope_deg", "tri", "clay_pct",
    "soil_moisture_p90", "evi_median", "dist_power_m", "dist_water_m",
]

# Per-site shared frailty — everything about a site that drives repeat visits
# and that no satellite records: as-built workmanship, cable dressing, door
# seals, how hard the site is actually loaded, which subcontractor has it. A
# standard frailty term from recurrent-event analysis. Attenuated by
# LATENT_STRENGTH like every other latent.
FRAILTY_SIGMA = 0.20

# Ceiling on a site's expected corrective tickets per month, applied smoothly by
# _saturate(). 0.8/month is ~29 over the 36-month window: a genuinely troubled
# site that a planner would already have escalated, and far past anything the
# binary label can distinguish. Chosen as the point where the register stops
# being absurd without touching the region where the label is decided.
MAX_MONTHLY_RATE = 0.8

# Sanity cap on a recorded simulation. Not a tuning knob — a tripwire for an
# uncalibrated scale (see simulate()).
MAX_TICKETS = 2_000_000

# Demo-case budget, capped hard. Plant 200 pathological towers and the metrics
# stop describing the model and start describing the edge cases.
MAX_DEMO_CASES = 45


# --- inputs ----------------------------------------------------------------
def load_inputs(
    tower_table: Path, land_features: Path, land_change: Path = LAND_CHANGE
) -> pd.DataFrame:
    if not tower_table.exists():
        raise SystemExit(
            f"{tower_table} not found — run data/prepare_malaysia_dataset.py first."
        )
    if not land_features.exists():
        raise SystemExit(
            f"{land_features} not found — run data/prepare_land_features.py first. "
            "It needs Earth Engine credentials (see tiles/ee_session.py)."
        )
    towers = pd.read_csv(tower_table)
    land = pd.read_csv(land_features)
    frame = towers.merge(land, on="tower_id", how="left")
    if land_change.exists():
        change = pd.read_csv(land_change, usecols=["tower_id", "evi_delta_per_year"])
        frame = frame.merge(change, on="tower_id", how="left", validate="one_to_one")
    frame["state"] = frame["state"].fillna("unassigned").replace("", "unassigned")
    frame["radio"] = frame["radio"].fillna("UNKNOWN")
    return frame.reset_index(drop=True)


# --- Task 2: latent site attributes ---------------------------------------
def draw_latents(rng: np.random.Generator, frame: pd.DataFrame) -> pd.DataFrame:
    """Attributes a satellite cannot see, and the model never gets.

    Conditioned weakly on observables so the simulated world is coherent — a
    real site's build quality does correlate with where it is — but every unit
    of that correlation is signal handed back to the model, so the conditioning
    stays light and a test holds the strongest correlation under 0.35.
    """
    n = len(frame)
    built_up = (frame["land_cover_class"] == 50).to_numpy().astype(float)
    tri = frame["tri"].to_numpy()
    tri_norm = tri / (np.nanmax(tri) + 1e-9)
    clay = frame["clay_pct"].fillna(frame["clay_pct"].median()).to_numpy()

    latents = pd.DataFrame(index=frame.index)
    latents["build_quality"] = np.clip(rng.beta(2.0, 2.0, n) + 0.10 * built_up, 0.0, 1.0)
    latents["has_drainage"] = (
        rng.random(n) < np.clip(0.35 + 0.25 * built_up, 0.0, 1.0)
    ).astype(int)
    latents["genset_age_years"] = rng.uniform(1.0, 22.0, n)
    latents["site_frailty"] = rng.lognormal(0.0, FRAILTY_SIGMA, n)

    # Pile foundations are likelier where the ground is clay-rich — an
    # engineering decision genuinely driven by the soil.
    pile_p = np.clip(0.20 + 0.010 * clay, 0.0, 0.75)
    draw = rng.random(n)
    latents["foundation_type"] = np.where(
        draw < pile_p, "pile", np.where(draw < pile_p + 0.35, "raft", "pad")
    )

    # Rougher ground is served by worse roads.
    track_p = np.clip(0.10 + 0.55 * tri_norm, 0.0, 0.80)
    draw = rng.random(n)
    latents["access_road_class"] = np.where(
        draw < track_p, "track", np.where(draw < track_p + 0.35, "gravel", "sealed")
    )

    # The per-state contractor effect that used to live here is removed. It was
    # the trap that made a random KFold score optimistically against GroupKFold;
    # without it the two splits should agree, and the notebook still reports
    # both so that agreement is checked rather than assumed.

    # Demo-case latent. 1.0 for every ordinary site; plant_demo_cases() sets it
    # for the handful it plants. Applied at FULL strength in cause_intensities()
    # — deliberately outside LATENT_STRENGTH, see set_behaviour() there.
    latents["demo_multiplier"] = 1.0

    # Every site runs for the whole window unless a demo case says otherwise.
    latents["months_in_service"] = float(HISTORY_MONTHS)
    latents["remediated_at_month"] = np.nan
    latents["catastrophic"] = 0.0
    return latents


# --- Task 4b: planted edge cases ------------------------------------------
def _pick(rng, pool, taken: set[int], count: int) -> list[int]:
    """Draw `count` unused row positions from `pool`, seeded and repeatable."""
    available = [int(i) for i in np.asarray(pool) if int(i) not in taken]
    if not available:
        return []
    chosen = rng.choice(available, size=min(count, len(available)), replace=False)
    picked = [int(i) for i in np.atleast_1d(chosen)]
    taken.update(picked)
    return picked


def _find_twin_pairs(frame: pd.DataFrame, taken: set[int], n_pairs: int):
    """Nearest neighbours in the MODEL's standardised feature space.

    Uses build_matrix so the match is on exactly the columns the model sees, in
    the order it sees them. A pair matched on raw columns the model ignores
    would be separable, and the ceiling demo would be void.
    """
    from scipy.spatial import cKDTree

    numeric = build_matrix(frame).select_dtypes(include=[np.number])
    values = numeric.to_numpy(dtype=float)
    # Median-fill for the distance metric only — the model still sees NaN.
    filled = np.where(np.isnan(values), np.nanmedian(values, axis=0), values)
    spread = filled.std(axis=0)
    spread[spread == 0] = 1.0
    standardised = (filled - filled.mean(axis=0)) / spread

    distances, neighbours = cKDTree(standardised).query(standardised, k=2)
    pairs, used = [], set(taken)
    for index in np.argsort(distances[:, 1]):
        left, right = int(index), int(neighbours[index, 1])
        if left in used or right in used or left == right:
            continue
        pairs.append((left, right))
        used.update({left, right})
        if len(pairs) == n_pairs:
            break
    return pairs


def plant_demo_cases(
    rng: np.random.Generator,
    frame: pd.DataFrame,
    latents: pd.DataFrame,
    baseline: pd.DataFrame,
) -> list[dict]:
    """Force latents on a small, named set of sites. Never touches labels.

    Selection is by environmental precondition from the seeded rng, never a
    hardcoded tower_id — a hardcoded id breaks the moment the tower table is
    regenerated, and is also how a "planted" case quietly becomes a hand-picked
    one.

    `baseline` is cause_intensities() run BEFORE any demo forcing: the purely
    observable side, which is what the model will rank on. Both halves of this
    function need it, and both were broken without it.

    SELECTION. Cases used to be drawn on `gsw_occurrence_pct` — "the 120 wettest
    towers". That column is 0 for 97.9% of towers, so the sort was ties at zero
    and "high exposure" was in practice a random site: two of four planted
    protected_sites came back with lambda 0.000 and 0.298, which cannot be a
    false positive because nothing ranks them high in the first place. Selection
    is now on `baseline` itself — the site's observable intensity — which is the
    quantity the story is actually about.

    FORCING. A fixed latent multiplier cannot flip an outcome any more.
    OBSERVABLE_LOG_SPREAD renormalises the observable side to ~5.5 standard
    deviations of log-intensity, so a plausible latent (build quality, drainage:
    a factor of two either way) moves a site a hundredth of the range. Instead a
    case states the rate it should BEHAVE at, as a quantile of the population,
    and the multiplier is solved for. "This site sits in the top decile on
    environment but behaves like a p15 site" is the definition of a protected
    site, and it is scale-free — it survives calibrate() rescaling everything.

    What that does NOT do is decide the outcome. The Poisson draw still runs
    unchanged, so a protected_site can still take a ticket by luck and the
    notebook reports observed_role either way. expected_role stays a falsifiable
    claim, which is the whole point of registering it before training.
    """
    cases: list[dict] = []
    taken: set[int] = set()
    ids = frame["tower_id"].to_numpy()
    states = frame["state"].to_numpy()

    total = baseline.sum(axis=1).to_numpy()
    ranked = np.argsort(-total)          # loudest observable environment first
    quiet = np.argsort(total)            # quietest first

    def behave_at(index: int, quantile: float) -> float:
        """Solve the demo multiplier so this site behaves like `quantile`."""
        target = float(np.quantile(total, quantile))
        multiplier = target / max(float(total[index]), 1e-12)
        latents.loc[index, "demo_multiplier"] = multiplier
        return round(multiplier, 6)

    slope = frame["slope_deg"].to_numpy()

    # How `expected_role` is to be CHECKED. Three kinds, and conflating them is
    # why this set used to read 5/33 even when the planting worked:
    #   confusion — the role is one of TP/FP/FN/TN and compares directly.
    #   pair      — the claim is about the PAIR (near-identical scores, opposite
    #               outcomes), so neither member can be judged alone. A pair the
    #               model cannot separate can only land {TN,FN} or {FP,TP} — one
    #               TN and one TP is not a stricter expectation, it is an
    #               impossible one.
    #   narrative — the role names a lesson ("count is not cost"), not a cell of
    #               the confusion matrix, so equality against observed_role is
    #               false by construction and must not be scored.
    KIND = {
        "protected_site": "confusion", "neglected_site": "confusion",
        "twin_pair": "pair",
    }

    def add(index: int, case_type: str, role: str, forced: dict, why: str) -> None:
        cases.append(
            {
                "tower_id": str(ids[index]),
                "state": str(states[index]),
                "case_type": case_type,
                "expected_role": role,
                "expectation_kind": KIND.get(case_type, "narrative"),
                "forced_latents": forced,
                "observable_percentile": round(
                    float((total < total[index]).mean() * 100), 1
                ),
                "why": why,
            }
        )

    # Behaviour targets, as population quantiles of the observable intensity.
    # QUIET is well below the base rate so a Poisson draw almost never fires;
    # LOUD is well above it so it almost always does. "Almost" is the point —
    # the draw still decides, and misses are reported as misses.
    QUIET, LOUD = 0.15, 0.97

    # 1. protected_site — loud environment, already remediated. Expected FP.
    #    Drawn from the top ~5% rather than the top ~13%: the claim is that the
    #    model DISPATCHES this site, so it has to clear the top-10% cut, and the
    #    observable ranking is only a proxy for the model's. At [:150] three of
    #    four landed at risk 0.19-0.68 against a cut around 0.7 — correctly
    #    ticket-free, but never dispatched, so true negatives instead of the
    #    false positives the case exists to show.
    for index in _pick(rng, ranked[:60], taken, 4):
        latents.loc[index, "has_drainage"] = 1
        latents.loc[index, "build_quality"] = 0.92
        multiplier = behave_at(index, QUIET)
        add(
            index, "protected_site", "false_positive",
            {"has_drainage": 1, "build_quality": 0.92, "behaves_at_pct": QUIET * 100,
             "demo_multiplier": multiplier},
            "Top-decile flood exposure, drainage already installed. The model "
            "ranks it on environment and cannot see the fix — this FP is the "
            "limit of environment, not model error.",
        )

    # 2. neglected_site — benign ground, bad workmanship, ancient genset.
    #    Expected FN: nothing in the environment says to send a crew.
    benign = [i for i in quiet[: len(frame) // 2] if slope[i] < 5.0]
    for index in _pick(rng, benign, taken, 4):
        latents.loc[index, "build_quality"] = 0.04
        latents.loc[index, "genset_age_years"] = 21.5
        latents.loc[index, "has_drainage"] = 0
        multiplier = behave_at(index, LOUD)
        add(
            index, "neglected_site", "false_negative",
            {"build_quality": 0.04, "genset_age_years": 21.5, "has_drainage": 0,
             "behaves_at_pct": LOUD * 100, "demo_multiplier": multiplier},
            "Benign environment, many tickets. Answers 'what would you miss?' — "
            "sites whose problem is workmanship, not geography.",
        )

    # 3. twin_pair — matched on the features the MODEL sees, opposite behaviour.
    #    Same environment, so the model must score them alike; the pair then
    #    diverges on hidden history alone. This is the irreducible ceiling.
    for left, right in _find_twin_pairs(frame, taken, n_pairs=6):
        latents.loc[left, "build_quality"] = 0.90
        latents.loc[left, "has_drainage"] = 1
        latents.loc[right, "build_quality"] = 0.10
        latents.loc[right, "has_drainage"] = 0
        quiet_mult, loud_mult = behave_at(left, QUIET), behave_at(right, LOUD)
        taken.update({left, right})
        why = (
            "Paired with a site the model cannot distinguish from it, with the "
            "opposite outcome. The irreducible ceiling made visible."
        )
        add(left, "twin_pair", "quiet_half",
            {"build_quality": 0.90, "behaves_at_pct": QUIET * 100,
             "demo_multiplier": quiet_mult}, why)
        add(right, "twin_pair", "loud_half",
            {"build_quality": 0.10, "behaves_at_pct": LOUD * 100,
             "demo_multiplier": loud_mult}, why)
        cases[-2]["partner_id"] = str(ids[right])
        cases[-1]["partner_id"] = str(ids[left])

    # 4. remediated_site — heavy early, fixed at month 14, quiet after. Needs a
    #    loud site: there is nothing to remediate on a site with no tickets.
    for index in _pick(rng, ranked[:250], taken, 3):
        latents.loc[index, "has_drainage"] = 0
        latents.loc[index, "remediated_at_month"] = 14.0
        multiplier = behave_at(index, LOUD)
        add(
            index, "remediated_site", "label_is_lossy",
            {"remediated_at_month": 14, "behaves_at_pct": LOUD * 100,
             "demo_multiplier": multiplier},
            "High 36-month count, but fixed 22 months ago. Shows why an aggregate "
            "target hides remediation, and why recency matters.",
        )

    # 5. new_commission — 8 months of exposure, not 36. Also needs a loud site,
    #    or "low count, high rate" has no count to be low.
    for index in _pick(rng, ranked[:250], taken, 3):
        latents.loc[index, "months_in_service"] = 8.0
        multiplier = behave_at(index, LOUD)
        add(
            index, "new_commission", "denominator_matters",
            {"months_in_service": 8, "behaves_at_pct": LOUD * 100,
             "demo_multiplier": multiplier},
            "Low raw count, high rate. The concrete reason a count target ranks "
            "it wrongly and an exposure offset is needed.",
        )

    # 6. cloud_shadowed — NOT planted. These are towers whose EVI genuinely came
    #    back masked. A real edge case beats a manufactured one, and if the fetch
    #    saw everything this case is legitimately absent rather than invented.
    cloudy = np.where(frame["evi_median"].isna().to_numpy())[0]
    for index in _pick(rng, cloudy, taken, 4):
        add(
            index, "cloud_shadowed", "missing_data_path", {},
            "Persistent cloud: no clear Sentinel-2 observation in a full year. "
            "LightGBM learns a split direction for NaN; the UI must show a real "
            "score with a caveat, never a blank or a zero.",
        )

    # 7. catastrophic — one very expensive ticket, low count. Drawn from the
    #    loud end so the ticket exists to be expensive.
    for index in _pick(rng, ranked[:400], taken, 2):
        latents.loc[index, "catastrophic"] = 1.0
        multiplier = behave_at(index, 0.90)
        add(
            index, "catastrophic", "count_is_not_cost",
            {"catastrophic": 1, "behaves_at_pct": 90.0, "demo_multiplier": multiplier},
            "Ranks low by ticket count, top by downtime. Opens the question of "
            "what the system should optimise, which this prototype does not "
            "answer.",
        )

    # 8. monsoon_locked — flood-dominant civil work inside the NE monsoon. Must
    #    land in the dispatch slice or the constraint never gets exercised, so
    #    it is drawn from the flood-dominant loud end rather than on raw GSW.
    flood_share = (baseline["flood"] / baseline.sum(axis=1).clip(lower=1e-12)).to_numpy()
    flood_loud = [i for i in ranked[:300] if flood_share[i] > 0.5]
    for index in _pick(rng, flood_loud, taken, 3):
        latents.loc[index, "has_drainage"] = 0
        multiplier = behave_at(index, LOUD)
        add(
            index, "monsoon_locked", "constraint_visible",
            {"has_drainage": 0, "behaves_at_pct": LOUD * 100,
             "demo_multiplier": multiplier},
            "Flood-dominant, civil crew. policy.yaml blocks civil work in flood "
            "zones Nov-Mar, so the optimizer must defer it and say why.",
        )

    # 9. lone_territory — a state with almost no crews.
    for index in _pick(rng, np.where(states == "Perlis")[0], taken, 1):
        latents.loc[index, "build_quality"] = 0.08
        behave_at(index, LOUD)
        add(
            index, "lone_territory", "capacity_edge", {"build_quality": 0.08},
            "Perlis has 2 towers in OSM. Either it schedules or it lands in "
            "`unscheduled` with a reason — both correct, provided it is stated.",
        )

    # 10. enclave — Kuala Lumpur sits wholly inside Selangor.
    for index in _pick(rng, np.where(states == "Kuala Lumpur")[0], taken, 1):
        latents.loc[index, "build_quality"] = 0.12
        behave_at(index, LOUD)
        add(
            index, "enclave", "territory_assignment", {"build_quality": 0.12},
            "An enclave state wholly inside another. Exercises assign_states' "
            "smallest-state-first rule live.",
        )

    if len(cases) > MAX_DEMO_CASES:
        raise SystemExit(
            f"{len(cases)} demo cases exceeds the {MAX_DEMO_CASES} cap. Past this "
            "the metrics describe the edge cases rather than the model."
        )
    return cases


# --- Task 4c: hazard mechanisms -------------------------------------------
def build_telemetry(rng, tower_ids, lambda_true: np.ndarray) -> pd.DataFrame:
    """Current-period counters per site: informative, and untrainable.

    Standardised log intensity plus gaussian noise per column, then mapped to
    non-negative counts so the file reads like a real export rather than a
    z-score. The ordering is what matters and the exponential map is monotone,
    so it changes nothing a detector sees.

    Drawn from its OWN generator, seeded from the caller's, for the same reason
    ticket detail is (see simulate): drawing from the shared stream would make
    the recorded run and the calibration bisection walk different Poisson
    streams, which is a bug this file has already had once.
    """
    lam = np.log(np.maximum(np.asarray(lambda_true, dtype=float), 1e-12))
    lam = (lam - lam.mean()) / (lam.std() + 1e-12)
    out = {"tower_id": np.asarray(tower_ids)}
    for column, loading in TELEMETRY_LOADINGS.items():
        z = loading * lam + TELEMETRY_NOISE * rng.normal(size=len(lam))
        out[column] = np.round(np.expm1(np.clip(z, -3.0, 6.0) + 1.5), 2).clip(0.0)
    return pd.DataFrame(out)


def rare_configuration(frame: pd.DataFrame) -> np.ndarray:
    """Hazard multiplier for sites in an unusual environmental configuration.

    Mahalanobis distance over RARE_CONFIG_COLUMNS, converted to a percentile
    rank, then a linear ramp from 1.0 at RARE_CONFIG_QUANTILE to
    RARE_CONFIG_BOOST at the most unusual site. Smooth and strictly monotone in
    the distance — see the constant's note for why that still leaves it hard to
    learn.

    Columns are standardised first, and the covariance is inverted with pinv
    rather than inv: two of these columns are strongly correlated (slope and
    tri) and a singular covariance would otherwise raise on a subset of the
    data or, worse, return numerical noise scaled to infinity.

    Missing values take the column median. That is imputation, which the serving
    path refuses to do — but this is the generator deciding a site's hidden
    truth, not a model claiming an observation it does not have. A site whose
    soil grid has a hole is not thereby unusual.

    Returns all-ones when the boost is disabled or fewer than two usable
    columns are present, so the term can be switched off without a branch at
    the call site.
    """
    if RARE_CONFIG_BOOST <= 1.0:
        return np.ones(len(frame))
    present = [c for c in RARE_CONFIG_COLUMNS if c in frame.columns]
    if len(present) < 2:
        return np.ones(len(frame))

    matrix = frame[present].astype(float)
    matrix = matrix.fillna(matrix.median())
    values = matrix.to_numpy()
    values = (values - values.mean(axis=0)) / (values.std(axis=0) + 1e-12)

    precision = np.linalg.pinv(np.cov(values, rowvar=False))
    centred = values - values.mean(axis=0)
    distance = np.sqrt(np.maximum(np.einsum("ij,jk,ik->i", centred, precision, centred), 0.0))

    rank = pd.Series(distance).rank(pct=True).to_numpy()
    excess = np.clip((rank - RARE_CONFIG_QUANTILE) / (1.0 - RARE_CONFIG_QUANTILE), 0.0, 1.0)
    return 1.0 + (RARE_CONFIG_BOOST - 1.0) * excess


def _ramp(x: np.ndarray, onset: float, span: float) -> np.ndarray:
    """Linear 0->1 across [onset, onset+span], clipped outside. Monotone."""
    return np.clip((x - onset) / span, 0.0, 1.0)


def cause_intensities(frame: pd.DataFrame, latents: pd.DataFrame) -> pd.DataFrame:
    """Monthly Poisson intensity per site per cause, before calibration.

    Every response is monotone in its driver and smooth. The interaction, the
    hump and the cliff that used to be here were the planted traps; they are
    gone, and so is the per-state multiplier. What is left is a hazard a
    gradient-boosted tree can recover from the observed columns, which is the
    point of the retune and also its whole cost — see the module docstring.

    `hand_m` and `slope_deg` now drive hazard (they deliberately did not
    before). The forms are still ours: a shape-1.5 decay in HAND and a linear
    slope ramp, not the index's logistic memberships.
    """

    def column(name: str, default: float, *, median_fill: bool = True) -> np.ndarray:
        if name not in frame:
            return np.full(len(frame), default)
        values = frame[name]
        fill = values.median() if median_fill and values.notna().any() else default
        return values.fillna(fill).to_numpy(dtype=float)

    def soften(multiplier) -> np.ndarray:
        """Pull a latent multiplier toward 1 by LATENT_STRENGTH."""
        return 1.0 + LATENT_STRENGTH * (np.asarray(multiplier, dtype=float) - 1.0)

    gsw = column("gsw_occurrence_pct", 0.0) / 100.0
    moisture_p90 = column("soil_moisture_p90", 0.35)
    clay = column("clay_pct", 30.0)
    evi = column("evi_median", 0.45)
    # A cloud gap must not invent median regrowth and hence a synthetic charge.
    evi_rate = column("evi_delta_per_year", 0.0, median_fill=False)
    dist_power = column("dist_power_m", 2000.0)
    dist_water = column("dist_water_m", 2000.0)
    hand = np.maximum(column("hand_m", 5.0), 0.0)
    slope = column("slope_deg", 3.0)
    tri = column("tri", 5.0)
    built_up = (
        frame.get("land_cover_class", pd.Series(0, index=frame.index)) == 50
    ).to_numpy().astype(float)

    drainage = latents["has_drainage"].to_numpy(dtype=float)
    build_quality = latents["build_quality"].to_numpy(dtype=float)
    genset_age = latents["genset_age_years"].to_numpy(dtype=float)
    road = (
        latents["access_road_class"]
        .map({"sealed": 0.6, "gravel": 1.0, "track": 1.6})
        .to_numpy(dtype=float)
    )
    foundation = (
        latents["foundation_type"]
        .map({"pile": 0.55, "raft": 0.9, "pad": 1.35})
        .to_numpy(dtype=float)
    )
    radio_burden = frame["radio"].map(RADIO_BURDEN).fillna(0.45).to_numpy(dtype=float)
    tri_norm = tri / (np.nanmax(tri) + 1e-9)

    out = pd.DataFrame(index=frame.index)

    # Flood: four monotone routes to water standing in a compound — mapped
    # water history, saturated ground, low height above drainage, proximity to
    # a watercourse — all suppressed by drainage.
    #
    # The wetness term is not decoration. JRC GSW occurrence is 0 for 97.9% of
    # these towers (OSM masts are mostly not beside mapped water bodies), so a
    # purely GSW-driven flood cause produced 6 tickets nationally and the
    # project's headline factor was effectively dead.
    low_ground = 1.0 / (1.0 + np.power(hand / HAND_SCALE_M, HAND_SHAPE))
    out["flood"] = soften(1.0 - 0.45 * drainage) * (
        1.20 * np.power(gsw, 0.7)
        + 0.90 * _ramp(moisture_p90, MOISTURE_ONSET, MOISTURE_SPAN)
        + 0.80 * low_ground
        + 0.35 * np.exp(-dist_water / WATER_SCALE_M)
    )

    # Terrain: roughness, slope and clay content, each on its own. The
    # clay x wetness interaction that used to gate this term is removed.
    out["terrain"] = soften(road) * (
        0.55 * np.power(tri_norm, 1.3) + 0.60 * _ramp(slope, 0.0, SLOPE_FULL_DEG)
    ) + soften(foundation) * 0.50 * _ramp(clay, CLAY_ONSET, CLAY_SPAN)

    # Vegetation: a monotone ramp in greenness. The mid-EVI hump is removed.
    out["vegetation"] = (
        0.90 * _ramp(evi, EVI_ONSET, EVI_SPAN) * (1.0 - 0.40 * built_up)
        + ENCROACHMENT_GAIN * _ramp(evi_rate, ENCROACHMENT_ONSET, ENCROACHMENT_SPAN)
    )

    # Power: smooth saturation in distance to grid. The cliff is removed.
    out["power"] = (
        0.85
        * (1.0 - np.exp(-dist_power / POWER_SCALE_M))
        * soften(genset_age / 11.0)
    )

    # Equipment: air-interface generation. Weak by construction, because 96% of
    # OSM masts carry no radio tag.
    out["equipment"] = 0.45 * radio_burden

    # Renormalise the observable side to a fixed log-spread before the latent
    # multiply, so the boost applies to what the model could in principle learn
    # rather than to the latent noise layered on top. Proportional rescale per
    # row keeps the relative cause shares — and hence dominant_factor and the
    # attribution panel — exactly as computed above; only magnitude changes.
    total = out.sum(axis=1).to_numpy()
    log_total = np.log(np.maximum(total, 1e-12))
    z = (log_total - log_total.mean()) / (log_total.std() + 1e-12)
    out = out.mul(np.exp(OBSERVABLE_LOG_SPREAD * z) / (total + 1e-12), axis=0)

    # Rare-configuration boost. Applied AFTER the log-spread renormalisation on
    # purpose: that step rescales the summed observable intensity to a fixed
    # spread, so a term folded in before it would be squeezed back out and the
    # knob would not mean what its name says. Applied to every cause equally, so
    # relative cause shares — and therefore dominant_factor and the attribution
    # panel — are untouched, the same argument _saturate() makes for its cap.
    out = out.mul(rare_configuration(frame), axis=0)

    # Latent site frailty and workmanship, applied to every cause: these are
    # what the model can never see, and they are what keeps the oracle below 1.
    hidden = soften(latents["site_frailty"].to_numpy(dtype=float)) * soften(
        1.20 - 0.40 * build_quality
    )
    # The demo multiplier is NOT softened. LATENT_STRENGTH exists to control how
    # much hidden history the population carries; a demo case is by definition a
    # site whose hidden history is extreme, and attenuating it to 0.15 is what
    # silently killed every planted story after the retune.
    return out.mul(hidden * latents["demo_multiplier"].to_numpy(dtype=float), axis=0)


# --- simulation ------------------------------------------------------------
def _month_starts(end: date, months: int) -> list[date]:
    """First-of-month dates for the window ending at `end`."""
    starts, year, month = [], end.year, end.month
    for _ in range(months):
        month -= 1
        if month == 0:
            year, month = year - 1, 12
        starts.append(date(year, month, 1))
    return sorted(starts)


def simulate(
    rng, frame, latents, intensities, scale, monsoon_months, end, record: bool,
    monthly: bool = False,
):
    """Poisson draws per site, per month, per cause.

    `lambda_true` is summed HERE, before any reporting noise, because it is the
    oracle: contaminate it and the ceiling the notebook reports is not a ceiling.

    `record=False` skips ticket construction and returns counts only — what the
    base-rate bisection calls a few dozen times.

    `monthly=True` additionally accumulates and returns `monthly_lambda`, shape
    (HISTORY_MONTHS, n_towers) — the oracle intensity for each individual
    tower-month, summed across causes. build_panel() needs this to score a
    monthly row against the *same* generative process's ground truth, rather
    than the 36-month aggregate `lambda_true` every other caller uses.
    Returned as a fourth tuple element rather than always present, so every
    existing 3-value call site — calibrate(), the test suite — is unaffected;
    only build_panel() passes monthly=True and unpacks four values.
    """
    months = _month_starts(end, HISTORY_MONTHS)
    exposure = latents["months_in_service"].to_numpy(dtype=float)
    remediated = latents["remediated_at_month"].to_numpy(dtype=float)
    catastrophic = latents["catastrophic"].fillna(0.0).to_numpy(dtype=float)

    ids = frame["tower_id"].to_numpy()
    values = {cause: intensities[cause].to_numpy() * scale for cause in CAUSES}

    if record:
        # An uncalibrated scale is silent and expensive: cause_intensities()
        # renormalises to a fixed log-spread, so scale=1.0 on a frame calibrate()
        # would have put at ~3e-4 asks for tens of millions of ticket dicts and
        # simply never returns. Raise instead of hanging.
        expected = float(sum(intensities[c].sum() for c in CAUSES) * scale * HISTORY_MONTHS)
        if expected > MAX_TICKETS:
            raise ValueError(
                f"scale={scale:g} implies ~{expected:,.0f} tickets (cap {MAX_TICKETS:,}). "
                "Pass a scale from calibrate(), not a literal."
            )

    # Ticket DETAIL (dates, downtime, cost) draws from its own generator, seeded
    # once from the caller's. Without this the recorded run and the counts-only
    # run walk different Poisson streams — recording consumes extra draws inside
    # the month loop — so calibrate(), which runs with record=False, cannot
    # predict the base rate of the run actually emitted. It was out by 1.5
    # points (0.212 calibrated vs 0.228 shipped) before the split, and the
    # module docstring's claim that the two share a seed was only half true:
    # same seed, divergent stream. The seed is drawn UNCONDITIONALLY so both
    # modes consume it identically.
    detail_rng = np.random.default_rng(int(rng.integers(np.iinfo(np.int64).max)))

    tickets: list[dict] = []
    lambda_true = np.zeros(len(frame))
    counts = np.zeros(len(frame), dtype=int)
    monthly_lambda = np.zeros((len(months), len(frame))) if monthly else None

    for position, month_start in enumerate(months):
        # A site commissioned late has no history before it existed.
        in_service = position >= (HISTORY_MONTHS - exposure)
        monsoon = month_start.month in monsoon_months
        fixed = np.isfinite(remediated) & (position >= remediated)

        month_rates = {}
        for cause in CAUSES:
            rate = values[cause].copy()
            if cause in ("flood", "terrain"):
                # The NE monsoon is when water actually arrives. Read from
                # policy.yaml, never a literal, so the synthetic history cannot
                # contradict the scheduler's own monsoon window.
                rate = rate * (1.9 if monsoon else 0.75)
            if cause == "flood":
                rate = np.where(fixed, rate * 0.12, rate)
            month_rates[cause] = np.where(in_service, rate, 0.0)

        month_rates = _saturate(month_rates)

        for cause in CAUSES:
            rate = month_rates[cause]

            lambda_true += rate
            if monthly:
                monthly_lambda[position] += rate
            drawn = rng.poisson(rate)
            counts += drawn
            if not record:
                continue

            for index in np.nonzero(drawn)[0]:
                for _ in range(int(drawn[index])):
                    opened = month_start + timedelta(
                        days=int(detail_rng.integers(0, 28))
                    )
                    heavy = catastrophic[index] > 0 and detail_rng.random() < 0.5
                    tickets.append(
                        {
                            "tower_id": str(ids[index]),
                            "opened_date": opened,
                            "closed_date": opened
                            + timedelta(days=int(detail_rng.integers(1, 6))),
                            "root_cause": cause,
                            "downtime_hours": round(
                                float(detail_rng.gamma(2.0, 3.0) * (14.0 if heavy else 1.0)), 1
                            ),
                            "cost_myr": int(
                                detail_rng.gamma(2.0, 1400.0) * (20.0 if heavy else 1.0)
                            ),
                            "is_corrective": True,
                        }
                    )
    if monthly:
        return tickets, lambda_true, counts, monthly_lambda
    return tickets, lambda_true, counts


def _saturate(month_rates: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Soft-cap a site's monthly corrective rate at MAX_MONTHLY_RATE.

    OBSERVABLE_LOG_SPREAD renormalises the observable side to ~5.5 standard
    deviations of LOG intensity, which is a ratio of about 1e14 between the
    quietest and loudest site. The binary label stops caring above lambda ~3
    (P(>=1 ticket) = 0.95), so the far tail buys no discrimination — but the
    Poisson draw still honours it, and the shipped register had a tower with
    2,199 corrective orders in 36 months. That is ~60 a month on one mast: not a
    maintenance record, and anything reading `n_corrective_36mo`,
    `downtime_hours` or `cost_myr` as a quantity inherits the nonsense.

    `x -> c(1 - exp(-x/c))` is the cap, and the shape is the whole point:

      * STRICTLY MONOTONE, so no two sites swap order. `lambda_true` is the
        oracle and the report's ceiling; a cap that reordered sites would move
        that ceiling and quietly invalidate the leak check.
      * Identity near zero (x << c gives x - x^2/2c), so the sites where the
        label is actually decided are untouched and the base rate barely moves.
      * Asymptotic to c, so the tail compresses instead of being clipped to a
        tie. A hard `np.minimum` would flatten the whole top decile onto one
        value and destroy the oracle's ranking within it.

    Applied to the row TOTAL and shared back proportionally, so per-cause shares
    — and therefore dominant_factor and the attribution panel — are unchanged.
    """
    total = sum(month_rates.values())
    capped = MAX_MONTHLY_RATE * (1.0 - np.exp(-total / MAX_MONTHLY_RATE))
    factor = np.divide(capped, total, out=np.ones_like(total), where=total > 0)
    return {cause: rate * factor for cause, rate in month_rates.items()}


def calibrate(frame, latents, intensities, monsoon_months, end, seed) -> float:
    """Bisect one common intensity scale until the base rate hits the target.

    Bisected rather than hand-tuned, so the constant is reproducible and its
    value is justified by a stated target rather than by taste.

    The bisection draws with the SAME rng seed the recorded simulation will use
    (`seed + 1`). Using a different one made the achieved base rate scatter
    around the target by up to two points purely from Poisson noise, which then
    read as planting having moved the headline when it had not. Calibrating
    against the draw actually emitted also makes the shipped dataset hit its
    stated target exactly, rather than approximately.
    """
    # Floor is 1e-9, not 1e-3. The needed scale falls as the observable spread
    # widens, and a floor above it makes bisection return the floor itself —
    # silently, with a base rate well above target and no error raised. That
    # shipped: at the tuned spread the required scale is ~3e-4.
    low, high, scale = 1e-9, 5.0, 1.0
    for _ in range(60):
        scale = (low + high) / 2
        _, _, counts = simulate(
            np.random.default_rng(seed + 1),
            frame, latents, intensities, scale, monsoon_months, end, record=False,
        )
        rate = float((counts > 0).mean())
        if abs(rate - TARGET_BASE_RATE) < BASE_RATE_TOLERANCE:
            return scale
        low, high = (low, scale) if rate > TARGET_BASE_RATE else (scale, high)
    return scale


# --- reporting noise and dirt ---------------------------------------------
def apply_reporting_noise(rng, tickets: list[dict], ids: np.ndarray) -> list[dict]:
    """Drop, misfile, and add preventive visits. Applied LAST.

    Real registers are incomplete and partly wrong. A generator that emits a
    perfect account of what happened is modelling a world nobody works in.
    """
    kept = [t for t in tickets if rng.random() > DROP_RATE]

    for _ in range(int(len(tickets) * SPURIOUS_RATE)):
        if not kept:
            break
        misfiled = dict(kept[int(rng.integers(0, len(kept)))])
        misfiled["tower_id"] = str(ids[int(rng.integers(0, len(ids)))])
        kept.append(misfiled)

    # Preventive visits: scheduled, not corrective. Excluded from the label.
    expected = PREVENTIVE_PER_YEAR * HISTORY_MONTHS / 12.0
    for tower_id, count in zip(ids, rng.poisson(expected, len(ids))):
        for _ in range(int(count)):
            opened = date(2023, 9, 1) + timedelta(days=int(rng.integers(0, 1050)))
            kept.append(
                {
                    "tower_id": str(tower_id),
                    "opened_date": opened,
                    "closed_date": opened + timedelta(days=1),
                    "root_cause": "scheduled_inspection",
                    "downtime_hours": round(float(rng.gamma(1.5, 1.0)), 1),
                    "cost_myr": int(rng.gamma(2.0, 350.0)),
                    "is_corrective": False,
                }
            )
    return kept


def inject_malformed(tickets: list[dict]) -> list[dict]:
    """Three deliberate defects, of the kind every real export carries.

    They live in maintenance_records.csv only. build_labels rejects each and
    COUNTS the rejection — a silent drop here is the same failure class as the
    partial cache that once produced a 97%-smaller dataset.
    """
    if len(tickets) < 3:
        return tickets
    out = list(tickets)

    reversed_dates = dict(out[0])
    reversed_dates["closed_date"] = reversed_dates["opened_date"] - timedelta(days=3)
    reversed_dates["_defect"] = "closed_before_opened"
    out.append(reversed_dates)

    duplicate = dict(out[1])
    duplicate["_defect"] = "duplicate_ticket_id"
    out.append(duplicate)

    orphan = dict(out[2])
    orphan["tower_id"] = "MY_ORPHAN_0001"
    orphan["_defect"] = "unknown_tower_id"
    out.append(orphan)
    return out


# --- labels ----------------------------------------------------------------
def build_labels(tickets: pd.DataFrame, frame, latents, lambda_true):
    """Ticket rows -> the site-level target, rejecting malformed rows loudly."""
    known = set(frame["tower_id"])
    unknown = ~tickets["tower_id"].isin(known)
    bad_dates = pd.to_datetime(tickets["closed_date"]) < pd.to_datetime(
        tickets["opened_date"]
    )
    duplicated = tickets["ticket_id"].duplicated(keep="first")

    rejected = {
        "unknown_tower_id": int(unknown.sum()),
        "closed_before_opened": int(bad_dates.sum()),
        "duplicate_ticket_id": int(duplicated.sum()),
    }
    valid = tickets[~(unknown | bad_dates | duplicated)].copy()

    counts = valid[valid["is_corrective"]].groupby("tower_id").size()

    labels = pd.DataFrame(
        {
            "tower_id": frame["tower_id"],
            "state": frame["state"],
            "n_corrective_36mo": frame["tower_id"].map(counts).fillna(0).astype(int),
            "months_in_service": latents["months_in_service"].to_numpy(),
            "lambda_true": np.round(lambda_true, 6),
        }
    )
    labels["needed_corrective_maintenance"] = (labels["n_corrective_36mo"] > 0).astype(int)
    return labels, valid, rejected


# --- monthly panel (real-world CBM framing) --------------------------------
# The 36-month aggregate above answers "did this tower ever need a corrective
# visit". Real condition-based maintenance systems answer a narrower, more
# useful question every planning cycle: "will this tower need one within the
# next PREDICTION_HORIZON_MONTHS", using recency and history features no
# snapshot-per-tower table can carry — how long since the last visit, how
# many visits so far, whether the upcoming window falls in the monsoon.
#
# The label looks FORWARD (does a ticket occur in [m, m+horizon)) — that is
# what a supervised target is supposed to do. What must never leak, and does
# not: months_since_last_corrective and n_corrective_to_date use only tickets
# strictly BEFORE month m, the same information a real planner has on the
# first day of that window, before looking forward at all.
#
# A single literal month (horizon=1) was tried first and produces a per-row
# base rate of 0.94% — technically correct, but PR-AUC collapsed to a tenth of
# the 36-month aggregate's, purely from base-rate arithmetic (PR-AUC scales
# with prevalence; this is not a statement about the model or the features).
# horizon=6 lands the rate around 5-6%, workable for a classifier and the same
# planning-cycle length real inspection/maintenance programmes actually use —
# "does this need attention sometime in the next cycle", not "in this literal
# instant".
PREDICTION_HORIZON_MONTHS = 6
NEVER_SERVICED_SENTINEL = float(HISTORY_MONTHS)  # censored: no prior ticket in the window


def build_panel(
    frame: pd.DataFrame,
    latents: pd.DataFrame,
    valid_tickets: pd.DataFrame,
    monthly_lambda: np.ndarray,
    monsoon_months: list[int],
    end: date,
    horizon: int = PREDICTION_HORIZON_MONTHS,
) -> pd.DataFrame:
    """One row per (tower_id, month) with a full forward window still inside
    the simulated history — the last `horizon` months per tower are censored,
    same as a real deployment: you cannot label "needed service in the next 6
    months" for a month where you do not yet have 6 months of subsequent data.

    `monthly_lambda` is simulate()'s per-month oracle intensity (monthly=True),
    row-aligned to `frame` and to the same `months` list this function derives
    independently from `end` — the two must describe the same window, which is
    why both are always built from the same `end` and HISTORY_MONTHS.
    """
    months = _month_starts(end, HISTORY_MONTHS)
    month_index = {(m.year, m.month): i for i, m in enumerate(months)}

    corrective = valid_tickets[valid_tickets["is_corrective"]].copy()
    corrective["month_position"] = [
        month_index.get((d.year, d.month)) for d in corrective["opened_date"]
    ]
    # Ticket dates are always drawn inside the month that generated them
    # (simulate() adds 0-27 days to month_start), so every valid ticket's
    # opened_date must resolve to a real position in this same window.
    corrective = corrective.dropna(subset=["month_position"])
    tickets_by_tower = {
        tower_id: sorted(int(p) for p in group["month_position"])
        for tower_id, group in corrective.groupby("tower_id")
    }

    exposure = latents["months_in_service"].to_numpy(dtype=float)
    last_labelable = HISTORY_MONTHS - horizon  # exclusive upper bound
    rows: list[dict] = []

    for row_index, tower in enumerate(frame.itertuples(index=False)):
        tower_id = tower.tower_id
        state = tower.state
        first_month = int(HISTORY_MONTHS - exposure[row_index])  # 0 if in service throughout
        ticket_months = tickets_by_tower.get(tower_id, [])
        had_ticket = np.zeros(HISTORY_MONTHS, dtype=bool)
        for m in ticket_months:
            had_ticket[m] = True
        cumulative_before = np.concatenate(([0], np.cumsum(had_ticket)))[:HISTORY_MONTHS]

        last_seen = -1
        for position in range(first_month, last_labelable):
            since_last = (
                float(position - last_seen) if last_seen >= 0 else NEVER_SERVICED_SENTINEL
            )
            window = slice(position, position + horizon)
            rows.append(
                {
                    "tower_id": tower_id,
                    "state": state,
                    "month": months[position].isoformat(),
                    "months_since_last_corrective": since_last,
                    "n_corrective_to_date": int(cumulative_before[position]),
                    "is_monsoon_month": int(months[position].month in monsoon_months),
                    "needed_corrective_within_horizon": int(had_ticket[window].any()),
                    # P(>=1 ticket in the window) under the same Poisson process
                    # simulate() draws from — the oracle for THIS row's target.
                    "lambda_true_window": round(
                        float(monthly_lambda[window, row_index].sum()), 6
                    ),
                }
            )
            if had_ticket[position]:
                last_seen = position

    return pd.DataFrame(rows)


# --- assembly --------------------------------------------------------------
def prepare(args) -> dict:
    rng = np.random.default_rng(args.seed)
    frame = load_inputs(args.tower_table, args.land_features, args.land_change)
    policy = load_policy()
    monsoon_months = list(policy["monsoon"]["months"])
    end = date.fromisoformat(policy["demo_clock"]["today"]).replace(day=1)

    latents = draw_latents(rng, frame)
    # Twice on purpose. The first pass is the purely observable intensity — what
    # the model will rank on — and plant_demo_cases() both selects and calibrates
    # against it. The second pass carries the demo multipliers it set.
    baseline = cause_intensities(frame, latents)
    cases = plant_demo_cases(rng, frame, latents, baseline) if args.plant else []
    intensities = cause_intensities(frame, latents)

    scale = calibrate(frame, latents, intensities, monsoon_months, end, args.seed)
    tickets, lambda_true, _, monthly_lambda = simulate(
        np.random.default_rng(args.seed + 1),
        frame, latents, intensities, scale, monsoon_months, end, record=True,
        monthly=True,
    )

    ids = frame["tower_id"].to_numpy()
    noisy = apply_reporting_noise(np.random.default_rng(args.seed + 2), tickets, ids)
    noisy = inject_malformed(noisy)

    records = pd.DataFrame(noisy)
    if "_defect" not in records:
        records["_defect"] = None
    records = records.sort_values(
        ["opened_date", "tower_id"], kind="stable"
    ).reset_index(drop=True)

    actions = records["root_cause"].map(
        lambda c: CAUSE_ACTIONS.get(c, ("scheduled_inspection", "civil"))
    )
    records["work_type"] = [a[0] for a in actions]
    records["crew_type"] = [a[1] for a in actions]
    records.insert(0, "ticket_id", [f"WO_{i:06d}" for i in range(1, len(records) + 1)])

    # The duplicate defect must survive as a duplicate ID rather than be
    # renumbered into a distinct, valid ticket.
    duplicate_rows = records.index[records["_defect"] == "duplicate_ticket_id"]
    for row in duplicate_rows:
        twin = records[
            (records["tower_id"] == records.at[row, "tower_id"])
            & (records["opened_date"] == records.at[row, "opened_date"])
            & (records["_defect"].isna())
        ]
        if len(twin):
            records.at[row, "ticket_id"] = twin.iloc[0]["ticket_id"]

    labels, valid, rejected = build_labels(records, frame, latents, lambda_true)
    base_rate = float(labels["needed_corrective_maintenance"].mean())
    if abs(base_rate - TARGET_BASE_RATE) > BASE_RATE_TOLERANCE:
        raise ValueError(f"Generated base rate {base_rate:.4f} is outside calibration tolerance")
    panel = build_panel(frame, latents, valid, monthly_lambda, monsoon_months, end)

    columns = [
        "ticket_id", "tower_id", "opened_date", "closed_date", "work_type",
        "crew_type", "root_cause", "downtime_hours", "cost_myr", "is_corrective",
    ]
    args.records.parent.mkdir(parents=True, exist_ok=True)
    records[columns].to_csv(args.records, index=False)
    labels.to_csv(args.labels, index=False)
    panel.to_csv(args.panel, index=False)
    telemetry = build_telemetry(
        np.random.default_rng(args.seed + 77_000), frame["tower_id"].to_numpy(), lambda_true
    )
    telemetry.to_csv(args.telemetry, index=False)

    manifest = {
        "synthetic": True,
        "generator_version": GENERATOR_VERSION,
        "encroachment_term": True,
        "encroachment_gain": ENCROACHMENT_GAIN,
        "encroachment_measured": int(frame.get("evi_delta_per_year", pd.Series(dtype=float)).notna().sum()),
        "encroachment_note": (
            "The synthetic label deliberately carries measured EVI growth so change "
            "detection can be tested rather than guaranteed null. This grades our "
            "own generator, not real-world maintenance. Missing change adds no charge."
        ),
        "seed": args.seed,
        "telemetry": {
            "columns": TELEMETRY_COLUMNS,
            "noise": TELEMETRY_NOISE,
            "window_days": 30,
            "note": ("Current-period counters. Predictive but UNTRAINABLE here: "
                     "the counters cover 30 days and the label covers 36 months, "
                     "so no aligned (telemetry, outcome) pair exists. "
                     "model/maintenance_need.py's FEATURES excludes it by design; "
                     "model/novelty.py reads it because an unsupervised layer "
                     "needs no labels."),
        },
        "history_months": HISTORY_MONTHS,
        "window": [_month_starts(end, HISTORY_MONTHS)[0].isoformat(), end.isoformat()],
        "towers": int(len(frame)),
        "tickets_written": int(len(records)),
        "tickets_valid": int(len(valid)),
        "rejected_tickets": rejected,
        "base_rate": round(float(labels["needed_corrective_maintenance"].mean()), 4),
        "target_base_rate": TARGET_BASE_RATE,
        "calibrated_scale": round(scale, 6),
        "reporting_noise": {
            "drop_rate": DROP_RATE,
            "spurious_rate": SPURIOUS_RATE,
            "preventive_per_year": PREVENTIVE_PER_YEAR,
        },
        "demo_cases": len(cases),
        "panel": {
            "rows": int(len(panel)),
            "towers": int(panel["tower_id"].nunique()),
            "base_rate": round(float(panel["needed_corrective_within_horizon"].mean()), 4),
            "horizon_months": PREDICTION_HORIZON_MONTHS,
        },
        "caveat": (
            "SYNTHETIC. No operator or MCMC maintenance history was available for "
            "this prototype, so these records are simulated. Figures computed "
            "against them validate the evaluation pipeline, not real-world "
            "accuracy, and will change when real work orders arrive."
        ),
        "not_a_failure_label": (
            "The target is 'a corrective work order was raised'. It is not an "
            "outage, a fault, or a probability of one."
        ),
    }
    write_json(args.manifest, manifest)
    write_json(
        args.demo_cases,
        {
            "synthetic": True,
            "seed": args.seed,
        "telemetry": {
            "columns": TELEMETRY_COLUMNS,
            "noise": TELEMETRY_NOISE,
            "window_days": 30,
            "note": ("Current-period counters. Predictive but UNTRAINABLE here: "
                     "the counters cover 30 days and the label covers 36 months, "
                     "so no aligned (telemetry, outcome) pair exists. "
                     "model/maintenance_need.py's FEATURES excludes it by design; "
                     "model/novelty.py reads it because an unsupervised layer "
                     "needs no labels."),
        },
            "note": (
                "Planted before training by forcing latent draws, never by writing "
                "labels. expected_role is the intent; the notebook reports "
                "observed_role, including disagreements."
            ),
            "budget": {"planted": len(cases), "cap": MAX_DEMO_CASES},
            "cases": cases,
        },
    )
    return manifest


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--tower-table", type=Path, default=TOWER_TABLE)
    p.add_argument("--land-features", type=Path, default=LAND_FEATURES)
    p.add_argument("--land-change", type=Path, default=LAND_CHANGE)
    p.add_argument("--records", type=Path, default=RECORDS_CSV)
    p.add_argument("--labels", type=Path, default=LABELS_CSV)
    p.add_argument("--panel", type=Path, default=PANEL_CSV)
    p.add_argument("--telemetry", type=Path, default=TELEMETRY_CSV)
    p.add_argument("--manifest", type=Path, default=MANIFEST)
    p.add_argument("--demo-cases", type=Path, default=DEMO_CASES)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument(
        "--no-plant",
        dest="plant",
        action="store_false",
        help="skip demo-case planting — used by the test asserting that planting "
        "does not move the headline metrics",
    )
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    manifest = prepare(args)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    print(f"\nwrote {args.records}\n      {args.labels}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
