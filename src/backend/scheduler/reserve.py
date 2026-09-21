"""Reserve carve-out selection (readiness capacity).

Pure and deterministic: given a roster, a horizon and a policy, decide which
crew-days are held free of planned work. Separated from optimize.py so it can
be tested without running a solve, and so the placement loop only has to
consult a set of keys.

The trade this encodes is real and is not free. Selangor has two civil crews
over a seven-day horizon (14 civil crew-days), and a four-hour flood job plus
travel fills a whole eight-hour shift, so the board is already saturated.
Reserving a civil crew EVERY day would take 7 of those 14 and halve the booked
work. `reserve_days` is what keeps the cost bounded — see config/policy.yaml.

Rotation is scoped PER TERRITORY, not across the whole national roster. A
civil crew in Johor cannot absorb an incident in Selangor, so readiness is
inherently territorial — a "national" reserve pool was never a meaningful
thing to hold. Grouping by `crew_type` alone (an earlier version of this
function) let the rotation offset for `reserve_days` land entirely on other
territories' crews while a given territory's own crews never lost a single
crew-day, making the feature invisible there. Each territory now gets its own
`reserve_crew_days` worth of reservation on every reserve day, and rotates
within only its own crews.
"""
from __future__ import annotations

from datetime import date

from scheduler.optimize import ReserveSlot


def select_reserve(
    crews: list[dict],
    horizon: list[date],
    policy: dict,
) -> list[ReserveSlot]:
    readiness = policy.get("readiness") or {}
    if not readiness.get("enabled"):
        return []

    counts: dict[str, int] = readiness.get("reserve_crew_days") or {}
    reserve_days = readiness.get("reserve_days")
    rotate = bool(readiness.get("rotate_reserve", True))

    # An empty or absent list means every day, which is the strongest
    # readiness posture and the most expensive one.
    day_indices = (
        set(range(len(horizon)))
        if not reserve_days
        else {i for i in reserve_days if 0 <= i < len(horizon)}
    )

    by_territory_type: dict[tuple[str, str], list[dict]] = {}
    for crew in crews:
        key = (crew.get("territory"), crew["crew_type"])
        by_territory_type.setdefault(key, []).append(crew)
    for crew_list in by_territory_type.values():
        crew_list.sort(key=lambda c: c["crew_id"])

    # Deterministic territory order so output ordering does not depend on
    # roster file order. Keyed on (is_missing, value) rather than the bare
    # value: a roster mixing crews that have a `territory` and crews that
    # don't puts None and str in the same set, and `sorted()` over that
    # raises TypeError — comparing None to a string is not defined. This
    # sorts missing territories first without ever comparing None to str.
    territories = sorted(
        {crew.get("territory") for crew in crews},
        key=lambda t: (t is None, t or ""),
    )

    slots: list[ReserveSlot] = []
    for day_index, day in enumerate(horizon):
        if day_index not in day_indices:
            continue
        for territory in territories:
            for crew_type, wanted in sorted(counts.items()):
                pool = by_territory_type.get((territory, crew_type), [])
                if not pool or wanted <= 0:
                    continue
                # Never reserve more crews than the territory has, and never
                # the same crew twice on one day — a wrap-around would
                # silently under-reserve.
                take = min(int(wanted), len(pool))
                for i in range(take):
                    offset = (day_index + i) % len(pool) if rotate else i
                    slots.append(
                        ReserveSlot(
                            crew_id=pool[offset]["crew_id"],
                            day=day.isoformat(),
                            crew_type=crew_type,
                        )
                    )
    return slots
