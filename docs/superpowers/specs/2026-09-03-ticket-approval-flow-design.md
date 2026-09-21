# Ticket → Schedule Approval Flow — Design

**Date:** 2026-09-03
**Scope:** the Schedule-side half of `docs/Ticket_To_Schedule_Handoff.md` §1 — the part that doc
marks NOT BUILT YET.
**Status:** design approved, not yet implemented.

---

## 0. Why this exists

`docs/Ticket_To_Schedule_Handoff.md` describes a hand-off that is finished on the ticket side and
absent on the Schedule side. Today a ticket with the Assignee Agent picked sets
`schedule_pending = true` and then **nothing happens, forever** — no crew is suggested, no
`/schedule/pin` fires, and the ticket sits in Open until some Schedule-side surface calls
`markScheduled()` or `markScheduleFailed()`. Nothing calls either. This design is that surface.

The demo story it serves: a field emergency arrives as a ticket, the agent proposes which crew to
divert, the planner sees **what that costs the already-scheduled work** and approves, the board
re-solves, and the ticket flips to Active.

---

## 1. What already exists (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Demo emergency ticket generation | `useTicketStore.createEmergencyTicket()` | Done. Picks a real maintain-band tower from live `/towers`, never `fixtures/towers.ts`. |
| Agent pick → hand-off flag | `state/useAutoDispatch.ts` | Done. Sets `schedule_pending`; deliberately does NOT dispatch. Do not re-add a pin call to it. |
| Ticket write-back contract | `useTicketStore.markScheduled()` / `markScheduleFailed()` | Done, uncalled. This design is the first caller. |
| Crew eligibility mapping | `lib/ticketSkills.ts::rankCandidateCrews()` | Done. `ISSUE_TYPE_TO_CREW_TYPE` + `max_travel_km` filter. The agreed mapping. |
| Commit path | `POST /schedule/preview`, `POST /schedule/pin` | Done. |
| Non-maintain-band tower crash | `api/routes/schedule.py::_resolve_work_orders()` | **Fixed and live.** A ticket can be filed against a watch/ok tower; pinning one used to 500 with a raw `KeyError`. |
| Override horizon drift | `api/routes/schedule.py::_anchor()` | **Fixed and live.** Overrides used to re-solve against the policy demo-clock date instead of the run's own anchor, so a just-placed day read as "outside the planning horizon" on the next render. |
| Board diff rendering | `AgentChat.tsx::deriveBoardChanges()` | Done, reusable. |

**Backend changes required by this design: none.**

---

## 2. Decisions locked

1. **Surface split — Ranger announces, the panel decides.** A compact pinned strip inside the
   Ranger dock advertises pending tickets; the actual suggestion, compensation preview and
   Approve/Reject live in the right-hand `DetailPanel`. Rationale: Ranger stays the narratively
   visible actor (the demo's framing, and doc §1's own diagram), while the decision happens on the
   surface where every other schedule decision is already made and where a proven
   suggest→preview→confirm component (`EmergencyPanel`) already sets the pattern.

2. **The strip is NOT a `Block` in `AgentChat`'s transcript.** Doc §6 leaves this open. Rejected
   because transcript blocks are local streaming state — they scroll away, they can be lost when
   the planner sends a message, and adding an approval gate inside the SSE apply path is the
   single riskiest change available (today every returned `ScheduleRun` is applied immediately,
   with no gate). A pinned region above the transcript touches `sendText`/SSE not at all.

3. **The suggestion is fixed, with a "suggest another" fallback.** Approve/Reject are the two
   primary actions. A secondary control advances to the next-best eligible crew when the top pick
   is a poor fit, so a bad suggestion is not a dead end. No free-form crew/day editing — that path
   already exists on the ticket itself (manual crew dropdown) and on the board (`MoveControl`).

4. **The suggested day is always today** (`run.horizon[0]`). An emergency dispatched four days out
   undercuts the premise. Consequence accepted deliberately: today is more often already booked,
   so displacement — and therefore the compensation readout — fires most of the time. That is the
   intended demo beat.

5. **Crew position is derived from the solver, never simulated.** See §4.

6. **`pin_reason: 'emergency'`**, matching `EmergencyPanel`'s existing vocabulary (doc §6 asks for
   consistency unless there is reason to diverge; there is none).

7. **One at a time.** The strip lists every pending ticket; the panel resolves one. Approving or
   rejecting returns to the strip with the remainder.

---

## 3. Target flow

```
Tickets tab: Assignee Agent picked on an open ticket
   ↓  useAutoDispatch sets schedule_pending = true          (exists)
Schedule tab: watcher reads useTicketStore
   pending = tickets.filter(t => t.schedule_pending && t.status === 'open')
   ↓
Ranger dock collapsed  → pill shows an alert dot + count
Ranger dock open       → pinned strip, one row per pending ticket, each [Review]
   ↓ Review
DetailPanel ← Selection {kind:'ticket_approval', ticket_id, day}
   on mount: POST /schedule/preview (tower, suggested crew, today)
   renders: ticket + tower identity
            suggested crew, where it is now, distance
            COMPENSATION: preview.moved / preview.dropped / wait delta
   ↓
[Approve]  POST /schedule/pin {pin_reason:'emergency'}
           → setRun(next)
           → markScheduled(ticket_id, crew_id)   → ticket flips to Active
[Reject]   → markScheduleFailed(ticket_id)       → stays Open; drawer shows the retry hint,
                                                    reassigning the agent re-arms it
[Suggest another] → advance to next eligible crew, re-run preview
```

---

## 4. Where a crew is *right now* (`lib/crewPosition.ts`)

No GPS, no telemetry, and **nothing simulated** — the schedule already answers this. Given
`run.entries` for today and the wall clock as minutes from midnight:

| Condition | Position | Label |
|---|---|---|
| An entry with `start_min <= now <= end_min` | that tower's coords | `on site at {place}` |
| Otherwise, the latest entry with `end_min <= now` | that tower's coords | `finished at {place}` |
| Otherwise (before the first job, or no jobs today) | the crew's depot | `at {depot.name}` |

This is solver output, so it carries the same authority as every other clock figure on the board
(`CLAUDE.md`: "Every clock figure on the schedule is solver output, and must stay that way").
Simulated GPS pings were considered and rejected: fabricated data presented as live tracking is
exactly what this project's rules forbid.

Note the module returns a position **and** a human label; the panel prints the label so the planner
can see *why* a crew is nearest ("finishing at site 701905, 12 km away") rather than being handed a
bare number.

---

## 5. The suggestion (`lib/ticketSuggestion.ts`)

Pure function: `(ticket, tower, crews, run, nowMin) → Suggestion[]`, ordered best-first.

1. **Eligibility comes from `rankCandidateCrews(ticket, limit)` with `limit = CREWS.length`** (its
   default is 3, which would silently truncate the pool before re-ranking) — trap A in doc §5. It
   applies `ISSUE_TYPE_TO_CREW_TYPE` (the ticket-side vocabulary) plus each crew's
   `max_travel_km`. Do **not** re-derive crew type from `tower.dominant_factor`; the two
   vocabularies do not match 1:1 and this is the agreed mapping.
2. **Re-rank the eligible set by distance from current position**, not depot distance.
   `rankCandidateCrews` sorts by depot distance because that is all it can see; §4 gives us
   better. Eligibility from the shared helper, ordering from live position.
3. **Day** is `run.horizon[0]`.

**Distance and time, and what is honest to claim before approval.** Distance is real (haversine over
real coordinates today; real road km once sub-project 1a lands). Travel *time* pre-approval is an
estimate and must be labelled as one — the exact figure is the solver's, and the solver has not run
yet. After approval the returned run carries the committed `travel_min` / `start_min` / `end_min`
for the new entry, and the confirmation shows those. So: **estimate before, solver truth after**,
each labelled. Do not print an unlabelled minute figure pre-approval; that is the class of bug the
hardcoded-timeslot grid was removed for.

---

## 6. Surfaces

### 6.1 Strip (`components/schedule/TicketApprovalStrip.tsx`)

Rendered inside `AgentChat`, above the transcript, only when `pending.length > 0`. One row per
pending ticket: alert glyph, ticket id, site name, `[Review]`. Rows are compact — this is an index,
not the decision surface.

`AgentDock`'s collapsed pill gains an alert dot and a count when `pending.length > 0`, so a pending
approval is visible without opening the dock. This is the "Ranger announces" half.

### 6.2 Panel (`components/schedule/TicketApprovalPanel.tsx`)

Rendered by `WhySlotPanel` for `selection.kind === 'ticket_approval'`, inside the existing
`DetailPanel`. Sections top to bottom:

1. **Identity** — ticket id, title, tower, site, issue type. Alert spine.
2. **Suggested crew** — crew name/id, role team, where it is now (§4 label), distance, estimated
   travel (labelled estimate). `Suggest another` when more than one crew is eligible.
3. **Compensation** — from `/schedule/preview`: `moved[]` (tower, from→to, ±days), `dropped[]`
   (falls to unscheduled), and the risk-weighted-wait delta. When both are empty, say so plainly
   and say why if a reserve crew-day absorbed it.
4. **Actions** — `Approve` (primary), `Reject` (ghost).
5. **Confirmation** (post-approve) — the committed crew, day, solver `start_min–end_min` and
   `travel_min`, what actually dropped (read from the returned run, not the pre-pin forecast), and
   a link back to the ticket.

**No `RouteMap` in this panel**, stated rather than silently omitted: `RouteMap` draws a crew-day's
committed route and keys off a scheduled entry, which by definition does not exist before approval.
Drawing a speculative crew→tower line would be a second, unsanctioned source of geometry beside the
solver's. Showing the committed route in the post-approval confirmation is a reasonable follow-up
once an entry exists, and is deliberately not in this build.

---

## 7. Design-system application

| Element | Rule |
|---|---|
| Panel spine | `.spine` on `--color-alert` — the same red spine `EmergencyTicketModal` gives this ticket on the Tickets tab, so one object reads identically across two tabs. |
| Panel surface | Inherits `DetailPanel`'s `glass-panel panel-enter`. No new blur layer. |
| Strip surface | `glass-field`. **Not** a `backdrop-filter` surface — the blur budget is 8 and the dock already spends one; nesting blur inside it costs budget for no visual gain. |
| Severity colour | `--color-alert` for the emergency; band colours only via `lib/colors.ts` (`bandColor` fills, `bandInk` text). |
| Control colour | Violet accent only. `Approve` is `tone="primary"`, `Reject` is ghost. Warm hue on a control is a bug. |
| Role chips | `lib/roleColors.ts::tintedChip()`, matching the board's crew rails. |
| Reserve marks | Only `lib/reserveHatch.ts::RESERVE_HATCH_STYLE`, if reserve is surfaced. |
| Type | Named steps only — `eyebrow` / `text-micro` / `text-ui` / `text-lead`. No arbitrary `text-[13px]`. |
| Metadata blocks | `dl` in `rounded-lg border border-overlay/10 bg-overlay/[0.03]`, matching `EmergencyTicketModal`. |

---

## 8. Component inventory

**New**

| File | Purpose | React? |
|---|---|---|
| `lib/crewPosition.ts` | Crew position + label from `run.entries` + clock (§4) | No — pure |
| `lib/ticketSuggestion.ts` | Eligibility + position-ranked suggestion (§5) | No — pure |
| `components/schedule/TicketApprovalStrip.tsx` | Pinned strip in the dock (§6.1) | Yes |
| `components/schedule/TicketApprovalPanel.tsx` | Approval panel (§6.2) | Yes |

**Changed**

| File | Change |
|---|---|
| `state/useScheduleStore.ts` | `Selection` union gains `{kind:'ticket_approval', ticket_id, day}` |
| `components/schedule/WhySlotPanel.tsx` | Route the new selection kind |
| `components/schedule/DetailPanel.tsx` | Header label for the new kind |
| `components/schedule/AgentDock.tsx` | Collapsed-pill alert dot + count |
| `components/schedule/AgentChat.tsx` | Render the strip above the transcript (one line) |

**Unchanged, deliberately:** every backend file, `useAutoDispatch.ts`, `useTicketStore.ts` (its
write-back actions are called, not modified), and `AgentChat`'s streaming logic.

---

## 9. Contract changes

One, frontend-only:

```ts
// state/useScheduleStore.ts
export type Selection =
  | { kind: 'job'; crew_id: string; day: string; tower_id: string }
  | { kind: 'free'; crew_id: string; day: string }
  | { kind: 'reserve'; crew_id: string; day: string }
  | { kind: 'emergency'; tower_id: string; day: string }
  | { kind: 'ticket_approval'; ticket_id: string; day: string };   // new
```

`select()` already syncs `selectedDay` from `selection.day`, so carrying `day` keeps the board on
the day being decided. No backend schema, no `api/types.ts` change.

---

## 10. Edge cases

| Case | Behaviour |
|---|---|
| `/schedule/preview` fails | Panel states the impact could not be computed; **Approve is disabled**. Never approve blind. |
| `/schedule/pin` fails | `markScheduleFailed(ticket_id)` per doc §3 ("or the commit itself fails"), panel offers retry, board unchanged. |
| No eligible crew | Panel explains (no crew of the required type within range); Reject only. |
| `run.horizon` empty (schedule still loading) | Strip says waiting for the schedule; no Review affordance. Mirrors `EmergencyPanel`'s existing `dayIsPlannable` guard. |
| Multiple pending tickets | Strip lists all; panel resolves one; return to strip after. |
| Ticket resolved elsewhere while panel open | Panel clears the selection. |
| Tower not in the live population | Cannot occur through the demo button (it draws from live `/towers`), but a hand-authored fixture ticket can; panel states the tower is unknown, Reject only. |
| Offline (`offlineRun`) | Approval is **refused with a reason**, not emulated. `EmergencyPanel` carries a local-mutation branch for offline, but this flow's approval also flips a ticket to Active via `markScheduled()` — a ticket recorded as dispatched against a schedule the backend never saw is a worse failure than a disabled button. The panel says the scheduler is needed; Reject still works. |

---

## 11. Build sequence

1. `lib/crewPosition.ts` + its `node --test` file.
2. `lib/ticketSuggestion.ts` + its `node --test` file.
3. `Selection` union + `WhySlotPanel`/`DetailPanel` routing (renders a stub panel).
4. `TicketApprovalPanel` — identity + suggestion, no preview yet.
5. Wire `/schedule/preview` → compensation section.
6. Wire `/schedule/pin` → `markScheduled` / `markScheduleFailed` + confirmation.
7. `TicketApprovalStrip` + `AgentChat` mount.
8. `AgentDock` collapsed-pill badge.
9. Full browser pass: Tickets → demo emergency → agent → Schedule → approve → Active.

Steps 1–2 are independently testable without a browser; 3–8 need one.

---

## 12. Verification

- `cd src/frontend && node --experimental-strip-types --test src/lib/crewPosition.test.mjs`
- `cd src/frontend && node --experimental-strip-types --test src/lib/ticketSuggestion.test.mjs`
- `npm run build` (`tsc -b && vite build`) and `npm run lint` (oxlint).
- `cd src/backend && pytest -q -p no:cacheprovider` — should stay at its current pass count;
  this design touches no backend file, so any change there is a regression signal.
- Browser pass on both branches: approve path (ticket → Active, board shows the pinned bar) and
  reject path (ticket stays Open, drawer shows the retry hint, reassigning the agent re-arms it).
- Per `CLAUDE.md`, a passing build does not verify visual or interaction work — the browser pass
  is mandatory, not optional.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Today (`horizon[0]`) is frequently full, so approvals routinely displace work | This is intended (§2.4) — the compensation readout is the feature. But if a demo needs the "zero disruption" beat, pick a ticket whose crew type holds reserve (`civil`/`power` per `policy.yaml`; `rf`/`electrical` hold none). |
| Pre-approval travel time is an estimate while the board draws solver truth | Both labelled (§5). Resolved outright when sub-project 1a lands and the estimate becomes real road time. |
| The strip is inside a dock that is collapsed by default | The collapsed pill carries the alert dot and count (§6.1); the approval is never invisible. |
| Ticket state is in-memory only (no ticket backend) | Pre-existing and documented; a page reload resets the board. Demo runs in one session. |

---

## 14. Out of scope

- **Sub-project 1a — real routing.** Replacing haversine × `road_factor` with a precomputed OSRM
  road matrix (`data/prepare_travel_matrix.py`, self-hosted OSRM, free-flow only, no traffic, no
  runtime API). Independent of this design: the approval flow works with whatever travel model is
  in place, and improves automatically when 1a lands. Gets its own spec.
- **Sub-project 2 — the reschedule animation.** Animating the board from its pre-approval to its
  post-approval arrangement. Sits on top of §6.2's confirmation and `deriveBoardChanges`. Its own
  spec.
- Making Ranger's LLM path decide dispatches. Unchanged and deliberate: the optimizer decides, the
  agent reports. `apply_constraint`'s `emergency_dispatch` → `to_pins()` stub is a known, separate
  gap.
- Any ticket-backend persistence.

---

## 15. Assumptions this design rests on

1. `schedule_pending` remains the hand-off contract and `useAutoDispatch` keeps not dispatching.
2. `markScheduled` / `markScheduleFailed` remain the only ways this flow moves a ticket — never
   `setStatus`/`assignCrew`, which carry manual-path semantics the drawer's status strip reads.
3. `/schedule/preview` remains non-mutating and `/schedule/pin` remains the commit, both keeping
   the `_resolve_work_orders()` and `_anchor()` guarantees.
4. Ticket tower ids come from the live population; the frontend resolves them with
   `useLiveTower`, never `fixtures/towers.ts`.
5. The Schedule page keeps mounting `DetailPanel` and `AgentDock` as siblings of the board.
