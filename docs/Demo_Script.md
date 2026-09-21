# Demo Script — ASEAN GeoAI Fusion 2026

**Slot: ~5 minutes. One presenter, driving the UI while speaking.**

This is a run-sheet, not a narrative. Each step carries: what you click, what
should appear, what you say while it appears, and what will break the demo if
you click the wrong control. Timings are cumulative budget, not stopwatch
targets.

Read `§6 Pre-flight` before you present. Two of the four steps have a control
that looks correct and silently does nothing.

---

## §0 The one-sentence frame (before you touch anything)

> "Malaysian telecom towers fail in ways nobody predicts, because nobody has a
> failure dataset. So we don't predict failure. We score maintenance *need*
> from the ground a tower sits on, turn that into work orders, and show what
> happens when a flood arrives anyway."

Say this. It is the answer to the first question a judge will ask, and getting
ahead of it buys you the rest of the five minutes. Do not use the words
"predict failure" at any point after this.

---

## §1 The model on the map — 0:00 to 1:15

**Route: `/` (map console, full-bleed)**

### Click sequence

1. Land on `/`. Map is already showing the national estate — 1,164 OSM
   communication towers across all 16 states.
2. Point at the colour spread without clicking. Three bands: maintain, watch,
   ok.
3. Open the **layer panel** (left). Toggle **one** ground layer — flood or
   terrain. One only.
4. Click **one maintain-band tower**. `SelectionHud` opens with its risk,
   decision band and factor attribution.

### What you say

> "Every dot is a real tower from OpenStreetMap. The colour is a maintenance
> risk score — 0 to 1 — and it comes from the ground each site sits on: height
> above drainage, slope, distance to the power grid, vegetation change from
> Sentinel-2."

> *(toggle a ground layer)* "Those are the actual inputs, not a decoration.
> Flood exposure is height-above-nearest-drainage from a 30-metre DEM, with a
> slope gate — because water has to stand somewhere, and a valley wall at the
> same drainage height as flat ground is not the same site."

> *(click the tower)* "And the score decomposes. This tower is flood-dominant
> at *(read the share)* — so the system already knows what kind of crew it
> needs before anybody looks at it."

### The honesty line — say it, do not skip it

> "The model is trained on a synthetic maintenance register, because no
> operator history exists for this prototype. We score it against the
> generator's own oracle so you can see the gap: oracle ROC 0.985, our model
> 0.910, and the physics baseline it replaced 0.678. If we had landed *on* the
> oracle, that would mean the generator leaked — not that we were good."

**If a judge pushes on the data:** the Model Health tab has the full confusion
matrix, the leak check, and the split-inflation figure. Do not navigate there
unless asked — it costs 40 seconds you do not have.

### Traps

- **Do not open more than one ground layer.** Rain and flood peak on different
  dates and a viewer toggling both sees a mismatch that is real hydrology, not
  a bug — but explaining that costs a minute.
- The Sunway pilot AOI is compressed (IQR 0.09). Stay on the **national** view,
  where IQR is 0.361 and the band spread is visible.

---

## §2 Ticket to schedule — 1:15 to 2:30

**Route: `/tickets`, then `/schedule`**

This is the step with the control trap. Read it twice.

### Click sequence

1. Go to **`/tickets`**.
2. Point at a ticket whose source is the risk model — it carries the work
   order's own SLA date, not a null.
3. **On the ticket CARD, click the sparkle `+` picker and choose the Assignee
   Agent.** The ticket must be **`open`**.
4. Go to **`/schedule`**. The ticket appears in the **Ranger dock** as a
   `TicketApprovalStrip`.
5. Click it. `TicketApprovalPanel` opens in the detail panel: suggested crew,
   previewed cost.
6. **Approve.** It commits through the ordinary `/schedule/pin` and the job
   lands on the board.

### What you say

> "Tickets are not typed by hand. When the optimizer finds a work order it
> cannot schedule — no crew of the right capability anywhere in that territory
> — it raises a ticket automatically. Six towers on the live board, risk 0.85
> to 0.96, needing power crews in Johor and Sarawak and civil crews in Penang.
> That is a permanent capability gap, which is exactly what a durable record is
> for."

> *(assign the agent)* "Assigning the agent does not dispatch anything. It sets
> a flag. A human still approves on the schedule side."

> *(on /schedule, approving)* "The optimizer decides, not the language model.
> This is a greedy solver packing work orders into crew-days under territory,
> depot, crew-type, SLA and monsoon constraints. Crew capacity is a time
> budget — travel measured from where the crew actually *is*, not from the
> depot — so a tight cluster of towers fits more jobs than a scattered one at
> identical risk."

### Traps — these will silently kill the demo

- **The sparkle picker on the CARD is the only control that works.** The
  drawer's Assignee dropdown and the suggested-crews "Assign" button both call
  `assignCrew()`, which flips the ticket `open -> active` and **permanently**
  disqualifies it. Nothing visibly fails. The ticket simply never appears on
  the Schedule side, and re-picking the agent afterwards cannot rescue it.
- **Check the territory selector on `/schedule`.** A dispatch into a territory
  you are not viewing draws no lane and moves no count — it looks like a no-op.
  `TicketApprovalPanel` points the selector at the proposed crew's territory
  when it opens; confirm it actually did.
- **Never type into the Ranger chat during the demo.** Its no-API-key parser
  turns any 4-digit number plus a trigger word ("emergency", "today", "dispatch
  now", "send someone") into an emergency dispatch — so mentioning ticket
  `T-1038` re-optimizes the entire board with the wrong date anchor. Dozens of
  unexplained reassignments, live, on stage.

### If you have 15 spare seconds

Hit the emergency-ticket button once. It raises a ticket at a random
maintain-band tower and shows the same flow under time pressure. Skip it if
you are behind.

---

## §3 Investigation, "if it fails, who covers?", MCMC SOP — 2:30 to 3:45

**Route: `/investigation/:towerId`, then back to `/`**

### Click sequence

1. From the selected tower, go to **`/investigation`** for that tower.
2. Scroll to the **"If it fails"** panel (`FallbackPanel`).
3. Land on a tower in the **isolated** state — "Nobody covers this."
4. Say the MCMC line (below).
5. Go back to **`/`**, select that same tower, and open **Protect** in the
   `SelectionHud`.
6. Pick a mitigation. **Watch the console run before the map moves.**

### What you say

> "Risk tells you a site needs work. It does not tell you what happens if the
> site goes down. So we compute that separately — for every flood-exposed
> tower, which neighbours inside 15 km could plausibly stand in."

> *(on an isolated tower)* "This one has nobody. And there are two different
> ways to have nobody: no neighbours at all, or neighbours that flood in the
> same event. Five towers and seven towers on the live estate — different
> findings, so we never collapse them into one number."

> "This is geometry, not RF. Distance and great-circle bearing between known
> coordinates. We hold no azimuth, no antenna height, no EIRP — `radio` is
> UNKNOWN for 1,119 of our 1,164 towers. So this is a shortlist for an RF
> planner to confirm, never an engineering instruction."

**The MCMC handoff is spoken framing, not a screen. Say it as such:**

> "An isolated high-risk site is what gets flagged to MCMC. They run their
> SOP against it — and that SOP is site protection: a raised plinth, a flood
> barrier, a drainage regrade, a genset. So let us apply one."

### On the protection console

> *(pick a mitigation, console beats run)* "Notice the sequence. A work order
> is raised from the dominant factor. A crew is assigned. Works complete. The
> site is re-scored — and only *then* does the map change."

> "That ordering is the argument. Dispatching a crew does not lower a tower's
> risk, and it must not — the ground is where it was. But a plinth *changes
> the site*. So this never decrements a score. It changes an input and re-runs
> the same model. The risk that comes out is computed, not assigned."

### The honesty line

> "The effect sizes are engineering assumptions, not measurements — nothing in
> this dataset observes a Malaysian tower compound after works. Every surface
> says ILLUSTRATIVE, including this one."

Point at the badge on screen while saying it.

### Traps

- Every console beat is badged `mechanism` or `illustrative`. There is
  deliberately no `real` badge in this sequence — nothing here touches the
  backend. If a judge asks "is this live?", the answer is **no, and the screen
  says so**.
- Pick a **flood-dominant** tower. A mitigation against a non-dominant factor
  moves the score very little and the demo lands flat.

---

## §4 Disaster simulation — 3:45 to 5:00

**Route: `/simulation`**

### Click sequence

1. Go to **`/simulation`**.
2. Press play on the `TransportBar`.
3. Let it run through the four phases. Do not scrub.
4. Stop on the `SimulationSummary`.

### The four phases and what to say at each

**PRE — beats `forecast`, `urgency-shift`, `optimize`, `harden`, `generators`**

> "Before the water arrives. A GFS rainfall forecast lands, and it shortens
> SLA deadlines — but only for flood- and terrain-coupled towers. Rain does not
> accelerate radio-unit wear, so an equipment-dominant tower's 90-day refresh
> does not move. That is pinned by a test."

> "And the optimizer here is **real** — this beat calls the actual
> `/schedule/*` endpoint. It is not a scripted number."

**IMPACT — beats `flood-onset`, `tower-down`, `cause-breakdown`, `taskforce`**

> "The flood extent is scenario premise, hand-authored, and labelled as such
> everywhere it renders. It approximates the July 2024 Sabah event —
> Penampang, Kota Kinabalu, Tuaran, Kota Marudu, 41 transmission towers down
> per MCMC and Bernama."

> *(at cause-breakdown)* "And the causes split the way the real event did:
> power cut by the utility, flooded access road, equipment damage. That is why
> we used this event — it is the one with district-level tower counts *and* a
> cause breakdown, which is what makes the beat table defensible instead of
> invented."

**RESPONSE — beats `antenna-retune`, `mocn`, `generator-dispatch`, `cow`, `prime`**

> "This is the real MCMC response sequence: neighbouring sites retune to cover
> the gap, operators open MOCN roaming, gensets go out, a Cell-on-Wheels
> deploys. The second optimizer call fires here — a real dispatch against the
> real solver."

> "The coverage cones are illustrative. We have no sector data, so a bearing
> here is a direction to a place. The legend says so."

**RECOVERY — beats `restore`, `withdraw`, `ledger`**

> "Sites come back, temporary assets withdraw, and the outcome lands in the
> observation ledger — which is where the loop closes back into the model."

### The closing claim — 4:45

> "And this is the point of doing the protection step before this one. The
> protection you applied is not a separate screen — it re-scored that tower,
> and the simulation reads the same scored population. So the estate that faces
> this flood is the estate you hardened."

### VERIFY THIS BEFORE YOU PRESENT

The mechanism above is real: `applyProtection` sits inside `useLiveTowers`, and
`SimulationMap`, `SimulationConsole`, `SimulationSummary` and `TransportBar` all
read `useLiveTowers`. So a mitigation applied in §3 **does** reach the
simulation.

**What is NOT guaranteed is that it visibly changes the down-tower set.**
`downTowerSelector` picks by flood-polygon containment *and* flood share, so a
protected tower may still be selected as down — its share dropped but it is
still inside the polygon and may still rank.

**Run this once before the pitch:**

1. Run `/simulation` clean. Note which towers go down.
2. Go to `/`, apply the strongest flood mitigation to one of those down towers.
3. Re-run `/simulation`. Did that tower drop out of the down set?

- **If yes** — say the closing claim exactly as written above. It is true and
  it is your strongest moment.
- **If no** — fall back to this wording, which is still true:

> "The protection re-scored that site, and the simulation reads the re-scored
> population — so the hardening is carried through, not forgotten between
> screens."

Do not claim a visible change you have not seen happen.

---

## §5 Anticipated questions

| Question | Answer |
|---|---|
| "Does this predict failures?" | No, and deliberately not — no failure labels exist anywhere in this project. It scores maintenance *need* and *urgency*. |
| "Is the data real?" | Towers, terrain, flood, vegetation, fire, backbone: real. The maintenance *register* is synthetic and generated under rules that stop it restating its own inputs — an AST test fails the build if the generator ever imports the risk index. |
| "Why not just use the risk score for everything?" | We measured. A second opinion earns its place only by beating what is served inside the band that decides dispatch. Fire, backbone and the isolation forest all failed that test and enter nothing. The telemetry read passed and is blended at 0.25. |
| "Does the LLM decide the schedule?" | Never. It calls tools and reports the return values verbatim. The greedy optimizer decides. |
| "What is the weakest part?" | The synthetic label, and we say so on the Model Health page. The fix is real operator work orders, not a better estimator. |
| "Why is one tower's score so high?" | Open `/investigation` for it. Every factor share, the ensemble second opinion, the profiler flags and the cover analysis are all there. |

---

## §6 Pre-flight checklist

Run through this **before** the room fills.

- [ ] Backend up on **8001**: `cd src/backend && uvicorn api.main:app --reload --port 8001`
- [ ] Frontend up: `cd src/frontend && npm run dev`
- [ ] **`VITE_API_BASE` is UNSET.** If it is set to an absolute URL the browser
      bypasses the Vite proxy and may silently serve fixtures while looking
      live. This has cost real time twice.
- [ ] No `OfflineBanner` visible on `/`. If it is showing, you are on fixtures.
- [ ] `data/malaysia/` present — confirm the map shows ~1,164 towers nationally,
      not 132 in Sunway.
- [ ] `/tickets` has at least one **open** risk-model ticket.
- [ ] You have **verified §4** per the box above and know which closing line
      you are using.
- [ ] Pick your demo tower in advance and write its id down: it must be
      **flood-dominant**, in the **maintain** band, and **isolated** in
      `FallbackPanel`. One tower carries §1, §3 and §4.
- [ ] Territory selector on `/schedule` matches the ticket you will approve.
- [ ] Ranger chat: do not touch it.

## §7 Time budget

| Step | Budget | Cumulative |
|---|---|---|
| §0 frame | 0:15 | 0:15 |
| §1 model on map | 1:00 | 1:15 |
| §2 ticket to schedule | 1:15 | 2:30 |
| §3 investigation to protection | 1:15 | 3:45 |
| §4 simulation | 1:15 | 5:00 |

If you are behind at 2:30, cut the emergency-ticket button in §2 and the layer
toggle in §1. **Do not cut §3's honesty line or §4's caveats** — those are what
make the rest credible.
