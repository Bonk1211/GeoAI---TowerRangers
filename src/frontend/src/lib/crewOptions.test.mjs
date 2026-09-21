import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCrewOptions, optionDetail, loadLabel } from './crewOptions.ts';

// Real roster values from src/backend/config/crews.json, and a real Kelantan
// tower from the national dataset — the case that motivated the module.
const TOWER = { lon: 101.647, lat: 5.101, territory: 'Kelantan' };

function crew(over = {}) {
  return {
    crew_id: 'KEL-P1',
    name: 'Tanah Merah Power 1',
    crew_type: 'power',
    depot: { lon: 102.148, lat: 5.806, name: 'Tanah Merah' },
    territory: 'Kelantan',
    max_travel_km: 100,
    shift_hours: 8,
    members: [],
    ...over,
  };
}

const SABAH = crew({
  crew_id: 'SBH-P1',
  name: 'Kota Kinabalu Power 1',
  depot: { lon: 116.07, lat: 5.98, name: 'Kota Kinabalu' },
  territory: 'Sabah',
  max_travel_km: 200,
});

const CIVIL = crew({ crew_id: 'KEL-C1', name: 'Kota Bharu Civil 1', crew_type: 'civil' });

test('the Kelantan Power case: one crew in range, the rest are overrides', () => {
  const g = groupCrewOptions({
    neededType: 'power',
    tower: TOWER,
    crews: [crew(), SABAH, CIVIL],
  });
  assert.deepEqual(
    g.inRange.map((o) => o.crew.crew_id),
    ['KEL-P1'],
  );
  assert.deepEqual(
    g.outOfRange.map((o) => o.crew.crew_id),
    ['SBH-P1'],
  );
  assert.deepEqual(
    g.otherCapability.map((o) => o.crew.crew_id),
    ['KEL-C1'],
  );
});

test('nothing is ever dropped — every crew lands in exactly one group', () => {
  // The override path is a real workflow (scheduler/override.py's "never
  // blocked" contract), so a crew the solver would refuse must stay pickable.
  const crews = [crew(), SABAH, CIVIL];
  const g = groupCrewOptions({ neededType: 'power', tower: TOWER, crews });
  const total = g.inRange.length + g.outOfRange.length + g.otherCapability.length;
  assert.equal(total, crews.length);
});

test('the Sabah crew is reported with how far past its own limit it is', () => {
  const g = groupCrewOptions({ neededType: 'power', tower: TOWER, crews: [SABAH] });
  const o = g.outOfRange[0];
  assert.ok(o.distanceKm > 1500, `expected >1500 km, got ${o.distanceKm}`);
  assert.ok(o.overByKm > 1300, `expected >1300 km over, got ${o.overByKm}`);
  assert.match(optionDetail(o), /past its 200 km range by \d+ km/);
});

test('a null neededType offers every crew as in-range-or-not, none as other', () => {
  // issue_type 'Other' with a tower whose dominant factor says nothing.
  // Filtering to no capability at all is what once let a Power crew be
  // offered for a vegetation site; here it must simply not narrow.
  const g = groupCrewOptions({ neededType: null, tower: TOWER, crews: [crew(), CIVIL, SABAH] });
  assert.equal(g.otherCapability.length, 0);
  assert.equal(g.inRange.length + g.outOfRange.length, 3);
});

test('groups are ordered nearest first, overrides included', () => {
  const far = crew({ crew_id: 'FAR', depot: { lon: 110, lat: 2, name: 'Far' } });
  const mid = crew({ crew_id: 'MID', depot: { lon: 104, lat: 4, name: 'Mid' } });
  const g = groupCrewOptions({ neededType: 'power', tower: TOWER, crews: [far, mid, SABAH] });
  const order = g.outOfRange.map((o) => o.crew.crew_id);
  assert.deepEqual(order, ['MID', 'FAR', 'SBH-P1']);
});

test('an unresolved tower yields no distances and sorts those crews last', () => {
  const g = groupCrewOptions({ neededType: 'power', tower: null, crews: [crew(), SABAH] });
  assert.equal(g.inRange.length, 0); // unreachable is not the same as in range
  assert.equal(g.outOfRange.length, 2);
  assert.equal(g.outOfRange[0].distanceKm, null);
  assert.equal(g.outOfRange[0].overByKm, null);
});

test('territory mismatch is reported separately from range', () => {
  // A crew can clear the distance limit and still be refused by the solver's
  // exact-territory rule — near a state border the two disagree.
  const border = crew({ crew_id: 'TRG-P1', territory: 'Terengganu', max_travel_km: 400 });
  const g = groupCrewOptions({ neededType: 'power', tower: TOWER, crews: [border] });
  assert.equal(g.inRange.length, 1);
  assert.equal(g.inRange[0].territoryMatch, false);
  assert.match(optionDetail(g.inRange[0]), /another territory/);
});

test('territory is unknown, not false, when the tower does not carry one', () => {
  const g = groupCrewOptions({
    neededType: 'power',
    tower: { lon: 101.647, lat: 5.101 },
    crews: [crew()],
  });
  assert.equal(g.inRange[0].territoryMatch, null);
  assert.doesNotMatch(optionDetail(g.inRange[0]), /another territory/);
});

// --- load ------------------------------------------------------------------

const HZ = ['2026-09-10','2026-09-11','2026-09-12','2026-09-13','2026-09-14','2026-09-15','2026-09-16'];

test('no solved horizon means no load at all, never a zeroed one', () => {
  // A zeroed struct is truthy and would render as "free all week" for a board
  // nobody has solved — the exact failure the offline-fallback rule forbids.
  const g = groupCrewOptions({ neededType: 'power', tower: TOWER, crews: [crew()] });
  assert.equal(g.inRange[0].load, null);
  assert.equal(g.horizonDays, 0);
});

test('a solved horizon with no entries is a real answer: that crew is free', () => {
  const g = groupCrewOptions({
    neededType: 'power', tower: TOWER, crews: [crew()], entries: [], horizon: HZ,
  });
  assert.equal(g.horizonDays, 7);
  assert.equal(g.inRange[0].load.jobs, 0);
  assert.equal(loadLabel(g.inRange[0].load), 'free all week');
});

test('a horizon that is not a week says how many days it is', () => {
  const g = groupCrewOptions({
    neededType: 'power', tower: TOWER, crews: [crew()], entries: [], horizon: HZ.slice(0, 3),
  });
  assert.equal(loadLabel(g.inRange[0].load), 'free all 3 days');
});

test('load spans the whole horizon, and only this crew', () => {
  // The correction this module exists for: reading horizon[0] alone reported
  // 29 of 30 crews as free on a live run, because day 0 held 1 of 54 entries.
  const entries = [
    { crew_id: 'KEL-P1', day: '2026-09-11', order: 1, tower_id: 'A', start_min: 540, end_min: 780, travel_min: 30 },
    { crew_id: 'KEL-P1', day: '2026-09-11', order: 2, tower_id: 'B', start_min: 800, end_min: 900, travel_min: 20 },
    { crew_id: 'KEL-P1', day: '2026-09-14', order: 1, tower_id: 'C', start_min: 540, end_min: 780, travel_min: 0 },
    { crew_id: 'OTHER', day: '2026-09-11', order: 1, tower_id: 'D', start_min: 540, end_min: 780, travel_min: 30 },
  ];
  const g = groupCrewOptions({ neededType: 'power', tower: TOWER, crews: [crew()], entries, horizon: HZ });
  const load = g.inRange[0].load;
  assert.equal(load.jobs, 3);
  assert.equal(load.daysBooked, 2);
  assert.equal(load.bookedMin, 270 + 120 + 240);
  assert.equal(load.shiftMin, 8 * 60 * 7);
  assert.equal(loadLabel(load), '3 jobs on 2/7 days');
});

test('entries outside the horizon are ignored', () => {
  const entries = [
    { crew_id: 'KEL-P1', day: '2026-08-01', order: 1, tower_id: 'OLD', start_min: 540, end_min: 780 },
  ];
  const g = groupCrewOptions({ neededType: 'power', tower: TOWER, crews: [crew()], entries, horizon: HZ });
  assert.equal(g.inRange[0].load.jobs, 0);
  assert.equal(loadLabel(g.inRange[0].load), 'free all week');
});

test('untimed work is counted, never estimated, and never reads as free', () => {
  const entries = [{ crew_id: 'KEL-P1', day: '2026-09-11', order: 1, tower_id: 'A' }];
  const g = groupCrewOptions({ neededType: 'power', tower: TOWER, crews: [crew()], entries, horizon: HZ });
  const load = g.inRange[0].load;
  assert.equal(load.jobs, 1);
  assert.equal(load.untimed, 1);
  assert.equal(load.bookedMin, 0);
  // Crucially NOT "free all week" — the crew has work whose span is unknown.
  assert.equal(loadLabel(load), '1 job on 1/7 days');
});

test('optionDetail names the crew id, territory, distance and load in order', () => {
  const g = groupCrewOptions({
    neededType: 'power', tower: TOWER, crews: [crew()], entries: [], horizon: HZ,
  });
  assert.equal(optionDetail(g.inRange[0]), 'KEL-P1 · Kelantan · 96 km · free all week');
});
