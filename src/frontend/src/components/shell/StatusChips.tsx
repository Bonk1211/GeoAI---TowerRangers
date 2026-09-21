import { useOffline } from '../../state/useOffline';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useStabilityQuery } from '../../api/queries';

/**
 * Top-right status readout.
 *
 * The three chips share one blurred surface rather than taking one each. The
 * blur budget for this screen is 8 surfaces; billing three for what reads as a
 * single cluster would spend nearly half of it on punctuation.
 *
 * The offline state is never hidden to keep the HUD tidy — it flips the first
 * chip and OfflineBanner still renders above the map.
 */
interface StatusChipsProps {
  /**
   * `float` draws its own glass chip, for sitting directly on the map.
   * `inline` draws no surface, for sitting inside a bar that already has one.
   */
  variant?: 'float' | 'inline';
}

export function StatusChips({ variant = 'float' }: StatusChipsProps) {
  const offline = useOffline((s) => s.offline);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const stability = useStabilityQuery();

  return (
    <div
      className={`flex items-stretch rounded-[10px] ${
        variant === 'float' ? 'glass-float' : 'border border-overlay/[0.09] bg-overlay/[0.03]'
      }`}
    >
      <div
        className="flex items-center gap-2 px-3 py-[9px] font-mono text-micro"
        style={{ color: offline ? 'var(--color-watch-ink)' : 'var(--color-ok-ink)' }}
      >
        <span
          className="h-[5px] w-[5px] shrink-0 rounded-full"
          style={{
            backgroundColor: 'currentColor',
            boxShadow: '0 0 9px 1px currentColor',
          }}
        />
        {offline ? 'OFFLINE' : 'LIVE'}
      </div>

      <div className="my-[7px] w-px bg-overlay/10" />

      <div className="px-3 py-[9px] font-mono text-micro text-muted">
        <span aria-hidden="true">ρ </span>
        <span className="sr-only">Rank stability </span>
        <span className="tnum">{stability.data ? stability.data.rho_mean.toFixed(2) : '—'}</span>
      </div>

      <div className="my-[7px] w-px bg-overlay/10" />

      <div className="px-3 py-[9px] font-mono text-micro text-muted">
        <span className="tnum">{towers.length}</span> towers
      </div>
    </div>
  );
}
