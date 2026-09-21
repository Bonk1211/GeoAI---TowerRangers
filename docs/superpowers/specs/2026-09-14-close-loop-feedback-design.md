# Close Loop Feedback — Design

**Date:** 2026-09-14
**Scope:** make the human half of the retraining loop visible and exportable — the technician
verdict that turns a satellite observation into a training label.
**Depends on:** `model/feedback.py` (the ledger, already built and tested),
`state/useTicketStore.ts` (the close-out flow, already built).
**Status:** design, not yet implemented.
**Replaces:** the `/perception` tab, whose three real facts move into Method.

---

## 0. Why this exists

This is not a new idea being invented. It is a **hole in a pipeline that already ships**, and
the app already tells the user the hole is there.

`components/health/ObservationLedger.tsx` renders this sentence on the Health page today:

> A satellite observation is evidence, not an outcome — **no record becomes a training label
> until a work order closes against it.** Demo confirmations are explicitly simulated.

That promise is currently unfulfilled. The pipeline is:

```
1. Satellite observes          -> ledger row, label_status: "unlabeled"
2. Model prediction recorded   -> predicted_priority, predicted_decision, agreement
3. A work order closes against it
       -> label_status: "confirmed"
       -> observation.needed_corrective_maintenance: 0 | 1          <-- NO PRODUCER
4. promote_to_training()       -> confirmed rows only
5. Manual notebook retrain
```

Step 3 has exactly one writer in the entire repository: `model/feedback.py:204`, inside
`--simulate`. It stamps `simulated: True`, writes a manifest reading *"Demo confirmations from
synthetic labels; no real work order confirmed these observations"*, and trips the yellow
warning box in the ledger panel.

The serving path cannot produce one. `append()` (`model/feedback.py:80`) overwrites any
caller-supplied label back to `"unlabeled"`, unconditionally, and the module docstring gives the
reason in five words: **"Evidence is never an automatic label."**

So the human is not decoration in this architecture. The architecture *refuses to proceed*
without one, and that human has no way in.

### The join that makes it real

`model/maintenance_need.py:21` states the model's target:

> Not a failure predictor. The target is `needed_corrective_maintenance` — a work order was
> raised.

`fixtures/tickets.ts:2` states the technician's verdict vocabulary:

```ts
export type TicketResolution = 'confirmed' | 'false_positive' | null;
```

These are the same quantity. `confirmed` is `needed_corrective_maintenance = 1`;
`false_positive` is `0`. A technician closing a ticket is *observing the model's own training
label in the field* — the label that is synthetic today
(`components/method/MethodPage.tsx:78`: *"The labels are synthetic"*).

That is the entire argument for this feature, and it survives a hostile question.

### What is already built, and must not be rebuilt

| capability | location | state |
|---|---|---|
| `resolution: 'confirmed' \| 'false_positive'` | `fixtures/tickets.ts:2` | done |
| `closeTicket(id, resolution)` | `useTicketStore.ts:191` | done |
| Jira-style work log `fix_notes[]` | `fixtures/tickets.ts:16` | done |
| Close UI, gated on `status === 'resolved'` | `TicketDrawer.tsx:731` | done |
| Observation ledger + `summarise()` | `model/feedback.py` | done |
| `GET /model/health` -> `ledger` | `api/routes/model.py:84` | done |
| Ledger summary panel | `components/health/ObservationLedger.tsx` | done |

**Nothing in this design rebuilds any of the above.** The capture half of the loop works end to
end. What is missing is that `resolution` is read in exactly three places — `TicketCard.tsx:95`
(a badge colour), `TicketDrawer.tsx:590` (one line of text), `useTicketStore.ts:192` (a
notification string) — **all three cosmetic.** The most valuable signal in the product is
collected perfectly and consumed by nothing.

---

## 1. Scope decisions, and what was rejected

| decision | chosen | rejected, and why |
|---|---|---|
| Loop closure | **Frontend + export the ledger's exact JSONL.** The page reads tickets and the live `/model/health` ledger; an export produces real `Observation` records (`label_status: "confirmed"`, `simulated: false`) appendable to `observation_log.jsonl` by hand. | A `POST /model/feedback/confirm` writer would genuinely close the loop, but the assignment says frontend-only, and a write path into an append-only training ledger deserves its own review. Deferred, not discarded — §7. |
| Verdicts with no matching observation | **Shown, and marked unattachable.** | Hiding them would make the corpus look cleaner while concealing a real finding: satellite coverage does not reach every serviced tower. |
| Perception tab | **Salvage 3 real facts into Method, then delete.** | Deleting outright loses the only in-app evidence of the GeoAI imagery pipeline (Sentinel-2 -> OmniWaterMask -> flood factor), which matters at a GeoAI event. Keeping it costs a nav slot for a page that is 5/7 empty placeholders. |
| Corpus membership | **Every closed ticket is a label**, whatever raised it. | Restricting to `source: 'risk_model'` renders the page EMPTY on load: all 13 fixture tickets are `source: 'manual'` and model-raised tickets only appear once the backend runs and the solver misses an SLA. |
| Corpus storage | **Derived, not stored.** Pure functions over the ticket store. | A parallel `useFeedbackStore` is a second source of truth for one event; reopen a ticket and the two desync. |

### The one backend addition, and why it is unavoidable

`GET /model/health` returns `LedgerSummary` — **aggregate counts only** (`api/schemas.py:204`).
No `tower_id` list, no per-row data. The frontend therefore cannot determine which towers have
an unlabeled observation, which is precisely what "mark them unattachable" requires.

This design adds **one read-only endpoint**:

```
GET /model/feedback/observations?label_status=unlabeled
    -> [ <the complete Observation row, every field> ]
```

**It must return the WHOLE row, not a projection** — see §3.3. A confirmation is produced by
copying the original observation and flipping two fields; a partial row cannot be copied, and
reconstructing one would invent `predicted_priority` and `agreement` values that the ledger
measured.

It is a pass-through of `_read()`, which already exists. **No mutation, no new writer, no change
to `Observation` or its validation.** It is the minimum that makes the chosen behaviour
possible. If the frontend-only constraint is enforced strictly, drop this endpoint; every
verdict then renders as unattachable and the export is empty — the page still stands, and it
reports the reason rather than faking a match.

---

## 2. Data model

### 2.1 Two additions to `Ticket` (`fixtures/tickets.ts`)

```ts
/** What the model believed WHEN THE TICKET WAS RAISED. */
export interface ModelSnapshot {
  risk: number;
  priority: number;                       // the blended rank decision is cut on
  decision: 'maintain' | 'watch' | 'ok';
  dominant_factor: string;
  captured_at: string;                    // ISO
}

/** The technician's verdict ON THE MODEL, distinct from the verdict on the tower. */
export interface ModelFeedback {
  accurate: boolean | null;               // was the model's assessment right?
  actual_factor?: string;                 // it said flood; it was really power
  comment?: string;
  author: string;
  created_at: string;
}

interface Ticket {
  // ...existing fields unchanged...
  model_snapshot?: ModelSnapshot;
  model_feedback?: ModelFeedback;
}
```

Both optional. Every existing fixture ticket and every existing consumer keeps compiling
untouched.

**`resolution` and `model_feedback.accurate` are not redundant.** They answer different
questions and imply different fixes:

- `resolution` — *was there really a problem?* That is the training label.
- `accurate` — *did the model reason correctly?* That is the attribution signal.

A ticket can be `confirmed` (a real fault) while the model blamed the wrong factor. Collapsing
them would discard the second correction entirely.

`model_snapshot` is populated inside `escalateWorkOrder` (`useTicketStore.ts:272`), which
already receives the full `Tower`. Roughly five lines.

### 2.2 Attachments (`fix_notes[]`)

```ts
fix_notes: {
  author: string;
  created_at: string;
  text: string;
  link?: string;                          // retained; existing fixtures use it
  attachment?: { name: string; type: string; size: number; dataUrl: string };
}[]
```

Real `<input type="file">`, thumbnail preview, **2 MB cap** with an inline rejection message.
The file never leaves the browser. The JSON export carries attachment *metadata* only — name,
type, size — never the bytes.

### 2.3 Corpus row (derived, never stored)

Field names mirror the ledger's vocabulary deliberately, so both halves of the loop speak one
language:

```ts
export interface CorpusRow {
  ticket_id: string;
  tower_id: string;
  needed_corrective_maintenance: 0 | 1;   // the ledger's own label field name
  verdict: 'confirmed' | 'false_positive';
  raised_by: 'manual' | 'demo_emergency' | 'risk_model';
  belief: ModelSnapshot | null;
  belief_at: 'raise' | 'current';         // see below
  verdict_agreement: 'agree' | 'disagree' | 'indeterminate';
  factor_correct: boolean | null;
  actual_factor: string | null;
  evidence_notes: number;
  evidence_attachments: number;
  /** The unlabeled ledger row this verdict can confirm, whole. Null = unattachable. */
  observation: LedgerObservation | null;
  closed_at: string;
}
```

**`verdict_agreement` must not be called `agreement`.** The ledger already has an `agreement`
field and it measures a *different comparison*: model prediction versus **satellite**
observation. This field is model prediction versus **technician**. Same three-way vocabulary,
deliberately — but reusing the name would let two unrelated comparisons be read as one number,
which is the failure this whole feature exists to prevent.

`observation` carries the matched row **in full**, not a reference. §3.3 explains why a copy is
required.

**`belief_at` is not cosmetic.** Manual tickets were raised by a human, so no snapshot exists
and the row falls back to the tower's *current* score, marked `'current'`. Without that flag the
page would silently compare today's model against a verdict from three weeks ago and present it
as a measurement. Rows marked `'current'` render with a visible marker and are **excluded from
the 2x2 counts** in §3.2.

`agreement` follows the ledger's own three-way vocabulary rather than a boolean, because
`indeterminate` is a real outcome — a `watch`-band tower is neither a dispatch nor a dismissal.

---

## 3. Panels

### 3.1 `LoopDiagram`

Five stages, each with a live count read from real state — not a static graphic.

```
Model scores ──> Solver schedules ──> Crew visits ──> Technician judges ──> Corpus grows
  N towers          N entries          N active/        N closed with       N labelled
                                       resolved          a verdict           rows
```

The last stage carries the ledger's `eligible_for_training` beside it, so the in-app corpus and
the backend's own count sit next to each other and any divergence is visible rather than hidden.

### 3.2 `VerdictMatrix`

```
                      field: confirmed        field: false_positive
model: maintain       caught it               false alarm
model: watch / ok     missed it               correctly quiet
```

Built only from rows with `belief_at === 'raise'`. Renders `n` prominently and, directly beneath
it, this sentence, non-negotiable:

> Not an accuracy measurement. n is small, these tickets are not a held-out sample, and they
> were not drawn at random. Measured accuracy is on the Health page.

Without that line this panel contradicts `ModelHealth`, whose own doc comment says *"a
fabricated confusion matrix on the page whose job is telling you whether to trust the model
would be the worst place in the app to invent a number."* Two confusion matrices in one app,
one measured and one not, must be told apart on sight.

### 3.3 `CorpusLedger`

One row per closed ticket:

```
tower_id  | model belief (at raise) | verdict        | label | evidence | attachable | closed
MY_1010   | 0.87 maintain / flood   | confirmed      | 1     | 2 + 1 img| yes        | Sep 12
MY_1003   | 0.71 maintain / power   | false positive | 0     | 1        | no obs.    | Sep 13
MY_1042   | 0.44 watch  (current)   | confirmed      | 1     | 3        | yes        | Sep 13
```

Header states the corpus size against the backend's `eligible_for_training`, plus
`simulated_records` — so a reader can see how much of the current training-eligible pool is
simulated rather than real.

**`Export confirmations (JSONL)`** — and the construction rule is the single most important
detail in this document.

A confirmation is **not a newly built record.** `model/feedback.py:204` builds one by copying
the original observation wholesale and changing exactly two things:

```python
Observation(**{**row,
               "label_status": "confirmed",
               "simulated": True,          # ours writes False
               "observation": {**row["observation"],
                               "needed_corrective_maintenance": int(label)}})
```

The export must do the same, because `_confirmed()` (`model/feedback.py:97`, key at `:104`) keys candidates on
**`(tower_id, source, observed_at)`**. Any record that does not reproduce that triple exactly
does not confirm the existing observation — it appends an unrelated row, and the original stays
`unlabeled` forever. Silently. So:

```
exported = { ...matchedObservation,                      // every field, copied
             label_status: "confirmed",
             simulated: false,                           // the entire point
             observation: { ...matchedObservation.observation,
                            needed_corrective_maintenance: 0 | 1,
                            ticket_id, closed_by, closed_at } }
```

`predicted_priority`, `predicted_decision`, `agreement`, `source` and `observed_at` are **carried
over untouched**. They were measured when the observation was made; re-deriving them from
today's model would overwrite a measurement with a guess.

Consequences, each enforced by `Observation.__post_init__`:

- `observed_at` stays the **observation's**, never the ticket's `closed_at`. It is UTC already,
  and `__post_init__` raises on any offset that is not zero.
- `source` is carried, so it is legal by construction. **Unattachable rows are excluded from the
  export entirely** — there is no legal source to invent for them. They stay visible in the
  table with the reason shown.
- `predicted_priority` is carried, so it is already finite and in `[0, 1]`.
- The extra ticket fields live **inside** `observation`, which is a free-form dict, so no
  validation is touched.

The exported file is appendable to `data/observation_log.jsonl` by hand.

The exported file is appendable to `data/observation_log.jsonl` by hand. That is the loop
closing to the boundary of the stated scope, and it is demonstrable in one command.

### 3.4 `DisagreementList`

Rows where `verdict_agreement === 'disagree'`, plus rows where `factor_correct === false`. Each links to
`/investigation/:towerId`, where `ModelTransparencyPanel` already renders the attribution — so
"the model over-weighted flood here, and here is the field evidence" is two clicks, not a claim.

### 3.5 Honesty panel

`<Panel spine="var(--color-alert)">`, matching `MethodPage.tsx:340`'s existing convention:

- No retraining happens here. Nothing on this page changes the served model.
- Ticket state is in-memory (`docs/Ticket_System_Handoff.md §0.4` — no ticket backend exists).
  Closing a ticket and refreshing resets the corpus to the seeded fixtures.
- The 2x2 is not an accuracy metric.
- Attachments never leave the browser.

---

## 4. Files

**New**

| path | responsibility |
|---|---|
| `pages/CloseLoop.tsx` | composes the five panels |
| `components/closeloop/LoopDiagram.tsx` | §3.1 |
| `components/closeloop/VerdictMatrix.tsx` | §3.2 |
| `components/closeloop/CorpusLedger.tsx` | §3.3 |
| `components/closeloop/DisagreementList.tsx` | §3.4 |
| `components/closeloop/index.ts` | barrel, matching `components/health/index.ts` |
| `lib/feedbackCorpus.ts` | `toCorpus()`, `verdictCounts()`, `toObservationRecords()` — pure |
| `lib/feedbackCorpus.test.mjs` | node test, matching the 10 existing `.test.mjs` files |
| `components/method/PerceptionEvidence.tsx` | Perception's salvaged content |

**Modified**

| path | change |
|---|---|
| `fixtures/tickets.ts` | `ModelSnapshot`, `ModelFeedback`, `attachment` on fix notes |
| `state/useTicketStore.ts` | capture snapshot in `escalateWorkOrder`; add `setModelFeedback` |
| `components/tickets/TicketDrawer.tsx` | feedback section beside the close buttons; real file input |
| `api/types.ts` | `LedgerObservation` for the new read endpoint |
| `api/queries.ts` | `useLedgerObservationsQuery` |
| `App.tsx` | `/loop` route in, `/perception` route out |
| `components/shell/NavPill.tsx` | Close Loop after Investigation; Perception removed |
| `components/method/MethodPage.tsx` | mount `PerceptionEvidence` |
| `api/routes/model.py` | `GET /model/feedback/observations` (read-only, §1) |
| `api/schemas.py` | `LedgerObservationOut` |

**Deleted**

`pages/Perception.tsx`, `components/perception/PerceptionProof.tsx`

**Nav result** — still 8 items:

```
Map | Investigation | Close Loop | Tickets | Schedule | Weights | Method | Health
```

---

## 5. Perception salvage

Three facts survive; five empty placeholder stages do not.

1. The flood-factor derivation — Sentinel-2 over Sunway, `segment_water()` via OmniWaterMask
   (opengeos/geoai), distance-to-water, **0.41 flood factor for MY_1042** — kept because that
   number is the value the index actually consumes, not an illustration.
2. `BuildingFootprintExtractor` — **1,847 footprints** in the 2 km buffer, ~6,200 people served.
3. Coverage — Sunway processed, 13 states pending.

These become a **"From imagery to input"** section on Method, which is already the page that
explains how the model is built. The `opengeos/geoai` and OmniWaterMask attribution travels with
them. The `SatelliteIcon` import in `shell/icons.tsx` stays — it is reused elsewhere; only the
nav entry goes.

---

## 6. Testing

Every decision lives in `lib/feedbackCorpus.ts` as a pure function, so the tests assert
behaviour rather than markup. `lib/feedbackCorpus.test.mjs` covers:

1. `confirmed -> needed_corrective_maintenance === 1`, `false_positive -> 0`.
2. Open / active / resolved tickets are excluded; only `closed` with a non-null resolution enters.
3. A ticket with `model_snapshot` yields `belief_at: 'raise'`; one without yields `'current'`.
4. Rows with `belief_at: 'current'` are excluded from `verdictCounts()`.
5. `verdict_agreement` is `'agree'` for maintain+confirmed and watch/ok+false_positive;
   `'disagree'` for maintain+false_positive and watch/ok+confirmed; `'indeterminate'` where the
   band is absent.
6. `observation` is null — and `attachable` therefore false — when no unlabeled observation
   matches the tower.
7. `toObservationRecords()` **omits unattachable rows entirely**.
8. **The exported record reproduces `(tower_id, source, observed_at)` byte-identically from the
   matched observation.** This is the test that matters most: a drifted triple appends an
   orphan row instead of confirming anything, and nothing anywhere would report the failure.
9. `predicted_priority`, `predicted_decision` and `agreement` are carried through unchanged
   from the matched observation, never recomputed from the current tower.
10. Every exported record carries `simulated: false` and `label_status: "confirmed"`, and the
    ticket fields land inside `observation`, leaving the validated top-level fields untouched.
11. An empty ticket list yields an empty corpus and zeroed counts, not a crash.

Backend: extend `api/test_model_health.py` for the new read endpoint — shape, the
`label_status` filter, and `[]` (not a 500) when no ledger file exists.

Frontend gate: `npx tsc --noEmit` and `npm run build`, both currently clean.

---

## 7. Deliberately out of scope

- **`POST /model/feedback/confirm`.** The write path that would close the loop end to end. A
  writer into an append-only training ledger needs its own review — idempotency, who is
  authorised to confirm, and what happens when a ticket is reopened after confirmation. §3.3's
  export reaches the same boundary without any of that risk.
- **A `work_order` observation source.** Would let any technician verdict become a standalone
  labelled record rather than only confirming a satellite row. It edits `Observation`'s
  validation in a tested file another teammate owns, and should be raised with them first.
- **Retraining.** Manual notebook run, unchanged. Nothing here triggers it, and no panel claims
  otherwise.
- **Persistence.** Ticket state stays in-memory. `localStorage` on the ticket store is ~10 lines
  if the corpus needs to survive a refresh during a demo; it is not in this design.
- **Role enforcement.** "admin/reporter only" remains a label, not a check, exactly as it is
  today.
