import { ROLE_TEAMS } from './roleTeams.ts';
import type { Crew, ScheduleRun } from '../api/types.ts';

export interface TeamReadiness {
  crewType: string;
  label: string;
  reserveDays: number;
  availableToday: boolean;
  nextReserveDay: string | null;
}

/**
 * The crew ids staffed in one territory.
 *
 * A ScheduleRun is national: `run.reserve` and `run.entries` cover every
 * territory the solver planned, while the board only ever draws the crews of
 * the selected one (TimelineBoard filters by `crew.territory`). Counting the
 * national list beside a territory-filtered board overstates cover by the
 * ratio of the two rosters — 19 reserve slots a day nationally against
 * Selangor's 2. Every count shown above the board goes through this.
 */
export function crewIdsInTerritory(crews: Crew[], territory: string): Set<string> {
  return new Set(crews.filter((c) => c.territory === territory).map((c) => c.crew_id));
}

/**
 * The same run, with `reserve` and `entries` narrowed to one territory's
 * crews. Horizon, unscheduled and the objective stay as the solver reported
 * them — those are properties of the run, not of a crew roster.
 */
export function scopeRunToCrews(run: ScheduleRun, crewIds: Set<string>): ScheduleRun {
  return {
    ...run,
    entries: run.entries.filter((e) => crewIds.has(e.crew_id)),
    reserve: run.reserve.filter((r) => crewIds.has(r.crew_id)),
  };
}

export function readinessByTeam(run: ScheduleRun, today?: string): TeamReadiness[] {
  // Default today to run.horizon[0], falling back to '' if horizon is empty
  const resolvedToday = today !== undefined ? today : (run.horizon[0] ?? '');

  return ROLE_TEAMS.map((team) => {
    // Count reserve crew-days for this team type
    const teamReserves = run.reserve.filter((slot) => slot.crew_type === team.crewType);

    // Check if available today
    const availableToday = teamReserves.some((slot) => slot.day === resolvedToday);

    // Find next reserved day strictly after today (not on-or-after)
    const futureReserves = teamReserves.filter((slot) => slot.day > resolvedToday);
    const nextReserveDay =
      futureReserves.length > 0
        ? futureReserves.sort((a, b) => a.day.localeCompare(b.day))[0].day
        : null;

    return {
      crewType: team.crewType,
      label: team.label,
      reserveDays: teamReserves.length,
      availableToday,
      nextReserveDay,
    };
  });
}
