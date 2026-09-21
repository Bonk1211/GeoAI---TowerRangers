# Synthetic maintenance labels

`data/prepare_maintenance_records.py` simulates 36 months of tower maintenance
history because no real one was obtainable for this prototype. This document is
the honest answer to "so is this real?" — the causal graph the generator
implements, why each constant has the value it has, and what a real dataset
would and would not change.

**Everything downstream of this generator is synthetic.** The model report
(`data/malaysia/maintenance_need_report.json`), the confusion matrix on the
Method page — all of it validates the *evaluation pipeline*, not real-world
accuracy. See `CLAUDE.md` for how the served risk score and its circularity
rules fit into the rest of the backend.

> **Retuned for accuracy (generator v2.0).** The planted traps were removed on
> request, the hazard forms were made smooth and monotone in the observed
> columns, `hand_m`/`slope_deg` were allowed to drive hazard, latent site
> attributes were attenuated to `LATENT_STRENGTH = 0.15` of their natural
> spread, and reporting noise was switched off. The served model went from ROC
> 0.58 / PR-AUC 0.29 to ROC 0.91 / PR-AUC 0.77. **None of that gain
> came from the model.** The label was made more learnable, and the traps that
> used to demonstrate what the physical index structurally could not represent
> are gone with it. Read the headline as "the pipeline recovers the structure
> this generator plants", never as an accuracy claim.

## Why this is not the withdrawn classifier again

`maintenance_classifier` reported 0.974 out-of-fold AUC and meant nothing: its
label was a quantile cut on `technical_risk`, itself a deterministic function
of the same six features the model was given, so it was scored on its ability
to invert a monotone threshold it had been handed.

Five rules keep this generator from repeating that:

1. **It never imports `model/risk_index.py`.** Not `memberships()`, not
   `noisy_or()`, not `PARAMS`. `data/test_maintenance_records.py::
   test_generator_does_not_import_risk_index` parses the module's imports with
   `ast` rather than grepping its prose — this document and the module's own
   docstring both mention the index on purpose.
2. **Hazard is driven by observed measurements**, not by the index's
   membership curves. Flood exposure comes from JRC GSW occurrence and SMAP
   soil moisture; vegetation risk from Sentinel-2 EVI; structural risk from
   OpenLandMap clay. Since v2.0 `hand_m` and `slope_deg` **do** drive hazard —
   low ground holds water, steep ground erodes — because excluding the two most
   informative terrain columns was costing the accuracy the retune was asked to
   recover. The functional forms are still the generator's own (a shape-1.5
   decay in HAND, a linear slope ramp), never the index's logistic memberships
   combined by noisy-OR.
3. **Latent, unobservable site attributes carry signal — attenuated.** Build
   quality, drainage presence, genset age, foundation type, access road class
   and a per-site frailty term are drawn from
   distributions weakly conditioned on the observables (correlation held under
   0.35 — real sites' build quality does correlate with where they are, but
   every unit of that correlation is signal handed back to a model that can
   see the observables). Each is then pulled toward 1 by `LATENT_STRENGTH =
   0.15`, so they still keep a perfect model below PR-AUC 1.0 but carry far
   less of the label's variance than in v1.0. The per-state contractor effect
   is removed entirely.
4. **The oracle ceiling is reported.** The generator knows each site's true
   latent hazard intensity, `lambda_true`, computed *before* any reporting
   noise is applied. Scoring `lambda_true` against the emitted labels gives the
   best any model could possibly do here. On the shipped dataset: oracle ROC
   0.985, PR-AUC 0.95 — above the served model's 0.910 / 0.765, most of that
   gap now being the planted demo cases rather than the population's latents. A model landing
   at the oracle would mean the generator leaked recoverable structure, not
   that the model is good.
5. **Nothing synthetic is presented as observed.** Every artifact —
   `maintenance_manifest.json`, `demo_cases.json`, the model report — carries `"synthetic": true` and a `caveat` string. The
   Method page states it in the first caveat panel, not a footnote.

## The causal graph

Five causes, one per scheduler factor (`config/actions.yaml`'s vocabulary:
`flood`, `terrain`, `vegetation`, `power`, `equipment`). Each cause has a
monthly Poisson intensity that is a product of observed drivers and latent
modifiers:

```
lambda_flood      = (1 - 0.45*drainage)_soft * (1.20*gsw_occurrence^0.7
                                                + 0.90*ramp(soil_moisture_p90)
                                                + 0.80/(1 + (hand_m/4)^1.5)
                                                + 0.35*exp(-dist_water_m/1500))
lambda_terrain    = road_soft*(0.55*tri_norm^1.3 + 0.60*ramp(slope_deg))
                     + foundation_soft*0.50*ramp(clay_pct)
lambda_vegetation = 0.90*ramp(evi_median)*(1 - 0.40*built_up)
lambda_power      = 0.85*(1 - exp(-dist_power_m/2500))*soft(genset_age/11)
lambda_equipment  = 0.45*radio_burden

z     = standardise(log(sum of the five))
total = exp(OBSERVABLE_LOG_SPREAD * z)          (level set by the base-rate bisection)
total *= soft(site_frailty) * soft(1.20 - 0.40*build_quality)
total *= demo_multiplier                        (1.0 for every unplanted site)

# per month, in simulate(): soft-cap the row and share it back proportionally
rate  = MAX_MONTHLY_RATE * (1 - exp(-rate/MAX_MONTHLY_RATE))
```

`ramp(x)` is linear 0->1 across a stated span and flat outside it; `soft(m)` is
`1 + LATENT_STRENGTH*(m - 1)`. Every response is **monotone** in its driver.
The v1.0 clay x wetness interaction, mid-EVI hump, power-distance cliff and
per-state multiplier are gone.

### The two constants that set the headline

`OBSERVABLE_LOG_SPREAD = 5.5` replaces v1.0's `CAUSE_INTENSITY_EXPONENT` power
law, which set contrast only indirectly and saturated. It renormalises the
summed observable intensity to a fixed spread in log space, so the base-rate
bisection sets the level and this sets the contrast. Measured out-of-fold on
the real 1,164-tower national data (GroupKFold on ADM1 state, 5 folds) at
`LATENT_STRENGTH = 0.15`:

| spread | model ROC | oracle ROC |
|---|---|---|
| 1.0 | 0.665 | 0.767 |
| 2.0 | 0.849 | 0.892 |
| 3.0 | 0.900 | 0.940 |
| 4.5 | 0.940 | 0.973 |
| **5.5** | **0.910** | **0.985** |

5.5 is where the model tracks the oracle closely without the label becoming a
deterministic function of the features; above ~6 the Poisson draw stops
mattering and this is no longer a statistics problem. The table's model column
was measured before demo-case planting was repaired; planting now costs a
further ~0.04 ROC, which is what the planted ceiling is for.

`LATENT_STRENGTH = 0.15` is the other half, and it is a lever on the **data**,
not the model: at 1.0 (v1.0 behaviour) the served model reaches ROC ~0.57
because half the label's variance sits in attributes no satellite can see; at
0.15 it reaches ~0.95 (before planting) because that half has largely been
deleted. It is kept non-zero so the oracle remains a real ceiling — but note
that at this spread the latents no longer hold that ceiling far above the model
on their own, and most of the surviving gap now comes from the planted cases.

### Ramp siting

Every ramp is sited on the **national distribution of the column it reads**
(`data/malaysia/land_features.csv` + `tower_feature_table.csv`, 1,164 towers),
not at a round, physically plausible number picked without checking the data —
a ramp centred outside the data's own range is a constant, not a response:

| Constant | Value | Sited at |
|---|---|---|
| `MOISTURE_ONSET` / `SPAN` | 0.30 / 0.25 | below the p10 of `soil_moisture_p90` (0.354), spanning the bulk |
| `CLAY_ONSET` / `SPAN` | 20.0 / 25.0 | p25 to p95 of `clay_pct` |
| `EVI_ONSET` / `SPAN` | 0.15 / 0.35 | spans the national median of `evi_median` (0.335) |
| `POWER_SCALE_M` | 2500.0 | p75 of `dist_power_m` (1936 m) |
| `HAND_SCALE_M` / `SHAPE` | 4.0 / 1.5 | national median `hand_m` (3.88 m) |
| `SLOPE_FULL_DEG` | 25.0 | upper tail of `slope_deg` |

### The monthly rate is soft-capped

`OBSERVABLE_LOG_SPREAD = 5.5` is a ratio of ~1e14 between the quietest and
loudest site, and the Poisson draw honours all of it. The first shipped register
had a tower with **2,199 corrective orders in 36 months** — about 60 a month on
one mast. The binary label stops caring above lambda ~3 (`P(>=1) = 0.95`), so
that tail bought no discrimination while making `n_corrective_36mo`,
`downtime_hours` and `cost_myr` unusable as quantities.

`_saturate()` caps a site's monthly rate at `MAX_MONTHLY_RATE = 0.8` with
`x -> c(1 - exp(-x/c))`, applied to the row total and shared back
proportionally, so per-cause shares — and therefore `dominant_factor` and the
attribution panel — are unchanged. Three properties of that shape are
load-bearing:

* **Strictly monotone**, so no two sites swap order. `lambda_true` is the oracle
  and the report's ceiling; a cap that reordered sites would move that ceiling
  and quietly invalidate the leak check. Measured: oracle ROC stays 0.982-0.985
  across every cap from 0.4/month to uncapped.
* **Identity near zero** (`x << c` gives `x - x^2/2c`), so the region where the
  label is actually decided is untouched and the base rate barely moves.
* **Asymptotic, not clipped.** `np.minimum` would flatten the whole top decile
  onto one value and destroy the oracle's ranking inside it.

| | before | after |
|---|---|---|
| max tickets / 36 months | 2,199 | 41 |
| p99 | 248 | 31 |
| towers above 50 | 45 | 0 |
| total tickets | 13,837 | 2,485 |

Accuracy is flat across caps, so this costs nothing.

### Calibration and the recorded run share a Poisson stream

`calibrate()` runs `simulate(record=False)`; the shipped dataset comes from
`simulate(record=True)`. Both were given the same seed, and the docstring said
so — but recording consumes extra draws inside the month loop for ticket dates,
downtime and cost, so the two walked **different streams** and the shipped base
rate missed the calibrated one by 1.5 points (0.212 calibrated, 0.228 emitted).
Ticket detail now draws from its own generator, seeded once from the caller's
and drawn *unconditionally* so both modes consume it identically. The shipped
base rate is 0.2113 against a 0.21 target.

This also invalidated the first round of cap measurements: base rates were
drifting 0.203-0.228, and PR-AUC scales with prevalence, so an apparent "tighter
cap scores better" trend was prevalence rather than the cap.

### Reporting noise is off

`DROP_RATE` and `SPURIOUS_RATE` are both 0.0 in v2.0, and not only because
noise costs accuracy. `SPURIOUS_RATE` scatters `len(tickets) * rate` misfiled
tickets uniformly across towers, while `OBSERVABLE_LOG_SPREAD` concentrates the
ticket count onto a small number of very heavy sites. At the v1.0 value of 0.08
that pushed the measured base rate from 0.21 to **0.66** — the label stopped
meaning "this site needs work" and started meaning "somebody filed something".
Restoring either rate needs a misfile model that respects the site
distribution.

### Calibration

`TARGET_BASE_RATE = 0.21` (share of towers with >=1 corrective ticket in 36
months) is hit by bisecting one common intensity scale - `calibrate()` - over
`[1e-9, 5.0]`. The lower bound used to be `1e-3`, which is **above** the scale
the retuned spread needs (~3e-4): the bisection returned its own floor and the
base rate came out at 0.29 instead of 0.21, silently and with no error.
Bisected rather than hand-tuned, so the constant is reproducible and its value is a
stated target rather than taste. The bisection draws with the *same* RNG seed
the recorded simulation uses; an earlier version used a different seed for
calibration than for simulation, which let the achieved base rate scatter by
up to two points from Poisson noise alone and made an unrelated test
(`test_planting_does_not_move_the_headline`) look like it was detecting a real
effect when it was detecting seed noise.

## What is planted, and why that is not cheating

Demo cases, written to JSON **before any model is trained**, so "the model
caught this" or "the model missed this" is a finding rather than a case
selected after seeing predictions.

### Traps - removed in v2.0

`planted_traps.json` is no longer written and the notebook's trap-recovery
section is gone. Five mechanisms used to live here, each one something the
noisy-OR index is structurally unable to represent, and together they were the
concrete answer to "why replace the index at all":

| Trap | Mechanism | Why it was removed |
|---|---|---|
| Interaction | Structural risk needs clay **and** wetness; neither alone | Replaced by an additive clay ramp |
| Non-monotone | Vegetation risk peaks at **mid** EVI | Replaced by a monotone EVI ramp |
| Threshold cliff | Power risk flat within feeder reach, sharp beyond it | Replaced by a smooth saturating curve |
| State effect | Per-state lognormal multiplier | Removed; it was unlearnable latent variance and the single biggest drag on the score |
| Leakage bait | `n_site_visits_36mo` beside the target in the labels file | Column no longer written at all |

What the removal costs, stated once and not softened: the report can no longer
show that the supervised model recovers structure the physical index cannot,
which was the argument for the model existing. The split-check section of the
notebook survives — it now verifies that random KFold and GroupKFold *agree*,
which is the check that catches regional structure creeping back in when real
records arrive.

### How a demo case is planted, and how it is checked

Both halves were rebuilt after the retune, which had silently killed every
planted story while a comparison bug hid the fact: the set read **5/33**
matching its registered `expected_role`. Three faults stacked.

**Selection.** Cases were drawn on `gsw_occurrence_pct` — "the 120 wettest
towers". That column is 0 for 97.9% of towers, so the sort was ties at zero and
"high exposure" meant a random site; two of four `protected_site`s came back at
lambda 0.000 and 0.298, which cannot be a false positive because nothing ranks
them high. Selection is now on the site's own observable intensity, and
`protected_site` specifically from the top 5% — the case claims the model
*dispatches* the site, so it has to clear the top-10% cut, and the top 13% was
not tight enough (three of four sat at risk 0.19-0.68 against a cut near 0.7).

**Forcing.** `LATENT_STRENGTH = 0.15` made a forced latent inert, and no
plausible latent — build quality or drainage, a factor of two — can move a site
against a 5.5-sd log-spread anyway. A case now states the rate it should
**behave** at, as a population quantile (`QUIET = p15`, `LOUD = p97`), and the
multiplier is solved for. That is scale-free, so it survives `calibrate()`
rescaling everything. The resulting `demo_multiplier` is applied at **full**
strength, deliberately outside `LATENT_STRENGTH`, because a demo case is by
definition a site whose hidden history is extreme. The Poisson draw still
decides the outcome, so `expected_role` stays a falsifiable claim.

**Checking.** `expected_role` mixed two incompatible things, and one was
impossible:

| kind | cases | how it is checked |
|---|---|---|
| `confusion` | `protected_site`, `neglected_site` | direct comparison against the observed TP/FP/FN/TN cell |
| `pair` | `twin_pair` | judged as a pair: scores within 0.10, outcomes opposite |
| `narrative` | everything else | reported, never scored |

`count_is_not_cost`, `denominator_matters` and the rest name a *lesson*, not a
cell of the confusion matrix, so equality against `observed_role` is false by
construction — 13 rows were guaranteed to read as failures. And `twin_pair`
expected one TN and one TP from a pair the model *cannot separate*: near
identical scores can only land {TN, FN} or {FP, TP}, so that was an impossible
expectation rather than a strict one. One pair had scored 0.861/0.866 with
opposite outcomes — the ceiling demo working exactly as designed — and was
recorded as a miss.

Now: **7/8 confusion cases and 6/6 twin pairs**, pairs separated by 0.000-0.059
in model probability. The cost is real and is the point — planting drops the
headline from roughly ROC 0.948 / PR 0.835 to 0.910 / 0.765, because 33 sites
(2.8%) are genuinely unlearnable. Softening the targets does not recover it
(p25/p92 and p30/p88 both score the same or worse): the cost is having
label-contradicting sites at all, not how extreme they are, so the only dial is
how many to plant.

### Demo cases - where the model is expected to be honestly wrong

Registered in `data/malaysia/demo_cases.json`, capped at `MAX_DEMO_CASES = 45`
(under 4% of towers) and asserted not to move the headline base rate by more
than ~0.015 across seeds. Planted by **forcing a site's latent draw**, then
letting the same Poisson simulation run unchanged - never by hand-writing a
ticket count. A forced latent produces a site with an unusual history, which
real registers are full of; an edited ticket count would be a fabrication.

| Case | Forced latents | Expected role | What it demonstrates |
|---|---|---|---|
| `protected_site` | drainage installed, high build quality | false positive | High observed exposure, already remediated - the FP is the limit of what environment can tell you, not model error |
| `neglected_site` | poor build quality, old genset, no drainage | false negative | Benign environment, many tickets - the sites a model built on environment alone will always miss |
| `twin_pair` | opposite behaviour targets on sites matched to noise on every `FEATURES` column | *pair*: near-identical scores, opposite outcomes | The irreducible ceiling, made visible: two rows the model cannot distinguish, opposite outcomes |
| `remediated_site` | drainage installed mid-window | - | A 36-month aggregate count hides a fix that happened 22 months ago |
| `new_commission` | 8 months of exposure instead of 36 | - | A raw count needs an exposure denominator |
| `cloud_shadowed` | *(not planted - selected from towers whose EVI genuinely came back masked)* | - | The missing-data path end to end: LightGBM learns a split direction for NaN |
| `catastrophic` | one very expensive, very long ticket | - | Count is not cost |
| `monsoon_locked` | flood-dominant, civil crew | - | `policy.yaml`'s monsoon window really does defer civil work |
| `lone_territory` / `enclave` | - | - | Perlis (2 OSM towers) and Kuala Lumpur (an enclave in Selangor) exercise real scheduler edge cases |

`malformed_ticket` is a third category, in `maintenance_records.csv` only: one
row with `closed_date` before `opened_date`, one duplicate `ticket_id`, one
`tower_id` matching no tower. `build_labels()` rejects each and **counts** the
rejection in `maintenance_manifest.json`'s `rejected_tickets` field - a silent
drop here would repeat the failure class that once produced a 97%-smaller
dataset from a partial cache (see `CLAUDE.md`'s `fetch_hand` note).

## What real data would change

The pipeline is the deliverable; the label is the placeholder. Given a few
hundred real work orders - `site_id`, `date`, `what_was_done` - this generator
becomes an **ingest** rather than a simulator: `maintenance_labels.csv` keeps
its exact schema (`tower_id, state, n_corrective_36mo, months_in_service,
lambda_true, n_site_visits_36mo, needed_corrective_maintenance`), and
`model/maintenance_need.py` and `notebooks/maintenance_need.ipynb` do not
change at all. That substitution being a one-file change is the reason this
was built as a generator with a real schema rather than a set of inline test
fixtures.

Two things real data would **not** fix, worth stating alongside it:

- **Tower positions are OpenStreetMap features, not an operator asset
  register.** Per-state counts describe mapping density, not deployment, and
  the synthetic generator inherits that bias - it simulates history only for
  the towers OSM happens to know about.
- **96% of masts carry no radio tag**, so `equipment` was dropped as a model
  factor: the booster split on `radio` zero times across 91 trees, its
  attribution share was exactly 0.000, and no tower could ever be
  equipment-dominant. The generator still simulates an equipment cause (it is
  a real mechanism and it appears in `maintenance_records.csv` as a
  `root_cause`), so the model now carries an unmodelled hazard component —
  deliberately, because deleting it from the label to flatter the model is the
  move this whole document exists to avoid. Fixing it needs an asset register.

## A monthly panel/recency framing was tried, measured, and not shipped

`prepare_maintenance_records.py` can also build `maintenance_panel.csv` — one
row per (tower, month) rather than one row per tower, with three real
condition-based-maintenance features computed from history strictly BEFORE
each row's own month (never leakage): `months_since_last_corrective`,
`n_corrective_to_date`, `is_monsoon_month`. This is the standard reliability-
engineering framing (bathtub-curve recency) real CBM systems use, and it is
~30x more training rows (~35,000 vs 1,164).

It was trained, evaluated, and **not adopted as the served model**, because
every accuracy metric came back lower than the single-snapshot version. The
table below is from **generator v1.0**, before the retune; both columns move
under v2.0 and the panel has not been re-run, but the base-rate argument the
comparison rests on is unchanged:

| | single-snapshot (served) | monthly panel, 6-month horizon (not served) |
|---|---|---|
| Target | any corrective ticket in 36 months | a corrective ticket within the next 6 months |
| Base rate | 22.4% | 5.15% |
| lightgbm PR-AUC | 0.292 | 0.062 (technical) / 0.070 (product view) |
| lightgbm ROC | 0.581 | 0.575 / 0.580 |
| Beats ahp_index by | +0.062 PR-AUC | +0.012 / +0.020 PR-AUC |
| Gap to oracle | 0.280 (clear) | 0.226 / 0.194 (clear) |

The gap is not a modelling failure - it is base-rate arithmetic. PR-AUC scales
with prevalence, and a rarer, forward-looking 6-month event is a strictly
harder statistical problem than a 36-month "did this ever happen" label,
independent of feature quality or hyperparameters. A 1-month horizon (base
rate 0.94%) was tried first and collapsed further (PR-AUC 0.013), confirming
the pattern rather than a one-off. Widening the horizon back toward 36 months
would recover the easier framing's numbers by definition, at which point it
stops being a "recency" framing at all - the tension between "more realistic"
(shorter, rarer, forward-looking windows) and "higher absolute accuracy
numbers" (longer, commoner, backward-looking windows) is real for this
generator, not an artifact of tuning.

What survived from the experiment: the panel-generation code
(`build_panel`, `PREDICTION_HORIZON_MONTHS`) stays in
`prepare_maintenance_records.py`, tested (`data/test_maintenance_records.py`)
and working end to end, in case a future need (a genuinely time-varying
serving path, or a real dataset where recency turns out to carry more signal
than it does in this synthetic one) makes the harder framing worth the
accuracy cost. `model/maintenance_need.py` does not reference it - reviving it
means re-adding the three columns to `FEATURES` and `FACTOR_GROUPS`, exactly as
this session did once, and retraining.
