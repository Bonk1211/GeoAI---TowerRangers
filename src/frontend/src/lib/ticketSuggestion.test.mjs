import assert from 'node:assert/strict';
import test from 'node:test';

import { rankSuggestions, ROAD_FACTOR, AVG_SPEED_KMH } from './ticketSuggestion.ts';

function crew(crew_id, depotLon) {
  return {
    crew_id,
    name: crew_id,
    crew_type: 'civil',
    depot: { lon: depotLon, lat: 3.0, name: `${crew_id} depot` },
    territory: 'Selangor',
    max_travel_km: 60,
    shift_hours: 8,
    members: [],
  };
}

function entry(crew_id, tower_id, start_min, end_min) {
  return {
    crew_id,
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

const TOWER = { lon: 101.0, lat: 3.0 };
const COORDS = new Map([['T_NEAR', { lon: 101.01, lat: 3.0 }]]);
const placeNameOf = () => 'Near Site';

test('ranks by where the crew is NOW, not by depot distance', () => {
  // FAR's depot is far, but it is standing at T_NEAR right now; NEAR is at its depot.
  const candidates = [
    { crew: crew('NEAR', 100.9), distance_km: 11 },
    { crew: crew('FAR', 102.5), distance_km: 167 },
  ];
  const entries = [entry('FAR', 'T_NEAR', 540, 780)];
  const ranked = rankSuggestions(candidates, entries, TOWER, 600, COORDS, placeNameOf);
  assert.equal(ranked[0].crew.crew_id, 'FAR');
  assert.equal(ranked[0].from.state, 'on_site');
  assert.ok(ranked[0].distance_km < ranked[1].distance_km);
});

test('distance carries the road factor and eta follows the speed assumption', () => {
  const candidates = [{ crew: crew('A', 101.0), distance_km: 0 }];
  const ranked = rankSuggestions(candidates, [], TOWER, 600, COORDS, placeNameOf);
  // Depot is exactly the tower's coordinates, so straight-line distance is 0.
  assert.equal(ranked[0].distance_km, 0);
  assert.equal(ranked[0].eta_min, 0);
  assert.equal(ROAD_FACTOR, 1.35);
  assert.equal(AVG_SPEED_KMH, 45);
});

test('eta is whole minutes, rounded, never fractional', () => {
  const candidates = [{ crew: crew('A', 100.5), distance_km: 55 }];
  const ranked = rankSuggestions(candidates, [], TOWER, 600, COORDS, placeNameOf);
  assert.equal(Number.isInteger(ranked[0].eta_min), true);
  assert.ok(ranked[0].eta_min > 0);
});

test('an empty candidate list yields no suggestions rather than throwing', () => {
  assert.deepEqual(rankSuggestions([], [], TOWER, 600, COORDS, placeNameOf), []);
});

test('every candidate survives ranking — eligibility is decided upstream', () => {
  const candidates = [
    { crew: crew('A', 100.5), distance_km: 55 },
    { crew: crew('B', 101.4), distance_km: 44 },
    { crew: crew('C', 101.1), distance_km: 11 },
  ];
  const ranked = rankSuggestions(candidates, [], TOWER, 600, COORDS, placeNameOf);
  assert.equal(ranked.length, 3);
  assert.deepEqual(
    ranked.map((s) => s.crew.crew_id),
    ['C', 'B', 'A'],
  );
});

// --- measured legs from the road matrix ------------------------------------

test('a measured leg replaces the estimate and says so', () => {
  const crews = [{ crew_id: 'KDH-C1', crew_type: 'civil', name: 'Alor Setar Civil 1',
                   depot: { lon: 100.37, lat: 6.121, name: 'Alor Setar' },
                   territory: 'Kedah', max_travel_km: 150, shift_hours: 8, members: [] }];
  const tower = { lon: 100.5, lat: 6.0 };
  const measured = new Map([['depot:100.37:6.121', { km: 41.2, minutes: 58, reachable: true }]]);
  const [s] = rankSuggestions(
    crews.map((crew) => ({ crew, distance_km: 0 })), [], tower, 9 * 60,
    new Map(), (id) => id, measured,
  );
  assert.equal(s.measured, true);
  assert.equal(s.distance_km, 41.2);
  assert.equal(s.eta_min, 58);
});

test('an absent pair falls back to the estimate rather than blocking', () => {
  const crews = [{ crew_id: 'KDH-C1', crew_type: 'civil', name: 'Alor Setar Civil 1',
                   depot: { lon: 100.37, lat: 6.121, name: 'Alor Setar' },
                   territory: 'Kedah', max_travel_km: 150, shift_hours: 8, members: [] }];
  const [s] = rankSuggestions(
    crews.map((crew) => ({ crew, distance_km: 0 })), [], { lon: 100.5, lat: 6.0 },
    9 * 60, new Map(), (id) => id, new Map(),
  );
  assert.equal(s.measured, false);
  assert.ok(s.eta_min > 0 && Number.isFinite(s.eta_min));
});

test('an unreachable crew sorts last instead of vanishing', () => {
  const mk = (id, lon) => ({ crew_id: id, crew_type: 'civil', name: id,
    depot: { lon, lat: 6.121, name: id }, territory: 'Kedah',
    max_travel_km: 150, shift_hours: 8, members: [] });
  const measured = new Map([
    ['depot:100.37:6.121', { km: null, minutes: null, reachable: false }],
    ['depot:101.09:6.121', { km: 120, minutes: 100, reachable: true }],
  ]);
  const out = rankSuggestions(
    [mk('A', 100.37), mk('B', 101.09)].map((crew) => ({ crew, distance_km: 0 })),
    [], { lon: 100.5, lat: 6.0 }, 9 * 60, new Map(), (id) => id, measured,
  );
  assert.equal(out.length, 2, 'an unusable crew is still shown, with a reason');
  assert.equal(out[0].crew.crew_id, 'B');
  assert.equal(out[1].unreachable, true);
});
