"""Unit tests for the synthetic maintenance-record generator.

Network-free and synthetic — every frame here is built in memory, which is what
keeps the suite offline. A label generator is the easiest thing in this repo to
fool yourself with, because it always produces a dataset and a dataset always
trains a model. The guards are about the specific ways this could produce
numbers that mean nothing:

  * the generator quietly reproducing the physical index, which is how the
    withdrawn maintenance_classifier scored 0.974 AUC on nothing;
  * latents carrying no real variance, so a perfect model could reach PR-AUC 1.0
    and the reported ceiling would be a fiction;
  * lambda_true contaminated by reporting noise, making the oracle not an oracle;
  * planted demo cases heavy enough that the metrics describe the edge cases
    rather than the model;
  * malformed rows dropped silently instead of rejected and counted — the same
    failure class as the partial cache that once produced a 97%-smaller dataset;
  * a target-derived column wandering into FEATURES.

The planted-trap tests (interaction, non-monotone response, threshold cliff,
per-state effect) were removed with the traps themselves. What replaced them is
test_hazard_responses_are_monotone, which pins the shapes that took their place.

Run from src/backend/data:  python3 test_maintenance_records.py  (or via pytest)
"""

import ast
import sys
from datetime import date
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_BACKEND = _THIS_DIR.parent
for _p in (str(_BACKEND), str(_THIS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import numpy as np
import pandas as pd

import prepare_maintenance_records as gen
from model.maintenance_need import FEATURES, build_matrix

STATES = ["Selangor", "Johor", "Kedah", "Perlis", "Kuala Lumpur", "Sarawak"]
MONSOON = [11, 12, 1, 2, 3]
END = date(2026, 8, 1)


def _frame(n=400, seed=0, cloudy=0):
    """A tower table joined to land features, all synthetic."""
    rng = np.random.default_rng(seed)
    hand = rng.gamma(2.0, 6.0, n)
    frame = pd.DataFrame(
        {
            "tower_id": [f"MY_T{i:05d}" for i in range(n)],
            "lon": rng.uniform(100.0, 119.0, n),
            "lat": rng.uniform(1.0, 6.5, n),
            "state": rng.choice(STATES, n),
            "radio": rng.choice(
                ["UNKNOWN", "LTE", "GSM", "UMTS", "NR"],
                n,
                p=[0.9, 0.04, 0.03, 0.02, 0.01],
            ),
            "hand_m": hand,
            "dist_water_m": rng.exponential(80.0 + 40.0 * hand, n),
            "slope_deg": rng.gamma(2.0, 4.0, n),
            "tri": rng.gamma(2.0, 3.0, n),
            "elevation_m": rng.uniform(0, 1500, n),
            "dist_power_m": rng.exponential(2500.0, n),
            "evi_median": np.clip(rng.normal(0.45, 0.15, n), 0.02, 0.95),
            "evi_p10": np.clip(rng.normal(0.30, 0.12, n), 0.01, 0.85),
            "soil_moisture_mean": np.clip(rng.normal(0.30, 0.05, n), 0.05, 0.55),
            "soil_moisture_p90": np.clip(rng.normal(0.38, 0.06, n), 0.08, 0.60),
            "clay_pct": np.clip(rng.normal(30, 9, n), 2, 60),
            "land_cover_class": rng.choice([10, 30, 40, 50], n, p=[0.5, 0.2, 0.2, 0.1]),
            "gsw_occurrence_pct": np.where(
                rng.random(n) < 0.25, rng.uniform(0, 70, n), 0.0
            ),
            "gsw_recurrence_pct": 0.0,
        }
    )
    if cloudy:
        frame.loc[: cloudy - 1, ["evi_median", "evi_p10"]] = np.nan
    return frame


def _run(frame, seed=0, plant=True):
    """draw_latents -> plant -> intensities -> calibrate -> simulate."""
    rng = np.random.default_rng(seed)
    latents = gen.draw_latents(rng, frame)
    baseline = gen.cause_intensities(frame, latents)
    cases = gen.plant_demo_cases(rng, frame, latents, baseline) if plant else []
    intensities = gen.cause_intensities(frame, latents)
    scale = gen.calibrate(frame, latents, intensities, MONSOON, END, seed)
    tickets, lambda_true, counts = gen.simulate(
        np.random.default_rng(seed + 1),
        frame, latents, intensities, scale, MONSOON, END, record=True,
    )
    return latents, cases, intensities, tickets, lambda_true, counts


# --- circularity ----------------------------------------------------------
def test_telemetry_is_informative_and_absent_from_model_features():
    """The telemetry block is the one column set Layer 2 has and Layer 1 does
    not, and both halves of that must hold.

    Informative: it is derived from the site's own hazard intensity, so it must
    rank the label well above chance — otherwise the unsupervised layer is
    reading noise. Absent: model/maintenance_need.py's FEATURES must never
    contain it, because the counters cover 30 days and the label covers 36
    months, so there is no aligned pair to train on. If someone adds it to
    FEATURES the supervised model regains the advantage and the ensemble's whole
    case evaporates — this test is what catches that."""
    from sklearn.metrics import roc_auc_score

    from model.maintenance_need import FEATURES

    assert not set(gen.TELEMETRY_COLUMNS) & set(FEATURES), (
        "telemetry leaked into the supervised feature set"
    )

    rng = np.random.default_rng(0)
    lam = rng.gamma(2.0, 0.5, 400)
    telemetry = gen.build_telemetry(rng, [f"T{i}" for i in range(400)], lam)
    assert list(telemetry.columns) == ["tower_id"] + gen.TELEMETRY_COLUMNS
    assert (telemetry[gen.TELEMETRY_COLUMNS] >= 0).all().all(), "counts must be non-negative"

    y = (lam > np.median(lam)).astype(int)
    score = np.log1p(telemetry[gen.TELEMETRY_COLUMNS]).mean(axis=1)
    assert roc_auc_score(y, score) > 0.80, "telemetry carries no usable signal"


def test_generator_does_not_import_the_novelty_detector():
    """The generator may plant "unusual sites are riskier" but must measure
    unusualness its OWN way (Mahalanobis, numpy). Importing sklearn's
    IsolationForest — what model/novelty.py detects with — would hand the
    detector its own answer key, which is the maintenance_classifier failure
    wearing an unsupervised hat. AST-parsed, not grepped: the docstrings name
    both on purpose."""
    import ast

    tree = ast.parse((_THIS_DIR / "prepare_maintenance_records.py").read_text())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
            imported.update(f"{node.module}.{a.name}" for a in node.names)
    banned = [n for n in imported if "sklearn" in n or "novelty" in n or "model.ensemble" in n]
    assert not banned, f"generator imports the detector's own machinery: {banned}"


def test_rare_configuration_is_inert_when_disabled():
    """BOOST <= 1.0 must return exactly ones, so the term can be switched off
    without a branch at the call site and without perturbing the seed stream."""
    import prepare_maintenance_records as gen

    frame = pd.DataFrame({
        "hand_m": [1.0, 40.0, 3.0, 900.0], "slope_deg": [0.5, 30.0, 2.0, 1.0],
        "tri": [1.0, 9.0, 2.0, 1.0],
        "clay_pct": [20.0, 55.0, 25.0, 10.0], "soil_moisture_p90": [0.3, 0.6, 0.35, 0.2],
        "evi_median": [0.3, 0.9, 0.4, 0.1], "dist_power_m": [100.0, 9000.0, 500.0, 50.0],
        "dist_water_m": [50.0, 8000.0, 300.0, 20.0],
    })
    original = gen.RARE_CONFIG_BOOST
    try:
        gen.RARE_CONFIG_BOOST = 1.0
        np.testing.assert_array_equal(gen.rare_configuration(frame), np.ones(len(frame)))
        gen.RARE_CONFIG_BOOST = 4.0
        boosted = gen.rare_configuration(frame)
        assert boosted.min() >= 1.0 and boosted.max() <= 4.0
        # Monotone in the driver: the most unusual row must not score below any other.
        assert boosted.max() == boosted[np.argmax(boosted)]
    finally:
        gen.RARE_CONFIG_BOOST = original


def test_generator_does_not_import_risk_index():
    """The one mechanical guard against repeating the withdrawn classifier.

    Parsed, not grepped: the module docstring mentions the index on purpose, so
    a text search would either fail here or force the explanation out of the
    file where it belongs.
    """
    tree = ast.parse((_THIS_DIR / "prepare_maintenance_records.py").read_text())
    imported = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            imported.append(node.module or "")
    assert not any("risk_index" in name for name in imported), imported


def test_hazard_ignores_elevation():
    """`hand_m` and `slope_deg` DO drive hazard since the v2.0 retune — see the
    generator docstring. `elevation_m` still drives nothing: it is a descriptor,
    not a mechanism, and a site is not harder to maintain for being high up.

    The AST guard (above) remains the real protection against reproducing the
    index; this only pins that one column stays inert.
    """
    frame = _frame(300)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    base = gen.cause_intensities(frame, latents).to_numpy()

    moved = frame.copy()
    moved["elevation_m"] = moved["elevation_m"] * 3.0 + 500.0
    after = gen.cause_intensities(moved, latents).to_numpy()

    np.testing.assert_allclose(base, after, rtol=1e-12)


# --- calibration and shape ------------------------------------------------
def test_base_rate_in_operating_range():
    """Too rare and the top-10% operating point has no positives to find; too
    common and everything is positive."""
    *_, counts = _run(_frame(500))
    rate = float((counts > 0).mean())
    assert 0.15 <= rate <= 0.30, rate


def test_seed_is_deterministic():
    frame = _frame(200)
    np.testing.assert_array_equal(_run(frame, seed=3)[5], _run(frame, seed=3)[5])


def test_no_state_is_degenerate():
    """A state with only one class breaks the per-fold metrics under GroupKFold,
    and that failure reads as a modelling result."""
    frame = _frame(600)
    *_, counts = _run(frame)
    labels = pd.DataFrame({"state": frame["state"], "y": (counts > 0).astype(int)})
    for state, group in labels.groupby("state"):
        if len(group) >= 30:
            assert 0 < group.y.sum() < len(group), state


def test_monsoon_months_come_from_policy():
    """The synthetic history must not contradict the scheduler's own monsoon
    window, so the months are a parameter read from policy.yaml, not a literal.
    """
    frame = _frame(300)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    intensities = gen.cause_intensities(frame, latents)

    # Calibrated, never a literal scale: cause_intensities() renormalises to a
    # fixed log-spread, so an arbitrary scale of 1.0 asks simulate() to record
    # tens of millions of tickets and the test simply never returns.
    scale = gen.calibrate(frame, latents, intensities, MONSOON, END, 0)

    def flood_months(months):
        tickets, _, _ = gen.simulate(
            np.random.default_rng(1), frame, latents, intensities, scale,
            months, END, record=True,
        )
        floods = [t["opened_date"].month for t in tickets if t["root_cause"] == "flood"]
        return pd.Series(floods).value_counts()

    winter, summer = flood_months(MONSOON), flood_months([5, 6, 7, 8, 9])
    assert winter.get(12, 0) > winter.get(6, 0)
    assert summer.get(6, 0) > summer.get(12, 0)


# --- latents --------------------------------------------------------------
def test_latents_are_weakly_correlated_with_observables():
    """Conditioning latents on observables keeps the simulated world coherent,
    but every unit of correlation is signal handed back to the model."""
    frame = _frame(800)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    hidden = latents[["build_quality", "has_drainage", "genset_age_years"]]
    observables = frame.select_dtypes(include=[np.number])
    worst = 0.0
    for a in hidden.columns:
        for b in observables.columns:
            r = abs(np.corrcoef(hidden[a], observables[b].fillna(0))[0, 1])
            worst = max(worst, 0.0 if np.isnan(r) else r)
    assert worst < 0.35, worst


def test_latents_still_perturb_the_label():
    """The retune attenuated the latents; this pins that they still bite.

    v1.0 measured a *variance share* of log-intensity (0.35-0.55 band, CV-GBR
    probe). That measurement no longer says anything useful: OBSERVABLE_LOG_SPREAD
    renormalises the observable side to ~30 units of log variance, against which
    even an unattenuated latent multiplier is under 1%. It reads as 0.00 and a
    band on it would be a test of the wrong quantity.

    What the latents actually do is move sites near the label threshold, which
    is where ranking is decided. Measured out-of-fold on the real 1,164-tower
    national data at OBSERVABLE_LOG_SPREAD = 5.5: LATENT_STRENGTH 0.15 gives the
    served model ROC 0.955, and 1.0 gives 0.857, with the oracle unmoved at
    ~0.985. So this asserts the intensity is perturbed but not dominated —
    cheap, and it fails if either end of that is lost.
    """
    frame = _frame(600)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    original = gen.LATENT_STRENGTH
    try:
        with_latents = np.log(gen.cause_intensities(frame, latents).sum(axis=1).to_numpy())
        gen.LATENT_STRENGTH = 0.0
        without = np.log(gen.cause_intensities(frame, latents).sum(axis=1).to_numpy())
    finally:
        gen.LATENT_STRENGTH = original

    correlation = float(np.corrcoef(with_latents, without)[0, 1])
    assert correlation < 0.9999, "latents must perturb the intensity at all"
    assert correlation > 0.90, (
        f"latents dominate (corr {correlation:.4f}); the observable side must "
        "stay the main driver or the model has nothing to learn"
    )


def test_hazard_responses_are_monotone():
    """The traps are gone; these are the shapes that replaced them.

    Each driver is varied alone with every other observable column held
    identical across rows, because cause_intensities() renormalises the whole
    row to a fixed log-spread (see OBSERVABLE_LOG_SPREAD) and unrelated
    row-to-row variation would leak into a single-cause comparison.
    """
    def sweep(column, values, cause, **fixed):
        frame = pd.concat([_frame(1)] * len(values), ignore_index=True)
        for key, value in fixed.items():
            frame[key] = value
        frame[column] = values
        latents = gen.draw_latents(np.random.default_rng(0), frame)
        latents["foundation_type"] = "pad"
        latents["access_road_class"] = "sealed"
        latents["build_quality"] = 0.5
        latents["site_frailty"] = 1.0
        latents["genset_age_years"] = 11.0
        latents["has_drainage"] = 0
        return gen.cause_intensities(frame, latents)[cause].to_numpy()

    veg = sweep("evi_median", [0.10, 0.35, 0.60, 0.95], "vegetation",
                land_cover_class=10)
    assert np.all(np.diff(veg) >= 0), veg

    growth = sweep("evi_delta_per_year", [-0.3, 0.0, 0.02, 0.10, 0.20, 0.5], "vegetation")
    assert np.all(np.diff(growth) >= 0), growth
    assert growth[0] == growth[1] == growth[2] < growth[3] < growth[4] == growth[5]

    power = sweep("dist_power_m", [200.0, 1200.0, 2500.0, 6000.0], "power")
    assert np.all(np.diff(power) >= 0), power

    terrain = sweep("clay_pct", [5.0, 20.0, 35.0, 50.0], "terrain", tri=0.0,
                    slope_deg=0.0)
    assert np.all(np.diff(terrain) >= 0), terrain

    # Flood falls as the site sits further above local drainage.
    flood = sweep("hand_m", [0.2, 2.0, 8.0, 40.0], "flood",
                  gsw_occurrence_pct=0.0, soil_moisture_p90=0.2,
                  dist_water_m=5000.0)
    assert np.all(np.diff(flood) <= 0), flood


def test_latent_strength_attenuates_hidden_variance():
    """LATENT_STRENGTH is the retune's main lever and it must actually move.

    At 0.0 the latents are inert and two sites with identical observables get
    identical intensity; at 1.0 they do not. The shipped value sits between,
    which is what keeps the oracle a real ceiling.
    """
    frame = pd.concat([_frame(1)] * 40, ignore_index=True)
    latents = gen.draw_latents(np.random.default_rng(3), frame)
    original = gen.LATENT_STRENGTH
    try:
        gen.LATENT_STRENGTH = 0.0
        flat = gen.cause_intensities(frame, latents).sum(axis=1).to_numpy()
        gen.LATENT_STRENGTH = 1.0
        full = gen.cause_intensities(frame, latents).sum(axis=1).to_numpy()
    finally:
        gen.LATENT_STRENGTH = original
    assert flat.std() / flat.mean() < 1e-9, "latents must be inert at strength 0"
    assert full.std() / full.mean() > 0.2, "latents must bite at strength 1"
    assert 0.0 < original < 1.0, original


def test_no_target_derived_column_is_a_feature():
    """The withdrawn classifier's failure mode: a column that restates the
    target sitting in the model's input. `n_site_visits_36mo` — the old leakage
    bait — is no longer written at all."""
    for forbidden in ("n_site_visits_36mo", "lambda_true", "n_corrective_36mo"):
        assert forbidden not in FEATURES, forbidden


# --- reporting noise and labels -------------------------------------------
def test_lambda_true_precedes_reporting_noise():
    """The oracle must be the clean intensity. Contaminate it and the ceiling
    the notebook reports is not a ceiling."""
    frame = _frame(300)
    lambda_a = _run(frame, seed=5)[4]
    original = gen.DROP_RATE
    try:
        gen.DROP_RATE = 0.9
        lambda_b = _run(frame, seed=5)[4]
    finally:
        gen.DROP_RATE = original
    np.testing.assert_allclose(lambda_a, lambda_b)


def test_preventive_tickets_excluded_from_label():
    """A site visited only for scheduled inspection needs no corrective work. A
    target that counts inspections is counting our own dispatch policy."""
    frame = _frame(100)
    ids = frame["tower_id"].to_numpy()
    noisy = gen.apply_reporting_noise(np.random.default_rng(0), [], ids)
    tickets = pd.DataFrame(noisy)
    tickets["ticket_id"] = [f"WO_{i:06d}" for i in range(len(tickets))]
    latents = gen.draw_latents(np.random.default_rng(0), frame)

    labels, _, _ = gen.build_labels(tickets, frame, latents, np.zeros(len(frame)))
    assert labels["needed_corrective_maintenance"].sum() == 0


def test_malformed_tickets_are_rejected_and_counted():
    """Real exports are dirty. A silent drop is the same failure class as the
    partial cache that produced a 97%-smaller dataset."""
    frame = _frame(120)
    _, _, _, tickets, lambda_true, _ = _run(frame, seed=2)
    ids = frame["tower_id"].to_numpy()
    dirty = gen.inject_malformed(
        gen.apply_reporting_noise(np.random.default_rng(0), tickets, ids)
    )

    records = pd.DataFrame(dirty)
    records["ticket_id"] = [f"WO_{i:06d}" for i in range(len(records))]
    for row in records.index[records.get("_defect") == "duplicate_ticket_id"]:
        records.at[row, "ticket_id"] = records.at[0, "ticket_id"]

    latents = gen.draw_latents(np.random.default_rng(0), frame)
    _, valid, rejected = gen.build_labels(records, frame, latents, lambda_true)

    assert rejected["unknown_tower_id"] >= 1
    assert rejected["closed_before_opened"] >= 1
    assert rejected["duplicate_ticket_id"] >= 1
    assert len(valid) == len(records) - sum(rejected.values())


def test_missing_land_features_stay_nan_in_the_frame():
    """A zero EVI means bare ground; a missing one means we could not see. The
    generator median-fills internally to compute an intensity, but must not
    write that fill back into the frame the model reads."""
    frame = _frame(200, cloudy=10)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    intensities = gen.cause_intensities(frame, latents)
    assert np.isfinite(intensities.to_numpy()).all()
    assert frame["evi_median"].isna().sum() == 10


# --- demo cases -----------------------------------------------------------
def test_demo_case_budget_is_capped():
    """Plant 200 pathological towers and the metrics stop describing the model
    and start describing the edge cases."""
    frame = _frame(500)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    cases = gen.plant_demo_cases(np.random.default_rng(0), frame, latents, gen.cause_intensities(frame, latents))
    assert len(cases) <= gen.MAX_DEMO_CASES
    assert len(cases) / len(frame) < 0.10


def test_planting_does_not_move_the_headline():
    """If planting changes the dataset's character, every metric describes the
    planted sites rather than the model.

    Sized at the real tower count on purpose. The planted set is a fixed ~40
    sites, so its share of the dataset — and therefore its leverage on the base
    rate — depends entirely on n. At n=600 that is 6.7%; at the production 1,164
    it is 3.4%. Testing at 600 would hold the generator to a density it is never
    run at.

    Averaged over 5 seeds rather than compared at one. STATE_EFFECT_SIGMA and
    FRAILTY_SIGMA are both large (see their comments in
    prepare_maintenance_records.py — the oracle ceiling needs that spread), which
    makes the aggregate base rate noisy from Poisson draws alone: single-seed
    diffs ranged +0.021 to -0.030 with a mean of -0.0003 and no systematic
    direction. A one-seed comparison was measuring that noise, not planting.
    """
    frame = _frame(1164)
    diffs = []
    for seed in range(5, 10):
        on = float((_run(frame, seed=seed, plant=True)[5] > 0).mean())
        off = float((_run(frame, seed=seed, plant=False)[5] > 0).mean())
        diffs.append(on - off)
    assert abs(np.mean(diffs)) < 0.015, diffs


def test_demo_cases_are_selected_not_hardcoded():
    """A hardcoded tower_id breaks the moment the tower table is regenerated,
    and is also how a 'planted' case quietly becomes a hand-picked one."""
    frame = _frame(400, seed=11)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    cases = gen.plant_demo_cases(np.random.default_rng(0), frame, latents, gen.cause_intensities(frame, latents))
    known = set(frame["tower_id"])
    assert cases
    for case in cases:
        assert case["tower_id"] in known, case


def test_twin_pairs_match_on_model_features():
    """A pair the model can separate is not a twin pair, and the ceiling demo it
    supports would be void. Matched after build_matrix, on exactly the columns
    the model sees."""
    frame = _frame(500)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    cases = gen.plant_demo_cases(np.random.default_rng(0), frame, latents, gen.cause_intensities(frame, latents))
    twins = [c["tower_id"] for c in cases if c["case_type"] == "twin_pair"]
    assert len(twins) >= 2 and len(twins) % 2 == 0

    matrix = build_matrix(frame).select_dtypes(include=[np.number])
    values = matrix.to_numpy(dtype=float)
    filled = np.where(np.isnan(values), np.nanmedian(values, axis=0), values)
    spread = filled.std(axis=0)
    spread[spread == 0] = 1.0
    standardised = (filled - filled.mean(axis=0)) / spread
    position = {t: i for i, t in enumerate(frame["tower_id"])}

    for left, right in zip(twins[::2], twins[1::2]):
        distance = np.linalg.norm(
            standardised[position[left]] - standardised[position[right]]
        )
        assert distance < 1.5, (left, right, distance)


def test_demo_cases_carry_an_expected_role_and_a_reason():
    """Registered before training, with the claim stated up front. Picking cases
    after seeing predictions would be cherry-picking; the write order prevents
    it."""
    frame = _frame(400)
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    cases = gen.plant_demo_cases(np.random.default_rng(0), frame, latents, gen.cause_intensities(frame, latents))
    types = {c["case_type"] for c in cases}
    assert {"protected_site", "neglected_site", "twin_pair"} <= types, types
    for case in cases:
        assert case["expected_role"]
        assert len(case["why"]) > 30


def test_generator_has_encroachment_term_and_does_not_impute_growth():
    tree = ast.parse(Path(gen.__file__).read_text())
    function = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "cause_intensities")
    assert any(isinstance(n, ast.Constant) and n.value == "evi_delta_per_year" for n in ast.walk(function))
    assert gen.GENERATOR_VERSION == "2.3"
    frame = _frame()
    latents = gen.draw_latents(np.random.default_rng(0), frame)
    frame["evi_delta_per_year"] = np.where(np.arange(len(frame)) % 2, .2, np.nan)
    unknown = gen.cause_intensities(frame, latents)
    frame["evi_delta_per_year"] = frame.evi_delta_per_year.fillna(0)
    pd.testing.assert_frame_equal(unknown, gen.cause_intensities(frame, latents))


def test_generator_loads_change_by_tower_id():
    from tempfile import TemporaryDirectory
    with TemporaryDirectory() as directory:
        root = Path(directory)
        pd.DataFrame({"tower_id": ["A", "B"], "state": ["Johor"] * 2,
                      "radio": ["LTE"] * 2}).to_csv(root / "towers.csv", index=False)
        pd.DataFrame({"tower_id": ["B", "A"], "evi_median": [.2, .3]}).to_csv(root / "land.csv", index=False)
        pd.DataFrame({"tower_id": ["B"], "evi_delta_per_year": [.1]}).to_csv(root / "change.csv", index=False)
        frame = gen.load_inputs(root / "towers.csv", root / "land.csv", root / "change.csv")
        assert frame.tower_id.tolist() == ["A", "B"]
        assert np.isnan(frame.evi_delta_per_year.iloc[0]) and frame.evi_delta_per_year.iloc[1] == .1


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
