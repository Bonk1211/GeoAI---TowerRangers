import { create } from 'zustand';
import type { Decision } from '../api/types';

/**
 * The two map filters, in one store because they compose: band and area are
 * ANDed on the tower layers, so a component that changes one has to be able to
 * read the other to rebuild the combined expression.
 *
 * `areaFilter` is a territory string rather than a bounding box. The console
 * already has a geometric area control — AoiModule sends the live viewport to
 * POST /score, which re-scores and re-cuts the decision bands for that extent.
 * This one is different in kind and deliberately so: it hides towers outside a
 * named state without touching the scoring, so the bands keep their national
 * meaning while you look at one territory. Territory is also the key the
 * optimizer matches crews on, which makes it the area unit a planner already
 * thinks in.
 */
interface MapFilterState {
  bandFilter: Decision | null;
  areaFilter: string | null;
  setBandFilter: (band: Decision | null) => void;
  toggleBandFilter: (band: Decision) => void;
  setAreaFilter: (area: string | null) => void;
  toggleAreaFilter: (area: string) => void;
  clearFilters: () => void;
}

export const useMapFilter = create<MapFilterState>((set, get) => ({
  bandFilter: null,
  areaFilter: null,
  setBandFilter: (band) => set({ bandFilter: band }),
  toggleBandFilter: (band) => set({ bandFilter: get().bandFilter === band ? null : band }),
  setAreaFilter: (area) => set({ areaFilter: area }),
  toggleAreaFilter: (area) => set({ areaFilter: get().areaFilter === area ? null : area }),
  clearFilters: () => set({ bandFilter: null, areaFilter: null }),
}));
