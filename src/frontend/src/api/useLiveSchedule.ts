import { useCallback, useEffect, useRef } from 'react';
import type { ScheduleRun } from './types';
import { useOptimizeSchedule, useScheduleRunQuery } from './queries';
import { useOffline } from '../state/useOffline';
import { useScheduleStore } from '../state/useScheduleStore';
import { SCHEDULE_RUN } from '../fixtures/schedule';

// Single source of truth for the active ScheduleRun. Runs POST
// /schedule/optimize once on first use (a mutation, never a query — refetch-
// on-focus must not silently re-solve the schedule under the planner), then
// reads GET /schedule/{run_id}. Falls back to the fixture run, banner-flagged
// offline, if the optimizer call itself is unreachable.
export function useLiveSchedule(): {
  run: ScheduleRun;
  runId: string | null;
  isLoading: boolean;
  refetch: (newStartDate?: string) => Promise<void>;
} {
  const runId = useScheduleStore((s) => s.runId);
  const setRunId = useScheduleStore((s) => s.setRunId);
  const offlineRun = useScheduleStore((s) => s.offlineRun);
  const setOfflineRun = useScheduleStore((s) => s.setOfflineRun);
  const currentWeekStart = useScheduleStore((s) => s.currentWeekStart);
  const setCurrentWeekStart = useScheduleStore((s) => s.setCurrentWeekStart);
  const optimize = useOptimizeSchedule();
  const runQuery = useScheduleRunQuery(runId);
  const setOffline = useOffline((s) => s.setOffline);
  const attempted = useRef(false);

  const fetchSchedule = useCallback(
    async (startDate?: string) => {
      const today = startDate ?? currentWeekStart;
      try {
        const data = await optimize.mutateAsync({ today });
        setRunId(data.run_id);
        if (startDate) setCurrentWeekStart(startDate);
      } catch {
        setOffline(true);
        setOfflineRun(SCHEDULE_RUN);
      }
    },
    [currentWeekStart, optimize, setRunId, setCurrentWeekStart, setOffline, setOfflineRun],
  );

  useEffect(() => {
    if (runId || offlineRun || attempted.current) return;
    attempted.current = true;
    void fetchSchedule();
  }, [runId, offlineRun, fetchSchedule]);

  if (offlineRun) {
    return {
      run: offlineRun,
      runId: null,
      isLoading: false,
      refetch: fetchSchedule,
    };
  }

  return {
    run: runQuery.data ?? {
      run_id: '',
      horizon: [],
      entries: [],
      reserve: [],
      unscheduled: [],
      unscheduled_detail: [],
      risk_weighted_wait: 0,
    },
    runId,
    isLoading: !runId || runQuery.isLoading,
    refetch: fetchSchedule,
  };
}
