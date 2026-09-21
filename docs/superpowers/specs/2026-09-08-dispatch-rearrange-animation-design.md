# Dispatch Rearrange Animation — Design

**Date:** 2026-09-08
**Scope:** sub-project 2 of the ticket→schedule work — showing the board rearrange when an
emergency dispatch is approved.
**Depends on:** the approval flow (`2026-09-03-ticket-approval-flow-design.md`), shipped.
**Status:** design approved, not yet implemented.

---

## 0. Why this exists

The approval flow works and is provably correct — the panel reports the crew, the solver's clock,
and which jobs were rescheduled to make room. But on the board itself **nothing indicates what
changed**. A planner who approves a dispatch sees a schedule that is silently different from the
one they were looking at a second ago, and has to remember the previous state to spot it. Measured
on a real run: two jobs moved (`Sat 12 → Thu 10`, `Sun 13 → Sat 12`) and neither was distinguishable
from work that had always been there.

This is also the demo's intended climax: *the original schedule visibly rearranging to prioritise the
emergency.*

---

## 1. The structural constraint that decides the design

**The crew timeline cannot show a cross-day move.** `TimelineBoard` renders a single `selectedDay`
on an hour axis, so a job moving `Sat 12 → Thu 10` does not slide there — it disappears from one
day's view and reappears in another. Cross-day moves are the common case, and were both of the
moves in the measured run.

`ScheduleGridByTower` ("By site") is the only view that holds the whole horizon at once: tower rows
× day columns. There a moved job is a cell changing column, which is a real on-screen slide. So the
animation plays there, and approving switches the board to it — the same mechanic already used to
switch territory to the dispatched crew's.

---

## 2. Decisions locked

1. **Stage: the by-site grid**, auto-switched to on approve (§1).
2. **Pacing: staggered narrative.** Displaced jobs slide to their new columns first, then the
   emergency cell lands in the freed slot. Reads as "we made room, then placed it" rather than
   several cells twitching simultaneously, and it is the causal order the planner just approved.
3. **Replayable.** A Replay control in the confirmation re-runs the sequence from retained state.
   A demo's climax that fires exactly once, while the presenter may be reading the panel, is a
   climax that gets missed — which is what happened on the first live run.
4. **Geometry from column indices, not captured rects.** See §4.
5. **The animation may only ever describe real solver output.** It animates from the pre-pin run to
   the returned run; it never interpolates, invents, or reorders anything the solver did not do.

---

## 3. Data flow

```
TicketApprovalPanel, on /schedule/pin success
   already diffs before-run vs returned run into `moved` (tower, from, to)
        ↓ writes a descriptor into the schedule store
useScheduleStore.dispatchAnimation = {
  moves:    [{ tower_id, from: ISO day, to: ISO day }],
  emergency:{ tower_id, day: ISO day },
  token:    number        // bumped to replay
}
        ↓ setViewMode('tower')   (auto-switch to By site)
ScheduleGridByTower reads the descriptor
   phase 1 (0-400ms):   moved cells translate from their old column to their new one
   phase 2 (+150ms):    emergency cell scales/fades in with its ▲ marker
        ↓ on finish, the descriptor stays (so Replay can re-run it)
Replay button in the confirmation bumps `token`
```

The descriptor is display state, not schedule state — it is derived entirely from two runs the
store already holds, and clearing it changes nothing about the plan.

---

## 4. Why column indices, not FLIP rect capture

The textbook approach captures each cell's `getBoundingClientRect()` before the state change and
animates the delta afterwards. That does not work here: the grid is **not mounted** before approval
— the planner is in the crew view, and the by-site grid only appears when we switch to it. There
are no "before" rects to capture.

Instead, both days are known as horizon indices, and the grid's day columns are equal-width
(`gridTemplateColumns: 190px repeat(n, 1fr)`). So the horizontal delta is:

```
dx = (horizon.indexOf(from) - horizon.indexOf(to)) * columnWidth
```

`columnWidth` is measured once from a rendered cell via `ResizeObserver`, matching how
`TimelineBoard` already measures its lane width. The cell renders in its **final** column, starts
at `translateX(dx)`, and transitions to `translateX(0)` — visually identical to FLIP, with no
dependency on a prior mount.

Vertical movement is deliberately not animated: a row's vertical position can change only if the
row set changes, and animating that would mean the eye following a tower that moved for an
unrelated reason. Rows newly added to the set fade in instead.

---

## 5. Row visibility

`ScheduleGridByTower` caps its rows (top 30, filtered by relevance) and already force-includes the
emergency dispatch target so it can scroll it into view. The same guarantee must extend to every
tower in `dispatchAnimation.moves` — a slide the planner cannot see is worse than no slide, because
the confirmation names the tower and the board then appears not to contain it. Animated towers are
force-included and the emergency row is scrolled into view before phase 1 begins.

---

## 6. Reduced motion

Under `prefers-reduced-motion: reduce`, no cell translates and nothing is staggered: the changed
cells take their final positions immediately and are marked. The information — which jobs moved and
where from — is carried by the marker and the confirmation text, never by the motion alone. The
codebase already honours `prefers-reduced-transparency` for its glass surfaces; this is the same
obligation.

---

## 7. Marker

Motion is transient, so it cannot be the only record. After the sequence settles, each moved cell
keeps a small badge reading its origin (`from Sat 12`) and the emergency cell keeps its existing ▲
glyph, until the descriptor is cleared (Done, or the next dispatch). This is what makes the result
screenshot-able and pointable-at on stage, and is the honest half of the feature: it states what
happened rather than relying on the viewer having watched.

---

## 8. Design-system application

| Element | Rule |
|---|---|
| Moved-cell badge | `tintedChip()` on the accent — this is chrome describing a change, not severity |
| Emergency cell | Existing `--color-alert` spine and ▲ glyph, unchanged |
| Motion | `transform` and `opacity` only — never width/height/left, which would reflow the grid mid-animation |
| Duration | 400ms slide, 150ms stagger, 250ms landing; `ease-out` |
| Blur | None added. The grid is not a glass surface and the blur budget is unchanged |
| Type | Named steps only (`text-eyebrow` for the badge) |

---

## 9. Component inventory

**New**
| File | Purpose | React? |
|---|---|---|
| `lib/dispatchAnimation.ts` | Descriptor type + `columnDelta(from, to, horizon, colWidth)` + phase timing constants | No — pure |

**Changed**
| File | Change |
|---|---|
| `state/useScheduleStore.ts` | `dispatchAnimation` field, `setDispatchAnimation`, `replayDispatchAnimation` (bumps token), `clearDispatchAnimation` |
| `components/schedule/TicketApprovalPanel.tsx` | On pin success write the descriptor and `setViewMode('tower')`; add Replay to the confirmation; clear on Done |
| `components/schedule/ScheduleGridByTower.tsx` | Force-include animated towers; apply the transform/stagger; render the origin badge; honour reduced motion |

**Backend: none.**

---

## 10. Edge cases

| Case | Behaviour |
|---|---|
| Approval displaced nothing | No phase 1. The emergency cell still lands, so the approval always produces visible feedback. |
| A moved tower is outside the current territory | It is not drawn. The confirmation still names it; the badge appears if the planner switches territory while the descriptor lives. |
| A job was dropped, not moved | Dropped work has no destination cell to slide to. It is reported in the confirmation and in the work queue, not animated — inventing an exit animation toward "unscheduled" would imply a position it does not have. |
| Horizon changed between runs | `columnDelta` returns 0 when either day is absent from the current horizon; the cell appears without sliding rather than flying in from an arbitrary offset. |
| Replay pressed after another dispatch | The descriptor is per-dispatch and replaced, so Replay always re-runs the most recent one. |
| `prefers-reduced-motion` | §6. |

---

## 11. Verification

- `lib/dispatchAnimation.ts` is dependency-free → `node --experimental-strip-types --test`, the
  `inundation.test.mjs` pattern. Covers `columnDelta` sign, magnitude, and the missing-day case.
- `npm run build`, `npm run lint`.
- `pytest` unchanged — no backend file is touched, so any movement is a regression signal.
- Browser: approve a dispatch that displaces work (a civil ticket in a busy territory), confirm the
  staggered sequence, the badges, Replay, and the reduced-motion path via devtools emulation.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| The climax plays in a view the presenter was not using | Approve auto-switches to By site (§2.1), and Replay exists precisely so it can be shown again deliberately. |
| Animation implies a causal story the solver did not follow | The descriptor is diffed from two real runs (§2.5); phase order is presentational, and the confirmation states the same facts in words. |
| Grid rows are capped, so an animated tower may not be drawn | §5 force-includes them. |
| Motion as the only carrier of information | §7's persistent badge, plus the confirmation text. |

---

## 13. Out of scope

- Animating the crew timeline (§1 — it cannot show cross-day moves; a same-day reorder animation
  there is a separate, smaller idea).
- Animating the week strip's counts or load bars.
- Sub-project 1a (OSRM routing), unchanged and independent.
