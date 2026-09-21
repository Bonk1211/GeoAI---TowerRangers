import { Panel, Stat } from '../ui/Panel';
import type { LedgerSummary } from '../../api/types';

const sourceNames: Record<string, string> = {
  s2_change: 'Sentinel-2 change',
  s1_flood_extent: 'Sentinel-1 flood extent',
  viirs_fire: 'VIIRS fire',
};

export function ObservationLedger({ ledger }: { ledger: LedgerSummary | null }) {
  const compared = ledger ? ledger.agree + ledger.disagree : 0;
  return (
    <Panel title="Observation ledger" footnote="Retraining is manual. A satellite observation is evidence, not an outcome — no record becomes a training label until a work order closes against it. Demo confirmations are explicitly simulated.">
      {ledger ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Records" value={String(ledger.records)} />
            <Stat label="Agree" value={String(ledger.agree)} hint={compared ? `${(100 * ledger.agree / compared).toFixed(1)}% of determinate comparisons` : 'No determinate comparisons'} />
            <Stat label="Disagree" value={String(ledger.disagree)} />
            <Stat label="Training eligible" value={String(ledger.eligible_for_training)} hint="Confirmed candidates for the next run" />
          </div>
          <dl className="mt-4 space-y-2 border-t border-overlay/10 pt-3 text-micro">
            {[
              ['Observation windows end (UTC)', ledger.first_observed && ledger.last_observed ? `${ledger.first_observed.slice(0, 10)} → ${ledger.last_observed.slice(0, 10)}` : '—'],
              ['Indeterminate comparisons', ledger.indeterminate],
              ['Simulated records', ledger.simulated_records],
              ['Malformed records skipped', ledger.malformed],
              ['Last retrain (UTC)', ledger.last_retrain?.slice(0, 10) ?? 'Not recorded'],
              ['Sources', Object.entries(ledger.sources).map(([source, count]) => `${sourceNames[source] ?? source}: ${count}`).join(', ') || '—'],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex flex-wrap justify-between gap-2">
                <dt className="text-dim">{label}</dt>
                <dd className="tnum font-mono text-fg/85">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-micro text-dim">
            Agreement compares satellite growth and site condition with dispatch priority; it is not model accuracy.
            Repeated observations and confirmation records remain in the ledger; training candidates are counted once per site, source and window.
          </p>
          {ledger.simulated_records > 0 && (
            <p className="mt-3 rounded border border-overlay/15 bg-overlay/[0.045] p-3 text-ui font-semibold">
              {ledger.simulated_records} simulated records — demo confirmations, not closed real work orders.
            </p>
          )}
        </>
      ) : (
        <p className="text-ui text-dim">No observation ledger is available. Counts and agreement have not been measured.</p>
      )}
    </Panel>
  );
}
