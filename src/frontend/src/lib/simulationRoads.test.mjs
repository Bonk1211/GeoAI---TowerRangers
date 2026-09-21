import assert from 'node:assert/strict';
import test from 'node:test';

import {
  simulationHardeningLegs,
  simulationRoadCrewAt,
  simulationRoadRequests,
  HARDENING_START_MS,
  HARDENING_WORK_MS,
  HARDENING_EXIT_MS,
  HARDENING_SAFE_MS,
  HARDENING_END_MS,
} from './simulationRoads.ts';

const CREWS = [
  { crew_id: 'SBH-C1', crew_type: 'civil', territory: 'Sabah', depot: { lon: 116.073, lat: 5.98 } },
  { crew_id: 'SBH-P1', crew_type: 'power', territory: 'Sabah', depot: { lon: 116.073, lat: 5.98 } },
  { crew_id: 'SEL-C1', crew_type: 'civil', territory: 'Selangor', depot: { lon: 101.6, lat: 3.1 } },
];

function tower(id, { flood = 0.5, territory = 'Sabah', lat = 6, lon = 116 } = {}) {
  return { tower_id: id, territory, lat, lon, attribution: { flood } };
}

const DAY = '2026-09-15';

/** A unit as the router returns it once its road leg has resolved. */
function routed(unit) {
  return { ...unit, road: { status: 'routed', coordinates: [[unit.from.lon, unit.from.lat], [unit.to.lon, unit.to.lat]],
    departure_route: { status: 'routed', coordinates: [[unit.to.lon, unit.to.lat], [116.2, 6.1]] } } };
}

test('hardening legs are built from Sabah towers carrying flood exposure', () => {
  const units = simulationHardeningLegs(
    [tower('MY_1', { flood: 0.6 }), tower('MY_2', { flood: 0.4 })], CREWS, DAY);
  assert.deepEqual(units.map(u => u.entry.tower_id), ['MY_1', 'MY_2']);
  assert.ok(units.every(u => u.unitKind === 'hardening'));
});

test('hardening legs use the Sabah CIVIL crew and its real depot', () => {
  const [unit] = simulationHardeningLegs([tower('MY_1')], CREWS, DAY);
  assert.equal(unit.crewId, 'SBH-C1');
  assert.deepEqual(unit.from, { lon: 116.073, lat: 5.98 });
  assert.equal(unit.entry.work_order.crew_type, 'civil');
  assert.equal(unit.entry.work_order.action, 'raise_cabinet_and_seal');
});

test('towers outside Sabah and towers with no flood share are excluded', () => {
  const units = simulationHardeningLegs([
    tower('MY_sel', { territory: 'Selangor' }),
    tower('MY_dry', { flood: 0 }),
    tower('MY_ok', { flood: 0.3 }),
  ], CREWS, DAY);
  assert.deepEqual(units.map(u => u.entry.tower_id), ['MY_ok']);
});

test('no Sabah civil crew means no hardening convoy', () => {
  const units = simulationHardeningLegs([tower('MY_1')],
    CREWS.filter(c => c.crew_id !== 'SBH-C1'), DAY);
  assert.deepEqual(units, []);
});

test('a corridor predicate bounds which sites the convoy drives to', () => {
  // Guards the measured fault this parameter exists for: ranking all Sabah
  // towers by flood share put the top site ~220km east of the depot,
  // outside the scenario corridor and off the loaded road network.
  const towers = [
    tower('MY_far', { flood: 0.9, lon: 118.1, lat: 5.84 }),
    tower('MY_near', { flood: 0.4, lon: 116.09, lat: 5.98 }),
  ];
  const inCorridor = (lon) => lon < 117;
  assert.deepEqual(
    simulationHardeningLegs(towers, CREWS, DAY, inCorridor).map(u => u.entry.tower_id),
    ['MY_near'],
  );
  // Without the predicate the far site wins on flood share alone.
  assert.equal(simulationHardeningLegs(towers, CREWS, DAY)[0].entry.tower_id, 'MY_far');
});

test('hardening legs cap at four units', () => {
  const towers = Array.from({ length: 9 }, (_, i) => tower(`MY_${i}`, { flood: 0.9 - i / 100 }));
  assert.equal(simulationHardeningLegs(towers, CREWS, DAY).length, 4);
});

test('hardening legs order by flood share and number in order', () => {
  const towers = [tower('MY_lo', { flood: 0.2 }), tower('MY_hi', { flood: 0.9 }), tower('MY_mid', { flood: 0.5 })];
  const once = simulationHardeningLegs(towers, CREWS, DAY);
  const twice = simulationHardeningLegs([...towers].reverse(), CREWS, DAY);
  assert.deepEqual(once.map(u => u.entry.tower_id), ['MY_hi', 'MY_mid', 'MY_lo']);
  assert.deepEqual(once.map(u => u.entry.tower_id), twice.map(u => u.entry.tower_id));
  assert.deepEqual(once.map(u => u.unitId), ['hardening-1', 'hardening-2', 'hardening-3']);
});

test('an empty tower population yields no hardening units', () => {
  assert.deepEqual(simulationHardeningLegs([], CREWS, DAY), []);
});

test('hardening units animate inside their own pre-event window', () => {
  const legs = [routed(simulationHardeningLegs([tower('MY_1')], CREWS, DAY)[0])];
  assert.equal(simulationRoadCrewAt(HARDENING_START_MS - 1, false, legs), null);
  assert.equal(simulationRoadCrewAt(HARDENING_END_MS, false, legs), null);
  const mid = simulationRoadCrewAt((HARDENING_START_MS + HARDENING_END_MS) / 2, false, legs);
  assert.ok(mid, 'a hardening unit moves mid-window');
  assert.equal(mid.leg.unitKind, 'hardening');
});

test('hardening units never stage — staging is a response-phase concept', () => {
  const legs = [routed(simulationHardeningLegs([tower('MY_1')], CREWS, DAY)[0])];
  const motion = simulationRoadCrewAt(HARDENING_START_MS + 1_000, false, legs);
  assert.equal(motion.staged, false);
  assert.equal(motion.deployed, false);
  assert.equal(motion.returning, false);
});

test('an unroutable hardening leg holds rather than advancing', () => {
  const unit = simulationHardeningLegs([tower('MY_1')], CREWS, DAY)[0];
  const legs = [{ ...unit, road: { status: 'blocked', coordinates: [] } }];
  const motion = simulationRoadCrewAt(HARDENING_START_MS + 5_000, false, legs);
  assert.equal(motion.held, true);
  assert.equal(motion.travel, 0);
});

test('hardening motion is unaffected by the emergency flag', () => {
  // The caller passes `emergency: false` for these units; the window is the
  // unit's own, so a stray `true` must not silently route it through the
  // response branch's 54s gate.
  const legs = [routed(simulationHardeningLegs([tower('MY_1')], CREWS, DAY)[0])];
  const asEmergency = simulationRoadCrewAt(HARDENING_START_MS + 2_000, true, legs);
  assert.ok(asEmergency, 'the hardening branch is taken on unitKind, not on the flag');
  assert.equal(asEmergency.leg.unitKind, 'hardening');
});

test('civil maintenance holds before a continuous evacuation, then stays dry before flood onset', async () => {
  const { prepareRoadMotion, roadPositionAt } = await import('./simulationRoadMotion.ts');
  const { floodExtentAt, pointInPolygon } = await import('../fixtures/scenarios/sabahFlood.ts');
  const [unit] = simulationHardeningLegs([tower('MY_1', { lon: 116.086, lat: 5.977 })], CREWS, DAY);
  const leg = routed(unit);
  const position = ms => {
    const motion = simulationRoadCrewAt(ms, false, [leg]);
    return roadPositionAt(prepareRoadMotion(motion.returning ? leg.road.departure_route.coordinates : leg.road.coordinates), motion.travel);
  };
  for (const ms of [HARDENING_WORK_MS, 19_000, HARDENING_EXIT_MS - 1]) {
    assert.equal(simulationRoadCrewAt(ms, false, [leg]).working, true);
    assert.deepEqual([position(ms).lon, position(ms).lat], leg.road.coordinates.at(-1));
  }
  assert.deepEqual([position(HARDENING_EXIT_MS).lon, position(HARDENING_EXIT_MS).lat], leg.road.coordinates.at(-1), 'the exit starts at the exact maintenance endpoint');
  assert.equal(simulationRoadCrewAt(22_000, false, [leg]).exiting, true);
  assert.notDeepEqual(position(22_000), position(HARDENING_EXIT_MS));
  for (const ms of [HARDENING_SAFE_MS, 24_000, 26_000, 53_999]) {
    const point = position(ms);
    assert.equal(simulationRoadCrewAt(ms, false, [leg]).stationary, true);
    assert.equal(pointInPolygon(point.lon, point.lat, floodExtentAt(26_000)), false);
    assert.deepEqual(point, position(HARDENING_SAFE_MS));
  }
  assert.equal(simulationRoadCrewAt(24_000, false, [{ ...leg, road: { ...leg.road, departure_route: null } }]).held, true);
  assert.equal(simulationRoadCrewAt(18_000, false, [{ ...leg, road: { ...leg.road, departure_route: null } }]).held, true);
  const again = simulationHardeningLegs([tower('MY_1', { lon: 116.086, lat: 5.977 })], CREWS, '');
  assert.equal(again[0].id, unit.id, 'late optimizer dates cannot invalidate the assessed road');
  const requests = simulationRoadRequests([unit]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].id, `${unit.id}:exit`);
  assert.equal(requests[1].sequence_group, requests[0].sequence_group);
  assert.equal(requests[1].destination_outside_flood, true);
  assert.ok(requests.every(request => !request.avoid_flood && !request.stage_outside_flood));
});
