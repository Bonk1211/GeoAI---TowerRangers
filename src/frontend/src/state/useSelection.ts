import { create } from 'zustand';
import { DEMO_TOWER_ID } from '../fixtures/towers';

interface SelectionState {
  selectedTowerId: string | null;
  selectTower: (id: string | null) => void;
}

export const useSelection = create<SelectionState>((set) => ({
  selectedTowerId: DEMO_TOWER_ID,
  selectTower: (id) => set({ selectedTowerId: id }),
}));
