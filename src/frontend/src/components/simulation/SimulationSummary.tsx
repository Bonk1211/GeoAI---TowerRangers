import { useEffect, useRef, useState } from 'react';
import { useSimulation } from '../../state/useSimulation';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useWeights } from '../../state/useWeights';
import { computeFlaggedVsHit, timeToResponseHours } from '../../lib/simulationSummary';
import { beatById } from '../../lib/simulationTimeline';
import * as client from '../../api/client';
import type { BaselineComparison } from '../../api/types';

/**
 * The single baseline-comparison sentence, per spec §16's suggested
 * framing: "nearest-first would have reached these towers j days later."
 * `mean_days_to_service_top_decile` is the sharper, literal number for
 * that claim; `risk_weighted_wait_reduction_pct` is kept as a fallback
 * only when the day figure isn't available on either policy (both are
 * `number | null` per `PolicyResult` — a run can genuinely have no
 * top-decile towers to measure).
 */
function BaselineLine({ baseline }: { baseline: BaselineComparison }) {
  // /schedule/baseline takes no run_id — it is a standalone benchmark over
  // the current national population, not a re-run of THIS simulation's
  // optimize call. "than the optimizer actually used" would misrepresent
  // it as scoped to the run just watched; every phrasing below stays
  // general ("the standing benchmark") rather than implying otherwise.
  const greedyDays = baseline.greedy.mean_days_to_service_top_decile;
  const nfDays = baseline.nearest_first.mean_days_to_service_top_decile;
  if (greedyDays !== null && nfDays !== null) {
    const deltaDays = nfDays - greedyDays;
    if (deltaDays > 0) {
      return (
        <span>
          In the standing national benchmark, nearest-first dispatch reaches the
          highest-risk towers <span className="font-mono tnum text-fg">{deltaDays.toFixed(1)}</span>{' '}
          days later, on average, than the greedy optimizer.
        </span>
      );
    }
  }
  return (
    <span>
      In the standing national benchmark, the greedy optimizer reduces risk-weighted
      wait by{' '}
      <span className="font-mono tnum text-fg">
        {baseline.risk_weighted_wait_reduction_pct.toFixed(1)}%
      </span>{' '}
      compared to a nearest-first dispatcher, run through the same constraints.
    </span>
  );
}

/**
 * Closing summary. `docs/Disaster_Simulation_Spec.md` §6 "Summary panel at
 * end" — "Not a victory screen — a comparison." Renders only once the run
 * reaches `done`; nothing before that, since a mid-run summary would be
 * describing a scenario that hasn't finished happening.
 */
export function SimulationSummary() {
  const status = useSimulation((s) => s.status);
  const runSeq = useSimulation((s) => s.runSeq);
  const downTowerIds = useSimulation((s) => s.downTowerIds);
  const optimizeRun = useSimulation((s) => s.optimizeRun);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);

  const [baseline, setBaseline] = useState<BaselineComparison | null>(null);
  const [baselineFailed, setBaselineFailed] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (status !== 'done' || fetchedRef.current) return;
    fetchedRef.current = true;
    (async () => {
      try {
        const result = await client.getScheduleBaseline();
        setBaseline(result);
      } catch {
        setBaselineFailed(true);
      }
    })();
  }, [status]);

  // Keyed on runSeq, not status === 'idle': a replay from 'done' goes
  // straight to 'running' (see useSimulationBackendBeats.ts's identical
  // fix), so a status-keyed reset here would leave fetchedRef stuck
  // "already fetched" and show the first run's baseline figures — or a
  // stale "unavailable" — on every subsequent run.
  useEffect(() => {
    fetchedRef.current = false;
    setBaseline(null);
    setBaselineFailed(false);
  }, [runSeq]);

  if (status !== 'done') return null;

  const sabahTowerIds = new Set(towers.filter((t) => t.territory === 'Sabah').map((t) => t.tower_id));
  const summary = computeFlaggedVsHit(optimizeRun, downTowerIds, sabahTowerIds);

  const towerDownBeat = beatById('tower-down');
  const dispatchBeat = beatById('generator-dispatch');
  const responseHours =
    towerDownBeat && dispatchBeat
      ? timeToResponseHours(towerDownBeat.clockLabel, dispatchBeat.clockLabel)
      : null;

  const diverges = summary.hitButNotFlagged.length > 0;

  return (
    <section
      className="shrink-0 rounded-xl border border-overlay/10 bg-overlay/[0.03] p-3"
      aria-label="Scenario summary"
      aria-live="polite"
    >
      <h2 className="eyebrow mb-2">Summary</h2>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-ui">
        <div>
          <dt className="text-micro text-dim">National orders</dt>
          <dd className="font-mono tnum text-fg">{summary.nationalOrderCount}</dd>
        </div>
        <div>
          <dt className="text-micro text-dim">In Sabah</dt>
          <dd className="font-mono tnum text-fg">{summary.sabahOrderCount}</dd>
        </div>
        <div>
          <dt className="text-micro text-dim">Flagged &amp; hit</dt>
          <dd className="font-mono tnum text-fg">{summary.bothFlaggedAndHit.length}</dd>
        </div>
        <div>
          <dt className="text-micro text-dim">Time to response</dt>
          <dd className="font-mono tnum text-fg">
            {responseHours !== null ? `${responseHours}h` : '—'}
          </dd>
        </div>
      </dl>

      {/* The divergence line — spec §6: "If the flagged set and the hit set
          diverge, show that too; a demo that can only succeed is not
          evidence of anything." Rendered whenever it's true, never hidden. */}
      {diverges && (
        <p className="mt-2.5 rounded-md border border-overlay/20 bg-overlay/[0.05] px-2.5 py-2 text-micro leading-snug text-muted">
          {summary.hitButNotFlagged.length} of {summary.hitTowerIds.length} towers this
          scenario hit were <strong className="text-fg">not</strong> in the national
          maintain-band run — the risk index had not already prioritised every site the
          flood struck.
        </p>
      )}
      {!diverges && summary.hitTowerIds.length > 0 && (
        <p className="mt-2.5 text-micro leading-snug text-dim">
          Every tower this scenario hit was already in the national maintain-band run
          before the flood arrived — expected here, since the scenario selects its
          down towers from the highest flood-exposure sites already in that run, not
          independently of it.
        </p>
      )}
      {summary.hitTowerIds.length === 0 && (
        <p className="mt-2.5 text-micro leading-snug text-dim">
          No down towers were selected for this run.
        </p>
      )}

      <div className="mt-2.5 border-t border-overlay/[0.09] pt-2 text-micro leading-snug text-dim">
        {baseline ? (
          <BaselineLine baseline={baseline} />
        ) : baselineFailed ? (
          <span>Baseline comparison unavailable — the request to /schedule/baseline failed.</span>
        ) : (
          <span>Loading baseline comparison…</span>
        )}
      </div>
    </section>
  );
}
