import { useNavigate } from 'react-router-dom';
import { isScored } from '../../fixtures/towers';
import { useSelection } from '../../state/useSelection';
import { useWeights } from '../../state/useWeights';
import { useScheduleSelection } from '../../state/useScheduleSelection';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useLiveTower } from '../../api/useLiveTowers';
import { placeName } from '../../fixtures/schedule';
import { AttributionBars } from './AttributionBars';
import { WorkOrderCard } from './WorkOrderCard';
import { TimelineStrip } from './TimelineStrip';
import { formatInterval, formatRisk, formatUrgency, decisionLabel } from '../../lib/format';
import { bandColor, bandInk } from '../../lib/colors';
import { dispatchDayFor, NO_DISPATCH_DAY_REASON } from '../../lib/dispatchTarget';
import { approximateBaselineDays, daysOld, driverPhrase, movedForward } from '../../lib/weather';
import { Button } from '../ui/Panel';

export function TowerDrawer() {
  const selectedTowerId = useSelection((s) => s.selectedTowerId);
  const weights = useWeights((s) => s.weights);
  const setHighlightedTower = useScheduleSelection((s) => s.setHighlightedTower);
  const select = useScheduleStore((s) => s.select);
  const run = useScheduleStore((s) => s.run);
  const navigate = useNavigate();
  const tower = useLiveTower(selectedTowerId, weights);

  if (!tower) {
    return (
      <aside className="glass-raised hidden h-full w-[340px] shrink-0 flex-col items-center justify-center border-y-0 border-r-0 p-8 text-center lg:flex">
        <p className="text-body leading-relaxed text-dim">
          Select a tower on the map to see its risk breakdown, work order and scheduled visit.
        </p>
      </aside>
    );
  }

  const scored = isScored(tower);
  // Look up against the live schedule run populated by useLiveSchedule().
  const entry = scored ? run.entries.find((e) => e.tower_id === tower.tower_id) : undefined;
  const unscheduled = scored && !entry && run.unscheduled.includes(tower.tower_id);
  const goToSchedule = () => {
    setHighlightedTower(tower.tower_id);
    navigate('/schedule');
  };

  // See lib/dispatchTarget.ts: null when no run has been loaded yet, so the
  // button states that instead of posting an empty target_day.
  const dispatchDay = dispatchDayFor(run, tower.tower_id);

  const dispatchNow = () => {
    if (dispatchDay === null) return;
    select({ kind: 'emergency', tower_id: tower.tower_id, day: dispatchDay });
    navigate('/schedule');
  };

  const openDetail = () => {
    navigate(`/investigation/${tower.tower_id}`);
  };

  const band = scored ? bandColor(tower.decision) : undefined;
  const ink = scored ? bandInk(tower.decision) : undefined;

  return (
    <aside
      className="glass-raised spine scroll-thin flex h-full w-[360px] shrink-0 flex-col overflow-y-auto border-y-0 border-r-0"
      style={band ? ({ '--spine': band } as React.CSSProperties) : undefined}
    >
      <header className="flex items-center justify-between gap-3 border-b border-overlay/10 px-5 py-4">
        <div className="min-w-0">
          <h2 className="h-title text-lead">
            {placeName(tower.tower_id)}
          </h2>
          <p className="font-mono text-micro text-dim">{tower.tower_id}</p>
        </div>
        {scored ? (
          <span
            className="shrink-0 rounded-md border px-2 py-1 text-eyebrow font-semibold uppercase tracking-wider"
            style={{ color: ink, borderColor: `${band}66`, backgroundColor: `${band}1a` }}
          >
            {decisionLabel(tower.decision)}
          </span>
        ) : (
          <span className="shrink-0 rounded-md border border-overlay/12 bg-overlay/[0.05] px-2 py-1 text-eyebrow font-semibold uppercase tracking-wider text-dim">
            Not scored
          </span>
        )}
      </header>

      {!scored ? (
        <p className="p-5 text-ui leading-relaxed text-muted">
          This tower sits outside the current perception AOI, so it has no score yet. Rerun the pipeline with a
          bounding box that covers it.
        </p>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <div className="px-1 pb-1">
            <div className="flex items-baseline gap-2.5">
              <span
                className="font-display text-hero font-semibold leading-none tracking-tight tnum"
                style={{ color: ink }}
              >
                {formatRisk(tower.risk)}
              </span>
              <span className="text-ui tnum text-dim">{formatInterval(tower.risk_lo, tower.risk_hi)}</span>
            </div>
            <p className="mt-2 text-ui text-muted">
              <span className="text-fg">{tower.radio}</span> · maintain{' '}
              <span className="text-fg">{formatUrgency(tower.urgency_days)}</span>
            </p>
            {/* Shown only when a forecast actually moved the date. Absent when
                tower.weather is null ("no forecast applied") — saying nothing
                is honest there; a "forecast quiet" note would not be. */}
            {movedForward(tower.weather) && (
              <p className="mt-1.5 text-micro leading-snug text-watch-ink">
                Brought forward from about{' '}
                {approximateBaselineDays(tower.urgency_days, tower.weather)} days —{' '}
                {driverPhrase(tower.weather)}.
                <span className="block text-dim">
                  GFS run {new Date(tower.weather.issued_at).toISOString().slice(0, 16).replace('T', ' ')} UTC
                  {tower.weather.observed_at
                    ? ` · soil moisture observed ${daysOld(tower.weather.observed_at)} d ago`
                    : ''}
                </span>
              </p>
            )}
          </div>

          <div className="glass rounded-xl p-4">
            <h3 className="eyebrow mb-3">Why this score</h3>
            <AttributionBars attribution={tower.attribution} />
          </div>

          {entry && (
            <div className="glass rounded-xl">
              <WorkOrderCard workOrder={entry.work_order} />
            </div>
          )}

          <div className="glass rounded-xl">
            <TimelineStrip scheduledDate={entry?.day} urgencyDays={tower.urgency_days} />
          </div>

          {entry ? (
            <button
              type="button"
              onClick={goToSchedule}
              className="group rounded-xl border border-overlay/12 bg-overlay/[0.04] p-4 text-left transition-colors duration-150 hover:border-accent/45 hover:bg-accent/10"
            >
              <span className="eyebrow">Scheduled visit</span>
              <span className="mt-1.5 block text-body text-fg">
                {entry.crew_id} ·{' '}
                {new Date(entry.day).toLocaleDateString('en-GB', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
              </span>
              <span className="mt-2 block text-ui text-accent">View in schedule →</span>
            </button>
          ) : unscheduled ? (
            <p className="rounded-lg border border-maintain/35 bg-maintain/10 px-3 py-2 text-ui leading-snug text-maintain-ink">
              Unscheduled — no crew capacity left this week. Dispatch it now to displace lower-risk work.
            </p>
          ) : null}

          <div className="mt-1">
            <div className="flex gap-2">
              <Button tone="ghost" onClick={openDetail} className="flex-1">
                More details →
              </Button>
              <Button
                tone="danger"
                onClick={dispatchNow}
                disabled={dispatchDay === null}
                title={dispatchDay === null ? NO_DISPATCH_DAY_REASON : undefined}
                className="flex-1"
              >
                Dispatch a crew now
              </Button>
            </div>
            {dispatchDay === null && (
              <p className="mt-2 text-micro leading-relaxed text-dim">{NO_DISPATCH_DAY_REASON}</p>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
