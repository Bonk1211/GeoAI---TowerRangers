import assert from 'node:assert/strict';
import test from 'node:test';

import { bearingDeg, circlePolygon, sectorPolygon } from './coverageGeometry.ts';

function closeTo(actual, expected, tolerance = 0.5) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be close to ${expected}`,
  );
}

test('bearing due north is ~0 degrees', () => {
  closeTo(bearingDeg({ lon: 116.07, lat: 5.9 }, { lon: 116.07, lat: 6.0 }), 0);
});

test('bearing due east is ~90 degrees', () => {
  closeTo(bearingDeg({ lon: 116.0, lat: 5.98 }, { lon: 116.2, lat: 5.98 }), 90);
});

test('bearing due south is ~180 degrees', () => {
  closeTo(bearingDeg({ lon: 116.07, lat: 6.0 }, { lon: 116.07, lat: 5.9 }), 180);
});

test('bearing due west is ~270 degrees', () => {
  closeTo(bearingDeg({ lon: 116.2, lat: 5.98 }, { lon: 116.0, lat: 5.98 }), 270);
});

test('bearing is always in [0, 360)', () => {
  const cases = [
    [{ lon: 0, lat: 0 }, { lon: -1, lat: -1 }],
    [{ lon: 10, lat: 50 }, { lon: -10, lat: 50 }],
    [{ lon: 179, lat: 0 }, { lon: -179, lat: 0 }],
  ];
  for (const [a, b] of cases) {
    const bearing = bearingDeg(a, b);
    assert.ok(bearing >= 0 && bearing < 360, `bearing ${bearing} out of range`);
    assert.ok(Number.isFinite(bearing));
  }
});

test('bearing across the antimeridian resolves the short way, not the long way', () => {
  // A point just east of the antimeridian to one just west of it: the short
  // path is eastward (~small bearing), not a near-180-degree swing.
  const bearing = bearingDeg({ lon: 179.9, lat: 0 }, { lon: -179.9, lat: 0 });
  // Crossing eastward at the equator should read close to due east (90) —
  // certainly not anywhere near 180 or 270, which a naive dLon = -359.8
  // (unwrapped) would produce.
  assert.ok(bearing < 100 || bearing > 260, `unexpected antimeridian bearing ${bearing}`);
});

test('bearing between identical points is 0, never NaN', () => {
  const p = { lon: 101.61, lat: 3.07 };
  const bearing = bearingDeg(p, p);
  assert.equal(bearing, 0);
  assert.ok(!Number.isNaN(bearing));
});

test('circlePolygon returns a closed ring with no NaN coordinates', () => {
  const polygon = circlePolygon({ lon: 116.07, lat: 5.98 }, 5);
  const ring = polygon.coordinates[0];
  assert.ok(ring.length > 3);
  for (const [lon, lat] of ring) {
    assert.ok(Number.isFinite(lon));
    assert.ok(Number.isFinite(lat));
  }
  // Closed ring: first and last point coincide.
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

test('circlePolygon points are all roughly radiusKm from the center', () => {
  const center = { lon: 116.07, lat: 5.98 };
  const radiusKm = 8;
  const polygon = circlePolygon(center, radiusKm, 8);
  // Rough haversine check without importing lib/geo, to keep this module's
  // test dependency-free like the module itself.
  const R = 6371;
  for (const [lon, lat] of polygon.coordinates[0]) {
    const dLat = ((lat - center.lat) * Math.PI) / 180;
    const dLon = ((lon - center.lon) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((center.lat * Math.PI) / 180) *
        Math.cos((lat * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    const distanceKm = 2 * R * Math.asin(Math.sqrt(a));
    closeTo(distanceKm, radiusKm, 0.2);
  }
});

test('sectorPolygon starts and ends at the center (a pie slice, not a chord)', () => {
  const center = { lon: 116.07, lat: 5.98 };
  const polygon = sectorPolygon(center, 90, 60, 5);
  const ring = polygon.coordinates[0];
  assert.deepEqual(ring[0], [center.lon, center.lat]);
  assert.deepEqual(ring[ring.length - 1], [center.lon, center.lat]);
});

test('sectorPolygon has no NaN coordinates at any bearing', () => {
  for (const bearing of [0, 90, 180, 270, 359]) {
    const polygon = sectorPolygon({ lon: 116.07, lat: 5.98 }, bearing, 45, 6);
    for (const [lon, lat] of polygon.coordinates[0]) {
      assert.ok(Number.isFinite(lon));
      assert.ok(Number.isFinite(lat));
    }
  }
});
