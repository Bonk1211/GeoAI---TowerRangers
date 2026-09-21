import { create } from 'zustand';
import { AHP_WEIGHTS, type WeightVector } from '../lib/scorer';

interface WeightsState {
  weights: WeightVector;
  setWeight: (factor: keyof WeightVector, value: number) => void;
  reset: () => void;
}

export const useWeights = create<WeightsState>((set) => ({
  weights: { ...AHP_WEIGHTS },
  setWeight: (factor, value) =>
    set((state) => ({ weights: { ...state.weights, [factor]: value } })),
  reset: () => set({ weights: { ...AHP_WEIGHTS } }),
}));
