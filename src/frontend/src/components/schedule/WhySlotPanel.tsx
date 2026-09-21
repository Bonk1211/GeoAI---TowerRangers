import { useScheduleStore } from '../../state/useScheduleStore';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { computeWhySlot, whySlotHeader } from '../../lib/whySlot';
import { formatUrgency } from '../../lib/format';
import { movedForward } from '../../lib/weather';
import { MoveControl } from './MoveControl';
import { EmergencyPanel } from './EmergencyPanel';
import { AssignPanel } from './AssignPanel';
import { ReserveDetail } from './ReserveDetail';
import { TicketApprovalPanel } from './TicketApprovalPanel';
import { FireInspectionPanel } from './FireInspectionPanel';
import { scheduleEntryId, useWhySlotQuery } from '../../api/queries';
import type { ScheduleEntry, Tower } from '../../api/types';

export function WhySlotPanel() {
  const selection = useScheduleStore((s) => s.selection);
  const select = useScheduleStore((s) => s.select);
  const run = useScheduleStore((s) => s.run);
  const offlineRun = useScheduleStore((s) => s.offlineRun);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);

  if (!selection) {
    return (
      <p className="p-5 text-ui leading-relaxed text-dim">
        Select a scheduled slot to see why the optimizer put it there, and to move or pin it.
      </p>
    );
  }

  if (selection.kind === 'emergency') {
    return (
      <EmergencyPanel
        tower_id={selection.tower_id}
        day={selection.day}
        onDone={() => select(null)}
      />
    );
  }

  if (selection.kind === 'ticket_approval') {
    return (
      <TicketApprovalPanel
        ticket_id={selection.ticket_id}
        day={selection.day}
        onDone={() => select(null)}
      />
    );
  }

  if (selection.kind === 'free') {
    return <AssignPanel crew_id={selection.crew_id} day={selection.day} />;
  }

  if (selection.kind === 'reserve') {
    return <ReserveDetail crew_id={selection.crew_id} day={selection.day} onDone={() => select(null)} />;
  }

  // Raised from the map rather than from the board: this tower has a satellite
  // hotspot inside its screening buffer and no scheduled visit to explain. The
  // panel reviews the observation before anything is booked, so it sits beside
  // the other non-job branches rather than falling through to the entry lookup
  // below, which would find nothing and offer to assign unscheduled work.
  if (selection.kind === 'fire_inspection') {
    return (
      <FireInspectionPanel
        tower_id={selection.tower_id}
        day={selection.day}
        onDone={() => select(null)}
      />
    );
  }

  const entry = run.entries.find(
    (e) => e.crew_id === selection.crew_id && e.day === selection.day && e.tower_id === selection.tower_id,
  );

  if (!entry) {
    return <AssignPanel crew_id={selection.crew_id} day={selection.day} />;
  }

  const tower = towers.find((t) => t.tower_id === entry.tower_id);

  return <WhySlotBody entry={entry} tower={tower} offline={offlineRun !== null} />;
}

interface WhySlotBodyProps {
  entry: ScheduleEntry;
  tower: Tower | undefined;
  offline: boolean;
}

function WhySlotBody({ entry, tower, offline }: WhySlotBodyProps) {
  const run = useScheduleStore((s) => s.run);
  // Deterministic, no LLM — GET /schedule/why/{entry_id} when online (step
  // 6d); the local recompute is the step 7 offline path only.
  const entryId = offline ? null : scheduleEntryId(entry);
  const whySlotQuery = useWhySlotQuery(entryId);
  // Three states, not two. `!whySlotQuery.data` used to collapse "still
  // loading", "the request failed" and "we are offline" into one silent
  // local recompute rendered under the solver's own heading — the reader
  // could not tell the solver's record from the browser's reconstruction of
  // it. Loading now says so, and a local reconstruction is labelled wherever
  // it is shown.
  const derivedLocally = offline || whySlotQuery.isError;
  const waiting = !offline && whySlotQuery.isPending;
  const reasons = derivedLocally
    ? computeWhySlot(entry, run).reasons
    : (whySlotQuery.data?.reasons ?? []);

  return (
    <div>
      <div className="border-b border-overlay/10 p-5">
        <h3 className="eyebrow mb-2">Why this slot</h3>
        <p className="text-lead text-fg">{whySlotHeader(entry)}</p>
        {tower && (
          <p className="mt-1.5 text-micro text-muted">
            <span className="tnum text-fg">risk {tower.risk.toFixed(2)}</span>
            <span className="capitalize"> · {tower.dominant_factor}</span>
            {tower.urgency_days > 0 && <> · due {formatUrgency(tower.urgency_days)}</>}
            {/* The reason itself is a bullet below, rendered from solver state
                by explain.py. This is just the flag, so a moved date is
                visible without reading the list. */}
            {movedForward(tower.weather) && <span className="text-watch-ink"> · brought forward</span>}
          </p>
        )}

        <h4 className="eyebrow mt-5">Scheduled {entry.day.slice(5)} because</h4>
        {derivedLocally && (
          /* The map console states a caveat like this as a tinted callout, not
             as another grey line — a provenance warning that looks like body
             copy gets read as body copy. */
          <p className="mt-1.5 rounded-lg border border-watch/35 bg-watch/10 px-2.5 py-1.5 text-micro leading-snug text-watch-ink">
            {offline
              ? 'Reconstructed in the browser — offline, so the solver’s own record is unavailable.'
              : 'Reconstructed in the browser — the solver’s own record could not be fetched.'}
          </p>
        )}
        {waiting ? (
          <p className="mt-2 text-ui leading-snug text-dim">Loading the solver&rsquo;s record…</p>
        ) : reasons.length > 0 ? (
          /* One accent rail down the whole list rather than a dot per line:
             the reasons are a single record the solver kept, and a rail reads
             as one thing where loose bullets read as unrelated remarks. */
          <ul className="mt-2.5 space-y-2 border-l-2 border-accent/30 pl-3">
            {reasons.map((r, i) => (
              <li key={i} className="text-ui leading-snug text-muted">
                {r}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-ui leading-snug text-dim">No reason recorded for this placement.</p>
        )}
      </div>
      <MoveControl entry={entry} />
    </div>
  );
}
