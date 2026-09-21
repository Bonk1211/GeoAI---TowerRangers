# Ticket → Schedule Hand-off

**Status: BUILT (2026-09-10). This doc is now the contract, not a work item.** Ticket-side work (Tickets page, Demo Emergency Ticket button, Assignee Agent picker) was already done when this was written; the Schedule-side approval flow it scoped — notification, suggestion, approve/reject, real pin, board visualisation — is now built and verified in-browser. Every §1 step marked `NOT BUILT YET` below has been marked `BUILT` with the file that implements it.

**Do not rebuild any of it.** The design decisions §6 left open are recorded there as made. The build's own spec is `docs/superpowers/specs/2026-09-03-ticket-approval-flow-design.md`.

**Read this before touching `useTicketStore.ts`, `useAutoDispatch.ts`, `AgentChat.tsx`, or `TicketApprovalPanel.tsx`.** §0, §3 and §5 are still live constraints — they describe invariants the built flow depends on, not history.

---

## 0. What already exists, and what it deliberately does NOT do

The demo flow today:

1. Admin clicks **+ Demo Emergency Ticket** (Tickets page header) → generates an urgent ticket against a real tower (picked from live `/towers` data, not a mock), pops a centered alert modal.
2. Admin dismisses the modal → opens the normal ticket detail drawer, ticket sits in the **Open** column.
3. Admin picks **Assignee Agent** from the card's agent picker (the sparkle "+" icon, top-right of the card) or the drawer.
4. The moment `agent_id` becomes `'assignee_agent'` on an **open** ticket, `state/useAutoDispatch.ts` sets `ticket.schedule_pending = true`.
5. **That is the entire hand-off. Nothing else happens automatically.** No crew is suggested to the *ticket* UI beyond the existing `rankCandidateCrews()` list (client-side distance/crew-type filter, informational only — see §2). No `/schedule/pin` call fires. The ticket stays in **Open**, unassigned, forever, until something on the Schedule side calls `markScheduled()` or `markScheduleFailed()` (§3).

This was **not** the first version. An earlier pass had `useAutoDispatch` fire the pin call itself the instant the agent was assigned — ticket flipped straight to Active with a crew already booked, no human step in between. That was wrong: the real product flow needs a human to see the agent's suggestion on the Schedule side and explicitly approve it before anything is booked. `useAutoDispatch` was gutted back down to just the flag-set; do not re-add a pin call to it.

---

## 1. The flow this hands off to

```
Ticket: Assignee Agent picked
        ↓ (useAutoDispatch sets schedule_pending = true)
Schedule side: notify in Ranger chat            ← BUILT · TicketApprovalStrip.tsx, pinned
                                                   above AgentChat's transcript, + a count
                                                   badge on AgentDock's collapsed pill
        ↓
User sees agent's crew/day suggestion            ← BUILT · TicketApprovalPanel.tsx, opened
                                                   from the strip's "Review" via
                                                   select({kind:'ticket_approval'}) and
                                                   rendered by WhySlotPanel
        ↓
User approves                                    ← BUILT · sticky Approve/Reject bar, with
                                                   a confirm step on reject
        ↓
AI/optimizer arranges it (real /schedule/pin)     ← BUILT · usePreviewOverride (cost shown
                                                   first, non-mutating) then usePinOverride
        ↓
Board visualizes the change (gantt bar appears)   ← BUILT · setDispatchAnimation({moves,
                                                   emergency}) drives the rearrange
                                                   animation on the By-site grid
        ↓
Ticket flips to Active                           ← BUILT · markScheduled() in the pin's
                                                   onSuccess (§3)
```

**Verified end-to-end in a browser**, not on a passing build: ticket raised → agent picked →
strip appears in the Ranger dock → panel ranks candidates with measured road legs → approve →
board scrolls to the row, the emergency cell draws on the ALERT ramp, displaced work animates to
its new day, ticket reads Active. Reject and commit-failure paths both return the ticket to Open.

Reject path: user declines the suggestion → call `markScheduleFailed()` → ticket stays Open, drawer shows "Rejected on Schedule. Reassign the agent to send it again," `useAutoDispatch` will pick it up again once agent_id is reassigned (clears `schedule_failed`, see §3).

---

## 2. What to watch for pending tickets

```ts
import { useTicketStore } from '../state/useTicketStore';

const tickets = useTicketStore((s) => s.tickets);
const pending = tickets.filter((t) => t.schedule_pending && t.status === 'open');
```

Each pending ticket (`fixtures/tickets.ts::Ticket`) carries:

| Field | Use for |
|---|---|
| `tower_id` | The real tower to dispatch to — resolve via `useLiveTower(tower_id, weights)` (`api/useLiveTowers.ts`), not the frontend's static `fixtures/towers.ts` (see the big warning in §5). |
| `issue_type` | `'Equipment' \| 'Power' \| 'Structural' \| 'Other'` — already used by `lib/ticketSkills.ts::rankCandidateCrews(ticket)` to filter `CREWS` by crew_type + distance. Reuse that function for the suggestion rather than re-deriving crew_type from `dominant_factor` — the two vocabularies don't match 1:1 and `rankCandidateCrews` is already the agreed mapping (`ISSUE_TYPE_TO_CREW_TYPE` in that file). |
| `title`, `description` | For the chat notification text. |
| `ticket_id` | Pass back into `markScheduled(ticket_id, crew_id)` / `markScheduleFailed(ticket_id)` once resolved. |

`rankCandidateCrews(ticket)` returns `{ crew: Crew; distance_km: number }[]`, sorted nearest-first, already filtered to crews within `max_travel_km` and matching crew_type. This is a reasonable starting point for "the agent's suggestion" — it's what the ticket drawer itself already shows under "Assignee Agent — suggested crews."

---

## 3. Calling back into the ticket store once resolved

```ts
interface TicketStoreState {
  // ...
  markScheduled: (ticket_id: string, crew_id: string) => void;   // approve path
  markScheduleFailed: (ticket_id: string) => void;                // reject path
}
```

- **`markScheduled(ticket_id, crew_id)`** — call this *after* the real dispatch has actually been committed (i.e. after `/schedule/pin` or whatever the Schedule side's own commit path is returns success). It sets `status: 'active'`, `assignee_crew_id: crew_id`, clears `schedule_pending`/`schedule_failed`. This is the **only** thing that moves a ticket out of Open in this flow — do not call `setStatus`/`assignCrew` directly for this case, since those are the manual-crew-pick paths and don't carry the same "came from Schedule" semantics the drawer's status strip reads (§5).
- **`markScheduleFailed(ticket_id)`** — call this if the user rejects the suggestion, or the commit itself fails. Ticket stays Open, `schedule_pending` clears, `schedule_failed` sets. The drawer already shows the rejection message and lets the admin reassign the agent to try again — reassigning clears `schedule_failed` automatically (`setAgentId` does this, see `useTicketStore.ts`), which lets `useAutoDispatch` pick the ticket back up.

Both are plain Zustand actions — import `useTicketStore` from `state/useTicketStore.ts` and call them from wherever the approval resolves (a chat message handler, a button's onClick, whatever the approval UI ends up being — this doc doesn't prescribe that surface, that's your call).

---

## 4. What already exists on the Schedule side you can probably reuse

`components/schedule/AgentChat.tsx` ("Ranger") is the existing chat surface. Today it only handles **free-text** input the user types (constraints like "crew SEL-C1 unavailable Thursday", or "emergency dispatch to MY_1042") — it streams SSE from `POST /agent/chat` via `streamAgentChat()` (`api/client.ts`) and applies whatever `ScheduleRun` comes back immediately, no approval gate. `agentParser.ts::parseConstraint()` does client-side regex parsing for the local-echo preview shown before the server responds; it does **not** call any backend.

Relevant machinery already there, reusable for the ticket-approval surface:
- `deriveBoardChanges(before, after)` — diffs two `ScheduleRun`s into human-readable lines ("Kota Bharu: now booked — KEL-C1, 2026-09-10"). Exactly the "visualise what changes has been made" step.
- The `Block` union's `'tool'`, `'changes'`, `'error'` render variants — same visual language (pill badges, diff card) your ticket-notification message could reuse.
- `usePinOverride`/`useScheduleStore` (`api/queries.ts`, `state/useScheduleStore.ts`) — the actual commit path. `EmergencyPanel.tsx` (`components/schedule/`) is the closest existing reference for "resolve nearest crew, call pin, report what happened" — same shape a ticket-approval commit would need, minus the approval gate itself.

~~What does **not** exist yet, and is squarely this doc's scope:~~ **All three are now built:**
- ~~Any notion of a "pending suggestion awaiting approval" in the chat~~ — `TicketApprovalStrip.tsx`. The free-text path is unchanged and still applies immediately; the strip is a separate region that never touches the SSE path.
- ~~Approve/reject UI attached to a specific suggestion~~ — `TicketApprovalPanel.tsx`'s sticky bar.
- ~~The trigger that turns "a ticket became schedule_pending" into a chat message~~ — `state/usePendingTickets.ts`, shared by the strip and the dock badge. Not an effect posting a message: a derived selector, so it cannot desync from the store or scroll away.

**One reuse in §4 was deliberately declined.** `deriveBoardChanges()` returns human-readable strings; the approval panel needs structured moves (`tower_id`, `from`/`to` day, `from_crew_id`/`to_crew_id`) to drive the rearrange animation, so it diffs the returned run itself. It also diffs **after** the pin rather than carrying the preview forward — the solver is free to place things differently than the preview predicted, and the moves reported are the ones that actually happened. `AgentChat` still uses `deriveBoardChanges` for its own free-text flow.

---

## 5. Two traps already hit once, worth not re-hitting

**Real tower ids ≠ frontend fixture ids.** `fixtures/towers.ts` is a small offline mock (`MY_1000`–`MY_1043`-ish range). The backend's real `/towers` (whether `USE_FIXTURE=1`'s small fixed set, the 132-tower pilot, or the 1164-tower national dataset) uses a completely different id space — real OSM ids look like `MY_N11659562128`. `createEmergencyTicket()` was fixed to generate tickets against `useLiveTowers()`'s real data specifically because of this; **any new Schedule-side code reading a ticket's `tower_id` must also resolve it via `useLiveTower(tower_id, weights)` (`api/useLiveTowers.ts`), never `fixtures/towers.ts`**, or it'll either show blank/"Unranked" state for a perfectly real tower, or (if it tries to feed a stale fixture-derived id back into `/schedule/pin`) 404.

**Backend crash on a tower outside the maintain band, now fixed — but only where this doc's code already calls it from.** `scheduler/override.py::pin()`/`preview()`/`emergency()` all assume the target tower already has a work order (`work_orders_by_tower[tower_id]`), which is only true for towers `/schedule/optimize` put in the maintain band. A ticket can be filed against *any* tower — watch/ok band included — and pinning one of those used to 500 with a raw `KeyError`, contradicting `override.py`'s own documented "never blocked" contract. Fixed in `api/routes/schedule.py::_resolve_work_orders()` — synthesizes the missing work order + tower record on the fly (same construction `/schedule/optimize` uses) for `preview`/`pin`/`emergency` alike. **This fix is already live and needs no further action**, but if your approval-commit path calls into the scheduler through some *other* route than these three, or reimplements pin logic rather than calling the existing endpoints, you'll hit the same crash again — reuse `/schedule/pin` (or `EmergencyPanel.tsx`'s pattern) rather than reinventing it.

---

## 6. Things left undecided here — now decided in the build

- **Notification surface: a separate region, not a `Block` in the transcript.** Transcript blocks are local streaming state — they scroll away and can be lost when the planner sends a message, and an approval nobody can see is one that never happens. `TicketApprovalStrip` is pinned above the transcript and touches the SSE path not at all. It is also not a glass surface: the dock already spends one of the eight blur-budget slots.
- **Approve re-uses `/schedule/pin` with `pin_reason: 'emergency'`**, matching `EmergencyPanel`. No new reason string — `RoleGroup`, `ScheduleGridByTower` and `whySlot.ts` all already branch on that value, so a fourth vocabulary would have needed three more call sites to learn it.
- **All pending tickets show at once**, one row each, rather than queuing. The strip is an index; the panel is where one ticket is decided.

Three things the build added past this doc's baseline, worth knowing before changing them:

- **Ranking is crew-position-aware, not depot-distance.** §2 called `rankCandidateCrews()` (depot → tower) "a reasonable starting point"; `lib/ticketSuggestion.ts` re-ranks from where each crew *actually is* at the dispatch time — on site, idle at its last tower, or back at depot (`lib/crewPosition.ts`) — and substitutes **measured road distances** from `POST /travel/legs` wherever the road matrix holds the pair. `rankCandidateCrews` is still the capability + range filter underneath; the crew-type mapping is unchanged. A candidate the matrix cannot reach sorts last rather than being dropped, and an estimated leg is labelled `(est.)` so a guessed number is never shown as a measured one.
- **`crewTypeForTicket()` handles `issue_type: 'Other'`.** `ISSUE_TYPE_TO_CREW_TYPE` maps it to `null`, which meant *no capability filter at all* — a Power crew was being offered for a vegetation site. It now falls back to the tower's `dominant_factor`. The mapping for the other three issue types is untouched.
- **The board is prepared before the animation runs.** Approving switches to the By-site view (a cross-day move is invisible on the one-day crew timeline), points the territory selector at the proposed crew's territory (a dispatch into a territory you are not viewing draws nothing and reads as a no-op), and collapses the Ranger dock (420×540 anchored bottom-left, which covers exactly where a first-day dispatch lands). All three are in the pin's `onSuccess`; removing any one of them makes the animation silently invisible in a specific, reproducible case.
