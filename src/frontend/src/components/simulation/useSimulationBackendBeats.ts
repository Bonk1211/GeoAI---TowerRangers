import { useEffect, useRef } from 'react';
import { useSimulation } from '../../state/useSimulation';
import { useOffline } from '../../state/useOffline';
import * as client from '../../api/client';

// Sabah's power crew — the natural crew for a generator dispatch (power
// outage). Hardcoded rather than looked up, because the simulation's own
// emergency beat is scripted to always target Sabah's power crew; a search
// over the live crew roster for "some Sabah power crew" would only add a
// second way for this to fail silently if the roster ever loses this id.
// docs/simulation-build-log.md's pre-P0 ground check confirmed this crew
// exists in config/crews.json (2 Sabah crews: SBH-C1 civil, SBH-P1 power,
// both Kota Kinabalu depot).
const SABAH_POWER_CREW_ID = 'SBH-P1';

/**
 * Fires the Disaster Simulation's two real backend calls at the right
 * moments. `docs/Disaster_Simulation_Spec.md` §7.
 *
 * Rule 1 — prefetch, don't block: `/schedule/optimize` fires the moment
 * `status` becomes 'running', not when the clock reaches the `optimize`
 * beat. The beat itself (rendered by SimulationConsole from firedBeatIds)
 * only shows a resolved value once BOTH the clock has arrived at that beat
 * AND the promise has resolved — that gating lives in SimulationConsole's
 * render, not here; this hook only owns "when do we call the network".
 *
 * Rule 2 — a failed call degrades visibly: on error, `optimizeStatus`/
 * `emergencyStatus` become 'error' and the global offline flag is set via
 * `useOffline`, so `OfflineBanner` appears. Never a silent fixture
 * substitution.
 *
 * Rule 3 — anchor the run: the emergency call passes `run_id` from the
 * optimize run it captured, and the backend's own `_anchor(run)` (already
 * fixed server-side, per CLAUDE.md's "Fixed, recorded" section) resolves
 * `today` from that run's `horizon[0]` rather than the demo clock. This
 * hook never passes a `today` of its own to `/schedule/emergency` — it
 * relies entirely on the run_id round-trip for that.
 */
export function useSimulationBackendBeats() {
  const status = useSimulation((s) => s.status);
  const runSeq = useSimulation((s) => s.runSeq);
  const firedBeatIds = useSimulation((s) => s.firedBeatIds);
  const downTowerIds = useSimulation((s) => s.downTowerIds);
  const optimizeStatus = useSimulation((s) => s.optimizeStatus);
  const optimizeRun = useSimulation((s) => s.optimizeRun);
  const emergencyStatus = useSimulation((s) => s.emergencyStatus);
  const setOptimizeStatus = useSimulation((s) => s.setOptimizeStatus);
  const setOptimizeRun = useSimulation((s) => s.setOptimizeRun);
  const setEmergencyStatus = useSimulation((s) => s.setEmergencyStatus);
  const setEmergencyRun = useSimulation((s) => s.setEmergencyRun);
  const setOffline = useOffline((s) => s.setOffline);

  // Guards against double-firing within one run — React effects can re-run
  // on unrelated re-renders, and this hook must call each endpoint at most
  // once per Start press, not once per render where the condition holds.
  const optimizeFiredRef = useRef(false);
  const emergencyFiredRef = useRef(false);

  // Keyed on runSeq, not status === 'idle': simulationClock.play() takes
  // 'done' straight to 'running' on a replay (TransportBar routes both
  // 'idle' and 'done' to start()), so a replay never passes through
  // 'idle' and a status-keyed reset here would leave both refs stuck at
  // "already fired" forever, silently skipping both backend calls on every
  // run after the first.
  useEffect(() => {
    optimizeFiredRef.current = false;
    emergencyFiredRef.current = false;
  }, [runSeq]);

  // Rule 1: fire optimize the moment a run starts, never on the beat itself.
  //
  // Keyed on [status] but must NOT tear down and discard the in-flight call
  // on a running -> paused transition: this effect's body re-runs on every
  // status change while status is 'running' or 'paused' (both conditions
  // that keep the fetch alive), and React runs the previous cleanup before
  // that. A `cancelled` flag set by that cleanup would make the eventual
  // resolution a no-op — permanently stranding optimizeStatus at 'pending'
  // the moment a user pauses mid-round-trip, which is a silent stall, not a
  // visible degrade.
  //
  // But dropping that flag outright reopens a DIFFERENT race: a new run
  // clears optimizeFiredRef (via the runSeq-keyed effect above) so a second
  // Start can fire a second optimize call while the first is still in
  // flight, and with no guard at all the first call's LATE resolution would
  // overwrite the second run's optimizeRun — or worse, let a stale run_id
  // reach a real /schedule/emergency commit. `firedRunSeq` is captured at
  // fire time and checked against the store's CURRENT runSeq (bumped by
  // every start()/resetSim()) before either write applies, which survives
  // a pause (runSeq is unchanged) but correctly drops a superseded run's
  // result after a Reset-and-restart OR a done-to-running replay.
  //
  // `runSeq` is deliberately absent from this effect's deps array below,
  // which is only correct because `start()` bumps `runSeq` in the SAME
  // `set()` call that changes `status` to 'running' (see useSimulation.ts) —
  // so by the time this effect re-runs on the `status` transition, `runSeq`
  // in scope is already the new value. If `runSeq` is ever bumped WITHOUT
  // also changing `status` in the same store update, this capture would go
  // stale silently; keep the two coupled.
  useEffect(() => {
    // Seeking directly to the end still initializes the run's plan.
    if (status !== 'running' && status !== 'paused' && !(status === 'done' && runSeq > 0)) return;
    if (optimizeFiredRef.current || optimizeStatus !== 'idle') return;
    optimizeFiredRef.current = true;
    const firedRunSeq = runSeq;
    setOptimizeStatus('pending');

    (async () => {
      try {
        // Whole national population per spec's decisions-already-made table
        // (§ "Optimize scope"): the pre-event optimize beat calls
        // /schedule/optimize against ALL towers, and the closing summary
        // (P8) filters for the affected Sabah districts.
        const { run_id } = await client.optimizeSchedule({});
        const run = await client.getScheduleRun(run_id);
        if (useSimulation.getState().runSeq !== firedRunSeq) return;
        setOptimizeRun(run);
        setOptimizeStatus('ready');
      } catch {
        if (useSimulation.getState().runSeq !== firedRunSeq) return;
        setOptimizeStatus('error');
        setOffline(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Rule 3: fire the emergency dispatch once the generator-dispatch beat has
  // arrived AND the optimize run is ready to anchor against. If optimize
  // errored, the emergency beat degrades too (spec §7 rule 2 applies to
  // every backend beat, not only the first) — there is no run_id to anchor
  // against, so the console shows the beat as degraded rather than firing
  // a request that would silently re-anchor to the demo clock.
  //
  // Fans out to EVERY down tower (2026-09-17, operator review), not just
  // the first — the original single-tower dispatch was the FIRST thing an
  // MCMC-practice reviewer flagged reading this beat's own console line
  // ("generator dispatch -> <tower_id>"): a real flood knocks out multiple
  // sites, and MCMC's actual practice cited in
  // docs/Disaster_Response_Actions.md is to move generators fleet-wide, not
  // to one compound. Calls are sequential (`for...await`, not
  // `Promise.all`) and against the SAME `run_id` throughout: the backend's
  // `/schedule/emergency?commit=true` mutates and persists the stored run
  // in place (`api/routes/schedule.py::emergency_dispatch` re-pins only the
  // requested tower and keeps every earlier pin — verified by reading that
  // route before relying on it), so each subsequent call resolves against
  // the previous call's already-committed state, which is what lets a
  // single FINAL `ScheduleRun` end up holding every tower's emergency pin
  // rather than needing an array of separate results threaded through
  // every consumer.
  useEffect(() => {
    if (emergencyFiredRef.current || emergencyStatus !== 'idle') return;
    if (!firedBeatIds.includes('generator-dispatch')) return;
    if (optimizeStatus === 'error') {
      emergencyFiredRef.current = true;
      setEmergencyStatus('error');
      return;
    }
    if (optimizeStatus !== 'ready' || !optimizeRun) return;
    // Every down tower this run selected, not just the first — dispatch
    // order is the scenario's own Set iteration order (insertion order,
    // since `downTowerIds` is built from an array via `new Set(...)`),
    // deterministic for a given tower population.
    const towerIds = [...downTowerIds];
    if (towerIds.length === 0) {
      emergencyFiredRef.current = true;
      setEmergencyStatus('error');
      return;
    }
    emergencyFiredRef.current = true;
    const firedRunSeq = runSeq;
    setEmergencyStatus('pending');

    // No `cancelled` flag, for the same reason as the optimize effect above
    // (firedBeatIds grows every beat while this call is in flight, so a
    // cancellation flag would strand emergencyStatus at 'pending' forever).
    // The `firedRunSeq` check below guards the same Reset-mid-flight race:
    // without it, a superseded run's LATE resolution could commit a real
    // /schedule/emergency dispatch — or overwrite emergencyRun — against a
    // run_id the board has already moved on from. Checked before EVERY
    // dispatch in the loop, not just once at the end, so a Reset mid-fan-out
    // stops issuing further real commits rather than continuing to write
    // against an abandoned run_id.
    (async () => {
      let lastGoodRun: import('../../api/types').ScheduleRun | null = null;
      try {
        for (const towerId of towerIds) {
          if (useSimulation.getState().runSeq !== firedRunSeq) return;
          const result = await client.emergencyDispatch({
            run_id: optimizeRun.run_id,
            tower_id: towerId,
            crew_id: SABAH_POWER_CREW_ID,
            pinned_by: 'disaster-simulation',
            commit: true,
          });
          // commit: true always returns a ScheduleRun (has entries/horizon),
          // never an OverridePreview — but narrow defensively rather than
          // asserting the union away, since a schema drift here should
          // degrade visibly rather than throw.
          if (!('entries' in result)) {
            if (useSimulation.getState().runSeq !== firedRunSeq) return;
            setEmergencyStatus('error');
            setOffline(true);
            return;
          }
          lastGoodRun = result;
        }
        if (useSimulation.getState().runSeq !== firedRunSeq) return;
        setEmergencyRun(lastGoodRun);
        setEmergencyStatus('ready');
      } catch {
        if (useSimulation.getState().runSeq !== firedRunSeq) return;
        setEmergencyStatus('error');
        setOffline(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firedBeatIds, optimizeStatus, optimizeRun, downTowerIds]);

  // No emergencyStatus in the effect deps above beyond what's read: adding
  // it would refire on its own transition, which the emergencyFiredRef
  // guard already prevents structurally — this comment exists so a future
  // edit doesn't "fix" the lint warning by adding it back.
  void emergencyStatus;
}
