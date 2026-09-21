import type { Tower, Crew, ScheduleEntry } from '../api/types';
import { actionForFactor } from './actions';

export interface WbsTask {
  code: string; // "1.1"
  name: string;
  startDay: number; // offset from plan start, inclusive
  durationDays: number;
  pic: string;
  dependsOn?: string; // wbs code
}

export interface WorkBreakdown {
  planStart: Date;
  tasks: WbsTask[];
}

// Per-crew-type phase templates. Duration in days, sequential by default —
// a plan is a fixed shape per intervention type, not a live solver output
// (the optimizer in scheduler/optimize.py owns the actual crew-day slot;
// this is the illustrative work breakdown for what happens on-site).
const PHASE_TEMPLATES: Record<string, { name: string; days: number }[]> = {
  civil: [
    { name: 'Site survey & access check', days: 1 },
    { name: 'Materials staging', days: 2 },
    { name: 'Civil works execution', days: 3 },
    { name: 'Drainage / structural QA', days: 1 },
    { name: 'Sign-off & close-out', days: 1 },
  ],
  power: [
    { name: 'Site survey & power audit', days: 1 },
    { name: 'Parts staging', days: 1 },
    { name: 'Battery / genset service', days: 2 },
    { name: 'Load test', days: 1 },
    { name: 'Sign-off & close-out', days: 1 },
  ],
  electrical: [
    { name: 'Site survey & continuity check', days: 1 },
    { name: 'Parts staging', days: 1 },
    { name: 'Surge-arrestor swap & grounding', days: 2 },
    { name: 'Ground-resistance test', days: 1 },
    { name: 'Sign-off & close-out', days: 1 },
  ],
  rf: [
    { name: 'Site survey & spares check', days: 1 },
    { name: 'Spares pre-stage', days: 2 },
    { name: 'Radio-unit refresh', days: 2 },
    { name: 'RF verification', days: 1 },
    { name: 'Sign-off & close-out', days: 1 },
  ],
};

function pic(crew: Crew | undefined, index: number): string {
  if (!crew || crew.members.length === 0) return 'Unassigned';
  return crew.members[index % crew.members.length];
}

/**
 * Builds an illustrative WBS/Gantt plan for one tower's work order. Purely
 * derived from the dominant factor and (if scheduled) the assigned crew — no
 * backend call, since this is a planning view over data already on screen,
 * not a new source of truth.
 */
export function buildWorkBreakdown(tower: Tower, crew: Crew | undefined, entry: ScheduleEntry | undefined): WorkBreakdown {
  const spec = actionForFactor(tower.dominant_factor);
  const phases = PHASE_TEMPLATES[spec.crew_type] ?? PHASE_TEMPLATES.civil;
  const planStart = entry ? new Date(entry.day) : new Date();

  let cursor = 0;
  const tasks: WbsTask[] = phases.map((phase, i) => {
    const task: WbsTask = {
      code: `1.${i + 1}`,
      name: phase.name,
      startDay: cursor,
      durationDays: phase.days,
      pic: pic(crew, i),
      dependsOn: i > 0 ? `1.${i}` : undefined,
    };
    cursor += phase.days;
    return task;
  });

  return { planStart, tasks };
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
