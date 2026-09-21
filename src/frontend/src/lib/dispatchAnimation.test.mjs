import assert from 'node:assert/strict';
import test from 'node:test';

import { moveDelaySec, emergencyDelaySec, SLIDE_MS, STAGGER_MS, LAND_MS } from './dispatchAnimation.ts';

test('the first move starts with no delay', () => {
  assert.equal(moveDelaySec(0), 0);
});

test('later moves are staggered by STAGGER_MS apart', () => {
  assert.equal(moveDelaySec(1), STAGGER_MS / 1000);
  assert.equal(moveDelaySec(2), (2 * STAGGER_MS) / 1000);
});

test('no moves means the emergency lands immediately', () => {
  assert.equal(emergencyDelaySec(0), 0);
});

test('the emergency waits for the LAST move to finish travelling', () => {
  // One move: starts at 0, travels for SLIDE_MS, lands at SLIDE_MS.
  assert.equal(emergencyDelaySec(1), SLIDE_MS / 1000);
  // Three moves: the third starts at 2*STAGGER_MS and takes SLIDE_MS more.
  assert.equal(emergencyDelaySec(3), (2 * STAGGER_MS + SLIDE_MS) / 1000);
});

test('phase timings are ordered so the emergency lands after the moves settle', () => {
  assert.ok(STAGGER_MS < SLIDE_MS);
  assert.ok(LAND_MS > 0);
});
