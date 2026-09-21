import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createClock,
  play,
  pause,
  resume,
  setSpeed,
  seek,
  reset,
  tick,
} from './simulationClock.ts';

const TOTAL = 100_000;

test('createClock starts idle at zero', () => {
  const c = createClock();
  assert.equal(c.status, 'idle');
  assert.equal(c.elapsedMs, 0);
  assert.equal(c.speed, 1);
});

test('play from idle starts running without resetting elapsed', () => {
  const c = play(createClock());
  assert.equal(c.status, 'running');
  assert.equal(c.elapsedMs, 0);
});

test('play from done restarts at zero', () => {
  const done = { status: 'done', elapsedMs: TOTAL, speed: 1 };
  const restarted = play(done);
  assert.equal(restarted.status, 'running');
  assert.equal(restarted.elapsedMs, 0);
});

test('pause only takes effect while running', () => {
  const running = play(createClock());
  const paused = pause(running);
  assert.equal(paused.status, 'paused');

  const idle = createClock();
  assert.equal(pause(idle).status, 'idle'); // no-op
});

test('resume only takes effect while paused', () => {
  const paused = pause(play(createClock()));
  const resumed = resume(paused);
  assert.equal(resumed.status, 'running');

  const idle = createClock();
  assert.equal(resume(idle).status, 'idle'); // no-op
});

test('tick is a no-op unless running', () => {
  const idle = createClock();
  assert.deepEqual(tick(idle, 1000, TOTAL), idle);

  const paused = pause(play(createClock()));
  assert.deepEqual(tick(paused, 1000, TOTAL), paused);
});

test('tick advances elapsedMs by deltaMs at speed 1', () => {
  const running = play(createClock());
  const advanced = tick(running, 500, TOTAL);
  assert.equal(advanced.elapsedMs, 500);
});

test('tick advances by deltaMs * speed', () => {
  let c = play(createClock());
  c = setSpeed(c, 4);
  c = tick(c, 500, TOTAL);
  assert.equal(c.elapsedMs, 2000);
});

test('switching speed mid-run does not rescale already-elapsed time (the classic bug)', () => {
  let c = play(createClock());
  c = tick(c, 10_000, TOTAL); // 10s of real time at 1x -> 10_000ms elapsed
  assert.equal(c.elapsedMs, 10_000);

  // Now switch to 2x. elapsedMs must be untouched by the switch itself.
  c = setSpeed(c, 2);
  assert.equal(c.elapsedMs, 10_000, 'setSpeed must not rescale accumulated time');

  // The NEXT tick is what doubles, not the past.
  c = tick(c, 1000, TOTAL);
  assert.equal(c.elapsedMs, 12_000);
});

test('tick clamps to totalDurationMs and flips to done', () => {
  let c = play(createClock());
  c = tick(c, TOTAL + 5000, TOTAL);
  assert.equal(c.elapsedMs, TOTAL);
  assert.equal(c.status, 'done');
});

test('seek clamps into [0, total] and never accepts a running status', () => {
  const c = seek(createClock(), -50, TOTAL);
  assert.equal(c.elapsedMs, 0);
  assert.equal(c.status, 'paused');

  const overshoot = seek(createClock(), TOTAL + 1000, TOTAL);
  assert.equal(overshoot.elapsedMs, TOTAL);
  assert.equal(overshoot.status, 'done');
});

test('seek backwards from done lands on paused, not done, below the total', () => {
  const done = { status: 'done', elapsedMs: TOTAL, speed: 1 };
  const rewound = seek(done, 20_000, TOTAL);
  assert.equal(rewound.elapsedMs, 20_000);
  assert.equal(rewound.status, 'paused');
});

test('reset returns a fresh idle clock', () => {
  assert.deepEqual(reset(), createClock());
});
