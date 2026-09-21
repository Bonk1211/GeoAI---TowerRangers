"""Road geometry for scenario playback, never a live road-safety service.

The checked-in OSM extract is read locally. Routes respect its vehicle access,
one-way and node-via turn restrictions, plus caller-selected scenario closures.
No graph, no path or no nearby road means no movement geometry; unsurveyed
depot/site connectors are never invented.
"""
from __future__ import annotations

import gzip
import heapq
import json
import math
from functools import lru_cache
from pathlib import Path

NETWORK_PATH = Path(__file__).resolve().parents[3] / "data/simulation/sabah-roads.json.gz"
MAX_SNAP_M = 300.0
STAGING_CLEARANCE_M = 500.0
DEPLOYMENT_CLEARANCE_M = 100.0
MOBILE_STAGING_CLEARANCE_M = 1000.0
STAGING_SEARCH_M = 5000.0
STAGING_CANDIDATES = 48
SPEED_KMH = {
    "motorway": 80, "trunk": 70, "primary": 60, "secondary": 50,
    "tertiary": 40, "unclassified": 30, "residential": 25,
    "motorway_link": 40, "trunk_link": 35, "primary_link": 30,
    "secondary_link": 30, "tertiary_link": 25, "living_street": 15, "service": 15,
}
ALLOWED_ACCESS = {"yes", "permissive", "designated", "official"}
LIMITATIONS = [
    "Current OpenStreetMap snapshot, not historical or live verified road access.",
    "Closures are authored scenario assumptions, not observed road closures.",
    "Drive duration uses road-class speed estimates; traffic and flood depth are not measured.",
    "Only the mapped road-node path is drawn. Depot connectors and final site access remain unverified.",
    "Scenario staging and mobile coverage parking use mapped road nodes outside the authored flood; personnel, parking suitability and field access are unverified.",
    "Restricted/private/conditional access and unsupported turn restrictions are excluded conservatively; ferries are not routed.",
]


def distance_m(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    value = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 12_742_000 * math.asin(math.sqrt(min(1, value)))


def allowed(tags):
    # Most-specific vehicle access overrides a broader access restriction.
    if any(key.endswith(":conditional") and key.split(":")[0] in {"access", "vehicle", "motor_vehicle", "motorcar", "oneway"} for key in tags):
        return False
    for key in ("motorcar", "motor_vehicle", "vehicle", "access"):
        if key in tags:
            return tags[key] in ALLOWED_ACCESS
    return True


def _clearance(point, ring):
    """Signed planar boundary distance: positive outside, negative inside."""
    x, y = point
    inside, closest = False, math.inf
    for (ax, ay), (bx, by) in zip(ring, ring[1:]):
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        closest = min(closest, math.hypot(x - ax - t * dx, y - ay - t * dy))
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return -closest if inside else closest


def flood_clearance_m(point, ring):
    # Local equirectangular metres suffice for illustrative 100–1000 m buffers.
    scale_x = 111_195 * math.cos(math.radians(sum(p[1] for p in ring[:-1]) / (len(ring) - 1)))
    return _clearance((point[0] * scale_x, point[1] * 111_195),
        tuple((lon * scale_x, lat * 111_195) for lon, lat in ring))


class RoadNetwork:
    def __init__(self, payload):
        if payload.get("remark") or not isinstance(payload.get("elements"), list):
            raise ValueError("Incomplete OSM road extract")
        self.bounds = payload["query_bounds"]
        self.updated_at = payload.get("osm3s", {}).get("timestamp_osm_base")
        self.blocked_edge_ids = payload.get("scenario_blocked_edge_ids", [])
        self.nodes = {}
        self.adjacency = {}
        self.incoming = {}
        self.edges = {}
        self.ways = {}
        self.forbidden_turns = set()
        self.only_turns = {}
        self.no_u_turns = set()
        self.only_u_turns = set()
        rivers = []
        excluded_ways = set()
        blocked_nodes = set()
        for element in payload["elements"]:
            tags = element.get("tags", {})
            if element.get("type") == "node":
                explicit_access = any(tags.get(key) in ALLOWED_ACCESS for key in ("motorcar", "motor_vehicle", "vehicle", "access"))
                if not allowed(tags) or (tags.get("barrier") not in (None, "entrance", "toll_booth", "cattle_grid") and not explicit_access):
                    blocked_nodes.add(element["id"])
            if element.get("type") != "relation" or tags.get("type") != "restriction":
                continue
            if any(mode in tags.get("except", "").split(";") for mode in ("motorcar", "motor_vehicle", "vehicle")):
                continue
            members = element.get("members", [])
            before = [m["ref"] for m in members if m.get("role") == "from" and m.get("type") == "way"]
            after = [m["ref"] for m in members if m.get("role") == "to" and m.get("type") == "way"]
            via = [m["ref"] for m in members if m.get("role") == "via" and m.get("type") == "node"]
            restriction = tags.get("restriction:motorcar", tags.get("restriction:motor_vehicle", tags.get("restriction", "")))
            if len(before) == len(after) == len(via) == 1 and ":conditional" not in " ".join(tags):
                key = (via[0], before[0])
                if before == after and restriction == "no_u_turn":
                    self.no_u_turns.add(key)
                elif before == after and restriction == "only_u_turn":
                    self.only_u_turns.add(key)
                elif restriction.startswith("only_"):
                    self.only_turns.setdefault(key, set()).add(after[0])
                elif restriction.startswith("no_"):
                    self.forbidden_turns.add((*key, after[0]))
                else:
                    excluded_ways.update(before)
            else:
                # ponytail: no via-way restriction automaton; exclude its approach way until a full router is required.
                excluded_ways.update(before)

        for element in payload["elements"]:
            if element.get("type") != "way":
                continue
            tags = element.get("tags", {})
            points = element.get("geometry", [])
            if len(points) < 2 or any(not isinstance(p, dict) or not all(math.isfinite(p.get(k, float("nan"))) for k in ("lon", "lat")) for p in points):
                continue
            coords = [(p["lon"], p["lat"]) for p in points]
            if tags.get("waterway") in {"river", "stream", "canal"}:
                rivers.append({"type": "Feature", "properties": {"way_id": element["id"], "name": tags.get("name", "Mapped waterway"), "waterway": tags["waterway"]},
                    "geometry": {"type": "LineString", "coordinates": coords}})
            highway = tags.get("highway")
            refs = element.get("nodes", [])
            if highway not in SPEED_KMH or len(refs) != len(coords) or not allowed(tags) or element["id"] in excluded_ways or tags.get("area") == "yes":
                continue
            one_way = tags.get("oneway:motorcar", tags.get("oneway:motor_vehicle", tags.get("oneway", "yes" if tags.get("junction") == "roundabout" or highway == "motorway" else "no")))
            if one_way not in {"yes", "1", "true", "-1", "no", "0", "false"}:
                continue
            speed = SPEED_KMH[highway]
            limit = tags.get("maxspeed", "")
            try:
                numeric = float(limit.removesuffix(" mph")) * (1.609344 if limit.endswith(" mph") else 1)
                if numeric > 0:
                    speed = min(speed, numeric)
            except ValueError:
                pass
            self.ways[element["id"]] = {"name": tags.get("name", "Mapped road"), "highway": highway}
            for index, (a, b) in enumerate(zip(refs, refs[1:])):
                if a == b or a in blocked_nodes or b in blocked_nodes:
                    continue
                start, end = coords[index:index + 2]
                metres = distance_m(start, end)
                if not metres:
                    continue
                edge_id = f"{element['id']}:{index}"
                self.nodes[a], self.nodes[b] = start, end
                self.edges[edge_id] = (a, b, element["id"])
                directions = [(b, a)] if one_way == "-1" else [(a, b)] if one_way in {"yes", "1", "true"} else [(a, b), (b, a)]
                for source, target in directions:
                    self.adjacency.setdefault(source, []).append((target, edge_id, element["id"], metres, metres / speed * 0.06))
                    self.incoming.setdefault(target, []).append((source, edge_id))
        self.rivers = {"type": "FeatureCollection", "features": rivers}
        self.u_turn_nodes = {node for node, _ in self.no_u_turns | self.only_u_turns}
        if not self.nodes or any(edge not in self.edges for edge in self.blocked_edge_ids):
            raise ValueError("Road graph or authored closure is missing")
        # Disconnected access roads cannot be reached even before considering
        # direction or closures. Reject them without searching the whole region.
        parents = {node: node for node in self.nodes}
        def component(node):
            while parents[node] != node:
                parents[node] = parents[parents[node]]
                node = parents[node]
            return node
        for start, end, _ in self.edges.values():
            parents[component(start)] = component(end)
        self.components = {node: component(node) for node in self.nodes}
        self.spatial = {}
        for node, (lon, lat) in self.nodes.items():
            self.spatial.setdefault((math.floor(lon / 0.005), math.floor(lat / 0.005)), []).append(node)

    def feature(self, edge_id):
        start, end, way = self.edges[edge_id]
        return {"type": "Feature", "properties": {"edge_id": edge_id, "way_id": way, **self.ways[way]},
            "geometry": {"type": "LineString", "coordinates": [self.nodes[start], self.nodes[end]]}}

    def description(self):
        # The basemap supplies road context. Sending the full graph would exceed 150 MB.
        shown = self.blocked_edge_ids if len(self.edges) > 5000 else self.edges
        return {"status": "available", "source_updated_at": self.updated_at, "bounds": self.bounds,
            "roads": {"type": "FeatureCollection", "features": [self.feature(edge) for edge in shown]}, "rivers": self.rivers,
            "road_context": "scenario_closure_segments" if len(self.edges) > 5000 else "all_roads",
            "blocked_edge_ids": self.blocked_edge_ids, "limitations": LIMITATIONS}

    def snap(self, point):
        west, south, east, north = self.bounds
        if not west <= point[0] <= east or not south <= point[1] <= north:
            return None
        x, y = math.floor(point[0] / 0.005), math.floor(point[1] / 0.005)
        span_x = math.ceil(MAX_SNAP_M / (111_000 * math.cos(math.radians(point[1])) * 0.005))
        span_y = math.ceil(MAX_SNAP_M / (110_000 * 0.005))
        candidates = [node for dx in range(-span_x, span_x + 1) for dy in range(-span_y, span_y + 1)
            for node in self.spatial.get((x + dx, y + dy), [])]
        if not candidates:
            return None
        node = min(candidates, key=lambda key: distance_m(point, self.nodes[key]))
        gap = distance_m(point, self.nodes[node])
        return (node, gap) if gap <= MAX_SNAP_M else None

    @lru_cache(maxsize=128)
    def short_approaches(self, end, blocked, avoid=frozenset()):
        """Reject small directed access islands without repeatedly searching Sabah.

        `avoid` must be honoured here, not only in the A*: this is the cheap
        pre-check that lets an impossible leg fail fast. Without it the
        reverse walk reports "reachable" via flooded nodes, the A* then
        searches the whole component and fails, and `route`'s diagnostic
        re-searches repeat that — measured, a single flood-avoiding
        deployment leg ran past 280 s because `staged_route` does this across
        up to 48x48 candidate pairs.
        """
        seen, queue = {end}, [end]
        for node in queue:
            for source, edge in self.incoming.get(node, []):
                if edge not in blocked and source not in seen and source not in avoid:
                    seen.add(source)
                    queue.append(source)
                    if len(seen) > 4096:
                        return None  # Large approaches retain the normal A* search.
        return frozenset(seen)

    def path(self, start, end, blocked, avoid=frozenset()):
        """`avoid` is a node set the path may not traverse.

        Used for the scenario's flood exclusion: MCMC practice does not send a
        ground crew through standing water, and before this existed
        `staged_route` constrained only its ENDPOINTS — it picked staging and
        deployment nodes outside the flood ring and then routed between them
        with an unconstrained search. Measured on the saved network
        (2026-09-21), a mobile-network leg whose staging and deployment were
        both correctly outside the ring still put **317 of its 679 route
        points inside the flood**, and a repair leg targeting a down tower put
        419 of 539 inside. The map drew crews driving through the flood while
        the code reported them staged outside it.

        Endpoints are deliberately exempt (see the `_ in avoid` guards being
        absent for `start`/`end`): a leg may legitimately begin or end on a
        node the clearance test calls flooded — the depot itself sits inside
        this scenario's ring — and rejecting those here would fail the leg for
        a reason the caller has already handled by relocating the origin.
        """
        if self.components[start] != self.components[end]:
            return None
        approaches = self.short_approaches(end, blocked, avoid)
        if approaches is not None and start not in approaches:
            return None
        # Straight-line time at the profile's maximum speed is an admissible
        # lower bound; A* avoids searching all of Sabah for a local detour.
        def remaining(node):
            return distance_m(self.nodes[node], self.nodes[end]) / max(SPEED_KMH.values()) * 0.06

        queue = [(remaining(start), 0.0, start, -1, -1)]
        distances = {(start, -1, -1): 0.0}
        previous = {}
        final = None
        while queue:
            _, cost, node, before, incoming = heapq.heappop(queue)
            state = (node, before, incoming)
            if cost != distances[state]:
                continue
            if node == end:
                final = state
                break
            for target, edge_id, way, metres, minutes in self.adjacency.get(node, []):
                # `target != end` keeps the destination reachable even when it
                # is itself inside the flood — the caller decides whether a
                # flooded destination is permitted, not the search.
                if edge_id in blocked or (node, before, way) in self.forbidden_turns:
                    continue
                if target in avoid and target != end:
                    continue
                reversing = before == way and target == incoming
                if ((node, before) in self.no_u_turns and reversing) or ((node, before) in self.only_u_turns and not reversing):
                    continue
                permitted = self.only_turns.get((node, before))
                if permitted is not None and way not in permitted:
                    continue
                # Only U-turn restrictions need the incoming node; ordinary
                # turns depend on the incoming way, keeping the search small.
                next_state = (target, way, node if target in self.u_turn_nodes else -1)
                if cost + minutes < distances.get(next_state, math.inf):
                    distances[next_state] = cost + minutes
                    previous[next_state] = (state, edge_id, metres)
                    heapq.heappush(queue, (cost + minutes + remaining(target), cost + minutes, *next_state))
        if final is None:
            return None
        path, edge_ids, metres = [self.nodes[final[0]]], [], 0.0
        cursor = final
        while cursor in previous:
            parent, edge, length = previous[cursor]
            edge_ids.append(edge)
            metres += length
            path.append(self.nodes[parent[0]])
            cursor = parent
        return list(reversed(path)), list(reversed(edge_ids)), metres / 1000, distances[final]

    @lru_cache(maxsize=4)
    def flood_nodes(self, ring):
        """Mapped nodes standing inside the authored flood ring.

        The complement of `outside_nodes`, computed the same way and cached
        the same way, and the set `staged_route` hands to `path` as `avoid`
        so a ground route cannot traverse standing water. MCMC practice
        allows crews in before a flood and during recovery, not through the
        middle of one — so the caller supplies this only for the impact and
        response window, never for the pre-event or recovery legs.

        Scanned over the whole network bbox rather than `outside_nodes`'
        boundary band: a node deep inside the ring is exactly the one that
        must be excluded, and the band-limited scan there deliberately skips
        anything further than STAGING_SEARCH_M from the boundary.
        """
        scale_x = 111_195 * math.cos(math.radians(sum(p[1] for p in ring[:-1]) / (len(ring) - 1)))
        projected = tuple((lon * scale_x, lat * 111_195) for lon, lat in ring)
        west, south, east, north = self.bounds
        x0, x1 = math.floor(max(west, min(p[0] for p in ring)) / 0.005), math.floor(min(east, max(p[0] for p in ring)) / 0.005)
        y0, y1 = math.floor(max(south, min(p[1] for p in ring)) / 0.005), math.floor(min(north, max(p[1] for p in ring)) / 0.005)
        flooded = set()
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                for node in self.spatial.get((x, y), []):
                    lon, lat = self.nodes[node]
                    if _clearance((lon * scale_x, lat * 111_195), projected) < 0:
                        flooded.add(node)
        return frozenset(flooded)

    @lru_cache(maxsize=4)
    def dry_components(self, ring):
        """Connected components of the network with flooded nodes removed.

        `staged_route` sweeps up to 48 deployment endpoints x 48 staging
        origins. Testing each pair with a real A* costs ~28 ms when it fails,
        so one unroutable leg ran ~64 s and six legs ran 75 s — measured
        before this existed. Almost all of those pairs are unroutable for the
        SAME reason (the flood severs the approach for the whole
        neighbourhood, not for one unlucky pair), so this precomputes
        reachability once per ring and turns each pair test into an O(1)
        component comparison. Undirected, so it is a NECESSARY condition
        rather than a sufficient one: a pair in the same dry component still
        goes through the real directed search, and a pair in different ones
        is skipped without one.
        """
        flooded = self.flood_nodes(ring)
        parents = {}

        def find(node):
            while parents.get(node, node) != node:
                parents[node] = parents.get(parents[node], parents[node])
                node = parents[node]
            return node

        for start, end, _ in self.edges.values():
            if start in flooded or end in flooded:
                continue
            a, b = find(start), find(end)
            if a != b:
                parents[a] = b
        return {node: find(node) for node in self.nodes if node not in flooded}

    @lru_cache(maxsize=256)
    def route(self, origin, destination, blocked=frozenset(), avoid=frozenset()):
        result = {"status": "outside_network", "coordinates": [], "edge_ids": [], "distance_km": None, "duration_minutes": None,
            "origin_snap": None, "destination_snap": None, "last_mile": "unverified", "reason": None}
        start, end = self.snap(origin), self.snap(destination)
        for key, snap in (("origin_snap", start), ("destination_snap", end)):
            if snap:
                lon, lat = self.nodes[snap[0]]
                result[key] = {"lon": lon, "lat": lat, "distance_m": round(snap[1], 1)}
        if start is None or end is None:
            result["reason"] = "Endpoint is outside the saved road network or more than 300 m from a mapped road node."
            return result
        route = self.path(start[0], end[0], blocked, avoid)
        if route is None:
            # Distinguish the three reasons a leg can fail, because they mean
            # different things to a planner: the flood stands between the crew
            # and the site (hold until the water drops), a scenario closure
            # blocks the way (hold for access review), or no road connection
            # exists at all. A flood hold is reported first — it is the
            # binding constraint and the one MCMC practice acts on.
            # The flood check runs FIRST and short-circuits: when the flood is
            # what blocks the leg, the closure re-search below is both
            # redundant and expensive, and `staged_route` calls this per
            # candidate pair.
            if avoid and self.path(start[0], end[0], blocked) is not None:
                result["status"] = "blocked"
                result["reason"] = "No mapped road route avoids the flood; crews hold outside it until the water drops."
                return result
            blocked_route = bool(blocked) and self.path(start[0], end[0], frozenset(), avoid) is not None
            result["status"] = "blocked" if blocked_route else "unreachable"
            result["reason"] = "Scenario closures prevent a mapped road route." if blocked_route else "No directed, permitted road connection exists in this saved network."
            return result
        coords, edges, km, minutes = route
        result.update(status="routed", coordinates=coords, edge_ids=edges, distance_km=round(km, 3), duration_minutes=round(minutes, 2))
        return result

    @lru_cache(maxsize=4)
    def outside_nodes(self, ring):
        """Classify local mapped nodes once per polygon, shared by every unit."""
        scale_x = 111_195 * math.cos(math.radians(sum(p[1] for p in ring[:-1]) / (len(ring) - 1)))
        projected = tuple((lon * scale_x, lat * 111_195) for lon, lat in ring)
        west, south, east, north = self.bounds
        lon_buffer = STAGING_SEARCH_M / max(1, abs(scale_x))
        lat_buffer = STAGING_SEARCH_M / 111_195
        x0 = math.floor(max(west, min(p[0] for p in ring) - lon_buffer) / 0.005)
        x1 = math.floor(min(east, max(p[0] for p in ring) + lon_buffer) / 0.005)
        y0 = math.floor(max(south, min(p[1] for p in ring) - lat_buffer) / 0.005)
        y1 = math.floor(min(north, max(p[1] for p in ring) + lat_buffer) / 0.005)
        outside = []
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                for node in self.spatial.get((x, y), []):
                    lon, lat = self.nodes[node]
                    clearance = _clearance((lon * scale_x, lat * 111_195), projected)
                    if DEPLOYMENT_CLEARANCE_M <= clearance <= STAGING_SEARCH_M:
                        outside.append((node, clearance))
        return tuple(outside)

    @lru_cache(maxsize=256)
    def staged_route(self, origin, destination, blocked, ring, stage_origin, deploy_outside, avoid_flood=False):
        """Scenario-only road staging; never relocate a repair's target snap."""
        empty = {"status": "unreachable", "coordinates": [], "edge_ids": [], "distance_km": None,
            "duration_minutes": None, "origin_snap": None, "destination_snap": None,
            "last_mile": "unverified", "staging": None, "deployment": None,
            "reason": "No permitted route found in the bounded outside-flood staging search; hold for access review."}
        west, south, east, north = self.bounds
        if not west <= destination[0] <= east or not south <= destination[1] <= north:
            return {**empty, "status": "outside_network", "reason": "Affected target is outside the saved road network."}
        end = self.snap(destination)
        if not deploy_outside and end is None:
            return {**empty, "status": "outside_network", "reason": "Target is more than 300 m from a mapped road node; its location was not moved."}
        start = None if stage_origin else self.snap(origin)
        if not stage_origin and start is None:
            return {**empty, "status": "outside_network", "reason": "Origin is outside the mapped road network; hold for access review."}
        outside = self.outside_nodes(ring)
        # The flood exclusion applies to the DRIVEN path only. Staging and
        # deployment candidate selection already tests clearance against the
        # same ring, so the endpoints were never the problem — the route
        # between them was.
        avoid = self.flood_nodes(ring) if avoid_flood else frozenset()
        # O(1) reachability for the candidate sweep — see `dry_components`
        # for the measurement that made this necessary. Keeps the full
        # STAGING_CANDIDATES budget rather than truncating it, so the flood
        # changes which pairs are viable, never how hard we look.
        dry = self.dry_components(ring) if avoid else None
        # ponytail: inspect at most 48 nearby candidates per endpoint within 5 km
        # of the boundary; use a multi-source router if larger staging areas are needed.
        def candidates(clearance, target, component=None):
            return heapq.nsmallest(STAGING_CANDIDATES,
                (node for node, gap in outside if gap >= clearance and
                    (component is None or self.components[node] == component)),
                key=lambda node: (distance_m(target, self.nodes[node]), node))

        endpoints = candidates(DEPLOYMENT_CLEARANCE_M, destination,
            None if stage_origin else self.components[start[0]]) if deploy_outside else [end[0]]
        blocked_path = False
        for endpoint in endpoints:
            target = self.nodes[endpoint] if deploy_outside else destination
            origins = candidates(MOBILE_STAGING_CLEARANCE_M if deploy_outside else STAGING_CLEARANCE_M,
                destination, self.components[endpoint]) if stage_origin else [start[0]]
            for node in origins:
                if deploy_outside and node == endpoint:
                    continue
                # Skip pairs the flood has already severed, without paying
                # for a full directed search to rediscover it. Only applied
                # when the endpoint is itself dry: a leg targeting a tower
                # INSIDE the flood (deploy_outside False) has a flooded
                # endpoint that sits in no dry component, and skipping on
                # that would reject every pair before the real search gets
                # to decide — `path` exempts the destination for exactly
                # this reason.
                if dry is not None and endpoint in dry and dry.get(node) != dry[endpoint]:
                    continue
                mapped_origin = self.nodes[node] if stage_origin else origin
                result = self.route(mapped_origin, target, blocked, avoid)
                if result["status"] != "routed":
                    blocked_path |= result["status"] == "blocked"
                    continue
                staging = dict(zip(("lon", "lat"), self.nodes[node])) if stage_origin else None
                deployment = dict(zip(("lon", "lat"), self.nodes[endpoint])) if deploy_outside else None
                # The device stays here; its carrier uses a separately routed exit.
                destination_snap = {**result["destination_snap"], "distance_m": round(distance_m(destination, self.nodes[endpoint]), 1)}
                departure = {"departure_route": self.route(result["coordinates"][-1], result["coordinates"][0], blocked, avoid)} if deploy_outside else {}
                return {**result, "staging": staging, "deployment": deployment, "destination_snap": destination_snap, **departure}
        return {**empty, "status": "blocked" if blocked_path else "unreachable"}


@lru_cache(maxsize=1)
def _load(path, modified_ns):
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return RoadNetwork(json.load(source))


def get_network():
    try:
        return _load(str(NETWORK_PATH), NETWORK_PATH.stat().st_mtime_ns)
    except (OSError, ValueError, KeyError, TypeError, EOFError):
        return None
