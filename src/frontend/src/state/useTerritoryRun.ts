import { useMemo } from 'react';
import { CREWS } from '../fixtures/crews';
import { useCrewsQuery } from '../api/queries';
import { crewIdsInTerritory, scopeRunToCrews } from '../lib/readiness';
import { useScheduleStore } from './useScheduleStore';
import type { Crew, ScheduleRun } from '../api/types';

export interface TerritoryRun {
  /** The active run with entries + reserve narrowed to `crews`. */
  run: ScheduleRun;
  /** The crews the board actually draws — this territory's roster only. */
  crews: Crew[];
  crewIds: Set<string>;
}

/**
 * The run as the board actually shows it: one territory's crews, and only
 * the entries and reserve slots belonging to them.
 *
 * The solver plans nationally, so `run.reserve` and `run.entries` cover all
 * 16 territories in crews.json while TimelineBoard draws exactly one. Every
 * figure printed above that board — the readiness chips, the WeekStrip load
 * bars, the by-site day header's reserve count — has to be scoped the same
 * way or it describes a different board than the one on screen. One hook, so
 * the filter is written once rather than re-derived (and re-drifted) in each
 * component.
 */
export function useTerritoryRun(): TerritoryRun {
  const run = useScheduleStore((s) => s.run);
  const territory = useScheduleStore((s) => s.territory);
  const crewsQuery = useCrewsQuery();
  const allCrews = crewsQuery.data ?? CREWS;

  const crews = useMemo(
    () => allCrews.filter((c) => c.territory === territory),
    [allCrews, territory],
  );
  const crewIds = useMemo(() => crewIdsInTerritory(allCrews, territory), [allCrews, territory]);
  const scoped = useMemo(() => scopeRunToCrews(run, crewIds), [run, crewIds]);

  return { run: scoped, crews, crewIds };
}
