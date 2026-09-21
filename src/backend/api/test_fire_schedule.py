"""Reviewed fire-exposure inspections, through the schedule routes.

Network-free: `thermal.exposure.screen_towers` is replaced by a stub returning a
body the real `_exposure_body` built, so the shape cannot drift from the one the
route reads, and nothing here reaches Earth Engine. It is patched on
`api.routes.schedule`, not on `thermal.exposure` — the route does `from
thermal.exposure import screen_towers` and therefore holds its own reference,
which patching the defining module would leave untouched.

The population is the deterministic synthetic fixture (USE_FIXTURE=1, via the
same monkeypatch idiom as scheduler/test_optimize.py), whose 500 towers all sit
in Selangor. That is what makes the territory and crew-type refusals checkable:
the roster carries civil crews in sixteen territories, so a wrong one is one
crew_id away.

What is being pinned here is a set of refusals. An ordinary pin is never
validated — the planner holds information the model does not — but a fire
inspection is NEW work the optimizer never proposed, raised against a watch or
ok tower on evidence a satellite produced, so every way that could go wrong has
to have a number attached to it.

Run from src/backend:  python3 api/test_fire_schedule.py   (or via pytest)
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from thermal.exposure import STALE_AFTER_HOURS, FireSnapshot, _exposure_body

# The run is anchored here rather than on policy.yaml's demo_clock (2026-08-17),
# which is the whole point of one of the tests below: an override used to
# re-solve against the demo clock and hand back a horizon the pinned entry was
# not in.
RUN_TODAY = "2026-09-09"

# How many towers the screening claims to have looked at. Any number; it is the
# denominator the panel reports, and nothing in the route reads it.
SCREENED = 1164


def _utc_today() -> str:
    """Read per call, never at import: a suite that starts before midnight UTC
    and reaches this test after it would otherwise post yesterday's snapshot
    date and hit the 409 that exists for exactly that."""
    return datetime.now(timezone.utc).date().isoformat()


def _exposure(tower_ids, *, date=None, age_hours=2.0, pixel_days=3, confidence=1) -> dict:
    """A /fire/exposure body, built by the module that builds the real one.

    Constructed through `_exposure_body` rather than typed out, so a change to
    the body's shape breaks these tests instead of letting them keep asserting
    against a body the route no longer receives.
    """
    date = date or _utc_today()
    now = datetime.now(timezone.utc)
    acquired = now - timedelta(hours=age_hours)
    snapshot = FireSnapshot(
        snapshot_id=f"viirs-{date}-000000000000",
        date=date,
        window_start="2026-09-09",
        window_end="2026-09-12",
        granules=2,
        granule_ids=("2026252", "2026253"),
        latest_acquisition=acquired.strftime("%Y-%m-%dT%H:%M:%SZ"),
        built_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    observations = [
        {
            "tower_id": tower_id,
            "pixel_days_sum": pixel_days,
            "max_conf_max": confidence,
            "latest_epoch_max": acquired.timestamp(),
        }
        for tower_id in tower_ids
    ]
    towers = [{"tower_id": f"MY_{i}"} for i in range(SCREENED)]
    return _exposure_body(snapshot, towers, observations, now=now)


class _Console:
    """A TestClient plus the screening answer the route will see."""

    def __init__(self, client: TestClient):
        self.client = client
        self.exposure: dict | None = None

    def screening(self, exposure: dict | None) -> dict | None:
        """Set what `screen_towers` returns. None means "we could not ask"."""
        self.exposure = exposure
        return exposure

    def run(self, today: str = RUN_TODAY) -> tuple[str, dict]:
        run_id = self.client.post("/schedule/optimize", json={"today": today}).json()["run_id"]
        return run_id, self.client.get(f"/schedule/{run_id}").json()

    def pin(self, run_id, tower_id, *, crew="SEL-C1", day=None, snapshot_id=None, safe=True,
            fire=True, endpoint="pin"):
        body = {
            "run_id": run_id,
            "tower_id": tower_id,
            "target_crew_id": crew,
            "target_day": day,
        }
        if fire:
            current = self.exposure["snapshot_id"] if self.exposure else ""
            body["fire_inspection"] = {
                "snapshot_id": snapshot_id if snapshot_id is not None else current,
                "safe_access_confirmed": safe,
            }
        return self.client.post(f"/schedule/{endpoint}", json=body)


@pytest.fixture
def console(monkeypatch):
    """USE_FIXTURE=1 and a stubbed screening, both undone when the test ends.

    monkeypatch rather than a bare `os.environ[...] = "1"`: an unrestored
    USE_FIXTURE leaked into every later module in the same pytest process once
    already, which made results depend on file order.
    """
    monkeypatch.setenv("USE_FIXTURE", "1")

    import api.routes.schedule as schedule_route
    from api.main import app

    console = _Console(TestClient(app))
    # Patched where it is USED. api/routes/schedule.py imports the NAME, so the
    # route holds its own reference and patching thermal.exposure would leave it
    # pointing at the real, network-touching function.
    monkeypatch.setattr(schedule_route, "screen_towers", lambda date: console.exposure)
    return console


def _reviewable_tower() -> str:
    """A tower the optimizer never gave work to — the case this feature is for.

    A fire inspection is raised against whatever the satellite saw, and the
    satellite does not know the decision bands. Most such towers are watch or
    ok, which is why `_resolve_work_orders` has to synthesise a record for them
    at all.
    """
    from fixtures.source import scored_towers

    return next(t["tower_id"] for t in scored_towers() if t["decision"] != "maintain")


# --------------------------------------------------------------------------
# The happy path, and what has to reach the wire with it
# --------------------------------------------------------------------------


def test_a_watch_band_tower_can_be_scheduled_for_a_reviewed_inspection(console):
    """The feature, end to end: a tower with no work order gets one.

    Not through propose_action() — that keys on dominant_factor, and no tower
    ever carries a fire one. The work order's `why` is an EVIDENCE sentence, and
    it must stay one: a share would put a satellite observation into the score's
    own language.
    """
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    exposure = console.screening(_exposure([tower_id], pixel_days=21))

    response = console.pin(run_id, tower_id, day=run["horizon"][1])
    assert response.status_code == 200, response.json()

    entry = next(e for e in response.json()["entries"] if e["tower_id"] == tower_id)
    work_order = entry["work_order"]
    assert work_order["action"] == "fire_exposure_inspection"
    assert work_order["crew_type"] == "civil"
    assert work_order["urgency_days"] == 7, "target_days from actions.yaml, not the tower"
    assert "21 hotspot detection-days within 5 km" in work_order["why"]
    assert "safe access confirmed" in work_order["why"]
    # No share, no band, no factor anywhere in the sentence.
    assert "attribution" not in work_order["why"]

    # Pydantic silently drops undeclared keys, so this assertion is the only
    # thing standing between the evidence and a work order that says a planner
    # reviewed something the browser cannot show.
    evidence = work_order["fire_inspection"]
    assert evidence["snapshot_id"] == exposure["snapshot_id"]
    assert evidence["hotspot_pixel_days"] == 21
    assert evidence["max_confidence"] == "nominal"
    assert evidence["buffer_m"] == 5000
    assert evidence["window_days"] == 3
    assert evidence["reviewed"] is True and evidence["safe_access_confirmed"] is True


def test_the_evidence_is_built_server_side_not_taken_from_the_request(console):
    """The request body carries only which snapshot was reviewed.

    A client that could post its own pixel-day count could post any number, and
    the work order's `why` would then assert an observation nobody made.
    """
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id], pixel_days=4, confidence=2))

    response = console.client.post(
        "/schedule/pin",
        json={
            "run_id": run_id,
            "tower_id": tower_id,
            "target_crew_id": "SEL-C1",
            "target_day": run["horizon"][1],
            "fire_inspection": {
                "snapshot_id": console.exposure["snapshot_id"],
                "safe_access_confirmed": True,
                # Ignored — not a declared field, and the route never reads it.
                "hotspot_pixel_days": 999,
            },
        },
    )
    assert response.status_code == 200
    entry = next(e for e in response.json()["entries"] if e["tower_id"] == tower_id)
    assert entry["work_order"]["fire_inspection"]["hotspot_pixel_days"] == 4
    assert entry["work_order"]["fire_inspection"]["max_confidence"] == "high"


def test_the_reviewed_snapshot_is_recorded_in_the_override_log(console):
    # The work order is rebuilt on every re-solve; the log is the record that a
    # planner reviewed THIS snapshot and attested to access at this moment.
    from scheduler.store import run_store

    run_id, run = console.run()
    tower_id = _reviewable_tower()
    exposure = console.screening(_exposure([tower_id]))
    assert console.pin(run_id, tower_id, day=run["horizon"][1]).status_code == 200

    logged = run_store.get(run_id).override_log[-1]
    assert logged["tower_id"] == tower_id
    assert logged["fire_inspection"] == {
        "snapshot_id": exposure["snapshot_id"],
        "safe_access_confirmed": True,
    }


# --------------------------------------------------------------------------
# Refusals. Each is a different statement and carries a different code.
# --------------------------------------------------------------------------


def test_an_unconfirmed_safe_access_is_refused(console):
    """400, and first — before anything is screened or built.

    A hotspot within the buffer may still be burning, and nothing in this system
    can see whether the site is reachable.
    """
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id]))

    response = console.pin(run_id, tower_id, day=run["horizon"][1], safe=False)
    assert response.status_code == 400
    assert "safe access must be confirmed" in response.json()["detail"]


def test_screening_being_unavailable_is_a_503_not_a_refusal(console):
    """None means "we could not ask", and the route must say so.

    A 409 here would read as "there is nothing to inspect", which is the one
    thing an unavailable feed cannot tell you.
    """
    run_id, run = console.run()
    console.screening(None)

    response = console.pin(run_id, _reviewable_tower(), day=run["horizon"][1])
    assert response.status_code == 503
    assert "not a statement that nothing is burning" in response.json()["detail"]


def test_a_snapshot_from_another_day_is_refused(console):
    # Historical windows stay browsable on the map; scheduling against one would
    # dispatch a crew on evidence that has had days to stop being true.
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id], date="2026-01-01"))

    response = console.pin(run_id, tower_id, day=run["horizon"][1])
    assert response.status_code == 409
    assert "today's snapshot" in response.json()["detail"]


def test_a_changed_snapshot_expires_the_review(console):
    """The id IS the expiry. A new granule or a moved window changes it.

    Without this a planner could review Monday's hotspots, leave the tab open,
    and schedule against them on Thursday with nothing on screen having moved.
    """
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id]))

    response = console.pin(
        run_id, tower_id, day=run["horizon"][1], snapshot_id="viirs-2026-09-08-aaaaaaaaaaaa"
    )
    assert response.status_code == 409
    assert "changed since this review" in response.json()["detail"]


def test_a_stale_source_is_refused_and_the_age_is_named(console):
    # 48 h is one whole missed publication. The refusal names the measured age
    # rather than just saying "stale", because the planner's next question is
    # how old.
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id], age_hours=STALE_AFTER_HOURS + 12))

    response = console.pin(run_id, tower_id, day=run["horizon"][1])
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "60.0 h old" in detail and f"{STALE_AFTER_HOURS} h limit" in detail


def test_a_tower_with_no_detections_has_nothing_to_inspect(console):
    # The quiet answer, not the unavailable one: a populated body whose `towers`
    # map does not carry this tower. It is a 409 rather than a 400 because the
    # request was well formed and the evidence simply is not there.
    run_id, run = console.run()
    console.screening(_exposure([]))

    response = console.pin(run_id, _reviewable_tower(), day=run["horizon"][1])
    assert response.status_code == 409
    assert "no fire detections within 5 km" in response.json()["detail"]


def test_a_tower_with_a_standing_work_order_is_never_overwritten(console):
    """409, naming the work that is already there.

    work_orders_by_tower is keyed by tower_id and override.py reads it with a
    bare subscript, so writing a second order under that key does not add work —
    it REPLACES it, and the crew arrives to raise a cabinet on a site the
    planner sent them to inspect.
    """
    run_id, run = console.run()
    scheduled = run["entries"][0]["tower_id"]
    console.screening(_exposure([scheduled]))

    response = console.pin(run_id, scheduled, day=run["horizon"][1])
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "already has a" in detail and "cannot replace it" in detail


def test_an_unscheduled_tower_still_occupies_its_work_order_key(console):
    """The half of that rule that is easy to miss.

    An unscheduled tower has no entry on the board, so it looks free — but it
    still holds a real pending job that the solver feeds back through on every
    re-solve, and replacing it would drop that work silently.
    """
    run_id, run = console.run()
    assert run["unscheduled"], "the fixture must leave something unscheduled"
    unscheduled = run["unscheduled"][0]
    console.screening(_exposure([unscheduled]))

    response = console.pin(run_id, unscheduled, day=run["horizon"][1])
    assert response.status_code == 409
    assert "already has a" in response.json()["detail"]


def test_a_day_outside_the_runs_horizon_is_refused(console):
    # Both directions. A day the board cannot draw is a 400 whichever side of
    # the horizon it falls on — the past-day case is caught by the membership
    # test first, since a past day is not in the horizon either.
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id]))

    for day in ("2026-09-01", "2026-12-01"):
        response = console.pin(run_id, tower_id, day=day)
        assert response.status_code == 400, day
        assert "outside this run's horizon" in response.json()["detail"]


def test_a_crew_that_cannot_do_the_job_is_refused(console):
    # A fire inspection is civil work. Booking a power or RF crew for it is the
    # one thing that must not happen quietly, because the optimizer never
    # proposed this job and has no other check on it.
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id]))

    response = console.pin(run_id, tower_id, crew="SEL-P1", day=run["horizon"][1])
    assert response.status_code == 400
    assert "needs a civil crew" in response.json()["detail"]


def test_a_crew_in_another_territory_is_refused(console):
    # The synthetic population is entirely Selangor; KEL-C1 is a civil crew in
    # Kelantan, so this isolates territory from crew type.
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id]))

    response = console.pin(run_id, tower_id, crew="KEL-C1", day=run["horizon"][1])
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "covers Kelantan" in detail and "is in Selangor" in detail


def test_an_unknown_crew_is_a_404(console):
    # Not a 400: a crew id that does not exist is not a bad choice of crew, and
    # retrying it will never succeed.
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id]))

    response = console.pin(run_id, tower_id, crew="NO-SUCH-CREW", day=run["horizon"][1])
    assert response.status_code == 404
    assert "not found" in response.json()["detail"]


def test_preview_refuses_on_the_same_terms_as_pin(console):
    # The validation lives on both handlers, not just the committing one — a
    # preview that renders a cost for work pin would refuse is worse than no
    # preview.
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id]))

    assert (
        console.pin(
            run_id, tower_id, crew="SEL-P1", day=run["horizon"][1], endpoint="preview"
        ).status_code
        == 400
    )
    assert (
        console.pin(
            run_id, tower_id, day=run["horizon"][1], safe=False, endpoint="preview"
        ).status_code
        == 400
    )


# --------------------------------------------------------------------------
# Mutation rules
# --------------------------------------------------------------------------


def test_preview_does_not_mutate_the_stored_run(console):
    """The separation the whole override UX rests on.

    _resolve_work_orders returns copies precisely so this path can build the
    fire work order without persisting it; only pin_override writes them back.
    """
    from scheduler.store import run_store

    run_id, run = console.run()
    tower_id = _reviewable_tower()
    console.screening(_exposure([tower_id]))

    before = console.client.get(f"/schedule/{run_id}").json()
    response = console.pin(run_id, tower_id, day=run["horizon"][1], endpoint="preview")
    assert response.status_code == 200
    assert set(response.json()) == {
        "moved",
        "dropped",
        "risk_weighted_wait_before",
        "risk_weighted_wait_after",
    }

    assert console.client.get(f"/schedule/{run_id}").json() == before
    stored = run_store.get(run_id)
    assert tower_id not in stored.work_orders_by_tower
    assert stored.override_log == []


def test_a_fire_inspection_can_be_moved_and_keeps_its_evidence(console):
    """A move carries no fire body, and that is what makes it a move.

    Re-running the snapshot checks on a drag from Tuesday to Thursday would make
    a planner re-review evidence they already reviewed, and would fail outright
    the moment a new granule landed between the two actions.
    """
    run_id, run = console.run()
    tower_id = _reviewable_tower()
    exposure = console.screening(_exposure([tower_id], pixel_days=9))
    assert console.pin(run_id, tower_id, day=run["horizon"][1]).status_code == 200

    # The snapshot has since moved on. The move must not care.
    console.screening(_exposure([], date="2026-01-01", age_hours=500))
    moved = console.pin(run_id, tower_id, crew="SEL-C2", day=run["horizon"][3], fire=False)
    assert moved.status_code == 200

    entry = next(e for e in moved.json()["entries"] if e["tower_id"] == tower_id)
    assert (entry["crew_id"], entry["day"]) == ("SEL-C2", run["horizon"][3])
    assert entry["work_order"]["action"] == "fire_exposure_inspection"
    assert entry["work_order"]["fire_inspection"]["snapshot_id"] == exposure["snapshot_id"]
    assert entry["work_order"]["fire_inspection"]["hotspot_pixel_days"] == 9


def test_a_pin_re_solves_against_the_runs_own_start_not_the_demo_clock(console):
    """The verified bug this fix exists for, pinned in both directions.

    preview/pin/emergency never passed `today=`, so Optimizer.optimize fell back
    to policy demo_clock.today. Measured: a run optimised for 2026-09-09 came
    back from POST /schedule/pin with its horizon reset to 2026-08-17..08-23 and
    the pinned entry — still on 2026-09-09 — the only entry outside the horizon
    it was returned with, so the week strip, which tabs from run.horizon, could
    not draw the very job the planner had just pinned.

    This is an ORDINARY pin. The demo clock is not a fire question, and the fix
    is load-bearing for every override.
    """
    from scheduler.config_loader import load_policy

    demo_today = load_policy()["demo_clock"]["today"]
    assert demo_today != RUN_TODAY, "the run must be anchored away from the demo clock"

    run_id, run = console.run()
    assert run["horizon"][0] == RUN_TODAY
    tower_id = run["unscheduled"][0]
    day = run["horizon"][1]

    response = console.pin(run_id, tower_id, day=day, fire=False)
    assert response.status_code == 200
    body = response.json()

    assert body["horizon"] == run["horizon"], f"horizon reset to the demo clock: {body['horizon']}"
    assert body["horizon"][0] == RUN_TODAY
    pinned = next(e for e in body["entries"] if e["tower_id"] == tower_id)
    assert pinned["day"] in body["horizon"], "the pinned entry must be inside its own horizon"
    assert all(entry["day"] in body["horizon"] for entry in body["entries"])


# --------------------------------------------------------------------------
# The hard constraint: fire is beside the score, never inside it
# --------------------------------------------------------------------------


def test_scored_towers_carry_no_fire_key_and_their_attribution_is_untouched(console):
    """Nothing in thermal/ may reach a tower record.

    `attribution` is documented as "factor -> share, sums to 1.0" and
    `dominant_factor` is its argmax, which SELECTS AN INTERVENTION. A fire key
    there would turn an observed thermal anomaly into a work order the model
    never asked for, which is the one thing this feature must not do.
    """
    towers = console.client.get("/towers").json()
    assert towers

    for tower in towers:
        assert not any(key.startswith("fire") for key in tower), tower["tower_id"]
        assert set(tower["attribution"]) == {
            "flood",
            "power",
            "terrain",
            "equipment",
            "lightning",
        }
        # To within the wire rounding, not exactly: every share is emitted at
        # four decimal places, so five factors can drift up to 2.5e-4 from 1.0
        # (measured on this fixture: 0.9999). The point of the assertion is that
        # the shares still normalise over the SAME five factors they always did.
        assert abs(sum(tower["attribution"].values()) - 1.0) < 5e-4
        assert tower["dominant_factor"] in tower["attribution"]
        assert tower["decision"] in {"maintain", "watch", "ok"}


def test_a_scheduled_inspection_leaves_the_towers_score_alone(console):
    """The record the board reads is the record the model produced.

    propose_fire_inspection copies `risk` across and sets dominant_factor to the
    empty string rather than a fire value — so nothing downstream can read the
    inspection as an attribution.
    """
    from scheduler.store import run_store

    run_id, run = console.run()
    tower_id = _reviewable_tower()
    before = next(t for t in console.client.get("/towers").json() if t["tower_id"] == tower_id)
    console.screening(_exposure([tower_id]))

    assert console.pin(run_id, tower_id, day=run["horizon"][1]).status_code == 200

    after = next(t for t in console.client.get("/towers").json() if t["tower_id"] == tower_id)
    assert after == before

    work_order = run_store.get(run_id).work_orders_by_tower[tower_id]
    assert work_order["dominant_factor"] == "", "a fire inspection has no dominant factor"
    assert work_order["risk"] == before["risk"]


if __name__ == "__main__":
    # Delegates to pytest rather than calling each test_* in globals() directly:
    # every test here takes the `console` fixture, which only a real pytest run
    # can supply. Same standalone entry point as scheduler/test_optimize.py.
    raise SystemExit(pytest.main([__file__, "-v"]))
