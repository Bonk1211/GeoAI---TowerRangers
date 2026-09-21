import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeImpact, costLabel } from './dispatchImpact.ts';

const OWN = 'MY_N13331200716';

function preview(over = {}) {
  return {
    moved: [],
    dropped: [],
    risk_weighted_wait_before: 100,
    risk_weighted_wait_after: 100,
    ...over,
  };
}

test('no preview yet reads as no cost rather than as zero cost', () => {
  const s = summarizeImpact(null, OWN);
  assert.equal(s.waitDeltaPct, null);
  assert.equal(s.costsNothing, true);
  assert.equal(s.ownMove, null);
});

test('the pinned tower is the action, not a cost', () => {
  const s = summarizeImpact(
    preview({
      moved: [
        { tower_id: OWN, from: '2026-09-13', to: '2026-09-10', delta_days: -3 },
        { tower_id: 'MY_A', from: '2026-09-11', to: '2026-09-12', delta_days: 1 },
      ],
    }),
    OWN,
  );
  assert.equal(s.ownMove?.delta_days, -3);
  assert.equal(s.moved.length, 1);
  assert.equal(s.moved[0].tower_id, 'MY_A');
  // Its own move must not inflate the disruption the planner is being asked
  // to accept.
  assert.equal(s.later, 1);
  assert.equal(s.earlier, 0);
});

test('the pinned tower is excluded from dropped as well', () => {
  const s = summarizeImpact(preview({ dropped: [OWN, 'MY_B'] }), OWN);
  assert.deepEqual(s.dropped, ['MY_B']);
});

test('buckets group by days shifted and are ordered earliest first', () => {
  const s = summarizeImpact(
    preview({
      moved: [
        { tower_id: 'A', from: 'x', to: 'y', delta_days: 1 },
        { tower_id: 'B', from: 'x', to: 'y', delta_days: 1 },
        { tower_id: 'C', from: 'x', to: 'y', delta_days: -2 },
        { tower_id: 'D', from: 'x', to: 'y', delta_days: 2 },
      ],
    }),
    OWN,
  );
  assert.deepEqual(s.buckets, [
    { delta: -2, count: 1 },
    { delta: 1, count: 2 },
    { delta: 2, count: 1 },
  ]);
  assert.equal(s.maxBucket, 2);
  assert.equal(s.earlier, 1);
  assert.equal(s.later, 3);
});

test('a crew swap with no date change is counted but never bucketed', () => {
  // delta 0 is a real row from the backend — _diff() reports a change of
  // (crew_id, day), so a same-day reassignment arrives with delta_days 0. A
  // zero-width bar would be invisible and a zero-length one misleading.
  const s = summarizeImpact(
    preview({ moved: [{ tower_id: 'A', from: 'x', to: 'x', delta_days: 0 }] }),
    OWN,
  );
  assert.equal(s.sameDay, 1);
  assert.deepEqual(s.buckets, []);
  assert.equal(s.earlier, 0);
  assert.equal(s.later, 0);
  // It still counts as a cost — something moved.
  assert.equal(s.costsNothing, false);
});

test('a zero baseline yields null rather than Infinity', () => {
  const s = summarizeImpact(
    preview({ risk_weighted_wait_before: 0, risk_weighted_wait_after: 5 }),
    OWN,
  );
  assert.equal(s.waitDeltaPct, null);
});

test('wait delta is signed and rounded', () => {
  const up = summarizeImpact(
    preview({ risk_weighted_wait_before: 261.125, risk_weighted_wait_after: 270.088 }),
    OWN,
  );
  assert.equal(up.waitDeltaPct, 3); // the measured PHG-C1 case
  const down = summarizeImpact(
    preview({ risk_weighted_wait_before: 100, risk_weighted_wait_after: 96 }),
    OWN,
  );
  assert.equal(down.waitDeltaPct, -4);
});

test('costLabel leads with the wait and names dropped work when there is any', () => {
  const s = summarizeImpact(
    preview({
      risk_weighted_wait_before: 100,
      risk_weighted_wait_after: 103,
      dropped: ['MY_B', 'MY_C'],
      moved: [{ tower_id: 'A', from: 'x', to: 'y', delta_days: 1 }],
    }),
    OWN,
  );
  assert.equal(costLabel(s), '+3% wait · 2 dropped');
});

test('costLabel says so plainly when a dispatch displaces nothing', () => {
  const s = summarizeImpact(preview(), OWN);
  assert.equal(costLabel(s), '0% wait · displaces nothing');
});

test('costLabel falls back to the move count when nothing is dropped', () => {
  const s = summarizeImpact(
    preview({
      risk_weighted_wait_after: 101,
      moved: [
        { tower_id: 'A', from: 'x', to: 'y', delta_days: 1 },
        { tower_id: 'B', from: 'x', to: 'y', delta_days: 1 },
      ],
    }),
    OWN,
  );
  assert.equal(costLabel(s), '+1% wait · 2 moved');
});
