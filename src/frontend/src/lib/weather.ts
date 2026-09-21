import type { WeatherHazard } from '../api/types';

/**
 * How a moved deadline is described, in one place.
 *
 * The drawer and the schedule why-slot both explain the same adjustment, so the
 * phrasing lives here rather than being written twice and drifting. The backend
 * has its own copy of these phrases in scheduler/explain.py, which renders the
 * server-side why-slot; they say the same thing in the same words on purpose.
 *
 * None of this copy implies a failure event. The deadline moved because rain is
 * forecast; the tower's condition has not changed.
 */

const DRIVER_PHRASES: Record<string, string> = {
  severe_rain: 'heavy rain forecast in the next 24 h',
  watch_rain: 'rain forecast in the next 24 h',
  saturated_ground: 'ground already saturated',
};

/** True when a forecast actually shortened this tower's deadline. */
export function movedForward(weather: WeatherHazard | null | undefined): weather is WeatherHazard {
  return Boolean(weather) && (weather as WeatherHazard).multiplier < 1;
}

/** "heavy rain forecast in the next 24 h, ground already saturated" */
export function driverPhrase(weather: WeatherHazard): string {
  return weather.drivers.map((d) => DRIVER_PHRASES[d] ?? d).join(', ');
}

/**
 * The baseline this deadline was pulled in from.
 *
 * Reconstructed from the multiplier rather than sent by the server, because the
 * server sends the applied number and the multiplier that produced it. It is an
 * approximation: the multiplier lands on the weather-coupled share only, so the
 * true baseline is slightly higher than dividing through. Rounded and labelled
 * "about" so it is not read as exact.
 */
export function approximateBaselineDays(urgencyDays: number, weather: WeatherHazard): number {
  return Math.round(urgencyDays / weather.multiplier);
}

/** Whole days between an observation and now, for stating staleness plainly. */
export function daysOld(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}
