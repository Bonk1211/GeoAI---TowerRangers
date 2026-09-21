import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isScored } from '../../fixtures/towers';
import { useSelection } from '../../state/useSelection';
import { useWeights } from '../../state/useWeights';
import { useScheduleSelection } from '../../state/useScheduleSelection';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useLiveTower } from '../../api/useLiveTowers';
import { useFireExposureQuery } from '../../api/queries';
import { useFloodLayers } from '../../state/useFloodLayers';
import { placeName } from '../../fixtures/schedule';
import { AttributionBars } from '../tower/AttributionBars';
import { formatInterval, decisionLabel, formatRelativeAge } from '../../lib/format';
import { bandColor, bandInk } from '../../lib/colors';
import { SiteSurroundings } from '../tower/SiteSurroundings';
import { dispatchDayFor, NO_DISPATCH_DAY_REASON } from '../../lib/dispatchTarget';
import { Button } from '../ui/Panel';
import { CountingRisk } from '../ui/CountingRisk';
import { ProtectionPanel } from './ProtectionPanel';
import { useMitigations } from '../../state/useMitigations';

// Backstop deadline from src/backend/config/policy.yaml (`sla.fallback_sla_days`).
// That file is the source of truth; it is not exposed over the API and the
// backend is out of scope for this redesign, so it is mirrored here rather than
// fetched. If the YAML changes, this changes with it.
const SLA_CAP_DAYS = 30;

/**
 * The right HUD column. Renders the same reading TowerDrawer renders on the
 * tower detail route, laid out for a floating column rather than a full-height
 * drawer.
 *
 * The column keeps its width in the empty state so selecting a tower does not
 * shift the layout underneath the pointer that just clicked it.
 */
export function SelectionHud() {
  const selectedTowerId = useSelection((s) => s.selectedTowerId);
  const weights = useWeights((s) => s.weights);
  const setHighlightedTower = useScheduleSelection((s) => s.setHighlightedTower);
  const select = useScheduleStore((s) => s.select);
  const run = useScheduleStore((s) => s.run);
  const navigate = useNavigate();
  const tower = useLiveTower(selectedTowerId, weights);
  const [protectOpen, setProtectOpen] = useState(false);
  const protectedMitigation = useMitigations((s) =>
    selectedTowerId ? s.applied[selectedTowerId] : undefined,
  );

  // BRING THE SCORE BACK INTO VIEW WHEN IT MOVES.
  //
  // The mitigation list is long enough to push the Risk index readout off the
  // top of this scrolling column — which is exactly where a reader is left
  // after choosing an option, since choosing one means scrolling down to it.
  // The console then runs over the map, the protection commits, and the number
  // counts down somewhere above the fold: the one moment the whole surface
  // exists to show, happening off screen. Observed on a real run.
  //
  // So on commit the readout is scrolled back to and briefly washed with the
  // accent, giving the eye somewhere to land before the count starts. The wash
  // is chrome, not data — it says "look here", not "this is a band" — which is
  // what keeps it on the cool accent rather than a severity hue.
  const riskRef = useRef<HTMLDivElement | null>(null);
  const [justProtected, setJustProtected] = useState(false);
  useEffect(() => {
    if (!protectedMitigation) return;
    // `block: 'center'` rather than 'start': the readout sits directly under a
    // sticky-ish header in a short column, and aligning to the top can leave it
    // flush against the edge where it reads as clipped.
    riskRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setJustProtected(true);
    const timer = window.setTimeout(() => setJustProtected(false), 1800);
    return () => window.clearTimeout(timer);
    // Keyed on the tower as well, so protecting a SECOND tower re-runs this
    // rather than being swallowed because `protectedMitigation` happens to
    // hold the same mitigation id as the last one.
  }, [protectedMitigation, selectedTowerId]);
  // Keyed on the SAME date the layer panel is showing, so this card and the
  // hotspot raster beside it can never describe different days. Called here
  // with the other hooks rather than inside the scored branch below: this
  // component early-returns for a null tower, and a hook after that return
  // throws on the first render with nothing selected.
  const layerDate = useFloodLayers((s) => s.date);
  const { data: fireExposure, isPending: firePending } = useFireExposureQuery(layerDate);
  const fire = fireExposure?.towers[tower?.tower_id ?? ''];

  const shell =
    'glass-float scroll-thin pointer-events-auto min-h-0 overflow-y-auto rounded-[14px]';

  if (!tower) {
    return (
      <aside className={shell} aria-label="Selected tower">
        <div className="border-b border-overlay/[0.09] px-4 py-3.5">
          <h2 className="eyebrow">No selection</h2>
        </div>
        <p className="px-4 py-4 text-ui text-muted">Click a tower to read its score.</p>
      </aside>
    );
  }

  const scored = isScored(tower);
  const name = placeName(tower.tower_id);
  const entry = scored ? run.entries.find((e) => e.tower_id === tower.tower_id) : undefined;
  const unscheduled = scored && !entry && run.unscheduled.includes(tower.tower_id);
  const band = scored ? bandColor(tower.decision) : undefined;
  const ink = scored ? bandInk(tower.decision) : undefined;

  const scheduledDay = entry
    ? new Date(entry.day).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : null;

  // null until a run exists to dispatch into — see lib/dispatchTarget.ts.
  // The button says why rather than creating a day-less emergency selection.
  const dispatchDay = dispatchDayFor(run, tower.tower_id);

  const dispatchNow = () => {
    if (dispatchDay === null) return;
    select({ kind: 'emergency', tower_id: tower.tower_id, day: dispatchDay });
    setHighlightedTower(tower.tower_id);
    navigate('/schedule');
  };

  return (
    <aside className={`${shell} flex-1`} aria-label="Selected tower">
      <header className="flex items-start justify-between gap-3 border-b border-overlay/[0.09] px-4 py-3.5">
        <div className="min-w-0">
          <h2 className="eyebrow text-accent">Selected</h2>
          <p className="mt-1 truncate h-title text-lead">
            {name}
          </p>
          {name !== tower.tower_id && <p className="font-mono text-eyebrow text-dim">{tower.tower_id}</p>}
        </div>
        {scored ? (
          <span
            className="shrink-0 rounded-md border px-2 py-1 text-eyebrow font-semibold uppercase tracking-wider"
            style={{ color: ink, borderColor: `${band}66`, backgroundColor: `${band}1a` }}
          >
            {decisionLabel(tower.decision)}
          </span>
        ) : (
          <span className="shrink-0 rounded-md border border-overlay/[0.12] bg-overlay/[0.05] px-2 py-1 text-eyebrow font-semibold uppercase tracking-wider text-dim">
            Not scored
          </span>
        )}
      </header>

      {!scored ? (
        <>
          <p className="px-4 py-4 text-ui leading-relaxed text-muted">
            This tower has no score in the current area. Its surroundings are shown below.
          </p>
          <SiteSurroundings tower={tower} />
        </>
      ) : (
        <>
          <div
            ref={riskRef}
            className={`flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-500 ${
              justProtected ? 'bg-accent/[0.07]' : ''
            }`}
          >
            <div>
              <p className="text-micro text-muted">Risk index</p>
              {/* Counts to its new value rather than jumping, so a modelled
                  protection reads as something that MOVED the score. Display
                  only — every consumer of `tower.risk` sees the committed
                  number throughout. */}
              <p className="text-title font-semibold" style={{ color: ink }}>
                <CountingRisk value={tower.risk} />
              </p>
              <p className="text-micro tnum text-dim">{formatInterval(tower.risk_lo, tower.risk_hi)}</p>
            </div>
            <div className="text-right">
              <p className="text-micro text-muted">Maintain within</p>
              <p className="text-title font-semibold tnum text-fg">{tower.urgency_days} days</p>
              <p className="text-micro text-dim">SLA cap {SLA_CAP_DAYS} d</p>
            </div>
          </div>

          <SiteSurroundings tower={tower} />

          <details className="border-t border-overlay/[0.09] px-4 py-3">
            <summary className="cursor-pointer text-ui font-medium text-muted">Model details</summary>
            <div className="mt-3"><AttributionBars attribution={tower.attribution} /></div>
          </details>

          {/* Fire screening is independent of model attribution. Missing data
              must not be rendered as an all-clear. */}
          {!firePending && (
            <details className="border-t border-overlay/[0.09] px-4 py-3">
              <summary className="mb-1.5 cursor-pointer text-ui font-medium text-muted">Fire exposure · observed</summary>
              {!fireExposure ? (
                <p className="text-micro leading-snug text-dim">
                  Screening unavailable &mdash; no hotspot evidence for this site. That is a
                  missing pass, not an all-clear.
                </p>
              ) : fire ? (
                <p className="text-micro leading-snug text-muted">
                  <span className="tnum text-fg">{fire.hotspot_pixel_days}</span> detection-days
                  within{' '}
                  <span className="tnum text-fg">
                    {fireExposure.screening.buffer_m / 1000} km
                  </span>{' '}
                  over {fireExposure.screening.window_days} days, most recent{' '}
                  <span className="tnum text-fg">
                    {formatRelativeAge(fire.latest_acquisition)}
                  </span>{' '}
                  ({fire.max_confidence} confidence). A thermal anomaly near the site, not a
                  fire at it &mdash; and no part of this tower&rsquo;s score.
                </p>
              ) : (
                <p className="text-micro leading-snug text-dim">
                  No detections within{' '}
                  <span className="tnum">{fireExposure.screening.buffer_m / 1000} km</span> in the
                  last {fireExposure.screening.window_days} days.
                </p>
              )}
            </details>
          )}

          {entry && (
            <div className="border-t border-overlay/[0.09] px-4 py-3.5">
              <h3 className="eyebrow mb-2">Work order</h3>
              <p className="text-body leading-snug text-fg">{entry.work_order.action}</p>
              <p className="mt-1.5 text-micro text-muted">
                {entry.crew_id} · {entry.work_order.crew_type} · {scheduledDay}
              </p>
            </div>
          )}

          {unscheduled && (
            <p className="mx-4 mb-3 rounded-lg border border-maintain/35 bg-maintain/10 px-3 py-2 text-micro leading-snug text-maintain-ink">
              Unscheduled — no crew capacity left this week. Dispatch it now to displace lower-risk
              work.
            </p>
          )}

          {/* TWO KINDS OF ACTION, AND THE DIFFERENCE IS THE POINT.
              `Dispatch now` sends a crew and deliberately does NOT move this
              tower's score — a visit fixes equipment, it does not raise the
              ground the mast stands on. `Model protection` models works that
              DO change the site, and the score moves because an input changed
              and the model was re-run. Showing them side by side is what keeps
              a planner from reading a dispatch as a site made safe. */}
          {(protectOpen || protectedMitigation) && (
            <ProtectionPanel tower={tower} onClose={() => setProtectOpen(false)} />
          )}

          <div className="border-t border-overlay/[0.09] p-4">
            <div className="flex gap-2">
              <Button
                tone="ghost"
                onClick={() => navigate(`/tower/${tower.tower_id}`)}
                className="h-9 flex-1"
              >
                Details
              </Button>
              <Button
                tone="danger"
                onClick={dispatchNow}
                disabled={dispatchDay === null}
                title={dispatchDay === null ? NO_DISPATCH_DAY_REASON : undefined}
                className="h-9 flex-1"
              >
                Dispatch now
              </Button>
            </div>
            {!protectedMitigation && (
              <Button
                tone="primary"
                onClick={() => setProtectOpen((open) => !open)}
                aria-expanded={protectOpen}
                className="mt-2 h-9 w-full"
              >
                {protectOpen ? 'Hide protection options' : 'Model protection'}
              </Button>
            )}
            {dispatchDay === null && (
              <p className="mt-2 text-micro leading-relaxed text-dim">{NO_DISPATCH_DAY_REASON}</p>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
