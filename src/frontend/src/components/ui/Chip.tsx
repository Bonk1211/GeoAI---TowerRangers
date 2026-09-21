import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { bandColor, bandInk } from '../../lib/colors';
import type { Decision } from '../../api/types';

export type ChipTone = 'ok' | 'alert' | 'watch' | 'accent' | 'neutral';

const CHIP_TONES: Record<ChipTone, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok-ink',
  alert: 'border-alert/40 bg-alert/10 text-alert-ink',
  watch: 'border-watch/40 bg-watch/10 text-watch-ink',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  neutral: 'border-overlay/15 bg-overlay/[0.05] text-muted',
};

interface ChipProps {
  tone?: ChipTone;
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A short status token. Replaces status sentences in tables and lists: the
 * state is read from the chip's words, and the tone only reinforces them, so
 * colour is never the sole carrier of meaning.
 */
export function Chip({ tone = 'neutral', icon, title, className = '', children }: ChipProps) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-micro font-medium ${CHIP_TONES[tone]} ${className}`}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

const DECISIONS = new Set<string>(['maintain', 'watch', 'ok']);

/**
 * The served decision as a band-coloured badge, the same treatment
 * Investigation gives it. Fill ramp for the tint, ink ramp for the words — see
 * lib/colors.ts for why the two are not interchangeable.
 */
export function DecisionChip({ decision }: { decision: string | null | undefined }) {
  if (!decision || !DECISIONS.has(decision)) {
    return <Chip>{decision ?? 'not scored'}</Chip>;
  }
  const d = decision as Decision;
  return (
    <span
      className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-eyebrow font-semibold uppercase tracking-wider"
      style={{
        color: bandInk(d),
        borderColor: `${bandColor(d)}66`,
        backgroundColor: `${bandColor(d)}1a`,
      }}
    >
      {d}
    </span>
  );
}

export interface SegmentedTab<K extends string> {
  key: K;
  label: string;
  count?: number;
  /** Tints the count badge — for the one tab that holds outstanding work. */
  countTone?: 'alert' | 'neutral';
}

interface SegmentedTabsProps<K extends string> {
  tabs: SegmentedTab<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  /** Prefix for tab/panel ids, so aria-controls resolves. */
  idPrefix: string;
}

/**
 * The segmented control Integrations introduced, lifted here so Close Loop
 * uses the same one. Real ARIA tabs: arrow keys move between them, and each
 * tab names the panel it controls.
 */
export function SegmentedTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: SegmentedTabsProps<K>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    onChange(tabs[next].key);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex flex-wrap gap-1 rounded-xl bg-overlay/[0.03] p-[5px]"
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === value;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.key}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={`flex min-h-[36px] cursor-pointer items-center gap-2 rounded-[9px] px-3.5 text-ui transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              selected
                ? 'bg-accent/15 font-medium text-accent'
                : 'text-muted hover:bg-overlay/[0.06] hover:text-fg'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-micro tnum ${
                  tab.countTone === 'alert' && tab.count > 0
                    ? 'bg-alert/15 font-semibold text-alert-ink'
                    : 'bg-overlay/[0.08]'
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
