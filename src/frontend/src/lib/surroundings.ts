import type { LayerTiles, Tower } from '../api/types';

/** A latest-weather sample must never masquerade as a reading from another image. */
export function surroundingsReading(layerId: string, tiles: LayerTiles | undefined, weather: Tower['weather']): number | null {
  if (!tiles || !weather) return null;
  const rain = layerId === 'forecast_rainfall_24h';
  if (!rain && layerId !== 'soil_moisture') return null;
  const imageTime = rain ? tiles.forecast?.issued_at : tiles.observed_at;
  const sampleTime = rain ? weather.issued_at : weather.observed_at;
  const value = rain ? weather.rain_mm_24h : weather.soil_moisture;
  return imageTime && sampleTime && Date.parse(imageTime) === Date.parse(sampleTime)
    && typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function withinLayer(tower: Pick<Tower, 'lon' | 'lat'>, bounds: LayerTiles['bounds']): boolean {
  return !bounds || (tower.lon >= bounds[0] && tower.lat >= bounds[1]
    && tower.lon <= bounds[2] && tower.lat <= bounds[3]);
}

export function switchRainLayer(active: string[], previous: string, next: string): string[] {
  return active.includes(previous) ? [...new Set(active.map((id) => id === previous ? next : id))] : active;
}
