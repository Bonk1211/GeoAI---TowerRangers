import { create } from 'zustand';

// Set whenever any live API call falls back to fixture data (step 7). Drives
// the always-visible "offline data" banner — never fall back silently.
interface OfflineState {
  offline: boolean;
  setOffline: (offline: boolean) => void;
}

export const useOffline = create<OfflineState>((set) => ({
  offline: false,
  setOffline: (offline) => set({ offline }),
}));
