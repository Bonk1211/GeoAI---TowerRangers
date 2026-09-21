"""Layer 3: contextual red flags no feature column records.

The BehavioralProfiler scores a tower against human-defined rules over its
operating context — whether any crew can reach it, whether it was scored on a
complete feature row, whether a live forecast couples to its dominant factor.
"Behavioral" describes the SITE's context, not a person.

Why a third layer at all. The supervised model reads twelve environmental
columns and nothing else; the isolation forest reads eleven of the same ones.
Neither can express "no crew territory rosters this tower", which is not a
property of its environment but of the roster, and which makes the tower
undispatchable no matter what either model says about it. Rules are also the
only layer here that is auditable line by line, which is what lets a planner
disagree with one.

WHAT THIS LAYER MAY NOT READ, and the reason is measured rather than cautious.
No rule may touch maintenance history. The served label is the site's own ticket
count thresholded at one — on the shipped dataset both quantities select the
same 246 rows — so a rule reading that history predicts the target by
construction. It would report near-perfect accuracy the way the withdrawn
`maintenance_classifier` reported 0.974 AUC for inverting a threshold it had
been handed. A repeat-visit rule is the most natural rule to want here and it is
precisely the one that cannot exist in this framing. `model/test_ensemble.py`
parses this module's AST and fails the build on those column names. The honest
home for site history is the monthly panel, whose recency columns are computed
strictly before each row's reference date.

These flags are DESCRIPTIVE. They are shown to a planner and nothing consumes
them: they do not enter `risk`, and since the escalation gate was removed (see
adapter/ml_source.py for the matched-budget measurement that removed it) they do
not enter `decision` either. Each rule carried a numeric `weight` while the gate
existed; that weight had no other consumer and went with it, along with the
`flag_score()` sum it fed.

Rule PREDICATES live here; every threshold, label and on/off switch
lives in `config/profiler.yaml`. A rules expression language in YAML would be a
second language to debug for no gain — `policy.yaml` sets the precedent that
config carries parameters, not logic. Construction asserts the two sides match
in both directions, so a rule added to the YAML without a predicate (or the
reverse) fails immediately rather than silently never firing.

Imports from `scheduler/`, which inverts this project's usual direction
(adapter and scheduler import model). Deliberate: `adapter/ml_source.py`
already imports `scheduler.config_loader`, the crew roster and travel model
genuinely live there, and the alternative is a second copy of both.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Callable

import pandas as pd

from scheduler.actions import load_action_map
from scheduler.config_loader import load_crews, load_policy, load_profiler
from scheduler.optimize import travel_km

def _territory_of(record: dict) -> str:
    return str(record.get("territory") or "")


def _flood_share(record: dict) -> float:
    return float((record.get("attribution") or {}).get("flood", 0.0))


# --- predicates -------------------------------------------------------------
# Each takes (profiler, record, matrix_row) and returns a bool. Signature is
# uniform so the registry below can be checked against the YAML in both
# directions; a predicate that needed a different one would be a sign the rule
# belongs somewhere else.


def _unassigned_territory(prof: "BehavioralProfiler", record: dict, row: pd.Series) -> bool:
    """No crew in the roster covers this tower's territory.

    Stated as "no crew rosters it" rather than "territory == 'unassigned'" on
    purpose. That literal is the adapter's, and a second copy here would drift;
    more usefully, the roster test also catches the Malacca/Melaka class of
    fault, where a real state spelled the way the boundary file spells it
    silently matches no crew and every tower in it becomes undispatchable
    without anything raising.
    """
    return not prof.crews_for(_territory_of(record))


def _out_of_crew_range(prof: "BehavioralProfiler", record: dict, row: pd.Series) -> bool:
    """Crews exist for this territory, but every depot is beyond its own range.

    Mutually exclusive with the rule above by construction, so a tower cannot
    collect both weights for one underlying fact.
    """
    crews = prof.crews_for(_territory_of(record))
    if not crews:
        return False
    return all(
        travel_km(crew, record, prof.road_factor)
        > crew.get("max_travel_km", prof.max_travel_km_default)
        for crew in crews
    )


def _incomplete_evidence(prof: "BehavioralProfiler", record: dict, row: pd.Series) -> bool:
    return bool(row.isna().any())


def _unmapped_asset(prof: "BehavioralProfiler", record: dict, row: pd.Series) -> bool:
    return record.get("radio") == "UNKNOWN"


def _storm_coupled(prof: "BehavioralProfiler", record: dict, row: pd.Series) -> bool:
    """A live forecast fired a driver at a site whose risk is flood-shaped.

    `record["weather"]` is None both when the forecast is switched off and when
    Earth Engine was unreachable — "we could not ask" in both cases — so this
    must not fire, and equally must not render as a checked-and-clear result.
    Absence of the flag under a null forecast means nothing was asked.
    """
    weather = record.get("weather")
    if not weather or not weather.get("drivers"):
        return False
    return _flood_share(record) >= prof.flood_zone_share_threshold


def _monsoon_blocked(prof: "BehavioralProfiler", record: dict, row: pd.Series) -> bool:
    """Flood-zone site whose intervention needs a crew type blocked this month.

    Reads the same pinned `demo_clock.today` the optimizer builds its window
    against, so the flag and the schedule cannot disagree about what month it
    is. Under the shipped clock (August) the monsoon window is closed and this
    rule correctly fires on nothing.
    """
    if prof.today.month not in prof.monsoon_months:
        return False
    in_flood_zone = (
        record.get("dominant_factor") == "flood"
        or _flood_share(record) >= prof.flood_zone_share_threshold
    )
    if not in_flood_zone:
        return False
    action = prof.actions.get(str(record.get("dominant_factor")))
    return bool(action) and action.get("crew_type") in prof.blocked_crew_types


def _model_high_ground_quiet(prof: "BehavioralProfiler", record: dict, row: pd.Series) -> bool:
    """Top-band site with measured quiet change AND quiet telemetry."""
    if pd.isna(record.get("change")) or pd.isna(record.get("condition")):
        return False
    rule = prof.rules["model_high_ground_quiet"]
    return bool(record.get("decision") == "maintain"
                and record["change"] <= rule["max_change"]
                and record["condition"] <= rule["max_condition"])


def _model_low_ground_active(prof: "BehavioralProfiler", record: dict, row: pd.Series) -> bool:
    """Below-median site with measured satellite growth; absence is not quiet."""
    if pd.isna(record.get("change")) or pd.isna(record.get("priority")):
        return False
    rule = prof.rules["model_low_ground_active"]
    return bool(record["priority"] < rule["max_priority"]
                and record["change"] >= rule["min_change"])


PREDICATES: dict[str, Callable[["BehavioralProfiler", dict, pd.Series], bool]] = {
    "unassigned_territory": _unassigned_territory,
    "out_of_crew_range": _out_of_crew_range,
    "incomplete_evidence": _incomplete_evidence,
    "unmapped_asset": _unmapped_asset,
    "storm_coupled": _storm_coupled,
    "monsoon_blocked": _monsoon_blocked,
    "model_high_ground_quiet": _model_high_ground_quiet,
    "model_low_ground_active": _model_low_ground_active,
}


class BehavioralProfiler:
    """Evaluates config/profiler.yaml's rules against one scored-tower record.

    Constructed once per process (adapter/ml_source.py's _AdapterCache) and
    called per tower. Config, roster and policy are injectable so tests need no
    files on disk and no network.
    """

    def __init__(
        self,
        config: dict[str, Any] | None = None,
        crews: list[dict] | None = None,
        policy: dict[str, Any] | None = None,
        actions: dict[str, dict] | None = None,
    ) -> None:
        self.config = config if config is not None else load_profiler()
        self.crews = crews if crews is not None else load_crews()
        self.policy = policy if policy is not None else load_policy()
        self.actions = actions if actions is not None else load_action_map()

        self.rules: dict[str, dict] = self.config.get("rules", {})
        missing = set(self.rules) - set(PREDICATES)
        orphaned = set(PREDICATES) - set(self.rules)
        # Both directions. A YAML rule with no predicate would never fire and
        # look merely quiet; a predicate with no YAML entry has no weight or
        # label and would raise mid-request instead of at construction.
        if missing or orphaned:
            raise ValueError(
                f"profiler.yaml and PREDICATES disagree — "
                f"no predicate for {sorted(missing)}, no config for {sorted(orphaned)}"
            )

        travel = self.policy.get("travel", {})
        self.road_factor = float(travel.get("road_factor", 1.0))
        self.max_travel_km_default = float(travel.get("max_travel_km_default", 120))

        monsoon = self.policy.get("monsoon", {})
        self.monsoon_months = set(monsoon.get("months", []))
        self.blocked_crew_types = set(monsoon.get("blocked_crew_types", []))
        self.flood_zone_share_threshold = float(
            monsoon.get("flood_zone_share_threshold", 1.0)
        )
        self.today = date.fromisoformat(
            str(self.policy.get("demo_clock", {}).get("today", date.today().isoformat()))
        )

        self._by_territory: dict[str, list[dict]] = {}
        for crew in self.crews:
            self._by_territory.setdefault(str(crew.get("territory")), []).append(crew)

    def crews_for(self, territory: str) -> list[dict]:
        return self._by_territory.get(territory, [])

    def flags(self, record: dict, matrix_row: pd.Series) -> list[dict]:
        """Every enabled rule that fires, in config order.

        Each flag carries its `detail` sentence from the YAML rather than
        leaving the UI to compose one, so changing what a flag says is a config
        edit and every surface says the same thing.
        """
        out: list[dict] = []
        for rule_id, rule in self.rules.items():
            if not rule.get("enabled", True):
                continue
            if PREDICATES[rule_id](self, record, matrix_row):
                out.append(
                    {
                        "id": rule_id,
                        "label": str(rule.get("label", rule_id)),
                        "detail": str(rule.get("detail", "")),
                    }
                )
        return out
