import type { ModelReport } from '../../api/types';

/**
 * First on the page, and not collapsible.
 *
 * Every figure below it is measured against synthetic labels. A page of
 * confusion matrices with the provenance somewhere near the bottom is how a
 * prototype gets quoted as a product, so this sits above the numbers and states
 * both what the labels are and what the target is not.
 */
export function ProvenanceBanner({ report }: { report: ModelReport }) {
  const d = report.dataset;
  return (
    <div className="rounded border border-overlay/15 bg-overlay/[0.045] p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="rounded bg-overlay/12 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fg/85">
          {report.synthetic_labels ? 'Synthetic labels' : 'Observed labels'}
        </span>
        <span className="text-[11px] text-dim">
          generator v{report.generator_version} · {d.towers} towers · {d.positives} positives ·
          base rate {(d.base_rate * 100).toFixed(2)}% · {d.states} states · {d.window[0]} to {d.window[1]}
        </span>
      </div>
      <p className="mt-2 text-xs text-fg/80">{report.caveat}</p>
      <p className="mt-2 text-xs text-dim">{report.not_a_failure_label}</p>
    </div>
  );
}
