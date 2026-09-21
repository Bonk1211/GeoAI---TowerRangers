"""Schedule endpoints (Backend_Handoff §6):

POST /schedule/optimize      -> { run_id }
GET  /schedule/{run_id}      -> ScheduleRun
GET  /schedule/why/{entry}   -> WhySlot            deterministic, no LLM
POST /schedule/preview       -> OverridePreview    no mutation
POST /schedule/pin           -> ScheduleRun        commit + re-solve
POST /schedule/emergency     -> OverridePreview | ScheduleRun
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, HTTPException

from api.schemas import (
    EmergencyRequest,
    FireInspectionRequest,
    OptimizeRequest,
    OptimizeResponse,
    OverridePreviewOut,
    PinRequest,
    PreviewRequest,
    ScheduleRunOut,
    WhySlotOut,
)
from thermal.exposure import SCREEN_BUFFER_M, STALE_AFTER_HOURS, screen_towers
from fixtures.source import scored_towers
from scheduler.actions import (
    FIRE_INSPECTION_KEY,
    load_action_map,
    propose_actions,
    propose_fire_inspection,
)
from scheduler.explain import explain_slot
from scheduler.optimize import Optimizer
from scheduler.override import OverrideEngine
from scheduler.store import StoredRun, run_store
from scheduler.travel import get_matrix

router = APIRouter(tags=["schedule"])

# The action string a fire inspection carries, read from config rather than
# retyped: config/actions.yaml is the authority, and a literal here would let
# the two drift while every test still passed.
FIRE_INSPECTION_ACTION = load_action_map()[FIRE_INSPECTION_KEY]["action"]

_optimizer = Optimizer()
_override_engine = OverrideEngine(_optimizer)


def _run_to_response(run: StoredRun) -> ScheduleRunOut:
    # StoredRun.to_dict() is the single wire serialisation, shared with the
    # agent's optimize_schedule tool so the two cannot drift apart again.
    #
    # travel_source is attached here rather than stored on the run: it is a
    # property of THIS PROCESS's loaded artefact, not of the solve. A run
    # restored in a process with no matrix must not claim measured distances.
    return ScheduleRunOut(
        **run.to_dict(),
        travel_source="matrix" if get_matrix().available else "haversine",
    )


def _get_run_or_404(run_id: str) -> StoredRun:
    run = run_store.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"schedule run {run_id!r} not found")
    return run


def _run_today(run: StoredRun) -> date | None:
    """The run's own first day, which is the only "today" it was ever solved against.

    Without this every override re-solved against policy demo_clock.today. Measured:
    a run optimised for 2026-09-09 came back from POST /schedule/pin with its horizon
    reset to 2026-08-17..08-23 and the pinned entry — still on 2026-09-09 — the only
    entry outside the horizon it was returned with, so the week strip, which tabs from
    run.horizon, could not draw the very job the planner had just pinned.

    Returns None for a run with no horizon, which leaves the optimizer's demo-clock
    default standing for exactly the case it was written for.
    """
    return date.fromisoformat(run.horizon[0]) if run.horizon else None


def _utc_today() -> str:
    """Today in UTC, because the snapshot's date is a UTC acquisition day."""
    return datetime.now(timezone.utc).date().isoformat()


def _fire_evidence(run: StoredRun, tower_id: str, request: FireInspectionRequest) -> dict:
    """Re-derive the evidence a reviewed inspection is being raised against.

    Built SERVER-SIDE from the current screening and the action config, never from
    the request body: the body carries only which snapshot the planner reviewed and
    that they confirmed access. A client that could post its own pixel-day count
    could post any number, and the work order's `why` string would then assert an
    observation nobody made.

    Every refusal here is the route's, not the engine's. scheduler/override.py's
    contract is that it has no path that raises or refuses — the planner's
    instruction is taken as given — so a check that must be able to say no cannot
    live inside it.
    """
    if not request.safe_access_confirmed:
        raise HTTPException(
            status_code=400,
            detail=(
                "safe access must be confirmed before a fire-exposure inspection can "
                "be scheduled: a hotspot within the screening buffer may still be "
                "burning, and this system cannot see whether the site is reachable"
            ),
        )

    today = _utc_today()
    exposure = screen_towers(today)
    if exposure is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "fire screening is unavailable, so an inspection cannot be raised "
                "against it. This is not a statement that nothing is burning"
            ),
        )

    # Today's snapshot, not the reviewed date's. Historical windows stay browsable
    # on the map; scheduling against one would dispatch a crew on evidence that has
    # had days to stop being true.
    if exposure["date"] != today:
        raise HTTPException(
            status_code=409,
            detail=(
                f"scheduling requires today's snapshot; the current screening covers "
                f"{exposure['date']}"
            ),
        )

    if request.snapshot_id != exposure["snapshot_id"]:
        raise HTTPException(
            status_code=409,
            detail=(
                "the fire snapshot changed since this review — a new granule landed or "
                "the window moved. Refresh the evidence and review it again before "
                "scheduling"
            ),
        )

    # Detections before freshness, deliberately. A window in which nothing burned
    # anywhere has no latest acquisition, so it is reported stale AND empty at
    # once — and "the data is too old" is the wrong half to tell a planner whose
    # actual situation is that nothing was seen near this tower at all.
    observed = exposure["towers"].get(tower_id)
    if observed is None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"no fire detections within {SCREEN_BUFFER_M / 1000:g} km of "
                f"{tower_id!r} in this snapshot, so there is nothing to inspect it for"
            ),
        )

    freshness = exposure["freshness"]
    if freshness["stale"]:
        age = freshness["source_age_hours"]
        measured = (
            "of unknown age" if age is None else f"{age:.1f} h old"
        )
        raise HTTPException(
            status_code=409,
            detail=(
                f"the newest usable observation is {measured}, past the "
                f"{STALE_AFTER_HOURS} h limit for scheduling against it"
            ),
        )

    return {
        "snapshot_id": exposure["snapshot_id"],
        "observed_at": observed["latest_acquisition"],
        "hotspot_pixel_days": observed["hotspot_pixel_days"],
        "max_confidence": observed["max_confidence"],
        "buffer_m": exposure["screening"]["buffer_m"],
        "window_days": exposure["screening"]["window_days"],
        "reviewed": True,
        "safe_access_confirmed": True,
    }


def _validate_inspection_slot(run: StoredRun, tower: dict, crew_type: str, crew_id: str, day: str) -> None:
    """Crew and date checks for a reviewed inspection.

    These exist only on this path, deliberately. An ordinary pin is never validated:
    the planner holds information the model does not, and the worst case is reported
    as cost rather than refused. A fire inspection is different — it is NEW work the
    optimizer never proposed, raised against a watch or ok tower that may have no
    business being visited at all, so the one thing that must not happen is a crew
    being booked for a job it cannot do in a state it does not cover.
    """
    # Membership covers "in the past" too, and is the only check needed: the
    # horizon is the explicit list of days this run was solved for and its first
    # entry IS the run's today, so any earlier date fails here first. A separate
    # past-date branch below this one was unreachable.
    if day not in run.horizon:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{day!r} is outside this run's horizon "
                f"({run.horizon[0]}..{run.horizon[-1]}) — the board cannot draw it"
            ),
        )
    crew = next((c for c in _optimizer.crews if c["crew_id"] == crew_id), None)
    if crew is None:
        raise HTTPException(status_code=404, detail=f"crew {crew_id!r} not found")
    if crew["crew_type"] != crew_type:
        raise HTTPException(
            status_code=400,
            detail=(
                f"crew {crew_id!r} is {crew['crew_type']}; a fire-exposure inspection "
                f"needs a {crew_type} crew"
            ),
        )
    territory = tower.get("territory") or tower.get("state")
    if territory is not None and crew["territory"] != territory:
        raise HTTPException(
            status_code=400,
            detail=(
                f"crew {crew_id!r} covers {crew['territory']}; tower "
                f"{tower['tower_id']!r} is in {territory}"
            ),
        )


def _resolve_work_orders(
    run: StoredRun,
    tower_id: str,
    fire_inspection: FireInspectionRequest | None = None,
) -> tuple[dict[str, dict], dict[str, dict]]:
    """override.py's pin/preview/emergency all assume tower_id already has a
    work order and tower record in the run — true for anything the optimizer
    itself scheduled or left unscheduled, since those only ever come from the
    maintain-band population /schedule/optimize built the run from. It is NOT
    true for a tower an operator wants to dispatch that was never in that
    band (e.g. a field ticket filed against a watch/ok tower) — pin() would
    KeyError on work_orders_by_tower[tower_id], which contradicts this
    module's own "never blocked, no validation path that raises" contract
    (override.py's docstring).

    Returns (work_orders_by_tower, towers_by_id), synthesizing the missing
    tower's entry from the full scored population — same construction
    /schedule/optimize uses for the maintain band — without ever mutating the
    stored run's own dicts in place, so a preview()'s no-mutation guarantee
    holds even on this path; pin()/emergency(commit=True) persist the merged
    dicts back onto the run themselves, after the fact.
    """
    existing = run.work_orders_by_tower.get(tower_id)

    # The fire branch runs BEFORE the early return below, and that ordering is the
    # whole fix. A fire-exposed tower that happens to be in the maintain band
    # already has a flood or power work order under this key, so the early return
    # would hand the planner that job under a fire-inspection intent — the crew
    # arrives to raise a cabinet on a site the planner sent them to inspect.
    if fire_inspection is not None:
        tower = run.towers_by_id.get(tower_id) or next(
            (t for t in scored_towers() if t["tower_id"] == tower_id), None
        )
        if tower is None:
            raise HTTPException(status_code=404, detail=f"tower {tower_id!r} not found")

        action_map = load_action_map()
        spec = action_map[FIRE_INSPECTION_KEY]

        # One work order per tower is structural here: work_orders_by_tower is keyed
        # by tower_id, and override.py reads it with a bare subscript. Writing a
        # second order under the same key does not add work, it REPLACES it — and an
        # unscheduled tower still occupies that key, with a real pending job that the
        # solver feeds back through on every re-solve. So a standing order is a
        # conflict to report, never something to overwrite.
        if existing is not None and existing.get("action") != spec["action"]:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"tower {tower_id!r} already has a {existing['action']!r} work order "
                    f"in this run; a fire inspection cannot replace it. Reschedule or "
                    f"complete that work first"
                ),
            )

        evidence = _fire_evidence(run, tower_id, fire_inspection)
        wo = propose_fire_inspection(tower, evidence, action_map).to_dict()
        return (
            {**run.work_orders_by_tower, tower_id: wo},
            {**run.towers_by_id, tower_id: tower},
        )

    # No fire body on the request. An existing fire inspection therefore survives
    # untouched, evidence included — which is what makes MOVING one work without the
    # planner having to review it again.
    if existing is not None:
        return run.work_orders_by_tower, run.towers_by_id
    tower = next((t for t in scored_towers() if t["tower_id"] == tower_id), None)
    if tower is None:
        raise HTTPException(status_code=404, detail=f"tower {tower_id!r} not found")
    wo = propose_actions([tower])[0].to_dict()
    work_orders_by_tower = {**run.work_orders_by_tower, tower_id: wo}
    towers_by_id = {**run.towers_by_id, tower_id: tower}
    return work_orders_by_tower, towers_by_id


def _fire_slot_guard(run: StoredRun, req, work_orders_by_tower: dict, towers_by_id: dict) -> None:
    """Apply the crew and day checks whenever the TARGET is a fire inspection.

    Keyed on the work order, not on whether the request carried a fire body.
    Keying it on the body let the constraint be walked around in one follow-up
    request: pinning to a power crew WITH the evidence was refused 400 ("a
    fire-exposure inspection needs a civil crew"), and the identical pin without
    the evidence — which is exactly how a MOVE is spelled — succeeded, landing a
    civil work order on a power crew in another territory. Stating a rule in a
    refusal and then not holding it is worse than never stating it.

    Ordinary work orders keep the "never blocked" behaviour override.py
    documents: the planner holds information the model does not, and the worst
    case is reported as cost rather than refused. This gate is narrower on
    purpose — a fire inspection is work the optimizer never proposed, raised
    against a tower that may be in no band at all, so the one outcome worth
    refusing outright is a crew booked for a job it cannot do in a state it does
    not cover.
    """
    work_order = work_orders_by_tower.get(req.tower_id)
    if not work_order or work_order.get("action") != FIRE_INSPECTION_ACTION:
        return
    tower = towers_by_id.get(req.tower_id)
    if tower is None:
        return
    _validate_inspection_slot(
        run, tower, work_order["crew_type"], req.target_crew_id, req.target_day
    )


@router.post("/schedule/optimize", response_model=OptimizeResponse)
def optimize_schedule(req: OptimizeRequest) -> OptimizeResponse:
    # Shared with the agent tools and /schedule/baseline via
    # fixtures.source.scored_towers() so all callers agree on which tower
    # population (fixture vs. real ML adapter) is in play.
    towers = scored_towers()
    maintain = [t for t in towers if t["decision"] == "maintain"]
    if req.tower_ids is not None:
        wanted = set(req.tower_ids)
        maintain = [t for t in maintain if t["tower_id"] in wanted]

    towers_by_id = {t["tower_id"]: t for t in maintain}
    work_orders = [wo.to_dict() for wo in propose_actions(maintain)]
    work_orders_by_tower = {wo["tower_id"]: wo for wo in work_orders}

    today_date = date.fromisoformat(req.today) if req.today else None
    result = _optimizer.optimize(work_orders, towers_by_id, today=today_date)

    run = StoredRun(
        run_id=run_store.new_run_id(),
        entries=result.entries,
        unscheduled=result.unscheduled,
        risk_weighted_wait=result.risk_weighted_wait,
        horizon=result.horizon,
        reserve=result.reserve,
        unscheduled_detail=result.unscheduled_detail,
        pins=[],
        work_orders_by_tower=work_orders_by_tower,
        towers_by_id=towers_by_id,
    )
    run_store.save(run)
    return OptimizeResponse(run_id=run.run_id)


@router.get("/schedule/{run_id}", response_model=ScheduleRunOut)
def get_schedule(run_id: str) -> ScheduleRunOut:
    run = _get_run_or_404(run_id)
    return _run_to_response(run)


@router.get("/schedule/why/{entry_id}", response_model=WhySlotOut)
def why_this_slot(entry_id: str) -> WhySlotOut:
    """entry_id is the composite ScheduleEntry.entry_id: crew_id__day__tower_id.
    Deterministic — renders from stored solver state only, no agent involved
    (Backend_Handoff §7, PRD §8.1)."""
    run = run_store.latest()
    if run is None:
        raise HTTPException(status_code=404, detail="no schedule run exists yet")

    match = next((e for e in run.entries if e.entry_id == entry_id), None)
    if match is None:
        raise HTTPException(status_code=404, detail=f"schedule entry {entry_id!r} not found")

    tower = run.towers_by_id.get(match.tower_id)
    crew = next((c for c in _optimizer.crews if c["crew_id"] == match.crew_id), None)
    if tower is None or crew is None:
        raise HTTPException(status_code=500, detail="entry references unknown tower or crew")

    # The run's own start, not the demo clock. explain.py walks days forward from
    # `today`, so a September run explained against 2026-08-17 narrates three weeks
    # of skipped days that were never in its horizon.
    today = _run_today(run) or date.fromisoformat(_optimizer.policy["demo_clock"]["today"])
    ws = explain_slot(match, tower, crew, run.entries, _optimizer.policy, today=today)
    return ws.to_dict()


@router.post("/schedule/preview", response_model=OverridePreviewOut)
def preview_override(req: PreviewRequest) -> OverridePreviewOut:
    """No mutation — computes knock-on cost only (Backend_Handoff §5)."""
    run = _get_run_or_404(req.run_id)
    work_orders_by_tower, towers_by_id = _resolve_work_orders(
        run, req.tower_id, req.fire_inspection
    )
    _fire_slot_guard(run, req, work_orders_by_tower, towers_by_id)
    preview = _override_engine.preview(
        run.entries,
        run.unscheduled,
        run.pins,
        req.tower_id,
        req.target_crew_id,
        req.target_day,
        work_orders_by_tower,
        towers_by_id,
        pinned_by=req.pinned_by,
        today=_run_today(run),
    )
    return preview.to_dict()


@router.post("/schedule/pin", response_model=ScheduleRunOut)
def pin_override(req: PinRequest) -> ScheduleRunOut:
    """Commits the pin and re-solves. Never blocked — the planner's
    instruction is taken as given (Backend_Handoff §5)."""
    run = _get_run_or_404(req.run_id)
    work_orders_by_tower, towers_by_id = _resolve_work_orders(
        run, req.tower_id, req.fire_inspection
    )
    _fire_slot_guard(run, req, work_orders_by_tower, towers_by_id)

    result = _override_engine.pin(
        run.entries,
        run.pins,
        req.tower_id,
        req.target_crew_id,
        req.target_day,
        work_orders_by_tower,
        towers_by_id,
        pin_reason=req.pin_reason,
        pinned_by=req.pinned_by,
        today=_run_today(run),
    )

    new_pin = next(e for e in result.entries if e.tower_id == req.tower_id)
    run.pins = [p for p in run.pins if p.tower_id != req.tower_id] + [new_pin]
    run.entries = result.entries
    run.unscheduled = result.unscheduled
    run.risk_weighted_wait = result.risk_weighted_wait
    run.horizon = result.horizon
    run.reserve = result.reserve
    run.unscheduled_detail = result.unscheduled_detail
    # This call is the one place these dicts DO persist onto the stored run —
    # _resolve_work_orders returns a copy specifically so preview() (above)
    # never mutates it, but a committed pin is exactly the moment a
    # synthesized work order should stick, so later calls for this tower
    # (another pin, an emergency, /schedule/why) see it too.
    run.work_orders_by_tower = work_orders_by_tower
    run.towers_by_id = towers_by_id
    run.override_log.append(
        {
            "tower_id": req.tower_id,
            "crew_id": req.target_crew_id,
            "day": req.target_day,
            "pin_reason": req.pin_reason,
            "pinned_by": req.pinned_by,
            # Present only on a reviewed inspection. The work order carries the
            # evidence too, but the work order is replaced on the next re-solve
            # while the log is the record that a planner reviewed THIS snapshot
            # and attested to access at this moment.
            "fire_inspection": (
                req.fire_inspection.model_dump() if req.fire_inspection else None
            ),
        }
    )
    run_store.save(run)
    return _run_to_response(run)


@router.post("/schedule/emergency")
def emergency_dispatch(req: EmergencyRequest):
    """Force-insert today. commit=False (default) returns OverridePreview
    with displacement; commit=True commits and returns the new ScheduleRun.
    Displacement always names every moved or dropped job (Backend_Handoff §5)."""
    run = _get_run_or_404(req.run_id)
    work_orders_by_tower, towers_by_id = _resolve_work_orders(run, req.tower_id)

    result = _override_engine.emergency(
        run.entries,
        run.unscheduled,
        run.pins,
        req.tower_id,
        req.crew_id,
        work_orders_by_tower,
        towers_by_id,
        pinned_by=req.pinned_by,
        commit=req.commit,
        today=_run_today(run),
    )

    if not req.commit:
        return result.to_dict()

    new_pin = next(e for e in result.entries if e.tower_id == req.tower_id)
    run.pins = [p for p in run.pins if p.tower_id != req.tower_id] + [new_pin]
    run.entries = result.entries
    run.unscheduled = result.unscheduled
    run.risk_weighted_wait = result.risk_weighted_wait
    run.horizon = result.horizon
    run.reserve = result.reserve
    run.unscheduled_detail = result.unscheduled_detail
    run.work_orders_by_tower = work_orders_by_tower
    run.towers_by_id = towers_by_id
    run.override_log.append(
        {
            "tower_id": req.tower_id,
            "crew_id": req.crew_id,
            "day": new_pin.day,
            "pin_reason": "emergency",
            "pinned_by": req.pinned_by,
        }
    )
    run_store.save(run)
    return _run_to_response(run)
