# Disaster Response Actions (Sabah Flood Storyline)

Status: **concept/storyline note**, written 2026-09-14, revised 2026-09-17 (COW naming
corrected; antenna-tilting precedent added; scoping section on MCMC's existing pre-monsoon
selection added — every quote in it re-verified against a fetched source). Scopes the
"adaptive disaster response" narrative layer on top of the existing detect → decide
→ dispatch pipeline, anchored on the Sabah flood case as the pitch's worked example.

## Why this doc exists

Layers 1–2 (`docs/important/Concept_Overview.md`, `docs/Backend_Handoff.md`) already
cover routine predictive maintenance. This note extends the storyline into **disaster
response**: what happens before, during and after a flood event, and which parts of
that are real MCMC/telco practice (citable) versus demo-only visualisation (must be
labelled as such per the project's no-fabricated-capability rule, `docs/Backend_Handoff.md`
§0.6).

Every action below that is not marked "demo-only" is grounded in a cited news source
from actual Sabah flood responses (2024–2025), not invented.

**Primary worked example: the July 2024 west-coast flood**, not the September 2025 one.
Both are real and cited below, but July 2024 is the better spine for a beat table because
MCMC/Bernama reported it with **district-level tower counts and outage causes**, not just
an aggregate. September 2025 was larger (266 towers, 6 districts, 2,955+ people affected)
but reported only an aggregate power-outage count with no cause breakdown — still cited
where it adds real detail (MCMC PRIME deployment, NADI activation counts), but the tower/
district/cause numbers used for the beat table below are July 2024's.

**41 transmission towers were affected, across 4 districts** (2–3 Jul 2024): Penampang
(19 down, 13 restored within ~2 days), Kota Kinabalu (4 down, 1 restored), Tuaran (3 down),
Kota Marudu (1 down). 14 of 41 were back within roughly two days; full restoration took
longer than that window covers.

**Outage cause, broken down** — this is the detail September 2025's reporting lacked, and
it is the reason the "power outage" line below is not the only failure mode:

| Cause | Towers | Share |
|---|---|---|
| Power cut by SESB (utility), for safety | 34 | 83% |
| Access road flooded — crew could not reach the site | 5 | 12% |
| Equipment physically damaged | 2 | 5% |

The dominant mode is **utility-initiated power withdrawal**, not storm damage to the
tower itself — most of these sites did not break, they were switched off. That is why
generator dispatch (not structural repair) is the correct response for the large majority,
and why the "flooded road" cause is its own distinct failure mode: those towers are not
waiting on a part or a generator, they are waiting on the water to recede enough for a
truck to reach them, which is a real, reported sequencing constraint, not an invented one.

**Restoration priority is real and reported**: MCMC's joint task force explicitly
prioritises **"collector sites"** — the main sites that control coverage for the
surrounding area — ahead of other affected sites, then works through the rest. This is
citable, not invented, and it is a free ordering rule this project's beat table can state
even though the optimizer itself has no "collector site" role field to compute it from.

## What MCMC already does before a flood — and the gap it names

This section exists to stop the pitch overclaiming. **Selecting towers for preparation
before the monsoon is not a gap in MCMC's practice — it is already happening.** A claim
that this project "helps MCMC decide which towers to prepare" describes something they
already do, and a judge who knows the sector will say so.

The evidence comes from **two separate events**, and they must not be merged: they are
different states, different dates, and different triggers.

### Sabah, September 2025 — selection by outage frequency

After a power disruption affected telecommunications towers in Sabah, **eleven towers in
the West Coast Division** were identified for urgent site hardening (26 Sep 2025). The
Communications Minister described the selection basis directly:

> "Based on that data, I've requested that towers most frequently affected by outages be
> equipped with backup solutions such as generators or solar systems."

"That data" is the outage analysis the disruption prompted. The criterion is **how often a
tower has already lost power** — a backward-looking rule.

### Kelantan, January 2025 — the limit of that method, named

After 264 flood-affected towers were restored in Kelantan (20 Jan 2025), the Minister
cited **Tumpat** as an example of a location that had never experienced flooding before
but was impacted by the recent flood. On that basis he instructed MCMC to hold a workshop
with all network service providers and TNB:

> "to identify telecommunication tower locations that have never been impacted by floods
> but could be at risk in the future."

and directed that:

> "MCMC, in collaboration with telecommunications companies, should conduct a simulation
> workshop to assess the potential impact if water levels rise in tower areas."

### The gap is in what history can reach

Neither approach is wrong, and this doc makes **no claim about whether or how MCMC acted
on the January directive** — nothing found establishes that either way.

What the two events show together is a structural limit. A rule built on outage frequency
can only rank a site that has already failed. Tumpat is the case it cannot catch: no
history, then an outage. The ministry's own response to Tumpat was to ask for
identification of towers **with no flood history that are still at risk** — a
forward-looking capability that frequency-of-past-outage cannot produce by construction.

### Where this project sits — stated narrowly enough to defend

The served model **reads no outage history at all**. Its twelve features are geospatial:
`hand_m`, `dist_water_m`, `soil_moisture_mean`, `soil_moisture_p90`, `slope_deg`, `tri`,
`elevation_m`, `clay_pct`, `evi_median`, `evi_p10`, `land_cover_class`, `dist_power_m`
(verifiable from `GET /model/health` → `report.features`). A site surfaces from what the
ground and imagery say, whether or not it has ever failed.

| Claim | Holds? | Why |
|---|---|---|
| Surfaces at-risk sites with **no failure history** | ✅ | No outage-history feature exists to depend on |
| Scores **every tower in the population**, not a shortlist | ✅ | 1,164 sites scored |
| **Same score** orders pre-monsoon prep and post-impact restoration | ✅ | One risk index feeds both |
| "We would have caught Tumpat" | ❌ | Never tested. This project's data does not cover that site's history, and no backtest against the Jan 2025 Kelantan flood exists. |
| "This specific tower has never flooded, and we flagged it" | ❌ | **This project holds no per-tower outage history.** It cannot name any site's record, so it cannot demonstrate the never-flooded case for a single tower. |

The last two rows are the traps. The defensible claim is about **what the scorer reads** —
a property of the method, checkable in code — never about a named tower's past, and never
about Tumpat. Say "our score does not need a site to have failed before," not "we find
towers that never flooded," and never "we would have caught Tumpat."

**The simulation tab is the software form of the simulation workshop the ministry
directed** — a repeatable run of "what happens if water levels rise here," rather than a
meeting. It remains labelled scenario playback: the flood extent is a stated premise, not
a prediction.

## Timeline

### T-72h to T-24h — pre-event (forecast-driven)

- GFS 24h rainfall + GloFAS days 1–3 river-discharge outlook cross a threshold over
  the AOI. This is the existing `flood/forecast.py` mechanism — it already shortens
  `urgency_days` for flood/terrain-dominant towers only (`policy.yaml`'s
  `weather_hazard.coupled_factors`).
- **Site hardening dispatch**: sandbag, clear drainage, secure equipment at towers
  the forecast flags. Real precedent — 11 Sabah west-coast towers received "urgent
  site hardening" ahead of the 2025 monsoon on ministerial directive.
- **Generator pre-positioning**: portable generators staged at flood-prone tower
  sites ahead of expected power outages. Real precedent — telcos directed to keep
  portable generators on standby in flood-prone areas.

### T-0 — tower down

- Power outage or signal loss detected at a tower. Real July 2024 breakdown of why:
  83% utility power cut for safety, 12% road access blocked by floodwater, 5% equipment
  damage (see table above) — the response differs by cause, not just by tower.
- **Task force activation**: MCMC + telcos + utility (SESB in both the 2024 and 2025
  Sabah cases) form a joint monitoring body for phase-by-phase repair coordination,
  prioritising **collector sites** first. Maps to the existing reserve-crew-day
  mechanism (`policy.yaml`'s `readiness` block, `scheduler/reserve.py`) — activation is
  a state change on reserve capacity, not a new physical work order.

### T+hours — active response

- **Generator dispatch**: restore power at the affected tower. This is the existing
  `power` factor's emergency work order, just under a flood-declared, faster SLA — and
  the correct response for the 83% of July 2024's down towers whose cause was a utility
  power cut, not physical damage. Real precedent — 41 Sabah towers affected in Jul 2024
  (14 restored within ~2 days); 266 towers lost power in the larger Sep 2025 event, 147
  restored in phases via generator + repair crews.
- **Remote antenna power & tilt adjustment**: telcos run 24/7 Network Monitoring
  Centres (NMCs) under MCMC's disaster readiness framework; when a tower goes
  down, NMC engineers remotely retune **neighbouring, still-operational** towers —
  electrical downtilt/azimuth change to widen beam footprint, and a temporary
  transmission-power boost — to stretch coverage into the dead zone. This is a
  remote OSS/RAN control-room action, not a truck roll: no crew, no travel time,
  no `duration_hours`. It is the real-world basis for the "neighbour towers
  reorient toward the gap" visual — genuinely how MCMC/telcos respond, confirmed
  practice under the disaster readiness framework, even though this project has no
  sector-level RF data to compute the adjustment for real. Demo visual should be
  labelled "illustrative — real action, simulated geometry."

  **Named precedent** (Bernama, 16 Dec 2022, reporting the Communications Minister):

  > "Maxis has also done (antenna) tilting to help reduce the issue which is mostly a
  > technical and geographical problem."

  Same caveat as the COW entry below: this was the **Batang Kali landslide** search-and-
  rescue operation, not a flood. It establishes antenna tilting as **real Malaysian
  operator practice in a disaster**, which is what matters here — so retuning must never
  be pitched as this project's innovation. The action is theirs. What this project can
  claim is only the *decision* layer: which surviving towers to point, and at which gap,
  driven by the same risk scores that order restoration.
- **MOCN (Multi-Operator Core Network) failover**: if one operator's tower is
  down but a nearby tower belonging to a **different** operator is still up, MCMC
  coordinates traffic routing onto the surviving tower regardless of subscriber's
  network. Real and current — Malaysia signed a first-in-the-world 6-way 4G MOCN
  sharing agreement (Celcom, Digi, Maxis, U Mobile, TM, YTL) in Jan 2025, already
  used to extend coverage in poor-signal areas nationwide. Also a remote/network
  action, not a dispatch.
- **Coverage on Wheels (COW) deployment**: used when terrain or damage severity means
  neighbouring towers and MOCN failover cannot cover the gap — a mobile base
  station trucked to the dead zone, or to a Temporary Evacuation Centre (PPS) to
  absorb a user spike, for temporary coverage while the permanent tower is
  repaired. This is the new schedulable action type this storyline needs — crew +
  vehicle + site + duration, same shape as any other work order.

  **Naming — corrected 2026-09-17.** An earlier version of this note said no Malaysian
  source used the COW term, and that "temporary BTS" was the only confirmed local
  phrasing. That was wrong. Malaysian official reporting **does** use it (Bernama,
  16 Dec 2022):

  > "Fahmi said as an early measure to overcome the problem, Telekom Malaysia (TM) and
  > telcos have been instructed to send their Mobile Coverage Vehicles to allow the
  > implementation of Coverage on Wheels at the location."

  The acronym is local usage — expanded as *Coverage* on Wheels, not the general
  industry's *Cell* on Wheels. Use **"Coverage on Wheels (COW)"** in Malaysian-facing
  material. "Temporary BTS" (MCMC 2021 disaster-recovery measures) remains a second real
  phrasing, not the only one.

  **Event context — do not cite this as a flood precedent.** The report is datelined
  Batang Kali: it concerns the **December 2022 landslide** search-and-rescue operation in
  Selangor, where poor coverage hampered rescuers. It proves the *term* and the
  *deployment practice* are Malaysian. It does **not** evidence a COW deployment in a
  flood, and still not a named Sabah one — that part of the grounding remains generic.

  Note this corrects the *term*, not the simulation's on-screen count wording: the
  console line says "coverage footprint" because the ring-packed count reaches 20–21 on
  a real run and no operator stages that many units in one district
  (`simulationTimeline.ts`, `cow` beat). That reasoning never depended on the naming
  research and stands unchanged.
- **MCMC PRIME unit**: a portable vehicle combining satellite link, cellular
  network, two-way radio, Wi-Fi hotspot and drones — deployed to **relief centres**
  (evacuee connectivity), not tower sites. Different target from COW: PRIME serves
  people at a PPS (temporary evacuation centre), COW restores network coverage at a
  location. Real precedent — MCMC PRIME deployed to Kampung Cendrakasih and
  Penampang in the 2025 Sabah response.
- **NADI activation**: existing fixed National Information Dissemination Centres
  switched into public-access mode during the disaster. Not a dispatch — a mode
  switch on infrastructure that already exists. Real precedent — 131 NADI centres
  activated across impacted areas in 2025.

### T+recovery

- Tower repaired; COW withdrawn; generator returned to the standby pool.
- Task force stands down (reserve slot released).
- Outcome logged to the observation ledger (`model/feedback.py`) as a confirmed
  event — real training signal for the model over time, distinct from the synthetic
  `maintenance_records.csv` label.

## What is real vs demo-only, and why the line matters

| Action | Status | Note |
|---|---|---|
| Forecast-shortened urgency | **Real, already built** | `flood/forecast.py`, `scheduler/urgency.py` |
| Site hardening | **Real practice, not yet built** | New `actions.yaml` entry needed |
| Generator pre-position / dispatch | **Real practice, mostly built** | Existing `power` factor + work order; needs faster flood-declared SLA |
| Task force / reserve activation | **Real practice, partially built** | Reserve mechanism exists; needs a visible "activated" state |
| Temporary base station deployment | **Real practice (generically), not yet built** | New schedulable action type; "COW" itself unevidenced in Malaysia — use "temporary BTS" wording |
| Remote antenna tilt/power (NMC) | **Real practice, demo-visual only** | Real action, but no sector-level RF data in this project to compute it for real — geometry on screen is simulated, action itself is not invented |
| MOCN failover | **Real practice, demo-visual only** | Real, current (Jan 2025 6-way agreement); no cross-operator tower ownership data in this project's feature table, so "which operator" is illustrative |
| MCMC PRIME (relief centres) | **Real practice, out of scope for now** | Targets people at PPS, not towers — no tower-level data to drive this from |
| NADI activation | **Real practice, out of scope for now** | Infrastructure mode-switch, not a scheduler concept |

Anything shown on screen that has no data behind the specific numbers (antenna
bearing, "coverage restored %", which operator gets MOCN failover) must be
visibly labelled illustrative — this follows the same discipline
`docs/Backend_Handoff.md` §0.6 already applies to risk scoring: never let a demo
visual read as a claim the system doesn't back. The distinction is "action is
real" vs "this specific number is simulated" — not "this whole thing is made up."

## Sources

- [41 transmission towers in Sabah affected by flood](https://www.theborneopost.com/2024/07/03/41-transmission-towers-in-sabah-affected-by-flood/) (Borneo Post, 3 Jul 2024) — district counts and the 34/5/2 cause breakdown
- [Sabah Floods: MCMC Restores 14 Telecommunications Towers](https://www.bernama.com/en/news.php?id=2313715) (Bernama)
- [MCMC restores 14 of 41 flood-damaged telecom towers in Malaysia's Sabah](https://www.communicationstoday.co.in/mcmc-restores-14-of-41-flood-damaged-telecom-towers-in-malaysias-sabah/)
- [MCMC steps up emergency communications support for flood-hit communities in Sabah](https://www.theborneopost.com/2025/09/16/mcmc-steps-up-emergency-communications-support-for-flood-hit-communities-in-sabah/)
- [MCMC deploys PRIME, NADI to restore communication in Sabah](https://www.nst.com.my/amp/news/nation/2025/09/1276874/mcmc-deploys-prime-nadi-restore-communication-sabah)
- [MCMC boosts emergency communications for Sabah disaster victims](https://thesun.my/malaysia-news/mcmc-boosts-emergency-communications-for-sabah-disaster-victims-JM14905491)
- [Fahmi: 11 Sabah west coast telecom towers to get urgent site hardening ahead of monsoon](https://www.malaymail.com/news/malaysia/2025/09/26/fahmi-11-sabah-west-coast-telecom-towers-to-get-urgent-site-hardening-ahead-of-monsoon/192521)
- [Deputy minister: telcos directed to keep portable generators on standby in flood-prone areas](https://www.malaymail.com/news/malaysia/2024/10/16/deputy-minister-telcos-directed-to-keep-portable-generators-on-standby-in-flood-prone-areas/153868)
- [Cell on Wheels (COW) | Mobile Base Station](https://www.icsindustries.com.au/products/communication-trailers/cell-on-wheels) — general industry definition only; not Malaysian usage
- [MCMC, Telcos told to establish SOP for telecommunications access in disaster areas](https://www.bernama.com/en/news.php?id=2148670) (Bernama, 16 Dec 2022) — "Coverage on Wheels" as Malaysian usage, and Maxis antenna tilting. **Batang Kali landslide SAR, not a flood.**
- [264 telecommunication towers affected by floods in Kelantan restored](https://thesun.my/malaysia-news/264-telecommunication-towers-affected-by-floods-in-kelantan-restored-fahmi-IC13555962) (The Sun, 20 Jan 2025) — Tumpat example, workshop directive for towers "never been impacted by floods", simulation-workshop directive. The fullest version; all three quotes verified here.
- [264 telecommunication towers affected by floods in Kelantan restored](https://www.thestar.com.my/news/nation/2025/01/20/264-telecommunication-towers-affected-by-floods-in-kelantan-restored) (The Star / Bernama, 20 Jan 2025) — corroborates the workshop directive; shorter syndication, omits the Tumpat and simulation-workshop sentences
- [Eleven Sabah telecom towers to undergo urgent site hardening work](https://thesun.my/malaysia-news/eleven-sabah-telecom-towers-to-undergo-urgent-site-hardening-work-EL14975212) (The Sun, 26 Sep 2025) — the Minister's verbatim selection basis, "towers most frequently affected by outages". Note this version does not name the eleven sites' locations.
- [Malaysia's telcos sign network sharing deal for six-way 4G Multi-Operator Core Network](https://www.malaymail.com/news/malaysia/2025/01/28/first-in-the-world-malaysias-telcos-sign-network-sharing-deal-for-six-way-4g-multi-operator-core-network-says-minister/164777)
- [MCMC Launches MOCN Guidelines to Improve Network Coverage](https://www.malaysianwireless.com/2025/01/mcmc-mocn-guidelines-network-coverage/)

## Not yet decided (next conversation)

- Whether COW deployment and site hardening become real `actions.yaml` entries now
  or stay storyline-only for the pitch deck.
- Whether the "Disaster Response" tab is a new page or a mode on the existing
  Schedule page.
- Whether task-force activation needs its own UI state or reuses the existing
  reserve/`ReadinessBar` component.
