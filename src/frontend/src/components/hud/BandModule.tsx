import { bandCounts, driverMix } from '../../lib/aggregate';
import { useMapFilter } from '../../state/useMapFilter';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { COLORS } from '../../lib/colors';
import type { Decision } from '../../api/types';

const ROWS: { key: Decision; label: string }[] = [
  { key: 'maintain', label: 'Maintain' },
  { key: 'watch', label: 'Watch' },
  { key: 'ok', label: 'OK' },
];

/**
 * The band rows are the only band key on screen — there is no separate legend
 * component any more. Each row is simultaneously the key and the filter, so
 * reading the colour and acting on it are the same gesture.
 *
 * The meter fill is share of total, not count-over-max. The design prototype
 * divided by the largest band, which only looks right because its fixture
 * counts happen to sit near their own percentages.
 *
 * The driver mix shares this surface rather than taking a module of its own:
 * the screen's blur budget is 8 surfaces and this is the cheaper way to keep
 * the AOI-wide attribution on the map screen.
 */
export function BandModule() {
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const bands = bandCounts(towers);
  const bandFilter = useMapFilter((s) => s.bandFilter);
  const toggleBandFilter = useMapFilter((s) => s.toggleBandFilter);

  const total = bands.maintain + bands.watch + bands.ok;
  const drivers = driverMix(towers);
  const driverMax = Math.max(...drivers.map((d) => d.pct), 0.01);

  return (
    <section className="glass-float rounded-xl p-[13px]" aria-label="Risk band">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h2 className="eyebrow">Band</h2>
        {/* This hint sits on a .glass-float panel, which on the light theme is
            opaque enough (0.90..0.84 white) that the basemap no longer bleeds
            through it — so unlike the dark theme, the colour here is governed
            by the panel, not by the brightest tile under it. --color-dim
            measures 4.82:1 against the panel's darkest stop, clearing AA for
            body text rather than merely the 3:1 secondary floor the old
            hardcoded #64769c was chosen to scrape past. */}
        <span className="font-mono text-eyebrow text-dim">tap to isolate</span>
      </div>

      {ROWS.map((row) => {
        const count = bands[row.key];
        const active = bandFilter === row.key;
        const dimmed = bandFilter !== null && !active;
        return (
          <button
            key={row.key}
            type="button"
            aria-pressed={active}
            onClick={() => toggleBandFilter(row.key)}
            className={`mb-[9px] flex min-h-[32px] w-full items-center gap-[9px] rounded-md px-1.5 text-left transition-opacity duration-150 ${
              dimmed ? 'opacity-45' : 'opacity-100'
            } ${active ? 'bg-overlay/[0.08]' : 'hover:bg-overlay/[0.05]'}`}
          >
            <span className="w-[22px] shrink-0 text-left text-micro tnum text-[color:var(--color-sub)]">
              {count}
            </span>
            <span className="h-[5px] flex-1 overflow-hidden rounded-full bg-overlay/[0.07]">
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${total ? (count / total) * 100 : 0}%`,
                  backgroundColor: COLORS[row.key],
                }}
              />
            </span>
            <span className="w-[78px] shrink-0 text-micro text-muted">{row.label}</span>
          </button>
        );
      })}

      <div className="mt-3 border-t border-overlay/[0.09] pt-3">
        <h2 className="eyebrow mb-2.5">What drives risk</h2>
        {drivers.map((d, i) => (
          <div key={d.factor} className="mb-[9px] flex items-center gap-[9px]">
            <span className="w-[78px] shrink-0 truncate text-micro capitalize text-[color:var(--color-sub)]">
              {d.factor}
            </span>
            <span className="h-[5px] flex-1 overflow-hidden rounded-full bg-overlay/[0.07]">
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${(d.pct / driverMax) * 100}%`,
                  // Leading driver accented, the rest recede — matches AttributionBars.
                  backgroundColor: i === 0 ? 'var(--color-accent)' : 'rgba(13,21,38,0.32)',
                }}
              />
            </span>
            <span className="w-[30px] shrink-0 text-right text-micro tnum text-muted">
              {Math.round(d.pct * 100)}%
            </span>
          </div>
        ))}
        <p className="mt-2 text-eyebrow leading-snug text-dim">
          Mean attribution share across maintain-band towers.
        </p>
      </div>
    </section>
  );
}
