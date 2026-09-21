import assert from 'node:assert/strict';
import test from 'node:test';
import { simulationAssessmentAt, simulationWarningAt, simulationWarningsAt } from './simulationWarnings.ts';

test('warnings separate scenario changes, usable Sabah evidence, and missing data when seeking', () => {
  const site = (tower_id, lon, lat, extra = {}) => ({
    tower_id, territory: 'Sabah', lon, lat, hand_m: 2, decision: 'ok',
    dominant_factor: 'flood', attribution: { flood: 0.8, power: 0.2 },
    flags: [{ id: 'unmapped_asset' }], condition: 0.4, ...extra,
  });
  const towers = [
    site('south', 116.08, 5.96, { decision: 'maintain', dominant_factor: 'power', condition: 0.9, flags: [{ id: 'out_of_crew_range' }] }),
    site('north', 116.12, 6.065, { hand_m: 9 }),
    site('threshold', 116.1, 5.96, { decision: 'watch', condition: 0.85 }),
    site('outside', 116, 5.82, { decision: 'watch', dominant_factor: 'power', flags: [{ id: 'monsoon_blocked' }] }),
    site('unknown', 116.09, 5.95, { attribution: {}, dominant_factor: 'unscored', condition: null, flags: [], hand_m: undefined }),
    site('not-sabah', 116.08, 5.96, { decision: 'maintain', territory: 'Selangor', dominant_factor: 'power', condition: 1, flags: [{ id: 'out_of_crew_range' }] }),
  ];
  const lookup = (time, records = towers) => Object.fromEntries(simulationWarningsAt(time, records).map((warning) => [warning.id, warning]));
  const initial = lookup(0);
  assert.deepEqual(Object.keys(initial), ['rain', 'flood', 'soil', 'access', 'power', 'condition', 'river', 'road']);
  assert.equal(initial.flood.value, '4');
  assert.deepEqual(initial.flood.siteIds, ['south', 'north', 'threshold', 'unknown']);
  assert.match(initial.flood.observation, /2 of 3 mapped sites.*within 5 m/);
  assert.equal(initial.access.value, '2');
  assert.deepEqual(initial.access.siteIds, ['south', 'outside']);
  assert.equal(initial.power.value, '2');
  assert.equal(initial.condition.value, '2');
  assert.equal(initial.condition.evidence, 'DEMO TELEMETRY');
  assert.match(initial.condition.observation, /synthetic/);
  assert.deepEqual(initial.condition.siteIds, ['south', 'threshold']);
  assert.equal(initial.soil.value, '28');
  assert.equal(initial.river.value, '16');
  assert.equal(initial.river.evidence, 'SCENARIO');
  assert.equal(initial.road.evidence, 'SCENARIO');
  assert.equal(initial.road.value, 'No closures yet');
  assert.deepEqual(initial.road.siteIds, []);
  assert.match(initial.river.observation, /not gauge metres/);
  assert.equal(lookup(24_000).road.value, 'Closures active');
  assert.equal(lookup(80_000).road.value, 'Checks pending');
  assert.equal(lookup(87_999).road.value, 'Checks pending');
  assert.equal(lookup(88_000).road.value, 'Closures clear');
  assert.match(lookup(88_000).road.observation, /does not confirm field access/);
  for (const [time, value] of [[23_999, '4'], [24_000, '3'], [26_000, '4'], [87_999, '4'], [88_000, '3'], [96_000, '0']]) {
    assert.equal(lookup(time).flood.value, value);
    for (const warning of simulationWarningsAt(time, towers)) assert.ok(!warning.siteIds.includes('not-sabah'));
  }
  const beats = [[0, 'rain'], [4_000, 'flood'], [8_000, 'soil'], [12_000, 'access'], [15_000, 'power'], [19_000, 'condition']];
  beats.forEach(([time, id], i) => {
    assert.equal(simulationWarningAt(time), id);
    if (i) assert.equal(simulationWarningAt(time - 1), beats[i - 1][1]);
  });
  const times = [-Infinity, -1, NaN, 0, 10_000, 24_000, 26_000, 80_000, 88_000, 96_000, Infinity];
  const forward = times.map((time) => lookup(time));
  times.toReversed().forEach((time, i) => assert.deepEqual(lookup(time), forward[forward.length - 1 - i]));
  assert.deepEqual(lookup(NaN), initial);
  assert.equal(simulationWarningAt(-Infinity), 'rain');
  assert.equal(simulationWarningAt(Infinity), 'condition');
  assert.deepEqual(lookup(Infinity), lookup(96_000));
  for (const records of [[], [towers.at(-1)], [towers[4]], [site('bad-condition', 116.08, 5.96, { attribution: {}, flags: [], condition: NaN })]]) {
    const warnings = lookup(0, records);
    for (const id of ['access', 'power', 'condition']) assert.equal(warnings[id].value, '—');
  }
  assert.equal(lookup(0, []).flood.value, '—');
  const quiet = lookup(0, [towers[1]]);
  for (const id of ['access', 'power', 'condition']) assert.equal(quiet[id].value, '0');
  assert.equal(quiet.condition.unit, 'sites in top 15% rank');

  const before = structuredClone(towers);
  const initialAssessment = simulationAssessmentAt(0, towers);
  assert.deepEqual(initialAssessment.exposedSiteIds, ['south', 'north', 'threshold', 'unknown']);
  assert.deepEqual(initialAssessment.prioritySiteIds, ['south', 'threshold', 'outside']);
  assert.deepEqual(initialAssessment.outsideFloodPrioritySiteIds, ['outside']);
  assert.deepEqual(initialAssessment.nearbyPrioritySiteIds, ['outside']);
  assert.deepEqual(initialAssessment.reviewSiteIds, ['south', 'threshold', 'outside', 'north', 'unknown']);
  assert.deepEqual(simulationAssessmentAt(96_000, towers).exposedSiteIds, []);
  assert.deepEqual(simulationAssessmentAt(96_000, towers).reviewSiteIds, initialAssessment.prioritySiteIds);
  const assessmentForward = times.map((time) => simulationAssessmentAt(time, towers));
  times.toReversed().forEach((time, i) => {
    const assessment = simulationAssessmentAt(time, towers);
    assert.deepEqual(assessment, assessmentForward[assessmentForward.length - 1 - i]);
    assert.deepEqual(assessment.outsideFloodPrioritySiteIds, ['outside']);
  });
  for (const records of [[], [towers.at(-1)]]) {
    assert.deepEqual(simulationAssessmentAt(26_000, records), { exposedSiteIds: [], prioritySiteIds: [], outsideFloodPrioritySiteIds: [], nearbyPrioritySiteIds: [], reviewSiteIds: [] });
  }
  assert.deepEqual(towers, before, 'scenario assessment must never mutate the served model records');
});

test('regional assessment keeps five closest outside-flood priorities stable through flood changes', () => {
  const site = (tower_id, lon, lat, decision = 'maintain', territory = 'Sabah') => ({ tower_id, lon, lat, decision, territory });
  const towers = [
    site('inside', 116.08, 5.96),
    site('near-b', 116.14, 6.06, 'watch'),
    site('near-a', 116.14, 6.06),
    site('near-c', 116.15, 6.06),
    site('far', 117, 6.06),
    site('routine', 116.138, 6.06, 'ok'),
    site('other-state', 116.138, 6.06, 'maintain', 'Selangor'),
    site('unmapped', NaN, 6.06),
    site('near-d', 116.16, 6.06),
    site('near-e', 116.17, 6.06, 'watch'),
  ];
  const before = structuredClone(towers);
  for (const time of [0, 24_000, 26_000, 54_000, 88_000, 96_000]) {
    for (const records of [towers, towers.toReversed()]) {
      const assessment = simulationAssessmentAt(time, records);
      assert.deepEqual(assessment.nearbyPrioritySiteIds, ['near-a', 'near-b', 'near-c', 'near-d', 'near-e']);
      assert.ok(assessment.nearbyPrioritySiteIds.every(id => assessment.outsideFloodPrioritySiteIds.includes(id)));
    }
  }
  assert.deepEqual(simulationAssessmentAt(26_000, [towers[0], towers[7]]).nearbyPrioritySiteIds, []);
  assert.deepEqual(towers, before);
});
