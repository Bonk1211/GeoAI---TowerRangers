import { CREWS } from '../fixtures/crews';

export interface ParsedConstraint {
  kind: 'crew_unavailable' | 'emergency' | 'unknown';
  crew_id?: string;
  day?: string;
  tower_id?: string;
  summary: string;
}

const DAY_NAMES: Record<string, string> = {
  monday: '2026-08-17',
  mon: '2026-08-17',
  tuesday: '2026-08-18',
  tue: '2026-08-18',
  wednesday: '2026-08-19',
  wed: '2026-08-19',
  thursday: '2026-08-20',
  thu: '2026-08-20',
  friday: '2026-08-21',
  fri: '2026-08-21',
};

// Deterministic, regex-based parse — a stand-in for the tool-calling agent's
// constraint extraction. Not an LLM call; the point on screen is that a
// constraint gets extracted and confirmed before anything re-solves.
export function parseConstraint(text: string): ParsedConstraint {
  const lower = text.toLowerCase();

  const crewMatch = CREWS.find((c) => lower.includes(c.crew_id.toLowerCase()));
  const dayMatch = Object.keys(DAY_NAMES).find((d) => lower.includes(d));

  if (crewMatch && /unavailable|out|off|can'?t work|sick/.test(lower)) {
    return {
      kind: 'crew_unavailable',
      crew_id: crewMatch.crew_id,
      day: dayMatch ? DAY_NAMES[dayMatch] : undefined,
      summary: `crew ${crewMatch.crew_id} unavailable${dayMatch ? ` ${dayMatch[0].toUpperCase()}${dayMatch.slice(1)} ${DAY_NAMES[dayMatch].slice(5)}` : ''}`,
    };
  }

  const towerMatch = lower.match(/\b(my_\d+|\d{4})\b/);
  if (/emergency|urgent|send someone|down/.test(lower) && towerMatch) {
    const tower_id = towerMatch[1].startsWith('my_') ? towerMatch[1].toUpperCase() : `MY_${towerMatch[1]}`;
    return {
      kind: 'emergency',
      tower_id,
      day: dayMatch ? DAY_NAMES[dayMatch] : undefined,
      summary: `emergency dispatch to ${tower_id}${dayMatch ? ` on ${dayMatch}` : ' today'}`,
    };
  }

  return { kind: 'unknown', summary: text };
}
