import { useEffect, useMemo, useState } from 'react';
import { CREWS } from '../../fixtures/crews';
import { placeName } from '../../fixtures/schedule';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { buildEmergencyEntry } from '../../lib/overridePreview';
import { roleTeam } from '../../lib/roleTeams';
import { RESERVE_HATCH_STYLE } from '../../lib/reserveHatch';
import { useCrewsQuery, usePinOverride, usePreviewOverride } from '../../api/queries';
import { Button } from '../ui/Panel';
import { bandColor, bandInk } from '../../lib/colors';
import type { ScheduleRun, Tower } from '../../api/types';

interface ReserveDetailProps {
  crew_id: string;
  day: string;
  onDone: () => void;
}

/** How many waiting towers to offer before "show more" — keeps the panel a
 * ranked shortlist, not the whole unscheduled table repeated in a sidebar. */
const SHORTLIST_SIZE = 5;

/**
 * The contrast this panel exists to show: a reserve slot is crew capacity
 * deliberately held free, and spending it gets urgent work done WITHOUT
 * dropping anything already booked. It previews before pinning — see RULING
 * in task-15-brief — because /schedule/pin returns a ScheduleRun, which
 * carries no `dropped` field; only /schedule/preview's OverridePreview does,
 * so the preview call is what lets this panel honestly report displacement
 * (or the absence of it) rather than assuming the reserve behaved as
 * designed.
 *
 * The target tower is a suggestion, not a rule: the panel ranks waiting
 * towers by risk and pre-selects the top one, but a planner can override it
 * to any other waiting tower of the same crew type. Auto-picking only the
 * single highest-risk tower — the earlier behaviour — meant a planner could
 * never choose the second-most-urgent site even when the top one was a poor
 * geographic fit for this crew; the ranking now informs the choice instead
 * of replacing it.
 */
export function ReserveDetail({ crew_id, day, onDone }: ReserveDetailProps) {
  const run = useScheduleStore((s) => s.run);
  const runId = useScheduleStore((s) => s.runId);
  const offlineRun = useScheduleStore((s) => s.offlineRun);
  const offlineInsertEmergency = useScheduleStore((s) => s.offlineInsertEmergency);
  const setRun = useScheduleStore((s) => s.setRun);
  const offline = offlineRun !== null;
  const crewsQuery = useCrewsQuery();
  const previewMutation = usePreviewOverride();
  const pinMutation = usePinOverride(runId);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);

  const crew = (crewsQuery.data ?? CREWS).find((c) => c.crew_id === crew_id);
  const team = crew ? roleTeam(crew.crew_type) : undefined;

  const matchingTowers = useMemo(() => {
    if (!crew) return [] as Tower[];
    const detail = run.unscheduled_detail.filter((d) => d.crew_type === crew.crew_type);
    const found: Tower[] = [];
    for (const d of detail) {
      const t = towers.find((tw) => tw.tower_id === d.tower_id);
      if (t) found.push(t);
    }
    return found.sort((a, b) => b.risk - a.risk);
  }, [crew, run.unscheduled_detail, towers]);

  const [showAll, setShowAll] = useState(false);
  const visibleTowers = showAll ? matchingTowers : matchingTowers.slice(0, SHORTLIST_SIZE);

  const [selectedTowerId, setSelectedTowerId] = useState<string | null>(null);
  // Re-suggest the top-risk tower whenever the candidate set changes under
  // this panel — a new crew-day selection, or the list refetching — rather
  // than leaving a stale id selected once from a previous crew's shortlist.
  useEffect(() => {
    setSelectedTowerId(matchingTowers[0]?.tower_id ?? null);
  }, [matchingTowers]);

  const bestTower = matchingTowers.find((t) => t.tower_id === selectedTowerId) ?? matchingTowers[0];

  // Same distinction AssignPanel draws: no candidate can mean the dataset
  // holds no work of this type, or simply that all of it is already placed.
  // Only the first is what team.emptyReason claims.
  const typeAppearsInRun =
    run.unscheduled_detail.some((d) => d.crew_type === crew?.crew_type) ||
    run.entries.some(
      (e) => (crewsQuery.data ?? CREWS).find((c) => c.crew_id === e.crew_id)?.crew_type === crew?.crew_type,
    );

  const [confirmed, setConfirmed] = useState(false);
  const [spentTowerId, setSpentTowerId] = useState<string | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  // A failed preview or pin used to leave the button re-enabled and the
  // panel unchanged: the planner clicks "Spend this reserve", the button
  // un-presses, and nothing on screen says the request never landed.
  const [failed, setFailed] = useState(false);

  const spending = previewMutation.isPending || pinMutation.isPending;

  if (!crew) {
    return <p className="p-5 text-ui leading-relaxed text-dim">Unknown crew.</p>;
  }

  const handleSpend = () => {
    if (!bestTower) return;
    setFailed(false);
    const tower_id = bestTower.tower_id;

    if (offline) {
      const existingEntry = run.entries.find((e) => e.tower_id === tower_id);
      const displaced = run.entries
        .filter((e) => e.crew_id === crew_id && e.day === day && e.tower_id !== tower_id)
        .map((e) => e.tower_id);
      const entry = buildEmergencyEntry(tower_id, crew_id, day, existingEntry, bestTower);
      offlineInsertEmergency(entry, displaced);
      setSpentTowerId(tower_id);
      setDropped(displaced);
      setConfirmed(true);
      return;
    }

    if (!runId) return;
    previewMutation.mutate(
      { run_id: runId, tower_id, target_crew_id: crew_id, target_day: day },
      {
        onSuccess: (preview) => {
          pinMutation.mutate(
            { tower_id, target_crew_id: crew_id, target_day: day, pin_reason: 'emergency' },
            {
              onSuccess: (result) => {
                setRun(result as ScheduleRun);
                setSpentTowerId(tower_id);
                setDropped(preview.dropped);
                setConfirmed(true);
              },
              onError: () => setFailed(true),
            },
          );
        },
        onError: () => setFailed(true),
      },
    );
  };

  if (confirmed) {
    return (
      <div className="p-5">
        <h3 className="eyebrow mb-2">Reserve spent</h3>
        {dropped.length === 0 ? (
          <p className="text-ui leading-relaxed text-ok-ink">
            {crew_id} is now booked for {spentTowerId ? placeName(spentTowerId) : 'the selected tower'} on {day}.
            Nothing already booked was displaced.
          </p>
        ) : (
          <>
            <p className="text-ui leading-relaxed text-fg">
              {crew_id} is now booked for {spentTowerId ? placeName(spentTowerId) : 'the selected tower'} on {day}.
            </p>
            <div className="mt-3 rounded-lg border border-watch/30 bg-watch/[0.08] p-3">
              <p className="text-micro font-medium text-watch-ink">
                This displaced work already booked — the reserve did not fully absorb it:
              </p>
              <ul className="mt-1.5 space-y-1 text-ui text-muted">
                {dropped.map((id) => (
                  <li key={id}>
                    <span className="text-fg">{placeName(id)}</span> drops to unscheduled
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="p-5">
      <div aria-hidden="true" className="mb-3 h-1.5 rounded-full" style={RESERVE_HATCH_STYLE} />
      <h3 className="eyebrow mb-2">Reserve capacity</h3>
      <p className="text-lead text-fg">{crew.name}</p>
      <p className="font-mono text-micro text-dim">
        {crew.crew_id} · {day}
      </p>

      <dl className="mt-3 space-y-2 border-t border-overlay/10 pt-3 text-ui">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Role team</dt>
          <dd className="text-fg">{team?.label ?? crew.crew_type}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Answers</dt>
          <dd className="text-right text-fg">{team?.answers ?? '—'}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Unscheduled {crew.crew_type} towers waiting</dt>
          <dd className="tnum text-fg">{matchingTowers.length}</dd>
        </div>
      </dl>

      <p className="mt-3 text-micro leading-relaxed text-dim">
        This crew-day is held free so an unplanned incident displaces nothing already booked. Ranked
        highest-risk first — pick a different waiting {crew.crew_type} tower if the top one is a poor fit.
      </p>

      {matchingTowers.length > 0 ? (
        <>
          <ul className="mt-3 space-y-1.5" role="radiogroup" aria-label={`Waiting ${crew.crew_type} towers`}>
            {visibleTowers.map((tower) => {
              const selected = tower.tower_id === selectedTowerId;
              return (
                <li key={tower.tower_id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSelectedTowerId(tower.tower_id)}
                    className={`spine flex w-full items-center justify-between gap-2 rounded-lg py-2 pl-3 pr-3 text-left transition-colors duration-150 ${
                      selected ? 'bg-accent/[0.08] ring-1 ring-accent/40' : 'glass hover:bg-overlay/[0.04]'
                    }`}
                    style={{ '--spine': bandColor(tower.decision) } as React.CSSProperties}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-ui font-medium text-fg">{placeName(tower.tower_id)}</div>
                      <div className="flex items-center gap-2 text-micro text-muted">
                        <span className="tnum" style={{ color: bandInk(tower.decision) }}>
                          {tower.risk.toFixed(2)}
                        </span>
                        <span className="truncate capitalize text-dim">{tower.dominant_factor}</span>
                      </div>
                    </div>
                    {selected && (
                      <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-micro font-medium text-accent">
                        Selected
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {matchingTowers.length > SHORTLIST_SIZE && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 text-micro font-medium text-muted hover:text-accent"
            >
              {showAll ? 'Show fewer' : `Show all ${matchingTowers.length} waiting towers`}
            </button>
          )}
        </>
      ) : (
        <p className="mt-3 text-micro text-dim">
          {typeAppearsInRun
            ? `Every ${crew.crew_type} tower due this week is already placed.`
            : (team?.emptyReason ?? `No unscheduled ${crew.crew_type} towers waiting.`)}
        </p>
      )}

      {failed && (
        <p className="mt-3 rounded-lg border border-alert/35 bg-alert/[0.09] p-3 text-micro leading-relaxed text-alert-ink">
          The request failed. The reserve was not spent and nothing on the board changed. Try again.
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button tone="primary" disabled={!bestTower || spending} onClick={handleSpend}>
          {spending ? 'Spending…' : 'Spend this reserve'}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
