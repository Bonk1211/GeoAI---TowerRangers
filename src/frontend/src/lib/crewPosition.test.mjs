import assert from 'node:assert/strict';
import test from 'node:test';

import { crewPositionNow } from './crewPosition.ts';

const CREW = {
  crew_id: 'SEL-C1',
  name: 'Subang Jaya Civil 1',
  crew_type: 'civil',
  depot: { lon: 101.58, lat: 3.05, name: 'Subang Jaya' },
  territory: 'Selangor',
  max_travel_km: 40,
  shift_hours: 8,
  members: ['Ahmad'],
};

const COORDS = new Map([
  ['T_A', { lon: 101.6, lat: 3.07 }],
  ['T_B', { lon: 101.7, lat: 3.12 }],
]);

const placeNameOf = (id) => (id === 'T_A' ? 'Site A' : 'Site B');

function entry(tower_id, start_min, end_min) {
  return {
    crew_id: 'SEL-C1',
    day: '2026-09-03',
    order: 1,
    tower_id,
    work_order: { tower_id, action: 'x', crew_type: 'civil', parts: [], urgency_days: 7, why: '' },
    pinned: false,
    travel_min: 10,
    start_min,
    end_min,
  };
}

test('a crew mid-job is on site at that tower', () => {
  const pos = crewPositionNow(CREW, [entry('T_A', 540, 780)], 600, COORDS, placeNameOf);
  assert.equal(pos.state, 'on_site');
  assert.deepEqual([pos.lon, pos.lat], [101.6, 3.07]);
  assert.match(pos.label, /Site A/);
});

test('after the last job the crew is idle at that tower, not back at depot', () => {
  const pos = crewPositionNow(CREW, [entry('T_A', 540, 660), entry('T_B', 700, 800)], 900, COORDS, placeNameOf);
  assert.equal(pos.state, 'idle');
  assert.deepEqual([pos.lon, pos.lat], [101.7, 3.12]);
  assert.match(pos.label, /Site B/);
});

test('before the first job the crew is at its depot', () => {
  const pos = crewPositionNow(CREW, [entry('T_A', 540, 780)], 480, COORDS, placeNameOf);
  assert.equal(pos.state, 'depot');
  assert.deepEqual([pos.lon, pos.lat], [101.58, 3.05]);
  assert.match(pos.label, /Subang Jaya/);
});

test('no jobs today means depot', () => {
  const pos = crewPositionNow(CREW, [], 600, COORDS, placeNameOf);
  assert.equal(pos.state, 'depot');
});

test('an untimed entry is ignored rather than treated as midnight', () => {
  const untimed = { ...entry('T_A', 540, 780), start_min: undefined, end_min: undefined };
  const pos = crewPositionNow(CREW, [untimed], 600, COORDS, placeNameOf);
  assert.equal(pos.state, 'depot');
});

test('a tower missing from the coordinate map falls back to depot', () => {
  const pos = crewPositionNow(CREW, [entry('T_MISSING', 540, 780)], 600, COORDS, placeNameOf);
  assert.equal(pos.state, 'depot');
});

test('the depot suffix is not doubled when the name already carries it', () => {
  // config/crews.json says "Kuantan"; fixtures/crews.ts says "Kuantan depot".
  // Both must read "at Kuantan depot", never "at Kuantan depot depot".
  const mk = (name) => ({
    crew_id: 'X', crew_type: 'civil', name: 'X', territory: 'T',
    depot: { lon: 103.326, lat: 3.808, name }, max_travel_km: 150,
    shift_hours: 8, members: [],
  });
  const at = (c) => crewPositionNow(c, [], 9 * 60, new Map(), (id) => id).label;
  assert.equal(at(mk('Kuantan')), 'at Kuantan depot');
  assert.equal(at(mk('Kuantan depot')), 'at Kuantan depot');
});
