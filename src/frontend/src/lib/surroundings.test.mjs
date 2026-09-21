import assert from 'node:assert/strict';
import test from 'node:test';
import { surroundingsReading, switchRainLayer, withinLayer } from './surroundings.ts';

test('card readings belong to the displayed source, preserve zero, and reject missing or historical samples', () => {
  const weather = { rain_mm_24h: 0, soil_moisture: 0.31,
    issued_at: '2026-09-20T00:00:00Z', observed_at: '2026-09-17T00:00:00Z' };
  const tiles = { forecast: { issued_at: weather.issued_at }, observed_at: weather.observed_at };
  assert.equal(surroundingsReading('forecast_rainfall_24h', tiles, weather), 0);
  assert.equal(surroundingsReading('soil_moisture', tiles, weather), 0.31);
  assert.equal(surroundingsReading('precipitation', tiles, weather), null);
  assert.equal(surroundingsReading('soil_moisture', { ...tiles, observed_at: '2021-12-20' }, weather), null);
  assert.equal(surroundingsReading('forecast_rainfall_24h', tiles, { ...weather, issued_at: '2026-09-19' }), null);
  assert.equal(surroundingsReading('soil_moisture', tiles, { ...weather, soil_moisture: null }), null);
  assert.equal(surroundingsReading('soil_moisture', undefined, weather), null);
  assert.equal(surroundingsReading('soil_moisture', tiles, null), null);
  assert.equal(withinLayer({ lon: 101.6, lat: 3.1 }, [99, 0, 119, 8]), true);
  assert.equal(withinLayer({ lon: 121, lat: 3.1 }, [99, 0, 119, 8]), false);
  assert.deepEqual(switchRainLayer(['soil_moisture', 'forecast_rainfall_24h'], 'forecast_rainfall_24h', 'precipitation'), ['soil_moisture', 'precipitation']);
  assert.deepEqual(switchRainLayer(['precipitation', 'forecast_rainfall_24h'], 'precipitation', 'forecast_rainfall_24h'), ['forecast_rainfall_24h']);
  assert.deepEqual(switchRainLayer([], 'precipitation', 'forecast_rainfall_24h'), []);
});
