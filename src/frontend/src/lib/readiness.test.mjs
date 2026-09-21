import assert from 'node:assert/strict';
import test from 'node:test';
import { crewIdsInTerritory, readinessByTeam, scopeRunToCrews } from './readiness.ts';

const RUN = {
  run_id: 'r', horizon: ['2026-08-17', '2026-08-18', '2026-08-19'],
  entries: [], unscheduled: [], unscheduled_detail: [], risk_weighted_wait: 0,
  reserve: [
    { crew_id: 'SEL-C1', day: '2026-08-17', crew_type: 'civil' },
    { crew_id: 'SEL-C2', day: '2026-08-19', crew_type: 'civil' },
    { crew_id: 'SEL-P1', day: '2026-08-19', crew_type: 'power' },
  ],
};

test('counts reserve crew-days per team', () => {
  const byType = Object.fromEntries(readinessByTeam(RUN).map((t) => [t.crewType, t]));
  assert.equal(byType.civil.reserveDays, 2);
  assert.equal(byType.power.reserveDays, 1);
  assert.equal(byType.rf.reserveDays, 0);
});

test('availableToday is true only when today itself carries reserve', () => {
  const byType = Object.fromEntries(readinessByTeam(RUN, '2026-08-17').map((t) => [t.crewType, t]));
  assert.equal(byType.civil.availableToday, true);
  assert.equal(byType.power.availableToday, false);
});

test('nextReserveDay points at the next protected day, or null', () => {
  const byType = Object.fromEntries(readinessByTeam(RUN, '2026-08-18').map((t) => [t.crewType, t]));
  assert.equal(byType.power.nextReserveDay, '2026-08-19');
  assert.equal(byType.rf.nextReserveDay, null);
});

test('every team is returned even with no reserve at all', () => {
  // A team missing from the readout is indistinguishable from a team with no
  // cover. Four rows, always.
  assert.equal(readinessByTeam({ ...RUN, reserve: [] }).length, 4);
});

// --- territory scoping -------------------------------------------------
// A ScheduleRun is national: the solver plans every territory in crews.json
// at once. The board draws one. Counting the unscoped run.reserve beside it
// reported roughly sixteen times the cover any crew on screen actually held
// ("Civil · 33 crew-days" over two civil bands), which is the defect this
// pins.

const CREWS = [
  { crew_id: 'SEL-C1', territory: 'Selangor', crew_type: 'civil' },
  { crew_id: 'SEL-P1', territory: 'Selangor', crew_type: 'power' },
  { crew_id: 'KEL-C1', territory: 'Kelantan', crew_type: 'civil' },
  { crew_id: 'JHR-C1', territory: 'Johor', crew_type: 'civil' },
];

const NATIONAL_RUN = {
  ...RUN,
  entries: [
    { crew_id: 'SEL-C1', day: '2026-08-17', order: 0, tower_id: 'T1' },
    { crew_id: 'KEL-C1', day: '2026-08-17', order: 0, tower_id: 'T2' },
  ],
  reserve: [
    { crew_id: 'SEL-C1', day: '2026-08-17', crew_type: 'civil' },
    { crew_id: 'SEL-P1', day: '2026-08-19', crew_type: 'power' },
    { crew_id: 'KEL-C1', day: '2026-08-17', crew_type: 'civil' },
    { crew_id: 'JHR-C1', day: '2026-08-18', crew_type: 'civil' },
  ],
};

test('crewIdsInTerritory picks out only this territory crews', () => {
  assert.deepEqual([...crewIdsInTerritory(CREWS, 'Selangor')].sort(), ['SEL-C1', 'SEL-P1']);
  assert.deepEqual([...crewIdsInTerritory(CREWS, 'Sabah')], []);
});

test('a national reserve list is scoped down to the requested territory', () => {
  const scoped = scopeRunToCrews(NATIONAL_RUN, crewIdsInTerritory(CREWS, 'Selangor'));
  assert.deepEqual(
    scoped.reserve.map((r) => r.crew_id),
    ['SEL-C1', 'SEL-P1'],
  );
  assert.deepEqual(
    scoped.entries.map((e) => e.crew_id),
    ['SEL-C1'],
  );
  // Horizon and unscheduled describe the run, not a roster — untouched.
  assert.deepEqual(scoped.horizon, NATIONAL_RUN.horizon);

  const byType = Object.fromEntries(readinessByTeam(scoped).map((t) => [t.crewType, t]));
  assert.equal(byType.civil.reserveDays, 1, 'Kelantan + Johor civil reserve must not be counted');
  assert.equal(byType.power.reserveDays, 1);
});

test('readinessByTeam over an unscoped run still counts every territory', () => {
  // Pins the reason scoping has to happen at the caller: readinessByTeam
  // filters by crew_type alone and cannot know which board it is feeding.
  const byType = Object.fromEntries(readinessByTeam(NATIONAL_RUN).map((t) => [t.crewType, t]));
  assert.equal(byType.civil.reserveDays, 3);
});
