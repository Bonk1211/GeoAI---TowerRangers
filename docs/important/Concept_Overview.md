# Concept Overview — Predictive Maintenance for Telecom Towers

**Team TowerRangers (HACK-MY-093)**
**ASEAN GeoAI Fusion 2026 · Innovation track — predictive maintenance & infrastructure intelligence**
**Read this first.** Feature detail lives in [PRD — Tower Health Risk Index](PRD_Tower_Health_Risk_Index.md) and [PRD — Agentic Maintenance Scheduler](PRD_Agentic_Maintenance_Scheduler.md); the ML build sits in [ML Implementation Plan](ML_Implementation_Plan.md).

---

## 2. The problem — two root causes

Malaysian tower maintenance today fails in two distinct ways, not one:

**1. No adaptive decision.** Scheduling is fixed and manual. There is no automated way to weigh an incoming reactive ticket against already-planned work, so preventive work slips, the backlog rolls forward, and the schedule drifts off track. The system cannot reprioritize, re-sequence, or triage on its own — a human reconstructs the plan from scratch every time reality changes.

**2. No unified visibility layer.** Scheduling one visit means separately checking sources that don't talk to each other: access/permits (landlord or building-management email threads), spare-parts availability (warehouse inventory the field planner can't see live), crew certification and availability (HR rosters or a subcontractor's own system, rarely synced to dispatch), network shutdown windows (NOC-controlled, based on traffic), genset fuel/battery status (sometimes IoT-monitored, sometimes only a technician's verbal report), and subcontractor coordination (work dispatched and closed over WhatsApp, with photos of uncertain provenance). If any one of these is stale — a permit expired, a part gone — a crew is sent to a site it can't work, turning one trip into two.

This project attacks root cause #1 directly — the layers below are an adaptive decision engine, not a static one. Root cause #2 defines the next system this decision engine should sit on top of: an approach we describe but do not build.

---

## 3. The core idea

**Replace the missing sensors with remote sensing.** A tower's environment is observable from space even when the tower itself is not instrumented — the water that floods it, the slope it stands on, the storms that strike it, the grid it depends on. Deep learning turns that imagery and elevation data into condition indicators, and those indicators drive the maintenance decision.

That substitution — *satellite-derived environmental condition standing in for on-asset telemetry* — is what makes predictive maintenance possible for an asset class that has none, and it is why geospatial AI is load-bearing here rather than decorative.

---

## 4. What we built

Two layers that form one arc:

```
   detect            ──►      decide           ──►      dispatch
   Tower Health Index         Action + urgency         Crew schedule
   which towers are           what to fix and          who goes, when,
   fragile, and why           how soon                 with what parts
```

**Layer 1 — Tower Health Risk Index.** Every tower gets a bounded risk score, an uncertainty band, and a per-factor explanation, which resolve into a **maintain / watch / OK** decision with an urgency. Factors are derived from open geospatial data through deep-learning perception: water segmentation for flood exposure, building-footprint extraction for population exposure, DEM derivatives for terrain.

**Layer 2 — Agentic Maintenance Scheduler.** The explanation drives the intervention. A tower that is risky *because of flood* needs drainage and a raised cabinet; the same score driven by *equipment generation* needs a radio refresh and a capex line — different crew, different parts, different lead time. Those work orders are then packed into crew-days under travel, capacity, parts, and weather constraints. An agent handles the part no solver can: turning a planner's sentence into a constraint, and explaining what moved after a replan.

**The hinge between them is per-factor attribution.** It is the reason the second layer is possible at all, and why it is the one component we never cut.

---

## 5. Why geospatial AI is load-bearing

The risk drivers that matter most **exist in no table**. They have to be perceived from imagery and elevation data:

- **Flood exposure** — water bodies segmented from Sentinel-2 imagery, combined with height-above-drainage from a Copernicus DEM.
- **Exposure / consequence** — building footprints extracted from imagery where map coverage is sparse, giving the population actually affected by an outage. Reported alongside risk, **not inside it**: likelihood and consequence stay separate numbers so each stays interpretable.
- **Terrain** — slope and ruggedness from the DEM, proxying landslide risk, wind load, and access difficulty.

This is the deep learning in the system, and it runs on pretrained models via [`opengeos/geoai`](https://github.com/opengeos/geoai). Everything downstream — scoring, scheduling — is transparent arithmetic and optimization by design.

Every source is **open and global**, so the pipeline reruns for any area of interest with no new data collection.

---

## 6. What we predict — stated precisely

This is condition-based predictive maintenance, and we claim that use case directly. The precision matters at the boundary:

**We predict maintenance need, priority, and urgency.** Which towers warrant intervention, driven by which failure mechanism, and how soon — where urgency reflects how fast that mechanism acts, not merely how high the score is. A lightning-driven tower needs attention in days; an equipment-generation tower is a capex cycle.

**We do not predict failure events or probabilities.** "This tower has a 30% chance of failing within six months" is a hazard rate. Calibrating one requires failure logs, and no public tower-failure dataset exists. We will not fabricate labels to manufacture a number that looks more precise than the evidence supports.

Both statements are predictive maintenance. Only the first is defensible with open data — so we make the first, decline the second, and say why.

---

## 7. Two claims, two different kinds of evidence

The two layers sit in genuinely different epistemic positions, and we are explicit about which claim rests on what.

**The index does not claim accuracy.** With no failure labels there is no ground truth to validate a classifier against. Instead the index is built from failure physics — each factor maps to a named mechanism, each normalization curve has a physical justification — and we prove **robustness** rather than accuracy: perturb the weights a few hundred times and show the high-risk set stays the high-risk set.

**The scheduler does claim a number.** Comparing two dispatch policies on identical demand is a policy comparison, not a fabricated label, so the improvement in risk-weighted response time is a legitimate quantitative result.

Knowing which of those two situations you are in — and saying so — is the methodological core of this project.

---

## 8. What we are honest about

- Rank stability shows the ranking is not an artefact of arbitrary weight tuning. It does **not** prove the weights are correct — a stable ranking around a wrong center is still wrong. Establishing correctness requires real operator failure data, which is exactly the calibration path we have specified and deliberately left open.
- Risk factors are proxies for failure mechanisms, not observations of failure.
- Scheduler capacity parameters — crew counts, shift hours, travel speeds, part lead times — are stated assumptions, not operator data. The claim is the *policy delta*, which holds across consistent capacity settings.
- Pretrained perception models carry a domain gap on ASEAN imagery.
- Crowd-sourced tower positions are imperfect.

These are stated up front because they are what a reviewer would find anyway, and because the boundary of a claim is part of the claim.

---

## 9. Who it serves

- **Field-maintenance planners** — the primary user. They need *what to inspect and why*, not a number.
- **Network-ops planners** — sizing crews, prioritizing hardening capex.
- **Regulators** — assessing infrastructure resilience in service-obligation areas.
- **Subscribers** in rural and degraded-coverage areas, who absorb the long outages when a fragile tower fails.

---

## 10. Regional fit

**Scope is national — all of Malaysia**, with perception coverage staged by area of interest.

Every Malaysian tower is on the map and scored. Four factors — terrain, lightning, power distance, equipment generation — are computable nationally from rasters and tables. The two factors that require deep-learning perception, **flood exposure and population served**, run per area of interest, with **Kelantan** as the reference region: its northeast-monsoon flood exposure (November–March) exercises the flood pathway that dominates the model, and that same seasonality re-enters the scheduler as a constraint — civil work is not dispatched into flood-zone towers during monsoon.

Towers outside a perception area carry partial factors and are **flagged as such in the interface**. That flag is a roadmap rather than an apology: it shows exactly where running the pipeline next would add the most information.

Because every input is open and global, none of this is Malaysia-specific. The pipeline reruns for any ASEAN area of interest by changing a bounding box.

---

## 11. Track alignment — Innovation

The Innovation track asks for advancing **network planning and maintenance through geospatial intelligence**, with predictive maintenance and infrastructure intelligence as named use cases. This is exactly that: maintenance decisions derived from geospatial deep learning, for an asset class with no condition telemetry.

The work also touches **Efficiency** — field-force optimisation and workflow automation are precisely what the scheduling layer does — but the centre of gravity is the innovation of substituting remote sensing for absent sensors, so we compete under Innovation.

---

## 12. What we deliberately did not build

- A failure-*event* predictor. No labels exist; an unvalidated black box claiming failure probabilities is weaker than an honest, auditable index.
- A model trained from scratch. Perception is pretrained inference; the value is in the composition, not in re-deriving segmentation.
- A full country-scale run. Perception is demonstrated on one area of interest; the architecture is what generalizes.
- A third feature. Detect → decide → dispatch is a complete arc, and a third would dilute it.
- A unified visibility layer (root cause #2). Permits, parts, crew certs, NOC windows, genset status, and subcontractor coordination are named as the next system to build, not modeled here.

---

## 13. The demonstration in one line

Open the map. The highest-risk tower in the state is three years old — a calendar-based programme would skip it. Its breakdown reads *flood 0.41, power 0.28, terrain 0.19*, so the call is **maintain within 14 days**: drainage and a raised cabinet, civil crew, scheduled Tuesday. Drag the weight sliders and the ranking barely moves.

That is the whole product: **predictive maintenance for towers that were never instrumented — it sees what calendar-based inspection misses, and then does something about it.**
