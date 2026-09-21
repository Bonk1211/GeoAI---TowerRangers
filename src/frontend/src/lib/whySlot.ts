import type { ScheduleEntry, ScheduleRun, WhySlot } from '../api/types';
import { CREWS } from '../fixtures/crews';
import { placeName } from '../fixtures/schedule';

// Deterministic, derived from solver-adjacent state — no LLM in this path.
export function computeWhySlot(entry: ScheduleEntry, run: ScheduleRun): WhySlot {
  const crew = CREWS.find((c) => c.crew_id === entry.crew_id);
  const reasons: string[] = [];

  if (crew) {
    reasons.push(`earliest ${crew.crew_type} slot within ${crew.max_travel_km} km of ${crew.depot.name}`);
  }

  const sameDayJobs = run.entries.filter((e) => e.crew_id === entry.crew_id && e.day < entry.day);
  const busiestDay = sameDayJobs.reduce<Record<string, number>>((acc, e) => {
    acc[e.day] = (acc[e.day] ?? 0) + 1;
    return acc;
  }, {});
  const fullDay = Object.entries(busiestDay).find(([, count]) => count >= 2);
  if (fullDay) {
    reasons.push(`${fullDay[0]} full (${fullDay[1]} jobs)`);
  }

  if (entry.pinned) {
    reasons.unshift(entry.pin_reason === 'emergency' ? 'emergency override — forced insertion' : 'planner pinned this slot');
  }

  return {
    tower_id: entry.tower_id,
    crew_id: entry.crew_id,
    day: entry.day,
    reasons,
  };
}

export function whySlotHeader(entry: ScheduleEntry) {
  return `${placeName(entry.tower_id)} · ${entry.tower_id}`;
}
