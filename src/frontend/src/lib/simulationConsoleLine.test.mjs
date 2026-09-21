import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConsoleLine, resolveHeadline } from './simulationConsoleLine.ts';
import { beatById, BEATS } from './simulationTimeline.ts';

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

const noContext = {
  optimizeRun: null,
  emergencyRun: null,
  sabahTowerIds: new Set(),
  downTowerId: null,
  cowClusterCount: 0,
  generatorSiteCount: 0,
  retuneNeighborCount: null,
  hardeningSiteCount: null,
};

test('a beat with no backing run keeps its raw placeholder text', () => {
  const beat = beatById('optimize');
  assert.equal(resolveConsoleLine(beat, noContext), beat.console);
  assert.match(resolveConsoleLine(beat, noContext), /<n>/);
});

test('optimize beat fills n (entries) and k (distinct crews)', () => {
  const beat = beatById('optimize');
  const run = fakeRun([
    { crew_id: 'SBH-C1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
    { crew_id: 'SBH-P1', tower_id: 'MY_2', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
    { crew_id: 'SBH-P1', tower_id: 'MY_3', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
  ]);
  const line = resolveConsoleLine(beat, { ...noContext, optimizeRun: run });
  assert.match(line, /3 work orders/);
  assert.match(line, /across 2 crews/);
});

test('urgency-shift counts only towers inside the given Sabah set', () => {
  const beat = beatById('urgency-shift');
  const run = fakeRun([
    { crew_id: 'SBH-C1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
    { crew_id: 'SEL-C1', tower_id: 'MY_2', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
  ]);
  const line = resolveConsoleLine(beat, {
    ...noContext,
    optimizeRun: run,
    sabahTowerIds: new Set(['MY_1']),
  });
  assert.match(line, /^Urgency multiplier applied to flood-coupled factors — 1 Sabah towers/);
});

test('generators beat fills n with the scenario\'s own generator site count, not the down-tower count', () => {
  const beat = beatById('generators');
  const line = resolveConsoleLine(beat, { ...noContext, generatorSiteCount: 12 });
  assert.match(line, /at 12 flood-prone sites/);
});

test('cow beat fills n with the drone count, not a place name', () => {
  const beat = beatById('cow');
  const line = resolveConsoleLine(beat, { ...noContext, cowClusterCount: 12 });
  assert.match(line, /^12 airborne relay\(s\)/);
  assert.ok(!line.includes('<location>'));
  assert.ok(!line.includes('<n>'));
});

test('harden beat resolves the hardening site count', () => {
  const beat = beatById('harden');
  const line = resolveConsoleLine(beat, { ...noContext, hardeningSiteCount: 3 });
  assert.match(line, /3 sites/);
  assert.ok(!line.includes('<n>'));
});

test('harden headline and console report the same site count', () => {
  const beat = beatById('harden');
  const context = { ...noContext, hardeningSiteCount: 2 };
  assert.match(resolveHeadline(beat, context), /2 sites/);
  assert.match(resolveConsoleLine(beat, context), /2 sites/);
});

test('harden beat keeps its placeholder when no hardening unit resolved', () => {
  const beat = beatById('harden');
  // Null is "not worked out yet" (roads unavailable, legs still loading).
  assert.equal(resolveConsoleLine(beat, { ...noContext, hardeningSiteCount: null }), beat.console);
  // Zero defers too: this beat asserts crews WERE dispatched, so "0 sites"
  // would be the line contradicting itself.
  assert.equal(resolveConsoleLine(beat, { ...noContext, hardeningSiteCount: 0 }), beat.console);
});

test('tower-down beat resolves the scenario down tower id', () => {
  const beat = beatById('tower-down');
  const line = resolveConsoleLine(beat, { ...noContext, downTowerId: 'MY_42' });
  assert.match(line, /MY_42/);
  assert.match(line, /scenario picks/);
});

test('generator-dispatch beat counts every emergency-reason pin, not just one tower', () => {
  // The fan-out dispatch (2026-09-17) commits sequentially against the same
  // run_id, so the FINAL emergencyRun's entries hold one 'emergency'-reason
  // pin per down tower dispatched to, plus whatever ordinary maintain-band
  // entries the optimize run already carried — this pins that the count
  // only includes the former.
  const beat = beatById('generator-dispatch');
  const run = fakeRun([
    { crew_id: 'SBH-P1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: true, pin_reason: 'emergency' },
    { crew_id: 'SBH-P1', tower_id: 'MY_2', day: '2026-09-15', order: 2, work_order: {}, pinned: true, pin_reason: 'emergency' },
    { crew_id: 'SBH-C1', tower_id: 'MY_9', day: '2026-09-15', order: 1, work_order: {}, pinned: false, pin_reason: null },
  ]);
  const line = resolveConsoleLine(beat, { ...noContext, emergencyRun: run });
  assert.match(line, /^Emergency work orders committed -> 2 offline sites \(crew SBH-P1\)/);
});

test('generator-dispatch beat keeps raw placeholder text before emergencyRun resolves', () => {
  const beat = beatById('generator-dispatch');
  assert.equal(resolveConsoleLine(beat, noContext), beat.console);
  assert.match(resolveConsoleLine(beat, noContext), /<n>/);
});

test('a beat not in the placeholder switch passes through unchanged', () => {
  const beat = beatById('taskforce');
  assert.equal(resolveConsoleLine(beat, noContext), beat.console);
});

test('antenna-retune fills n with the number of retuning neighbour cells', () => {
  const beat = beatById('antenna-retune');
  const line = resolveConsoleLine(beat, { ...noContext, retuneNeighborCount: 7 });
  assert.match(line, /7 neighbouring cells/);
  assert.doesNotMatch(line, /<n>/);
});

test('antenna-retune keeps its raw placeholder before the geometry resolves', () => {
  // null means "not computed yet", which is not the same as "zero cells
  // retuned" — the module never invents a number for unresolved data.
  const beat = beatById('antenna-retune');
  assert.equal(resolveConsoleLine(beat, noContext), beat.console);
});

test('antenna-retune reports a genuine zero rather than hiding it', () => {
  const beat = beatById('antenna-retune');
  const line = resolveConsoleLine(beat, { ...noContext, retuneNeighborCount: 0 });
  assert.match(line, /0 neighbouring cells/);
});

test('no beat in the timeline can leak an unresolved placeholder to a viewer', () => {
  // The regression guard for this whole class of bug: antenna-retune shipped
  // with a <n> in its text and no case in the switch, so the console printed
  // the literal token on the demo screen. Any future beat that gains a
  // placeholder without a resolver fails here rather than on stage.
  const resolved = {
    optimizeRun: fakeRun([
      { crew_id: 'C1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: false },
    ]),
    emergencyRun: fakeRun([
      { crew_id: 'C1', tower_id: 'MY_1', day: '2026-09-15', order: 1, work_order: {}, pinned: false, pin_reason: 'emergency' },
    ]),
    sabahTowerIds: new Set(['MY_1']),
    downTowerId: 'MY_1',
    cowClusterCount: 2,
    generatorSiteCount: 3,
    retuneNeighborCount: 4,
    hardeningSiteCount: 3,
  };
  const leaked = [];
  for (const beat of BEATS) {
    if (!/<\w+>/.test(beat.console)) continue;
    const line = resolveConsoleLine(beat, resolved);
    if (/<\w+>/.test(line)) leaked.push(`${beat.id}: ${line}`);
  }
  assert.deepEqual(leaked, [], 'beats leaked a placeholder: ' + leaked.join(' | '));
});
