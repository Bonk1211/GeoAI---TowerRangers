import { useMutation } from '@tanstack/react-query';
import { scoreTowers, type ScoreBounds } from '../../api/client';
import { bandCounts } from '../../lib/aggregate';
import { useMapInstance } from '../../state/useMapInstance';
import { useWeights } from '../../state/useWeights';

/**
 * Re-score the real towers inside the current map viewport.
 *
 * The viewport is already a rectangle and MapLibre publishes its bounds, so a
 * drawing library would only duplicate a selection primitive the map provides.
 * The backend applies the bounding box before recomputing risk and band edges.
 */

export function AoiModule() {
  const view = useMapInstance((s) => s.view);
  const weights = useWeights((s) => s.weights);
  const score = useMutation({
    mutationFn: (bbox: ScoreBounds) => scoreTowers(weights, bbox),
  });
  const summary = score.data
    ? { total: score.data.length, ...bandCounts(score.data) }
    : null;
  const bounds: ScoreBounds | null = view
    ? [view.west, view.south, view.east, view.north]
    : null;

  return (
    <section className="glass-float rounded-xl p-[13px]">
      <h2 className="eyebrow mb-2.5">Area of interest</h2>

      <div className="rounded-[9px] border border-overlay/[0.11] bg-overlay/[0.04] px-2.5 py-2">
        <p className="text-micro text-muted">Current map view</p>
        <p className="mt-1 font-mono text-eyebrow text-dim">
          {view
            ? `${view.west.toFixed(2)}, ${view.south.toFixed(2)} → ${view.east.toFixed(2)}, ${view.north.toFixed(2)}`
            : 'Waiting for map bounds…'}
        </p>
      </div>

      <button
        type="button"
        disabled={!bounds || score.isPending}
        onClick={() => bounds && score.mutate(bounds)}
        className="mt-[9px] h-[34px] w-full rounded-[9px] bg-accent/25 text-ui font-medium text-accent disabled:cursor-not-allowed disabled:opacity-45"
      >
        {score.isPending ? 'Scoring…' : 'Score current view'}
      </button>

      <div className="mt-2.5 text-eyebrow leading-snug text-dim" aria-live="polite">
        {score.error ? (
          <p role="alert">{score.error.message}</p>
        ) : summary ? (
          summary.total === 0 ? (
            <p>No real tower records fall inside that view.</p>
          ) : (
            <p>
              {summary.total} towers rescored · {summary.maintain} maintain · {summary.watch}{' '}
              watch · {summary.ok} OK
            </p>
          )
        ) : (
          <p>Runs the current weights against real tower records inside the visible map bounds.</p>
        )}
      </div>
    </section>
  );
}
