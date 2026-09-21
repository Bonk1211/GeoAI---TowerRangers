import { create } from 'zustand';

/**
 * Whether the flood-exposure hex surface is drawn.
 *
 * Off by default. It is an analysis overlay rather than part of the console's
 * resting state: it tints the ground the band colours are read against, so it
 * should be something you switch on to ask a question, not something you have
 * to notice and switch off.
 */
interface FloodSurfaceState {
  floodSurface: boolean;
  toggleFloodSurface: () => void;
}

export const useFloodSurface = create<FloodSurfaceState>((set) => ({
  floodSurface: false,
  toggleFloodSurface: () => set((s) => ({ floodSurface: !s.floodSurface })),
}));
