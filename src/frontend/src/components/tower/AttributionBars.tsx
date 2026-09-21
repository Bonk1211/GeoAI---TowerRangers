import type { Tower } from '../../api/types';

interface AttributionBarsProps {
  attribution: Tower['attribution'];
}

/**
 * Ranked bars, not a radar. A radar chart encodes magnitude as area on a
 * rotated axis, which is exactly the wrong shape for "which factor is the
 * biggest" — the question this panel exists to answer.
 */
export function AttributionBars({ attribution }: AttributionBarsProps) {
  const data = Object.entries(attribution)
    .map(([factor, share]) => ({ factor, share }))
    .sort((a, b) => b.share - a.share);

  if (data.length === 0) {
    return <p className="text-ui text-dim">No attribution yet — perception hasn't run for this AOI.</p>;
  }

  const max = Math.max(...data.map((d) => d.share), 0.01);

  return (
    <div className="flex flex-col gap-2">
      {data.map((d, i) => (
        <div key={d.factor} className="flex items-center gap-3">
          <span className="w-[72px] shrink-0 truncate text-ui capitalize text-fg">{d.factor}</span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-overlay/[0.07]">
            <span
              className="block h-full rounded-full transition-[width] duration-300"
              style={{
                width: `${(d.share / max) * 100}%`,
                // The leading driver carries the accent; the rest recede, so the
                // dominant factor is readable without reading any number.
                backgroundColor: i === 0 ? 'var(--color-accent)' : 'rgba(13,21,38,0.32)',
              }}
            />
          </span>
          <span className="w-9 shrink-0 text-right text-ui tnum text-muted">
            {Math.round(d.share * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}
