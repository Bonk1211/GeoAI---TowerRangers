import { actionForFactor } from './actions';
import type { OverridePreview, ScheduleEntry, ScheduleRun, Tower } from '../api/types';

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

// Client-side stand-in for POST /schedule/preview — no mutation, just the
// knock-on cost of moving one entry to a new crew/day.
export function previewMove(run: ScheduleRun, tower_id: string, newCrewId: string, newDay: string): OverridePreview {
  const entry = run.entries.find((e) => e.tower_id === tower_id);
  const moved: OverridePreview['moved'] = [];
  const dropped: string[] = [];

  if (entry) {
    moved.push({ tower_id, from: entry.day, to: newDay, delta_days: daysBetween(entry.day, newDay) });

    // Anything already sitting in the destination crew/day slips by one day,
    // cascading until it lands on a free day or falls off the week.
    const displacedFromSlot = run.entries.find(
      (e) => e.tower_id !== tower_id && e.crew_id === newCrewId && e.day === newDay,
    );
    if (displacedFromSlot) {
      const nextDay = new Date(new Date(newDay).getTime() + 86_400_000).toISOString().slice(0, 10);
      const stillOccupied = run.entries.some(
        (e) => e.tower_id !== tower_id && e.crew_id === newCrewId && e.day === nextDay,
      );
      if (stillOccupied) {
        dropped.push(displacedFromSlot.tower_id);
      } else {
        moved.push({
          tower_id: displacedFromSlot.tower_id,
          from: displacedFromSlot.day,
          to: nextDay,
          delta_days: 1,
        });
      }
    }
  }

  const before = run.risk_weighted_wait;
  const deltaFactor = 1 + moved.reduce((sum, m) => sum + Math.abs(m.delta_days), 0) * 0.02 + dropped.length * 0.05;
  const after = Number((before * deltaFactor).toFixed(2));

  return {
    moved,
    dropped,
    risk_weighted_wait_before: before,
    risk_weighted_wait_after: after,
  };
}

export function buildEmergencyEntry(
  tower_id: string,
  crew_id: string,
  day: string,
  base: ScheduleEntry | undefined,
  tower?: Tower,
): ScheduleEntry {
  const spec = tower ? actionForFactor(tower.dominant_factor) : undefined;
  // An emergency lands at the head of the day by definition — it is the reason
  // the rest of the day moves. Giving it the first slot keeps the timeline
  // drawable offline instead of leaving an untimed bar in a timed lane.
  const durationH = base?.work_order.duration_hours ?? 3;
  const startMin = 9 * 60 + 20;
  return {
    crew_id,
    day,
    order: 1,
    tower_id,
    travel_min: 20,
    start_min: startMin,
    end_min: startMin + Math.round(durationH * 60),
    work_order: base?.work_order ?? {
      tower_id,
      action: spec?.label ?? 'Emergency assessment and stabilization',
      crew_type: spec?.crew_type ?? 'civil',
      parts: spec?.parts ?? ['field kit'],
      urgency_days: 1,
      why: 'Emergency dispatch',
    },
    pinned: true,
    pin_reason: 'emergency',
  };
}
