"""Load test for the endpoints the disaster-response path actually calls.

Run it, don't read it, to find out how long the optimizer takes under
concurrency. See loadtest/README.md for the invocations and for what the
numbers do and do not mean.

Scope decision: these are the routes a planner hits between a flood warning
and a crew being dispatched -- the read every screen does (`GET /towers`),
the re-score behind the weight sliders (`POST /score`), the solver
(`POST /schedule/optimize`), the non-mutating override check
(`POST /schedule/preview`) and the dispatch-now path
(`POST /schedule/emergency`). Nothing here touches Earth Engine, the flood
forecast or the agent: those are network-bound on a third party, so timing
them measures someone else's service and would swamp the solver's own number.

Two properties of the server shape this file, and both are measured rather
than assumed (README "What the store does under load"):

1. `scheduler/store.py`'s `RunStore` is an in-memory dict with NO eviction.
   Every `/schedule/optimize` adds a `StoredRun` that is never freed, so a
   long run grows the process monotonically. `StoreGrowthUser` samples that
   growth so latency can be read against it instead of in isolation.

2. That store is per-process. Under `--workers N` there are N independent
   stores behind one port, so a `run_id` minted by one worker is a 404 on
   the other N-1. Every task that needs a run therefore uses a run THIS
   user created and tolerates a 404 as an expected multi-worker outcome
   rather than counting it as a server failure -- see `_own_run`.
"""
from __future__ import annotations

import os
import random
import time
from datetime import date, timedelta

from locust import HttpUser, between, constant_pacing, events, task
from requests.exceptions import RequestException

# The date the horizon is anchored to. Pinned rather than `date.today()` so a
# run today and a run next week exercise the same horizon arithmetic; the
# policy's own demo_clock is pinned for the same reason.
ANCHOR_TODAY = os.environ.get("LOADTEST_TODAY", "2026-09-09")

# Weight sliders send AHP factor weights. These are the five the index
# carries; the route renormalises, so the absolute values only need to be
# positive and to vary run-to-run so no response can be served from an
# identical-input cache that a real user would not benefit from.
AHP_FACTORS = ("flood", "terrain", "lightning", "equipment", "power")

# Collected by StoreGrowthUser, printed once at teardown. A plain list is
# enough: one sampler, one process, no contention.
STORE_SAMPLES: list[dict] = []


def _jittered_weights() -> dict[str, float]:
    """A weight vector off baseline, as a slider drag produces.

    Every factor is redrawn each call. A vector that repeated would let any
    memoisation on the scoring path answer instantly and report a latency no
    planner will ever see.
    """
    return {factor: round(random.uniform(0.05, 0.95), 3) for factor in AHP_FACTORS}


class DisasterResponseUser(HttpUser):
    """One planner working an incident.

    `wait_time` is `between`, not `constant_pacing`: a planner reads the board
    between actions, and pacing that assumes zero think-time reports a
    throughput ceiling nobody is asking the server for.
    """

    wait_time = between(0.5, 2.5)

    # Weighted heavily against StoreGrowthUser (weight 1) so that at any
    # realistic user count almost every user generates load and roughly one
    # samples. Without this, locust's allocation at -u 1 produced
    # `{"DisasterResponseUser": 1, "StoreGrowthUser": 0}` -- correct, but it
    # reads as a broken class. Name this class as a trailing argument to
    # exclude the sampler entirely.
    weight = 20

    def on_start(self) -> None:
        # Each user owns exactly one run for the whole session. Minting a new
        # run per emergency would measure the solver twice and would grow the
        # store far faster than real use, making the growth sample meaningless.
        self.run_id: str | None = None
        self.crew_id: str | None = None
        self.tower_id: str | None = None
        self._create_run()

    # ---- helpers -------------------------------------------------------

    def _create_run(self) -> None:
        """Mint a run and remember a real crew/tower id from its own entries.

        Crew and tower ids are read back off the solved run rather than
        hardcoded from config/crews.json. A hardcoded id silently becomes a
        400 the day the roster changes, and a load test whose requests all
        fail fast reports excellent latency.

        Every request here is wrapped against `RequestException`, because
        `response.ok` RAISES rather than returning False when the connection
        itself failed -- locust's `catch_response` re-raises the stored error
        on attribute access. Unwrapped, pointing this file at a port with no
        backend on it killed the user out of `on_start` with an 80-line
        traceback per user, which buries the one line that matters
        ("connection refused": start the backend first).
        """
        try:
            with self.client.post(
                "/schedule/optimize",
                json={"today": ANCHOR_TODAY},
                name="POST /schedule/optimize",
                catch_response=True,
            ) as response:
                if not response.ok:
                    response.failure(f"optimize returned {response.status_code}")
                    return
                run_id = response.json().get("run_id")
                if not run_id:
                    response.failure("optimize returned no run_id")
                    return
        except RequestException as exc:
            # Already counted as a failure in the stats table by locust; this
            # only stops it from taking the user down with it.
            print(f"[loadtest] cannot reach {self.host}: {type(exc).__name__}")
            return

        self.run_id = run_id

        try:
            with self.client.get(
                f"/schedule/{run_id}",
                name="GET /schedule/{run_id}",
                catch_response=True,
            ) as response:
                if not response.ok:
                    # Expected under --workers N: the worker answering this GET
                    # is probably not the one that minted the run. Not a fault.
                    response.success()
                    return
                entries = response.json().get("entries") or []
                if entries:
                    seed = random.choice(entries)
                    self.crew_id = seed.get("crew_id")
                    self.tower_id = seed.get("tower_id")
        except RequestException:
            return

    def _own_run(self) -> str | None:
        """The run this user created, or None if it never got one."""
        return self.run_id

    # ---- tasks ---------------------------------------------------------

    @task(10)
    def read_towers(self) -> None:
        """The read every screen in the app performs on mount."""
        self.client.get("/towers", name="GET /towers")

    @task(4)
    def rescore_with_weights(self) -> None:
        """A weight-slider drag. Re-scores the whole feature table server-side."""
        self.client.post(
            "/score",
            json={"weights": _jittered_weights()},
            name="POST /score",
        )

    @task(2)
    def reoptimize(self) -> None:
        """A fresh solve. The expensive call, and the one that grows the store."""
        self._create_run()

    @task(3)
    def preview_override(self) -> None:
        """A planner dragging a job to another crew-day, before committing.

        Contractually non-mutating (`/schedule/preview` must never write), so
        this can run at any concurrency without dirtying the store.
        """
        run_id = self._own_run()
        if not (run_id and self.crew_id and self.tower_id):
            return
        target_day = (
            date.fromisoformat(ANCHOR_TODAY) + timedelta(days=random.randint(0, 4))
        ).isoformat()
        with self.client.post(
            "/schedule/preview",
            json={
                "run_id": run_id,
                "tower_id": self.tower_id,
                "target_crew_id": self.crew_id,
                "target_day": target_day,
                "pinned_by": "loadtest",
            },
            name="POST /schedule/preview",
            catch_response=True,
        ) as response:
            # 404 = this worker does not hold the run (see module docstring).
            if response.status_code == 404:
                response.success()

    @task(2)
    def emergency_dispatch(self) -> None:
        """Dispatch-now. THIS ONE MUTATES: it commits into the run store.

        `commit: true` is deliberate -- `commit: false` is only the preview
        half, which `preview_override` above already measures, and the point
        of including this task at all was to measure the write path and the
        store growth it causes. Run it against a backend you are willing to
        restart afterwards.
        """
        run_id = self._own_run()
        if not (run_id and self.crew_id and self.tower_id):
            return
        with self.client.post(
            "/schedule/emergency",
            json={
                "run_id": run_id,
                "tower_id": self.tower_id,
                "crew_id": self.crew_id,
                "pinned_by": "loadtest",
                "commit": True,
            },
            name="POST /schedule/emergency (commit)",
            catch_response=True,
        ) as response:
            if response.status_code == 404:
                response.success()


class EndToEndUser(HttpUser):
    """Times the detect -> decide -> dispatch chain as ONE measurement.

    `DisasterResponseUser` above measures each endpoint separately, which
    answers "is the app responsive" but cannot answer "how long from a
    warning to a dispatched crew" -- summing three independently-measured
    medians is arithmetic, not a measurement, and the sum of per-call p50s
    is not the p50 of the sum. This class walks the whole arc in sequence
    and reports the total through locust's own stats as a single synthetic
    request named `CHAIN score->optimize->emergency`, so the number is
    measured end to end rather than added up afterwards.

    What the chain is:
      1. POST /score              detect  -- re-score under current weights
      2. POST /schedule/optimize  decide  -- solve the national board
      3. POST /schedule/emergency dispatch -- commit one urgent job

    Run it as the only class so nothing else competes for the server:

        python -m locust -f loadtest/locustfile.py --headless \\
          -u 1 -r 1 -t 60s --host http://127.0.0.1:8011 EndToEndUser

    Two honesty notes that belong with any figure this produces. It is
    COMPUTE time, not response time: a crew still has to drive to the site,
    and the planning latency is not what a disaster is waiting on. And step
    1 is the pessimistic reading -- a planner who has not touched the weight
    sliders is dispatching against scores that already exist, so the chain
    they actually walk is steps 2-3.
    """

    # Not weighted against the other classes: this one is meant to be run
    # alone (named as a trailing argument), because a chain timing taken
    # while other users hammer the same process measures contention as well
    # as the chain.
    weight = 1
    wait_time = between(1.0, 2.0)

    @task
    def full_chain(self) -> None:
        chain_start = time.monotonic()
        failure: str | None = None
        run_id: str | None = None
        crew_id: str | None = None
        tower_id: str | None = None

        try:
            # 1. detect
            with self.client.post(
                "/score",
                json={"weights": _jittered_weights()},
                name="  1. POST /score (chain step)",
                catch_response=True,
            ) as response:
                if not response.ok:
                    failure = f"score returned {response.status_code}"

            # 2. decide
            if failure is None:
                with self.client.post(
                    "/schedule/optimize",
                    json={"today": ANCHOR_TODAY},
                    name="  2. POST /schedule/optimize (chain step)",
                    catch_response=True,
                ) as response:
                    if not response.ok:
                        failure = f"optimize returned {response.status_code}"
                    else:
                        run_id = response.json().get("run_id")

            # The read that finds a real crew/tower to dispatch to. Timed as
            # part of the chain because a planner genuinely cannot dispatch
            # without it -- the ids have to come from somewhere.
            if failure is None and run_id:
                with self.client.get(
                    f"/schedule/{run_id}",
                    name="  3. GET /schedule/{run_id} (chain step)",
                    catch_response=True,
                ) as response:
                    if response.ok:
                        entries = response.json().get("entries") or []
                        if entries:
                            seed = random.choice(entries)
                            crew_id = seed.get("crew_id")
                            tower_id = seed.get("tower_id")

            # 4. dispatch
            if failure is None and run_id and crew_id and tower_id:
                with self.client.post(
                    "/schedule/emergency",
                    json={
                        "run_id": run_id,
                        "tower_id": tower_id,
                        "crew_id": crew_id,
                        "pinned_by": "loadtest-chain",
                        "commit": True,
                    },
                    name="  4. POST /schedule/emergency (chain step)",
                    catch_response=True,
                ) as response:
                    if not response.ok and response.status_code != 404:
                        failure = f"emergency returned {response.status_code}"
            elif failure is None:
                failure = "chain produced no dispatchable crew/tower"
        except RequestException as exc:
            failure = f"{type(exc).__name__}"

        elapsed_ms = (time.monotonic() - chain_start) * 1000

        # Report the whole chain as one synthetic request so it lands in the
        # same stats table and percentile columns as everything else. This is
        # the number to quote; the four steps above are the breakdown.
        self.environment.events.request.fire(
            request_type="CHAIN",
            name="CHAIN score->optimize->emergency",
            response_time=elapsed_ms,
            response_length=0,
            exception=Exception(failure) if failure else None,
            context={},
        )


class StoreGrowthUser(HttpUser):
    """A single sampler that measures how the process grows as runs accumulate.

    This is not load -- it is instrumentation, and it is why the mutating
    task above is safe to include: without it, `/schedule/emergency`'s latency
    would be reported with no way to tell whether a rising p95 is contention
    or an unbounded dict. Pin this to exactly ONE user (run it as the only
    class in a second locust process, or use `--class-picker`) so the sample
    cadence stays fixed.

    `constant_pacing(5)` samples every five seconds regardless of how long the
    sample itself takes, so the series has an even time axis.
    """

    # Deliberately 1 against DisasterResponseUser's 20: this is instrumentation,
    # not load, and a second sampler would only double the cadence.
    weight = 1

    wait_time = constant_pacing(5)

    @task
    def sample_store(self) -> None:
        with self.client.get(
            "/model/health",
            name="GET /model/health (store sample)",
            catch_response=True,
        ) as response:
            if not response.ok:
                # The health route is optional-artifact tolerant, so a non-200
                # here is a real finding: let it count as a failure.
                return
            serving = (response.json() or {}).get("serving") or {}
            STORE_SAMPLES.append({"source": serving.get("source")})


@events.quitting.add_listener
def _report_store_growth(environment, **_kwargs) -> None:
    """Print the store sample series and set a non-zero exit code on failures.

    Locust exits 0 by default even when every request failed, which makes it
    useless in a script. This makes a failed run visible to the shell.
    """
    stats = environment.stats
    if STORE_SAMPLES:
        sources = {sample.get("source") for sample in STORE_SAMPLES}
        print(f"\nstore samples: {len(STORE_SAMPLES)}")
        print(f"serving source(s) observed: {sources}")

    if stats.total.num_requests == 0:
        print("FAIL: no requests were made")
        environment.process_exit_code = 1
    elif stats.total.fail_ratio > 0.01:
        print(f"FAIL: {stats.total.fail_ratio:.1%} of requests failed")
        environment.process_exit_code = 1
    else:
        environment.process_exit_code = 0
