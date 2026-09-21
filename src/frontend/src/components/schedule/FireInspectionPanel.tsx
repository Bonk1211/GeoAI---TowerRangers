import { useMemo, useState } from 'react';
import { CREWS } from '../../fixtures/crews';
import { placeName } from '../../fixtures/schedule';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import {
  useCrewsQuery,
  useFireExposureQuery,
  usePinOverride,
  usePreviewOverride,
} from '../../api/queries';
import { formatRelativeAge } from '../../lib/format';
import { Button } from '../ui/Panel';
import { OverridePreview } from './OverridePreview';
import type { OverridePreview as OverridePreviewType, ScheduleRun } from '../../api/types';

interface FireInspectionPanelProps {
  tower_id: string;
  day: string;
  onDone: () => void;
}

/**
 * Review a satellite hotspot near a tower, then schedule an inspection for it.
 *
 * This is the one place in the app where OBSERVED evidence turns into planned
 * work, and the whole panel is built around keeping those two things separable.
 * The hotspot is a 375 m thermal anomaly within 5 km over three days: it may be
 * a plantation burn, a flare or hot bare ground, and the tower may be entirely
 * untouched. So nothing here is automatic — the optimizer never proposed this
 * job, the model never saw the fire, and no band moved. A planner reads the
 * evidence, attests that an inspection is appropriate and that access is safe,
 * and only then does anything commit.
 *
 * Preview before pin, for the reason ReserveDetail records: POST /schedule/pin
 * returns a ScheduleRun, which carries no `dropped` field. Only the preview's
 * OverridePreview can say what this inspection would displace, and inserting
 * unplanned work into a planned week without showing that is how a planner
 * discovers the cost afterwards.
 *
 * The backend validates all of this again and is the real authority — see
 * _fire_evidence and _validate_inspection_slot in api/routes/schedule.py. This
 * panel refuses the same things for the same reasons so a planner learns why
 * before spending a request, but it never assumes the server agreed: every
 * refusal that comes back is surfaced verbatim, because its `detail` is the
 * operator-facing reason and is more specific than anything guessable here.
 */
export function FireInspectionPanel({ tower_id, day, onDone }: FireInspectionPanelProps) {
  const run = useScheduleStore((s) => s.run);
  const runId = useScheduleStore((s) => s.runId);
  const offlineRun = useScheduleStore((s) => s.offlineRun);
  const setRun = useScheduleStore((s) => s.setRun);
  const offline = offlineRun !== null;

  const crewsQuery = useCrewsQuery();
  const previewMutation = usePreviewOverride();
  const pinMutation = usePinOverride(runId);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);

  // Today in UTC, not the console's layer date. Historical windows stay
  // browsable on the map, but the backend refuses to schedule against one —
  // evidence that has had days to stop being true is not evidence to send a
  // crew on. Asking for the same date the server will check against means a
  // planner is never shown a snapshot id the pin would then reject.
  const today = new Date().toISOString().slice(0, 10);
  const { data: exposure, isPending } = useFireExposureQuery(today);

  const tower = towers.find((t) => t.tower_id === tower_id);
  const observed = exposure?.towers[tower_id];

  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<OverridePreviewType | null>(null);
  const [committed, setCommitted] = useState(false);
  const [dropped, setDropped] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [crewId, setCrewId] = useState('');
  const [targetDay, setTargetDay] = useState('');

  // Civil, and in the tower's OWN territory rather than the board's current
  // one. MoveControl filters on the store's `territory`, which defaults to
  // Selangor, so a tower anywhere else gets an empty dropdown and no
  // explanation — a bug worth not reproducing on a panel whose towers are, by
  // definition, wherever the fire happened to be.
  const crews = useMemo(() => {
    const all = crewsQuery.data ?? CREWS;
    const wanted = tower?.territory;
    return all.filter((c) => c.crew_type === 'civil' && (!wanted || c.territory === wanted));
  }, [crewsQuery.data, tower?.territory]);

  // The horizon's first entry is the run's own today, so everything in the
  // horizon is already non-past for this run. Posting anything outside it is a
  // 400: the board cannot draw a bar on a day it has no column for.
  const days = run.horizon;

  const crew = crewId || crews[0]?.crew_id || '';
  const when = targetDay || (days.includes(day) ? day : days[0] || '');

  // Block the FORM, not just the button. Mapping the in-flight state to "no
  // blocker" rendered the crew select, the day select, the confirmation switch
  // and an enabled Preview while the screening was still resolving — and the
  // first screening of a session is slow (19 s cold, measured). A planner who
  // confirmed and pressed Preview inside that window posted an empty
  // snapshot_id, which the backend refused with the WRONG reason: "the fire
  // snapshot changed since this review", about a review that had not loaded.
  const blocker = isPending
    ? 'Reading the current screening…'
    : offline
    ? 'Offline — hotspot screening is a live measurement with no honest stand-in, so an inspection cannot be reviewed or scheduled here.'
    : !runId
      ? 'No live schedule run is loaded, so there is no crew-day to schedule into. Open the Schedule tab first.'
      : !exposure
          ? 'Fire screening is unavailable, so there is no evidence to review. That is a missing screening pass, not an absence of fire.'
          : exposure.freshness.stale
            ? `The newest observation is ${
                exposure.freshness.source_age_hours === null
                  ? 'of unknown age'
                  : `${exposure.freshness.source_age_hours.toFixed(1)} h old`
              }, past the ${exposure.freshness.stale_after_hours} h limit for scheduling against it.`
            : !observed
              ? `No hotspot was detected within ${
                  exposure.screening.buffer_m / 1000
                } km of this tower in the current window, so there is nothing to inspect it for.`
              : !crews.length
                ? `No civil crew is rostered in ${
                    tower?.territory ?? 'this territory'
                  }, so this inspection cannot be assigned from here.`
                : !when
                  ? 'This run has no horizon, so there is no day to schedule into.'
                  : null;

  const body = () => ({
    tower_id,
    target_crew_id: crew,
    target_day: when,
    fire_inspection: {
      // Taken from the response the planner is looking at, never minted here.
      // If the source window moves between this read and the pin the ids stop
      // matching and the backend 409s — which is the whole point of deriving
      // the id from the window rather than per request.
      snapshot_id: exposure?.snapshot_id ?? '',
      safe_access_confirmed: confirmed,
    },
  });

  // The client appends FastAPI's `detail` after an em dash; strip the HTTP
  // preamble and keep the reason, which is the half a planner can act on.
  const reasonOf = (error: unknown) =>
    error instanceof Error
      ? error.message.replace(/^POST \S+ failed: \d+ [^—]*— ?/, '')
      : String(error);

  const runPreview = () => {
    setFailed(null);
    if (offline) return;
    if (!runId) return;
    previewMutation.mutate(
      { run_id: runId, ...body() },
      { onSuccess: setPreview, onError: (error) => setFailed(reasonOf(error)) },
    );
  };

  const commit = () => {
    setFailed(null);
    if (offline) return;
    if (!runId) return;
    pinMutation.mutate(body(), {
      onSuccess: (result) => {
        // Read off the RETURNED run, never off the preview. The preview was a
        // forecast of what the solver would do; this is what it did.
        const next = result as ScheduleRun;
        const before = new Set(run.unscheduled);
        setDropped(next.unscheduled.filter((id) => !before.has(id) && id !== tower_id));
        setRun(next);
        setPreview(null);
        setCommitted(true);
      },
      onError: (error) => setFailed(reasonOf(error)),
    });
  };

  if (committed) {
    const entry = run.entries.find((e) => e.tower_id === tower_id);
    return (
      <div className="p-5">
        <h3 className="h-title mb-2 text-lead">Inspection scheduled</h3>
        <p className="text-ui leading-relaxed text-muted">
          <span className="text-fg">{placeName(tower_id)}</span> is booked for a post-fire site
          inspection{entry ? ` on ${entry.day} with ${entry.crew_id}` : ''}. The reviewed evidence
          rides the work order, so the crew brief says which observation sent them.
        </p>
        {dropped.length > 0 ? (
          <p className="mt-3 text-ui leading-relaxed text-watch-ink">
            Unplanned work costs capacity: {dropped.map(placeName).join(', ')}{' '}
            {dropped.length === 1 ? 'is' : 'are'} now unscheduled.
          </p>
        ) : (
          <p className="mt-3 text-ui leading-relaxed text-dim">
            Nothing already booked was displaced.
          </p>
        )}
        <p className="mt-3 text-micro leading-snug text-dim">
          This changes no part of the tower&rsquo;s score: not its risk, not its decision band,
          not its factor shares.
        </p>
        <div className="mt-4">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5">
      <h3 className="h-title mb-1 text-lead">Fire exposure &mdash; review inspection</h3>
      <p className="text-micro leading-snug text-dim">
        {placeName(tower_id)}
        {tower?.territory ? ` · ${tower.territory}` : ''}
      </p>

      {isPending && (
        <p role="status" className="mt-4 text-ui text-dim">
          Reading the current screening…
        </p>
      )}

      {observed && exposure && (
        <dl className="mt-4 space-y-1.5 rounded-xl border border-overlay/[0.10] bg-overlay/[0.03] p-3 text-micro">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">
              Detection-days within {exposure.screening.buffer_m / 1000} km
            </dt>
            <dd className="tnum text-fg">{observed.hotspot_pixel_days}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">Most recent</dt>
            <dd className="tnum text-fg">{formatRelativeAge(observed.latest_acquisition)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">Confidence</dt>
            <dd className="text-fg">{observed.max_confidence}</dd>
          </div>
          <p className="border-t border-overlay/[0.09] pt-1.5 text-eyebrow leading-snug text-dim">
            A detection-day counts satellite pixels over {exposure.screening.window_days} days at{' '}
            {exposure.screening.resolution_m} m,{' '}
            {exposure.screening.confidence_included.join(' and ')} confidence only. It is not a
            fire at this site and not a damage assessment.
          </p>
        </dl>
      )}

      {blocker ? (
        <p className="mt-4 text-ui leading-relaxed text-dim">{blocker}</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-eyebrow text-muted">Crew</span>
              <select
                value={crew}
                onChange={(event) => {
                  setCrewId(event.target.value);
                  setPreview(null);
                }}
                className="h-8 w-full rounded-lg border border-overlay/[0.14] bg-ink-900 px-2 text-micro text-fg"
              >
                {crews.map((c) => (
                  <option key={c.crew_id} value={c.crew_id}>
                    {c.crew_id} · {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-eyebrow text-muted">Day</span>
              <select
                value={when}
                onChange={(event) => {
                  setTargetDay(event.target.value);
                  setPreview(null);
                }}
                className="tnum h-8 w-full rounded-lg border border-overlay/[0.14] bg-ink-900 px-2 text-micro text-fg"
              >
                {days.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Two attestations, one control, and the label states both. Splitting
              them would let a planner confirm the site is reachable without ever
              judging whether a visit is warranted — and a hotspot inside the
              buffer is not on its own a reason to send anyone. */}
          <button
            type="button"
            role="switch"
            aria-checked={confirmed}
            onClick={() => {
              setConfirmed((value) => !value);
              setPreview(null);
            }}
            className="mt-3 flex w-full items-start justify-between gap-3 rounded-lg py-1 text-left"
          >
            <span className="text-micro leading-snug text-muted">
              I have reviewed this observation, an inspection is appropriate for this site, and
              access is safe.
            </span>
            <span
              aria-hidden="true"
              className={`relative mt-0.5 h-[15px] w-[27px] shrink-0 rounded-full transition-colors ${
                confirmed ? 'bg-accent' : 'bg-overlay/20'
              }`}
            >
              <span
                className={`absolute top-[2px] h-[11px] w-[11px] rounded-full bg-ink-900 shadow-sm transition-[left] ${
                  confirmed ? 'left-[14px]' : 'left-[2px]'
                }`}
              />
            </span>
          </button>

          <div className="mt-4 flex gap-2">
            <Button
              tone="primary"
              onClick={runPreview}
              disabled={!confirmed || previewMutation.isPending}
              title={confirmed ? undefined : 'Confirm the review and safe access first'}
            >
              {previewMutation.isPending ? 'Checking…' : 'Preview'}
            </Button>
            <Button onClick={onDone}>Cancel</Button>
          </div>
          {!confirmed && (
            <p className="mt-2 text-micro leading-snug text-dim">
              Nothing is sent until you confirm. Scheduling an inspection books a civil crew for
              two hours against a week that is already planned.
            </p>
          )}
        </>
      )}

      {failed && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-overlay/[0.14] bg-overlay/[0.05] p-2.5 text-micro leading-snug text-muted"
        >
          {failed} Nothing was scheduled.
        </p>
      )}

      {preview && (
        <div className="-mx-5 mt-4">
          <OverridePreview preview={preview} onConfirm={commit} onCancel={() => setPreview(null)} />
        </div>
      )}
    </div>
  );
}
