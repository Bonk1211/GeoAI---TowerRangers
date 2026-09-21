"""GET /towers, POST /score, GET /stability (Implementation_Plan step 3b).

Serves the ML adapter's cached records over the same base URL as the
scheduler routes. /stability is computed once at adapter import and cached
in-process — never re-run per request (500 noisy-OR draws)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from adapter.ml_source import get_stability
from api.schemas import ScoreRequest
from fixtures.source import scored_towers, scored_towers_with_weights, tower_points
from data.power_stations import nearest_power_station
from model.fallback import cached_fallback_report

router = APIRouter(tags=["towers"])


@router.get("/towers")
def get_towers() -> list[dict]:
    # Through fixtures.source.scored_towers(), not load_scored_towers()
    # directly: this route used to be the last caller that ignored
    # USE_FIXTURE, so under USE_FIXTURE=1 the board planned the synthetic
    # MY_* population while the map served real SUNWAY_* towers. Every
    # id-keyed lookup in the frontend then missed, and the work queue's
    # Operator / Factor / Risk columns degraded to "—" on every row.
    return scored_towers()


@router.post("/score")
def score(req: ScoreRequest) -> list[dict]:
    # Same switch, same reason: /score feeds the same map and tiles /towers
    # does, so the two must never describe different tower populations.
    #
    # One code path for both branches. The fixture used to be special-cased
    # here — it carried finished scores and no feature table, so the weight
    # overrides could not move it — but it now builds a synthetic feature
    # table and derives risk through model/risk_index.py just as the real
    # adapter does. Both branches are therefore genuinely re-scored, and
    # both still describe the same tower population /towers serves, because
    # both describe the same feature table.
    return scored_towers_with_weights(req.weights, req.bbox)


@router.get("/stability")
def stability() -> dict | None:
    # None (not {}) when there is nothing to perturb — the supervised model
    # has no AHP weights to jitter, see adapter.ml_source._compute_stability_draws.
    # A bare `-> dict` annotation makes FastAPI reject a None body at
    # serialisation time with a 500, which is how this was first caught.
    return get_stability()


@router.get("/towers/fallback")
def towers_fallback() -> dict:
    """Which flood-exposed towers have a neighbour that could stand in, and
    which have none. Geometry only — see model/fallback.py.

    Derived from scored_towers(), NOT a second source: fixtures/source.py is the
    one place the USE_FIXTURE branch is decided, and a cover report describing a
    different tower population than /towers serves is exactly the drift that
    module's docstring exists to prevent.

    Returns a plain dict rather than the FallbackReport model. The model is
    declared in api/schemas.py for the frontend contract and for anything that
    wants to validate the payload; annotating it here would make FastAPI
    re-validate ~78 nested records on a response that is already cached and
    already shaped by one function. /towers does the same.
    """
    return cached_fallback_report(scored_towers())


@router.get("/towers/{tower_id}/power-station")
def tower_power_station(tower_id: str) -> dict:
    tower = next((point for point in tower_points() if point["tower_id"] == tower_id), None)
    if tower is None:
        raise HTTPException(status_code=404, detail="Tower not found")
    return nearest_power_station(tower)
