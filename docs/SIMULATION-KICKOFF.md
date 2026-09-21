# Kickoff prompt — Disaster Simulation build (full run, Sonnet session)

Paste everything below the line as the first message of a fresh Claude Code
session in this repo. It runs the whole backlog P0→P8 without stopping.

`SIMULATION-LOOP-PROMPT.md` is the same run in overnight form — it opens by asking
you three questions and then proceeds on defaults if you don't reply. This file is
for starting the run while you're at the desk: the three questions are already
answered in it.

---

You are building the **Disaster Simulation** tab for Tower Rangers, a predictive
maintenance and disaster-response system for Malaysian telecom towers (ASEAN GeoAI
Fusion 2026 hackathon).

Run the whole backlog below, P0 through P8, without stopping to ask. Each item:
**build → gate → review → fix → commit → log → next.**

## Read these first, in order, before writing any code

1. `CLAUDE.md` — repo root. Non-negotiable project rules and a long list of
   gotchas, each written after a real bug shipped. These outrank anything below.
   If you find a genuine conflict, follow `CLAUDE.md` and note it in the log.
2. `docs/Disaster_Simulation_Spec.md` — **the build specification. This is what
   you are building.** Read all of it now, not item by item.
3. `docs/Disaster_Response_Actions.md` — the real MCMC flood-response actions the
   simulation dramatises, and which parts are citable versus illustrative.

## What this feature is, in one sentence

A scripted timeline that plays the 2025 Sabah flood as a timed sequence over a
real map, with a console transcript beside it — **and calls the real optimizer at
its dispatch beats**, so the crew assignments on screen are genuine solver output
while the actions the backend cannot compute are animation labelled as such.

## Decisions already made — do not revisit these

- **Nav:** `/simulation` ships as a sixth pill item, placed after Schedule.
- **Optimize scope:** the pre-event `optimize` beat calls `/schedule/optimize`
  against the **whole national population**, and the closing summary filters for
  the affected districts — so it can say "of N national orders, k were in the
  districts the flood hit".
- **Baseline comparison:** yes, the closing summary also calls
  `/schedule/baseline` for the "nearest-first would have reached these towers j
  days later" line. If that call fails, omit that one line and carry on.

## Hard rules — violating any of these fails the run

- **Never fabricate a failure label or failure-probability semantics.** This system
  schedules maintenance *need* and *urgency*, never predicted failures. A simulated
  outage is a stated scenario premise. No console line, label, tooltip or summary
  figure may say or imply a tower *will* fail or carry a probability of failure.
- **Simulated state never leaves the simulation store.** `downTowerIds` and every
  other scenario premise live in `state/useSimulation.ts` — never written into a
  `Tower` record, never sent to the backend, never persisted.
- **The simulation map is a silent MapLibre instance** — never `setMap`,
  `setView` or `setCursor`. A second publisher makes the map console's graticule,
  cursor readout and scale rule describe the wrong map. Copy the pattern in
  `components/schedule/DispatchRoutePreview.tsx`.
- **A fallback is real data or `null`, never a zeroed struct.** A zeroed object is
  truthy and every `data ? … : '—'` guard downstream takes the wrong branch. This
  has shipped as a bug here before.
- **When a backend call fails, the beat still fires but is visibly marked
  degraded**, and the global offline flag is set. Never narrate fixtures as live.
- **Illustrative content is labelled illustrative.** Antenna bearings, coverage
  footprints and MOCN attribution are geometry we invented. The action is real;
  the number is not. Both halves must be legible on screen.
- **The simulation calls `/schedule/*` directly, never `/agent/chat`** — its
  no-API-key parser turns any 4-digit number plus a trigger word into an emergency
  dispatch against a different tower.
- **Design system:** cool accent is chrome, warm is data severity. `bandColor()`
  for fills, `bandInk()` for text. Only the eight named type steps — no
  `text-[13px]`. `overlay/<alpha>`, never `white/<alpha>`. Component classes stay
  inside `@layer components`.
- **Process:** never `git push --force`, never `--no-verify`, never delete or skip
  a failing test to go green, never weaken an assertion. Never commit `.env`.

## Before P0 — confirm the ground

1. **Run the gate on a clean tree** (commands below). If it is already red, that
   is your first work item — fix it, or record precisely what was already broken
   so every later validation is unambiguous.
2. **Confirm the Sabah data exists.** Verify `/towers` returns towers with
   `territory === 'Sabah'`, how many, and that `config/crews.json` rosters crews
   for that territory. If the set is empty or tiny the scenario needs rethinking —
   that is a finding for the log, not something to paper over.
3. **Read the primitives you will reuse**, named in spec §4-5:
   `components/schedule/DispatchRoutePreview.tsx` (silent map instance, and lines
   176-195, the moving-marker tween with its reduced-motion treatment),
   `components/hud/AreaModule.tsx:28-57` (`fitBounds` with clamped padding),
   `lib/colors.ts` and `lib/reserveHatch.ts`.

Write what you found to `docs/simulation-build-log.md` before writing code.

## The backlog

Full detail is in spec §13. Each item is done when the gate is green, its
reviewers return no blockers, docs are updated, and it is committed.

- **P0 — Skeleton.** Route, nav entry after Schedule, `PageHeader`, the three
  panel shells from spec §3, store with `status` only. Navigable, obviously
  unfinished. `flex h-full flex-col`, never `h-screen`.
- **P1 — Clock and console.** `lib/simulationClock.ts`, `lib/simulationTimeline.ts`
  with the full beat table but no map effects, `SimulationConsole`, `TransportBar`,
  `PhaseStrip`. **Write the unit tests for both lib modules in this item**, while
  they are still pure — they will not get easier later.
- **P2 — Map, static.** `SimulationMap` as a silent instance, Sabah towers,
  `fitBounds` on scenario select. Camera move in the start handler, **never an
  effect keyed on tower data** — `useLiveTowers` returns a fresh array identity on
  most renders and an effect would re-fly the camera mid-run.
- **P3 — Impact overlays.** Flood extent, outage marks, coverage gap. The outage
  mark must not be plain red — red is the `maintain` band; carry it with shape and
  a literal label.
- **P4 — Backend beats.** Real `/schedule/optimize` and `/schedule/emergency`,
  prefetched at Start so solver latency hides under the opening narration, with
  visible degradation on failure. Pass the run's own anchor to the second call.
- **P5 — Response animation.** Sector cones swinging, MOCN link line, COW arrival,
  crew routes. Every one needs a reduced-motion still state.
- **P6 — Honesty surface.** Evidence badges (`real` / `mechanism` /
  `illustrative`, each with a **word** and not only a hue), the standing banner,
  `SimulationLegend`. **If you run out of time or context, this ships anyway** — a
  demo without it overstates the system.
- **P7 — Reduced-motion pass and narrow-width check** at 1280px and 1024px.
- **P8 — Closing summary.** What the risk index flagged in advance versus what the
  scenario hit, time-to-response, and the baseline comparison. **If they diverge,
  show the divergence** — a demo that can only succeed is not evidence of
  anything.

If the backlog empties, harden rather than stop: more `lib/` test coverage, error
paths, the new docs added to `CLAUDE.md`'s documentation-map table, accessibility,
bundle size, and a pass over every `TODO` you left behind.

## The gate — run all of it, every item, before committing

```bash
# Backend — from src/backend/. Use `py` on Windows; `python3` is a Store stub.
cd src/backend && pytest -q -p no:cacheprovider

# Frontend — from src/frontend/
cd src/frontend && npm run build      # tsc -b && vite build
cd src/frontend && npm run lint       # oxlint
cd src/frontend && for f in src/lib/*.test.mjs; do node --experimental-strip-types --test "$f"; done
```

- There is **no** `npm test` script. Don't add one — the `lib/` tests run via that
  loop. Plain `node --test` fails with `ERR_UNKNOWN_FILE_EXTENSION`; the
  strip-types flag is what makes it work.
- In a tested `lib/` module, **value imports need explicit `.ts` extensions and
  type-only imports must not.** This fails only under the test runner, never in
  the build.
- `npm run build` **cannot** catch the MapLibre worker bug (dev-only) and proves
  nothing about visual, animation or map-rendering correctness.
- If the gate fails, that is the work. Fix, re-run the whole gate, repeat. Do not
  start the next item with a red gate.

## The review gate — after the build gate, before the commit

Reviewers are defined in `.claude/agents/`. Dispatch the ones the item touched,
**in parallel** — one message, multiple `Agent` calls:

| Item touches | Dispatch |
|---|---|
| Beats, console copy, scenario, any user-facing string | `mcmc-domain-reviewer` |
| Backend, `lib/`, store, endpoint wiring | `simulation-integrity-tester` |
| `components/simulation/`, `pages/Simulation.tsx`, `index.css` | `simulation-ux-reviewer` |

Roughly: P0/P7 → UX. P1 → integrity + UX. P2/P3/P5 → UX (+ integrity for P2/P3).
P4 → integrity. P6/P8 → all three.

- **Fix every BLOCKER before committing.** A blocker is not a follow-up.
- Other findings: fix if cheap, otherwise log as deferred **with a reason**. Never
  silently drop one.
- An empty findings section is a valid result. Don't re-run hoping for different
  output, and don't manufacture work from it.
- A reviewer's summary describes what it *intended* to check. If it claims a file
  is wrong, open the file before acting.
- Run all three once against the finished tab before your final report, even if no
  single item triggered all three.

## Log every cycle

Append to `docs/simulation-build-log.md`, committed with each item. Never rewrite
an earlier entry.

```
## <ISO timestamp> — <item>
Did: ...
Decisions made without the operator: ... (and the reasoning)
Validation: <pass/fail, which commands>
Reviewers: <which ran, verdict, what you fixed, what you deferred and why>
Blocked: ... (if anything, with exact steps for the human)
Next: ...
```

## How to work

- **Do not stop to ask.** When the spec doesn't resolve something, pick the option
  most consistent with `CLAUDE.md` — the most honest one where a claim about the
  system is involved — write down why, continue.
- **Timebox ~90 minutes per item.** If it isn't converging, park it with detailed
  notes in the log, move to the next item, come back with fresh context.
- **A failing test is work, not a blocker.** So is a type error, a lint error, a
  broken build, and a reviewer blocker.
- **Blocked by something only a human can supply?** Mark it `BLOCKED-EXTERNAL` in
  the log with exact steps, move on immediately. Never wait. Never work around it
  by doing something you were told not to do.
- Small, coherent commits. Imperative subject, body explains *why*. Docs updated
  in the same commit as the code they describe. End every commit message with:

```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```

- **Do not push.** There are uncommitted changes in the tree from a tab trim I'm
  still working through. Commit locally; I'll review and push.
- Don't narrate at length. Work, validate, review, commit, log, next.

## Stop conditions

Stop only when one of these is true:
1. P0-P8 and the hardening list are done, both gates green, all three reviewers
   run clean or with only logged deferrals, everything committed.
2. You hit a hard limit (context, rate limit, no network) and have logged and
   committed all work in progress.
3. Continuing would require violating a hard rule above.

Do not stop because an item is hard, because you have been running a long time, or
because it feels like a natural pause.

## Final report

Leave a summary as your last message and append it to the log:

- What landed, with commit SHAs.
- What the three reviewers said, and what you did about each finding — including
  deferrals and why.
- Where the build diverged from `docs/Disaster_Simulation_Spec.md`, and why. The
  spec is not sacred; an undocumented divergence is a defect.
- What is blocked on me, with exact steps.
- Anything you decided on my behalf that I might want to reverse.
- The honest state of both gates when you stopped.
- **What has not been verified in a browser.** A green build says nothing about
  whether the map renders, the animation reads, or the timeline is legible. Be
  explicit about what still needs eyes.

Be accurate. If something is half-done, say so. A truthful report of partial
progress is worth more than a confident one that isn't true.
