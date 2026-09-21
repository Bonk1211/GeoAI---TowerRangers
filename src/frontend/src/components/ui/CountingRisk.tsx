import { useCountingValue } from '../../lib/useCountingValue';

/**
 * A risk score that counts to its new value instead of jumping to it.
 *
 * The tween itself, and the reasoning behind it, live in
 * `lib/useCountingValue.ts`. This is the readout.
 *
 * `.tnum` is load-bearing rather than decorative: a proportional figure set
 * gives every digit a different width, so a counting number visibly jitters as
 * it runs and the column reflows under it. Tabular figures hold it still.
 *
 * THE BAND COLOUR IS NOT TWEENED, deliberately. `decision` is a CUT on the
 * score, so interpolating the colour alongside the number would paint a blend
 * of two bands for a few hundred milliseconds — a hue that means nothing, in a
 * palette where every hue is supposed to mean exactly one thing. The number
 * moves; the colour switches once, when the committed band does. Callers pass
 * the committed band's ink through `style`.
 */
export function CountingRisk({
  value,
  className = '',
  style,
}: {
  value: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const display = useCountingValue(value);
  return (
    <span className={`tnum ${className}`} style={style}>
      {display.toFixed(2)}
    </span>
  );
}
