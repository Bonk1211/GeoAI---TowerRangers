import { create } from 'zustand';

interface ScheduleSelectionState {
  highlightedTowerId: string | null;
  setHighlightedTower: (id: string | null) => void;
  /**
   * Transient hover shared between the schedule grid and the route map, so
   * pointing at a cell lights its stop and vice versa.
   *
   * Kept separate from `highlightedTowerId`: that one is a navigation intent
   * (Schedule.tsx consumes it once, selects the owning cell, then clears it).
   * Reusing it for hover would fire that select-and-clear effect on every
   * pointer move across the grid.
   */
  hoveredTowerId: string | null;
  setHoveredTower: (id: string | null) => void;
}

export const useScheduleSelection = create<ScheduleSelectionState>((set) => ({
  highlightedTowerId: null,
  setHighlightedTower: (id) => set({ highlightedTowerId: id }),
  hoveredTowerId: null,
  setHoveredTower: (id) => set({ hoveredTowerId: id }),
}));
