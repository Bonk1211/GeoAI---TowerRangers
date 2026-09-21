import { create } from 'zustand';
import type { MitigationMap } from '../lib/protection';

/**
 * Session-only record of which towers carry MODELLED protection.
 *
 * DEMO SURFACE. Deliberately not persisted, deliberately never sent anywhere.
 *
 * Three properties are load-bearing, and each one is a rule rather than a
 * preference:
 *
 * 1. NO PERSISTence. No localStorage, no URL param, no query cache. A reload
 *    returns the map to what the backend actually serves. A modelled score
 *    that survived a refresh would eventually be read as a real one — by a
 *    judge, or by whoever opens the laptop next.
 *
 * 2. NO BACKEND. Nothing here reaches `POST /score`, `/schedule/*` or the
 *    ticket store. Protection is a hypothetical about the GROUND; dispatching
 *    against it would put a crew on a work order for works that were never
 *    carried out.
 *
 * 3. VISIBLE WHENEVER NON-EMPTY. `ProtectionBanner` renders off `count`, the
 *    same contract `OfflineBanner` keeps with `useOffline`. The map must never
 *    quietly show modelled scores — a demo narrated as live while showing a
 *    hypothetical is the same failure class as a silent fixture fallback, and
 *    this app already has a rule about that one.
 */
/**
 * The transcript currently playing, or null.
 *
 * A run is held in its own field rather than written straight into `applied`
 * because the map must NOT move until the transcript finishes — that ordering
 * is the point of the console. Carrying the chosen mitigation here (rather
 * than reading it back out of `applied`) is what keeps the two states
 * disjoint: nothing is in `applied` until it has been committed, so a tower
 * can never be half-protected.
 */
interface ProtectionRun {
  towerId: string;
  mitigationId: string;
}

interface MitigationState {
  /** tower_id -> mitigation id. Committed only. */
  applied: MitigationMap;
  running: ProtectionRun | null;
  /** Begin a transcript. Commits nothing. */
  start: (towerId: string, mitigationId: string) => void;
  /** Commit the run in flight, if it is still the one that started. */
  commit: (towerId: string, mitigationId: string) => void;
  /** Abandon the run without committing. */
  cancel: () => void;
  remove: (towerId: string) => void;
  reset: () => void;
}

export const useMitigations = create<MitigationState>((set) => ({
  applied: {},
  running: null,
  start: (towerId, mitigationId) => set({ running: { towerId, mitigationId } }),
  commit: (towerId, mitigationId) =>
    set((s) => {
      // Guard against a stale timer from an abandoned run landing on top of a
      // newer one: a fast operator can cancel and restart inside one interval.
      if (!s.running || s.running.towerId !== towerId) return s;
      return { applied: { ...s.applied, [towerId]: mitigationId }, running: null };
    }),
  cancel: () => set({ running: null }),
  remove: (towerId) =>
    set((s) => {
      const next = { ...s.applied };
      delete next[towerId];
      return { applied: next };
    }),
  reset: () => set({ applied: {}, running: null }),
}));
