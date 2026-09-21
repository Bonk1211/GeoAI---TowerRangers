/** One job the re-solve moved to make room — a different day, a different
 * crew, or both. This IS the compensation story: the answer to "what did
 * approving the emergency cost the rest of the plan". */
export interface DispatchMove {
  tower_id: string;
  from: string; // ISO day it left
  to: string; // ISO day it landed on
  from_crew_id: string; // who had it before
  to_crew_id: string; // who has it now — same crew_id when only the day changed
}

/**
 * Display-only description of what one approved dispatch did to the board.
 * Derived entirely from the pre-pin run and the run /schedule/pin returned —
 * it never carries anything the solver did not actually do.
 */
export interface DispatchAnimation {
  moves: DispatchMove[];
  emergency: { tower_id: string; day: string };
  /** Bumped to replay the same sequence. */
  token: number;
}

export const SLIDE_MS = 400;
export const STAGGER_MS = 150;
export const LAND_MS = 250;

/**
 * Delay, in seconds, before the Nth compensating move starts its travel.
 * Moves ripple one after another rather than firing at once — a re-solve
 * that bumped three jobs should read as three separate decisions, not one
 * simultaneous shuffle.
 */
export function moveDelaySec(index: number): number {
  return (index * STAGGER_MS) / 1000;
}

/**
 * Delay, in seconds, before the emergency's own cell reveals itself — after
 * the last compensating move has finished travelling, so the sequence reads
 * as "room was made, then it landed" rather than everything happening at
 * once.
 */
export function emergencyDelaySec(moveCount: number): number {
  if (moveCount === 0) return 0;
  return (moveDelaySec(moveCount - 1) * 1000 + SLIDE_MS) / 1000;
}
