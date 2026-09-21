import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeFlaggedVsHit,
  parseClockLabelHours,
  timeToResponseHours,
} from './simulationSummary.ts';

function fakeRun(entries) {
  return {
    run_id: 'r1',
    horizon: ['2026-09-15'],
    entries,
    reserve: [],
    unscheduled: [],
    unscheduled_detail: [],
    risk_weighted_wait: 0,
  };
}

const SABAH_IDS = new Set(['MY_1', 'MY_2', 'MY_3', 'MY_4']);

test('computeFlaggedVsHit with no optimize run returns zero national/sabah counts', () => {
  const result = computeFlaggedVsHit(null, new Set(['MY_1']), SABAH_IDS);
  assert.equal(result.nationalOrderCount, 0);
  assert.equal(result.sabahOrderCount, 0);
  assert.deepEqual(result.flaggedTowerIds, []);
});

test('computeFlaggedVsHit filters entries to the Sabah id set', () => {
  const run = fakeRun([
    { crew_id: 'SBH-C1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
    { crew_id: 'SEL-C1', tower_id: 'MY_9', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
  ]);
  const result = computeFlaggedVsHit(run, new Set(), SABAH_IDS);
  assert.equal(result.nationalOrderCount, 2);
  assert.equal(result.sabahOrderCount, 1);
  assert.deepEqual(result.flaggedTowerIds, ['MY_1']);
});

test('computeFlaggedVsHit reports overlap: both flagged and hit', () => {
  const run = fakeRun([
    { crew_id: 'SBH-C1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
  ]);
  const result = computeFlaggedVsHit(run, new Set(['MY_1']), SABAH_IDS);
  assert.deepEqual(result.bothFlaggedAndHit, ['MY_1']);
  assert.deepEqual(result.hitButNotFlagged, []);
  assert.deepEqual(result.flaggedButNotHit, []);
});

test('computeFlaggedVsHit surfaces divergence: hit but not flagged', () => {
  const run = fakeRun([
    { crew_id: 'SBH-C1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
  ]);
  const result = computeFlaggedVsHit(run, new Set(['MY_1', 'MY_2']), SABAH_IDS);
  assert.deepEqual(result.bothFlaggedAndHit, ['MY_1']);
  assert.deepEqual(result.hitButNotFlagged, ['MY_2']);
});

test('computeFlaggedVsHit surfaces divergence: flagged but not hit', () => {
  const run = fakeRun([
    { crew_id: 'SBH-C1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
    { crew_id: 'SBH-C1', tower_id: 'MY_2', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
  ]);
  const result = computeFlaggedVsHit(run, new Set(['MY_1']), SABAH_IDS);
  assert.deepEqual(result.flaggedButNotHit, ['MY_2']);
});

test('parseClockLabelHours parses positive, negative and zero offsets', () => {
  assert.equal(parseClockLabelHours('T+4h'), 4);
  assert.equal(parseClockLabelHours('T-72h'), -72);
  assert.equal(parseClockLabelHours('T-0'), -0);
});

test('parseClockLabelHours returns null for unparseable input', () => {
  assert.equal(parseClockLabelHours('garbage'), null);
  assert.equal(parseClockLabelHours(''), null);
  assert.equal(parseClockLabelHours('T+abc'), null);
});

test('timeToResponseHours computes the difference between two scenario clock labels', () => {
  assert.equal(timeToResponseHours('T-0', 'T+4h'), 4);
  assert.equal(timeToResponseHours('T-72h', 'T-24h'), 48);
});

test('timeToResponseHours returns null if either label fails to parse', () => {
  assert.equal(timeToResponseHours('garbage', 'T+4h'), null);
  assert.equal(timeToResponseHours('T-0', 'garbage'), null);
});
