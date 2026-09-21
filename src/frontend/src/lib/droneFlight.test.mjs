import assert from 'node:assert/strict';
import test from 'node:test';

import {
  droneFlightAt,
  DRONE_LAUNCH_MS,
  DRONE_ON_STATION_MS,
  DRONE_RECALL_MS,
  DRONE_LANDED_MS,
} from './droneFlight.ts';

const STAGING = { lon: 116.0, lat: 6.0 };
const HOVER = { lon: 116.1, lat: 6.1 };

test('the drone is absent before launch', () => {
  assert.equal(droneFlightAt(DRONE_LAUNCH_MS - 1, STAGING, HOVER), null);
  assert.equal(droneFlightAt(0, STAGING, HOVER), null);
});

test('missing staging or hover point yields no drone', () => {
  assert.equal(droneFlightAt(DRONE_ON_STATION_MS, null, HOVER), null);
  assert.equal(droneFlightAt(DRONE_ON_STATION_MS, STAGING, null), null);
});

test('outbound flies from staging toward the hover point', () => {
  const start = droneFlightAt(DRONE_LAUNCH_MS, STAGING, HOVER);
  assert.equal(start.phase, 'outbound');
  assert.deepEqual(start.position, STAGING);
  assert.equal(start.covering, false, 'no coverage until it is on station');

  const mid = droneFlightAt((DRONE_LAUNCH_MS + DRONE_ON_STATION_MS) / 2, STAGING, HOVER);
  assert.equal(mid.phase, 'outbound');
  assert.ok(mid.position.lon > STAGING.lon && mid.position.lon < HOVER.lon);
  assert.equal(mid.covering, false);
});

test('coverage exists only while on station', () => {
  const onStation = droneFlightAt(DRONE_ON_STATION_MS, STAGING, HOVER);
  assert.equal(onStation.phase, 'on-station');
  assert.deepEqual(onStation.position, HOVER);
  assert.equal(onStation.covering, true);

  for (const ms of [DRONE_LAUNCH_MS, DRONE_RECALL_MS, DRONE_LANDED_MS]) {
    assert.equal(droneFlightAt(ms, STAGING, HOVER).covering, false, `covering at ${ms}`);
  }
});

test('the drone returns to staging and stays there', () => {
  const inbound = droneFlightAt(DRONE_RECALL_MS, STAGING, HOVER);
  assert.equal(inbound.phase, 'inbound');
  assert.deepEqual(inbound.position, HOVER);

  const landed = droneFlightAt(DRONE_LANDED_MS, STAGING, HOVER);
  assert.equal(landed.phase, 'landed');
  assert.deepEqual(landed.position, STAGING);

  // Still landed well past the end of the run.
  assert.deepEqual(droneFlightAt(200_000, STAGING, HOVER).position, STAGING);
});

test('reduced motion snaps to endpoints instead of animating', () => {
  const mid = (DRONE_LAUNCH_MS + DRONE_ON_STATION_MS) / 2;
  assert.deepEqual(droneFlightAt(mid, STAGING, HOVER, true).position, HOVER);
  const back = (DRONE_RECALL_MS + DRONE_LANDED_MS) / 2;
  assert.deepEqual(droneFlightAt(back, STAGING, HOVER, true).position, STAGING);
});

test('a non-finite clock yields no drone rather than NaN coordinates', () => {
  assert.equal(droneFlightAt(NaN, STAGING, HOVER), null);
});
