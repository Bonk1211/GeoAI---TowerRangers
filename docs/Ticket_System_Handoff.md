# Ticket System — Design Handoff

**Status: this is the outstanding piece.** The rest of the app — map console, Investigation, Schedule, Weights, Perception, Method — is already built (see `docs/Frontend_Handoff.md` / `docs/Frontend_Build_Plan.md` for that history). This doc is scoped to the one feature not yet started: the ticket log. Treat everything in §1–§4 as new build, not a revision of existing pages.

**For the UI/UX implementer.** Scope: a Jira-style issue log for towers, viewed from the ops-center perspective — we *receive* reports, assign crews, and close the loop. Not a rebuild of the risk-index or scheduler.

**Reference templates** (already saved, study both before drawing):
- [docs/frontend-template/ticket-log-system-landing-page-template.webp](frontend-template/ticket-log-system-landing-page-template.webp) — "Flowtic" kanban board. Reference for board/column layout only. **Light theme — do not carry over.**
- [docs/frontend-template/ticket-log-system-details-card.webp](frontend-template/ticket-log-system-details-card.webp) — "Benchmark" ticket detail drawer. Reference for detail-panel structure (header meta grid, description, comment thread, composer).

---

## 0. Ground rules

1. **This app is dark glass, not light SaaS.** Reuse existing tokens — `--color-accent` (violet, chrome only), `--color-maintain`/`--color-watch`/`--color-ok`/`--color-alert` (severity only, never on a control), `glass-raised` surfaces, `spine` band strip. Do not import the templates' light palette or their priority-tag colors wholesale — re-derive using this app's existing severity language. See root `CLAUDE.md` design-system section before touching color.
2. **Reuse primitives, don't reinvent.** `PageHeader`, `Panel`, `Button` from `src/frontend/src/components/ui/Panel.tsx`. Look at `pages/Investigation.tsx` (list+detail split, filter pills, search) and `pages/Schedule.tsx` (`aside` overlay column pattern) for how existing pages compose these.
3. **No dead controls.** If a UI element from the reference templates has no backing data or action in this app (see §3 "Explicitly dropped"), do not include it. Per `CLAUDE.md`: a control with no backend must either be visibly `aria-disabled` with an explanatory `title`, or not exist. Never wire a fake response.
4. **Mock data only, for now.** No ticket backend exists yet. Build against the entity shape in §2 and a local fixture, same pattern as `src/frontend/src/fixtures/`.
5. **Manual-report only, for now.** Tickets are created by a person logging an issue against a tower. Auto-spawning a ticket from the ML risk index (`dominant_factor` crossing a threshold) is future work — leave a `source: 'manual'` field on the entity so that door stays open, but do not build the auto-spawn path.
6. **No close-loop ML wiring, for now.** The ticket's `resolution` field (confirmed / false-positive) is captured and stored only. It does **not** feed `model/validate.py` or any rank-stability check in this pass — that integration is a separate future task, decided against for this round.

---

## 1. Nav & routing

New top-level route, sits beside Investigation in the pill nav:

| Route | Page | Position in `NavPill` |
|---|---|---|
| `/tickets` | Tickets | after `/investigation`, before `/schedule` |

Nav label: **Tickets**. One word, matches existing style (`Map` / `Investigation` / `Schedule` / `Weights` / `Perception` / `Method`).

---

## 2. Ticket entity (mock fixture shape)

```ts
type TicketStatus = 'open' | 'active' | 'resolved' | 'closed';
type TicketResolution = 'confirmed' | 'false_positive' | null;

interface Ticket {
  ticket_id: string;          // e.g. "T-1042"
  tower_id: string;           // FK into existing Tower record — never mutates it
  title: string;
  description: string;
  issue_type: string;         // free choice at report time, e.g. Equipment / Power / Structural / Other
  reporter: string;
  status: TicketStatus;
  assignee_crew_id: string | null;  // FK into CREWS fixture
  created_at: string;         // ISO date
  target_sla: string | null;  // ISO date, optional
  fix_notes: { author: string; created_at: string; text: string; link?: string }[]; // mock text/link, no real upload
  resolution: TicketResolution;   // set only when status = closed
  source: 'manual';            // reserved for future 'ml_generated'
}
```

**Status meaning:**
| Status | Meaning | Set by |
|---|---|---|
| `open` | Reported, no crew designated yet | reporter |
| `active` | Crew assigned — covers both "designated, not yet started" and "working on it". Deliberately not split further: relies on the PIC updating status themselves, which isn't reliable enough to trust a finer-grained state. | assignee/PIC |
| `resolved` | PIC submits fix, awaiting validation | assignee/PIC |
| `closed` | Validated by admin/reporter, `resolution` set | admin/reporter (the person in charge, not the PIC who did the fix) |

**Boundary rule:** ticket references `tower_id` only. It must never write back to the scored-tower record — same "scheduler never recomputes scoring" invariant the rest of the app follows.

---

## 3. Layout — Board (landing view)

Kanban, 4 fixed columns by `status`. Adapted from the Flowtic reference's board mechanics (columns, card density, counts) — **not** its visual style.

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Map][Investigation][Tickets][Schedule][Weights][Perception][Method] │  NavPill
├─────────────────────────────────────────────────────────────────────┤
│ Tickets                                    [Search...] [+ New Ticket]│  PageHeader
│ Field-reported issues logged against towers                          │
├─────────────────────────────────────────────────────────────────────┤
│  OPEN (3)      │  ACTIVE (3)     │  RESOLVED (1)      │  CLOSED (5)  │
│ ┌────────────┐ │ ┌─────────────┐ │ ┌──────────────┐   │ ┌────────────┐│
│ │● MY_1042   │ │ │● MY_0873    │ │ │● MY_1190      │   │ │✓ MY_0221   ││
│ │Antenna tilt│ │ │Power flicker│ │ │Flood damage    │   │ │False-pos   ││
│ │reported off│ │ │Crew Alpha    │ │ │Fix submitted, │   │ │Confirmed   ││
│ │2d ago      │ │ │working       │ │ │needs review    │   │ │3d ago      ││
│ └────────────┘ │ └─────────────┘ │ └──────────────┘   │ └────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

Card details:
- Status dot uses `bandColor()` from `lib/colors.ts`, driven by the **linked tower's** `decision` — this is the one place ticket severity borrows the existing risk-severity color language, so a card visually agrees with the tower's own band on the map/Investigation page.
- Card shows: `tower_id`, short `title`, relative age or assignee, nothing else — keep board scan-able, detail lives in the drawer.

---

## 4. Layout — Detail drawer (on card click)

Adapted from the Benchmark reference's structure (back-nav, ID badge, two-column meta grid, description + attachment, threaded notes, composer) — width and density should follow that reference closely; **colors, card style, and the comment-visibility toggle do not carry over.**

```
┌──────────────────────────────────────────────────────────┐
│ ← Back                                                     │
│                                                              │
│ Antenna Tilt After Storm            [T-1042]                │  spine = bandColor(tower.decision)
│                                                              │
│ ┌─────────────────────────┬──────────────────────────────┐│
│ │ Tower       MY_1042      │ Status      [Active ▾]        ││
│ │             Gua Musang   │ Priority    ⚑ Urgent          ││
│ │ Reported by field-tech-03│ Logged      Aug 25, 2026      ││
│ │ Assignee    [Crew Alpha▾]│ Target SLA  Aug 30, 2026       ││
│ │ Issue Type  Equipment     │                                ││
│ │ ↗ View Investigation      │                                ││
│ └─────────────────────────┴──────────────────────────────┘│
│                                                              │
│ Description                                                 │
│ Antenna visibly tilted after storm, needs inspection         │
│ before next monsoon window.                                  │
│ 🔗 site_photo_link.jpg  (mock text/link, not a real upload)  │
│                                                              │
│ ── Fix Notes ──────────────────────────────────────────────│
│                                                              │
│  Crew Alpha           Aug 26, 10:20                          │
│  Inspected — bracket loosened, tightening scheduled           │
│  🔗 inspection_note.pdf                                       │
│                                                              │
│  [+ text box: add fix note/link...]           [Add Note]     │
│  [ Submit Fix → Resolved ]  (moves status open→active→resolved)│
│                                                              │
│ ── Close Ticket (admin/reporter only) ───────────────────────│
│  [ Confirm Issue ]   [ Mark False Positive ]                 │
│  (enabled once status = Resolved — validates the PIC's fix,   │
│   sets resolution, moves status → Closed)                     │
└──────────────────────────────────────────────────────────┘
```

Panel width: ~520px overlay (wider than `Schedule`'s 360px `aside` — comment thread needs room).

`↗ View Investigation` navigates to `/investigation/{tower_id}`, same cross-link pattern already used between Schedule and Investigation (`setHighlightedTower` + `navigate`).

---

## 5. Skills agents (per-column)

Adapted from Jira/Rovo's board-agent picker: a small icon pinned to each column header, click opens a "Select a skill" list, pick swaps which skill runs that column. Same mechanic, four fixed skills instead of Rovo's third-party tool integrations. **Every skill here is mocked — frontend-only pass, no live model call, no real external side effect.** Label each accordingly wherever it appears (same `illustrative` convention `Frontend_Handoff.md` already uses for any unfabricated number).

```
┌─────────────────────┐
│ OPEN (3)       [✦▾]  │  ← accent-violet icon (chrome, not severity — see color rule in root CLAUDE.md)
├─────────────────────┤
│ card, card, card...   │
└─────────────────────┘

click [✦▾] →

┌─────────────────────────────┐
│ Select a skill                │
│ ┌───────────────────────────┐│
│ │ ✦ Issue Descriptor      ✓  ││  ← currently pinned
│ │   drafts fuller description │
│ ├───────────────────────────┤│
│ │ ✦ Assignee Agent            ││
│ │   suggests candidate crew   │
│ ├───────────────────────────┤│
│ │ ✦ Validation Assistant      ││
│ │   drafts closeout summary   │
│ ├───────────────────────────┤│
│ │ ○ None                      ││
│ └───────────────────────────┘│
└─────────────────────────────┘
```

**The four skills:**

| Skill | What it does | Real or mocked | Notes |
|---|---|---|---|
| **Assignee Agent** | Filters `CREWS` fixture by territory + crew_type matching `issue_type` (reuses the same matching rules `scheduler/optimize.py` and `actions.yaml` already apply for ML work orders), returns a ranked candidate list. | **Real** — deterministic client-side logic, not an LLM call | Suggests only. Human still clicks Assign. Never auto-assigns. |
| **Issue Descriptor** | Expands the reporter's raw text into a fuller description, and suggests a possible fix. | **Mocked** — canned/illustrative text | Must visibly read as a draft/suggestion, not live reasoning over the actual ticket. |
| **Notifier** | Not column-pinned — a global behavior that fires on status transitions (`Open→Active` notifies the assignee, `Resolved→Closed` notifies the reporter/admin). | **Mocked** — in-app notification/timeline entry only | No real email/Gmail send. Never render a "sent ✓" state for something that didn't send — that's a fabricated capability, same rule as the AOI tools' `aria-disabled` pattern. |
| **Validation Assistant** | Drafts a closeout summary for the human validator to read before they decide. | **Mocked**, and **drafts only** | Does **not** set `resolution` or move status itself — that stays a manual click (`Confirm Issue` / `Mark False Positive` in §4). Auto-closing here would erase the human-in-the-loop check the `Resolved → Closed` split exists for. |

**Suggested column defaults** (editable per-column via the dropdown, not hardcoded):

| Column | Default pinned skill |
|---|---|
| Open | Issue Descriptor |
| Active | None |
| Resolved | Validation Assistant |
| Closed | None |

---

## 6. Explicitly dropped from the reference templates

| Reference element | Why dropped |
|---|---|
| Internal / External comment visibility toggle (Benchmark) | No external-stakeholder concept in this app. Would be a control wired to nothing — violates the no-dead-controls rule. |
| Category / Sub-category / Entity split (Benchmark) | That structure models a client-account hierarchy. Here there is only the tower — collapsed to `Tower` + `Issue Type`. |
| Light theme, card shadows, rounded-soft style (both) | Contradicts this app's dark-glass system (`glass-raised`, measured-contrast greys, violet-only chrome). Structure and density only. |
| "Create agent" / "Browse agents" footer (Jira reference, §5) | No agent marketplace or custom-agent creation in this app — four fixed skills only. Omit the footer entirely rather than show a link to nothing. |

---

## 7. Explicitly out of scope this pass

- Auto-spawning tickets from ML risk index (`dominant_factor` → ticket). Entity has `source` field reserved for it.
- Wiring `resolution` (confirmed / false-positive) into `model/validate.py` rank-stability check. Logged only, not consumed.
- Real file upload for attachments — text/link fields only, mocked.
- Any live LLM call, real email/notification send, or agent that decides/closes on its own — see §5, everything there is either deterministic-and-real or mocked-and-labeled.
