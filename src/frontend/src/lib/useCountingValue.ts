import { useEffect, useRef, useState } from 'react';
import { durationFor, valueAt } from './countTo';

/**
 * Walk a displayed number toward its target instead of jumping to it.
 *
 * WHAT THIS IS FOR. When modelled protection commits, a tower's score moves
 * 0.91 -> 0.62 in one render. Shown as a jump, that is a RESULT with no
 * visible cause; counted down, it reads as something the works DID, and the
 * size of the move registers on its own. Same argument as the console
 * transcript one level up: the mechanism is the claim, and a value that
 * teleports hides it.
 *
 * ONLY THE DISPLAY MOVES. Nothing here changes what a tower is scored at. The
 * store commits the real number immediately and this walks a local copy toward
 * it, so the intermediate values exist nowhere except on screen. Everything
 * that READS risk — the map filter, the band cut, the panel's own before/after
 * pair — sees the committed value throughout.
 *
 * REDUCED MOTION IS A HARD SKIP, not a shortened tween. Someone who asked for
 * less motion gets the final number on the first frame and loses nothing: the
 * before/after pair is stated in text beside it either way.
 *
 * It lives in `lib/` rather than beside the component because a module that
 * exports both a hook and a component breaks React Fast Refresh — the lint
 * rule `react(only-export-components)` catches exactly this.
 */
export function useCountingValue(target: number): number {
  const [display, setDisplay] = useState(target);
  // The value the CURRENT tween started from. Held in a ref rather than state
  // so updating it cannot itself schedule a render.
  const fromRef = useRef(target);
  // The latest rendered value, read only by the cleanup path. `display` cannot
  // be used there: it is captured per-render, and the cleanup that matters
  // runs against a frame far newer than the one that registered it.
  const latestRef = useRef(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const from = fromRef.current;
    if (reduced || from === target) {
      fromRef.current = target;
      latestRef.current = target;
      setDisplay(target);
      return;
    }

    const duration = durationFor(from, target);
    const start = performance.now();

    const tick = (now: number) => {
      const elapsed = now - start;
      const value = valueAt(from, target, elapsed, duration);
      // Only re-render when the DISPLAYED step actually changes — compared on
      // the rendered STRING, never on the raw float.
      //
      // This is not a micro-optimisation, it is the correctness condition. Two
      // floats that differ in the fifteenth decimal render as the same two
      // decimals, and two that look equal after `toFixed` can differ as
      // numbers; comparing raw values therefore both re-renders identical
      // digits and, worse, lets the final frame decide the last visible step
      // was already on screen when it was not. Observed: the count rendered
      // 0.54 0.53 0.51 and dropped 0.52 entirely, at the one moment the eye is
      // on the number.
      const shown = value.toFixed(2);
      if (shown !== latestRef.current.toFixed(2)) {
        latestRef.current = value;
        setDisplay(value);
      }
      if (elapsed < duration) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        // Land on the exact target, compared the same way.
        if (target.toFixed(2) !== latestRef.current.toFixed(2)) setDisplay(target);
        // Latch it, so the next count starts from the committed number rather
        // than from whatever the last frame happened to render.
        fromRef.current = target;
        latestRef.current = target;
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      // Interrupted mid-count — a second commit, or a change of selection.
      // Resume from where the eye last saw the number, so a rapid second
      // change continues the motion rather than snapping back.
      fromRef.current = latestRef.current;
    };
  }, [target]);

  return display;
}
