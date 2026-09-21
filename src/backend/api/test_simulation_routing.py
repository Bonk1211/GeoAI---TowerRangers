"""Network-free routing contract: python api/test_simulation_routing.py."""
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import travel
from scheduler import simulation_routing as routing


POINTS = {
    1: [116.000, 6.000], 2: [116.005, 6.004], 3: [116.010, 6.000],
    4: [116.000, 6.012], 5: [116.010, 6.012],
    # This disconnected road is closer than the connected road to node 6.
    6: [116.0004, 6.0004], 7: [116.0008, 6.0004],
    8: [116.020, 6.000], 9: [116.025, 6.000], 10: [116.030, 6.000],
    11: [116.000, 6.020],
}


def _way(way_id, nodes, **tags):
    return {"type": "way", "id": way_id, "nodes": nodes,
            "geometry": [{"lon": POINTS[n][0], "lat": POINTS[n][1]} for n in nodes],
            "tags": {"highway": "residential", "name": f"Road {way_id}", **tags}}


def _leg(origin=1, destination=3, leg_id="crew-to-site"):
    return {"id": leg_id,
            "from": dict(zip(("lon", "lat"), POINTS[origin])),
            "to": dict(zip(("lon", "lat"), POINTS[destination]))}


def test_simulation_road_contract():
    network = routing.RoadNetwork({
        "query_bounds": [115.99, 5.99, 116.05, 6.03],
        "osm3s": {"timestamp_osm_base": "2026-09-20T00:00:00Z"},
        "elements": [_way(10, [1, 2, 3]), _way(20, [1, 4, 5, 3]),
                     _way(25, [6, 7]), _way(30, [8, 9, 10], oneway="yes"),
                     _way(40, [1, 3], access="private"),
                     _way(41, [1, 3], access="no"),
                     _way(42, [1, 3], motor_vehicle="no")],
    })
    app = FastAPI()
    app.include_router(travel.router)
    with TestClient(app) as client, patch.object(routing, "get_network", return_value=network):
        response = client.get("/travel/simulation-network")
        assert response.status_code == 200, response.text
        snapshot = response.json()
        assert snapshot["status"] == "available"
        assert snapshot["source_updated_at"] == "2026-09-20T00:00:00Z"
        assert snapshot["bounds"] == [115.99, 5.99, 116.05, 6.03]
        edges = {feature["properties"]["edge_id"] for feature in snapshot["roads"]["features"]}
        assert edges == {"10:0", "10:1", "20:0", "20:1", "20:2", "25:0", "30:0", "30:1"}

        def routes(legs, blocked=()):
            response = client.post("/travel/simulation-routes", json={
                "legs": legs, "blocked_edge_ids": list(blocked),
            })
            assert response.status_code == 200, response.text
            return response.json()["legs"]

        leg = _leg()
        leg["from"] = {"lon": 116.00005, "lat": 6.00002}
        normal = routes([leg])[0]
        assert normal["id"] == leg["id"] and normal["status"] == "routed"
        assert normal["coordinates"] == [POINTS[n] for n in (1, 2, 3)]
        assert normal["edge_ids"] == ["10:0", "10:1"]
        assert 1.40 < normal["distance_km"] < 1.45 and normal["duration_minutes"] > 0
        assert normal["last_mile"] == "unverified"
        assert 0 < normal["origin_snap"]["distance_m"] < 20
        assert normal["origin_snap"]["lon"] == POINTS[1][0]
        assert normal["destination_snap"]["distance_m"] == 0

        detour = routes([_leg()], ["10:0"])[0]
        assert detour["status"] == "routed"
        assert detour["coordinates"] == [POINTS[n] for n in (1, 4, 5, 3)]
        assert detour["edge_ids"] == ["20:0", "20:1", "20:2"]
        assert not set(detour["edge_ids"]) & {"10:0"}
        assert detour["distance_km"] > normal["distance_km"]
        assert detour["duration_minutes"] > normal["duration_minutes"]
        # Closing an undirected segment removes both permitted directions.
        for blocked in routes([_leg(), _leg(3, 1, "return")], ["10:0", "20:0"]):
            assert blocked["status"] == "blocked"
            assert blocked["coordinates"] == [] and blocked["edge_ids"] == []
            assert blocked["distance_km"] is None and blocked["duration_minutes"] is None

        forward, reverse, isolated = routes([_leg(8, 10, "forward"),
                                            _leg(10, 8, "reverse"), _leg(6, 3, "isolated")])
        assert forward["status"] == "routed" and forward["coordinates"] == [POINTS[n] for n in (8, 9, 10)]
        for inaccessible in (reverse, isolated):
            assert inaccessible["status"] == "unreachable" and inaccessible["coordinates"] == []
        assert isolated["origin_snap"]["lon"] == POINTS[6][0]

        sequence = [{**_leg(1, 3, "A-first"), "sequence_group": "A"},
                    {**_leg(3, 6, "A-unreachable"), "sequence_group": "A"},
                    {**_leg(6, 1, "A-resume"), "sequence_group": "A"},
                    {**_leg(8, 10, "B-first"), "sequence_group": "B"},
                    {**_leg(6, 1, "ungrouped"), "sequence_group": None}]
        sequence[0]["to"] = {"lon": 116.01001, "lat": 6.00003}
        first, deferred, resumed, independent, ungrouped = routes(sequence)
        assert first["status"] == "routed"
        assert deferred["status"] == "unreachable" and deferred["coordinates"] == []
        assert deferred["origin_snap"]["distance_m"] == 0  # Depart the reached road node.
        assert resumed["status"] == "routed"
        assert resumed["coordinates"] == [POINTS[n] for n in (3, 2, 1)]
        assert independent["status"] == "routed"
        assert independent["coordinates"] == [POINTS[n] for n in (8, 9, 10)]
        assert ungrouped["status"] == "unreachable" and ungrouped["coordinates"] == []

        # Inside the extract but beyond 300 m of every road is still unsupported.
        distant = _leg()
        distant["from"] = {"lon": 116.045, "lat": 6.025}
        assert routes([distant])[0]["status"] == "outside_network"

        assert client.post("/travel/simulation-routes", json={
            "legs": [_leg()], "blocked_edge_ids": ["unknown:0"],
        }).status_code == 400
        for point in ({"lon": 181, "lat": 6}, {"lon": 116, "lat": -91},
                      {"lon": "nan", "lat": 6}, {"lon": 116, "lat": "inf"}):
            invalid = _leg()
            invalid["from"] = point
            assert client.post("/travel/simulation-routes", json={"legs": [invalid]}).status_code == 422
        for body in ({"legs": [_leg(leg_id=str(i)) for i in range(65)]},
                     {"legs": [_leg()], "blocked_edge_ids": ["10:0"] * 257}):
            assert client.post("/travel/simulation-routes", json=body).status_code == 422
        for group in ("", "A" * 161):
            assert client.post("/travel/simulation-routes", json={
                "legs": [{**_leg(), "sequence_group": group}],
            }).status_code == 422

        with patch.object(routing, "get_network", return_value=None):
            unavailable = client.get("/travel/simulation-network").json()
            assert unavailable["status"] == "unavailable"
            assert unavailable["roads"]["features"] == []
            missing = routes([_leg()])[0]
            assert missing["status"] == "unavailable" and missing["coordinates"] == []
            assert missing["distance_km"] is None and missing["duration_minutes"] is None


def test_turn_restrictions():
    payload = {"query_bounds": [115.99, 5.99, 116.05, 6.03], "elements": [
        _way(10, [1, 2, 3]), _way(20, [1, 4, 5, 3]), _way(21, [5, 8]),
    ]}
    origin, destination = tuple(POINTS[2]), tuple(POINTS[5])
    normal = routing.RoadNetwork(payload).route(origin, destination)
    assert normal["coordinates"] == [tuple(POINTS[n]) for n in (2, 3, 5)]
    restriction = {"type": "relation", "id": 100,
        "tags": {"type": "restriction", "restriction": "no_right_turn"},
        "members": [{"type": "way", "ref": 10, "role": "from"},
                    {"type": "node", "ref": 3, "role": "via"},
                    {"type": "way", "ref": 20, "role": "to"}]}
    payload["elements"].append(restriction)
    detour = routing.RoadNetwork(payload).route(origin, destination)
    assert detour["status"] == "routed"
    assert detour["coordinates"] == [tuple(POINTS[n]) for n in (2, 1, 4, 5)]
    assert detour["distance_km"] > normal["distance_km"]
    # Unsupported via-way restrictions must exclude their approach road.
    restriction["members"][1] = {"type": "way", "ref": 20, "role": "via"}
    restriction["members"][2] = {"type": "way", "ref": 21, "role": "to"}
    conservative = routing.RoadNetwork(payload)
    assert not {"10:0", "10:1"} & conservative.edges.keys()
    assert {"20:0", "20:1", "20:2", "21:0"} <= conservative.edges.keys()


def test_same_way_uturn_restrictions():
    restriction = {"type": "relation", "id": 101,
        "tags": {"type": "restriction", "restriction": "no_u_turn"},
        "members": [{"type": "way", "ref": 10, "role": "from"},
                    {"type": "node", "ref": 2, "role": "via"},
                    {"type": "way", "ref": 10, "role": "to"}]}
    payload = {"query_bounds": [115.99, 5.99, 116.05, 6.03],
               "elements": [_way(10, [1, 2, 3]), restriction]}
    for kind, status in (("no_u_turn", "routed"), ("only_u_turn", "unreachable")):
        restriction["tags"]["restriction"] = kind
        network = routing.RoadNetwork(payload)
        for nodes in ((1, 2, 3), (3, 2, 1)):
            route = network.route(tuple(POINTS[nodes[0]]), tuple(POINTS[nodes[-1]]))
            assert route["status"] == status, (kind, nodes, route)
            expected = [tuple(POINTS[n]) for n in nodes] if status == "routed" else []
            assert route["coordinates"] == expected
        # Starting at the via node has no incoming turn to restrict.
        assert network.route(tuple(POINTS[2]), tuple(POINTS[3]))["status"] == "routed"


def test_ground_routes_never_cross_the_flood_while_it_stands():
    """MCMC practice: no ground crew drives through standing water.

    Guards the fault this flag was added for (2026-09-21). `staged_route`
    constrained only its ENDPOINTS, so on the saved Sabah network a
    mobile-network leg whose staging and deployment were both correctly
    outside the flood still put 317 of its 679 route points inside it, and a
    repair leg targeting a down tower put 419 of 539 inside.
    """
    # Node 2 is the only node of road 10 inside the ring, so excluding it
    # forces the detour via road 20 (nodes 4, 5) that runs outside.
    ring = [[116.003, 6.002], [116.007, 6.002], [116.007, 6.006], [116.003, 6.006], [116.003, 6.002]]
    polygon = {"type": "Polygon", "coordinates": [ring]}
    network = routing.RoadNetwork({"query_bounds": [115.99, 5.99, 116.05, 6.03],
        "elements": [_way(10, [1, 2, 3]), _way(20, [1, 4, 5, 3])]})
    assert routing.flood_clearance_m(tuple(POINTS[2]), ring) < 0, "fixture: node 2 must be inside the ring"

    app = FastAPI()
    app.include_router(travel.router)
    with TestClient(app) as client, patch.object(routing, "get_network", return_value=network):
        crossing = {**_leg(1, 3, "crossing"), "avoid_flood": False}
        around = {**_leg(1, 3, "around"), "avoid_flood": True}
        legs = client.post("/travel/simulation-routes", json={
            "flood_polygon": polygon, "legs": [crossing, around]}).json()["legs"]
        unconstrained, constrained = legs

        # Unconstrained takes the short way, straight through the flood.
        assert unconstrained["status"] == "routed"
        assert POINTS[2] in unconstrained["coordinates"]

        # Constrained detours around it, and NO point of the route is inside.
        assert constrained["status"] == "routed"
        assert POINTS[2] not in constrained["coordinates"]
        assert constrained["coordinates"] == [POINTS[n] for n in (1, 4, 5, 3)]
        for lon, lat in constrained["coordinates"]:
            assert routing.flood_clearance_m((lon, lat), ring) >= 0

        # With the only dry detour closed, the leg HOLDS rather than taking
        # the wet road — a degraded answer, never a quiet fallback.
        held = client.post("/travel/simulation-routes", json={
            "flood_polygon": polygon, "legs": [around], "blocked_edge_ids": ["20:0"]}).json()["legs"][0]
        assert held["status"] == "blocked"
        assert held["coordinates"] == []
        assert "flood" in held["reason"].lower()

        # avoid_flood without a polygon is rejected, never silently ignored.
        assert client.post("/travel/simulation-routes", json={"legs": [around]}).status_code == 422


def test_outside_flood_staging_and_mobile_deployment():
    ring = [[116.004, 5.997], [116.013, 5.997], [116.013, 6.008], [116.004, 6.008], [116.004, 5.997]]
    polygon = {"type": "Polygon", "coordinates": [ring]}
    network = routing.RoadNetwork({"query_bounds": [115.99, 5.99, 116.05, 6.03],
        "elements": [_way(10, [1, 2, 3]), _way(20, [1, 4, 5, 3]), _way(25, [6, 7]), _way(50, [11, 4])]})
    app = FastAPI()
    app.include_router(travel.router)
    with TestClient(app) as client, patch.object(routing, "get_network", return_value=network):
        body = {"flood_polygon": polygon, "legs": [
            {**_leg(1, 6, "no-invented-connection"), "sequence_group": "unit-1", "stage_outside_flood": True},
            {**_leg(1, 3, "staged-repair"), "sequence_group": "unit-1", "stage_outside_flood": True},
            {**_leg(1, 2, "next-stop"), "sequence_group": "unit-1", "stage_outside_flood": True},
            {**_leg(1, 3, "mobile"), "stage_outside_flood": True, "destination_outside_flood": True},
        ], "blocked_edge_ids": ["20:0"]}
        response = client.post("/travel/simulation-routes", json=body)
        assert response.status_code == 200, response.text
        held, repair, following, mobile = response.json()["legs"]
        assert held["status"] == "unreachable" and held["coordinates"] == []
        assert held["origin_snap"] is None  # Never fall back to the supplied depot.
        assert repair["status"] == following["status"] == mobile["status"] == "routed"
        assert repair["staging"] == {"lon": POINTS[4][0], "lat": POINTS[4][1]}
        assert held["staging"] == repair["staging"]  # Group metadata includes deferred jobs.
        assert repair["coordinates"] == [POINTS[n] for n in (4, 5, 3)]
        assert repair["origin_source"] == "mapped_staging"
        assert repair["origin_snap"]["distance_m"] == 0
        assert following["staging"] == repair["staging"]
        assert following["origin_source"] == "previous_stop"
        assert following["coordinates"] == [POINTS[n] for n in (3, 2)]
        assert mobile["deployment"] == {"lon": POINTS[1][0], "lat": POINTS[1][1]}
        assert mobile["staging"] == {"lon": POINTS[11][0], "lat": POINTS[11][1]}
        assert mobile["destination_snap"]["distance_m"] > routing.MAX_SNAP_M
        assert mobile["last_mile"] == "unverified" and mobile["distance_km"] > 0
        departure = mobile["departure_route"]
        assert departure["status"] == "routed"
        assert departure["coordinates"][0] == mobile["coordinates"][-1]
        assert departure["coordinates"][-1] == mobile["coordinates"][0]
        assert "20:0" not in departure["edge_ids"] and "departure_route" not in departure
        assert "departure_route" not in repair
        for result, clearance in ((repair, 500), (mobile, 1000)):
            assert routing.flood_clearance_m(tuple(result["staging"].values()), ring) >= clearance
            assert "20:0" not in result["edge_ids"]
        assert routing.flood_clearance_m(tuple(mobile["deployment"].values()), ring) >= 100
        distant_mobile = {**body["legs"][-1], "to": {"lon": 120, "lat": 7}}
        outside = client.post("/travel/simulation-routes", json={**body, "legs": [distant_mobile]}).json()["legs"][0]
        assert outside["status"] == "outside_network" and outside["coordinates"] == []
        # Block every connection to the exact repair snap; do not use another road.
        blocked = {**body, "legs": [body["legs"][1]], "blocked_edge_ids": ["10:1", "20:2"]}
        result = client.post("/travel/simulation-routes", json=blocked).json()["legs"][0]
        assert result["status"] == "blocked" and result["coordinates"] == []
        assert result["staging"] is None
        # New flags require a validated simple polygon, even when roads are unavailable.
        assert client.post("/travel/simulation-routes", json={"legs": [body["legs"][1]]}).status_code == 422
        invalid_rings = [ring[:-1], ring + [ring[0]], [ring[0], ring[2], ring[1], ring[3], ring[0]],
                         [[181, 6], *ring[1:]], [["nan", 6], *ring[1:]],
                         [[116, 6], [116.01, 6], [116.02, 6], [116, 6]], ring * 30]
        for invalid in invalid_rings:
            assert client.post("/travel/simulation-routes", json={**body,
                "flood_polygon": {"type": "Polygon", "coordinates": [invalid]}}).status_code == 422
        assert client.post("/travel/simulation-routes", json={**body,
            "flood_polygon": {"type": "Polygon", "coordinates": [ring, ring]}}).status_code == 422
        with patch.object(routing, "get_network", return_value=None):
            missing = client.post("/travel/simulation-routes", json=body).json()["legs"]
            assert all(leg["status"] == "unavailable" and leg["coordinates"] == [] and leg["staging"] is None and leg["deployment"] is None for leg in missing)


def test_mobile_departure_respects_direction_and_does_not_cancel_deployment():
    ring = ((116.004, 5.997), (116.013, 5.997), (116.013, 6.008), (116.004, 6.008), (116.004, 5.997))
    inbound = [_way(50, [11, 4], oneway="yes"), _way(20, [4, 5, 3], oneway="yes"), _way(10, [3, 2, 1], oneway="yes")]
    for return_road, blocked, departure_status in ((False, frozenset(), "unreachable"),
            (True, frozenset(), "routed"), (True, frozenset({"60:0"}), "blocked")):
        network = routing.RoadNetwork({"query_bounds": [115.99, 5.99, 116.05, 6.03],
            "elements": inbound + ([_way(60, [1, 11], oneway="yes")] if return_road else [])})
        mobile = network.staged_route(tuple(POINTS[1]), tuple(POINTS[3]), blocked, ring, True, True)
        assert mobile["status"] == "routed" and mobile["deployment"] is not None
        assert mobile["coordinates"] == [tuple(POINTS[n]) for n in (11, 4, 5, 3, 2, 1)]
        departure = mobile["departure_route"]
        assert departure["status"] == departure_status
        assert not set(departure["edge_ids"]) & blocked
        if departure_status == "routed":
            assert departure["coordinates"] == [tuple(POINTS[n]) for n in (1, 11)]
            assert departure["coordinates"] != list(reversed(mobile["coordinates"]))
        else:
            assert departure["coordinates"] == [] and departure["edge_ids"] == []
            assert departure["distance_km"] is None and departure["reason"]


def test_saved_snapshot_routes():
    network = routing.get_network()
    assert network is not None, "The saved Sabah OSM road snapshot must load locally"
    closed = frozenset(network.blocked_edge_ids)
    assert closed == {f"117168871:{i}" for i in range(25)}
    depot, site = (116.073, 5.980), (116.067224, 5.9534048)
    normal, detour = network.route(depot, site), network.route(depot, site, closed)
    assert normal["status"] == detour["status"] == "routed"
    assert normal["coordinates"] and detour["coordinates"]
    assert set(normal["edge_ids"]) & closed
    assert not set(detour["edge_ids"]) & closed
    assert detour["distance_km"] > normal["distance_km"]
    inaccessible = network.route(depot, (116.1070508, 5.9547427))
    assert inaccessible["status"] == "unreachable" and inaccessible["coordinates"] == []
    # Same authored full footprint as the frontend Sabah scenario. Parking
    # outside it is a scenario choice, not a claim of surveyed safe ground.
    ring = ((116.04, 5.96), (116.055, 5.985), (116.075, 5.995), (116.095, 5.998),
            (116.11, 6.01), (116.115, 6.04), (116.118, 6.065), (116.128, 6.078),
            (116.135, 6.06), (116.132, 6.03), (116.128, 5.995), (116.125, 5.965),
            (116.115, 5.94), (116.09, 5.925), (116.06, 5.928), (116.038, 5.94), (116.04, 5.96))
    for mobile in (False, True):
        staged = network.staged_route(depot, site, closed, ring, True, mobile)
        assert staged["status"] == "routed" and staged["distance_km"] > 0
        assert staged["coordinates"][0] == tuple(staged["staging"].values())
        assert routing.flood_clearance_m(staged["coordinates"][0], ring) >= (1000 if mobile else 500)
        assert not set(staged["edge_ids"]) & closed
        assert staged["origin_snap"]["distance_m"] == 0 and staged["last_mile"] == "unverified"
        if mobile:
            assert staged["coordinates"][-1] == tuple(staged["deployment"].values())
            assert routing.flood_clearance_m(staged["coordinates"][-1], ring) >= 100
            assert abs(staged["destination_snap"]["distance_m"] - routing.distance_m(site, staged["coordinates"][-1])) < .1
            departure = staged["departure_route"]
            assert departure["status"] == "routed" and departure["distance_km"] > 0
            assert departure["coordinates"][0] == staged["coordinates"][-1]
            assert departure["coordinates"][-1] == staged["coordinates"][0]
            assert not set(departure["edge_ids"]) & closed
        else:
            assert staged["destination_snap"] == normal["destination_snap"]
    held = network.staged_route(depot, (116.1070508, 5.9547427), closed, ring, True, False)
    assert held["status"] == "unreachable" and held["staging"] is None and held["coordinates"] == []


if __name__ == "__main__":
    test_simulation_road_contract()
    test_turn_restrictions()
    test_same_way_uturn_restrictions()
    test_outside_flood_staging_and_mobile_deployment()
    test_mobile_departure_respects_direction_and_does_not_cancel_deployment()
    test_saved_snapshot_routes()
    print("Simulation road routing contract check passed")
