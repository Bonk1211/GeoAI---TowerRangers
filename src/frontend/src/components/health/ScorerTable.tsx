import { Panel } from '../ui/Panel';
import type { ModelReport } from '../../api/types';

const NOTES: Record<string, string> = {
  lightgbm: 'served today',
  ahp_index: 'the physical index this replaced — the baseline',
  oracle: 'the generator’s own latent intensity — a ceiling, not a competitor',
  hand_only: 'one feature, as a sanity floor',
};

/**
 * The four scorers, out of fold, at the dispatch operating point.
 *
 * Read from the artifact rather than typed in. MethodPage carried this table as
 * literals for one release and had already drifted from the report by the time
 * this component was written — which is the whole argument for serving the file.
 */
export function ScorerTable({ report }: { report: ModelReport }) {
  return (
    <Panel
      title="Scorers, out of fold"
      footnote={`${report.cv.scheme}, ${report.cv.folds} folds. Confusion at the ${report.cv.operating_point} operating point — the slice crew capacity actually dispatches.`}
    >
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left text-xs whitespace-nowrap">
          <thead>
            <tr className="border-b border-overlay/10 text-dim">
              {['Scorer', 'ROC', 'PR-AUC', 'TP', 'FP', 'FN', 'TN', 'Precision', 'Recall', 'Lift'].map((h) => (
                <th key={h} className="pb-2 pr-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.scorers.map((s) => {
              const t = s.at_top_10_percent;
              const served = s.scorer === 'lightgbm';
              return (
                <tr
                  key={s.scorer}
                  className={`border-b border-overlay/5 last:border-0 ${served ? 'bg-overlay/[0.035]' : ''}`}
                >
                  <td className="py-2 pr-4">
                    <span className={`font-mono ${served ? 'font-bold text-fg' : 'text-fg/80'}`}>
                      {s.scorer}
                    </span>
                    <span className="ml-2 text-[10px] italic text-muted">{NOTES[s.scorer] ?? ''}</span>
                  </td>
                  <td className="tnum py-2 pr-4 font-mono">{s.ranking.roc_auc.toFixed(4)}</td>
                  <td className="tnum py-2 pr-4 font-mono">{s.ranking.pr_auc.toFixed(4)}</td>
                  <td className="tnum py-2 pr-4 font-mono">{t.true_positive}</td>
                  <td className="tnum py-2 pr-4 font-mono">{t.false_positive}</td>
                  <td className="tnum py-2 pr-4 font-mono">{t.false_negative}</td>
                  <td className="tnum py-2 pr-4 font-mono">{t.true_negative}</td>
                  <td className="tnum py-2 pr-4 font-mono">{(t.precision * 100).toFixed(1)}%</td>
                  <td className="tnum py-2 pr-4 font-mono">{(t.recall * 100).toFixed(1)}%</td>
                  <td className="tnum py-2 font-mono">{t.lift_over_random.toFixed(2)}x</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-dim">
        Accuracy is deliberately absent. At a {(report.dataset.base_rate * 100).toFixed(1)}% base rate,
        dispatching nobody scores {((1 - report.dataset.base_rate) * 100).toFixed(1)}% — it would be the
        largest number here and would mean nothing.
      </p>
    </Panel>
  );
}
