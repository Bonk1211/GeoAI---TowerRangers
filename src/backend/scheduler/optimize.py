"""Greedy assignment under constraints (Backend_Handoff §2/§4, step 4).

Objective: minimize risk-weighted unserviced time.

    minimize   sum_t  priority_t * days_until_serviced_t   +  lambda * travel_cost
    where      priority_t = risk_t * log1p(exposed_pop_t)
               (falls back to risk_t when exposure is unavailable)

Greedy tier only (PRD §7.4 ship-now tier): sort work orders by
priority * urgency_factor descending, bin-pack into crew-days with
nearest-neighbour routing from each crew's depot. ~O(n log n) sort +
O(n * crew-days) placement, always terminates, fully explainable.

Constraints enforced as hard filters when searching for a slot — none
optional (Backend_Handoff §4):
  - territory   : tower's crew candidates restricted to crews covering it
  - depot range : haversine*road_factor from depot <= crew.max_travel_km
  - crew type   : work order's crew_type must match the crew's crew_type
  - shift time  : travel-in + on-site duration + the drive BACK to the depot
                  must all fit inside the shift
  - SLA         : day must fall within tower's urgency_days deadline
  - pinned      : pinned assignments are placed first as hard constraints
  - monsoon     : civil crews blocked from flood-zone towers in monsoon months
"""
from __future__ import annotations

import math
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Any

from scheduler.config_loader import load_crews, load_policy
from scheduler.travel import depot_key, get_matrix


@dataclass
class ScheduleEntry:
    """Mirrors Frontend_Build_Plan §5 `ScheduleEntry` exactly."""

    crew_id: str
    day: str  # ISO date
    order: int  # visit sequence within the crew-day
    tower_id: str
    work_order: dict[str, Any]
    pinned: bool = False
    pin_reason: str | None = None  # "planner_override" | "emergency"
    pinned_by: str | None = None
    # --- clock fields (step 8: wired timeline) -----------------------------
    # Minutes from midnight, local. Derived by the optimizer from the actual
    # route, never assumed: travel_min is the drive from the previous point
    # (the depot, for order 1), start_min is arrival, end_min adds the work
    # order's on-site duration_hours. The frontend renders bar geometry
    # straight from these, so what the planner sees is what the solver
    # committed to.
    travel_min: int = 0
    start_min: int = 0
    end_min: int = 0
    # True when this placement was allowed into a reserved crew-day because its
    # SLA deadline left no alternative. Surfaced so a planner can see that
    # readiness capacity was spent, rather than discovering it when an incident
    # finds nothing free.
    consumed_reserve: bool = False

    @property
    def entry_id(self) -> str:
        """Stable composite id for GET /schedule/why/{entry} — not part of
        the frozen frontend shape (kept out of to_dict), the API route
        exposes it as a URL path segment instead."""
        return f"{self.crew_id}__{self.day}__{self.tower_id}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "crew_id": self.crew_id,
            "day": self.day,
            "order": self.order,
            "tower_id": self.tower_id,
            "work_order": self.work_order,
            "pinned": self.pinned,
            "pin_reason": self.pin_reason,
            "pinned_by": self.pinned_by,
            "travel_min": self.travel_min,
            "start_min": self.start_min,
            "end_min": self.end_min,
            "consumed_reserve": self.consumed_reserve,
        }


UNSCHEDULED_REASONS = frozenset(
    {
        "no_capacity",
        "past_sla",
        "monsoon_blocked",
        "no_crew_type",
        "reserved",
        # --- coverage, as opposed to capacity ------------------------------
        # These three used to be reported as "no_capacity", which told a
        # planner the fleet was busy. Measured on the national roster: of 50
        # towers labelled no_capacity, 45 were rejected by the depot-range
        # filter and 3 had no road at all — while 108 of 210 crew-days sat
        # completely idle. Not one of them was a capacity problem, and none
        # is fixable by scheduling differently.
        "out_of_range",       # right crew type and territory, too far to drive
        "out_of_territory",   # a crew IS in range, but it belongs to another territory
        "no_route",           # the matrix proved there is no road, at any distance
    }
)


@dataclass(frozen=True)
class ReserveSlot:
    """A crew-day deliberately held free of planned work — and, in the list
    OptimizeResult.reserve actually returns, STILL free as of this resolve.

    Readiness capacity: unplanned insertion consumes this FIRST, so a real
    incident displaces nothing. Decided before planned assignment — reserve
    chosen after the fact would not be protected from anything.

    Once a pin, an emergency, or the SLA valve actually occupies a
    (crew_id, day) that was chosen for reserve, optimize() drops that slot
    from the returned list — showing it as still-reserved after something
    has landed there would tell the UI to paint a "held free" band over a
    booked job, exactly the failure mode this feature exists to prevent.
    So: a count taken from OptimizeResult.reserve is reserve days
    REMAINING for this resolve, not the policy quota configured in
    policy.yaml's readiness block (select_reserve's full selection, before
    any consumption) — the two will disagree by design once anything has
    been placed into reserve capacity.
    """

    crew_id: str
    day: str  # ISO date
    crew_type: str

    def to_dict(self) -> dict[str, Any]:
        return {"crew_id": self.crew_id, "day": self.day, "crew_type": self.crew_type}


@dataclass(frozen=True)
class UnscheduledItem:
    """Why one tower did not make it onto the board.

    The reason is per-tower and returned explicitly. The UI previously
    printed one static sentence about the monsoon window for the whole
    unscheduled set, in August, which was true of almost none of them.
    """

    tower_id: str
    reason: str  # one of UNSCHEDULED_REASONS
    deadline: str | None  # ISO date the SLA expires, None when unknown
    crew_type: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "tower_id": self.tower_id,
            "reason": self.reason,
            "deadline": self.deadline,
            "crew_type": self.crew_type,
        }


@dataclass
class RestartStats:
    """What the multi-start search actually did — the bound PRD §13 promised.

    improvement_pct compares risk_weighted_wait only, so it CAN be negative: a
    winner that schedules more work pays more wait for it, and that is a better
    schedule, not a worse one. The raw figures are carried alongside so nobody
    has to trust the derived one.
    """

    restarts_run: int
    winner_index: int
    baseline_score: float
    winner_score: float
    improvement_pct: float

    def to_dict(self) -> dict:
        return {
            "restarts_run": self.restarts_run,
            "winner_index": self.winner_index,
            "baseline_score": self.baseline_score,
            "winner_score": self.winner_score,
            "improvement_pct": self.improvement_pct,
        }


@dataclass
class OptimizeResult:
    """Solver output.

    Iterable as `(entries, unscheduled, risk_weighted_wait)` on purpose: four
    call sites unpack the old 3-tuple, and keeping them working means this
    contract change lands without touching baseline.py, tools.py, override.py
    or the schedule route.
    """

    entries: list[ScheduleEntry]
    unscheduled: list[str]
    risk_weighted_wait: float
    horizon: list[str] = field(default_factory=list)
    reserve: list[ReserveSlot] = field(default_factory=list)
    unscheduled_detail: list[UnscheduledItem] = field(default_factory=list)
    restarts: RestartStats | None = None

    def __iter__(self):
        return iter((self.entries, self.unscheduled, self.risk_weighted_wait))


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


UNREACHABLE = float("inf")


def leg(
    from_key: str,
    from_lon: float,
    from_lat: float,
    to_key: str,
    to_lon: float,
    to_lat: float,
    road_factor: float,
    avg_speed_kmh: float,
) -> tuple[float, int]:
    """One leg as (km, minutes), measured if we have it and estimated if not.

    THE ONE PLACE the matrix-vs-haversine decision is made. It is a single
    function on purpose: the fallback rule has three branches and writing it
    at each of the six call sites is how they drift, which is the same failure
    the band-colour triad had before lib/colors.ts.

    Returns (inf, inf-minutes) for a pair OSRM proved has no road. Callers
    already reject on distance > max_travel_km and on shift overflow, so an
    infinite leg falls out of every feasibility test without any of them
    needing to learn a new sentinel — and, critically, WITHOUT silently
    reverting to the straight-line guess that OSRM has just contradicted.
    """
    measured = get_matrix().lookup(from_key, to_key)
    if measured is not None:
        if not measured.reachable:
            return UNREACHABLE, 10**9
        return measured.km, int(round(measured.minutes))
    km = haversine_km(from_lon, from_lat, to_lon, to_lat) * road_factor
    return km, travel_minutes(km, avg_speed_kmh)


def travel_km(crew: dict, tower: dict, road_factor: float) -> float:
    """Depot -> tower distance. Kept for callers that only want the distance
    (the depot-range check, baseline, explain); `leg()` is the full form."""
    km, _ = leg(
        depot_key(crew["depot"]["lon"], crew["depot"]["lat"]),
        crew["depot"]["lon"],
        crew["depot"]["lat"],
        tower.get("tower_id", ""),
        tower["lon"],
        tower["lat"],
        road_factor,
        # Distance-only caller: the speed is irrelevant to the return value,
        # and passing the policy default here would make this function need a
        # policy it does not otherwise read.
        1.0,
    )
    return km


DEFAULT_DURATION_HOURS = 3.0


def _duration_hours(work_order: dict) -> float:
    """On-site hours for a work order. Falls back rather than raising: a
    schedule that draws a default-width bar is recoverable, one that 500s
    because a YAML key went missing is not."""
    value = work_order.get("duration_hours")
    return float(value) if value else DEFAULT_DURATION_HOURS


def priority(tower: dict) -> float:
    """priority_t = ordering_t * log1p(exposed_pop_t), falls back to ordering_t.

    `ordering` is the served `priority` field — the model's risk rank blended
    with the telemetry condition rank (model/ensemble.py) — falling back to
    `risk` for any record that predates it: the mock fixture, and any caller
    still on the Backend_Handoff §1 minimum contract.

    It reads the blend rather than `risk` because the decision bands are cut on
    the blend. A tower can be in the maintain band because its live counters are
    running hot, and ordering the run by `risk` alone would let exactly that
    tower enter the dispatch list and then sort to the bottom of it — the two
    halves of the pipeline disagreeing about the same site. That was a real
    regression for the one release where banding moved to the blend and this
    function had not.

    This changes the SCALE of risk_weighted_wait: `risk` is a probability
    (p50 ~ 0.12 under the served model) while `priority` is a percentile rank
    (p50 0.5), so the absolute figure roughly quadruples. The reported headline
    is `risk_weighted_wait_reduction_pct`, a ratio between two policies that now
    both weight this way — greedy and nearest-first run through the same
    Optimizer and differ only in sort_key_fn — so the comparison it makes is
    unaffected. The absolute number is not comparable across that release
    boundary; the percentage is.
    """
    ordering = tower.get("priority")
    if ordering is None:
        ordering = tower["risk"]
    ordering = float(ordering)
    exposed_pop = tower.get("exposed_pop")
    if exposed_pop is None:
        return ordering
    return ordering * math.log1p(float(exposed_pop))


def urgency_factor(tower: dict) -> float:
    """Higher for towers closer to their SLA deadline — sharpens sort order
    beyond raw priority so near-due towers surface first among equals."""
    urgency_days = max(1, int(tower.get("urgency_days", 30)))
    return 1.0 / urgency_days


def _candidate_score(
    unscheduled: list[str],
    towers_by_id: dict[str, dict],
    risk_weighted_wait: float,
    restart_index: int,
) -> tuple[float, float, int]:
    """Ranking key for one restart's result. Lower wins, on every element.

    risk_weighted_wait ALONE is not a valid criterion and never can be: it
    accumulates only for jobs that were placed (the two `risk_weighted_wait
    +=` lines below), so a restart that fails to place a high-risk tower
    simply stops paying for it. Ranking on it directly would systematically
    select the restart that scheduled the LEAST work, while reporting the
    best number — and the fake improvement would grow with the restart count.

    So unserviced risk mass leads. It is risk-weighted rather than a plain
    count because leaving a 0.95 tower unscheduled is not equivalent to
    leaving a 0.10 one, and it introduces no new tunable constant to defend:
    priority() is the same function the sort key and the objective already
    use.

    restart_index last so two genuinely equal candidates always resolve the
    same way; without it the winner depends on iteration order and the run
    stops being reproducible.
    """
    unserviced = sum(
        priority(towers_by_id[t]) for t in unscheduled if t in towers_by_id
    )
    return (unserviced, risk_weighted_wait, restart_index)


def _coverage_reason(
    tower: dict,
    crew_type: str,
    all_crews: list[dict],
    depot_km: Callable[[dict, dict], float],
    max_km_default: float,
) -> str:
    """Why no crew can reach this tower. Called only when the in-territory,
    in-range candidate list came back empty.

    The three answers are NOT interchangeable, and collapsing them (as
    "no_capacity" did) hides the only one a planner can act on:

      no_route         the matrix proved there is no road to this tower from
                       any depot staffing this crew type. Moving a depot does
                       not help; nothing does, short of a different access
                       route. Distance is irrelevant and must not be implied.
      out_of_territory a crew of the right type is within its OWN range —
                       it simply belongs to another territory, and
                       _candidate_crews never offered it. That is a dispatch
                       RULE, answerable by a human today, and it was the
                       thing most worth surfacing: measured nationally, some
                       Johor towers sit 95 km from a Negeri Sembilan crew and
                       174 km from their own.
      out_of_range     roads exist and no foreign crew is close enough
                       either. A genuine coverage hole — the honest answer is
                       a depot or a crew, not a better schedule.

    Ordered most-specific first: no_route dominates because if nothing can
    route here, "too far" is not merely unhelpful, it is false.
    """
    typed_anywhere = [c for c in all_crews if c["crew_type"] == crew_type]
    if not typed_anywhere:
        # Should be unreachable in practice — has_typed_crew already routes
        # this to "no_crew_type" — but returning the range answer for a fleet
        # that does not staff this type at all would be a lie.
        return "no_crew_type"

    distances = [(depot_km(c, tower), c) for c in typed_anywhere]
    if all(km == UNREACHABLE for km, _ in distances):
        return "no_route"

    tower_territory = tower.get("territory") or tower.get("state")
    for km, crew in distances:
        if km == UNREACHABLE:
            continue
        if crew["territory"] == tower_territory:
            continue  # already rejected above; this loop is about the others
        if km <= crew.get("max_travel_km", max_km_default):
            return "out_of_territory"

    return "out_of_range"


def _relabel_reserved(
    unscheduled_detail: list[UnscheduledItem],
    shadow_entries: list[ScheduleEntry],
) -> list[UnscheduledItem]:
    """Apply the reserve counterfactual label to one pass's unscheduled detail.

    A tower is 'reserved' iff it is unscheduled in the real pass AND the
    reserve-off shadow pass would have placed it — never decided by anything
    observed during the real pass, so it cannot latch onto an incidental
    reserved crew-day the way the old per-day flag did.

    Extracted so the shadow pass can be run ONCE against the winning restart
    rather than once per restart: it does not touch entries, reserve or
    risk_weighted_wait, so it cannot change which restart wins, and running it
    per restart would double the cost of every one of them for a label thrown
    away N-1 times.
    """
    recoverable = {e.tower_id for e in shadow_entries if not e.pinned}
    return [
        replace(item, reason="reserved") if item.tower_id in recoverable else item
        for item in unscheduled_detail
    ]


@dataclass(frozen=True)
class RestartConfig:
    """How much search to spend. See config/policy.yaml `restarts`."""

    max_restarts: int
    time_budget_ms: float
    no_improve_stop: int
    jitter: float
    seed: int


def _restart_config(policy: dict, override: int | None = None) -> RestartConfig:
    """Restart budget from policy, defaulting to today's single unperturbed
    pass whenever the block is missing or disabled.

    Defaulting OFF is deliberate: every solver test builds its policy dict
    inline without this key, and a default-on would silently change what all
    of them are asserting. `override` is how the interactive override path
    (scheduler/override.py) forces single-pass regardless of policy.
    """
    cfg = policy.get("restarts") or {}
    max_restarts = int(cfg.get("max_restarts", 1)) if cfg.get("enabled", False) else 1
    if override is not None:
        max_restarts = int(override)
    return RestartConfig(
        max_restarts=max(1, max_restarts),
        time_budget_ms=float(cfg.get("time_budget_ms", 1500)),
        no_improve_stop=int(cfg.get("no_improve_stop", 5)),
        jitter=float(cfg.get("jitter", 0.15)),
        seed=int(cfg.get("seed", 20260910)),
    )


def is_flood_zone(tower: dict, policy: dict) -> bool:
    threshold = policy["monsoon"]["flood_zone_share_threshold"]
    if tower.get("dominant_factor") == "flood":
        return True
    return float(tower.get("attribution", {}).get("flood", 0.0)) >= threshold


def is_monsoon_month(day: date, policy: dict) -> bool:
    return day.month in policy["monsoon"]["months"]


@dataclass
class _CrewDayState:
    jobs: list[ScheduleEntry] = field(default_factory=list)
    last_point: tuple[float, float] | None = None  # for nearest-neighbour order
    # The matrix key for that same point — the tower the crew is standing at.
    # Carried beside the coordinates rather than derived from them: a tower's
    # matrix row is keyed by tower_id, and rounding a lon/lat back into an id
    # is not possible.
    last_key: str | None = None
    # Minutes from midnight at which the crew becomes free again. Seeded to
    # the shift's day_start and advanced by each placement's travel + work.
    cursor_min: int = 0


def _hhmm_to_min(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def travel_minutes(km: float, avg_speed_kmh: float) -> int:
    """Road km -> drive minutes. Rounded to whole minutes so the schedule the
    planner reads and the geometry the timeline draws cannot disagree by a
    fraction that renders as a sliver."""
    if avg_speed_kmh <= 0:
        return 0
    return int(round(km / avg_speed_kmh * 60))


class Optimizer:
    """Greedy priority-sort + bin-pack optimizer (PRD §7.4)."""

    def __init__(
        self,
        crews: list[dict] | None = None,
        policy: dict | None = None,
    ):
        self.crews = crews if crews is not None else load_crews()
        self.policy = policy if policy is not None else load_policy()
        self._crews_by_id = {c["crew_id"]: c for c in self.crews}

    def _horizon(self, today: date) -> list[date]:
        n = int(self.policy["planning_horizon_days"])
        return [today + timedelta(days=i) for i in range(n)]

    def _candidate_crews(self, work_order: dict, tower: dict) -> list[dict]:
        """Territory + crew-type filters (hard constraints, §4)."""
        territory = tower.get("territory") or tower.get("state")
        out = []
        for crew in self.crews:
            if crew["crew_type"] != work_order["crew_type"]:
                continue
            if territory is not None and crew["territory"] != territory:
                continue
            out.append(crew)
        return out

    def optimize(
        self,
        work_orders: list[dict],
        towers_by_id: dict[str, dict],
        pinned: list[ScheduleEntry] | None = None,
        today: date | None = None,
        sort_key_fn: Callable[[dict, dict], float] | None = None,
        blocked_crew_days: set[tuple[str, str]] | None = None,
        restarts: int | None = None,
    ) -> OptimizeResult:
        """Returns an OptimizeResult, which also unpacks as (entries, unscheduled, wait).

        sort_key_fn(work_order, tower) -> float lets a caller swap the
        dispatch *policy* (which order work gets bin-packed in) while
        keeping every constraint identical — this is what makes the
        baseline comparison (scheduler/baseline.py, PRD §9) a fair
        apples-to-apples policy delta rather than a different capacity
        model. Defaults to the documented greedy priority order.

        blocked_crew_days: (crew_id, day-iso) pairs the planner has declared
        unavailable — "crew SEL-C1 unavailable Thursday" via the agent's
        apply_constraint. Enforced as a hard candidate filter, same tier as
        depot-range and shift-time: the crew is simply never offered for
        that day, so remaining work either finds another crew/day or falls
        out to unscheduled with the ordinary "no_capacity" reason — there is
        no separate "crew_unavailable" reason, because from the solver's
        point of view this crew-day just has zero capacity, indistinguishable
        from any other day that filled up. This does not evict anything
        already pinned to that crew-day: pins are a hard constraint supplied
        by the caller and are seeded before this filter is ever consulted,
        the same way a reserved crew-day does not un-pin an emergency dispatch
        that already landed on it.

        restarts: how many perturbed orderings to try, overriding policy.
        None reads config/policy.yaml's `restarts` block. Pass 1 to force a
        single unperturbed pass — the interactive override path does exactly
        that, because re-drawing the whole board from a different restart on
        every pin would make unrelated jobs jump around for reasons the
        planner cannot see.
        """
        today = today or date.fromisoformat(self.policy["demo_clock"]["today"])
        horizon = self._horizon(today)
        # Local import to break the optimize <-> reserve circular import.
        from scheduler.reserve import select_reserve

        reserve = select_reserve(self.crews, horizon, self.policy)
        reserved_keys = {(s.crew_id, s.day) for s in reserve}
        blocked_keys = blocked_crew_days or set()
        sla_may_consume = bool(
            (self.policy.get("readiness") or {}).get("sla_may_consume_reserve")
        )
        road_factor = self.policy["travel"]["road_factor"]
        avg_speed = float(self.policy["travel"]["avg_speed_kmh"])
        shift = self.policy["shift"]
        day_start_min = _hhmm_to_min(shift["day_start"])
        shift_hours_default = float(shift["hours_default"])
        fallback_sla = int(self.policy["sla"]["fallback_sla_days"])
        lam = float(self.policy["objective"]["travel_weight_lambda"])

        pinned_tower_ids: set[str] = {p.tower_id for p in pinned or []}

        # sort remaining work by priority * urgency_factor, descending
        # (or by sort_key_fn, when a caller supplies an alternate dispatch
        # policy — e.g. baseline.py's nearest-first comparison). Sorted once,
        # outside run_pass, so the real and shadow passes place work in
        # identical order — the counterfactual below depends on that.
        remaining = [wo for wo in work_orders if wo["tower_id"] not in pinned_tower_ids]

        if sort_key_fn is None:
            def default_sort_key(wo: dict) -> float:
                t = towers_by_id[wo["tower_id"]]
                return -(priority(t) * urgency_factor(t))

            sort_key = default_sort_key
        else:
            def wrapped_sort_key(wo: dict) -> float:
                return sort_key_fn(wo, towers_by_id[wo["tower_id"]])

            sort_key = wrapped_sort_key

        # Tie-break on tower_id, never on list position. Python's sort is
        # stable, so a bare float key leaves exact ties in input order — and
        # co-located towers ARE exactly tied: SUNWAY_OPERATOR_{A,B,C}_701934
        # are three operators' equipment on one mast, identical risk, urgency
        # and coordinates. Pinning removes one work order from this list,
        # every later position shifts, and the tied towers permute. That made
        # a dispatch into a FREE reserve crew-day report displaced work when
        # nothing was displaced: one tied tower swapped out, its twin swapped
        # in, net placements unchanged. Measured before this line: 30 of 36
        # reserve dispatches reported a phantom displacement; after: 0.
        # Computed once, then reused as the base for every restart's ordering —
        # this also stops priority()/urgency_factor() being recomputed per pass.
        base_keys = {wo["tower_id"]: sort_key(wo) for wo in remaining}
        remaining.sort(key=lambda wo: (base_keys[wo["tower_id"]], wo["tower_id"]))

        # Per-CALL, not per-process: a leg depends only on its two endpoints and
        # the two travel constants, and the endpoint set is fixed for the whole
        # solve. Across restarts the same pairs recur heavily, because restarts
        # differ in the ORDER work is placed, not in which towers exist. Scoped
        # to this call so a reloaded travel matrix can never be served stale.
        leg_cache: dict[tuple[str, str], tuple[float, int]] = {}

        def cached_leg(
            from_key: str, from_lon: float, from_lat: float,
            to_key: str, to_lon: float, to_lat: float,
        ) -> tuple[float, int]:
            ck = (from_key, to_key)
            hit = leg_cache.get(ck)
            if hit is None:
                hit = leg(
                    from_key, from_lon, from_lat,
                    to_key, to_lon, to_lat,
                    road_factor, avg_speed,
                )
                leg_cache[ck] = hit
            return hit

        def cached_depot_km(crew: dict, tower: dict) -> float:
            """travel_km() through the cache. Same value, same argument order —
            but travel_km calls leg() directly, so leaving the depot-range
            checks on it would re-measure pairs cached_leg already holds."""
            km, _ = cached_leg(
                depot_key(crew["depot"]["lon"], crew["depot"]["lat"]),
                crew["depot"]["lon"], crew["depot"]["lat"],
                tower.get("tower_id", ""), tower["lon"], tower["lat"],
            )
            return km

        # Restart-invariant and day-invariant: crew-type/territory matching and
        # depot range are pure functions of (work order, tower, crew), so they
        # are computed once here rather than once per work order per day per
        # pass. Keyed on crew_type as well as tower_id because a tower could in
        # principle carry work orders of different types.
        in_range: dict[tuple[str, str], list[tuple[dict, float]]] = {}
        has_typed_crew: dict[tuple[str, str], bool] = {}
        # Why a tower has NO reachable crew — computed only when in_range is
        # empty, so the extra lookups are paid for the handful of towers that
        # are actually blocked, not for the whole population. See
        # _coverage_reason for what separates the three.
        coverage_block: dict[tuple[str, str], str] = {}
        max_km_default = self.policy["travel"]["max_travel_km_default"]
        for wo in remaining:
            ck = (wo["tower_id"], wo["crew_type"])
            if ck in in_range:
                continue
            tower = towers_by_id[wo["tower_id"]]
            typed = self._candidate_crews(wo, tower)
            has_typed_crew[ck] = bool(typed)
            reachable: list[tuple[dict, float]] = []
            for crew in typed:
                dist = cached_depot_km(crew, tower)
                if dist <= crew.get("max_travel_km", max_km_default):
                    reachable.append((crew, dist))
            in_range[ck] = reachable
            if typed and not reachable:
                coverage_block[ck] = _coverage_reason(
                    tower,
                    wo["crew_type"],
                    self.crews,
                    cached_depot_km,
                    max_km_default,
                )

        def run_pass(
            pass_reserved_keys: set[tuple[str, str]],
        ) -> tuple[list[ScheduleEntry], list[str], list[UnscheduledItem], float]:
            """One full greedy placement pass, self-contained: builds its own
            crew-day state from scratch (including re-seeding pins) so two
            calls never share mutable state. `pass_reserved_keys` is the only
            thing that varies between the real pass and the counterfactual
            shadow pass optimize() runs below to label 'reserved' — see the
            module-level note on why the label can no longer be a per-day
            sticky flag.
            """
            state: dict[tuple[str, str], _CrewDayState] = {}
            entries: list[ScheduleEntry] = []

            for p in pinned or []:
                key = (p.crew_id, p.day)
                cd = state.setdefault(key, _CrewDayState())
                if not cd.jobs:
                    cd.cursor_min = day_start_min
                crew = self._crews_by_id.get(p.crew_id)
                tower = towers_by_id.get(p.tower_id)
                # A pin is a hard constraint on crew+day, but its clock position is
                # still derived — otherwise a pinned job would carry stale times
                # from whichever slot it held before the planner moved it, and the
                # timeline would draw a bar the solver never agreed to.
                #
                # This seeding loop runs once per run_pass() call, and optimize()
                # calls run_pass() TWICE — a real pass, then a reserve-off shadow
                # pass whose only job is to compute the 'reserved' label. `pinned`
                # holds objects the CALLER owns and both passes iterate the same
                # list, so writing straight onto `p` (as this used to) would let
                # the shadow pass silently overwrite fields the real pass already
                # returned to the caller — invisible corruption once pin placement
                # depends on reserve state, which it now does via consumed_reserve
                # below. `replace(p, ...)` produces a fresh, disconnected entry
                # per pass instead: the shadow pass's copy is appended only to its
                # own local `entries` list, which the caller never sees.
                if tower is not None and crew is not None:
                    # Matrix key follows the same rule as the geometry: the
                    # PREVIOUS TOWER once the crew is out on the road, its
                    # depot only for the first job of the day.
                    origin = cd.last_point or (crew["depot"]["lon"], crew["depot"]["lat"])
                    origin_key = cd.last_key or depot_key(
                        crew["depot"]["lon"], crew["depot"]["lat"]
                    )
                    leg_km, travel_min = cached_leg(
                        origin_key, origin[0], origin[1],
                        tower["tower_id"], tower["lon"], tower["lat"],
                    )
                    start_min = cd.cursor_min + travel_min
                    end_min = start_min + int(round(_duration_hours(p.work_order) * 60))
                    pin_entry = replace(
                        p,
                        travel_min=travel_min,
                        start_min=start_min,
                        end_min=end_min,
                        order=len(cd.jobs) + 1,
                        consumed_reserve=(p.crew_id, p.day) in pass_reserved_keys,
                    )
                    cd.cursor_min = end_min
                    cd.last_point = (tower["lon"], tower["lat"])
                    cd.last_key = tower["tower_id"]
                else:
                    # Tower/crew lookup failed (should not happen in practice),
                    # so no clock fields to derive — but consumed_reserve must
                    # still reflect THIS pass's reserve state, not whatever the
                    # caller's object happened to carry from an earlier resolve.
                    # run.pins now stores solver-produced entries, and with
                    # rotate_reserve the same crew-day is not reserved forever,
                    # so a stale True surviving across resolves would render as
                    # a visibly wrong badge in the UI.
                    pin_entry = replace(
                        p, consumed_reserve=(p.crew_id, p.day) in pass_reserved_keys
                    )
                cd.jobs.append(pin_entry)
                entries.append(pin_entry)

            unscheduled: list[str] = []
            unscheduled_detail: list[UnscheduledItem] = []
            risk_weighted_wait = 0.0

            for wo in remaining:
                tower = towers_by_id[wo["tower_id"]]
                deadline_days = int(wo.get("urgency_days", fallback_sla))
                deadline = today + timedelta(days=deadline_days)

                ck = (wo["tower_id"], wo["crew_type"])
                candidates = in_range[ck]
                # Recorded now because the day loop below cannot distinguish "no
                # crew of this type in this territory" from "every day was full" —
                # by then there are simply no candidates to fail against. Read
                # from has_typed_crew, not from `candidates`: an empty
                # `candidates` now also means "typed crews exist but none are in
                # depot range", which is a capacity reason, not a crew-type one.
                no_crew_type = not has_typed_crew[ck]
                placed = False

                for day in horizon:
                    if day > deadline:
                        break  # SLA constraint — no later day is valid either
                    if is_monsoon_month(day, self.policy) and is_flood_zone(tower, self.policy):
                        if wo["crew_type"] in self.policy["monsoon"]["blocked_crew_types"]:
                            continue  # weather-window constraint

                    # rank crews for this tower/day by depot-range feasibility + travel cost
                    work_min = int(round(_duration_hours(wo) * 60))

                    feasible = []
                    for crew, dist in candidates:
                        key = (crew["crew_id"], day.isoformat())
                        if key in blocked_keys:
                            continue  # planner-declared unavailability
                        # depot-range constraint already applied when `in_range`
                        # was built — it does not vary by day.
                        cd = state.get(key)

                        # Shift-time capacity. The leg is measured from where the
                        # crew actually is — the depot for the first job of the
                        # day, the previous tower after that — so a tight cluster
                        # fits three jobs where a scattered one fits two. A job
                        # count could never express that.
                        shift_min = int(float(crew.get("shift_hours", shift_hours_default)) * 60)
                        cursor = cd.cursor_min if cd and cd.jobs else day_start_min
                        origin = (
                            cd.last_point
                            if cd and cd.last_point
                            else (crew["depot"]["lon"], crew["depot"]["lat"])
                        )
                        origin_key = (
                            cd.last_key
                            if cd and cd.last_key
                            else depot_key(crew["depot"]["lon"], crew["depot"]["lat"])
                        )
                        leg_km, leg_min = cached_leg(
                            origin_key, origin[0], origin[1],
                            tower["tower_id"], tower["lon"], tower["lat"],
                        )
                        # THE CREW HAS TO GET HOME.
                        #
                        # The shift used to end the moment the last job did,
                        # which quietly booked work a crew could only finish by
                        # abandoning the van at the tower. On a 150 km-range
                        # territory that is not a rounding error: the return
                        # leg is the same order of magnitude as the outbound
                        # one, so the last slot of every day was being sold
                        # twice.
                        #
                        # Measured from the TOWER being considered, not from
                        # wherever the crew is now — the return only happens
                        # after this job, so it is this job that has to pay for
                        # it. The matrix carries the reverse pair explicitly
                        # (data/prepare_travel_matrix_osm.py writes both
                        # directions); without a matrix it falls back to the
                        # same haversine estimate as every other leg.
                        _, home_min = cached_leg(
                            tower["tower_id"], tower["lon"], tower["lat"],
                            depot_key(crew["depot"]["lon"], crew["depot"]["lat"]),
                            crew["depot"]["lon"], crew["depot"]["lat"],
                        )
                        if cursor + leg_min + work_min + home_min > day_start_min + shift_min:
                            continue  # shift-time constraint, return leg included
                        # Rank by the time this placement actually costs the day,
                        # not by depot distance: mid-route, the crew with the
                        # nearest depot is rarely the cheapest insertion.
                        feasible.append(
                            (leg_min, dist, crew, (crew["crew_id"], day.isoformat()) in pass_reserved_keys)
                        )

                    if not feasible:
                        continue

                    # Reserve is protected capacity, so planned work never takes it.
                    # Partitioned rather than filtered earlier so "the only crew that
                    # fits is on reserve duty" stays distinguishable from "nothing fit".
                    open_feasible = [f for f in feasible if not f[3]]
                    # Readiness must never cause a missed deadline. On the last day
                    # the SLA allows, reserved capacity becomes eligible — spending
                    # readiness is strictly better than blowing the deadline it was
                    # being held for.
                    took_reserve = False
                    if not open_feasible:
                        if sla_may_consume and day >= deadline:
                            open_feasible = list(feasible)
                            took_reserve = True
                        else:
                            blocked_by_reserve = True
                            continue

                    open_feasible.sort(key=lambda x: (x[0], x[1]))
                    leg_min, dist, crew, from_reserve = open_feasible[0]
                    took_reserve = took_reserve and from_reserve

                    key = (crew["crew_id"], day.isoformat())
                    cd = state.setdefault(key, _CrewDayState())
                    if not cd.jobs:
                        cd.cursor_min = day_start_min
                    order = len(cd.jobs) + 1
                    start_min = cd.cursor_min + leg_min
                    entry = ScheduleEntry(
                        crew_id=crew["crew_id"],
                        day=day.isoformat(),
                        order=order,
                        tower_id=tower["tower_id"],
                        work_order=wo,
                        pinned=False,
                        pin_reason=None,
                        pinned_by=None,
                        travel_min=leg_min,
                        start_min=start_min,
                        end_min=start_min + work_min,
                        consumed_reserve=took_reserve,
                    )
                    cd.jobs.append(entry)
                    cd.cursor_min = entry.end_min
                    cd.last_point = (tower["lon"], tower["lat"])
                    cd.last_key = tower["tower_id"]
                    entries.append(entry)

                    days_until_serviced = (day - today).days
                    risk_weighted_wait += priority(tower) * days_until_serviced + lam * dist
                    placed = True
                    break

                if not placed:
                    unscheduled.append(tower["tower_id"])
                    # Note: this chain never labels "reserved" — that label is
                    # decided afterward by counterfactual (see below), not by
                    # a per-day flag here. A per-day "was every feasible crew
                    # on reserve duty that day" flag is sticky across the
                    # whole horizon and cannot tell "reserve is the only
                    # thing blocking this tower" from "this tower also fails
                    # on every other day for an ordinary capacity reason" —
                    # that conflation is the bug this replaced.
                    if no_crew_type:
                        reason = "no_crew_type"
                    elif deadline < horizon[0]:
                        reason = "past_sla"
                    elif is_monsoon_month(horizon[0], self.policy) and is_flood_zone(
                        tower, self.policy
                    ) and wo["crew_type"] in self.policy["monsoon"]["blocked_crew_types"]:
                        reason = "monsoon_blocked"
                    elif ck in coverage_block:
                        # No crew could reach this tower on ANY day — decided
                        # before the day loop ran, so "the fleet was full" was
                        # never true of it. Placed last among the structural
                        # reasons so a tower that is also past SLA or monsoon-
                        # blocked keeps the reason it already reported; this
                        # branch only ever reclassifies what used to fall
                        # through to no_capacity.
                        reason = coverage_block[ck]
                    else:
                        reason = "no_capacity"
                    unscheduled_detail.append(
                        UnscheduledItem(
                            tower_id=tower["tower_id"],
                            reason=reason,
                            deadline=deadline.isoformat(),
                            crew_type=wo["crew_type"],
                        )
                    )

            # pinned jobs also contribute to the objective (their fixed slot's wait)
            for p in pinned or []:
                tower = towers_by_id.get(p.tower_id)
                if tower is None:
                    continue
                day = date.fromisoformat(p.day)
                days_until_serviced = max(0, (day - today).days)
                crew = self._crews_by_id.get(p.crew_id)
                dist = cached_depot_km(crew, tower) if crew else 0.0
                risk_weighted_wait += priority(tower) * days_until_serviced + lam * dist

            return entries, unscheduled, unscheduled_detail, risk_weighted_wait

        # Multi-start. Every restart runs the SAME run_pass() under the same
        # hard constraints; only the order work is offered in changes. Restart
        # 0 is always the unperturbed ordering and always runs, which is what
        # makes this provably non-regressive: the winner is chosen from a set
        # that always contains today's answer.
        cfg = _restart_config(self.policy, override=restarts)
        rng = random.Random(cfg.seed)
        started = time.monotonic()

        best_score: tuple[float, float, int] | None = None
        best_out: tuple[list, list, list, float] | None = None
        best_order: dict[str, float] = base_keys
        winner_index = 0
        restarts_run = 0
        baseline_wait = 0.0
        no_improve = 0

        for i in range(cfg.max_restarts):
            if i > 0:
                # These may only ever CUT the search short. Restart 0 is
                # outside both guards, so a zero budget still yields a real
                # schedule rather than none.
                if (time.monotonic() - started) * 1000.0 >= cfg.time_budget_ms:
                    break
                if no_improve >= cfg.no_improve_stop:
                    break

            if i == 0:
                order = base_keys
            else:
                order = {
                    tid: k * (1.0 + rng.uniform(-cfg.jitter, cfg.jitter))
                    for tid, k in base_keys.items()
                }
            # The tower_id tie-break is not optional: without it, co-located
            # towers with identical keys permute between passes and a dispatch
            # into a free crew-day reports displacement that never happened.
            remaining.sort(key=lambda wo: (order[wo["tower_id"]], wo["tower_id"]))

            out = run_pass(reserved_keys)
            restarts_run += 1
            score = _candidate_score(out[1], towers_by_id, out[3], i)
            if i == 0:
                baseline_wait = out[3]

            if best_score is None or score < best_score:
                best_score, best_out, best_order = score, out, order
                winner_index = i
                no_improve = 0
            else:
                no_improve += 1

        entries, unscheduled, unscheduled_detail, risk_weighted_wait = best_out

        # Counterfactual reserved-label pass. A tower is "reserved" iff it is
        # unscheduled here AND would have been scheduled with no reserve at
        # all — never decided by anything observed during the real pass, so
        # it cannot latch onto an incidental reserved crew-day the way the
        # old per-day flag did. Skipped when the reserve is empty: it cannot
        # change any label then, and running it would just cost time on the
        # readiness-off path for nothing. This shadow pass does not affect
        # entries, reserve, risk_weighted_wait, or any other real-pass output
        # — only which towers in unscheduled_detail get relabelled below.
        if reserved_keys:
            # Re-sorted to the WINNER's ordering first. The counterfactual asks
            # "would this tower have been placed with no reserve at all", and
            # that question is only meaningful against the ordering that
            # actually produced the schedule being labelled.
            remaining.sort(key=lambda wo: (best_order[wo["tower_id"]], wo["tower_id"]))
            shadow_entries, _shadow_unscheduled, _shadow_detail, _shadow_wait = run_pass(set())
            unscheduled_detail = _relabel_reserved(unscheduled_detail, shadow_entries)

        # `reserve` reports which crew-days were deliberately held free so the
        # UI can paint a "held free" band. Once something has actually landed
        # there in THIS resolve — a pin, an emergency, or the SLA valve, all
        # of which carry consumed_reserve=True on the real pass — it is no
        # longer free, and reporting it as still-reserved would paint that
        # band over a booked job. Only the real pass's entries decide this;
        # the shadow pass's placements are never consulted for anything.
        occupied_reserved = {
            (e.crew_id, e.day) for e in entries if (e.crew_id, e.day) in reserved_keys
        }
        if occupied_reserved:
            reserve = [s for s in reserve if (s.crew_id, s.day) not in occupied_reserved]

        return OptimizeResult(
            entries=entries,
            unscheduled=unscheduled,
            risk_weighted_wait=risk_weighted_wait,
            horizon=[d.isoformat() for d in horizon],
            reserve=reserve,
            unscheduled_detail=unscheduled_detail,
            restarts=RestartStats(
                restarts_run=restarts_run,
                winner_index=winner_index,
                baseline_score=baseline_wait,
                winner_score=risk_weighted_wait,
                improvement_pct=(
                    round(100.0 * (baseline_wait - risk_weighted_wait) / baseline_wait, 1)
                    if baseline_wait > 0
                    else 0.0
                ),
            ),
        )
