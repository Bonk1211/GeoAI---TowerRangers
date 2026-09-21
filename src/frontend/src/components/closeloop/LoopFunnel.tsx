import { Panel } from '../ui/Panel';
import { ArrowRightIcon } from '../shell/icons';
import type { FunnelCounts } from '../../lib/contestedQueue';

interface Stage {
  label: string;
  value: number | null;
  /** One short qualifier under the label — a count, never a sentence. */
  sub?: string;
  tone?: 'contested' | 'accent';
}

function format(value: number | null) {
  return value === null ? '—' : value.toLocaleString();
}

interface LoopFunnelProps {
  counts: FunnelCounts;
  /** Of the in-training rows, how many --simulate wrote. */
  simulated: number | null;
}

/**
 * The loop as one strip of five figures, read left to right.
 *
 * This absorbed the old CorpusYield hero and the full-width bar funnel, which
 * between them printed the exportable and judged counts twice more than the
 * header already did. Each stage now appears exactly once, and the page's one
 * accent figure (ready to export) sits beside the button that acts on it.
 *
 * The bar under each figure is still drawn at true scale against the ledger,
 * so a stage holding 0.03% of the observations still looks like 0.03% — the
 * narrowing is the argument for a human in the loop.
 */
export function LoopFunnel({ counts, simulated }: LoopFunnelProps) {
  const stages: Stage[] = [
    { label: 'Observed', value: counts.observed, sub: 'ledger rows' },
    {
      label: 'Contested',
      value: counts.contested_rows,
      sub: `${format(counts.contested_towers)} towers`,
      tone: 'contested',
    },
    { label: 'Judged', value: counts.judged, sub: 'field verdicts' },
    { label: 'Ready to export', value: counts.exportable, tone: 'accent' },
    {
      label: 'In training',
      value: counts.in_training,
      sub: simulated ? `${format(simulated)} simulated` : undefined,
    },
  ];

  return (
    <Panel
      title="The loop"
      hint="Satellite observation → contradiction → technician verdict → exportable label → training set, drawn at true scale. Observed, contested and in-training come from the backend ledger; judged and exportable from tickets in this browser. No stage is inferred from another."
    >
      <ol className="grid grid-cols-2 gap-x-2 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {stages.map((stage, index) => {
          const pct =
            stage.value !== null && counts.observed !== null && counts.observed > 0
              ? (stage.value / counts.observed) * 100
              : null;
          // An unread stage is absence, not a reading — keep its dash neutral.
          const ink =
            stage.value === null
              ? 'text-dim'
              : stage.tone === 'contested'
              ? 'text-alert-ink'
              : stage.tone === 'accent'
                ? 'text-accent'
                : 'text-fg';
          const fill =
            stage.tone === 'contested'
              ? 'bg-alert/70'
              : stage.tone === 'accent'
                ? 'bg-accent/70'
                : 'bg-overlay/30';
          return (
            <li key={stage.label} className="relative min-w-0 lg:pr-5">
              <div className={`font-display text-display font-semibold leading-none tnum ${ink}`}>
                {format(stage.value)}
              </div>
              <div className="eyebrow mt-2 truncate">{stage.label}</div>
              <div className="mt-0.5 h-4 truncate text-micro text-dim">{stage.sub}</div>
              <div
                className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-overlay/[0.06]"
                role="presentation"
              >
                {pct !== null && (
                  <div
                    className={`h-full rounded-full ${fill}`}
                    // Sub-pixel bars vanish; floor so a non-zero stage shows.
                    style={{ width: `${stage.value === 0 ? 0 : Math.max(pct, 1)}%` }}
                  />
                )}
              </div>
              {index < stages.length - 1 && (
                <span
                  className="absolute right-0 top-3 hidden text-dim lg:block"
                  aria-hidden="true"
                >
                  <ArrowRightIcon size={14} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
