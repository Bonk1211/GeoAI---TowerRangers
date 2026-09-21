import assert from 'node:assert/strict';
import test from 'node:test';
import { mercatorX, mercatorY, stackFrame, stackHeight, stackTiles, stackTileUrl } from './stackGeometry.ts';
import { isSkyLayer } from './eeLayer.ts';

test('only observed and forecast rainfall belong in the sky', () => {
  for (const id of ['precipitation', 'forecast_rainfall_24h']) assert.equal(isSkyLayer(id), true);
  for (const id of ['vegetation_vigour', 'land_cover', 'soil_moisture', 'soil_texture', 'ground_slope',
    'flood_extent', 'daily_water', 'surface_water', 'permanent_water', 'potential_depth',
    'glofas_flood_outlook', 'glofas_rapid_flood_extent', 's1_backscatter', 'active_fire']) {
    assert.equal(isSkyLayer(id), false, `${id} stays on the ground`);
  }
});

test('stack preserves geographic alignment, finite spacing and XYZ/WMS tile coverage', () => {
  assert.equal(mercatorX(0), 0.5);
  assert.equal(mercatorY(0), 0.5);
  const frame = stackFrame(101.6, 3.1, 8, 1440);
  assert.equal((frame[0] + frame[2]) / 2, mercatorX(101.6));
  assert.equal((frame[1] + frame[3]) / 2, mercatorY(3.1));
  const levels = [1, 2, 3].map((n) => stackHeight(n, 3, 90, 8, 900));
  assert(levels[0] > 0 && levels[1] > levels[0] && levels[2] > levels[1]);
  assert(Math.abs(levels[2] - 3 * levels[0]) < 1e-12);
  assert(stackHeight(20, 20, 150, 8, 900) * 512 * 2 ** 8 <= 900 * 0.34);
  assert(stackHeight(3, 3, 150, 8, 900) > stackHeight(3, 3, 120, 8, 900), 'Spacing still changes with three or more layers');
  for (const width of [390, 1024, 1440, 1920]) {
    const area = stackFrame(101.6, 3.1, 8, width);
    assert(Math.abs((area[2] - area[0]) - (area[3] - area[1])) < 1e-12,
      'Every viewport gets a full square comparison area, not a narrow strip');
  }
  const tiles = stackTiles(frame, [92, -11.5, 142, 29], 14, 8);
  assert(tiles.length > 0 && tiles.length < 16);
  for (const tile of tiles) {
    assert.equal(tile.z, 8, 'Never request unsaved high-zoom tiles');
    assert(tile.rect[0] <= frame[2] && tile.rect[2] >= frame[0]);
    assert(tile.rect[1] <= frame[3] && tile.rect[3] >= frame[1]);
    assert.equal(stackTileUrl('/tiles/{z}/{x}/{y}', tile.x, tile.y, tile.z), `/tiles/${tile.key}`);
  }
  assert.deepEqual(stackTiles(frame, [-100, 10, -90, 20], 8, 8), []);
  assert.equal(stackTileUrl('/wms?bbox={bbox-epsg-3857}', 0, 0, 0),
    '/wms?bbox=-20037508.342789244,-20037508.342789244,20037508.342789244,20037508.342789244');
  assert.equal(stackTileUrl('/wms?bbox={bbox-epsg-3857}', 1, 1, 1),
    '/wms?bbox=0,-20037508.342789244,20037508.342789244,0');
});
