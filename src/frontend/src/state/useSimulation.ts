import { create } from 'zustand';
import * as clock from '../lib/simulationClock';
import { BEATS, TOTAL_DURATION_MS, beatsUpTo, phaseAt, type SimulationPhase } from '../lib/simulationTimeline';
import { SABAH_FLOOD_SCENARIO } from '../fixtures/scenarios/sabahFlood';
import type { ScheduleRun, Tower } from '../api/types';

/**
 * Disaster Simulation store. `docs/Disaster_Simulation_Spec.md` §11.
 *
 * P1 wired the clock and the beat table. P3 adds the §0.6 firewall fields:
 * `downTowerIds` and, later, the retuned-sector/COW records. This is the
 * ONLY place simulated scenario state lives — it is never written into a
 * `Tower` record, never sent to the backend, and never persisted. The map
 * overlay reads `downTowerIds` to decide which towers get the outage mark;
 * nothing else reads it.
 */

let rafId: number | null = null;
let lastFrameAt: number | null = null;

interface SimulationState {
  status: clock.ClockStatus;
  elapsedMs: number;
  speed: 1 | 2 | 4;
  phase: SimulationPhase;
  /** Ordered ids of every beat fired so far, oldest first. Derived from
   *  elapsedMs via beatsUpTo — kept in the store (rather than recomputed by
   *  every consumer) so SimulationConsole doesn't need to re-run the filter
   *  on every render. */
  firedBeatIds: string[];

  /**
   * The §0.6 firewall. Set once at `start()` from the scenario's
   * `downTowerSelector` run over the live Sabah population, and read by the
   * map overlay only. Never written into a `Tower` record, never sent to
   * the backend, never persisted (no localStorage, no query cache). A
   * simulated outage is a stated scenario premise, not a prediction — see
   * `docs/Disaster_Simulation_Spec.md` §0.
   */
  downTowerIds: Set<string>;

  /** Same shape as `downTowerIds` and set at the same moment in `start()`,
   *  from the scenario's `generatorSiteSelector` — the fixed pre-event
   *  generator-preposition sites (2026-09-17). Not part of the §0.6
   *  firewall's outage-premise concern (these towers are never claimed to
   *  be down), but kept alongside `downTowerIds` as a stated scenario
   *  premise rather than backend truth, for the same reason: never sent to
   *  the backend, never persisted. */
  generatorSiteIds: Set<string>;

  /**
   * Bumped by every `start()` and `resetSim()` — a monotonic identifier for
   * "which run is this". `useSimulationBackendBeats` captures it at fetch
   * time and only applies a resolved response when it still matches
   * `get().runSeq`, so a stale in-flight call from a run the user has since
   * Reset-and-restarted cannot land its result (or, worse, a real
   * `/schedule/emergency` commit) into the CURRENT run. This exists because
   * removing the effects' `cancelled` closures (to fix a pause-strands-
   * pending bug) reopened exactly that race — see
   * `docs/simulation-build-log.md`'s P4 entry.
   */
  runSeq: number;

  // Real backend results captured during the run. `docs/Disaster_Simulation_Spec.md` §7:
  // /schedule/optimize is prefetched at Start (fired from `start()`, not
  // waited on), so its ~15s of narration hides the round-trip; the
  // `optimize` beat renders once BOTH the clock has arrived and the promise
  // has resolved. A failed call degrades to 'error' rather than a silent
  // substitution — the console beat still fires, marked degraded, and the
  // caller sets the global offline flag (useOffline), never narrating a
  // fixture as live.
  optimizeStatus: 'idle' | 'pending' | 'ready' | 'error';
  optimizeRun: ScheduleRun | null;
  emergencyStatus: 'idle' | 'pending' | 'ready' | 'error';
  emergencyRun: ScheduleRun | null;
  setOptimizeStatus: (status: 'idle' | 'pending' | 'ready' | 'error') => void;
  setOptimizeRun: (run: ScheduleRun | null) => void;
  setEmergencyStatus: (status: 'idle' | 'pending' | 'ready' | 'error') => void;
  setEmergencyRun: (run: ScheduleRun | null) => void;

  /** Selects the scenario's down towers from the live population and starts
   *  the clock. `towers` is read once, at call time — the store never holds
   *  a live tower subscription. */
  start: (towers: Tower[]) => void;
  pauseSim: () => void;
  resumeSim: () => void;
  setSpeed: (speed: 1 | 2 | 4) => void;
  seekSim: (ms: number) => void;
  resetSim: () => void;
  /** Called every animation frame by the hook that drives the clock. Not
   *  meant to be called from UI code directly. */
  _tick: (deltaMs: number) => void;
}

function deriveFromElapsed(elapsedMs: number) {
  return {
    phase: phaseAt(elapsedMs),
    firedBeatIds: beatsUpTo(elapsedMs).map((b) => b.id),
  };
}

function stopLoop() {
  if (rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafId);
  }
  rafId = null;
  lastFrameAt = null;
}

export const useSimulation = create<SimulationState>((set, get) => {
  function loop(now: number) {
    if (lastFrameAt === null) lastFrameAt = now;
    const deltaMs = now - lastFrameAt;
    lastFrameAt = now;
    get()._tick(deltaMs);
    if (get().status === 'running' && typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(loop);
    } else {
      stopLoop();
    }
  }

  function ensureLoopRunning() {
    if (rafId === null && typeof requestAnimationFrame === 'function') {
      lastFrameAt = null;
      rafId = requestAnimationFrame(loop);
    }
  }

  return {
    status: 'idle',
    elapsedMs: 0,
    speed: 1,
    phase: 'pre',
    firedBeatIds: [],
    downTowerIds: new Set(),
    generatorSiteIds: new Set(),
    runSeq: 0,
    optimizeStatus: 'idle',
    optimizeRun: null,
    emergencyStatus: 'idle',
    emergencyRun: null,
    setOptimizeStatus: (status) => set({ optimizeStatus: status }),
    setOptimizeRun: (run) => set({ optimizeRun: run }),
    setEmergencyStatus: (status) => set({ emergencyStatus: status }),
    setEmergencyRun: (run) => set({ emergencyRun: run }),

    start: (towers) => {
      const c = clock.play({ status: get().status, elapsedMs: get().elapsedMs, speed: get().speed });
      const downTowerIds = new Set(SABAH_FLOOD_SCENARIO.downTowerSelector(towers));
      const generatorSiteIds = new Set(SABAH_FLOOD_SCENARIO.generatorSiteSelector(towers));
      // A replay (Play from 'done') must not carry the previous run's
      // backend results forward — the caller (useSimulationBackendBeats)
      // watches these to decide when to fire /schedule/optimize again.
      set({
        status: c.status,
        elapsedMs: c.elapsedMs,
        downTowerIds,
        generatorSiteIds,
        runSeq: get().runSeq + 1,
        optimizeStatus: 'idle',
        optimizeRun: null,
        emergencyStatus: 'idle',
        emergencyRun: null,
        ...deriveFromElapsed(c.elapsedMs),
      });
      ensureLoopRunning();
    },
    pauseSim: () => {
      const c = clock.pause({ status: get().status, elapsedMs: get().elapsedMs, speed: get().speed });
      set({ status: c.status });
    },
    resumeSim: () => {
      const c = clock.resume({ status: get().status, elapsedMs: get().elapsedMs, speed: get().speed });
      set({ status: c.status });
      ensureLoopRunning();
    },
    setSpeed: (speed) => {
      const c = clock.setSpeed({ status: get().status, elapsedMs: get().elapsedMs, speed: get().speed }, speed);
      set({ speed: c.speed });
    },
    seekSim: (ms) => {
      const c = clock.seek(
        { status: get().status, elapsedMs: get().elapsedMs, speed: get().speed },
        ms,
        TOTAL_DURATION_MS,
      );
      set({ status: c.status, elapsedMs: c.elapsedMs, ...deriveFromElapsed(c.elapsedMs) });
    },
    resetSim: () => {
      stopLoop();
      const c = clock.reset();
      set({
        status: c.status,
        elapsedMs: c.elapsedMs,
        speed: c.speed,
        ...deriveFromElapsed(c.elapsedMs),
        downTowerIds: new Set(),
        generatorSiteIds: new Set(),
        runSeq: get().runSeq + 1,
        optimizeStatus: 'idle',
        optimizeRun: null,
        emergencyStatus: 'idle',
        emergencyRun: null,
      });
    },
    _tick: (deltaMs) => {
      const c = clock.tick(
        { status: get().status, elapsedMs: get().elapsedMs, speed: get().speed },
        deltaMs,
        TOTAL_DURATION_MS,
      );
      set({ status: c.status, elapsedMs: c.elapsedMs, ...deriveFromElapsed(c.elapsedMs) });
    },
  };
});

export { BEATS };
