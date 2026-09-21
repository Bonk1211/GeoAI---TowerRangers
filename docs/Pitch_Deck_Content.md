# Pitch deck — slide content

**Project:** Tower Health Risk Index → Agentic Maintenance Scheduler
**Track:** ASEAN GeoAI Fusion 2026, Innovation
**Drafted:** 2026-09-20

Every number in this deck is traceable. Sources are named inline so a judge can
check one. Figures marked **[SYNTHETIC]** are measured against this project's
simulated maintenance register, not operator history — say that on stage, do not
hide it. Figures marked **[REAL]** are measured against observed satellite water
or published news.

---

## Slide 1 — User story: the MCMC officer at 3am

**Persona.** Encik Faizal, Network Resilience Officer, MCMC. Owns nothing, answers
for everything. When towers go dark, the Minister's phone rings, then his does.

**The worst night of his career** (this is the scenario to narrate):

> It is 1:30pm on 30 June. Rain starts over Penampang. By evening the district is
> declared a disaster area — the worst flood in 20 years, 23 villages under water.
> By the time he gets the first tower-status report, he already cannot reach
> anyone who could tell him more. Over four districts, **41 transmission towers
> are down.** He does not know which ones matter most. He does not know which
> roads are still passable. He does not know which crews are closest, or which
> are already stuck. He has a list, and a phone, and no order.
>
> **Four days later, 27 of those 41 towers are still dark.**

**The three problems we solve for him**

| # | His trouble | What it costs | What we give him |
|---|---|---|---|
| **1. He is blind before the event.** | Nobody can tell him which towers are fragile *until* they fail. Risk lives in engineers' heads and spreadsheets, one state at a time. | He cannot pre-position. Every response starts from zero. | A standing, national, per-tower maintenance-need score with **per-factor attribution** — he sees *why* a tower is exposed (flood / terrain / power / vegetation), not just that it is. |
| **2. He cannot turn a list into a plan.** | A ranked list of 41 towers is not a dispatch. Crew skills, depots, travel time, shift hours, SLA and monsoon windows all bind at once. | Crews are sent nearest-first, so the highest-risk site waits longest. | A constrained optimizer that packs real work orders into real crew-days — **travel measured from where the crew actually is**, not from the depot. |
| **3. He cannot defend the decision.** | When asked "why did that tower wait three days?", he has no answer that survives a select committee. | Loss of trust in the whole programme. | A deterministic `why-this-slot` explanation per assignment, rendered from solver state — **never written by an LLM.** |

**The framing line for the slide:** *He does not need a better report. He needs the
list to already be sorted before the rain starts.*

---

## Slide 2 — The statistics: post-event maintenance is the harm

### Headline option A (recommended — it is the strongest and least contestable)

> # 41 towers down. 14 restored. 27 still dark on day four.
> ## And only **2 of the 41** were actually broken.

### Headline option B (use if you want the human angle first)

> # For four days, 23 flooded villages could not call for help —
> ## because the towers that would have carried the call had no power and no road.

### The supporting breakdown — this is the slide's real payload

Sabah, 30 June – 3 July 2024. Penampang, Kota Kinabalu, Tuaran, Kota Marudu:

| Cause of outage | Towers | Share |
|---|---:|---:|
| Power disconnected by SESB for safety | **34** | 83% |
| Unreachable — roads flooded | **5** | 12% |
| Electronic equipment actually damaged | **2** | 5% |
| **Total affected** | **41** | |

**Restoration, day 4 (3 July 2024):** 14 restored, **27 still non-operational.**
Penampang alone: 13 repaired, 19 still down.

**Say this out loud:**
> Ninety-five percent of that outage was not a broken tower. It was a tower that
> lost power, or a tower nobody could reach. Those are the two things you can see
> coming from orbit. Those are the two things post-event maintenance can never fix,
> because by the time the work order exists, the road is already under water.

### The "this keeps happening" beat

September 2025, Sabah again: **266 telecommunications towers affected by power
outages; 147 restored** — recovery still running in phases, more than a year after
the 2024 event. MCMC again deployed its PRIME mobile unit to Penampang.

**The one-line conclusion:** *The failure mode is stable, repeating, and
geographically predictable. That is exactly the kind of failure you schedule
against, not react to.*

**Sources to put in small type on the slide:**
Borneo Post, 3 Jul 2024 · Bernama, 3 Jul 2024 · Daily Express (Penampang disaster
declaration, 30 Jun 2024) · Borneo Post, 16 Sep 2025 · IFRC GO emergency 7051.

---

## Slide 3 — The one question for the room

Put this on a black slide, alone, and wait.

> # Did anyone check on those 41 towers **before** the rain?

Then the follow-up, spoken not written:

> Every one of those 34 towers that lost power had a distance to the nearest grid
> line. We can measure it from satellite. Every one of those 5 towers cut off by
> road had a height above the nearest drainage. We can measure that too. Nobody
> looked, because nobody had a reason to look at *that* tower on *that* Tuesday.
>
> **We are not predicting the flood. We are ranking which towers you should have
> already visited by the time it arrives.**

### Alternative phrasings if you want a softer open

- *"Show of hands — who here has a maintenance schedule that changes when the
  weather forecast changes?"*
- *"How many of the 41 do you think were on someone's maintenance list that week?"*

**Do not ask a question you cannot answer in the next 60 seconds.** Slide 4 is the
answer, so move straight into it.

---

## Slide 4 — What we built: three sectors

### Sector 1 — DETECT · Tower Health Risk Index

*Score every tower in Malaysia, continuously, from open satellite data.*

- **1,164 towers, all 16 states**, scored 0–1 for maintenance need
- **12 measured features → 4 risk factors**: flood, terrain, power, vegetation
- **Per-tower attribution** — every score decomposes into which factor drove it,
  so the score produces an *action*, not just a number
- **Uncertainty is shown, never hidden** — rank-stability under weight
  perturbation; when it cannot be computed, the UI says so instead of printing zero
- **Not a failure predictor.** The target is "a corrective work order was raised."
  We never claim to predict an outage — and we say so on the product itself.

### Sector 2 — DECIDE · Work orders with urgency

*Turn a risk number into a dated job with a crew type and a parts list.*

- **Dominant factor → intervention**, via config not code
  (`flood` → drainage/plinth work, `power` → genset & feeder, `vegetation` →
  clearance, `terrain` → access & anchoring)
- **Urgency is the only place live weather enters.** A 24-hour GFS rainfall and
  SMAP soil-moisture forecast shortens deadlines — but **only for flood- and
  terrain-coupled towers**, proportional to that tower's own flood share.
  Rain does not accelerate radio-unit wear, so an equipment-dominant tower's
  90-day refresh does not move. Measured live: a 0.98-flood-share tower went
  **11 → 9 days** while a 0.10-share tower went **37 → 35**.
- **It can only shorten, never extend.** A dry forecast is not evidence of safety.

### Sector 3 — DISPATCH · Constrained crew scheduling

*Pack the work into real crew-days that real crews can actually do.*

- **30 crews, 16 territories, 4 capabilities** (civil / power / RF / electrical)
- **Capacity is a time budget, not a job count** — a placement is accepted only if
  `cursor + travel + duration` finishes inside the shift, with travel measured
  **from the crew's current position**, not the depot
- **Reserve capacity is protected absence** — crew-days deliberately held open for
  emergencies, and a job may only consume one to save an SLA
- **Unscheduled work is always returned explicitly**, never silently dropped.
  Measured nationally: 117 maintain-band orders → **57 assignments across 11 crews
  in 10 territories**, with the other 60 returned as `unscheduled`
- **The optimizer decides; the LLM never does.** The agent calls typed tools and
  reports their return values verbatim. It cannot invent a schedule.

### The connective tissue (mention, don't slide it)

A **disaster simulation tab** replays a real flood timeline against the *live*
optimizer, so MCMC can rehearse the Penampang night before it happens again.

---

## Slide 5 — Unique selling points (feature-based)

Six things the product **does** that a risk dashboard, a flood map or a work-order
system does not. Each has a 4–5 word slide headline — say the headline, demo the
feature, then the number.

| # | Headline (say this) | What it actually does | Why nothing else does it |
|---|---|---|---|
| **1** | **Every score names its fix** | The risk number is not a number. It decomposes per tower into **flood / terrain / power / vegetation**, and the dominant factor auto-generates the work order: crew type, parts list, on-site hours, and a plain-language reason. A flood-dominant tower raises drainage and plinth work for a **civil** crew; a power-dominant one raises genset and feeder work for a **power** crew. | Risk dashboards stop at the score and hand a ranked list to a human. We go **detect → decide** in one click, because attribution is a first-class output, not a debugging aid. |
| **2** | **Live forecast shortens the deadline** | A 24-hour GFS rainfall and SMAP soil-moisture read moves `urgency_days` — but **only for flood- and terrain-coupled towers, proportional to that tower's own flood share.** Measured live: a 0.98-flood-share tower went **11 → 9 days** while a 0.10-share tower went **37 → 35**. An equipment-dominant tower's 90-day refresh does not move, because rain does not accelerate radio-unit wear. | Everyone else lets weather move the **score**, which reshuffles the ranking three times a day. We move the **deadline** instead — and only downward, with a floor, only where the physics couples. |
| **3** | **A schedule, not a list** | Work orders are packed into real crew-days by a constrained optimizer. **Capacity is a time budget, not a job count** — a placement is accepted only if `cursor + travel + duration` finishes inside the shift, with travel measured **from where the crew actually is**, not from the depot. 30 crews, 16 territories, 4 capabilities. **Reserve crew-days are held open** and only an SLA breach may spend one. | A ranked list of 41 towers is not a dispatch. Skills, depots, travel, shift hours, SLA and monsoon all bind at once — and a tight tower cluster fits more jobs than a scattered one at identical risk. |
| **4** | **Every assignment explains itself** | Click any bar on the schedule board and it renders **why this crew, this day, this slot** — from solver state, deterministically. If a tower entered the run on hot telemetry rather than standing risk, the explanation **says so**, so a planner never sees a low-risk site dispatched ahead of higher-risk ones with nothing accounting for it. | It is **rendered, never written by an LLM.** The agent calls typed tools and reports return values verbatim. That is the difference between an answer you can take to a select committee and one you cannot. |
| **5** | **Rehearse tomorrow's flood today** | A full disaster-simulation tab replays a real flood timeline — towers going dark, coverage collapsing, crews moving — and at every dispatch beat it calls the **real `/schedule/*` optimizer**, not a script. On-screen copy states which actions are real MCMC practice and which are demo-only. | Nobody can rehearse a Penampang night today. This turns the plan into something you can **run before the rain**, and it is scored by the same optimizer that will run on the night. |
| **6** | **The app audits its own model** | A live **Model Health** page reads the training artifact directly and shows the confusion matrix, leak check, split inflation, beats-index margin, matched-budget verdict, base-rate range and demo-case outcomes. Provenance first, guardrails second, numbers third. **It has no offline fixture** — if the measurement is unavailable, the page says so rather than showing a fabricated one. | Every other system asks you to trust its number. Ours ships the evidence that the number is trustworthy **on the same screen as the number**, and cannot drift from the notebook because both read one file. |

**Runners-up — swap in if one above lands flat for your audience:**

- **Move the weights, watch everything** — drag the AHP factor sliders and the whole national map re-scores live, server-authoritative. Lets a planner ask *"what if access matters more than water this monsoon?"* and see the answer in 300 ms.
- **Drag the map, re-cut the bands** — scoring an area of interest re-filters the feature table and **re-cuts the decision bands for that extent**, so a state planner ranks against their own state, not against Sarawak.
- **The planner keeps the pen** — a ticket routed to Schedule is a *proposal*: it suggests a crew, previews the cost, and books nothing until a human approves. Rejection and failure are both first-class outcomes.

**The six headlines alone, for a build-up slide:**

> Every score names its fix
> Live forecast shortens the deadline
> A schedule, not a list
> Every assignment explains itself
> Rehearse tomorrow's flood today
> The app audits its own model

---

## Slide 6 — Dataset documentation

### 6.1 The spine — what every tower row is built from

| Layer | Source | Licence / access | Used for | Grain |
|---|---|---|---|---|
| Tower locations | **OpenStreetMap** (via Overpass) | ODbL | 1,164 communication towers, all 16 states | per tower |
| Elevation, slope, ruggedness | **Copernicus DEM GLO-30** (Planetary Computer) | Open, free | `elevation_m`, `slope_deg`, `tri` | 30 m raster |
| Height above nearest drainage | **ASF Global 30 m HAND v1** | Open | `hand_m` — the single strongest flood feature | 30 m raster |
| Water & power proximity | **OpenStreetMap** | ODbL | `dist_water_m`, `dist_power_m` | vector |
| Administrative territory | **geoBoundaries ADM1** | CC-BY | `territory` → crew assignment | polygon |
| Vegetation | **Sentinel-2 EVI** (Earth Engine) | Open | `evi_median`, `evi_p10` | 10 m, annual windows |
| Land cover | **ESA WorldCover** | CC-BY-4.0 | `land_cover_class`, sampled at 100 m buffer | 10 m |
| Soil | **SMAP / soil property grids** | Open | `soil_moisture_mean`, `soil_moisture_p90`, `clay_pct` | coarse raster |

**Served model input: 12 features → 4 factor groups.**

| Factor | Features |
|---|---|
| flood | `hand_m`, `dist_water_m`, `soil_moisture_mean`, `soil_moisture_p90` |
| terrain | `slope_deg`, `tri`, `elevation_m`, `clay_pct` |
| vegetation | `evi_median`, `evi_p10`, `land_cover_class` |
| power | `dist_power_m` |

### 6.2 Ground truth — the flood factor is validated against observed water

| Label set | Source | Points | Positive rate | Role |
|---|---|---:|---:|---|
| **GSW** | JRC Global Surface Water v1.3, Landsat 1984–2020, 400 random 0.05° land cells | **38,948** | 0.56% | Cross-validated, parameters chosen here |
| **Event** | **UNOSAT FL20191217MYS**, Sentinel-1, 15 Dec 2019, Johor | **12,000** | 2.06% | **Held out. Never fitted. Scored once.** |

Three rules that make the evaluation honest, and are worth saying aloud:
1. **Every split is GroupKFold on ADM1 state** — points 5 km apart share a
   catchment, so a random split scores near-duplicates against each other.
2. **Permanent water (occurrence ≥ 75%) is excluded from both classes** — finding
   rivers is a different question.
3. **Weight tuning stays inside the flood factor.** `power` and `vegetation` have
   no inundation signature; refitting the whole index against a water label would
   rebuild exactly the circularity that killed our first classifier.

### 6.3 Live layers (request-time, optional — the app boots without them)

| Layer | Source | Cadence | Enters the model? |
|---|---|---|---|
| Rainfall | **JAXA GSMaP** `hourlyPrecipRateGC` | hourly, ~17 h latency | No — map context |
| Rainfall forecast | **NOAA GFS**, next 24 h | 4 runs/day | **Yes — urgency only** |
| Soil moisture | **NASA SMAP** | daily | **Yes — urgency only** |
| River outlook | **CEMS GloFAS** days 1–3, WMS | daily | **No — deliberately excluded.** Basin discharge sampled at a point is a category error. |
| Flood extent | Sentinel-1 / Sentinel-2 / Landsat, JRC-corrected | per overpass | No — map context |
| Active fire | **VIIRS NOAA-20 LANCE NRT** | ~daily | **No.** A thermal anomaly can be a plantation burn. It reaches work through a reviewed inspection path, never through `risk`. |

### 6.4 The honest gaps — put this on the slide, do not bury it

| Field | Status | Why it matters |
|---|---|---|
| `radio` (air interface) | **`UNKNOWN` for 1,119 of 1,164 rows (96.1%)** | The `equipment` factor was **dropped** — the trained model split on it **0 times across 91 trees**, gain 0.0000. Needs an operator asset register. |
| `flash_density` | **null, all 1,164 rows** | Lightning factor unusable. NASA climatology needs Earthdata login and its cells are too coarse. |
| `age_years` | **null, all rows** | No open source establishes tower install dates. We refused to substitute a proxy. |
| `exposed_pop` | null nationally (populated in the 132-row Sunway pilot from WorldPop) | Population weighting is pilot-only. |
| Maintenance history | **None exists.** | See 6.5. |

**Provenance rule we enforce in code:** tower positions are OSM features, not an
operator register, so **per-state counts describe OSM mapping density, not
deployment** (Sarawak 232, Selangor 228, Perlis 2). They are never rendered as
coverage. And 96% of masts carry no radio tag, so we write the literal string
`UNKNOWN` rather than NaN — "we do not know" stays visible in the CSV instead of
being hidden inside a `.fillna(0.5)`.

### 6.5 The synthetic register — declare it before a judge finds it

No operator or MCMC maintenance history was available for this prototype. The
maintenance label is **simulated**, 1,164 towers × 36 months
(2023-08-01 → 2026-08-01), base rate **0.2088**, 243 positives.

Five rules keep it from repeating our first classifier's failure:

1. **The generator cannot import the risk index.** An AST test fails the build if
   `risk_index` ever appears in its imports.
2. **Hazard is driven by observed measurements** (GSW occurrence, sampled EVI,
   clay, soil moisture, HAND, slope) through the generator's *own* functional
   forms — never the index's membership curves.
3. **A per-site latent** (build quality, drainage, genset age) perturbs the label.
4. **The generator's own latent intensity is scored as an oracle** and reported
   beside every model number. A model reaching the oracle means the generator
   leaked, not that the model is good.
5. **Leak check published:** gap to oracle **+0.2012**, verdict **clear**;
   random-vs-grouped split inflation **+0.0269**.

> **The sentence to say:** *Every accuracy number on the next slide is measured
> against synthetic labels. It validates our evaluation pipeline, not our
> real-world accuracy. The flood numbers are different — those are measured
> against observed satellite water, and they are real.*

---

## Slide 7 — Why ensemble: measured, not asserted

### 7.1 Single scorers, ranked — 1,164 towers, GroupKFold on state, top-10% budget

| Scorer | ROC-AUC | PR-AUC | F1 @10% | TP | FP | Precision | Lift |
|---|---:|---:|---:|---:|---:|---:|---:|
| `hand_only` — best single feature | 0.6195 | 0.2824 | 0.197 | 37 | 96 | 0.278 | 1.33× |
| `ahp_index` — physics-only baseline | 0.6845 | 0.3371 | 0.278 | 50 | 67 | 0.427 | 2.05× |
| **`lightgbm` — served model** | **0.8971** | **0.7509** | **0.550** | **99** | **18** | **0.846** | **4.05×** |
| `oracle` — generator's own intensity (ceiling) | 0.9845 | 0.9521 | 0.650 | 117 | 0 | 1.000 | 4.79× |

**[SYNTHETIC]** · base rate 0.2088 · `beats_index_by +0.4138 PR-AUC`

**Read it this way:** the learned model beats the physics index by **+0.41 PR-AUC**
and sits **0.20 below the oracle** — close enough to be useful, far enough to prove
nothing leaked.

### 7.2 The ensemble, on a matched budget — the only fair comparison

This is the comparison that matters, and it is the one we got wrong first.
**Anything that dispatches more towers must be scored against a *cut* that
dispatches the same number** — not against the untouched top-10%.

Budget fixed at **116 towers** either way:

| Configuration | F1 | TP | FP | Precision | Recall |
|---|---:|---:|---:|---:|---:|
| Model alone, cut lowered to 116 | 0.5460 | 98 | 18 | 0.845 | 0.403 |
| **Model + condition rank-blend (w=0.25)** | **0.5738** | **103** | **13** | **0.888** | **0.424** |
| **Delta** | **+0.0278** | **+5 real jobs found** | **−5 wasted trips** | **+0.043** | |

**Verdict recorded in the artifact:** `ensemble_beats_matched_budget`.

Held-out seeds 5–9, same protocol:

| Method | F1 | TP | Δ vs model alone | Seeds won |
|---|---:|---:|---:|---:|
| LightGBM alone | 0.6623 | 138.4 | — | — |
| Gate on condition (p85, cap 5%) | 0.6497 | 135.8 | **−0.0125** | **1 / 5** |
| Gate on condition (p70, cap 20%) | 0.6738 | 140.8 | +0.0115 | 5 / 5 |
| **Rank blend, w = 0.25** | **0.6814** | **142.4** | **+0.0191** | **5 / 5** |

### 7.3 So — why ensemble? Three answers, in order of strength

**1. Because the two members are complementary, and we measured it.**

| Ranker, standalone | ROC-AUC |
|---|---:|
| Supervised model | 0.905 |
| Telemetry condition | 0.884 |
| **50/50 rank blend of the two** | **0.929** |

The blend is **above both members**. That is the textbook definition of a useful
ensemble, and it is a measurement, not a hope.

**2. Because one member can read data the other is structurally forbidden to use.**
The 30-day telemetry block ranks the label at **ROC 0.9548**. The supervised model
cannot train on it — the counters cover 30 days, the label covers 36 months, so
this dataset holds **no aligned (telemetry, outcome) pair to fit**. An
unsupervised score needs no labels and can read it the day it starts flowing.
*That asymmetry is the only reason measured here that actually works.*

**3. Because we tested every candidate against a necessary condition and rejected
two of three.**

| Candidate second opinion | In-band AUC | Model AUC | Δ | Shipped? |
|---|---:|---:|---:|---|
| Isolation Forest (novelty) | 0.4962 | 0.6766 | −0.180 | **No — descriptive only** |
| Satellite EVI change | 0.6072 | 0.6745 | −0.067 | **No — weight 0.0** |
| **One-sided telemetry condition** | **0.8096** | 0.6745 | **+0.135** | **Yes — w = 0.25** |

**Why the forest fails, in one line:** an isolation forest scores *|deviation from
typical|*, and maintenance need is **monotone** — a site with unusually *few*
alarms is exactly as anomalous as one with unusually many. A two-sided statistic
aimed at a one-sided target cancels most of the signal. Same telemetry column,
read one-sidedly: **0.8096.** Read by the forest: **0.4962.**

### 7.4 Two more honesty beats, if you have time

- **The shape mattered more than the member.** A *gate* touches one threshold and
  reorders nothing; a *rank blend* uses the signal on every tower. Gate −0.0125,
  blend +0.0191, same input.
- **Weight is the midpoint, not the argmax.** Swept on seeds 0–4 (0.2 and 0.3 both
  win 5/5), set to **0.25**, then verified on unseen seeds 5–9. Past ~0.4 the
  blend is worse than the model alone.
- **`risk` itself is never blended.** The blend enters `priority`, which cuts the
  decision bands. `risk` stays the model's calibrated probability — the quantity
  the oracle check compares against.
- **A tower with no telemetry keeps its bare model rank.** Missing telemetry is not
  evidence of a healthy site, and a fleet part-way through a monitoring rollout
  must not de-prioritise its unmonitored towers.

### 7.5 The flood factor — the one number that is [REAL]

Held out on **UNOSAT's Sentinel-1 analysis of the 15 Dec 2019 Johor flood**, never
fitted, 12,000 points, 2.06% positive:

| Configuration | ROC-AUC | PR-AUC | TP | FP | FN | Lift |
|---|---:|---:|---:|---:|---:|---:|
| Flood membership, ungated | 0.8649 | 0.1194 | 136 | 1064 | 111 | 5.50× |
| **Flood membership + slope gate (shipped)** | **0.8670** | **0.1734** | **146** | **1054** | **101** | **5.91×** |
| Full composite index | 0.8548 | ~0.144 | 127 | — | — | — |

**Every confusion cell improves.** PR-AUC **×1.45 held out, ×1.60** on the national
GSW label. And note the third row: the *flood factor alone* beats the *full index*
at finding flood — which is exactly why attribution is a product feature and not a
debugging aid.

---

## Slide 8 — Win–win: who gains what

| Party | What they get | The number or mechanism behind it |
|---|---|---|
| **MCMC** | A defensible national picture, and an answer to "why did that tower wait." | 1,164 towers scored nationally with per-factor attribution; a deterministic `why-this-slot` string per assignment, rendered from solver state, never LLM-written. Regulatory framing maps to **MCMC MTSFB TC G041:2023** §6.3.2 (soil) and §6.3.3 (vegetation). |
| **Citizens in flood-prone districts** | The tower that carries their emergency call is visited *before* the monsoon, not four days after the water arrives. | The 2024 Sabah event: 39 of 41 outages were power or access, both visible from orbit months ahead. |
| **Tower companies / TowerCos** | Fewer wasted truck rolls and a shorter, better-ordered dispatch list. | At matched budget: **+5 real jobs found, −5 wasted trips** per 116 dispatches; precision 0.845 → 0.888. |
| **Field crews** | Schedules that respect the shift, the travel, and the skill. Reserve days that are actually protected. | Capacity is a *time budget* — `cursor + travel + duration` must finish inside the shift, travel measured from current position. Reserve crew-days held open; only an SLA breach may consume one. |
| **Telco operators (Maxis / CelcomDigi / U Mobile / TM)** | Coordinated, non-duplicated response across shared sites, and an SLA they can evidence. | 30 crews across 16 territories; unscheduled work returned **explicitly**, never dropped, so nobody's site vanishes from the plan silently. |
| **NADCOM / state disaster agencies (APM, JKM)** | A rehearsable plan. The simulation tab replays a real flood timeline against the *live* optimizer. | Every dispatch beat in the simulation calls the real `/schedule/*` endpoints. On-screen copy states which actions are real practice and which are demo-only. |
| **Utilities (SESB / TNB)** | The joint failure mode finally becomes visible. | 34 of 41 Sabah outages were *grid* disconnections. `dist_power_m` is a served model feature and `power` is a live factor with its own crew type and work order. |

**The closing line for this slide:**
> *Nobody here has to lose for someone else to win. The tower company saves the
> truck roll, the crew gets a shift that ends on time, and a village in Penampang
> keeps its signal. Those are the same action.*

---

## Slide 9 — System architecture: the closed loop

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   ①  OBSERVE                              ②  DETECT                          │
│   ──────────                              ──────────                         │
│   Copernicus DEM GLO-30                                                      │
│   ASF HAND v1              ──────────▶    tower_feature_table.csv            │
│   Sentinel-2 EVI                          1,164 towers · 12 features         │
│   ESA WorldCover                                   │                         │
│   SMAP soil moisture                               ▼                         │
│   OpenStreetMap                           model/maintenance_need.py          │
│   geoBoundaries ADM1                      LightGBM · 4 factor groups         │
│                                           → risk + SHAP attribution          │
│   Site telemetry (30d)                             │                         │
│   rectifier · battery · door ──────┐               │                         │
│                                    ▼               ▼                         │
│                            model/ensemble.py :: blend_priority               │
│                            rank blend, w = 0.25 → PRIORITY                   │
│                            (risk itself is never touched)                    │
│                                            │                                 │
│   GFS 24h rainfall ────┐                   ▼                                 │
│   SMAP soil moisture   │          ③  DECIDE                                  │
│                        │          ──────────                                 │
│                        │          decision bands cut on priority             │
│                        └────────▶ scheduler/urgency.py                       │
│                        (shortens ONLY flood/terrain,                         │
│                         proportional, floored, never extends)                │
│                                            │                                 │
│                                            ▼                                 │
│                                   scheduler/actions.py                       │
│                                   dominant_factor → work order               │
│                                   (config/actions.yaml — crew type,          │
│                                    parts, duration, why-string)              │
│                                            │                                 │
│                                            ▼                                 │
│                                   ④  DISPATCH                                │
│                                   ────────────                               │
│                                   scheduler/optimize.py                      │
│                                   greedy · priority × urgency                │
│                                   bin-packed into crew-days                  │
│                                   30 crews · 16 territories · 4 skills       │
│                                   reserve held back · SLA · monsoon          │
│                                            │                                 │
│                        ┌───────────────────┼───────────────────┐             │
│                        ▼                   ▼                   ▼             │
│                  scheduled            unscheduled          reserve           │
│                  (57 assignments)     (returned            (protected        │
│                        │               explicitly)          absence)         │
│                        ▼                                                     │
│                  ⑤  ACT                                                      │
│                  ───────                                                     │
│                  Ticket → crew → site visit → outcome                        │
│                        │                                                     │
│                        ▼                                                     │
│                  ⑥  LEARN                                                    │
│                  ─────────                                                   │
│                  model/feedback.py — observation ledger                      │
│                  every served observation logged UNLABELED                   │
│                  only CONFIRMED binary outcomes become                       │
│                  deduplicated training candidates                            │
│                        │                                                     │
└────────────────────────┼─────────────────────────────────────────────────────┘
                         │
                         └──────────▶ retrain ──▶ back to ② DETECT
                                      (manual, gated, never automatic)
```

### The four things to point at while this is on screen

1. **The loop actually closes.** `model/feedback.py` writes every served
   observation to a ledger as *unlabeled*. Only a confirmed binary outcome from a
   real crew visit becomes a training candidate. **Retraining is manual and
   gated** — we do not let the system quietly retrain itself on its own
   predictions, which is how these loops poison.

2. **Two seams, deliberately separated.** Weather enters at ④ urgency, never at ②
   risk. If the forecast moved the score, the ranking would reshuffle three times
   a day and the stability claim would be meaningless — and a score that tracks
   the weather *reads as a failure predictor*, which we are forbidden to be.

3. **The LLM sits beside the loop, never inside it.** The agent calls four typed
   tools and reports their return values verbatim. Remove the API key and a
   deterministic fallback emits the same event vocabulary. **The optimizer decides.**

4. **`GET /model/health` audits the loop from inside the product.** Leak check,
   split inflation, beats-index margin, the `detector_auc > model_auc` condition,
   matched-budget verdict, base-rate range, demo cases. It reads the training
   artifact directly, so the UI cannot drift from the notebook. **There is no
   offline fixture for that page** — fabricating a confusion matrix on the one
   screen whose job is telling you whether to trust the model would be the worst
   place in the app to invent a number.

---

# What to add to solidify the pitch

Ordered by how much each one moves a judge, against how long it takes to build.

### Tier 1 — do these, they are the difference between a good and a winning pitch

**A. The Sabah counterfactual. This is your strongest possible slide and you do
not have it yet.**
Run the actual pipeline over the 41 Sabah towers from 30 June 2024. Answer one
question on screen: *how many of those 41 were in our top decile beforehand?*
Whatever the number is, show it. If it is 30 of 41, you have proven the thesis. If
it is 12 of 41, you say "twelve towers would have been visited before the rain,
and here is the honest reason the other 29 were not" — and you are still the only
team in the room who measured themselves against a real event. **This is the
highest-leverage thing you can build before the deadline.**
*Caveat to check first:* OSM tower coverage in Sabah is mapping density, not
deployment, so state up front how many of the 41 you could even locate.

**B. A single quantified before/after for the scheduler.**
You have `risk_weighted_wait_reduction_pct` — greedy versus naive nearest-first,
same optimizer, differing only in sort key. **Run it nationally and put the number
on Slide 4.** Right now Sectors 1 and 2 have hard numbers and Sector 3 has
architecture. One number fixes that. (Say the ratio, not the absolute figure —
the absolute value is not comparable across releases.)

**C. Cost, in ringgit, once.**
Every judge silently converts your F1 into money. Do it for them with one honest
arithmetic line: *at matched budget we find 5 more real jobs and avoid 5 wasted
truck rolls per 116 dispatches — at an assumed RM X per roll, that is RM Y per
cycle per 116 towers.* Mark the assumption as an assumption. One slide, one
asterisk, enormous effect.

**D. A 60-second live demo, rehearsed, with the backend already warm.**
Map → click a high-risk tower → attribution panel → work order → schedule board →
`why this slot`. The `why-this-slot` string is your proof that the optimizer
decides. Do not narrate the code. **Have the offline fixture path tested as your
fallback, and if it fires, say "we are on fixtures now" out loud** — your whole
deck is built on not hiding that, and a judge who catches you hiding it there
discounts everything else.

### Tier 2 — strong additions if time allows

**E. "What we deleted" as an actual slide.**
The withdrawn 0.974-AUC classifier, the rejected isolation forest, the rejected
change-detection blend (weight 0.0), the dropped `equipment` factor (0 splits
across 91 trees), the dropped GSW columns (lift 0.99× = zero information), the
deleted k-means typology. Title it **"Six things we built and threw away."**
Most teams show only what survived. This slide is unfakeable — you cannot
retrofit it the night before — and it is the single clearest signal of rigour
available to you.

**F. The deployment path, in three lines.**
Judges score feasibility. Today → runs on open data, no operator integration
needed. Phase 2 → an operator asset register unlocks `equipment` and `age_years`.
Phase 3 → real work orders replace the synthetic register and the ledger closes
the loop for real. Name what each phase needs *from someone else*; it reads as
realism, not as a gap.

**G. The one-line answer to "how is this not just a flood map?"**
Someone will ask. Prepare it: *"A flood map tells you where water is. We tell you
which of 1,164 specific assets a specific crew should visit on a specific Tuesday
— and the flood factor alone beats our own full index at finding flood, which is
why attribution is a product feature."*

### Tier 3 — polish

**H. Name the limits before the Q&A does.** One small slide: synthetic labels ·
OSM coverage ≠ deployment · no asset register · no lightning climatology · flood
validated on observed water, everything else on simulated work orders. Judges test
whether you know your own weaknesses. Answering first converts a liability into a
credibility beat.

**I. Sharpen Slide 3 for a Malaysian room.** "Did anyone check on those 41 towers
before the rain?" lands harder than an abstract question, because the room
probably remembers Penampang.

**J. Cut Slide 7's tables in half for the live deck.** Keep 7.1, 7.2 and the
complementarity block (0.905 / 0.884 / **0.929**). Move the rest to a backup
slide after the closing — then pull it up when a technical judge asks. Having the
answer ready *and not having led with it* reads better than either.

### One thing to remove

Do not put PR-AUC on the main deck without the base rate next to it. PR-AUC 0.17
on the Johor flood sounds bad and is actually a **5.9× lift on a 2% base rate**.
Either show both numbers or show the lift alone.
