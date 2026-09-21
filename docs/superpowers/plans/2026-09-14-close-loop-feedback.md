# Close Loop Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the technician's close-out verdict — already captured, currently read by nothing — into a visible, exportable training corpus that fills the one hole in the existing retraining loop.

**Architecture:** The backend ledger (`model/feedback.py`) and the ticket close-out flow (`useTicketStore`) both already exist. This plan adds one read-only endpoint to expose ledger rows, a pure-function corpus layer (`lib/feedbackCorpus.ts`) that joins closed tickets to those rows, and a `/loop` page that renders the join. Nothing writes to the ledger; the export produces the exact JSONL a human would append.

**Tech Stack:** React 19 + TypeScript + Zustand + TanStack Query + Tailwind (frontend); FastAPI + Pydantic + pytest (backend). Frontend logic tests run under `node --experimental-strip-types --test`.

**Spec:** `docs/superpowers/specs/2026-09-14-close-loop-feedback-design.md`

## Global Constraints

- **Branch:** `main`. It is at `1be0d26` and matches `origin/main`.
- **Frontend gate, every task:** `cd src/frontend && npx tsc --noEmit` must exit 0, and `npm run build` must succeed. Both are clean today.
- **Backend gate, every task:** `cd src/backend && python -m pytest model/ api/ scheduler/ -q` — **210 passing today.** Do NOT run the full backend suite as a gate: `tiles/` (2) and `thermal/` (1) fail on `main` for unrelated pre-existing reasons (Supabase map cache timeouts; `/fire/layers` never mounted). Those 3 are out of scope — do not fix them here.
- **Frontend logic tests:** `cd src/frontend && node --experimental-strip-types --test src/lib/<name>.test.mjs`.
- **Import extensions:** in `.test.mjs` files and in any `lib/*.ts` that imports another `lib/*.ts` at runtime, the import **must** carry an explicit `.ts` extension (`from './feedbackCorpus.ts'`). Node's strip-types loader does not resolve extensionless paths. Type-only imports are erased and do not need it.
- **No fabricated measurements.** Any count derived from tickets is a tally, never an accuracy figure. The `VerdictMatrix` caveat sentence in Task 7 is copied verbatim and must not be softened.
- **No writes to the ledger.** No `POST`, no file append, no change to `Observation` or its validation.
- **`simulated: false`** on every exported record. That field is the entire point of the export.
- **Commit after every task.** End commit messages with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

**Created**

| path | responsibility |
|---|---|
| `src/frontend/src/lib/feedbackCorpus.ts` | All corpus logic. Pure functions, no React, no stores. |
| `src/frontend/src/lib/feedbackCorpus.test.mjs` | Node tests for the above. |
| `src/frontend/src/components/closeloop/LoopDiagram.tsx` | Five-stage strip with live counts. |
| `src/frontend/src/components/closeloop/VerdictMatrix.tsx` | The 2×2 plus its caveat. |
| `src/frontend/src/components/closeloop/CorpusLedger.tsx` | The row table plus the export button. |
| `src/frontend/src/components/closeloop/DisagreementList.tsx` | Where the model was wrong. |
| `src/frontend/src/components/closeloop/index.ts` | Barrel. |
| `src/frontend/src/pages/CloseLoop.tsx` | Composes the four plus the honesty panel. |
| `src/frontend/src/components/method/PerceptionEvidence.tsx` | Perception's salvaged content. |

**Modified**

`src/backend/model/feedback.py` (one read function), `src/backend/api/routes/model.py`, `src/backend/api/schemas.py`, `src/backend/api/test_model_health.py`, `src/frontend/src/fixtures/tickets.ts`, `src/frontend/src/state/useTicketStore.ts`, `src/frontend/src/components/tickets/TicketDrawer.tsx`, `src/frontend/src/api/types.ts`, `src/frontend/src/api/client.ts`, `src/frontend/src/api/queries.ts`, `src/frontend/src/App.tsx`, `src/frontend/src/components/shell/NavPill.tsx`, `src/frontend/src/components/method/MethodPage.tsx`

**Deleted**

`src/frontend/src/pages/Perception.tsx`, `src/frontend/src/components/perception/PerceptionProof.tsx`

---

## Task 1: Ledger read endpoint

**Files:**
- Modify: `src/backend/model/feedback.py` (add one public function after `_read`, which ends at line 95)
- Modify: `src/backend/api/schemas.py` (append after `LedgerSummary`, which ends at line 216)
- Modify: `src/backend/api/routes/model.py` (append after `_ledger`, line 87-88)
- Test: `src/backend/api/test_model_health.py`

**Interfaces:**
- Consumes: `feedback.Observation`, `feedback.LEDGER_PATH`, `feedback.append` — all existing.
- Produces: `GET /model/feedback/observations?label_status=<str>` returning a JSON list of whole observation rows. Task 5 consumes this.

- [ ] **Step 1: Write the failing test**

Append to `src/backend/api/test_model_health.py`:

```python
def test_feedback_observations_returns_whole_rows_and_filters_by_label_status():
    """The frontend copies a row to build a confirmation, so a projection is
    not enough — _confirmed() keys on (tower_id, source, observed_at) and a
    record missing any of them appends an orphan instead of confirming."""
    from tempfile import TemporaryDirectory
    from unittest.mock import patch
    from model import feedback

    with TemporaryDirectory() as directory, patch.object(
        feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"
    ):
        # No ledger file at all is absence, not an error.
        assert route.feedback_observations() == []

        feedback.append([
            feedback.Observation(
                "2026-09-01T00:00:00+00:00", "MY_1010", "s2_change",
                {"evi_delta_per_year": 0.1}, 0.9, "maintain", "agree",
            )
        ])

        rows = route.feedback_observations()
        assert len(rows) == 1
        row = rows[0]
        # Every field Observation carries must survive the trip.
        assert set(row) == {
            "observed_at", "tower_id", "source", "observation",
            "predicted_priority", "predicted_decision", "agreement",
            "label_status", "simulated",
        }
        assert row["tower_id"] == "MY_1010"
        assert row["source"] == "s2_change"
        assert row["label_status"] == "unlabeled"
        assert row["observation"] == {"evi_delta_per_year": 0.1}

        assert route.feedback_observations(label_status="unlabeled") == rows
        assert route.feedback_observations(label_status="confirmed") == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && python -m pytest api/test_model_health.py::test_feedback_observations_returns_whole_rows_and_filters_by_label_status -q`
Expected: FAIL with `AttributeError: module 'api.routes.model' has no attribute 'feedback_observations'`

- [ ] **Step 3: Add the read function to `model/feedback.py`**

Insert directly after `_read()` (after line 95, before `def _confirmed`):

```python
def observations(label_status: str | None = None) -> list[dict]:
    """Ledger rows, WHOLE, for callers that need to copy one.

    A confirmation is built by copying an observation and changing two fields
    (see the --simulate path below), and _confirmed() keys candidates on
    (tower_id, source, observed_at). A projection cannot be copied, and
    rebuilding one would overwrite measured predicted_priority/agreement
    values with whatever the model says today. So this returns every field.

    Read-only. Missing or unreadable ledger reads as empty, matching
    summarise()'s contract that absence is not an error.
    """
    data = _read()
    if data is None:
        return []
    rows, _malformed = data
    if label_status is None:
        return rows
    return [row for row in rows if row["label_status"] == label_status]
```

- [ ] **Step 4: Add the response schema**

Append to `src/backend/api/schemas.py`:

```python
class LedgerObservationOut(BaseModel):
    """One whole ledger row. Mirrors model/feedback.py's Observation exactly —
    the frontend copies these to build confirmations, so a narrower shape here
    would silently break the (tower_id, source, observed_at) key that decides
    whether a confirmation lands on the right observation."""

    observed_at: str
    tower_id: str
    source: str
    observation: dict[str, Any]
    predicted_priority: float
    predicted_decision: str
    agreement: str
    label_status: str
    simulated: bool
```

- [ ] **Step 5: Add the route**

Append to `src/backend/api/routes/model.py`:

```python
@router.get("/model/feedback/observations", response_model=list[LedgerObservationOut])
def feedback_observations(label_status: str | None = None) -> list[dict]:
    """Ledger rows, for joining field verdicts to the observations they can
    confirm. Read-only by design: label_status only ever flips through a human
    decision (model/feedback.py's "Evidence is never an automatic label"), and
    this route deliberately offers no way to perform that flip."""
    return feedback.observations(label_status=label_status)
```

Add the import at the top of the file, beside the existing `from adapter.ml_source import ...`:

```python
from api.schemas import LedgerObservationOut
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd src/backend && python -m pytest api/test_model_health.py -q`
Expected: PASS, all tests in the file green.

- [ ] **Step 7: Run the scoped backend gate**

Run: `cd src/backend && python -m pytest model/ api/ scheduler/ -q`
Expected: `211 passed` (210 today, plus the new one).

- [ ] **Step 8: Commit**

```bash
git add src/backend/model/feedback.py src/backend/api/schemas.py src/backend/api/routes/model.py src/backend/api/test_model_health.py
git commit -m "feat(model): expose ledger observations read-only

The frontend needs to know WHICH towers have an unlabeled observation, and
/model/health carries only aggregate counts. This returns whole rows, not a
projection: a confirmation is a copy of an observation with two fields
changed, and _confirmed() keys on (tower_id, source, observed_at), so a
partial row cannot produce one and a rebuilt row would overwrite measured
predicted_priority and agreement values with today's guesses.

Read-only on purpose. label_status flips only through a human decision -
'Evidence is never an automatic label' - and this route offers no flip.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Ticket data model

**Files:**
- Modify: `src/frontend/src/fixtures/tickets.ts:1-36` (the type block)
- Modify: `src/frontend/src/state/useTicketStore.ts` (interface ~line 44-100; `escalateWorkOrder` impl at line 272)

**Interfaces:**
- Consumes: `Tower` from `../api/types`.
- Produces: `ModelSnapshot`, `ModelFeedback` types; `Ticket.model_snapshot`, `Ticket.model_feedback`, `fix_notes[].attachment`; store action `setModelFeedback(ticket_id, feedback)`. Tasks 3, 4, 6, 7, 8 consume these.

There is no store-test harness in this repo — `src/lib/*.test.mjs` are the only frontend tests, and they cover pure functions only. This task's gate is therefore `tsc` plus the fact that every field added is optional, so nothing existing can break.

- [ ] **Step 1: Add the types to `fixtures/tickets.ts`**

Insert after `export type TicketResolution` (line 2), before `export interface Ticket`:

```ts
/**
 * What the model believed WHEN THE TICKET WAS RAISED.
 *
 * Without this, the Close Loop page would compare a verdict recorded weeks ago
 * against whatever the model says today and present the pair as a measurement.
 * Absent on manually-raised tickets, which no model prediction produced.
 */
export interface ModelSnapshot {
  risk: number;
  /** The blended rank `decision` is actually cut on (model/ensemble.py). */
  priority: number;
  decision: 'maintain' | 'watch' | 'ok';
  dominant_factor: string;
  captured_at: string;
}

/**
 * The technician's verdict ON THE MODEL — distinct from `resolution`, which is
 * the verdict on the tower.
 *
 * `resolution` answers "was there really a problem?" and is the training label.
 * `accurate` answers "did the model reason correctly?" and is the attribution
 * signal. A ticket can be `confirmed` (a real fault) while the model blamed the
 * wrong factor; collapsing the two would discard the second correction.
 */
export interface ModelFeedback {
  accurate: boolean | null;
  /** Set when `accurate` is false: it said flood, it was really power. */
  actual_factor?: string;
  comment?: string;
  author: string;
  created_at: string;
}

/**
 * A file a technician attached to a fix note. Held in the browser only — the
 * bytes never reach a server, and the JSONL export carries name/type/size, not
 * `dataUrl`.
 */
export interface FixAttachment {
  name: string;
  type: string;
  size: number;
  /** base64 data URL, capped at 2 MB by the picker in TicketDrawer. */
  dataUrl: string;
}
```

- [ ] **Step 2: Extend `Ticket`**

In `fixtures/tickets.ts`, replace line 16:

```ts
  fix_notes: { author: string; created_at: string; text: string; link?: string }[];
```

with:

```ts
  fix_notes: {
    author: string;
    created_at: string;
    text: string;
    /** Retained: seeded fixtures use it, and it predates real attachments. */
    link?: string;
    attachment?: FixAttachment;
  }[];
```

Then add these two fields to `Ticket`, immediately after `schedule_failed?: boolean;` (the last field, line 35):

```ts
  /** Set by escalateWorkOrder at raise time. Absent on manual tickets. */
  model_snapshot?: ModelSnapshot;
  /** Set by setModelFeedback from the ticket drawer. */
  model_feedback?: ModelFeedback;
```

- [ ] **Step 3: Capture the snapshot when the model raises a ticket**

In `state/useTicketStore.ts`, find the `const ticket: Ticket = {` literal inside `escalateWorkOrder` (the implementation begins at line 272). Add this field to the object literal, immediately before the closing `};`:

```ts
      // The model's belief AT RAISE TIME. Read here because this is the only
      // moment it is knowable: the tower is rescored on every weights change,
      // so asking later returns a different model's opinion and the Close Loop
      // page would compare it against a verdict it never produced.
      model_snapshot: {
        risk: tower.risk,
        priority: tower.priority,
        decision: tower.decision,
        dominant_factor: tower.dominant_factor,
        captured_at: new Date().toISOString(),
      },
```

- [ ] **Step 4: Add the `setModelFeedback` action**

In `state/useTicketStore.ts`, add to the `TicketStoreState` interface, directly after the `closeTicket` declaration (line 55):

```ts
  /**
   * Records the technician's assessment OF THE MODEL. Independent of
   * closeTicket: a ticket can be closed without it, and it can be set before
   * closing. Never gates the close — override.py's "never block" rule applies
   * to judgement too.
   */
  setModelFeedback: (ticket_id: string, feedback: ModelFeedback) => void;
```

And add the implementation directly after the `closeTicket` implementation's closing `},`:

```ts
  setModelFeedback: (ticket_id, feedback) =>
    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id ? { ...t, model_feedback: feedback } : t,
      ),
    })),
```

Update the import at the top of `useTicketStore.ts` (line 2) to pull the new type:

```ts
import { TICKETS, type Ticket, type TicketStatus, type TicketResolution, type ModelFeedback } from '../fixtures/tickets';
```

- [ ] **Step 5: Verify the gate**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exit 0, no output. Every added field is optional, so the 13 seeded fixtures and all existing consumers still compile.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/fixtures/tickets.ts src/frontend/src/state/useTicketStore.ts
git commit -m "feat(tickets): record the model's belief at raise time

resolution already answers 'was there really a problem?' - the model's own
training label, observed in the field. What was missing is what the model
BELIEVED when it raised the ticket. Without it the Close Loop page would
compare a weeks-old verdict against whatever the model says today and
present the pair as a measurement.

model_feedback is deliberately separate from resolution. One answers
'was there a problem', the other 'did the model reason correctly'. A ticket
can be confirmed while the model blamed the wrong factor, and collapsing
them would throw that correction away.

Every field optional, so all 13 seeded fixtures still compile untouched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Corpus join

**Files:**
- Create: `src/frontend/src/lib/feedbackCorpus.ts`
- Test: `src/frontend/src/lib/feedbackCorpus.test.mjs`
- Modify: `src/frontend/src/api/types.ts` (append after `LedgerSummary`, which ends at line 671)

**Interfaces:**
- Consumes: `Ticket`, `ModelSnapshot` from `../fixtures/tickets`.
- Produces: `LedgerObservation` (in `api/types.ts`); `TowerBelief`, `CorpusRow`, `toCorpus(tickets, towers, observations)` (in `lib/feedbackCorpus.ts`). Tasks 4, 5, 7, 8 consume these.

`LedgerObservation` is a **wire shape**, so it is declared once in `api/types.ts` beside `LedgerSummary` and imported type-only elsewhere. Declaring it in both places — which an earlier draft of this plan did — gives two identical interfaces that can silently drift apart while both still compile. A type-only import is erased by the strip-types loader, so the test run never touches `api/types.ts` at runtime.

`toCorpus` takes `TowerBelief[]` rather than `Tower[]` — a structural subset of the five fields it reads. `Tower` satisfies it, so the page passes its live towers unchanged, while a test constructs one in five lines instead of thirty.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/lib/feedbackCorpus.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { toCorpus } from './feedbackCorpus.ts';

function ticket(over = {}) {
  return {
    ticket_id: 'T-1',
    tower_id: 'MY_1',
    title: 't',
    description: 'd',
    issue_type: 'Structural',
    reporter: 'field-tech-01',
    status: 'closed',
    assignee_crew_id: null,
    created_at: '2026-09-01T00:00:00Z',
    target_sla: null,
    fix_notes: [],
    resolution: 'confirmed',
    source: 'manual',
    ...over,
  };
}

function tower(over = {}) {
  return {
    tower_id: 'MY_1',
    risk: 0.8,
    priority: 0.82,
    decision: 'maintain',
    dominant_factor: 'flood',
    ...over,
  };
}

function observation(over = {}) {
  return {
    observed_at: '2026-08-20T00:00:00+00:00',
    tower_id: 'MY_1',
    source: 's2_change',
    observation: { evi_delta_per_year: 0.1 },
    predicted_priority: 0.9,
    predicted_decision: 'maintain',
    agreement: 'agree',
    label_status: 'unlabeled',
    simulated: false,
    ...over,
  };
}

test('confirmed is label 1, false_positive is label 0', () => {
  const rows = toCorpus(
    [ticket({ ticket_id: 'T-1', resolution: 'confirmed' }),
     ticket({ ticket_id: 'T-2', resolution: 'false_positive' })],
    [tower()],
    [],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.ticket_id === 'T-1').needed_corrective_maintenance, 1);
  assert.equal(rows.find((r) => r.ticket_id === 'T-2').needed_corrective_maintenance, 0);
});

test('only closed tickets carrying a verdict enter the corpus', () => {
  const rows = toCorpus(
    [ticket({ ticket_id: 'T-open', status: 'open', resolution: null }),
     ticket({ ticket_id: 'T-active', status: 'active', resolution: null }),
     ticket({ ticket_id: 'T-resolved', status: 'resolved', resolution: null }),
     ticket({ ticket_id: 'T-closed-no-verdict', status: 'closed', resolution: null }),
     ticket({ ticket_id: 'T-good', status: 'closed', resolution: 'confirmed' })],
    [tower()],
    [],
  );
  assert.deepEqual(rows.map((r) => r.ticket_id), ['T-good']);
});

test('a snapshot gives belief_at raise; its absence falls back to the current score', () => {
  const snap = {
    risk: 0.91, priority: 0.93, decision: 'maintain',
    dominant_factor: 'power', captured_at: '2026-08-25T00:00:00Z',
  };
  const [withSnap] = toCorpus([ticket({ model_snapshot: snap })], [tower()], []);
  assert.equal(withSnap.belief_at, 'raise');
  assert.equal(withSnap.belief.priority, 0.93);
  assert.equal(withSnap.belief.dominant_factor, 'power');

  const [without] = toCorpus([ticket()], [tower()], []);
  assert.equal(without.belief_at, 'current');
  assert.equal(without.belief.priority, 0.82);
});

test('a tower the app has never scored yields no belief at all', () => {
  const [row] = toCorpus([ticket({ tower_id: 'MY_GHOST' })], [tower()], []);
  assert.equal(row.belief, null);
  assert.equal(row.belief_at, 'current');
  assert.equal(row.verdict_agreement, 'indeterminate');
});

test('verdict_agreement reads maintain as dispatch and watch/ok as do-not', () => {
  const at = (decision, resolution) =>
    toCorpus(
      [ticket({ resolution, model_snapshot: {
        risk: 0.5, priority: 0.5, decision, dominant_factor: 'flood',
        captured_at: '2026-08-25T00:00:00Z' } })],
      [tower()],
      [],
    )[0].verdict_agreement;

  assert.equal(at('maintain', 'confirmed'), 'agree');        // caught it
  assert.equal(at('maintain', 'false_positive'), 'disagree'); // false alarm
  assert.equal(at('watch', 'confirmed'), 'disagree');         // missed it
  assert.equal(at('ok', 'confirmed'), 'disagree');            // missed it
  assert.equal(at('watch', 'false_positive'), 'agree');       // correctly quiet
  assert.equal(at('ok', 'false_positive'), 'agree');          // correctly quiet
});

test('an unlabeled observation for the tower makes the row attachable', () => {
  const [row] = toCorpus([ticket()], [tower()], [observation()]);
  assert.equal(row.attachable, true);
  assert.equal(row.observation.source, 's2_change');
  assert.equal(row.observation.observed_at, '2026-08-20T00:00:00+00:00');
});

test('no observation, or an already-confirmed one, leaves the row unattachable', () => {
  const [none] = toCorpus([ticket()], [tower()], []);
  assert.equal(none.attachable, false);
  assert.equal(none.observation, null);

  const [done] = toCorpus([ticket()], [tower()], [observation({ label_status: 'confirmed' })]);
  assert.equal(done.attachable, false);
  assert.equal(done.observation, null);

  const [other] = toCorpus([ticket()], [tower()], [observation({ tower_id: 'MY_OTHER' })]);
  assert.equal(other.attachable, false);
});

test('evidence counts separate notes from attachments', () => {
  const [row] = toCorpus(
    [ticket({ fix_notes: [
      { author: 'a', created_at: 'x', text: 'one' },
      { author: 'a', created_at: 'x', text: 'two',
        attachment: { name: 'p.jpg', type: 'image/jpeg', size: 10, dataUrl: 'data:,' } },
    ] })],
    [tower()],
    [],
  );
  assert.equal(row.evidence_notes, 2);
  assert.equal(row.evidence_attachments, 1);
});

test('model feedback surfaces as factor_correct and actual_factor', () => {
  const [row] = toCorpus(
    [ticket({ model_feedback: {
      accurate: false, actual_factor: 'power', author: 'a',
      created_at: '2026-09-02T00:00:00Z' } })],
    [tower()],
    [],
  );
  assert.equal(row.factor_correct, false);
  assert.equal(row.actual_factor, 'power');

  const [bare] = toCorpus([ticket()], [tower()], []);
  assert.equal(bare.factor_correct, null);
  assert.equal(bare.actual_factor, null);
});

test('an empty ticket list yields an empty corpus rather than throwing', () => {
  assert.deepEqual(toCorpus([], [], []), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/feedbackCorpus.test.mjs`
Expected: FAIL — `Cannot find module` for `./feedbackCorpus.ts`.

- [ ] **Step 3: Declare the wire shape in `api/types.ts`**

Append to `src/frontend/src/api/types.ts`, directly after the `LedgerSummary` interface (line 671):

```ts
/**
 * One whole row of the observation ledger, from GET /model/feedback/observations.
 *
 * Whole, not a projection: the Close Loop export builds a confirmation by
 * copying one of these and changing two fields, and model/feedback.py's
 * _confirmed() keys candidates on (tower_id, source, observed_at).
 *
 * `agreement` here is model-vs-SATELLITE. The Close Loop page's own
 * `verdict_agreement` is model-vs-TECHNICIAN. Different comparisons, and
 * reading them as one number is the failure that page exists to prevent.
 */
export interface LedgerObservation {
  observed_at: string;
  tower_id: string;
  source: string;
  observation: Record<string, unknown>;
  predicted_priority: number;
  predicted_decision: string;
  agreement: string;
  label_status: string;
  simulated: boolean;
}
```

- [ ] **Step 4: Write the implementation**

Create `src/frontend/src/lib/feedbackCorpus.ts`:

```ts
/**
 * Closed tickets as training labels.
 *
 * model/maintenance_need.py's target is `needed_corrective_maintenance` — "a
 * work order was raised" — and it is trained on SYNTHETIC labels today. A
 * technician closing a ticket `confirmed` or `false_positive` observes that
 * exact quantity in the field. This module performs the join that turns the
 * one into the other.
 *
 * Pure. No React, no stores, no fetch — every input arrives as an argument, so
 * the whole thing is testable under `node --test`.
 */
import type { ModelSnapshot, Ticket } from '../fixtures/tickets';
import type { LedgerObservation } from '../api/types';

export type { LedgerObservation };

/**
 * The five fields the corpus reads off a tower. `Tower` satisfies this
 * structurally, so callers pass their live towers unchanged — but a test can
 * build one in five lines instead of thirty.
 */
export interface TowerBelief {
  tower_id: string;
  risk: number;
  priority: number;
  decision: 'maintain' | 'watch' | 'ok';
  dominant_factor: string;
}

export type Verdict = 'confirmed' | 'false_positive';
export type Agreement = 'agree' | 'disagree' | 'indeterminate';

export interface CorpusRow {
  ticket_id: string;
  tower_id: string;
  /** The ledger's own field name, deliberately. 1 = confirmed, 0 = false positive. */
  needed_corrective_maintenance: 0 | 1;
  verdict: Verdict;
  raised_by: Ticket['source'];
  belief: ModelSnapshot | null;
  /** 'raise' when a snapshot existed; 'current' when it fell back to today. */
  belief_at: 'raise' | 'current';
  /**
   * Model-vs-TECHNICIAN. Not to be confused with LedgerObservation.agreement,
   * which is model-vs-SATELLITE. Same three words, different comparison —
   * reading them as one number is the failure this feature exists to prevent.
   */
  verdict_agreement: Agreement;
  factor_correct: boolean | null;
  actual_factor: string | null;
  evidence_notes: number;
  evidence_attachments: number;
  /** The unlabeled ledger row this verdict could confirm, WHOLE. */
  observation: LedgerObservation | null;
  attachable: boolean;
  closed_at: string;
}

/**
 * `maintain` is the dispatch band; `watch` and `ok` are both "do not dispatch".
 * So agreement is dispatch-decision against field outcome. `indeterminate` is
 * reserved for a tower with no belief at all — never for a band we do hold,
 * which would quietly drop real disagreements out of the count.
 */
function agreementOf(decision: TowerBelief['decision'] | null, verdict: Verdict): Agreement {
  if (decision === null) return 'indeterminate';
  const dispatched = decision === 'maintain';
  const neededWork = verdict === 'confirmed';
  return dispatched === neededWork ? 'agree' : 'disagree';
}

export function toCorpus(
  tickets: Ticket[],
  towers: TowerBelief[],
  observations: LedgerObservation[],
): CorpusRow[] {
  const towerById = new Map(towers.map((t) => [t.tower_id, t]));

  // Only unlabeled rows are confirmable: a confirmed one is already spent, and
  // _confirmed() counts a (tower, source, window) once however many times it
  // is appended.
  const openByTower = new Map<string, LedgerObservation>();
  for (const obs of observations) {
    if (obs.label_status === 'unlabeled' && !openByTower.has(obs.tower_id)) {
      openByTower.set(obs.tower_id, obs);
    }
  }

  const rows: CorpusRow[] = [];
  for (const ticket of tickets) {
    if (ticket.status !== 'closed' || ticket.resolution === null) continue;
    const verdict = ticket.resolution as Verdict;

    const snapshot = ticket.model_snapshot ?? null;
    const current = towerById.get(ticket.tower_id);
    let belief: ModelSnapshot | null = snapshot;
    if (belief === null && current) {
      belief = {
        risk: current.risk,
        priority: current.priority,
        decision: current.decision,
        dominant_factor: current.dominant_factor,
        captured_at: '',
      };
    }

    const observation = openByTower.get(ticket.tower_id) ?? null;
    const feedback = ticket.model_feedback;

    rows.push({
      ticket_id: ticket.ticket_id,
      tower_id: ticket.tower_id,
      needed_corrective_maintenance: verdict === 'confirmed' ? 1 : 0,
      verdict,
      raised_by: ticket.source,
      belief,
      belief_at: snapshot ? 'raise' : 'current',
      verdict_agreement: agreementOf(belief ? belief.decision : null, verdict),
      factor_correct: feedback ? feedback.accurate : null,
      actual_factor: feedback?.actual_factor ?? null,
      evidence_notes: ticket.fix_notes.length,
      evidence_attachments: ticket.fix_notes.filter((n) => n.attachment).length,
      observation,
      attachable: observation !== null,
      closed_at: ticket.fix_notes.at(-1)?.created_at ?? ticket.created_at,
    });
  }
  return rows;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/feedbackCorpus.test.mjs`
Expected: `# pass 10`, `# fail 0`.

- [ ] **Step 6: Verify the typecheck gate**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/lib/feedbackCorpus.ts src/frontend/src/lib/feedbackCorpus.test.mjs src/frontend/src/api/types.ts
git commit -m "feat(loop): join closed tickets to the observations they can confirm

maintenance_need.py's target is needed_corrective_maintenance - 'a work
order was raised' - trained on synthetic labels. A technician closing a
ticket confirmed/false_positive observes that exact quantity in the field.
This is the join.

Two decisions worth stating. verdict_agreement is NOT called agreement: the
ledger already has that field and it measures model-vs-SATELLITE, while this
is model-vs-TECHNICIAN. Same three words, different comparison. And
indeterminate is reserved for a tower with no belief at all, never for a
band we do hold - watch and ok are both 'do not dispatch', so calling them
indeterminate would drop real disagreements out of the count.

belief_at records whether the belief came from a raise-time snapshot or
today's score, so the page can never present the second as the first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Verdict counts and the JSONL export

**Files:**
- Modify: `src/frontend/src/lib/feedbackCorpus.ts` (append)
- Modify: `src/frontend/src/lib/feedbackCorpus.test.mjs` (append)

**Interfaces:**
- Consumes: `CorpusRow`, `LedgerObservation` from Task 3.
- Produces: `VerdictCounts`, `verdictCounts(rows)`, `ConfirmationRecord`, `toObservationRecords(rows)`, `toJsonl(records)`. Tasks 7 and 8 consume these.

This is the correctness-critical task. A confirmation that does not reproduce `(tower_id, source, observed_at)` byte-for-byte appends an orphan row and leaves the original `unlabeled` forever, with nothing anywhere reporting the failure.

- [ ] **Step 1: Write the failing test**

Append to `src/frontend/src/lib/feedbackCorpus.test.mjs`:

```js
import { verdictCounts, toObservationRecords, toJsonl } from './feedbackCorpus.ts';

test('the matrix counts only raise-time beliefs, and reports what it excluded', () => {
  const snap = (decision) => ({
    risk: 0.5, priority: 0.5, decision, dominant_factor: 'flood',
    captured_at: '2026-08-25T00:00:00Z',
  });
  const rows = toCorpus(
    [ticket({ ticket_id: 'A', resolution: 'confirmed', model_snapshot: snap('maintain') }),
     ticket({ ticket_id: 'B', resolution: 'false_positive', model_snapshot: snap('maintain') }),
     ticket({ ticket_id: 'C', resolution: 'confirmed', model_snapshot: snap('ok') }),
     ticket({ ticket_id: 'D', resolution: 'false_positive', model_snapshot: snap('watch') }),
     ticket({ ticket_id: 'E', resolution: 'confirmed' })], // no snapshot -> excluded
    [tower()],
    [],
  );
  const counts = verdictCounts(rows);
  assert.equal(counts.caught, 1);
  assert.equal(counts.falseAlarm, 1);
  assert.equal(counts.missed, 1);
  assert.equal(counts.quiet, 1);
  assert.equal(counts.n, 4);
  assert.equal(counts.excluded, 1);
});

test('the export reproduces the observation key triple byte-identically', () => {
  // THE test. _confirmed() keys on (tower_id, source, observed_at); a drifted
  // triple appends an orphan row and the original stays unlabeled forever,
  // silently.
  const obs = observation();
  const rows = toCorpus([ticket({ resolution: 'confirmed' })], [tower()], [obs]);
  const [record] = toObservationRecords(rows);

  assert.equal(record.tower_id, obs.tower_id);
  assert.equal(record.source, obs.source);
  assert.equal(record.observed_at, obs.observed_at);
});

test('measured fields are carried, never recomputed from the current tower', () => {
  const obs = observation({ predicted_priority: 0.9, predicted_decision: 'maintain', agreement: 'agree' });
  // The tower's priority is 0.82 and differs on purpose.
  const rows = toCorpus([ticket()], [tower({ priority: 0.82 })], [obs]);
  const [record] = toObservationRecords(rows);

  assert.equal(record.predicted_priority, 0.9);
  assert.equal(record.predicted_decision, 'maintain');
  assert.equal(record.agreement, 'agree');
});

test('every exported record is a real, confirmed, non-simulated closure', () => {
  const rows = toCorpus([ticket({ resolution: 'false_positive' })], [tower()], [observation()]);
  const [record] = toObservationRecords(rows);

  assert.equal(record.label_status, 'confirmed');
  assert.equal(record.simulated, false);
  assert.equal(record.observation.needed_corrective_maintenance, 0);
  // Original observation payload survives alongside the label.
  assert.equal(record.observation.evi_delta_per_year, 0.1);
  // Provenance, inside the free-form dict so no validated field is touched.
  assert.equal(record.observation.ticket_id, 'T-1');
});

test('unattachable rows are omitted entirely rather than given a fake source', () => {
  const rows = toCorpus(
    [ticket({ ticket_id: 'has-obs' }), ticket({ ticket_id: 'no-obs', tower_id: 'MY_ALONE' })],
    [tower(), tower({ tower_id: 'MY_ALONE' })],
    [observation()],
  );
  assert.equal(rows.length, 2);
  const records = toObservationRecords(rows);
  assert.equal(records.length, 1);
  assert.equal(records[0].observation.ticket_id, 'has-obs');
});

test('jsonl is one compact json object per line, newline-terminated', () => {
  const rows = toCorpus([ticket()], [tower()], [observation()]);
  const text = toJsonl(toObservationRecords(rows));
  assert.ok(text.endsWith('\n'));
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).tower_id, 'MY_1');
  assert.ok(!lines[0].includes('\n'));
});

test('an empty corpus exports nothing and counts zero without throwing', () => {
  assert.deepEqual(toObservationRecords([]), []);
  assert.equal(toJsonl([]), '');
  const counts = verdictCounts([]);
  assert.equal(counts.n, 0);
  assert.equal(counts.caught, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/feedbackCorpus.test.mjs`
Expected: FAIL — `SyntaxError` / `does not provide an export named 'verdictCounts'`.

- [ ] **Step 3: Write the implementation**

Append to `src/frontend/src/lib/feedbackCorpus.ts`:

```ts
export interface VerdictCounts {
  /** maintain + confirmed — the model dispatched and work was needed. */
  caught: number;
  /** maintain + false_positive — it dispatched and nothing was wrong. */
  falseAlarm: number;
  /** watch|ok + confirmed — it did not dispatch and work was needed. */
  missed: number;
  /** watch|ok + false_positive — it did not dispatch and nothing was wrong. */
  quiet: number;
  /** Rows actually counted. Small, and not a random sample — never an accuracy. */
  n: number;
  /** Rows dropped for having no raise-time belief. Reported, not hidden. */
  excluded: number;
}

/**
 * The 2x2, built ONLY from raise-time beliefs.
 *
 * A row whose belief came from today's score is excluded rather than counted:
 * including it would compare a verdict recorded weeks ago against a model that
 * has been rescored since, and present the pair as a measurement. `excluded` is
 * returned so the page can say how many were left out.
 */
export function verdictCounts(rows: CorpusRow[]): VerdictCounts {
  const counts: VerdictCounts = {
    caught: 0, falseAlarm: 0, missed: 0, quiet: 0, n: 0, excluded: 0,
  };
  for (const row of rows) {
    if (row.belief_at !== 'raise' || row.belief === null) {
      counts.excluded += 1;
      continue;
    }
    const dispatched = row.belief.decision === 'maintain';
    const neededWork = row.needed_corrective_maintenance === 1;
    if (dispatched && neededWork) counts.caught += 1;
    else if (dispatched && !neededWork) counts.falseAlarm += 1;
    else if (!dispatched && neededWork) counts.missed += 1;
    else counts.quiet += 1;
    counts.n += 1;
  }
  return counts;
}

/** One line of the export: an Observation with a label, ready to append. */
export interface ConfirmationRecord extends LedgerObservation {
  label_status: 'confirmed';
  simulated: false;
}

/**
 * Confirmations, in model/feedback.py's exact schema.
 *
 * A confirmation is a COPY of the original observation with two fields
 * changed — that is how feedback.py:204 builds one — because _confirmed()
 * keys candidates on (tower_id, source, observed_at). Any record that does
 * not reproduce that triple exactly appends an unrelated row and leaves the
 * original unlabeled forever, and nothing anywhere reports the failure.
 *
 * So predicted_priority, predicted_decision, agreement, source and observed_at
 * are carried over untouched. They were measured when the observation was
 * made; re-deriving them from today's model would overwrite a measurement with
 * a guess.
 *
 * Rows with no observation are omitted. `source` is validated against three
 * satellite values by Observation.__post_init__, and there is no legal value
 * to invent for a verdict that has no satellite row behind it.
 */
export function toObservationRecords(rows: CorpusRow[]): ConfirmationRecord[] {
  const records: ConfirmationRecord[] = [];
  for (const row of rows) {
    if (row.observation === null) continue;
    records.push({
      ...row.observation,
      label_status: 'confirmed',
      simulated: false,
      // Ticket provenance lives INSIDE the free-form observation dict, so no
      // field Observation validates is touched.
      observation: {
        ...row.observation.observation,
        needed_corrective_maintenance: row.needed_corrective_maintenance,
        ticket_id: row.ticket_id,
        closed_at: row.closed_at,
      },
    });
  }
  return records;
}

/** JSON Lines: one compact object per line, exactly as the ledger stores them. */
export function toJsonl(records: ConfirmationRecord[]): string {
  if (records.length === 0) return '';
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/feedbackCorpus.test.mjs`
Expected: `# pass 17`, `# fail 0`.

- [ ] **Step 5: Verify the typecheck gate**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/lib/feedbackCorpus.ts src/frontend/src/lib/feedbackCorpus.test.mjs
git commit -m "feat(loop): export confirmations in the ledger's exact schema

A confirmation is a COPY of the original observation with two fields
changed - that is how feedback.py:204 builds one - because _confirmed()
keys candidates on (tower_id, source, observed_at). A record that does not
reproduce that triple appends an unrelated row, leaves the original
unlabeled forever, and nothing anywhere reports it. That is the case the
export test asserts directly.

predicted_priority, predicted_decision and agreement are carried over, never
recomputed: they were measured when the observation was made, and rebuilding
them from today's model would overwrite a measurement with a guess.

Rows with no observation are omitted rather than given an invented source -
Observation.__post_init__ validates source against three satellite values
and there is no legal one for a verdict with no satellite row behind it.

verdictCounts() excludes rows whose belief came from today's score and
reports the exclusion count, so the 2x2 can never silently compare a
weeks-old verdict against a rescored model.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Wire the endpoint to the frontend

**Files:**
- Modify: `src/frontend/src/api/client.ts` (append after `getModelHealth`, line 88-90)
- Modify: `src/frontend/src/api/queries.ts` (append after `useModelHealthQuery`, line 329-335)

**Interfaces:**
- Consumes: the route from Task 1; `LedgerObservation` from `api/types.ts`, declared in Task 3.
- Produces: `useLedgerObservationsQuery()` returning `{ data: LedgerObservation[] }`. Tasks 7 and 8 consume it.

`LedgerObservation` already exists — Task 3 declared it. Do not redeclare it here.

- [ ] **Step 1: Add the client method**

In `src/frontend/src/api/client.ts`, add `LedgerObservation` to the type import block at the top (alphabetically, after `LayerTiles`), then append after `getModelHealth`:

```ts
export function getLedgerObservations(labelStatus?: string): Promise<LedgerObservation[]> {
  const query = labelStatus ? `?label_status=${encodeURIComponent(labelStatus)}` : '';
  return request<LedgerObservation[]>(`/model/feedback/observations${query}`);
}
```

- [ ] **Step 2: Add the query hook**

In `src/frontend/src/api/queries.ts`, add `LedgerObservation` to the type imports, then append after `useModelHealthQuery`:

```ts
// Unlabeled rows only: a confirmed observation is already spent, and offering
// it would invite a second confirmation that _confirmed() would dedupe away
// anyway. Empty array is the honest offline fallback here — unlike the health
// report, "no observations" is a real and common state, not a missing
// measurement, so an empty list claims nothing that is not true.
export function useLedgerObservationsQuery() {
  return useQuery<LedgerObservation[]>({
    queryKey: ['ledger-observations', 'unlabeled'],
    queryFn: () => withOfflineFallback<LedgerObservation[]>(
      () => client.getLedgerObservations('unlabeled'),
      [],
    ),
    staleTime: 60 * 1000,
  });
}
```

- [ ] **Step 3: Verify the gate**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: `tsc` exits 0; build succeeds with only the pre-existing chunk-size warning.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/api/client.ts src/frontend/src/api/queries.ts
git commit -m "feat(api): read unlabeled ledger observations from the frontend

Unlabeled only - a confirmed observation is already spent, and _confirmed()
would dedupe a second confirmation away regardless.

Empty array is the honest offline fallback, which is a different judgement
from useModelHealthQuery's null: 'no observations yet' is a real and common
state rather than a missing measurement, so [] claims nothing untrue.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Model feedback and real attachments in the ticket drawer

**Files:**
- Modify: `src/frontend/src/components/tickets/TicketDrawer.tsx` — fix-note render (~line 665-675), the note form (~line 686-695), and the close section (line 731)

**Interfaces:**
- Consumes: `ModelFeedback`, `FixAttachment` (Task 2); `setModelFeedback`, `addFixNote`, `submitFix` from the store.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the attachment reader and state**

Near the other `useState` declarations in the `TicketDrawer` body (alongside `noteText` / `noteLink`), add:

```tsx
  const setModelFeedback = useTicketStore((s) => s.setModelFeedback);
  const [noteFile, setNoteFile] = useState<FixAttachment | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fbAccurate, setFbAccurate] = useState<boolean | null>(ticket.model_feedback?.accurate ?? null);
  const [fbFactor, setFbFactor] = useState(ticket.model_feedback?.actual_factor ?? '');
  const [fbComment, setFbComment] = useState(ticket.model_feedback?.comment ?? '');

  // 2 MB, because the whole file is held as a base64 data URL in memory and
  // this store has no persistence layer to spill to. Rejected loudly rather
  // than silently truncated — a technician who thinks they attached a photo
  // and did not is worse off than one who was told no.
  const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

  function readAttachment(file: File) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setFileError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 2 MB.`);
      setNoteFile(undefined);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFileError(null);
      setNoteFile({
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: String(reader.result),
      });
    };
    reader.onerror = () => setFileError(`Could not read ${file.name}.`);
    reader.readAsDataURL(file);
  }
```

Add `FixAttachment` to the type import from `../../fixtures/tickets` at the top of the file.

- [ ] **Step 2: Render attachments on existing notes**

In the `ticket.fix_notes.map(...)` block, directly after the existing `{note.link && (...)}` clause, add:

```tsx
                {note.attachment && (
                  <div className="mt-2">
                    {note.attachment.type.startsWith('image/') ? (
                      <img
                        src={note.attachment.dataUrl}
                        alt={note.attachment.name}
                        className="max-h-32 rounded border border-overlay/15"
                      />
                    ) : null}
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-dim">
                      <AttachmentIcon />
                      <span>{note.attachment.name}</span>
                      <span className="tnum">({(note.attachment.size / 1024).toFixed(0)} KB)</span>
                    </div>
                  </div>
                )}
```

- [ ] **Step 3: Add the file picker to the note form**

Directly after the `noteLink` text input, add:

```tsx
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) readAttachment(file);
                  }}
                  className="w-full text-[11px] text-dim file:mr-2 file:rounded file:border file:border-overlay/15 file:bg-ink-800 file:px-2 file:py-1 file:text-[11px] file:text-fg"
                />
                {noteFile && (
                  <button
                    type="button"
                    onClick={() => { setNoteFile(undefined); setFileError(null); }}
                    className="shrink-0 text-[11px] text-dim underline hover:text-fg"
                  >
                    clear
                  </button>
                )}
              </div>
              {fileError && <p className="text-[11px] text-alert">{fileError}</p>}
              {noteFile && !fileError && (
                <p className="text-[11px] text-dim">
                  Attached {noteFile.name} — stays in this browser, never uploaded.
                </p>
              )}
```

- [ ] **Step 4: Pass the attachment through both submit handlers**

In the `Add Note` button's `onClick`, change the `addFixNote` call to:

```tsx
                    addFixNote(ticket.ticket_id, {
                      author: crew?.name ?? ticket.reporter,
                      text: noteText.trim(),
                      link: noteLink.trim() || undefined,
                      attachment: noteFile,
                    });
                    setNoteText('');
                    setNoteLink('');
                    setNoteFile(undefined);
```

And in the `Submit Fix → Resolved` button's `onClick`, change the `submitFix` call identically:

```tsx
                    submitFix(ticket.ticket_id, {
                      author: crew?.name ?? ticket.reporter,
                      text: noteText.trim(),
                      link: noteLink.trim() || undefined,
                      attachment: noteFile,
                    });
                    setNoteText('');
                    setNoteLink('');
                    setNoteFile(undefined);
```

Both store actions accept the note object and spread it, so no store change is needed — but their TypeScript signatures must widen. In `state/useTicketStore.ts`, change the `addFixNote` and `submitFix` declarations (lines 49-50) to:

```ts
  addFixNote: (ticket_id: string, note: { author: string; text: string; link?: string; attachment?: FixAttachment }) => void;
  submitFix: (ticket_id: string, note: { author: string; text: string; link?: string; attachment?: FixAttachment }) => void;
```

and add `type FixAttachment` to that file's import from `../fixtures/tickets`.

- [ ] **Step 5: Add the model-feedback section**

In `TicketDrawer.tsx`, directly BEFORE the `<div className="mt-6 border-t border-overlay/10 pt-4">` that contains `Close Ticket (admin/reporter only)` (line 731's parent), insert:

```tsx
        <div className="mt-6 border-t border-overlay/10 pt-4">
          <div className="eyebrow mb-2">Feedback to the model</div>
          {/* Separate from the close verdict on purpose. `resolution` answers
              "was there really a problem" — the model's own training label.
              This answers "did the model reason correctly". A ticket can be
              confirmed while the model blamed the wrong factor, and that is a
              different correction. */}
          <p className="mb-2 text-[11px] text-dim">
            Did the model read this site correctly? Recorded with the closure, and
            never required to close it.
          </p>
          <div className="mb-2 flex gap-2">
            {([['Accurate', true], ['Wrong', false]] as const).map(([label, value]) => (
              <button
                key={label}
                type="button"
                onClick={() => setFbAccurate(fbAccurate === value ? null : value)}
                className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                  fbAccurate === value
                    ? 'border-accent/60 bg-accent/10 text-fg'
                    : 'border-overlay/15 text-dim hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {fbAccurate === false && (
            <input
              type="text"
              value={fbFactor}
              onChange={(e) => setFbFactor(e.target.value)}
              placeholder="What was the real cause? e.g. power"
              className="mb-2 w-full rounded-lg border border-overlay/15 bg-ink-800 px-3 py-1.5 text-[11px] text-fg placeholder:text-dim focus:border-accent focus:outline-none"
            />
          )}
          <textarea
            value={fbComment}
            onChange={(e) => setFbComment(e.target.value)}
            rows={2}
            placeholder="Anything the model should learn from this site (optional)"
            className="w-full resize-none rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 text-xs text-fg placeholder:text-dim focus:border-accent focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-dim">
              {ticket.model_feedback
                ? `Recorded ${formatDate(ticket.model_feedback.created_at)}`
                : 'Not recorded yet'}
            </span>
            <Button
              tone="ghost"
              disabled={fbAccurate === null && fbComment.trim().length === 0}
              onClick={() =>
                setModelFeedback(ticket.ticket_id, {
                  accurate: fbAccurate,
                  actual_factor: fbFactor.trim() || undefined,
                  comment: fbComment.trim() || undefined,
                  author: crew?.name ?? ticket.reporter,
                  created_at: new Date().toISOString(),
                })
              }
            >
              Save feedback
            </Button>
          </div>
        </div>
```

- [ ] **Step 6: Verify the gate**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: `tsc` exits 0; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/components/tickets/TicketDrawer.tsx src/frontend/src/state/useTicketStore.ts
git commit -m "feat(tickets): real attachments and feedback to the model

The attachment field was a text box labelled '(mock, not a real upload)'.
It is now a file picker with a thumbnail. The bytes stay in the browser as
a data URL - there is no upload and the drawer says so - capped at 2 MB and
rejected loudly, because a technician who thinks they attached a photo and
did not is worse off than one who was told no.

The feedback section is deliberately separate from the close verdict.
resolution answers 'was there really a problem' and is the model's training
label; this answers 'did the model reason correctly'. A ticket can be
confirmed while the model blamed the wrong factor.

It never gates the close. override.py's 'never block an override' rule
applies to judgement too - worst case is recorded as information, never as
a refusal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: The Close Loop page — diagram and matrix

**Files:**
- Create: `src/frontend/src/components/closeloop/LoopDiagram.tsx`
- Create: `src/frontend/src/components/closeloop/VerdictMatrix.tsx`
- Create: `src/frontend/src/components/closeloop/index.ts`
- Create: `src/frontend/src/pages/CloseLoop.tsx`
- Modify: `src/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `toCorpus`, `verdictCounts`, `CorpusRow`, `VerdictCounts` (Tasks 3-4); `useLedgerObservationsQuery` (Task 5); `useTicketStore`, `useTowersQuery`, `useModelHealthQuery`.
- Produces: `/loop` route; the page shell Task 8 appends two more panels to.

- [ ] **Step 1: Create `LoopDiagram.tsx`**

```tsx
import { Panel } from '../ui/Panel';

interface Stage {
  label: string;
  value: string;
  hint: string;
}

/**
 * The loop, with live counts rather than a drawn graphic. Every number comes
 * from real state, so the strip moves when a ticket is closed — which is the
 * only way a diagram of a feedback loop is worth showing at all.
 */
export function LoopDiagram({ stages }: { stages: Stage[] }) {
  return (
    <Panel title="The loop">
      <ol className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(9rem,1fr))]">
        {stages.map((stage, i) => (
          <li
            key={stage.label}
            className={`min-w-0 rounded-lg border p-3 ${
              i === stages.length - 1
                ? 'border-accent/30 bg-accent/[0.07]'
                : 'border-overlay/10 bg-overlay/[0.02]'
            }`}
          >
            <div className="flex items-baseline gap-2">
              <span className="tnum text-eyebrow font-semibold text-dim">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0 truncate font-mono text-micro text-muted">{stage.label}</span>
            </div>
            <div className="mt-2 font-display text-title font-semibold leading-none tnum text-fg">
              {stage.value}
            </div>
            <div className="mt-1 text-micro leading-snug text-dim">{stage.hint}</div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
```

- [ ] **Step 2: Create `VerdictMatrix.tsx`**

```tsx
import { Panel } from '../ui/Panel';
import type { VerdictCounts } from '../../lib/feedbackCorpus';

/**
 * The 2x2 of dispatch decision against field outcome.
 *
 * This is NOT an accuracy measurement and the panel says so in those words.
 * ModelHealth renders a real, out-of-fold confusion matrix; two matrices in one
 * app, one measured and one not, have to be distinguishable on sight or the
 * unmeasured one borrows the other's authority.
 */
export function VerdictMatrix({ counts }: { counts: VerdictCounts }) {
  const cell = (label: string, value: number, good: boolean) => (
    <div
      className={`rounded-lg border p-3 ${
        good ? 'border-ok/25 bg-ok/[0.06]' : 'border-alert/25 bg-alert/[0.06]'
      }`}
    >
      <div className="font-display text-title font-semibold leading-none tnum text-fg">{value}</div>
      <div className="eyebrow mt-1.5">{label}</div>
    </div>
  );

  return (
    <Panel title="Field verdicts against the dispatch decision" spine="var(--color-watch)">
      <div className="grid grid-cols-2 gap-2.5">
        {cell('Dispatched · work needed', counts.caught, true)}
        {cell('Dispatched · nothing wrong', counts.falseAlarm, false)}
        {cell('Not dispatched · work needed', counts.missed, false)}
        {cell('Not dispatched · nothing wrong', counts.quiet, true)}
      </div>
      <p className="mt-3 text-ui leading-relaxed text-muted">
        <span className="tnum font-semibold text-fg">n = {counts.n}</span>
        {counts.excluded > 0 && (
          <>
            {' '}· {counts.excluded} closed ticket{counts.excluded === 1 ? '' : 's'} excluded for
            having no record of what the model believed at the time
          </>
        )}
      </p>
      <p className="mt-2 rounded-lg border border-alert/25 bg-alert/[0.06] px-3 py-2 text-ui leading-relaxed text-muted">
        <span className="font-medium text-fg">Not an accuracy measurement.</span> n is small, these
        tickets are not a held-out sample, and they were not drawn at random. Measured accuracy is
        on the Health page.
      </p>
    </Panel>
  );
}
```

- [ ] **Step 3: Create the barrel `index.ts`**

```ts
export { LoopDiagram } from './LoopDiagram';
export { VerdictMatrix } from './VerdictMatrix';
```

- [ ] **Step 4: Create `pages/CloseLoop.tsx`**

```tsx
import { useMemo } from 'react';
import { PageHeader, Panel } from '../components/ui/Panel';
import { LoopDiagram, VerdictMatrix } from '../components/closeloop';
import { useLedgerObservationsQuery, useModelHealthQuery, useTowersQuery } from '../api/queries';
import { useTicketStore } from '../state/useTicketStore';
import { useScheduleStore } from '../state/useScheduleStore';
import { toCorpus, verdictCounts } from '../lib/feedbackCorpus';

/**
 * Where the human closes the loop.
 *
 * model/feedback.py keeps an append-only observation ledger whose rows only
 * become training data once label_status flips to "confirmed", and append() on
 * the serving path forcibly resets any label to "unlabeled" — "Evidence is
 * never an automatic label". Exactly one writer in the repo performs that flip:
 * --simulate, which marks itself simulated.
 *
 * A technician closing a ticket confirmed/false_positive observes
 * needed_corrective_maintenance, which is the model's own training target. This
 * page shows that corpus accumulating and exports it in the ledger's schema.
 *
 * Nothing here writes to the ledger or retrains anything.
 */
export function CloseLoop() {
  const tickets = useTicketStore((s) => s.tickets);
  const towersQuery = useTowersQuery();
  const observationsQuery = useLedgerObservationsQuery();
  const healthQuery = useModelHealthQuery();
  const run = useScheduleStore((s) => s.run);

  const towers = towersQuery.data ?? [];
  const observations = observationsQuery.data ?? [];
  const ledger = healthQuery.data?.ledger ?? null;

  const rows = useMemo(
    () => toCorpus(tickets, towers, observations),
    [tickets, towers, observations],
  );
  const counts = useMemo(() => verdictCounts(rows), [rows]);

  const inFlight = tickets.filter((t) => t.status === 'active' || t.status === 'resolved').length;

  const stages = [
    {
      label: 'model scores',
      value: String(towers.length),
      hint: 'towers scored in this session',
    },
    {
      label: 'solver schedules',
      value: String(run.entries.length),
      hint: 'assignments on the current board',
    },
    {
      label: 'crews visit',
      value: String(inFlight),
      hint: 'tickets active or awaiting validation',
    },
    {
      label: 'technicians judge',
      value: String(rows.length),
      hint: 'closures carrying a verdict',
    },
    {
      label: 'corpus grows',
      value: String(rows.filter((r) => r.attachable).length),
      hint: ledger
        ? `${ledger.eligible_for_training} already training-eligible on the backend`
        : 'verdicts with an observation to confirm',
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Close Loop"
        subtitle="What the field found, against what the model predicted — and the labels that come out of it."
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4 pb-16">
          <LoopDiagram stages={stages} />
          <VerdictMatrix counts={counts} />

          <Panel title="What this page does not do" spine="var(--color-alert)">
            <ul className="space-y-1.5 text-ui leading-relaxed text-muted">
              <li>
                <span className="font-medium text-fg">No retraining happens here.</span> Retraining
                is a manual notebook run. Nothing on this page changes the served model.
              </li>
              <li>
                <span className="font-medium text-fg">Nothing is written to the ledger.</span> The
                export produces records a human appends deliberately.
              </li>
              <li>
                <span className="font-medium text-fg">Ticket state is in-memory.</span> There is no
                ticket backend, so closing a ticket and reloading resets this corpus to the seeded
                fixtures.
              </li>
              <li>
                <span className="font-medium text-fg">Attachments never leave the browser.</span>
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Register the route**

In `src/frontend/src/App.tsx`, add the import beside the other page imports:

```tsx
import { CloseLoop } from './pages/CloseLoop';
```

and add the route directly after the `/investigation` routes (before `/tickets`):

```tsx
            <Route path="/loop" element={<CloseLoop />} />
```

- [ ] **Step 6: Verify the gate**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: `tsc` exits 0; build succeeds. Navigating to `/loop` renders the diagram, the matrix and the honesty panel. With the seeded fixtures and no backend, the matrix shows `n = 0` and `5 closed tickets excluded` — correct, because no seeded ticket carries a snapshot.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/components/closeloop src/frontend/src/pages/CloseLoop.tsx src/frontend/src/App.tsx
git commit -m "feat(loop): the Close Loop page, diagram and verdict matrix

The loop diagram carries live counts rather than drawn boxes, so it moves
when a ticket is closed. A static picture of a feedback loop proves nothing.

The matrix says 'not an accuracy measurement' in those words, beside n and
the count of rows excluded for having no raise-time belief. ModelHealth
renders a real out-of-fold confusion matrix; two matrices in one app, one
measured and one not, have to be distinguishable on sight or the unmeasured
one borrows the other's authority.

The honesty panel states what the page does not do: no retraining, no ledger
write, in-memory tickets, attachments never uploaded.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Corpus ledger, export, and disagreements

**Files:**
- Create: `src/frontend/src/components/closeloop/CorpusLedger.tsx`
- Create: `src/frontend/src/components/closeloop/DisagreementList.tsx`
- Modify: `src/frontend/src/components/closeloop/index.ts`
- Modify: `src/frontend/src/pages/CloseLoop.tsx`

**Interfaces:**
- Consumes: `CorpusRow`, `toObservationRecords`, `toJsonl` (Tasks 3-4); `LedgerSummary` from `api/types`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Create `CorpusLedger.tsx`**

```tsx
import { Panel } from '../ui/Panel';
import { toJsonl, toObservationRecords, type CorpusRow } from '../../lib/feedbackCorpus';
import type { LedgerSummary } from '../../api/types';

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Every closed ticket as a labelled example, and the file that would carry them
 * into the next retrain.
 *
 * The export is the point. It produces records in model/feedback.py's exact
 * Observation schema — a copy of the matched observation with label_status
 * flipped and the label merged in — appendable to data/observation_log.jsonl
 * by hand. Rows with no observation cannot be exported: Observation validates
 * `source` against three satellite values and there is none to invent.
 */
export function CorpusLedger({ rows, ledger }: { rows: CorpusRow[]; ledger: LedgerSummary | null }) {
  const records = toObservationRecords(rows);

  return (
    <Panel
      title="Training corpus"
      footnote="Exported records carry simulated: false — these are real closures, unlike the demo confirmations --simulate writes."
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-ui leading-relaxed text-muted">
          <span className="tnum font-semibold text-fg">{rows.length}</span> closed ticket
          {rows.length === 1 ? '' : 's'} carrying a verdict ·{' '}
          <span className="tnum font-semibold text-fg">{records.length}</span> exportable
          {ledger && (
            <>
              {' '}· backend holds{' '}
              <span className="tnum font-semibold text-fg">{ledger.eligible_for_training}</span>{' '}
              training-eligible, of which{' '}
              <span className="tnum font-semibold text-fg">{ledger.simulated_records}</span>{' '}
              simulated
            </>
          )}
        </p>
        <button
          type="button"
          disabled={records.length === 0}
          onClick={() => download('confirmations.jsonl', toJsonl(records))}
          className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-micro font-semibold text-fg disabled:cursor-not-allowed disabled:border-overlay/15 disabled:bg-transparent disabled:text-dim"
        >
          Export confirmations (JSONL)
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-ui text-dim">
          No closed tickets carry a verdict yet. Close one from the Tickets board and it appears
          here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-ui">
            <thead className="text-eyebrow uppercase tracking-wider text-dim">
              <tr>
                <th className="py-1.5 pr-3">Tower</th>
                <th className="py-1.5 pr-3">Model believed</th>
                <th className="py-1.5 pr-3">Field found</th>
                <th className="py-1.5 pr-3 text-right">Label</th>
                <th className="py-1.5 pr-3">Evidence</th>
                <th className="py-1.5">Exportable</th>
              </tr>
            </thead>
            <tbody className="font-mono text-micro">
              {rows.map((row) => (
                <tr key={row.ticket_id} className="border-t border-overlay/10">
                  <td className="py-1.5 pr-3 text-fg">{row.tower_id}</td>
                  <td className="py-1.5 pr-3 text-muted">
                    {row.belief ? (
                      <>
                        <span className="tnum">{row.belief.priority.toFixed(2)}</span>{' '}
                        {row.belief.decision} · {row.belief.dominant_factor}
                        {row.belief_at === 'current' && (
                          <span className="ml-1 text-dim">(today's score)</span>
                        )}
                      </>
                    ) : (
                      <span className="text-dim">not scored</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-muted">
                    {row.verdict === 'confirmed' ? 'confirmed' : 'false positive'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tnum text-fg">
                    {row.needed_corrective_maintenance}
                  </td>
                  <td className="py-1.5 pr-3 tnum text-muted">
                    {row.evidence_notes} note{row.evidence_notes === 1 ? '' : 's'}
                    {row.evidence_attachments > 0 && ` · ${row.evidence_attachments} file`}
                  </td>
                  <td className="py-1.5 text-muted">
                    {row.attachable ? (
                      <span className="text-ok-ink">{row.observation?.source}</span>
                    ) : (
                      <span className="text-dim">no observation to confirm</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
```

- [ ] **Step 2: Create `DisagreementList.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { Panel } from '../ui/Panel';
import type { CorpusRow } from '../../lib/feedbackCorpus';

/**
 * Where the field contradicted the model.
 *
 * Two independent kinds, kept apart because they imply different corrections:
 * the dispatch decision was wrong (verdict_agreement), or the decision was
 * right and the REASON was wrong (factor_correct). Each row links to
 * Investigation, where ModelTransparencyPanel already renders the attribution —
 * so "it over-weighted flood here" is two clicks rather than a claim.
 */
export function DisagreementList({ rows }: { rows: CorpusRow[] }) {
  const wrongDecision = rows.filter((r) => r.verdict_agreement === 'disagree');
  const wrongReason = rows.filter((r) => r.factor_correct === false);

  if (wrongDecision.length === 0 && wrongReason.length === 0) {
    return (
      <Panel title="Disagreements">
        <p className="text-ui text-dim">
          No closed ticket has contradicted the model yet. With this few verdicts that is not
          evidence of accuracy.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Disagreements">
      {wrongDecision.length > 0 && (
        <>
          <div className="eyebrow mb-2">Dispatch decision was wrong</div>
          <ul className="mb-4 space-y-1.5">
            {wrongDecision.map((row) => (
              <li key={row.ticket_id} className="flex flex-wrap items-baseline gap-2 text-ui">
                <Link
                  to={`/investigation/${row.tower_id}`}
                  className="font-mono text-micro text-accent underline underline-offset-2 hover:no-underline"
                >
                  {row.tower_id}
                </Link>
                <span className="text-muted">
                  model said <span className="text-fg">{row.belief?.decision ?? 'nothing'}</span>,
                  field found{' '}
                  <span className="text-fg">
                    {row.verdict === 'confirmed' ? 'real work' : 'nothing wrong'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {wrongReason.length > 0 && (
        <>
          <div className="eyebrow mb-2">Reason was wrong</div>
          <ul className="space-y-1.5">
            {wrongReason.map((row) => (
              <li key={row.ticket_id} className="flex flex-wrap items-baseline gap-2 text-ui">
                <Link
                  to={`/investigation/${row.tower_id}`}
                  className="font-mono text-micro text-accent underline underline-offset-2 hover:no-underline"
                >
                  {row.tower_id}
                </Link>
                <span className="text-muted">
                  blamed <span className="text-fg">{row.belief?.dominant_factor ?? 'unknown'}</span>
                  {row.actual_factor && (
                    <>
                      , was really <span className="text-fg">{row.actual_factor}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
```

- [ ] **Step 3: Extend the barrel**

`src/frontend/src/components/closeloop/index.ts`:

```ts
export { LoopDiagram } from './LoopDiagram';
export { VerdictMatrix } from './VerdictMatrix';
export { CorpusLedger } from './CorpusLedger';
export { DisagreementList } from './DisagreementList';
```

- [ ] **Step 4: Mount both on the page**

In `src/frontend/src/pages/CloseLoop.tsx`, change the import to:

```tsx
import { CorpusLedger, DisagreementList, LoopDiagram, VerdictMatrix } from '../components/closeloop';
```

and insert between `<VerdictMatrix .../>` and the honesty `<Panel>`:

```tsx
          <CorpusLedger rows={rows} ledger={ledger} />
          <DisagreementList rows={rows} />
```

- [ ] **Step 5: Verify the gate**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: `tsc` exits 0; build succeeds. On `/loop` with seeded fixtures the table shows 5 rows (4 confirmed, 1 false positive), all marked "no observation to confirm" with no backend running, and the export button is disabled — correct, since there is nothing legal to export.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/components/closeloop src/frontend/src/pages/CloseLoop.tsx
git commit -m "feat(loop): corpus ledger, JSONL export and disagreements

The export is the point of the page. It writes records in feedback.py's
exact Observation schema - the matched observation copied, label_status
flipped, the label merged into the free-form dict - appendable to
observation_log.jsonl by hand. Rows with no observation cannot be exported
and say so in the table rather than being hidden: Observation validates
source against three satellite values and there is none to invent.

The table shows which beliefs came from a raise-time snapshot and which fell
back to today's score, because presenting the second as the first is the
quiet failure this feature is supposed to prevent.

Disagreements are split into 'decision was wrong' and 'reason was wrong'.
They imply different corrections, and each links to Investigation where the
attribution panel already shows the evidence.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Swap the nav, salvage Perception into Method

**Files:**
- Create: `src/frontend/src/components/method/PerceptionEvidence.tsx`
- Modify: `src/frontend/src/components/method/MethodPage.tsx`
- Modify: `src/frontend/src/components/shell/NavPill.tsx:28`
- Modify: `src/frontend/src/App.tsx:41`
- Delete: `src/frontend/src/pages/Perception.tsx`, `src/frontend/src/components/perception/PerceptionProof.tsx`

**Interfaces:**
- Consumes: `Panel` from `../ui/Panel`.
- Produces: nothing other tasks depend on.

Perception is 5/7 empty placeholder stages, but it carries the only in-app evidence of the GeoAI imagery pipeline. The three real facts move; the placeholders do not.

- [ ] **Step 1: Create `PerceptionEvidence.tsx`**

```tsx
import { Panel } from '../ui/Panel';

/**
 * How imagery becomes an index input.
 *
 * Salvaged from the Perception tab, which the Close Loop page replaced. That
 * page was 5/7 empty "imagery export pending" placeholders around three real
 * facts, and those three belong here — Method is already the page that explains
 * how the model is built, and these numbers are inputs to it.
 *
 * 0.41 is not an illustration. It is the flood share MY_1042's attribution
 * actually shows, which is why it survived the move.
 */
export function PerceptionEvidence() {
  return (
    <Panel className="mt-5" title="From imagery to input">
      <p className="text-lead leading-relaxed text-muted">
        The flood factor is derived from imagery, not read from a table. A Sentinel-2 tile over
        Sunway (101.605E, 3.065N) is segmented with OmniWaterMask via{' '}
        <a
          href="https://github.com/opengeos/geoai"
          className="text-accent underline underline-offset-2 hover:no-underline"
          target="_blank"
          rel="noreferrer"
        >
          opengeos/geoai
        </a>
        , and the distance-to-water field that falls out is what the index consumes.
      </p>

      <dl className="mt-4 grid gap-2 text-ui sm:grid-cols-3">
        <div className="rounded-lg border border-accent/30 bg-accent/[0.07] px-3 py-2.5">
          <dt className="text-micro text-muted">MY_1042 flood factor</dt>
          <dd className="mt-1 font-display text-title font-semibold leading-none tnum text-accent">
            0.41
          </dd>
          <p className="mt-1.5 text-micro leading-snug text-muted">
            84 m to water · HAND 2.1 m. The same share the tower's attribution shows — the value the
            index consumes, not a separate illustrative number.
          </p>
        </div>
        <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02] px-3 py-2.5">
          <dt className="text-micro text-muted">Exposure footprints</dt>
          <dd className="mt-1 font-display text-title font-semibold leading-none tnum text-fg">
            1,847
          </dd>
          <p className="mt-1.5 text-micro leading-snug text-muted">
            From <span className="font-mono">BuildingFootprintExtractor()</span> in the 2 km service
            buffer — about 6,200 people served. Footprints stand in where OSM is sparse.
          </p>
        </div>
        <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02] px-3 py-2.5">
          <dt className="text-micro text-muted">Coverage</dt>
          <dd className="mt-1 font-display text-title font-semibold leading-none text-fg">Sunway</dd>
          <p className="mt-1.5 text-micro leading-snug text-muted">
            Processed. 13 states pending — to extend coverage, change the bounding box and rerun.
          </p>
        </div>
      </dl>
    </Panel>
  );
}
```

- [ ] **Step 2: Mount it on Method**

In `src/frontend/src/components/method/MethodPage.tsx`, add the import at the top:

```tsx
import { PerceptionEvidence } from './PerceptionEvidence';
```

and render `<PerceptionEvidence />` immediately before the `<Panel className="mt-5" title="The labels behind every figure above are synthetic" ...>` element (line 340). It belongs above that caveat, because the caveat closes the page and this is content the caveat qualifies.

- [ ] **Step 3: Swap the nav entry**

In `src/frontend/src/components/shell/NavPill.tsx`, delete line 28:

```tsx
  { to: '/perception', label: 'Perception', Icon: SatelliteIcon },
```

and insert directly after the `/investigation` entry (line 24):

```tsx
  { to: '/loop', label: 'Close Loop', Icon: SatelliteIcon },
```

`SatelliteIcon` is already imported and now belongs to this entry — no import change, and no other file uses it.

- [ ] **Step 4: Remove the Perception route**

In `src/frontend/src/App.tsx`, delete the `Perception` import line and delete line 41:

```tsx
            <Route path="/perception" element={<Perception />} />
```

- [ ] **Step 5: Delete the files**

```bash
git rm src/frontend/src/pages/Perception.tsx src/frontend/src/components/perception/PerceptionProof.tsx
```

- [ ] **Step 6: Verify nothing else referenced them**

Run: `cd /c/Users/chinp/OneDrive/Documents/GeoAI/starlink && grep -rn "Perception\|/perception" src/frontend/src --include=*.ts --include=*.tsx`
Expected: only `PerceptionEvidence` in `method/`. Any other hit must be resolved before proceeding.

- [ ] **Step 7: Verify the gate**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: `tsc` exits 0; build succeeds. The nav reads
`Map | Investigation | Close Loop | Tickets | Schedule | Weights | Method | Health` — still 8 items.

- [ ] **Step 8: Full verification sweep**

```bash
cd src/frontend && node --experimental-strip-types --test src/lib/feedbackCorpus.test.mjs
cd ../backend && python -m pytest model/ api/ scheduler/ -q
```
Expected: 17 frontend tests pass; 211 backend tests pass.

- [ ] **Step 9: Commit**

```bash
git add -A src/frontend/src
git commit -m "feat(nav): Close Loop replaces Perception, whose evidence moves to Method

Perception was 5/7 empty 'imagery export pending' placeholders around three
real facts. The facts move to Method - already the page that explains how
the model is built - and the placeholders do not.

0.41 travels because it is not an illustration: it is the flood share
MY_1042's attribution actually shows, the value the index consumes. The
opengeos/geoai and OmniWaterMask attribution travels with it, so deleting
the tab costs no evidence that imagery feeds the model.

Close Loop sits beside Investigation because they are the same question at
two scales: one tower's reasoning, and whether that reasoning held up in the
field. Nav stays at 8 items.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification Summary

| gate | command | expected |
|---|---|---|
| Frontend types | `cd src/frontend && npx tsc --noEmit` | exit 0 |
| Frontend build | `cd src/frontend && npm run build` | succeeds; only the pre-existing chunk-size warning |
| Corpus logic | `cd src/frontend && node --experimental-strip-types --test src/lib/feedbackCorpus.test.mjs` | 17 pass |
| Backend | `cd src/backend && python -m pytest model/ api/ scheduler/ -q` | 211 pass |

**Do not gate on the full backend suite.** `tiles/test_preload.py`, `tiles/test_supabase_store.py` and `thermal/test_thermal_layers.py` fail on `main` before any of this work — two Supabase map-cache timeouts and `/fire/layers` never being mounted on the app. All three are outside this feature and must not be fixed here; the `/fire/layers` one is a real wiring bug worth reporting to whoever owns the fire-detection work.
