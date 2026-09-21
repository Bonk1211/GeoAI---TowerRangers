import { useMemo, useState } from 'react';
import { CREWS } from '../../fixtures/crews';
import { placeName } from '../../fixtures/schedule';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { buildEmergencyEntry } from '../../lib/overridePreview';
import { crewTypeForFactor } from '../../lib/actions';
import { haversineKm } from '../../lib/geo';
import { RESERVE_HATCH_STYLE } from '../../lib/reserveHatch';
import { useCrewsQuery, usePinOverride } from '../../api/queries';
import { Button } from '../ui/Panel';
import type { ScheduleRun } from '../../api/types';

interface EmergencyPanelProps {
  tower_id: string;
  day: string;
  onDone: () => void;
}

export function EmergencyPanel({ tower_id, day, onDone }: EmergencyPanelProps) {
  const run = useScheduleStore((s) => s.run);
  const runId = useScheduleStore((s) => s.runId);
  const offlineRun = useScheduleStore((s) => s.offlineRun);
  const offlineInsertEmergency = useScheduleStore((s) => s.offlineInsertEmergency);
  const setRun = useScheduleStore((s) => s.setRun);
  const territory = useScheduleStore((s) => s.territory);
  const offline = offlineRun !== null;
  const crewsQuery = useCrewsQuery();
  const pinMutation = usePinOverride(runId);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const tower = towers.find((t) => t.tower_id === tower_id);

  const nearestCrew = useMemo(() => {
    const crews = (crewsQuery.data ?? CREWS).filter((c) => c.territory === territory);
    if (!tower) return crews[0];
    const wantedType = crewTypeForFactor(tower.dominant_factor);
    const byDistance = [...crews].sort((a, b) => haversineKm(a.depot, tower) - haversineKm(b.depot, tower));
    return byDistance.find((c) => c.crew_type === wantedType) ?? byDistance[0];
  }, [tower, crewsQuery.data, territory]);

  const [confirmed, setConfirmed] = useState(false);
  // Declared with the other hooks, above the no-crew early return — a hook
  // after a conditional return breaks the hook order on the very first render
  // that takes it.
  const [spentReserve, setSpentReserve] = useState(false);
  // What the re-solve ACTUALLY dropped, read off the returned run rather
  // than assumed from the pre-pin forecast below. /schedule/pin re-solves,
  // and a bumped job is more often re-placed on another crew-day than
  // dropped — reporting the forecast as the outcome corrupts the exact
  // contrast this feature exists to make.
  const [droppedIds, setDroppedIds] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  // territory is now a mutable store field, not the literal 'Selangor' —
  // enabling a territory with no crew roster (or crews query still loading)
  // makes nearestCrew genuinely undefined, not just typed that way, so this
  // must return before anything below dereferences it. Same pattern as
  // WorkQueue.tsx's routeToOperator guard.
  if (!nearestCrew) {
    return (
      <div className="p-5">
        <h3 className="eyebrow mb-2 text-alert-ink">No crew available</h3>
        <p className="text-ui leading-relaxed text-dim">
          No crew is available in {territory} to dispatch to {placeName(tower_id)}.
        </p>
        <div className="mt-4">
          <Button onClick={onDone}>Cancel</Button>
        </div>
      </div>
    );
  }

  // A dispatch needs a real day. `day` comes from a Selection, and a
  // selection made before /schedule ever loaded a run used to carry '' —
  // the horizon was empty, so there was no day to resolve. Posting that
  // gives the backend date.fromisoformat('') — a 500, and a button that
  // never works again. Refuse to offer the dispatch instead, and say why.
  const dayIsPlannable = day !== '' && run.horizon.includes(day);
  if (!dayIsPlannable) {
    return (
      <div className="p-5">
        <h3 className="eyebrow mb-2 text-muted">Dispatch unavailable</h3>
        <p className="text-ui leading-relaxed text-dim">
          {day === ''
            ? 'No day was resolved for this dispatch, so there is no crew-day to schedule it against. Pick a day on the board and dispatch from there.'
            : `${day} is outside the current planning horizon, so no crew-day exists to dispatch into. Pick a day on the board.`}
        </p>
        <div className="mt-4">
          <Button onClick={onDone}>Close</Button>
        </div>
      </div>
    );
  }

  const existingEntry = run.entries.find((e) => e.tower_id === tower_id);
  // A forecast, not an outcome: the jobs currently sitting on the crew-day
  // about to be taken. The re-solve decides what actually happens to them.
  const displaced = run.entries.filter(
    (e) => e.crew_id === nearestCrew.crew_id && e.day === day && e.tower_id !== tower_id,
  );
  // The reserve's whole argument is that an unplanned job costs no planned
  // one, and that argument is only made if the panel SAYS so. Silence here
  // reads as wasted capacity. run.reserve drops the slot once it is spent,
  // so this has to be read before the dispatch and carried into the
  // confirmation rather than re-derived from the returned run.
  const spendsReserve = run.reserve.some(
    (r) => r.crew_id === nearestCrew.crew_id && r.day === day,
  );

  const handleDispatch = () => {
    setFailed(false);
    if (offline) {
      const entry = buildEmergencyEntry(tower_id, nearestCrew.crew_id, day, existingEntry, tower);
      offlineInsertEmergency(
        entry,
        displaced.map((d) => d.tower_id),
      );
      setSpentReserve(spendsReserve);
      // The offline store applies exactly the displacement it is handed, so
      // on this path the forecast IS the outcome.
      setDroppedIds(displaced.map((d) => d.tower_id));
      setConfirmed(true);
      return;
    }
    if (!runId) return;
    // Route through /schedule/pin (honors target_day) rather than
    // /schedule/emergency (always forces into "today" per Backend_Handoff
    // §5 — correct for a genuine now-dispatch, wrong for a planner picking
    // a specific day off the grid, which is what this panel is used for).
    pinMutation.mutate(
      { tower_id, target_crew_id: nearestCrew.crew_id, target_day: day, pin_reason: 'emergency' },
      {
        onSuccess: (result) => {
          const next = result as ScheduleRun;
          // The honest displacement figure: towers that were scheduled
          // before the pin and are unscheduled after it. Anything the
          // re-solve re-placed on another crew-day never appears here.
          const before = new Set(run.unscheduled);
          setDroppedIds(next.unscheduled.filter((id) => !before.has(id) && id !== tower_id));
          setRun(next);
          setSpentReserve(spendsReserve);
          setConfirmed(true);
        },
        onError: () => setFailed(true),
      },
    );
  };

  if (confirmed) {
    return (
      <div className="p-5">
        <h3 className="eyebrow mb-2">Crew dispatched</h3>
        <p className="text-ui leading-relaxed text-ok-ink">
          {nearestCrew.crew_id} is on the way to {placeName(tower_id)}.
        </p>
        {droppedIds.length > 0 ? (
          <div className="mt-3 rounded-lg border border-watch/30 bg-watch/[0.08] p-3">
            <p className="text-micro font-medium text-watch-ink">
              {droppedIds.length === 1 ? 'One booked job' : `${droppedIds.length} booked jobs`} dropped to
              unscheduled:
            </p>
            <ul className="mt-1.5 space-y-1 text-ui text-muted">
              {droppedIds.map((id) => (
                <li key={id}>
                  <span className="text-fg">{placeName(id)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-1.5 text-micro leading-relaxed text-muted">
            {spentReserve
              ? 'Absorbed by a reserve crew-day — nothing already booked was dropped.'
              : 'Nothing already booked was dropped.'}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="spine p-5" style={{ '--spine': 'var(--color-alert)' } as React.CSSProperties}>
      <h3 className="eyebrow mb-2 text-alert-ink">Dispatch a crew now</h3>
      <p className="text-lead text-fg">{placeName(tower_id)}</p>
      <p className="font-mono text-micro text-dim">{tower_id}</p>

      <dl className="mt-3 space-y-2 border-t border-overlay/10 pt-3 text-ui">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Nearest {nearestCrew.crew_type} crew</dt>
          <dd className="text-fg">{nearestCrew.crew_id}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Available that day</dt>
          <dd className="tnum text-fg">
            {nearestCrew.members.length - (displaced.length > 0 ? 1 : 0)} of {nearestCrew.members.length}
          </dd>
        </div>
      </dl>

      {displaced.length === 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-overlay/12 bg-overlay/[0.04] p-3">
          {spendsReserve && (
            <span
              aria-hidden="true"
              className="mt-0.5 h-3 w-3 shrink-0 rounded-sm border border-overlay/20"
              style={RESERVE_HATCH_STYLE}
            />
          )}
          <p className="text-micro leading-relaxed text-muted">
            {spendsReserve
              ? 'This spends a reserve crew-day, so nothing already booked should move.'
              : 'Nothing is booked on this crew-day, so nothing should move.'}
          </p>
        </div>
      )}

      {displaced.length > 0 && (
        <div className="mt-3 rounded-lg border border-watch/30 bg-watch/[0.08] p-3">
          <p className="text-micro font-medium text-watch-ink">
            This takes a crew-day that is already booked:
          </p>
          <ul className="mt-1.5 space-y-1 text-ui text-muted">
            {displaced.map((d) => (
              <li key={d.tower_id}>
                <span className="text-fg">{placeName(d.tower_id)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-micro leading-relaxed text-muted">
            Dispatching re-solves the week, so some of this may be re-placed rather than dropped. The
            confirmation reports what actually happened.
          </p>
        </div>
      )}

      {failed && (
        <p className="mt-3 rounded-lg border border-alert/35 bg-alert/[0.09] p-3 text-micro leading-relaxed text-alert-ink">
          The dispatch request failed. Nothing changed — the schedule is exactly as it was. Try again.
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button tone="danger" onClick={handleDispatch} disabled={pinMutation.isPending}>
          {pinMutation.isPending ? 'Dispatching…' : `Dispatch ${nearestCrew.crew_id}`}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
