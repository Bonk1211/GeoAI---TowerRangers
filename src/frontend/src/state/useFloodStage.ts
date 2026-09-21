import { create } from 'zustand';

/**
 * The flood stage the console is showing, in metres above nearest drainage, or
 * null for none.
 *
 * Null by default, for the same reason the hex surface is off by default: it
 * tints the ground the band colours are read against, so it should be something
 * you switch on to ask a question rather than something you have to notice and
 * switch off.
 *
 * Null rather than 0 because 0 is a real reading on this scale — a great many
 * sites in this AOI sit within a few centimetres of drainage level. "No
 * scenario selected" and "water at drainage level" are different states and
 * must not collapse into one falsy value.
 *
 * Separate from useFloodSurface: two overlays, two lifecycles. One paints
 * attribution share per cell, this one paints ground.
 */
interface FloodStageState {
  stage: number | null;
  tileError: string | null;
  setStage: (stage: number | null) => void;
  setTileError: (error: string | null) => void;
}

export const useFloodStage = create<FloodStageState>((set) => ({
  stage: null,
  tileError: null,
  setStage: (stage) => set({ stage }),
  setTileError: (tileError) => set({ tileError }),
}));
