import type { JSX } from 'react';
import { bandColor, bandInk } from '../../lib/colors';
import type { IconProps } from '../shell/icons';

interface EnvSignalRowProps {
  Icon: (props: IconProps) => JSX.Element;
  label: string;
  values: { key: string; value: string }[];
  /**
   * The factor's real attribution share for this tower, 0–1.
   *
   * This used to be a literal passed in at the call site — the same five
   * numbers for all 132 towers, rendered with a severity colour and a dataset
   * caption beside genuinely per-tower readings. A share is now required to
   * come from `tower.attribution`, so a row cannot claim a reading the model
   * did not produce.
   */
  share: number;
  source: string;
}

export function EnvSignalRow({ Icon, label, values, share, source }: EnvSignalRowProps) {
  // Same thresholds the bands use, so a factor row and the map agree on what
  // counts as severe.
  const band = share >= 0.4 ? 'maintain' : share >= 0.2 ? 'watch' : 'ok';
  const color = bandColor(band);
  const ink = bandInk(band);

  return (
    <div className="-mx-2 flex items-center justify-between rounded-sm border-b border-overlay/5 px-2 py-2 text-ui transition-colors last:border-0 hover:bg-overlay/[0.02]">
      <div className="flex items-center gap-3">
        <span className="text-dim" aria-hidden="true">
          <Icon />
        </span>
        <div className="flex flex-col">
          <span className="font-semibold uppercase tracking-wider text-fg/90">{label}</span>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-dim">
            {values.map((v, i) => (
              <span key={v.key}>
                {v.key} <span className="font-mono text-fg/80">{v.value}</span>
                {i < values.length - 1 && <span className="mx-1 text-overlay/20">·</span>}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col items-end gap-1">
        <div
          className="tnum rounded px-1.5 py-0.5 font-mono text-eyebrow font-bold"
          style={{ color: ink, backgroundColor: `${color}1f` }}
          title={`${label} accounts for ${Math.round(share * 100)}% of this tower's risk attribution.`}
        >
          {Math.round(share * 100)}%
        </div>
        <span className="text-eyebrow italic text-muted">{source}</span>
      </div>
    </div>
  );
}
