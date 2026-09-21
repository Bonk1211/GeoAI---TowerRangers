/** Web Mercator units, shared by every plane. Elevation here is display spacing. */
export type StackRect = [number, number, number, number];
export const mercatorX = (lon: number) => (lon + 180) / 360;
export const mercatorY = (lat: number) => {
  const radians = Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
};

export function stackFrame(lon: number, lat: number, zoom: number, width: number): StackRect {
  const world = 512 * 2 ** zoom;
  const span = Math.min(620, Math.max(220, width - 760)) / world;
  const x = mercatorX(lon), y = mercatorY(lat);
  return [x - span / 2, y - span / 2, x + span / 2, y + span / 2];
}

export function stackHeight(level: number, count: number, spacing: number, zoom: number, height: number) {
  // ponytail: fit one viewport; group stacks if dozens of levels need readable labels.
  return level * height * 0.34 / Math.max(1, count) * spacing / 150 / (512 * 2 ** zoom);
}

export function stackTiles(frame: StackRect, bounds: StackRect, zoom: number, maxZoom: number) {
  const west = Math.max(frame[0], mercatorX(bounds[0]), 0);
  const north = Math.max(frame[1], mercatorY(bounds[3]), 0);
  const east = Math.min(frame[2], mercatorX(bounds[2]), 1);
  const south = Math.min(frame[3], mercatorY(bounds[1]), 1);
  if (west >= east || north >= south) return [];
  const z = Math.max(0, Math.min(Math.floor(zoom + 1), maxZoom));
  const size = 2 ** z;
  const tiles = [];
  for (let x = Math.floor(west * size); x < Math.ceil(east * size); x++) {
    for (let y = Math.floor(north * size); y < Math.ceil(south * size); y++) {
      tiles.push({ x, y, z, key: `${z}/${x}/${y}`, rect: [x / size, y / size, (x + 1) / size, (y + 1) / size] as StackRect });
    }
  }
  return tiles;
}

export function stackTileUrl(template: string, x: number, y: number, z: number) {
  const size = 2 ** z, circumference = 40075016.68557849;
  const bbox = [x / size - 0.5, 0.5 - (y + 1) / size, (x + 1) / size - 0.5, 0.5 - y / size]
    .map((v) => v * circumference).join(',');
  return template.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y))
    .replaceAll('{bbox-epsg-3857}', bbox);
}
