import type { Crew, ScheduleEntry } from '../api/types';

export interface CrewPosition {
  lon: number;
  lat: number;
  label: string;
  /** on_site: mid-job now. idle: finished, still at the last tower. depot: not out yet. */
  state: 'on_site' | 'idle' | 'depot';
  /**
   * This position's key in the backend road matrix — a tower_id when the crew
   * is at a tower, `depotKey(...)` when it is at its depot.
   *
   * Carried here rather than rebuilt by the caller because only this function
   * knows WHICH tower the crew is standing at; recovering that from lon/lat
   * downstream would mean matching floats.
   */
  key: string;
}

/**
 * Matrix key for a depot, byte-identical to scheduler/travel.py::depot_key.
 *
 * The two must agree exactly or every depot lookup silently misses and the
 * panel quietly falls back to estimates — a failure that looks like "the
 * matrix has no data" rather than like a bug.
 *
 * 5 dp matches the Python side. Python rounds half-to-even and JS rounds
 * half-away-from-zero, which can only diverge on an exact tie at the 6th
 * decimal; config/crews.json carries at most 4, so the rounding is a no-op
 * for every real depot and the tie case cannot arise.
 */
/**
 * A depot's name with exactly one "depot" on the end.
 *
 * The two crew id spaces spell it differently - config/crews.json says
 * "Kuantan", fixtures/crews.ts says "Kuantan depot" - so appending
 * unconditionally reads "at Kuantan depot depot" on the offline path. That
 * shipped, and was visible in the approval panel.
 *
 * Plain string comparison, never an inline regex here. The first fix used
 * one inside the template substitution and a stray control character got
 * into the literal, so the pattern silently could not match while every
 * terminal rendering of the file looked correct - the character erased the
 * one before it on screen. A named helper is also testable, which the
 * inline ternary was not.
 */
export function depotLabel(name: string): string {
  const n = name.trim();
  return n.toLowerCase().endsWith('depot') ? n : n + ' depot';
}

export function depotKey(lon: number, lat: number): string {
  return `depot:${Number(lon.toFixed(5))}:${Number(lat.toFixed(5))}`;
}

/**
 * Where a crew actually is right now, derived from the schedule the solver
 * committed plus the wall clock — never from GPS, because there is no
 * telemetry in this system and simulated pings would be fabricated data
 * presented as live tracking.
 *
 * An entry with no clock fields is skipped rather than read as midnight:
 * lib/gantt.ts already reports such a lane as `untimed` instead of inventing
 * geometry for it, and inventing a position here would be the same bug.
 */
export function crewPositionNow(
  crew: Crew,
  entriesToday: ScheduleEntry[],
  nowMin: number,
  towerCoords: Map<string, { lon: number; lat: number }>,
  placeNameOf: (tower_id: string) => string,
): CrewPosition {
  const atDepot = (): CrewPosition => ({
    lon: crew.depot.lon,
    lat: crew.depot.lat,
    label: `at ${depotLabel(crew.depot.name)}`,
    state: 'depot',
    key: depotKey(crew.depot.lon, crew.depot.lat),
  });

  const timed = entriesToday
    .filter((e) => e.crew_id === crew.crew_id)
    .filter((e) => typeof e.start_min === 'number' && typeof e.end_min === 'number')
    .sort((a, b) => (a.start_min as number) - (b.start_min as number));

  const onSite = timed.find(
    (e) => (e.start_min as number) <= nowMin && nowMin <= (e.end_min as number),
  );
  if (onSite) {
    const at = towerCoords.get(onSite.tower_id);
    if (!at) return atDepot();
    return { ...at, label: `on site at ${placeNameOf(onSite.tower_id)}`, state: 'on_site', key: onSite.tower_id };
  }

  const finished = [...timed].reverse().find((e) => (e.end_min as number) <= nowMin);
  if (finished) {
    const at = towerCoords.get(finished.tower_id);
    if (!at) return atDepot();
    return { ...at, label: `finished at ${placeNameOf(finished.tower_id)}`, state: 'idle', key: finished.tower_id };
  }

  return atDepot();
}
