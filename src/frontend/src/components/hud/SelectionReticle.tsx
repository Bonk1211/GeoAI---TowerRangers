import { useSelection } from '../../state/useSelection';
import { useWeights } from '../../state/useWeights';
import { useLiveTower } from '../../api/useLiveTowers';
import { useMapInstance } from '../../state/useMapInstance';

/**
 * Corner brackets over the selected tower, plus one expanding ring.
 *
 * Decorative only — `aria-hidden`, and the HUD column is what actually tells
 * you which tower is selected. The ring is the screen's only looping animation,
 * so it is stopped outright under prefers-reduced-motion rather than merely
 * shortened, and it carries no blur.
 *
 * Position is recomputed from `view`, which the map republishes on every move,
 * so the brackets track the tower through a pan instead of detaching from it.
 */
export function SelectionReticle() {
  const selectedTowerId = useSelection((s) => s.selectedTowerId);
  const weights = useWeights((s) => s.weights);
  const tower = useLiveTower(selectedTowerId, weights);
  const map = useMapInstance((s) => s.map);
  // Not read directly — subscribing re-runs this component on every map move so
  // the projection below stays current.
  useMapInstance((s) => s.view);

  if (!tower || !map) return null;

  const point = map.project([tower.lon, tower.lat]);
  const accent = 'var(--color-accent)';

  const corner = (style: React.CSSProperties) => (
    <span className="absolute block" style={{ background: accent, ...style }} />
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10"
      style={{ left: point.x, top: point.y }}
    >
      {/* 30x30 bracket box, centred on the tower. */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ width: 30, height: 30 }}>
        {corner({ left: 0, top: 0, width: 9, height: 1.5 })}
        {corner({ left: 0, top: 0, width: 1.5, height: 9 })}
        {corner({ right: 0, top: 0, width: 9, height: 1.5 })}
        {corner({ right: 0, top: 0, width: 1.5, height: 9 })}
        {corner({ left: 0, bottom: 0, width: 9, height: 1.5 })}
        {corner({ left: 0, bottom: 0, width: 1.5, height: 9 })}
        {corner({ right: 0, bottom: 0, width: 9, height: 1.5 })}
        {corner({ right: 0, bottom: 0, width: 1.5, height: 9 })}
      </div>

      {/* The pulse animates `transform: scale()`, so the centring translate has
          to live on a separate element or the keyframes overwrite it. */}
      <span
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ width: 66, height: 66 }}
      >
        <span
          className="reticle-pulse block h-full w-full rounded-full"
          style={{ border: '1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)' }}
        />
      </span>
    </div>
  );
}
