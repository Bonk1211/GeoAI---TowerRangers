import { useMitigations } from '../../state/useMitigations';

/**
 * Says, permanently and unmissably, that the map is showing a hypothetical.
 *
 * Same contract `OfflineBanner` keeps with `useOffline`, and it exists for the
 * same reason: a screen narrated as live while quietly showing something else
 * is the single most dangerous failure this app can produce. A modelled score
 * is exactly that — it describes a site with a plinth nobody has poured.
 *
 * Rendered whenever ANY tower carries modelled protection, not only while the
 * panel is open. The realistic failure is a judge or a colleague walking up to
 * a laptop mid-demo, reading a lightened cluster as the live fleet, and
 * carrying that away; the banner has to be on screen at that moment, which
 * means it cannot be tied to a panel's lifetime.
 *
 * WARM, DELIBERATELY. The app's rule is that warm hue is data and cool accent
 * is chrome, and a banner is chrome — but this one is making a statement about
 * the DATA's provenance, which is the same job `OfflineBanner` does in
 * `watch`. Matching it keeps "the numbers on screen are not the served
 * numbers" reading as one visual idea in both cases rather than two.
 */
export function ProtectionBanner() {
  const applied = useMitigations((s) => s.applied);
  const reset = useMitigations((s) => s.reset);
  const count = Object.keys(applied).length;
  if (count === 0) return null;

  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center justify-center gap-2 border-b border-watch/30 bg-watch/15 px-3 text-ui font-medium text-watch-ink"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-watch" />
      Modelled protection on <span className="tnum">{count}</span>{' '}
      {count === 1 ? 'tower' : 'towers'} — hypothetical scores, nothing dispatched.
      <button
        type="button"
        onClick={reset}
        className="ml-1 rounded border border-watch/40 px-1.5 py-px text-micro font-semibold uppercase tracking-wider transition-colors hover:bg-watch/20"
      >
        Reset
      </button>
    </div>
  );
}
