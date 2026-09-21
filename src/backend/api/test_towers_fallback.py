"""Route-level tests for GET /towers/fallback.

    python3 src/backend/api/test_towers_fallback.py     # or: pytest

Calls the route function directly rather than through TestClient, matching
api/test_model_health.py. The HTTP layer adds nothing this feature needs
covered — there is no request body, no query parameter and no error branch.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.routes import towers as route      # noqa: E402
from model.fallback import reset_cache      # noqa: E402


def test_endpoint_returns_the_envelope_shape():
    reset_cache()
    payload = route.towers_fallback()
    assert set(payload) == {
        "generated_at", "parameters", "at_risk_count", "isolated_count", "towers",
    }


def test_endpoint_describes_the_same_population_towers_serves():
    """Both derive from fixtures/source.scored_towers(), which is the one place
    the USE_FIXTURE branch is decided. A report describing a different estate
    than /towers serves is exactly the drift that module exists to prevent."""
    reset_cache()
    served = {t["tower_id"] for t in route.get_towers()}
    reported = set(route.towers_fallback()["towers"])
    assert reported <= served, reported - served


def test_endpoint_reports_only_at_risk_towers():
    reset_cache()
    by_id = {t["tower_id"]: t for t in route.get_towers()}
    for tower_id in route.towers_fallback()["towers"]:
        t = by_id[tower_id]
        assert t["decision"] == "maintain"
        assert t["dominant_factor"] == "flood"


def test_endpoint_payload_is_json_serialisable():
    """pydantic is not in this path — the route returns a plain dict — so
    nothing will catch a stray numpy scalar except this."""
    import json
    reset_cache()
    json.dumps(route.towers_fallback())


def test_endpoint_is_cached_across_calls():
    reset_cache()
    first = route.towers_fallback()
    assert route.towers_fallback() is first


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
