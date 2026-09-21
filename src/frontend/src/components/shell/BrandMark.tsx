import { Link } from 'react-router-dom';

interface BrandMarkProps {
  /**
   * `float` draws its own glass chip, for sitting directly on the map.
   * `inline` draws no surface, for sitting inside a bar that already has one.
   */
  variant?: 'float' | 'inline';
}

/**
 * Product identity. Appears in the same
 * screen position on every route — floating over the map on Overview, inline in
 * the console bar everywhere else.
 */
export function BrandMark({ variant = 'float' }: BrandMarkProps) {
  return (
    <Link
      to="/"
      aria-label="TowerRangers home"
      className={
        variant === 'float'
          ? 'glass-float flex items-center gap-2.5 rounded-xl px-[13px] py-[9px]'
          : 'flex items-center gap-2.5'
      }
    >
      <img src="/brand/mcmc-logo.png" alt="" aria-hidden="true" className="h-[22px] w-[22px] object-contain" />
      <div>
        <div className="font-display text-body font-semibold leading-tight tracking-tight text-fg">
          TowerRangers
        </div>
        {/* Not "Sunway AOI" any more: the console scores every communication
            tower OpenStreetMap has in Malaysia, and a subtitle naming a 5.7
            km^2 pilot box under a national map is a caption that contradicts
            the screen it sits on. */}
        <div className="eyebrow mt-0.5 text-eyebrow">MCMC · Malaysia</div>
      </div>
    </Link>
  );
}
