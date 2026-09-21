# Multi-Start Optimizer — Design

**Date:** 2026-09-10
**Scope:** raise schedule quality above single-pass greedy without changing any constraint, any
API shape, or the explainability of the result.
**Depends on:** nothing. `Optimizer.optimize()`'s existing `sort_key_fn` seam is the whole
mechanism.
**Status:** design, not yet implemented.

---

## 0. Why this exists

[PRD §13](../../PRD_Agentic_Maintenance_Scheduler.md) already concedes the weakness openly:

> Greedy scheduling is not globally optimal; the OR-Tools tier (if shipped) bounds how far off it is.

The OR-Tools tier is not going to ship before the deadline — the travel chain inside a crew-day
makes this a VRP with time windows, not an assignment problem, and that is a multi-day modelling
job. This design delivers the *other* half of that sentence: it makes the schedule measurably
better **and** produces the number that bounds how far off greedy was, using only code that
already exists.

Two concrete failure modes are being attacked, both visible in `scheduler/optimize.py`:

1. **First-fit on day** (`:632`). The day loop `break`s on the first day that works. A job takes
   the earliest slot it can even when a later slot costs it nothing and that early slot was the
   only slot some other job could ever have used.
2. **Static ordering** (`:431`). Work is sorted once, up front, and placed in that frozen order. A
   job with one feasible crew-day loses it to a job with twenty options that happened to sort
   higher.

Multi-start does not fix either mechanism. It samples around them: run the same greedy several
times under slightly different orderings and keep the best result. Cheap, safe, and it converts
"we know greedy is suboptimal" into "greedy is within X% of the best of N".

---

## 1. The trap that decides the design

**`risk_weighted_wait` cannot be used as the selection criterion.** This is the single most
important fact in this document and it is not obvious from the field name.

The objective accumulates in exactly two places, `optimize.py:630` (a placed job) and `:672`
(a pinned job):

```python
risk_weighted_wait += priority(tower) * days_until_serviced + lam * dist
```

**Unscheduled work contributes nothing.** A restart that fails to place a high-risk tower does not
pay for it — it simply stops accruing. So the lowest `risk_weighted_wait` across N restarts is
systematically the restart that **scheduled the least work**.

Selecting on it directly would produce a schedule that is strictly worse than today's while
reporting a better number, and the reported improvement would grow with N. That is worse than not
doing this at all.

### The selection criterion

Compare candidates **lexicographically**, worst-first on unserviced risk:

| Rank | Key | Direction |
|---|---|---|
| 1 | `sum(priority(t) for t in unscheduled)` — unserviced risk mass | lower wins |
| 2 | `risk_weighted_wait` | lower wins |
| 3 | restart index | lower wins (determinism tie-break) |

Key 1 is risk-weighted rather than a plain count on purpose: leaving one 0.97 tower unscheduled is
not equivalent to leaving one 0.31 tower unscheduled, and a plain count would call them equal. It
introduces no new tunable constant — `priority()` is the same function the sort key and the
objective already use, so nothing new has to be defended.

Key 3 exists so that two genuinely equal candidates always resolve the same way. Without it the
winner depends on iteration order and the run stops being reproducible.

---

## 2. Decisions locked

1. **Restart 0 is the unperturbed baseline.** It runs the exact sort key in use today, ε = 0. This
   makes the whole feature *provably non-regressive*: the winner is chosen from a set that always
   contains today's answer, so multi-start can never return something worse than single-pass.
2. **Perturbation is multiplicative jitter on the sort key**, not noise added to it. `key * (1 +
   U(-ε, ε))`. The key is a product of `priority × urgency_factor` whose scale varies with the
   dataset, so additive noise would be meaningless on one dataset and overwhelming on another.
3. **The `tower_id` tie-break survives.** `remaining.sort(key=lambda wo: (sort_key(wo),
   wo["tower_id"]))` at `:431` exists to stop co-located towers permuting — the comment there
   records that it fixed 30 of 36 reserve dispatches reporting phantom displacement. Perturbation
   changes the first element of that tuple; it must never remove the second.
4. **Seeded, always.** `demo_clock` is pinned for demo reproducibility and
   `test_optimize.py:471-487` asserts `optimize()` twice returns identical output. Both must
   still hold. The RNG is seeded from policy, never from clock or entropy.
5. **Budget-bounded, not count-bounded.** See §4 — a fixed N behaves completely differently on the
   132-tower pilot than on the 1164-tower national set.
6. **Constraints are untouched.** No feasibility code is modified. Every restart calls the same
   `run_pass()` with the same hard filters. This is what makes the change safe to ship late.

---

## 3. Where this must NOT run

Two paths must stay single-pass, and both are correctness issues rather than performance ones.

### 3.1 The override path (`scheduler/override.py:93` `_resolve_around_pin`)

Every `/schedule/pin` and `/schedule/emergency` re-solves the whole board synchronously, in the
request path, while a human waits having just clicked Approve.

Beyond latency, there is a behavioural reason: re-drawing the entire board from a *different*
random restart on every pin would make unrelated jobs jump around after each approval, for reasons
the planner cannot see and the confirmation panel cannot explain. The dispatch animation would then
be narrating churn rather than consequence.

The pin is a human decision anchored to a board that was already optimized once. It re-solves
single-pass, from restart 0's semantics.

### 3.2 The baseline comparison (`scheduler/baseline.py`)

`risk_weighted_wait_reduction_pct` is the headline "our policy beats naive dispatch by X%" number.
It works today because both policies run through *identical* constraints via `sort_key_fn` — that
is the documented reason the seam exists.

**If the smart policy gets N restarts and the naive baseline gets one, that comparison becomes
rigged**, and the headline number silently absorbs the multi-start gain while claiming it came from
the dispatch policy. Two honest options:

- **(a)** Baseline comparison runs both policies single-pass. The reduction figure keeps meaning
  exactly what it means today. **Recommended.**
- **(b)** Both policies get the same restart budget. More favourable to us, but it changes what the
  published number measures and would need the writeup updated.

Pick (a) unless someone deliberately argues for (b). Do not leave it unstated.

---

## 4. Choosing N

### 4.1 Why a fixed N is the wrong knob

Single-pass cost scales with `jobs × days × crews`. The pilot dataset is 132 towers; the national
one is 1164. The same N produces an interactive solve on one and an unusable one on the other, and
whoever switches datasets will not remember to retune it.

**Bound the work by wall clock, cap it by count, and stop early when it stops helping.**

```yaml
# config/policy.yaml
restarts:
  enabled: true
  max_restarts: 16        # hard ceiling, including restart 0
  time_budget_ms: 1500    # stop starting new restarts past this
  no_improve_stop: 5      # stop after this many consecutive non-improving restarts
  jitter: 0.15            # epsilon in key * (1 + U(-e, e))
  seed: 20260910          # fixed: reproducibility is a project invariant
```

All four live in `policy.yaml` because that is where this project keeps assumed parameters — the
file header says so and PRD §13 depends on it staying true.

### 4.2 Why these values

**`max_restarts: 16`.** Best-of-N sampling improves roughly logarithmically: the gap between the
best of 1 and the best of 8 is large, between 8 and 16 modest, between 16 and 64 usually noise.
Published multi-start VRP results typically capture most of the achievable gain by N ≈ 10 and
plateau by N ≈ 25. 16 sits at the knee. It is also a power of two, which keeps the door open for
chunked parallelism later without re-tuning.

**`time_budget_ms: 1500`.** The initial `/schedule/optimize` is a page-load-time call, not an
interaction. 1.5 s of solve is invisible behind a spinner; 5 s is not. This is the number to raise
if measurement shows headroom.

**`no_improve_stop: 5`.** On an easy instance the first two or three restarts find the plateau and
the remaining thirteen are pure waste. Early stopping typically cuts mean restart count by roughly
half with no quality loss, and it costs one counter.

**`jitter: 0.15`.** Enough to reorder genuinely close-ranked work, not enough to shuffle a 0.95-risk
tower behind a 0.30 one. Too small and every restart reproduces restart 0; too large and the
priority ordering — the thing that makes this scheduler defensible — stops meaning anything. Tune
by measurement (§6), not by taste.

### 4.3 Measure before committing to any of it

```bash
cd src/backend && python -c "
import time, statistics
from scheduler.optimize import Optimizer
# build work_orders / towers_by_id exactly as api/routes/schedule.py does
t = []
for _ in range(5):
    s = time.perf_counter(); Optimizer(crews).optimize(work_orders, towers_by_id); t.append(time.perf_counter()-s)
print(f'single optimize(): p50={statistics.median(t)*1000:.0f}ms')
"
```

Read the result against §5's cost model. If a single `optimize()` is already above ~150 ms on the
national set, lower `max_restarts` rather than raising the budget — a slow initial load is a worse
demo failure than a slightly less optimal board.

---

## 5. Making N restarts cost far less than N × T

This is the part that decides whether N = 16 is affordable. Let **T** = one `run_pass()`.

**Today:** `optimize()` costs **2T** whenever reserve is enabled — `run_pass()` is called twice,
once real and once as the reserve-off counterfactual (`:676`, `:688`).
**Naive multi-start:** 2NT. At N = 16 that is 32T. Unaffordable.
**This design:** **(N + 1)·αT**, where α < 1 comes from the hoists below.

### 5.1 Run the shadow pass once, on the winner only — 2N → N+1

The counterfactual pass exists solely to relabel unscheduled towers as `reserved`. The code says so
itself at `:684-686`:

> This shadow pass does not affect entries, reserve, risk_weighted_wait, or any other real-pass
> output — only which towers in `unscheduled_detail` get relabelled below.

So it has no bearing on which restart wins. Run all N restarts reserve-on, select the winner, then
run the shadow pass exactly once against the winner. **This halves the cost and loses nothing** —
it is an exact transformation, not an approximation. It is also already conditional on
`if reserved_keys:` (`:687`), so a readiness-off run pays nothing at all.

### 5.2 Hoist the pure per-(tower, crew) work out of the restart loop

Three computations inside the hot loop are **identical in every restart** because they depend only
on the tower, the crew, and the policy — never on ordering or on placement state:

| Computation | Where | Why it is restart-invariant |
|---|---|---|
| `_candidate_crews(wo, tower)` — crew_type + territory filter | `:520` | Pure function of `wo["crew_type"]` and `tower["territory"]` |
| `travel_km(crew, tower, road_factor)` | `:543` | Pure function of the pair |
| The depot-range verdict `dist > max_km` | `:544` | Pure, derived from the above |

Precompute once, before the restart loop, as a per-tower list of `(crew, dist)` already filtered to
in-range crews. Every restart then iterates a short prepared list instead of re-filtering the whole
roster and recomputing every distance. This removes an entire inner filter pass from all N runs.

Note this is a **strict win even at N = 1**, so it can land as its own commit ahead of the restart
loop, and be verified against the existing determinism test in isolation.

### 5.3 Memoize `leg()` across restarts

`leg(origin_key, …, tower_id, …)` at `:565` is the true inner cost — it is called per candidate
crew, per day, per work order. Its result depends only on the two endpoints and the two travel
constants, and the endpoint set is fixed for the whole solve (towers and depots do not move).

Across N restarts the *same* `(origin_key, dest_key)` pairs recur heavily, because restarts differ
only in the order work is placed, not in which towers exist. A dict cache held on the `Optimizer`
instance for the duration of one `optimize()` call converts most of those into lookups.

Two rules: key on `(origin_key, dest_key)` only — never on mutable placement state — and build the
cache per `optimize()` call rather than per process, so a reloaded travel matrix can never be
served from a stale cache.

### 5.4 Do not parallelize yet

Restarts are embarrassingly parallel, so this looks tempting. It is not, yet:

- Threads gain nothing under the GIL unless the work is inside NumPy, and the placement loop is
  pure Python.
- `ProcessPoolExecutor` must pickle `work_orders`, `towers_by_id` and the travel matrix to each
  worker. For a solve measured in tens of milliseconds, that overhead exceeds the work.

Revisit only if §4.3 shows T large enough that the transfer cost is amortised. Ship the serial
version first; §5.1–5.3 are where the real factor is.

### 5.5 Expected result

With §5.1 alone: 32T → 17T at N = 16. With §5.2 and §5.3 lowering α to a plausible 0.6–0.7:
**roughly 10–12T**, against 2T today. A 5–6× slower initial solve for a measurably better board and
a defensible bound — while the interactive path (§3.1) stays exactly as fast as it is now.

---

## 6. What this must be able to report

The improvement is not the only deliverable — the *measurement* is, because it is what PRD §13
promised. `OptimizeResult` gains one optional field:

```python
@dataclass
class RestartStats:
    restarts_run: int          # how many actually ran (early stop may cut it short)
    winner_index: int          # 0 means the unperturbed baseline won
    baseline_score: float      # restart 0's risk_weighted_wait
    winner_score: float        # the winner's
    improvement_pct: float     # 0.0 when restart 0 won
```

`winner_index == 0` is a completely legitimate outcome and must be reported plainly, not hidden. If
it happens on most runs, that is real evidence that ordering is not greedy's binding constraint
here — which is exactly the signal that says stop investing in restarts and go implement regret
insertion instead.

---

## 7. Acceptance criteria

1. **`test_optimize.py:471-487` still passes** — two `optimize()` calls on identical input return
   identical entries, reserve and `risk_weighted_wait`. Non-negotiable; it is the reproducibility
   invariant the demo rests on.
2. **Never worse than single-pass.** A test asserting the winner's score is `<=` restart 0's, over
   a spread of seeds. Guaranteed by construction (§2.1) but must be pinned by a test, because a
   future edit to the selection criterion could silently break it.
3. **The trap is covered.** A test with two hand-built candidate solutions where the one that
   schedules *less* work has a lower `risk_weighted_wait`, asserting the selector picks the one that
   schedules more. This is the §1 failure, and it is the test most likely to catch a regression
   years from now.
4. **Shadow pass runs exactly once** regardless of N — assert via call counter, not by timing.
5. **Override path is single-pass.** Assert `_resolve_around_pin` produces `restarts_run == 1`.
6. **Budget honoured.** With `time_budget_ms` set very low, `restarts_run` is small and the call
   still returns a valid schedule.
7. **Baseline integrity.** Whichever of §3.2 (a)/(b) is chosen, a test pins it, so the published
   reduction percentage cannot drift into dishonesty unnoticed.

---

## 8. Out of scope

- **Regret insertion** — attacks failure mode 2 directly rather than sampling around it, but it
  restructures the main placement loop instead of using the `sort_key_fn` seam. Separate design,
  and §6's `winner_index` distribution is the evidence for whether it is worth doing.
- **Local search / relocate-swap improvement** — needs the feasibility check factored out of the
  placement loop so it can be called standalone. Separate design.
- **OR-Tools CP-SAT** — the real answer, out of reach before the deadline (§0).
- **Parallel restarts** — §5.4.
- **Any change to a hard constraint, the objective formula, or an API shape.** This design is
  worthless if it cannot be described as "same rules, better search".
