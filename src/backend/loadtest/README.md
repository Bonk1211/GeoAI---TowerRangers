# Load testing the disaster-response path

Measures how long the endpoints a planner hits between a flood warning and a
dispatched crew take **under concurrency**, using [locust](https://locust.io/).

This is *system* latency — wall-clock time for the API to answer. It is not the
domain "hours from impact to restore" figure, which is a different number that
lives in the `/simulation` tab. Do not present one as the other.

## Install

Installs into the same `src/backend/.venv` as the other four requirements
files. Nothing on the serving path imports locust; the API boots without it.

```bash
cd src/backend
pip install -r requirements-loadtest.txt
```

## Run

Start a backend, then point locust at it. Two configurations are worth
measuring and the gap between them is large (see "Measured" below).

```bash
# 1. Dev config — what `make dev` runs. Single worker.
cd src/backend && python -m uvicorn api.main:app --port 8011 --log-level warning

# 2. Multi-worker — nearest thing here to a deployable config.
cd src/backend && python -m uvicorn api.main:app --port 8012 --workers 4 --log-level warning
```

Web dashboard (locust's live charts — latency percentiles, RPS, failures as
they happen). Open http://localhost:8089 and set the user count there:

```bash
cd src/backend
python -m locust -f loadtest/locustfile.py --host http://127.0.0.1:8011
```

Headless, for a repeatable number you can quote:

```bash
cd src/backend
python -m locust -f loadtest/locustfile.py --headless \
  -u 20 -r 5 -t 60s --host http://127.0.0.1:8011 \
  --only-summary DisasterResponseUser --csv results_dev
```

`-u` users, `-r` spawn rate per second, `-t` duration. Naming
`DisasterResponseUser` as the trailing argument excludes the sampler class
below. `--csv` writes `results_dev_stats.csv` and friends.

Add `USE_FIXTURE=1` to the backend's environment for the deterministic
synthetic population — useful when you want run-to-run variance to be the
server rather than the data. The numbers below are **not** on that path; they
are against the real 1,164-tower national table.

## What it exercises

| Weight | Request | Why it is here |
|---|---|---|
| 10 | `GET /towers` | The read every screen performs on mount |
| 4 | `POST /score` | A weight-slider drag; re-scores the feature table server-side |
| 3 | `POST /schedule/preview` | Override check. Contractually non-mutating |
| 2 | `POST /schedule/optimize` | The greedy solver. The expensive call |
| 2 | `POST /schedule/emergency` | Dispatch-now, **with `commit: true`** |

Deliberately excluded: Earth Engine tiles, the flood forecast, and the agent.
Those are network-bound on a third party, so timing them measures someone
else's service and would swamp the solver's own number.

## This test mutates state

`POST /schedule/emergency` runs with `commit: true` and writes into
`scheduler/store.py`'s run store. **Restart the backend after a run.** Point it
at a throwaway process, never at a backend someone is demoing from.

## What the store does under load

Two properties of `RunStore` shape both the locustfile and how its output
should be read.

**It has no eviction.** Every `/schedule/optimize` adds a `StoredRun` that is
never freed, so a long run grows the process monotonically. Each simulated
user therefore owns one run for its whole session rather than minting one per
action — otherwise the test would measure store growth no real usage produces.
`StoreGrowthUser` samples alongside the load so a rising p95 can be read
against it instead of in isolation.

**It is per-process.** Under `--workers N` there are N independent stores
behind one port, so a `run_id` minted by one worker is a 404 on the other
N-1 — this is a real property of the server, not a test artifact. Tasks that
need a run use a run *that user* created and treat a 404 as an expected
multi-worker outcome rather than a server failure. If a deployed multi-worker
backend is ever wanted for real, the store needs to move out of process
first; this test does not paper over that, it just declines to score it as an
error.

## Measured

Legion7-2021, Windows 11, Python 3.14, locust 2.46.6, real national tower
table (not the fixture), 20 users, 60s, identical locustfile. Response times
in ms.

| Endpoint | 1 worker p50 / p95 | 4 workers p50 / p95 |
|---|---|---|
| `GET /towers` | 500 / 2100 | 14 / 180 |
| `POST /score` | 2100 / 4900 | 410 / 680 |
| `POST /schedule/optimize` | 640 / 2500 | 60 / 270 |
| `POST /schedule/preview` | 710 / 2000 | 21 / 260 |
| `POST /schedule/emergency` | 470 / 1200 | 25 / 220 |
| **Aggregate** | **640 / 3000** | **24 / 440** |

Throughput 8.73 → 14.27 req/s. **Zero failed requests in both runs** — the
single-worker config degrades by queueing, not by erroring, which is the
failure mode that looks fine in a log and terrible to a user.

Three things worth taking from this:

1. **`/score` is the slowest call by a wide margin** in both configs, and it
   is the one behind the weight sliders — the most interactive control in the
   app. At 4 workers its p95 is 680ms, which is usable; single-worker at
   4900ms is not. `useLiveTowers`'s ~300ms debounce exists partly because of
   this shape.
2. **The dev-mode penalty is real and roughly 7x at the aggregate p95.** Any
   latency figure quoted from a `make dev` backend understates capacity by
   about that much and must be labelled as dev-mode.
3. At 5 users single-worker (a demo-sized load) aggregate p95 was 560ms with
   `/schedule/optimize` at 410ms, so the demo path is comfortable. The
   saturation above is a 20-user finding, not a demo finding.

Re-measure rather than trusting this table after any change to the solver,
the adapter or the feature table's size.

## The detect -> decide -> dispatch chain

`EndToEndUser` walks the whole arc in sequence and reports the total as one
synthetic request, so the chain latency is measured rather than summed from
per-endpoint medians (the sum of p50s is not the p50 of the sum).

```bash
cd src/backend
python -m locust -f loadtest/locustfile.py --headless \
  -u 1 -r 1 -t 90s --host http://127.0.0.1:8011 EndToEndUser
```

Same machine and dataset as above. Chain totals, ms:

| Config | chain p50 | chain p95 | `/score` p50 | `optimize` p50 | `emergency` p50 |
|---|---|---|---|---|---|
| 1 user, 1 worker | **440** | 470 | 360 | 53 | 24 |
| 20 users, 1 worker | 8000 | 8500 | 6500 | 820 | 200 |
| 20 users, 4 workers | 2100 | 3800 | 1100 | 340 | 73 |

47 / 186 / 465 chain runs respectively, **zero failures in all three**.

Three readings:

1. **Uncontended, the full arc is 0.44s.** Planning is not what a disaster
   waits on -- a crew still has to drive there. The value of the number is
   that re-planning is cheap enough to do continuously as conditions change,
   not that anything is "solved" in half a second.
2. **`/score` is 82% of the chain** (360 of 440ms) and is the first thing to
   optimise if the chain ever needs to be faster. The solver is 53ms.
3. **Concurrency is the whole story.** 20 users on one worker is 18x worse
   than 1 user; four workers recover most of it. Quote the 0.44s only
   alongside its single-user condition.

`/score` is also the pessimistic step: a planner dispatching against scores
that already exist walks steps 2-4 only, which is **~81ms** at one user.
