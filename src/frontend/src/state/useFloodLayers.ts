import { create } from 'zustand';

/**
 * Which flood overlays are drawn, at what opacity, for which date.
 *
 * Latest mode follows each layer's newest saved imagery and labels its date.
 * Selecting a historical date applies the same cutoff to every dated layer.
 *
 * Everything starts off. These layers tint the ground the band colours are read
 * against, and an overlay you have to notice and switch off is worse than one
 * you switch on deliberately — the same argument as useFloodSurface.
 */
interface FloodLayersState {
  /** Layer ids currently drawn, in catalogue order. */
  active: string[];
  /** Per-layer opacity, 0–1. Absent means the default. */
  opacity: Record<string, number>;
  /** YYYY-MM-DD applied to every dated layer. */
  date: string;
  followLatest: boolean;
  /** Sensor used by layers that expose a source choice. */
  sensor: string;
  /** Which accordion section is expanded; only one at a time. */
  expanded: string | null;
  toggleLayer: (layerId: string) => void;
  setOpacity: (layerId: string, value: number) => void;
  setDate: (date: string) => void;
  useLatest: () => void;
  syncLatestDate: (savedDate: string | undefined) => void;
  setSensor: (sensor: string) => void;
  setExpanded: (layerId: string | null) => void;
}

export const DEFAULT_LAYER_OPACITY = 0.75;

/**
 * Default date.
 *
 * UTC today is the fallback for an empty cache. Latest mode follows the date
 * reported by the backend until the user chooses a historical date.
 */
export const DEFAULT_FLOOD_DATE = new Date().toISOString().slice(0, 10);

export const useFloodLayers = create<FloodLayersState>((set) => ({
  active: [],
  opacity: {},
  date: DEFAULT_FLOOD_DATE,
  followLatest: true,
  sensor: 'sentinel-1',
  expanded: null,
  toggleLayer: (layerId) =>
    set((s) => ({
      active: s.active.includes(layerId)
        ? s.active.filter((id) => id !== layerId)
        : [...s.active, layerId],
    })),
  setOpacity: (layerId, value) => set((s) => ({ opacity: { ...s.opacity, [layerId]: value } })),
  setDate: (date) => set({ date, followLatest: false }),
  useLatest: () => set({ followLatest: true }),
  syncLatestDate: (savedDate) => set((s) =>
    savedDate && s.followLatest && savedDate !== s.date ? { date: savedDate } : s),
  setSensor: (sensor) => set({ sensor }),
  setExpanded: (layerId) => set((s) => ({ expanded: s.expanded === layerId ? null : layerId })),
}));
