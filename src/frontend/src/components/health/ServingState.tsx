import { Panel, Stat } from '../ui/Panel';
import type { ModelServing } from '../../api/types';

/**
 * What this backend process is serving right now.
 *
 * Distinct from the report above, which describes a training run. The two can
 * legitimately disagree — a checkout with no trained artifact serves the
 * physical index against a report describing the model — and `source` is the
 * only place that says which you are looking at.
 *
 * The unavailable counts are counts, not coverage percentages. "20 towers could
 * not be measured" is the fact a planner needs; "98.3% coverage" hides it.
 */
export function ServingState({ serving }: { serving: ModelServing }) {
  const bands = ['maintain', 'watch', 'ok'] as const;
  return (
    <Panel
      title="Serving now"
      footnote={
        serving.source === 'model'
          ? 'A trained artifact was found, so the supervised scorer is serving.'
          : 'No trained artifact found — the physical noisy-OR index is serving, and the report above describes a model that is not in use.'
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Source" value={serving.source === 'model' ? 'supervised model' : 'physical index'} />
        <Stat label="Towers scored" value={String(serving.towers)} />
        <Stat
          label="Moved up by ensemble"
          value={String(serving.escalated)}
          hint={`condition ${serving.blend_weight}, change ${serving.change_weight}`}
        />
        <Stat
          label="Rank stability"
          value={serving.stability ? serving.stability.rho_mean.toFixed(2) : '—'}
          hint={
            serving.stability
              ? `${serving.stability.draws} perturbed-weight draws`
              : 'not measured — the model has no AHP weights to perturb'
          }
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {bands.map((band) => (
          <Stat key={band} label={band} value={String(serving.bands[band] ?? 0)} />
        ))}
      </div>

      <dl className="mt-4 space-y-1.5 border-t border-overlay/10 pt-3 text-xs">
        {[
          ['Environment novelty unavailable', serving.novelty_unavailable,
            'incomplete feature row, or scikit-learn absent'],
          ['Site condition unavailable', serving.condition_unavailable,
            'no telemetry row for this tower'],
          ['Satellite change unavailable', serving.change_unavailable,
            'no usable pair of EVI windows for this tower'],
          ['Carrying a context flag', serving.flagged,
            'crew reach, evidence completeness, live weather coupling'],
        ].map(([label, value, hint]) => (
          <div key={String(label)} className="flex items-baseline justify-between gap-3">
            <dt className="text-dim">
              {label}
              <span className="ml-2 text-[10px] italic text-muted">{hint}</span>
            </dt>
            <dd className="tnum shrink-0 font-mono text-fg/85">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
