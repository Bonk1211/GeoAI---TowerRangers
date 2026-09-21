# Unattended build run — Disaster Simulation tab (Tower Rangers)

You are working unattended on the repository at
`C:\Users\zhchua\Documents\Project (Comp)\starlink` (project: **Tower Rangers**,
ASEAN GeoAI Fusion 2026 hackathon). The operator is away. You will not get
another chance to ask anything.

Your job, in order: **read → implement → validate → review → fix → document →
push.** Then pick up the next backlog item and do it again, until a stop
condition at the bottom is met.

**Read `CLAUDE.md` in the repo root before you touch anything.** It carries
non-negotiable project rules — no fabricated failure labels, optimizer decides
never the LLM, config over code, the design system's colour and type discipline,
and a long list of gotchas each written after a real bug shipped. Those rules
outrank anything in this brief that appears to contradict them. If you find a
genuine conflict, follow `CLAUDE.md` and note the conflict in the log.

Then read, in this order:
1. `docs/Disaster_Simulation_Spec.md` — the build specification. This is what you
   are building. Its §13 is your backlog.
2. `docs/Disaster_Response_Actions.md` — the domain content the simulation
   dramatises, and the real-vs-simulated table its copy must honour.

---

## 0. The single question you are allowed to ask

Ask this **once**, as your very first action, in one message. Then never ask the
operator anything again for the rest of the run.

> Before I start the simulation build, three things I can't determine myself:
> 1. **Nav placement** — the pill in `components/shell/NavPill.tsx` currently
>    holds five items after your recent trim. Add `/simulation` as a sixth, or
>    reach it from the Schedule page and keep the pill at five?
> 2. **Pre-event optimize scope** — should the `optimize` beat call
>    `/schedule/optimize` against the whole national population (lets the summary
>    say "of N national orders, k were in the affected districts"), or Sabah only
>    (faster, more focused)?
> 3. **Baseline comparison** — should the closing summary also call
>    `/schedule/baseline` so it can state "nearest-first would have reached these
>    towers j days later"? One extra call, and it is the sharpest number
>    available.

**If no reply arrives within 10 minutes, proceed with these defaults and say so
in the log:** add the sixth nav item and verify the top row at 1280px and 1024px;
optimize **nationally** and filter for the summary; **yes** to the baseline
comparison, degrading silently to omitting that one line if the call fails.

After that message you are on your own. When you hit ambiguity: **decide, write
the decision and its reasoning in the log, and keep moving.** Never stop to ask.
Never idle waiting for a reply.

---

## 1. Hard rules — violating any of these fails the run

**Honesty (these are product requirements, from `CLAUDE.md` and
`docs/Backend_Handoff.md` §0.6).**
- **Never fabricate a failure label or expose failure-probability semantics.** The
  system schedules maintenance *need* and *urgency*. A simulated outage is a
  stated scenario premise, never a prediction. No console line, label, tooltip or
  summary may say or imply a tower *will* fail or carry a probability of failure.
- **Simulated state never leaves the simulation store.** `downTowerIds` and every
  other scenario premise stay in `state/useSimulation.ts`. Never written into a
  `Tower` record, never sent to the backend, never persisted.
- **A fallback is real data or `null`, never a zeroed struct.** A zeroed object is
  truthy, and every `data ? … : '—'` guard downstream then takes the wrong branch.
  This has shipped as a bug here before.
- **Never narrate fixtures as live.** When a backend call fails, the beat still
  fires but is visibly marked degraded and the global offline flag is set. A
  silent substitution is worse than a visible failure.
- **Illustrative content is labelled illustrative.** Antenna bearings, coverage
  footprints and MOCN attribution are geometry we invented. The action is real;
  the number is not. Both halves must be legible on screen.

**Architecture.**
- **The simulation map is a silent MapLibre instance.** Never call `setMap`,
  `setView` or `setCursor`. A second publisher makes the map console's graticule,
  cursor readout and scale rule describe the wrong map.
- **Optimizer decides.** The simulation calls `/schedule/*` directly. It never
  routes through `/agent/chat`, whose no-API-key parser turns any 4-digit number
  plus a trigger word into an emergency dispatch against a different tower.
- **Config over code.** New crew types, action mappings or SLA caps go in
  `src/backend/config/*.{json,yaml}`, never as literals in `scheduler/*.py`.
- **Design system.** Cool accent is chrome, warm is data severity. `bandColor()`
  for fills, `bandInk()` for text. Only the eight named type steps — no
  `text-[13px]`. `overlay/<alpha>`, never `white/<alpha>`. Component classes stay
  inside `@layer components`.

**Process.**
- Never `git push --force`, never rewrite pushed history, never `--no-verify`.
- Never commit `.env` or any key. `src/backend/.env` exists — leave it alone.
- Never delete or skip a failing test to make the suite green, and never weaken an
  assertion. Fix the code, or fix a genuinely wrong test and say which in the
  commit message.
- Never push a red gate. Section 4 passes, or you don't push.

---

## 2. Phase 1 — Orient before building

Do not skip this to get to code. It is short.

**2a. Confirm the baseline is green.** Run the full validation gate (section 4)
*before* writing anything. If it is already red, that is your first work item —
fix it or record precisely what was already broken, so every later validation is
unambiguous.

**2b. Read the primitives you are about to reuse.** The spec names them; read the
actual files:
- `src/frontend/src/components/schedule/DispatchRoutePreview.tsx` — the silent map
  instance, and lines 176-195, which are the moving-marker-along-a-route tween and
  its reduced-motion treatment. This is the animation primitive.
- `src/frontend/src/components/schedule/AgentChat.tsx` — SSE consumption. Not a
  console, but the streaming-transcript shape.
- `src/frontend/src/components/hud/AreaModule.tsx` lines 28-57 — `fitBounds` with
  clamped asymmetric padding.
- `src/frontend/src/lib/colors.ts` and `reserveHatch.ts` — the two-ramp
  construction and the single-definition precedent for a non-severity mark.
- `src/backend/api/routes/schedule.py` — the routes you will call, and `_anchor`.

**2c. Confirm the Sabah data is actually there.** Before building a scenario on
it, verify that `/towers` returns towers with `territory === 'Sabah'`, how many,
and that `config/crews.json` rosters crews for that territory. If the filtered set
is empty or tiny, the scenario needs rethinking and that is a finding for the log,
not something to paper over.

**Write what you found to `docs/simulation-build-log.md`** (section 5) before
writing implementation code.

---

## 3. Phase 2 — Backlog, in order

This is `docs/Disaster_Simulation_Spec.md` §13. Each item is done when it passes
the section 4 gate, its docs are updated in the same commit, and it is pushed.

**P0 — Skeleton.** Route, nav entry, `PageHeader`, three empty panels, store with
`status` only. Navigable and obviously unfinished. Establishes the shell contract
(no `h-screen`, `flex h-full flex-col`) before anything else lands on it.

**P1 — Clock and console.** `lib/simulationClock.ts`, `lib/simulationTimeline.ts`
with the full beat table but no map effects, `SimulationConsole`, `TransportBar`,
`PhaseStrip`. Press Start, watch lines land on time.
**Write the unit tests for both lib modules in this item**, while they are still
pure. They will not get easier later.

**P2 — Map, static.** `SimulationMap` as a silent instance, Sabah towers,
`fitBounds` on scenario select, no animation. Camera move in the start handler,
never an effect keyed on tower data — `useLiveTowers` returns a fresh array
identity on most renders and an effect would re-fly the camera mid-run.

**P3 — Impact overlays.** Flood extent, outage marks, coverage gap. First beat
that changes the map. The outage mark must not be plain red — red is the
`maintain` band; carry it with shape and a literal label.

**P4 — Backend beats.** Real `/schedule/optimize` and `/schedule/emergency`,
prefetched at Start so solver latency hides under the opening narration, with
visible degradation on failure. Pass the run's own anchor to the second call.

**P5 — Response animation.** Sector cones swinging (animate the bearing, rebuild
the polygon, `setData`, cap the rebuild near 30fps), MOCN link line, COW arrival,
crew routes. Every one needs a reduced-motion still state.

**P6 — Honesty surface.** Evidence badges (`real` / `mechanism` / `illustrative`,
each with a word and not only a hue), the standing banner, `SimulationLegend`.
**If the run is cut short, this ships anyway** — it is listed here only because it
annotates finished content, and a demo without it overstates the system.

**P7 — Reduced-motion pass and narrow-width check**, including whatever nav
decision came out of section 0.

**P8 — Closing summary.** What the risk index flagged in advance versus what the
scenario hit, and time-to-response. If they diverge, show the divergence — a demo
that can only succeed is not evidence of anything. Include the baseline comparison
if section 0 resolved that way.

**If the backlog empties**, do not stop. Harden: more `lib/` test coverage, error
paths, the `docs/` map entry in `CLAUDE.md`, accessibility, `prefers-reduced-motion`
across the whole tab, bundle size, and a pass over every `TODO` you left behind.

---

## 4. The validation gate

Run **all** of these. Every one passes before you commit and push.

```bash
# Backend — from src/backend/. Use `py` on Windows; `python3` is a Store stub.
cd src/backend && pytest -q -p no:cacheprovider

# Frontend — from src/frontend/
cd src/frontend && npm run build      # tsc -b && vite build
cd src/frontend && npm run lint       # oxlint
cd src/frontend && for f in src/lib/*.test.mjs; do node --experimental-strip-types --test "$f"; done
```

Rules for the gate:
- There is **no** `npm test` script. Do not add one; the ten existing `lib/` test
  files run via the loop above. Plain `node --test` fails with
  `ERR_UNKNOWN_FILE_EXTENSION` — the strip-types flag is what makes it work.
- In a tested `lib/` module, **value imports need explicit `.ts` extensions and
  type-only imports must not have them.** This fails only under the test runner,
  never in the build — so the build passing tells you nothing about it.
- `npm run build` **cannot** catch the MapLibre worker bug (dev-only) and proves
  nothing about visual, animation or map-rendering correctness. Never claim a
  visual pass from a green build.
- Fix every error and warning you introduced. If something was already broken and
  you can't fix it cheaply, note it in the log.
- If validation fails, that is the work. Fix it, re-run the whole gate, repeat
  until green. Do not move to the next item with a red gate.

### 4b. The review gate — after the build gate, before the push

Once the build gate is green for an item, dispatch the reviewers that item
touched. They are defined in `.claude/agents/`.

| Item touches | Dispatch |
|---|---|
| Beats, console copy, scenario, any user-facing string | `mcmc-domain-reviewer` |
| Backend, `lib/`, store, endpoint wiring | `simulation-integrity-tester` |
| Anything under `components/simulation/`, `pages/Simulation.tsx`, `index.css` | `simulation-ux-reviewer` |

Run them **in parallel** — one message, multiple `Agent` calls — whenever more
than one applies. They are read-only and independent.

Then:
- **Fix every BLOCKER before pushing.** A blocker is not a follow-up.
- Weaknesses, first-read problems and accessibility findings: fix them if cheap,
  otherwise log them explicitly as deferred with a reason. Never silently drop a
  finding.
- A reviewer returning an empty findings section is a valid result. Do not
  re-run it hoping for different output, and do not manufacture work from it.
- Record in the log which reviewers ran and what they said. A reviewer's summary
  describes what it *intended* to check — if it claims a file is wrong, open the
  file before acting.

At minimum, run all three once against the finished tab before the final report,
even if no single item triggered all three.

---

## 5. Docs, commits, and pushing

**Docs are not a follow-up task.** Update them in the *same commit* as the code:
- `docs/Disaster_Simulation_Spec.md` when the build diverges from the spec. The
  spec is not sacred — but an undocumented divergence is a defect. Say what
  changed and why.
- `CLAUDE.md` when a rule, command or gotcha changes, and add the two new docs to
  its documentation-map table if they are not there yet.
- `docs/Disaster_Response_Actions.md` if the domain reviewer surfaces a correction.

**Commits.** Small and coherent. Imperative subject. Body explains *why*, not
what. Write commit messages in normal prose. End every commit message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

**Push to `main` after every item that passes both gates.** Not once at the end.
Remote is `https://geoai-collabhub.com/git/starlink.git` over HTTPS. If a push is
rejected, pull/rebase and retry — never force.

**Keep a log at `docs/simulation-build-log.md`**, committed and pushed with each
cycle. Append-only, never rewritten:

```
## <ISO timestamp> — <item>
Did: ...
Decisions made without the operator: ... (and the reasoning)
Validation: <pass/fail, which commands>
Reviewers: <which ran, verdict, what you fixed, what you deferred and why>
Blocked: ... (if anything, with exact steps for the human)
Next: ...
```

---

## 6. Keeping going

- **You do not stop to ask questions.** After the one message in section 0 the
  operator is unreachable. Ambiguity resolves to: pick the option most consistent
  with `CLAUDE.md`, the most honest one where a claim about the system is
  involved, write down why, continue.
- **Timebox.** No more than ~90 minutes on a single item. If it is not
  converging, park it with detailed notes in the log, move to the next item, come
  back later with fresh context.
- **Blocked by something only a human can supply** (a credential, a decision with
  real consequences)? Mark it `BLOCKED-EXTERNAL` in the log with exact steps, then
  move on immediately. Never wait. Never work around it by doing something you
  were told not to do.
- **A failing test is work, not a blocker.** So is a type error, a lint error, a
  broken build, and a reviewer blocker.
- **Do not narrate at length or ask for approval.** Work, validate, review,
  commit, push, log, next.

---

## 7. Stop conditions

Stop only when one of these is true:
1. Every backlog item **and** the hardening list are done, both gates green, all
   three reviewers run clean or with only logged deferrals, and everything pushed.
2. You hit a hard external limit (rate limit, exhausted context, no network) and
   have logged and pushed all work in progress.
3. Continuing would require violating a rule in section 1.

**Do not stop because the item you're on is hard, because you have been running a
long time, or because it feels like a natural pause.**

---

## 8. Final report

When you stop, leave a summary as your last message and append it to
`docs/simulation-build-log.md`:

- What landed, with commit SHAs, and the pushed branch.
- What the three reviewers said, and what you did about each finding — including
  anything you deferred and why.
- Where the build diverged from `docs/Disaster_Simulation_Spec.md`, and why.
- **What is blocked on the operator**, with exact steps.
- Anything you decided on the operator's behalf that they might want to reverse —
  especially the section 0 defaults if no reply arrived.
- The honest state of both gates at the moment you stopped.
- **What has not been verified in a browser.** A green build says nothing about
  whether the map renders, the animation reads, or the timeline is legible. Be
  explicit about what still needs eyes.

Be accurate. If something is half-done, say it is half-done. A truthful report of
partial progress is worth more than a confident one that is not true.
