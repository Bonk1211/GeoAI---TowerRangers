import assert from 'node:assert/strict';
import test from 'node:test';
import { simulationCoverageAt, simulationDroneMissions } from './simulationCoverage.ts';
import { droneFlightAt, DRONE_LAUNCH_MS, DRONE_ON_STATION_MS, DRONE_LANDED_MS } from './droneFlight.ts';
import { haversineKm } from './geo.ts';
import { pointInPolygon } from '../fixtures/scenarios/sabahFlood.ts';

function contains(feature, point) {
  if (!feature) return false;
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return polygons.some(rings => pointInPolygon(point.lon, point.lat, { type: 'Polygon', coordinates: [rings[0]] })
    && !rings.slice(1).some(ring => pointInPolygon(point.lon, point.lat, { type: 'Polygon', coordinates: [ring] })));
}

test('mobile radio coverage removes only reached outage areas when the relay is on station, without repairing towers', () => {
  const south = { tower_id: 'south', lon: 116.07, lat: 5.95 }, north = { tower_id: 'north', lon: 116.12, lat: 6.07 };
  const parked = { lon: 116.08, lat: 5.94 };
  const unit = { unitId: 'mobile-network-1', unitKind: 'mobile-network', entry: { tower_id: 'south' }, coverageTowerIds: ['south'],
    road: { status: 'routed', staging: parked, deployment: parked } };
  const down = [south, north];
  for (const time of [0, 26_999, 80_000, 88_000]) assert.equal(simulationCoverageAt(time, down, [unit]).gap, null);
  const travelling = simulationCoverageAt(67_999, down, [unit]);
  assert.equal(travelling.deployments.length, 0);
  assert.equal(travelling.supported, null);
  assert.deepEqual(travelling.gap, travelling.remaining);
  const active = simulationCoverageAt(68_000, down, [unit]);
  assert.equal(active.deployments.length, 1);
  assert.equal(active.affectedCount, 2);
  assert.ok(contains(active.gap, south), 'original tower outage remains represented');
  assert.ok(contains(active.supported, south));
  assert.ok(!contains(active.remaining, south));
  assert.ok(contains(active.remaining, north), 'separate unsupported pocket stays red');
  assert.ok(!contains(active.supported, north));
  unit.road.departure_route = { status: 'routed', coordinates: [[parked.lon, parked.lat], [116.03, 5.92]] };
  const crewLeaving = simulationCoverageAt(78_000, down, [unit]);
  assert.deepEqual(crewLeaving.supported, active.supported, 'the airborne radio footprint stays fixed until recall');
  assert.deepEqual(crewLeaving.deployments[0].road.deployment, parked);
  assert.deepEqual(simulationCoverageAt(68_000, down, [unit, { ...unit, unitId: 'duplicate' }]).supported, active.supported,
    'overlapping station circles cannot double-count supported areas');
  assert.equal(simulationCoverageAt(68_000, down, [{ ...unit, road: { status: 'routed', deployment: parked } }]).deployments.length, 0, 'no launch vehicle means no relay');
  const held = { ...unit, road: { status: 'unreachable' } };
  assert.equal(simulationCoverageAt(79_000, down, [held]).supported, null);
  assert.deepEqual(simulationCoverageAt(70_000, down, [unit]).supported, active.supported);
  const full = simulationCoverageAt(68_000, [south], [{ ...unit, road: { status: 'routed', staging: parked, deployment: south } }]);
  assert.equal(full.remaining, null);
  assert.deepEqual(full.supported, full.gap);
  assert.equal(simulationCoverageAt(68_000, [], [unit]).supported, null);
  assert.equal(simulationCoverageAt(88_000, down, [unit]).deployments.length, 0);
});


test('multiple relays cover the entire outage footprint, including the outer red edges', () => {
  const sites = [
    { tower_id: 'south-west', lon: 116.05, lat: 5.95 },
    { tower_id: 'south-east', lon: 116.09, lat: 5.95 },
    { tower_id: 'north-west', lon: 116.11, lat: 6.07 },
    { tower_id: 'north-east', lon: 116.14, lat: 6.07 },
  ];
  const bases = [
    { unitId: 'prime-1', unitKind: 'mobile-network', coverageTowerIds: ['south-west', 'south-east'], road: { status: 'routed', staging: { lon: 116.08, lat: 5.93 } } },
    { unitId: 'prime-2', unitKind: 'mobile-network', coverageTowerIds: ['north-west', 'north-east'], road: { status: 'routed', staging: { lon: 116.16, lat: 6.08 } } },
  ];
  for (const time of [68_000, 72_000, 79_999]) {
    const coverage = simulationCoverageAt(time, sites, bases);
    assert.equal(coverage.activeDrones.length, coverage.missions.length);
    assert(coverage.activeDrones.length > 2, 'relay count follows the covered area');
    assert.equal(coverage.deployments.length, 2, 'ground vehicles remain two PRIME bases');
    assert.equal(coverage.remaining, null, 'all red geometry must be covered, not just tower points');
    assert.deepEqual(coverage.supported, coverage.gap);
  }
  assert.equal(simulationCoverageAt(67_999, sites, bases).activeDrones.length, 0);
  const partial = simulationCoverageAt(68_000, sites, [bases[0]]);
  assert(partial.remaining, 'an unavailable base must leave its outage area visible');
  assert(partial.activeDrones.length > 0);
  assert(partial.activeDrones.every(mission => mission.unitId === 'prime-1'));
  assert.equal(simulationCoverageAt(88_000, sites, bases).activeDrones.length, 0);
});

test('the live Sabah outage uses nine evenly spaced area relays with complete coverage and stable homes', () => {
  // Coordinates selected by the live Sabah scenario on 2026-09-21: seven southern and five northern sites.
  const sites = [
    [116.067224, 5.9534048], [116.0675271, 5.9534155], [116.0864836, 5.9769392],
    [116.1046475, 5.95468], [116.1046918, 5.9542612], [116.1070508, 5.9547427],
    [116.1129114, 5.954528], [116.1217036, 6.0687708], [116.1219144, 6.0670439],
    [116.1220885, 6.0663475], [116.1240107, 6.0669388], [116.1243832, 6.0652034],
  ].map(([lon, lat], index) => ({ tower_id: `site-${index}`, lon, lat }));
  const bases = [
    { unitId: 'prime-1', unitKind: 'mobile-network', coverageTowerIds: sites.slice(0, 7).map(site => site.tower_id),
      road: { status: 'routed', staging: { lon: 116.08, lat: 5.93 } } },
    { unitId: 'prime-2', unitKind: 'mobile-network', coverageTowerIds: sites.slice(7).map(site => site.tower_id),
      road: { status: 'routed', staging: { lon: 116.15, lat: 6.08 } } },
  ];
  const coverage = simulationCoverageAt(DRONE_ON_STATION_MS, sites, bases);
  const { missions } = coverage;
  assert(Math.abs(coverage.areaKm2 - 127.88) < .1, `actual outage union area: ${coverage.areaKm2}km²`);
  assert.equal(missions.length, 9, 'coverage area needs six southern and three northern relays, not one per tower');
  assert.equal(new Set(missions.map(mission => mission.id)).size, 9);
  assert.equal(coverage.remaining, null, 'even the outer red boundary is fully covered');
  assert.deepEqual(coverage.supported, coverage.gap);
  assert.deepEqual(simulationDroneMissions(sites.toReversed(), bases.toReversed()), missions,
    'site and vehicle input order cannot change geometry, identities or return homes');
  for (const [base, count] of [[bases[0], 6], [bases[1], 3]]) {
    const group = missions.filter(mission => mission.unitId === base.unitId);
    assert.equal(group.length, count);
    const nearestSpacing = group.map(mission => Math.min(...group.filter(other => other !== mission)
      .map(other => haversineKm(mission.hover, other.hover))));
    assert(Math.min(...nearestSpacing) > 3, 'relays must spread across the area rather than stack near tower clusters');
    assert(Math.max(...nearestSpacing) - Math.min(...nearestSpacing) < .05,
      'each connected area uses uniform local spacing');
    for (const mission of group) {
      assert(contains(coverage.gap, mission.hover), 'relay stations remain inside the affected area');
      assert(sites.every(site => haversineKm(site, mission.hover) > .2), 'stations follow the area layout, not tower coordinates');
      assert.deepEqual(droneFlightAt(DRONE_LAUNCH_MS, mission.staging, mission.hover).position, base.road.staging);
      assert.deepEqual(droneFlightAt(DRONE_ON_STATION_MS, mission.staging, mission.hover).position, mission.hover);
      assert.deepEqual(droneFlightAt(DRONE_LANDED_MS, mission.staging, mission.hover).position, base.road.staging);
    }
  }
  const partial = simulationCoverageAt(DRONE_ON_STATION_MS, sites, [bases[0], { ...bases[1], road: { status: 'unreachable' } }]);
  assert(partial.remaining, 'an unavailable northern vehicle leaves the northern outage visible');
  assert(partial.activeDrones.every(mission => mission.unitId === bases[0].unitId));
  assert.deepEqual(simulationDroneMissions([], bases), []);
  assert.deepEqual(simulationDroneMissions(sites, []), []);
});
