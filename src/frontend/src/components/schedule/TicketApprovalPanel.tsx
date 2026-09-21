import { useEffect, useMemo, useRef, useState } from 'react';
import { CREWS } from '../../fixtures/crews';
import { placeName, hasPlaceName } from '../../fixtures/schedule';
import { dayLabel } from '../../lib/scheduleDays';
import { rankCandidateCrews } from '../../lib/ticketSkills';
import { rankSuggestions, type MeasuredLeg } from '../../lib/ticketSuggestion';
import { crewPositionNow } from '../../lib/crewPosition';
import { roleTeam } from '../../lib/roleTeams';
import { roleColor, roleInk, tintedChip } from '../../lib/roleColors';
import { bandColor, bandInk } from '../../lib/colors';
import { slaStatus, reportedAgeLabel } from '../../lib/ticketUrgency';
import type { SlaLevel } from '../../lib/ticketUrgency';
import { summarizeImpact, costLabel } from '../../lib/dispatchImpact';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useTicketStore } from '../../state/useTicketStore';
import { useWeights } from '../../state/useWeights';
import { useLiveTower, useLiveTowers } from '../../api/useLiveTowers';
import { useCrewsQuery, usePinOverride, useTravelLegsQuery } from '../../api/queries';
// Called directly rather than through a useMutation hook — see the fan-out
// effect below for why a shared mutation observer cannot serve it.
import { previewOverride } from '../../api/client';
import { Button } from '../ui/Panel';
import { DispatchRoutePreview } from './DispatchRoutePreview';
import type { OverridePreview, ScheduleRun } from '../../api/types';
import type { DispatchMove } from '../../lib/dispatchAnimation';

interface TicketApprovalPanelProps {
  ticket_id: string;
  day: string;
  onDone: () => void;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Each level gets a glyph as well as a hue. An SLA breach is exactly the kind
 * of fact that must survive a monochrome screenshot or a red-green colour
 * deficiency, so the shape carries it too (WCAG color-not-only).
 */
const SLA_TONE: Record<SlaLevel, { cls: string; glyph: string }> = {
  breach: { cls: 'border-alert/40 bg-alert/[0.10] text-alert-ink', glyph: '!' },
  due: { cls: 'border-watch/40 bg-watch/[0.12] text-watch-ink', glyph: '!' },
  tight: { cls: 'border-watch/35 bg-watch/[0.09] text-watch-ink', glyph: '~' },
  ok: { cls: 'border-ok/35 bg-ok/[0.09] text-ok-ink', glyph: '✓' },
  none: { cls: 'border-overlay/15 bg-overlay/[0.04] text-dim', glyph: '–' },
};

/** Section heading plus its step number, so the panel reads as a sequence. */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <h4 className="eyebrow mt-5 mb-2 flex items-center gap-2">
      {/* tracking-normal: .eyebrow sets 0.14em letter-spacing, which on a
          single digit is trailing space that pushes it off the circle's
          centre. */}
      <span className="tnum flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-overlay/10 text-eyebrow font-bold tracking-normal text-muted">
        {n}
      </span>
      {children}
    </h4>
  );
}

/**
 * Shown while the solver works out the impact. A shaped placeholder rather
 * than a line of prose, because the block it stands in for is a list whose
 * height the planner is about to read — collapsing it to one line and then
 * expanding shifts every control below it (CLS).
 */
function ImpactSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-3.5 animate-pulse rounded bg-overlay/[0.07]"
          style={{ width: `${88 - i * 14}%`, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ok'; data: OverridePreview }
  | { status: 'error' };

/**
 * How many candidates get priced up front. Every eligible crew is still
 * OFFERED — this only bounds how many are costed without being asked for, so a
 * 30-crew roster in a dense territory cannot turn opening a panel into thirty
 * re-solves. Five covers every shortlist observed on the live national run.
 */
const MAX_PRICED_CANDIDATES = 5;

/** One headline number. The unit sits under the figure, never inside it. */
function Verdict({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warn' | 'good';
}) {
  const ink =
    tone === 'warn' ? 'text-watch-ink' : tone === 'good' ? 'text-ok-ink' : 'text-fg';
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-overlay/10 bg-overlay/[0.03] px-2.5 py-2">
      <div className={`tnum truncate text-lead font-semibold ${ink}`}>{value}</div>
      {/* Wraps rather than truncates. At three across in a 380px panel
          "risk-weighted wait" does not fit on one line, and it rendered as
          "RISK-WEIGHT…" — a metric name is not a place to spend an ellipsis,
          since the truncated form is the only thing saying what the number
          above it measures. */}
      <div className="eyebrow mt-0.5 leading-tight text-dim">{label}</div>
    </div>
  );
}

/**
 * The SHAPE of the disruption, which is what the per-tower list was being read
 * for and could not show. Bars are the neutral overlay ramp on purpose: a
 * rescheduled job is displacement, not severity, and the warm triad is
 * reserved for work that actually falls off the plan (see `dropped` below).
 * Every bar carries its own count, so the reading survives without colour.
 */
function MoveDistribution({
  buckets,
  max,
}: {
  buckets: { delta: number; count: number }[];
  max: number;
}) {
  return (
    <ul className="space-y-1">
      {buckets.map((b) => (
        <li key={b.delta} className="flex items-center gap-2">
          <span className="tnum w-8 shrink-0 text-right text-micro text-muted">
            {b.delta > 0 ? '+' : '−'}
            {Math.abs(b.delta)}d
          </span>
          <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-overlay/[0.06]">
            <span
              className="block h-full rounded-sm bg-overlay/30"
              style={{ width: `${max > 0 ? (b.count / max) * 100 : 0}%` }}
            />
          </span>
          <span className="tnum w-5 shrink-0 text-micro text-muted">{b.count}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The approval half of docs/Ticket_To_Schedule_Handoff.md §1.
 *
 * A ticket reaches here already flagged schedule_pending by useAutoDispatch;
 * nothing has been booked. This panel proposes a crew, shows what committing
 * it costs the work already on the board, and only then commits — the pin is
 * what unlocks the ticket's Active state, via markScheduled(). Rejecting calls
 * markScheduleFailed(), which leaves the ticket Open with the drawer's retry
 * hint. Those two actions are the ONLY ways this flow may move a ticket;
 * setStatus/assignCrew carry manual-path semantics the drawer reads
 * differently.
 */
export function TicketApprovalPanel({ ticket_id, day, onDone }: TicketApprovalPanelProps) {
  const tickets = useTicketStore((s) => s.tickets);
  const ticket = tickets.find((t) => t.ticket_id === ticket_id);
  const markScheduled = useTicketStore((s) => s.markScheduled);
  const markScheduleFailed = useTicketStore((s) => s.markScheduleFailed);

  const run = useScheduleStore((s) => s.run);
  const runId = useScheduleStore((s) => s.runId);
  const setRun = useScheduleStore((s) => s.setRun);
  const setTerritory = useScheduleStore((s) => s.setTerritory);
  const setViewMode = useScheduleStore((s) => s.setViewMode);
  const setDispatchAnimation = useScheduleStore((s) => s.setDispatchAnimation);
  const replayDispatchAnimation = useScheduleStore((s) => s.replayDispatchAnimation);
  const clearDispatchAnimation = useScheduleStore((s) => s.clearDispatchAnimation);
  const setAgentOpen = useScheduleStore((s) => s.setAgentOpen);

  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const tower = useLiveTower(ticket?.tower_id ?? null, weights);
  const crewsQuery = useCrewsQuery();

  const pinMutation = usePinOverride(runId);

  const [suggestIndex, setSuggestIndex] = useState(0);
  // Keyed by crew, not a single slot, so every candidate can carry its own
  // price. Measured: one preview is ~40 ms against a live national run, so
  // pricing the whole shortlist costs less than the panel's own map tiles.
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  // Which (run, tower, day, crew) combinations have already been asked for.
  // A ref rather than derived from `previews`, because reading that state to
  // decide whether to request would put it in the effect's deps and loop.
  const requested = useRef<Set<string>>(new Set());
  // Unmount, NOT effect re-run. Guarding the writes below with a per-effect
  // flag looked equivalent and was not: `candidateKey` changes the moment the
  // measured travel legs arrive, so the effect re-ran while the first previews
  // were still in flight, its cleanup voided their writes, and the re-run
  // skipped them as already-requested. Every candidate then sat on "pricing…"
  // forever while the network tab showed three 200s. Verified in the browser.
  //
  // The re-arm on the way IN is load-bearing, not defensive: StrictMode runs
  // mount -> cleanup -> mount in dev, so a cleanup-only version latched the
  // flag false on the first teardown and never lifted it. Every response then
  // landed on a component that believed it was gone, and because `requested`
  // is a ref it survived the same teardown and skipped the re-request. Same
  // observed symptom as the bug above — 200s in the network tab, "pricing…"
  // on screen — from a different cause.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [committed, setCommitted] = useState<{
    crew_id: string;
    dropped: string[];
    moved: DispatchMove[];
  } | null>(null);
  const [commitFailed, setCommitFailed] = useState(false);
  const [confirmingReject, setConfirmingReject] = useState(false);

  // Resolved once per panel session on purpose. A "now" that advanced on every
  // render would re-rank the crews under the planner's cursor mid-decision.
  const [nowMin] = useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });

  const towerCoords = useMemo(
    () => new Map(towers.map((t) => [t.tower_id, { lon: t.lon, lat: t.lat }])),
    [towers],
  );

  const entriesToday = useMemo(() => run.entries.filter((e) => e.day === day), [run.entries, day]);

  const crews = crewsQuery.data ?? CREWS;

  // Where each eligible crew IS right now, resolved before the ranking so the
  // legs can be asked for in ONE request rather than one per candidate.
  const positionKeys = useMemo(() => {
    if (!ticket || !tower) return [];
    const keys = crews.map(
      (c) => crewPositionNow(c, entriesToday, nowMin, towerCoords, placeName).key,
    );
    return [...new Set(keys)];
  }, [ticket, tower, crews, entriesToday, nowMin, towerCoords]);

  const legsQuery = useTravelLegsQuery(positionKeys, ticket?.tower_id ?? null);
  const measured = useMemo(() => {
    const m = new Map<string, MeasuredLeg>();
    for (const l of legsQuery.data?.legs ?? []) {
      m.set(l.origin, { km: l.km, minutes: l.minutes, reachable: l.reachable });
    }
    return m;
  }, [legsQuery.data]);

  const suggestions = useMemo(() => {
    if (!ticket || !tower) return [];
    // Live tower AND live roster, both required: rankCandidateCrews' fixture
    // fallbacks cannot resolve a real OSM tower_id (it would return [] and read
    // as "no crew in range"), and the 12-crew fixture cannot offer the crew the
    // solver actually has in that state.
    //
    // limit = roster size, not the default 3: this returns the eligible POOL,
    // which rankSuggestions then re-orders by live position. The default would
    // silently truncate to the three nearest DEPOTS first.
    const eligible = rankCandidateCrews(ticket, { tower, crews, limit: crews.length });
    return rankSuggestions(
      eligible, entriesToday, tower, nowMin, towerCoords, placeName, measured,
    );
  }, [ticket, tower, crews, entriesToday, nowMin, towerCoords, measured]);

  // Only computed when there is nothing to suggest, and only to say WHY.
  // These crews are out of range by definition and must never be offered as a
  // choice — the range limit is a real operational constraint, not a
  // formality the panel gets to wave through.
  const outOfRange = useMemo(() => {
    if (!ticket || !tower || suggestions.length > 0) return [];
    return rankCandidateCrews(ticket, { tower, crews, limit: 2, ignoreRange: true });
  }, [ticket, tower, crews, suggestions.length]);

  const suggestion = suggestions[suggestIndex];
  const suggestedCrewId = suggestion?.crew.crew_id;
  const suggestedTerritory = suggestion?.crew.territory;
  const towerId = ticket?.tower_id;

  // Point the board at the territory the proposed crew belongs to.
  //
  // The board (useTerritoryRun) draws ONE territory's crews, and the week
  // strip's job counts are scoped the same way — so approving a Johor crew
  // while the selector reads Selangor books a real crew-day that is invisible
  // on screen: no new lane, and Tue 8 still reads "1 job". The planner
  // correctly reports that nothing happened. Following the suggestion means
  // the before state, the change, and the after state all happen in view.
  // This only moves the viewport; the run itself is national and unfiltered,
  // so preview and pin are unaffected.
  useEffect(() => {
    if (!suggestedTerritory) return;
    setTerritory(suggestedTerritory);
  }, [suggestedTerritory, setTerritory]);

  // PRICE EVERY CANDIDATE, NOT JUST THE SELECTED ONE.
  //
  // Previewing only the picked crew made the cost section look static, and it
  // is nearly the only thing that separates two candidates. Measured on a live
  // national run (tower MY_N13331200716, Sat 12):
  //
  //     TRG-C1   moved 24   dropped 2   wait +0.5%
  //     PHG-C1   moved 28   dropped 3   wait +3.4%
  //     23 of those moves are IDENTICAL between the two.
  //
  // So clicking between crews rewrote four rows out of twenty-eight and left
  // the decisive numbers buried at the bottom — the panel read as hardcoded
  // because the visible 80% of it genuinely did not change. Pricing the whole
  // shortlist puts each crew's wait delta and dropped count on its own row,
  // where the comparison is free.
  //
  // The selected crew is requested FIRST so it is queued first: the backend is
  // one uvicorn process, so dispatch order is service order.
  const candidateIds = useMemo(
    () =>
      suggestions
        .filter((s) => !s.unreachable)
        .slice(0, MAX_PRICED_CANDIDATES)
        .map((s) => s.crew.crew_id),
    [suggestions],
  );
  const candidateKey = candidateIds.join(',');

  // NOT usePreviewOverride(). A TanStack mutation observer keeps ONE
  // `mutateOptions`, so a second mutate() before the first settles overwrites
  // the first call's onSuccess/onError — every completion then runs the LAST
  // registered pair. Fanning out through it left the first crew stuck on
  // "pricing…" forever, verified in the browser. `previewOverride` is a plain
  // promise and each call closes over its own crew id. Nothing is lost: this
  // needs no cache entry, no retry and no shared pending flag, which is all
  // the hook was adding.
  useEffect(() => {
    if (!towerId || !runId || committed) return;
    const order = [
      ...(suggestedCrewId ? [suggestedCrewId] : []),
      ...candidateIds.filter((id) => id !== suggestedCrewId),
    ];
    for (const crewId of order) {
      // The run, tower and day are all in the key: a preview is only valid for
      // the board it was computed against, so changing any of them must re-ask
      // rather than reuse a stale price.
      const key = `${runId}|${towerId}|${day}|${crewId}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      setPreviews((p) => ({ ...p, [crewId]: { status: 'loading' } }));
      previewOverride({
        run_id: runId,
        tower_id: towerId,
        target_crew_id: crewId,
        target_day: day,
      })
        .then((data) => {
          if (mounted.current) setPreviews((p) => ({ ...p, [crewId]: { status: 'ok', data } }));
        })
        .catch(() => {
          if (mounted.current) setPreviews((p) => ({ ...p, [crewId]: { status: 'error' } }));
          // Let a failed price be retried: leaving the key in place would pin
          // that crew on "cost unavailable" for the life of the panel.
          requested.current.delete(key);
        });
    }
    // candidateIds is covered by candidateKey, which is a stable string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [towerId, runId, day, committed, candidateKey, suggestedCrewId]);

  const previewState = suggestedCrewId ? previews[suggestedCrewId] : undefined;
  const preview = previewState?.status === 'ok' ? previewState.data : null;
  const previewFailed = previewState?.status === 'error';

  if (!ticket) {
    return (
      <div className="p-5">
        <h3 className="eyebrow mb-2">Ticket unavailable</h3>
        <p className="text-ui leading-relaxed text-dim">
          This ticket is no longer pending — it may have been resolved elsewhere.
        </p>
        <div className="mt-4">
          <Button onClick={onDone}>Close</Button>
        </div>
      </div>
    );
  }

  const site = hasPlaceName(ticket.tower_id)
    ? placeName(ticket.tower_id)
    : (tower?.territory ?? ticket.tower_id);

  /**
   * A PLACE, NOT AN OSM ID.
   *
   * placeName() only knows the offline fixture's towns, so every real-dataset
   * tower falls through to its bare id — and "MY_N13713417878 falls to
   * unscheduled" tells a planner nothing about the work they are being asked
   * to give up. The live roster is already loaded here for the range check,
   * so its territory costs one lookup. Same construction as `site` above.
   */
  const siteLabel = (id: string): string => {
    if (hasPlaceName(id)) return placeName(id);
    const t = towers.find((x) => x.tower_id === id);
    return t ? `${t.territory} · ${id}` : id;
  };

  if (committed) {
    const entry = run.entries.find((e) => e.tower_id === ticket.tower_id);
    return (
      <div className="p-5">
        <h3 className="eyebrow mb-2">Crew dispatched</h3>
        <p className="text-ui leading-relaxed text-ok-ink">
          {committed.crew_id} is booked for {site} on {dayLabel(day)}.
        </p>
        {/* Solver truth, not the pre-approval estimate. */}
        {entry && typeof entry.start_min === 'number' && typeof entry.end_min === 'number' && (
          <p className="tnum mt-1.5 text-micro text-muted">
            On site {clock(entry.start_min)}–{clock(entry.end_min)}
            {entry.travel_min ? ` after a ${entry.travel_min} min drive` : ''}
          </p>
        )}
        {committed.moved.length > 0 && (
          <div className="mt-3 rounded-lg border border-accent/25 bg-accent/[0.06] p-3">
            <p className="text-micro font-medium text-accent">
              {committed.moved.length === 1 ? 'One job' : `${committed.moved.length} jobs`} rescheduled
              to make room:
            </p>
            <ul className="mt-1.5 space-y-1 text-ui text-muted">
              {committed.moved.map((m) => (
                <li key={m.tower_id}>
                  <span className="text-fg">{placeName(m.tower_id)}</span> {dayLabel(m.from)} →{' '}
                  {dayLabel(m.to)}
                  {m.from_crew_id !== m.to_crew_id && (
                    <span className="text-watch-ink"> · reassigned to {m.to_crew_id}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {committed.dropped.length > 0 ? (
          <div className="mt-3 rounded-lg border border-watch/30 bg-watch/[0.08] p-3">
            <p className="text-micro font-medium text-watch-ink">
              {committed.dropped.length === 1
                ? 'One booked job'
                : `${committed.dropped.length} booked jobs`}{' '}
              dropped to unscheduled:
            </p>
            <ul className="mt-1.5 space-y-1 text-ui text-muted">
              {committed.dropped.map((id) => (
                <li key={id} className="text-fg">
                  {placeName(id)}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-1.5 text-micro leading-relaxed text-muted">
            {committed.moved.length > 0
              ? 'Everything else was rescheduled, not dropped — nothing fell off the plan.'
              : 'Nothing already booked was moved or dropped.'}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <Button
            onClick={() => {
              setViewMode('tower');
              // Same reason as the approve path: a replay the dock is sitting
              // on top of is a replay that did not happen.
              setAgentOpen(false);
              replayDispatchAnimation();
            }}
          >
            Replay
          </Button>
          {/* Clearing the descriptor also drops the grid's origin badges —
              they describe THIS dispatch, and leaving them up after the
              planner has moved on would attribute a later board state to it. */}
          <Button
            tone="primary"
            onClick={() => {
              clearDispatchAnimation();
              onDone();
            }}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  const approve = () => {
    if (!suggestion || !runId) return;
    setCommitFailed(false);
    const before = new Set(run.unscheduled);
    pinMutation.mutate(
      {
        tower_id: ticket.tower_id,
        target_crew_id: suggestion.crew.crew_id,
        target_day: day,
        pin_reason: 'emergency',
      },
      {
        onSuccess: (result) => {
          const next = result as ScheduleRun;
          const dropped = next.unscheduled.filter(
            (id) => !before.has(id) && id !== ticket.tower_id,
          );
          // What the re-solve ACTUALLY rescheduled, diffed from the returned
          // run rather than carried over from the pre-pin forecast — the
          // solver is free to place things differently than the preview
          // predicted. Reported because it IS the compensation story: work
          // that moved to make room is the answer to "what did this cost",
          // and a confirmation that only mentions drops loses it entirely
          // whenever the solver absorbs the emergency by shuffling instead.
          const beforeEntries = new Map(run.entries.map((e) => [e.tower_id, e]));
          const moved: DispatchMove[] = next.entries.flatMap((e) => {
            if (e.tower_id === ticket.tower_id) return [];
            const was = beforeEntries.get(e.tower_id);
            if (!was || (was.day === e.day && was.crew_id === e.crew_id)) return [];
            return [
              {
                tower_id: e.tower_id,
                from: was.day,
                to: e.day,
                from_crew_id: was.crew_id,
                to_crew_id: e.crew_id,
              },
            ];
          });
          setRun(next);
          markScheduled(ticket.ticket_id, suggestion.crew.crew_id);
          setCommitted({ crew_id: suggestion.crew.crew_id, dropped, moved });
          // The by-site grid is the only view holding the whole horizon, so a
          // cross-day move can only be shown there — the crew timeline draws
          // one day and a move between days is invisible on it.
          setViewMode('tower');
          // Collapse Ranger to its pill. The dock is 420x540 anchored to the
          // board's bottom-left, so an expanded dock covers the first two day
          // columns and several tower rows — which is where a dispatch on the
          // first day of the horizon lands. Measured: an approval whose cell
          // landed on Wed 9 animated entirely behind the dock. Preparing the
          // board to be read is already this callback's job (it switches the
          // view and follows the territory); uncovering it is the same job.
          setAgentOpen(false);
          setDispatchAnimation({
            moves: moved,
            emergency: { tower_id: ticket.tower_id, day },
          });
        },
        onError: () => {
          // Doc §3: markScheduleFailed covers a rejected suggestion OR a failed
          // commit. The ticket returns to Open so the agent can be reassigned.
          markScheduleFailed(ticket.ticket_id);
          setCommitFailed(true);
        },
      },
    );
  };

  const reject = () => {
    markScheduleFailed(ticket.ticket_id);
    onDone();
  };

  // The pinned tower shows up in preview.moved like any other entry, because
  // _diff() compares before/after by tower and this one did change slot. But
  // it is the ACTION, not a cost — listing "MY_… moves Sun 13 → Tue 8" under
  // "what this costs the plan" reads as collateral damage when it is the very
  // thing being asked for. Split out and stated separately.
  const impact = summarizeImpact(preview, ticket.tower_id);
  const { ownMove, moved: otherMoved, dropped: otherDropped, costsNothing } = impact;

  const sla = slaStatus(ticket.target_sla, day);
  const deltaPct = impact.waitDeltaPct;

  return (
    <div className="spine p-5" style={{ '--spine': 'var(--color-alert)' } as React.CSSProperties}>
      <h3 className="eyebrow mb-2 text-alert-ink">Emergency — awaiting approval</h3>
      <p className="text-lead text-fg">{ticket.title}</p>
      <p className="font-mono text-micro text-dim">
        {ticket.ticket_id} · {ticket.tower_id}
      </p>

      {/* The deadline this dispatch is being justified by, measured against
          the day it would actually land on. It was missing entirely: the
          panel asked for booked work to be displaced without ever showing
          what the emergency was racing. */}
      <p
        className={`mt-2.5 inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-micro font-semibold ${SLA_TONE[sla.level].cls}`}
      >
        <span aria-hidden="true" className="font-bold">
          {SLA_TONE[sla.level].glyph}
        </span>
        {sla.label}
        {ticket.target_sla && (
          <span className="font-normal opacity-75">· due {dayLabel(ticket.target_sla)}</span>
        )}
      </p>

      <Step n={1}>What was reported</Step>
      {/* FACTS FIRST, PROSE ON REQUEST.
          The narrative was three lines restating a headline the panel has
          already shown twice — the title above says "Structural Failure Risk —
          Urgent Inspection" and the table below says Structural — while the
          four facts a planner actually reads it FOR sat underneath it, pushing
          the crew choice off the first screen. The report text is still here
          verbatim; it is just no longer the thing between the planner and the
          decision. Native <details>, so it is keyboard-operable and findable
          by the browser's own in-page search with no JS. */}
      <p className="text-micro text-dim">
        {ticket.reporter} · {reportedAgeLabel(ticket.created_at)}
        {ticket.source === 'demo_emergency' && ' · demo'}
      </p>

      <dl className="mt-2.5 space-y-2 rounded-lg border border-overlay/10 bg-overlay/[0.03] p-3 text-ui">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Site</dt>
          <dd className="text-right text-fg">{site}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Issue type</dt>
          <dd className="text-fg">{ticket.issue_type}</dd>
        </div>
        {/* The tower was already being fetched for the range check and its
            risk thrown away. It is the same figure the board and the work
            queue print for this site, so the planner can tell an emergency on
            a quiet tower from one on a tower that was already in trouble. */}
        {tower && (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Site risk</dt>
            <dd className="flex items-center gap-2">
              <span
                className="tnum rounded border bg-white/70 px-1 text-micro font-semibold"
                style={{
                  color: bandInk(tower.decision),
                  borderColor: `${bandColor(tower.decision)}59`,
                }}
              >
                {tower.risk.toFixed(2)}
              </span>
              <span className="text-micro capitalize text-dim">{tower.dominant_factor}</span>
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Day</dt>
          <dd className="text-fg">{dayLabel(day)}</dd>
        </div>
      </dl>

      <details className="group mt-2">
        <summary className="cursor-pointer list-none text-micro text-muted transition-colors duration-150 hover:text-fg">
          <span aria-hidden="true" className="mr-1 inline-block transition-transform duration-150 group-open:rotate-90">
            ▸
          </span>
          Report text
        </summary>
        <p className="mt-1.5 border-l-2 border-overlay/10 pl-2.5 text-ui leading-relaxed text-muted">
          {ticket.description}
        </p>
      </details>

      <Step n={2}>Suggested crew</Step>
      {!tower ? (
        // Distinguished from "no crew in range" on purpose: an unknown tower
        // and an unreachable one are different problems, and reporting the
        // wrong one sends the planner hunting for crews that were never the
        // issue.
        <p className="text-ui leading-relaxed text-dim">
          Tower {ticket.tower_id} is not in the population the scheduler is serving, so no crew can be
          proposed for it. Reject to send this back to the ticket.
        </p>
      ) : !suggestion ? (
        // NAME THE GAP, DON'T JUST REPORT ONE.
        //
        // "No crew is within range" is unfalsifiable from the planner's seat:
        // a tower nobody can reach and a roster with a wrong depot produce the
        // identical sentence, and both read as the panel being broken. The
        // nearest crew and the margin it misses by turn it into something
        // that can be acted on — extend a limit, add a depot, or accept that
        // the site needs a different plan.
        <div>
          <p className="text-ui leading-relaxed text-dim">
            No {ticket.issue_type.toLowerCase()} crew can reach this tower from its depot, so there
            is nothing to approve here.
          </p>
          {outOfRange.length > 0 && (
            <ul className="mt-2.5 space-y-1.5 rounded-lg border border-overlay/10 bg-overlay/[0.03] p-3">
              {outOfRange.map((c) => {
                const over = c.distance_km - c.crew.max_travel_km;
                return (
                  <li key={c.crew.crew_id} className="text-micro leading-relaxed text-muted">
                    <span className="text-fg">{c.crew.name}</span>{' '}
                    <span className="text-dim">({c.crew.depot.name})</span> —{' '}
                    <span className="tnum">{c.distance_km.toFixed(0)} km</span> away, past its{' '}
                    <span className="tnum">{c.crew.max_travel_km} km</span> range by{' '}
                    <span className="tnum text-watch-ink">{over.toFixed(0)} km</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2.5 text-micro leading-relaxed text-dim">
            Reject to send it back, or assign a crew manually from the ticket — a manual assignment
            is not range-checked.
          </p>
        </div>
      ) : (
        // A LIST, NOT A CYCLE.
        //
        // This was a single card plus a "Suggest another (1 of 3)" button, so
        // choosing between crews meant clicking through them and holding the
        // rejected ones in your head. The candidates are already ranked and
        // already carry the two numbers the choice turns on — show them
        // together and the comparison is free. Radio semantics, because this
        // is one choice among a known set.
        <div role="radiogroup" aria-label="Crew candidates" className="space-y-1.5">
          {suggestions.map((s, i) => {
            const picked = i === suggestIndex;
            const t = roleTeam(s.crew.crew_type);
            return (
              <button
                key={s.crew.crew_id}
                type="button"
                role="radio"
                aria-checked={picked}
                onClick={() => setSuggestIndex(i)}
                className={`flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors duration-150 ${
                  picked
                    ? 'border-accent/45 bg-accent/[0.07]'
                    : 'border-overlay/10 bg-overlay/[0.02] hover:border-overlay/25 hover:bg-overlay/[0.05]'
                }`}
              >
                {/* A real radio mark, so the selected candidate is not
                    signalled by background tint alone. */}
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-2 ${
                    picked ? 'border-accent' : 'border-overlay/25'
                  }`}
                >
                  {picked && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-ui font-medium text-fg">{s.crew.name}</span>
                    {/* Nearest is a fact about the ranking, not a
                        recommendation to accept it — the solver still has the
                        last word, and a nearer crew can be the wrong one. */}
                    {i === 0 && suggestions.length > 1 && (
                      <span className="shrink-0 rounded bg-overlay/10 px-1.5 text-eyebrow font-semibold text-muted">
                        nearest
                      </span>
                    )}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className="rounded border px-1.5 text-eyebrow font-semibold"
                      style={tintedChip(
                        roleColor(s.crew.crew_type),
                        roleInk(s.crew.crew_type),
                        '1f',
                        '59',
                      )}
                    >
                      {t?.label ?? s.crew.crew_type} · {s.crew.crew_id}
                    </span>
                    {/* Labelled PER CANDIDATE, not per run. One crew can sit
                        at a depot the matrix measured while another sits at a
                        tower it does not hold, so a single run-wide "(est.)"
                        would be wrong about one of them either way. */}
                    {s.unreachable ? (
                      <span className="text-micro font-medium text-alert-ink">
                        no road route from here
                      </span>
                    ) : (
                      <>
                        <span className="tnum text-micro text-muted">
                          {s.distance_km.toFixed(0)} km
                        </span>
                        <span className="tnum text-micro text-dim">
                          {s.measured ? '' : '~'}
                          {s.eta_min} min drive{s.measured ? '' : ' (est.)'}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-micro text-dim">{s.from.label}</span>
                  {/* WHAT THIS CANDIDATE COSTS, on the row that offers it.
                      Distance and drive time rank the candidates; they do not
                      price them, and the price is what the two crews actually
                      differ by. Measured: two crews for the same tower and day
                      came back +0.5%/2 dropped against +3.4%/3 dropped while
                      sharing 23 of their moves — a difference invisible in the
                      list below and decisive here. */}
                  {(() => {
                    const st = previews[s.crew.crew_id];
                    if (!st) return null;
                    if (st.status === 'loading') {
                      return (
                        <span className="mt-1 block text-micro text-dim" role="status">
                          pricing…
                        </span>
                      );
                    }
                    if (st.status === 'error') {
                      return (
                        <span className="mt-1 block text-micro text-dim">cost unavailable</span>
                      );
                    }
                    const sum = summarizeImpact(st.data, ticket.tower_id);
                    return (
                      <span
                        className={`tnum mt-1 block text-micro ${
                          sum.dropped.length > 0 ? 'text-watch-ink' : 'text-muted'
                        }`}
                      >
                        {costLabel(sum)}
                      </span>
                    );
                  })()}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* The journey, once a crew is actually selected. Placed between the
          choice and its cost because that is the order the decision runs in:
          who, then how far, then what it displaces. Only for the picked
          candidate — a map per row would be five maps and no answer. */}
      {suggestion && tower && !suggestion.unreachable && (
        <div className="mt-3">
          <DispatchRoutePreview
            from={{ lon: suggestion.from.lon, lat: suggestion.from.lat, label: suggestion.from.label }}
            to={{
              lon: tower.lon,
              lat: tower.lat,
              label: `${site} · ${ticket.tower_id}`,
            }}
            distanceKm={suggestion.distance_km}
            etaMin={suggestion.eta_min}
            measured={suggestion.measured}
          />
        </div>
      )}

      <Step n={3}>What this costs the plan</Step>
      {!runId ? (
        // Offline (the store's fixture-backed run) has no run_id to preview or
        // pin against. EmergencyPanel carries a local-mutation branch for this;
        // this flow deliberately does not, because approving here also flips a
        // ticket to Active via markScheduled(), and a ticket recorded as
        // dispatched against a schedule the backend never saw is a worse
        // failure than a disabled button. Say so instead.
        <p className="text-ui leading-relaxed text-dim">
          The schedule is running offline, so there is no live plan to book against. Approval needs
          the scheduler; reject to send this back to the ticket.
        </p>
      ) : previewFailed ? (
        <p className="rounded-lg border border-alert/35 bg-alert/[0.09] p-3 text-micro leading-relaxed text-alert-ink">
          The impact could not be computed, so this cannot be approved yet. Nothing has changed. Try
          again, or reject to send it back to the ticket.
        </p>
      ) : !suggestion ? (
        <p className="text-ui text-dim">Nothing to price until a crew can be proposed.</p>
      ) : !preview ? (
        <>
          <p className="mb-2 text-ui text-dim" role="status">
            Working out what would move…
          </p>
          <ImpactSkeleton />
        </>
      ) : (
        <>
          {/* The action, not a cost. */}
          <p className="mb-2 text-ui text-muted">
            This visit:{' '}
            {ownMove ? (
              <>
                <span className="text-fg">
                  {dayLabel(ownMove.from)} → {dayLabel(ownMove.to)}
                </span>{' '}
                <span className="tnum text-dim">
                  ({ownMove.delta_days > 0 ? '+' : ''}
                  {ownMove.delta_days}d)
                </span>
              </>
            ) : (
              <span className="text-fg">newly booked on {dayLabel(day)}</span>
            )}
          </p>

          {costsNothing ? (
            <p className="text-ui leading-relaxed text-ok-ink">
              Nothing already booked would move.
            </p>
          ) : (
            <>
              {/* THE VERDICT, BEFORE THE EVIDENCE.
                  These three were previously derivable only by counting a
                  thirty-row list and reading one line underneath it. The wait
                  delta is the number two candidates actually differ by, and
                  dropped is the only irreversible loss. */}
              <div className="flex gap-2">
                <Verdict
                  label="risk-weighted wait"
                  value={deltaPct === null ? '—' : `${deltaPct > 0 ? '+' : ''}${deltaPct}%`}
                  tone={deltaPct === null ? 'neutral' : deltaPct > 0 ? 'warn' : 'good'}
                />
                <Verdict
                  label={otherDropped.length === 1 ? 'job dropped' : 'jobs dropped'}
                  value={String(otherDropped.length)}
                  tone={otherDropped.length > 0 ? 'warn' : 'good'}
                />
                <Verdict
                  label={otherMoved.length === 1 ? 'job moved' : 'jobs moved'}
                  value={String(otherMoved.length)}
                />
              </div>

              {impact.buckets.length > 0 && (
                <div className="mt-3">
                  <p className="eyebrow mb-1.5 text-dim">
                    {impact.earlier > 0 && `${impact.earlier} earlier`}
                    {impact.earlier > 0 && impact.later > 0 && ' · '}
                    {impact.later > 0 && `${impact.later} later`}
                    {impact.sameDay > 0 && ` · ${impact.sameDay} same day, new crew`}
                  </p>
                  <MoveDistribution buckets={impact.buckets} max={impact.maxBucket} />
                </div>
              )}

              {/* Named in full and never folded away: work leaving the plan
                  entirely is the one cost the planner cannot undo by reading
                  further, and the old list buried it under thirty move rows. */}
              {otherDropped.length > 0 && (
                <div className="mt-3 rounded-lg border border-watch/30 bg-watch/[0.08] p-2.5">
                  <p className="eyebrow mb-1 text-watch-ink">Falls to unscheduled</p>
                  <ul className="space-y-0.5 text-ui text-muted">
                    {otherDropped.map((id) => (
                      <li key={id} className="truncate">
                        <span className="text-fg">{siteLabel(id)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {otherMoved.length > 0 && (
                <details className="group mt-3">
                  <summary className="cursor-pointer list-none text-micro text-muted transition-colors duration-150 hover:text-fg">
                    <span
                      aria-hidden="true"
                      className="mr-1 inline-block transition-transform duration-150 group-open:rotate-90"
                    >
                      ▸
                    </span>
                    Show all {otherMoved.length} moves
                  </summary>
                  {/* SAY WHAT THIS LIST ACTUALLY IS.
                      Pinning re-solves the entire national board and the greedy
                      solver is not stable, so most of these rows are re-packing
                      rather than work this crew displaced — measured, two
                      different crews for the same tower and day shared 23 of
                      their moves. OverridePreview.moved carries no crew_id, so
                      the panel cannot separate the two and must not imply it
                      can by presenting the list as a displacement chain. */}
                  <p className="mt-1.5 text-eyebrow leading-relaxed text-dim">
                    The whole board re-solves around a pin, so this is every slot that changed — not
                    only work this crew displaced.
                  </p>
                  <ul className="mt-1.5 max-h-52 space-y-1 overflow-y-auto pr-1 text-ui">
                    {otherMoved.map((m) => (
                      <li key={m.tower_id} className="text-muted">
                        <span className="text-fg">{placeName(m.tower_id)}</span> moves{' '}
                        {dayLabel(m.from)} → {dayLabel(m.to)}{' '}
                        <span className="tnum text-dim">
                          ({m.delta_days > 0 ? '+' : ''}
                          {m.delta_days}d)
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}

      {commitFailed && (
        <p className="mt-3 rounded-lg border border-alert/35 bg-alert/[0.09] p-3 text-micro leading-relaxed text-alert-ink">
          The dispatch failed and nothing was booked. The ticket has been sent back — reassign its
          agent to try again.
        </p>
      )}

      {/* Pinned to the bottom of the detail panel's scroll container. The
          panel now runs well past a viewport, and a decision's two controls
          scrolling out of sight is how a planner ends up scrolling back up to
          find out whether they had already acted. */}
      {/* glass-raised, not a flat tint: the detail column is translucent by
          design (.glass-panel sits at 0.58 white so the board stays faintly
          legible through it), so a bar that content scrolls beneath needs the
          same surface the codebase already uses for anything floating over
          content. Its side and bottom borders are trimmed — only the top edge
          is a real boundary here. */}
      <div className="glass-raised sticky bottom-0 -mx-5 -mb-5 mt-4 border-x-0 border-b-0 px-5 py-3">
        {confirmingReject ? (
          // Reject is destructive in a way the label does not admit: it sends
          // the ticket back to Open and the planner must reassign its agent
          // to get it here again. One step of friction, and an explicit
          // statement of the consequence.
          <div>
            <p className="mb-2 text-micro leading-relaxed text-muted">
              Rejecting sends {ticket.ticket_id} back to Open. To bring it back here you will have to
              reassign its agent from the ticket.
            </p>
            <div className="flex gap-2">
              <Button tone="danger" onClick={reject}>
                Reject anyway
              </Button>
              <Button onClick={() => setConfirmingReject(false)}>Keep it here</Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              tone="primary"
              disabled={!suggestion || !preview || pinMutation.isPending}
              onClick={approve}
            >
              {pinMutation.isPending ? 'Dispatching…' : 'Approve'}
            </Button>
            <Button onClick={() => setConfirmingReject(true)}>Reject</Button>
            {/* States WHY the primary control is dead, rather than leaving a
                greyed button the planner has to guess at. */}
            {!pinMutation.isPending && (!suggestion || !preview) && (
              <span className="text-micro leading-tight text-dim">
                {!suggestion ? 'No crew to approve' : 'Pricing the change…'}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
