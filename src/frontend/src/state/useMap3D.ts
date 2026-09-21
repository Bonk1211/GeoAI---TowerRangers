import { create } from 'zustand';
import { DEFAULT_EXAGGERATION } from '../components/map/floodVolumeLayer';

/**
 * Whether the console is in 3D, and how hard the vertical is stretched.
 *
 * One exaggeration value drives both the terrain mesh and the water volume, on
 * purpose. Stretching them by different amounts would leave water sitting at
 * the wrong depth relative to the ground it covers — the scene would not be
 * exaggerated, it would be wrong. Scaling both keeps every vertical
 * relationship in the picture true and only changes the units they are read in.
 *
 * Off by default. The flat camera is the correct instrument for comparing
 * positions, reading coordinates and judging crew distances, which is what this
 * console is for; 3D answers a narrower question — how deep is the water here —
 * and is switched on to ask it.
 */
interface Map3DState {
  enabled: boolean;
  stacked: boolean;
  spacing: number;
  /** Camera tilt in degrees, applied when enabled. */
  pitch: number;
  /** Shared z stretch for terrain and water. */
  exaggeration: number;
  setEnabled: (enabled: boolean) => void;
  setStacked: () => void;
  setSpacing: (spacing: number) => void;
  setPitch: (pitch: number) => void;
  setExaggeration: (exaggeration: number) => void;
}

/** Enough tilt for volume to read without pushing the AOI to the horizon. */
export const DEFAULT_PITCH = 55;
export const PITCH_RANGE = { min: 0, max: 75 } as const;

export const useMap3D = create<Map3DState>((set) => ({
  enabled: false,
  stacked: false,
  spacing: 90,
  pitch: DEFAULT_PITCH,
  exaggeration: DEFAULT_EXAGGERATION,
  setEnabled: (enabled) => set({ enabled, stacked: false }),
  setStacked: () => set({ enabled: true, stacked: true }),
  setSpacing: (spacing) => set({ spacing: Math.max(40, Math.min(150, spacing)) }),
  setPitch: (pitch) => set({ pitch }),
  setExaggeration: (exaggeration) => set({ exaggeration }),
}));
