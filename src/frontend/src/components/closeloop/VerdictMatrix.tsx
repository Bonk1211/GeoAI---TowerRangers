import { Panel } from '../ui/Panel';
import { Chip } from '../ui/Chip';
import type { VerdictCounts } from '../../lib/feedbackCorpus';

/**
 * The 2x2 of dispatch decision against field outcome.
 *
 * This is NOT an accuracy measurement. It used to say so in an always-open red
 * box, which gave the caveat more weight than the figures. The caveat now
 * rides on a "Tally" chip beside the title and in the hint.
 */
export function VerdictMatrix({ counts }: { counts: VerdictCounts }) {
  const cell = (value: number, agrees: boolean, label: string) => (
    <td className="p-1">
      <div
        className={`rounded-lg border px-2 py-3 text-center ${
          agrees ? 'border-ok/25 bg-ok/[0.06]' : 'border-alert/25 bg-alert/[0.06]'
        }`}
      >
        <span className="sr-only">{label}: </span>
        <span className="font-display text-title font-semibold leading-none tnum text-fg">
          {value}
        </span>
        <span className="mt-1 block text-eyebrow uppercase tracking-wider text-dim">
          {agrees ? 'agree' : 'differ'}
        </span>
      </div>
    </td>
  );

  return (
    <Panel
      title="Dispatch vs field"
      hint="What the model decided against what the field found, for tickets that snapshotted the model's belief when raised. n is small, not held out and not random — a tally of this session's tickets, not an accuracy measurement."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Chip tone="watch">Tally, not accuracy</Chip>
        <span className="text-micro text-dim tnum">
          n = {counts.n}
          {counts.excluded > 0 && ` · ${counts.excluded} excluded`}
        </span>
      </div>

      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <td />
            <th scope="col" className="pb-1 text-micro font-medium text-muted">work needed</th>
            <th scope="col" className="pb-1 text-micro font-medium text-muted">nothing wrong</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="w-[5rem] pr-2 text-right text-micro font-medium text-muted">
              dispatched
            </th>
            {cell(counts.caught, true, 'Dispatched, work needed')}
            {cell(counts.falseAlarm, false, 'Dispatched, nothing wrong')}
          </tr>
          <tr>
            <th scope="row" className="pr-2 text-right text-micro font-medium text-muted">
              held back
            </th>
            {cell(counts.missed, false, 'Not dispatched, work needed')}
            {cell(counts.quiet, true, 'Not dispatched, nothing wrong')}
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}
