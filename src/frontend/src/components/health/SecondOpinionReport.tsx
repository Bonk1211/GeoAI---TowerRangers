import { Panel } from '../ui/Panel';
import type { ModelReport } from '../../api/types';

/**
 * Why the second opinion is wired the way it is, from the artifact.
 *
 * The matched-budget table is the load-bearing part: both rows dispatch the
 * same number of towers, so it is a strict swap rather than "the ensemble sent
 * more crews and caught more". Every earlier version of this comparison that
 * did not match the budget flattered the ensemble.
 */
export function SecondOpinionReport({ report }: { report: ModelReport }) {
  const so = report.second_opinion;
  const mb = so.matched_budget;
  const rows: [string, typeof mb.lower_cut][] = [
    ['LightGBM alone', mb.lower_cut],
    ['3-layer ensemble', mb.ensemble],
  ];

  return (
    <div className="space-y-4">
      <Panel
        title="Second opinion at matched dispatch budget"
        footnote={`Both policies dispatch ${mb.budget} towers. Condition weight ${so.blend_weight}; change weight ${so.change_weight ?? 'not measured'}.`}
      >
        {report.encroachment_note && <p className="mb-3 text-micro text-dim">{report.encroachment_note}</p>}
        {so.change_verdict && <p className="mb-3 text-ui text-fg/85">{so.change_verdict}</p>}
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-overlay/10 text-dim">
              {['Policy', 'TP', 'FP', 'Precision', 'Recall', 'F1'].map((h) => (
                <th key={h} className="pb-2 pr-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, r]) => (
              <tr key={label} className="border-b border-overlay/5 last:border-0">
                <td className="py-2 pr-4 text-fg/85">{label}</td>
                <td className="tnum py-2 pr-4 font-mono">{r.tp}</td>
                <td className="tnum py-2 pr-4 font-mono">{r.fp}</td>
                <td className="tnum py-2 pr-4 font-mono">{(r.precision * 100).toFixed(1)}%</td>
                <td className="tnum py-2 pr-4 font-mono">{(r.recall * 100).toFixed(1)}%</td>
                <td className="tnum py-2 font-mono">{r.f1.toFixed(4)}</td>
              </tr>
            ))}
            <tr className="text-fg/70">
              <td className="py-2 pr-4 text-[11px] italic">delta</td>
              <td className="tnum py-2 pr-4 font-mono">{mb.ensemble.tp - mb.lower_cut.tp >= 0 ? '+' : ''}{mb.ensemble.tp - mb.lower_cut.tp}</td>
              <td className="tnum py-2 pr-4 font-mono">{mb.ensemble.fp - mb.lower_cut.fp >= 0 ? '+' : ''}{mb.ensemble.fp - mb.lower_cut.fp}</td>
              <td className="py-2 pr-4" />
              <td className="py-2 pr-4" />
              <td className="tnum py-2 font-mono">{mb.delta_f1 >= 0 ? '+' : ''}{mb.delta_f1.toFixed(4)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-dim">
          Same budget both rows, so every tower the blend adds displaces one it drops —
          {' '}{so.towers_swapped_in} swapped in, {so.swapped_in_hits} of which needed work.
          Telemetry ranks the label at ROC {so.telemetry_roc_auc.toFixed(3)} on its own and is
          absent from the supervised feature set: the counters cover 30 days, the label covers 36
          months, so no aligned pair exists to train on.
        </p>
      </Panel>

      <Panel
        title="Blending novelty into risk"
        footnote="Rejected. Reported so the rejection stays measurable rather than remembered."
      >
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left text-xs">
            <thead>
              <tr className="border-b border-overlay/10 text-dim">
                {['Weight on novelty', 'ROC', 'PR-AUC'].map((h) => (
                  <th key={h} className="pb-2 pr-4 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {so.blend_sweep.map((r) => (
                <tr key={r.w_novelty} className="border-b border-overlay/5 last:border-0">
                  <td className="tnum py-1.5 pr-4 font-mono">{r.w_novelty.toFixed(1)}</td>
                  <td className="tnum py-1.5 pr-4 font-mono">{r.roc_auc.toFixed(4)}</td>
                  <td className="tnum py-1.5 pr-4 font-mono">{r.pr_auc.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-dim">
          The isolation forest degrades the ranking from the first step, which is why it is shown
          to planners and kept out of the ordering. The one-sided condition score is a different
          statistic on different data and is blended in — the two must not be confused.
        </p>
      </Panel>

      <Panel
        title="Environment novelty by quintile"
        footnote="Why novelty is not an out-of-distribution warning here."
      >
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-overlay/10 text-dim">
              {['Quintile', 'Towers', 'Base rate', 'Calibration error', 'ROC'].map((h) => (
                <th key={h} className="pb-2 pr-4 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {so.novelty_by_quintile.map((q) => (
              <tr key={q.quintile} className="border-b border-overlay/5 last:border-0">
                <td className="py-1.5 pr-4 font-mono">Q{q.quintile}</td>
                <td className="tnum py-1.5 pr-4 font-mono">{q.n}</td>
                <td className="tnum py-1.5 pr-4 font-mono">{(q.base_rate * 100).toFixed(1)}%</td>
                <td className="tnum py-1.5 pr-4 font-mono">{q.calibration_error.toFixed(4)}</td>
                <td className="tnum py-1.5 pr-4 font-mono">{q.roc_auc?.toFixed(4) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-dim">
          Calibration error and ROC stay flat while the base rate climbs, so novelty tracks risk
          rather than model error. Abstaining on the strangest towers would discard signal, not
          avoid mistakes.
        </p>
      </Panel>
    </div>
  );
}
