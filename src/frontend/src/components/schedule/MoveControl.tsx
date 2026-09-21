import { useState } from 'react';
import { CREWS } from '../../fixtures/crews';
import { dayLabel } from '../../lib/scheduleDays';
import { useScheduleStore } from '../../state/useScheduleStore';
import { previewMove } from '../../lib/overridePreview';
import { placeName } from '../../fixtures/schedule';
import { usePreviewOverride, usePinOverride, useCrewsQuery } from '../../api/queries';
import { OverridePreview } from './OverridePreview';
import type { OverridePreview as OverridePreviewType } from '../../api/types';
import type { ScheduleEntry } from '../../api/types';

interface MoveControlProps {
  entry: ScheduleEntry;
}

export function MoveControl({ entry }: MoveControlProps) {
  const run = useScheduleStore((s) => s.run);
  const runId = useScheduleStore((s) => s.runId);
  const offlineRun = useScheduleStore((s) => s.offlineRun);
  const offlineMove = useScheduleStore((s) => s.offlineMove);
  const offlinePin = useScheduleStore((s) => s.offlinePin);
  const setRun = useScheduleStore((s) => s.setRun);
  const territory = useScheduleStore((s) => s.territory);
  const askAgent = useScheduleStore((s) => s.askAgent);
  const crewsQuery = useCrewsQuery();
  const previewMutation = usePreviewOverride();
  const pinMutation = usePinOverride(runId);
  const [targetCrew, setTargetCrew] = useState(entry.crew_id);
  const [targetDay, setTargetDay] = useState(entry.day);
  const [preview, setPreview] = useState<OverridePreviewType | null>(null);
  const offline = offlineRun !== null;

  const sunwayCrews = (crewsQuery.data ?? CREWS).filter((c) => c.territory === territory);

  const runPreview = (crew_id: string, day: string) => {
    if (crew_id === entry.crew_id && day === entry.day) {
      setPreview(null);
      return;
    }
    if (offline) {
      setPreview(previewMove(run, entry.tower_id, crew_id, day));
      return;
    }
    if (!runId) return;
    previewMutation.mutate(
      { run_id: runId, tower_id: entry.tower_id, target_crew_id: crew_id, target_day: day },
      { onSuccess: setPreview },
    );
  };

  const confirmMove = () => {
    if (offline) {
      offlineMove(entry.tower_id, targetCrew, targetDay);
      offlinePin(entry.tower_id, targetCrew, targetDay);
      setPreview(null);
      return;
    }
    if (!runId) return;
    pinMutation.mutate(
      { tower_id: entry.tower_id, target_crew_id: targetCrew, target_day: targetDay, pin_reason: 'planner_override' },
      {
        onSuccess: (updatedRun) => {
          setRun(updatedRun);
          setPreview(null);
        },
      },
    );
  };

  const pinInPlace = () => {
    if (offline) {
      offlinePin(entry.tower_id, entry.crew_id, entry.day);
      return;
    }
    if (!runId) return;
    pinMutation.mutate(
      { tower_id: entry.tower_id, target_crew_id: entry.crew_id, target_day: entry.day, pin_reason: 'planner_override' },
      { onSuccess: setRun },
    );
  };

  return (
    <div className="p-5">
      <h3 className="eyebrow mb-3">Move or pin this visit</h3>
      <div className="flex flex-col gap-2.5 text-ui">
        <label className="flex items-center justify-between gap-3">
          <span className="text-muted">Crew</span>
          {/* .glass-field, not an opaque fill: an ink-800 control on a frosted
              panel reads as a hole punched through it. The global
              :focus-visible ring still applies to the select itself — the
              class only carries the resting and focus-within surface. */}
          <select
            value={targetCrew}
            onChange={(e) => {
              setTargetCrew(e.target.value);
              runPreview(e.target.value, targetDay);
            }}
            className="glass-field min-h-[36px] rounded-lg px-2.5 text-fg"
          >
            {sunwayCrews.map((c) => (
              <option key={c.crew_id} value={c.crew_id}>
                {c.crew_id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-muted">Day</span>
          <select
            value={targetDay}
            onChange={(e) => {
              setTargetDay(e.target.value);
              runPreview(targetCrew, e.target.value);
            }}
            className="glass-field min-h-[36px] rounded-lg px-2.5 text-fg"
          >
            {run.horizon.map((d) => (
              <option key={d} value={d}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* The panel's one primary action, and styled as the only one: a filled
          gradient at 44px rather than the shared ghost Button, which on a
          glass surface sat at the same weight as the two selects above it and
          read as a third field. */}
      {!entry.pinned && (
        <button
          type="button"
          onClick={pinInPlace}
          className="mt-4 flex h-11 w-full items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-ui font-semibold text-white shadow-[var(--shadow-2)] transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98]"
        >
          Pin to this slot
        </button>
      )}

      {/* The contextual handoff to Ranger.

          Ranger is NOT mounted in this panel, deliberately: it re-solves the
          whole board and returns a diff spanning every tower, which has
          nowhere to live in a panel headed "Scheduled visit" — and it would
          disappear entirely whenever nothing is selected, which is when a
          planner most wants to state a constraint. What was genuinely missing
          was the path from a selected job to the agent: you decided this visit
          had to move and then retyped its crew and day from memory.

          This drafts that sentence and hands it over. It does not send it —
          see the seed handling in AgentChat for why a re-solve must not be one
          click from a selection. */}
      <button
        type="button"
        onClick={() =>
          askAgent(`crew ${entry.crew_id} unavailable ${dayLabel(entry.day)} — reschedule ${placeName(entry.tower_id)}`)
        }
        className="glass-field mt-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-xl text-ui font-medium text-muted transition-colors duration-150 hover:text-accent"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        Ask Ranger about this visit
      </button>

      {preview && (
        <div className="-mx-5 mt-4">
          <OverridePreview
            preview={preview}
            onConfirm={confirmMove}
            onCancel={() => {
              setTargetCrew(entry.crew_id);
              setTargetDay(entry.day);
              setPreview(null);
            }}
          />
        </div>
      )}
    </div>
  );
}
