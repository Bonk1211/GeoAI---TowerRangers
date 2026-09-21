import { useMemo, useState } from 'react';
import { CREWS } from '../../fixtures/crews';
import { placeName } from '../../fixtures/schedule';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { buildEmergencyEntry } from '../../lib/overridePreview';
import { roleTeam } from '../../lib/roleTeams';
import { useCrewsQuery, usePinOverride } from '../../api/queries';
import { Button } from '../ui/Panel';
import { bandColor, bandInk } from '../../lib/colors';
import type { ScheduleRun } from '../../api/types';

interface AssignPanelProps {
  crew_id: string;
  day: string;
}

/**
 * What a free crew-day can be given.
 *
 * The candidate list is filtered to this crew's `crew_type`, the same way
 * EmergencyPanel picks its nearest crew and ReserveDetail picks its best
 * tower. Offering the whole of `run.unscheduled` let a civil flood tower be
 * assigned to an electrical crew, drawing a flood job under a header reading
 * "A5 lightning" — the exact contradiction the role-team grouping exists to
 * prevent. `unscheduled_detail` carries the solver's own crew_type for each
 * waiting tower, so the filter uses that rather than re-deriving the Annex C
 * mapping here.
 */
export function AssignPanel({ crew_id, day }: AssignPanelProps) {
  const run = useScheduleStore((s) => s.run);
  const runId = useScheduleStore((s) => s.runId);
  const offlineRun = useScheduleStore((s) => s.offlineRun);
  const offlineInsertEmergency = useScheduleStore((s) => s.offlineInsertEmergency);
  const setRun = useScheduleStore((s) => s.setRun);
  const select = useScheduleStore((s) => s.select);
  const offline = offlineRun !== null;
  const pinMutation = usePinOverride(runId);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const crewsQuery = useCrewsQuery();
  const [assigning, setAssigning] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const crew = (crewsQuery.data ?? CREWS).find((c) => c.crew_id === crew_id);
  const team = crew ? roleTeam(crew.crew_type) : undefined;

  const candidates = useMemo(() => {
    if (!crew) return [];
    return run.unscheduled_detail
      .filter((d) => d.crew_type === crew.crew_type)
      .map((d) => towers.find((t) => t.tower_id === d.tower_id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .sort((a, b) => b.risk - a.risk);
  }, [crew, run.unscheduled_detail, towers]);

  // "Nothing to assign" has two different causes and only one of them is a
  // statement about the dataset. If the run holds no work of this type at
  // all, the team's emptyReason is true. If the type's work is simply all
  // placed already, saying "no flood work in this AOI" would contradict the
  // civil bars drawn on the board behind this panel.
  const crews = crewsQuery.data ?? CREWS;
  const typeAppearsInRun =
    run.unscheduled_detail.some((d) => d.crew_type === crew?.crew_type) ||
    run.entries.some(
      (e) => crews.find((c) => c.crew_id === e.crew_id)?.crew_type === crew?.crew_type,
    );

  const assign = (tower_id: string) => {
    setAssigning(tower_id);
    setFailed(null);
    if (offline) {
      const tower = towers.find((t) => t.tower_id === tower_id);
      const entry = buildEmergencyEntry(tower_id, crew_id, day, undefined, tower);
      entry.pin_reason = 'planner_override';
      offlineInsertEmergency(entry, []);
      select({ kind: 'job', crew_id, day, tower_id });
      setAssigning(null);
      return;
    }
    if (!runId) return;
    pinMutation.mutate(
      { tower_id, target_crew_id: crew_id, target_day: day, pin_reason: 'planner_override' },
      {
        onSuccess: (updatedRun) => {
          setRun(updatedRun as ScheduleRun);
          setAssigning(null);
          // A later success must clear an earlier failure, or the panel keeps
          // reporting a failed assignment beside work that has since landed.
          setFailed(null);
        },
        onError: () => {
          setAssigning(null);
          setFailed(tower_id);
        },
      },
    );
  };

  return (
    <div className="p-5">
      <h3 className="eyebrow mb-2">Free crew-day</h3>
      <p className="text-ui leading-relaxed text-dim">
        Nothing is booked for {crew_id} on {day}. Assign an unscheduled tower here, or leave it free.
      </p>

      {failed && (
        <p className="mt-3 rounded-lg border border-alert/35 bg-alert/[0.09] p-3 text-micro leading-relaxed text-alert-ink">
          Assigning {placeName(failed)} failed. Nothing changed — the crew-day is still free. Try
          again.
        </p>
      )}

      <h4 className="eyebrow mt-5">
        Unscheduled {crew?.crew_type ?? ''} towers, most urgent first
      </h4>
      {candidates.length === 0 ? (
        // The reason, not just the absence: this crew can only take work its
        // own type answers, so "nothing to assign" here means nothing of
        // that type is waiting — which for electrical is a property of the
        // dataset, not of today's plan.
        <p className="mt-2 text-ui leading-relaxed text-dim">
          {typeAppearsInRun
            ? `Every ${crew?.crew_type ?? ''} tower due this week is already placed.`
            : (team?.emptyReason ?? `No unscheduled ${crew?.crew_type ?? ''} towers are waiting.`)}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {candidates.map((tower) => (
            <li key={tower.tower_id} className="spine glass rounded-lg py-2 pl-3 pr-2" style={{ '--spine': bandColor(tower.decision) } as React.CSSProperties}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-ui font-medium text-fg">{placeName(tower.tower_id)}</div>
                  <div className="flex items-center gap-2 text-micro text-muted">
                    <span className="tnum" style={{ color: bandInk(tower.decision) }}>
                      {tower.risk.toFixed(2)}
                    </span>
                    <span className="truncate capitalize text-dim">{tower.dominant_factor}</span>
                  </div>
                </div>
                <Button onClick={() => assign(tower.tower_id)} disabled={assigning === tower.tower_id}>
                  {assigning === tower.tower_id ? 'Assigning…' : 'Assign'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
