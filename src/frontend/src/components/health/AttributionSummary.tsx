import { Panel } from '../ui/Panel';
import type { ModelReport } from '../../api/types';

/**
 * Mean SHAP share per factor and how many towers each one leads.
 *
 * Bars are neutral, not band-coloured: these are attribution shares, not tower
 * severity, and the warm triad is reserved for the latter. A factor bar in
 * maintain-red would read as "flood is dangerous" rather than "flood explains
 * most of this score".
 */
export function AttributionSummary({ report }: { report: ModelReport }) {
  const shares = report.attribution.mean_shares;
  const counts = report.attribution.dominant_counts;
  const factors = Object.keys(shares).sort((a, b) => shares[b] - shares[a]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <Panel
      title="Attribution"
      footnote={`${report.features.length} features in ${Object.keys(report.factor_groups).length} factors. Normalised absolute TreeSHAP, so a factor that lowers a site's score still reads as explaining it.`}
    >
      <ul className="space-y-2.5 text-xs">
        {factors.map((f) => (
          <li key={f}>
            <div className="flex items-baseline justify-between">
              <span className="capitalize text-fg/85">{f}</span>
              <span className="tnum font-mono text-fg/70">
                {(shares[f] * 100).toFixed(1)}%
                <span className="ml-2 text-muted">
                  leads {counts[f] ?? 0}
                  {total ? ` (${(((counts[f] ?? 0) / total) * 100).toFixed(0)}%)` : ''}
                </span>
              </span>
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-overlay/10">
              <div className="h-full rounded-full bg-overlay/40" style={{ width: `${shares[f] * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
