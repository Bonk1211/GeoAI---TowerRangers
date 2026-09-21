import { Panel } from '../ui/Panel';
import type { LedgerSummary, ModelReport } from '../../api/types';

interface Check {
  id: string;
  label: string;
  pass: boolean;
  value: string;
  detail: string;
}

/**
 * The checks that have each caught a real bug, rendered as pass/fail.
 *
 * This is the panel that makes the page "health" rather than "metrics". Every
 * row below exists because the thing it tests went wrong at least once, and
 * every one of them fails silently in the artifact — a leaked generator, a
 * split that inflates, a detector that ranks worse than the model it is meant
 * to second-guess. None of them raises; they just make the numbers above mean
 * nothing, which is why they are shown above the numbers rather than under them.
 *
 * Colour is not the signal. `pass` drives a word as well as a hue, because a
 * grid of green and red dots is unreadable to a portion of any audience and
 * this page is where being unreadable is most expensive.
 */
export function GuardrailChecks({ report, ledger }: { report: ModelReport; ledger: LedgerSummary | null }) {
  const so = report.second_opinion;
  const forest = so.detectors_in_escalation_band['isolation_forest'];
  const condition = so.detectors_in_escalation_band['one_sided_condition'];
  const change = so.detectors_in_escalation_band['one_sided_change'];
  const base = report.dataset.base_rate;

  const checks: Check[] = [
    {
      id: 'leak',
      label: 'Model stays clear of the oracle',
      pass: report.leak_check.verdict === 'clear',
      value: `gap ${report.leak_check.gap_to_oracle.toFixed(4)} PR-AUC`,
      detail:
        'The oracle is the generator’s own latent intensity — the ceiling, not a competitor. A model within ~0.03 PR-AUC of it has been handed recoverable structure, and every figure on this page would be void.',
    },
    {
      id: 'split',
      label: 'Grouped split is not inflated',
      pass: Math.abs(report.split_check.inflation) < 0.05,
      value: `${report.split_check.inflation >= 0 ? '+' : ''}${report.split_check.inflation.toFixed(3)} PR-AUC vs random KFold`,
      detail:
        'Towers a few kilometres apart share a catchment, a feeder and a crew, so a random split scores near-duplicates. A large gap means regional structure crept back in — from the data, not the model — and the grouped number is the honest one.',
    },
    {
      id: 'beats-index',
      label: 'Model beats the physical index',
      pass: report.leak_check.beats_index_by > 0,
      value: `+${report.leak_check.beats_index_by.toFixed(4)} PR-AUC`,
      detail:
        'The noisy-OR AHP index is the baseline this model replaced. A PR-AUC with no baseline is unreadable, so it is scored on every run rather than cited from memory.',
    },
    {
      id: 'necessary-condition',
      label: 'Second opinion out-ranks the model in-band',
      pass: Boolean(condition?.may_gate),
      value: condition
        ? `condition ${condition.in_band_auc?.toFixed(3) ?? '—'} vs model ${condition.model_auc?.toFixed(3) ?? '—'}`
        : 'not measured',
      detail:
        'The necessary condition for a second opinion to be worth acting on. If the model already ranks better inside the band where the blend can move a tower, the blend can only make dispatch worse.',
    },
    {
      id: 'forest-excluded',
      label: 'Isolation forest stays out of the ordering',
      pass: forest ? !forest.may_gate : true,
      value: forest
        ? `forest ${forest.in_band_auc?.toFixed(3) ?? '—'} vs model ${forest.model_auc?.toFixed(3) ?? '—'}`
        : 'not measured',
      detail:
        'A forest scores |deviation from typical| while maintenance need is monotone — a site with unusually FEW alarms is as anomalous as one with unusually many. It is shown to planners and kept out of the ordering.',
    },
    {
      id: 'change-necessary-condition',
      label: 'Satellite change out-ranks the model in-band',
      pass: Boolean(change?.may_gate),
      value: change?.in_band_auc != null && change.model_auc != null
        ? `change ${change.in_band_auc.toFixed(3)} vs model ${change.model_auc.toFixed(3)}`
        : 'not measured',
      detail: so.change_verdict ?? 'Change stays descriptive until the grouped comparison establishes an advantage.',
    },
    {
      id: 'ledger-not-fabricated',
      label: 'Observation ledger contains no simulated records',
      pass: ledger === null || ledger.simulated_records === 0,
      value: ledger === null ? 'no ledger available' : `${ledger.simulated_records} simulated records`,
      detail: ledger?.simulated_records
        ? 'Simulated confirmations are present for demonstration. Their counts are real, but their outcomes are synthetic; they do not establish real maintenance benefit.'
        : 'Counts come from recorded observations. No missing ledger is replaced by invented counts.',
    },
    {
      id: 'matched-budget',
      label: 'Ensemble wins at matched dispatch budget',
      pass: so.matched_budget.delta_f1 > 0,
      value: `${so.matched_budget.delta_f1 >= 0 ? '+' : ''}${so.matched_budget.delta_f1.toFixed(4)} F1 at ${so.matched_budget.budget} towers`,
      detail:
        'Any policy that dispatches more towers must be scored against a cut that dispatches the same number. Comparing against the untouched top-10% credits the ensemble for the extra visits alone.',
    },
    {
      id: 'base-rate',
      label: 'Base rate in usable range',
      pass: base >= 0.15 && base <= 0.3,
      value: `${(base * 100).toFixed(2)}% of ${report.dataset.towers} towers`,
      detail:
        'Too rare and the top-10% operating point has no positives to find; too common and everything is positive. Outside 15–30% the figures above stop describing a decision anyone would make.',
    },
    {
      id: 'demo-cases',
      label: 'Planted demo cases hold',
      pass: report.demo_case_checks.confusion_held >= report.demo_case_checks.confusion_total - 1,
      value: `${report.demo_case_checks.confusion_held}/${report.demo_case_checks.confusion_total} confusion, ${report.demo_case_checks.pairs_held}/${report.demo_case_checks.pairs_total} pairs`,
      detail:
        'Sites registered with an expected role before training, so “the model fell for this” is a test rather than a story assembled afterwards.',
    },
  ];

  const failing = checks.filter((c) => !c.pass).length;

  return (
    <Panel
      title="Guardrails"
      footnote={
        failing === 0
          ? 'All checks hold. Each one has caught a real defect at least once.'
          : `${failing} check${failing === 1 ? '' : 's'} not holding — read these before any number below.`
      }
    >
      <ul className="space-y-2 text-xs">
        {checks.map((check) => (
          <li key={check.id} className="rounded border border-overlay/10 bg-overlay/[0.02] p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-fg/90">{check.label}</span>
              {/* The word carries the state; the hue only reinforces it. */}
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  check.pass ? 'bg-overlay/10 text-fg/80' : 'bg-alert/15 text-alert-ink'
                }`}
              >
                {check.pass ? 'holds' : 'check'}
              </span>
            </div>
            <div className="tnum mt-1 font-mono text-[11px] text-fg/80">{check.value}</div>
            <p className="mt-1 text-dim">{check.detail}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
