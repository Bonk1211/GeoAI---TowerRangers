import { create } from 'zustand';

/**
 * How strongly the scored tower layer reads against the basemap.
 *
 * A separate store rather than a field on useMapFilter: filtering changes which
 * towers exist on the map and is a data question; opacity changes only how
 * loudly they are drawn and is a chrome question. Mixing them would put a
 * presentation value inside the store the map filter effect depends on.
 */
interface ScoreOpacityState {
  scoreOpacity: number;
  setScoreOpacity: (value: number) => void;
}

export const DEFAULT_SCORE_OPACITY = 0.88;

export const useScoreOpacity = create<ScoreOpacityState>((set) => ({
  scoreOpacity: DEFAULT_SCORE_OPACITY,
  setScoreOpacity: (value) => set({ scoreOpacity: Math.min(1, Math.max(0.1, value)) }),
}));
