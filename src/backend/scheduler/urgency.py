"""Mechanism-weighted urgency (Backend_Handoff §1 coordination point, step 4d).

Owner: scheduler (Integration_Gaps §2 left this open; decided here). Promoted
out of fixtures/scored_towers.py so both the fixture and the real adapter
(adapter/ml_source.py) compute it identically instead of drifting.

DERIVED FIELD — urgency_days is not an ML column. It blends each factor's
base failure-arrival timescale by that tower's attribution share: lightning
arrives in days, equipment wear-out over quarters, so one risk number cannot
express deadline urgency on its own. Replaced when/if ML ships a real
urgency estimate; until then this is the sole producer (Backend_Handoff §1 —
both sides emitting it would make the schedule and the drawer disagree on
screen).

The live weather forecast enters here too, and only here. A hazard shortens the
weather-coupled portion of the blend — the tower's condition has not changed
because a storm is coming, only the sensible date to visit it has. Feeding the
forecast into the risk index instead would reshuffle the ranking several times a
day and make validate.py's rank-stability claim meaningless, and a score that
visibly tracks the weather reads as a failure predictor, which Backend_Handoff
§0.6 forbids.
"""
from __future__ import annotations

FACTORS = ["flood", "power", "terrain", "equipment", "lightning"]

# Mechanism timescale: how fast each failure mode actually arrives, in days,
# for a tower where that factor totally dominates (share -> 1.0).
FACTOR_BASE_URGENCY_DAYS = {
    "lightning": 5,
    "flood": 10,
    "power": 20,
    "terrain": 30,
    "equipment": 90,
}
SLOWEST_URGENCY_DAYS = 90  # equipment-only ceiling; blends toward this as share drops


def urgency_days(shares_row: dict[str, float], hazard=None, policy: dict | None = None) -> int:
    """Mechanism-weighted urgency: blend each factor's base timescale by its
    attribution share, so a lightning-dominant tower is urgent sooner than an
    equally-scored equipment-dominant one, per Backend_Handoff §1.

    Missing factors in shares_row (e.g. lightning dropped for null AOI
    coverage) contribute 0 share, per dict.get default.

    `hazard` is an optional live weather reading (flood/forecast.WeatherHazard).
    It shortens only the factors named in policy.weather_hazard.coupled_factors,
    scaled by each one's coupling strength: rain does not accelerate radio-unit
    wear-out, so an equipment-dominant tower's 90-day refresh must not halve
    because a storm is forecast. Because the multiplier lands on the base
    timescale before the share weights it, a flood-share-0.9 tower moves a long
    way and a flood-share-0.05 tower barely moves at all.

    Passing hazard=None reproduces the pre-forecast number exactly. That is what
    keeps this callable with no Earth Engine and no credentials, and it is why
    the parameter is duck-typed on `.multiplier` rather than imported — the
    scheduler must not depend on flood/, which would drag Earth Engine into
    /schedule.
    """
    coupled = (policy or {}).get("weather_hazard", {}).get("coupled_factors", {})
    days = 0.0
    for factor in FACTORS:
        base = FACTOR_BASE_URGENCY_DAYS[factor]
        if hazard is not None and factor in coupled:
            # Coupling strength interpolates between no effect (0.0) and the
            # full multiplier (1.0), so terrain moves half as far as flood.
            base *= 1.0 - coupled[factor] * (1.0 - hazard.multiplier)
        days += shares_row.get(factor, 0.0) * base
    # Never zero. An all-zero shares row could already return 0 before the
    # multiplier existed; a deadline of 0 days breaks the optimizer's date
    # arithmetic, and the multiplier makes that case easier to reach.
    return max(1, int(round(days)))
