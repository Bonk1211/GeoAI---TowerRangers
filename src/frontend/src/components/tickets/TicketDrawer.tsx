import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { placeName } from '../../fixtures/schedule';
import { CREWS } from '../../fixtures/crews';
import { bandColor, bandInk } from '../../lib/colors';
import { useTicketStore, type NewTicketInput } from '../../state/useTicketStore';
import { EDITABLE_STATUSES, ISSUE_TYPES, type FixAttachment, type Ticket, type TicketStatus } from '../../fixtures/tickets';
import {
  rankCandidateCrews,
  crewTypeForTicket,
  draftDescription,
  draftCloseoutSummary,
} from '../../lib/ticketSkills';
import { roleTeam } from '../../lib/roleTeams';
import { checklistForIssueType } from '../../lib/fixChecklists';
import { groupCrewOptions, optionDetail } from '../../lib/crewOptions';
import { dayLabel } from '../../lib/scheduleDays';
import { useScheduleStore } from '../../state/useScheduleStore';
import { Button } from '../ui/Panel';
import { AttachmentIcon, BackArrowIcon, SparkleIcon } from '../shell/icons';
import { SKILLS } from '../../fixtures/skills';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers, useLiveTower } from '../../api/useLiveTowers';
import { useCrewsQuery, useConfluenceRunbookQuery } from '../../api/queries';
import type { Tower } from '../../api/types';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function priorityFor(tower: Tower | undefined): { label: string; band: string; ink: string } {
  if (!tower) {
    return { label: 'Unranked', band: 'var(--color-unscored)', ink: 'var(--color-dim)' };
  }
  if (tower.decision === 'maintain') return { label: 'Urgent', band: bandColor('maintain'), ink: bandInk('maintain') };
  if (tower.decision === 'watch') return { label: 'Moderate', band: bandColor('watch'), ink: bandInk('watch') };
  return { label: 'Low', band: bandColor('ok'), ink: bandInk('ok') };
}

interface ViewDrawerProps {
  mode: 'view';
  ticket: Ticket;
  onClose: () => void;
}

interface CreateDrawerProps {
  mode: 'create';
  onClose: () => void;
  onCreated: (ticket: Ticket) => void;
}

type TicketDrawerProps = ViewDrawerProps | CreateDrawerProps;

export function TicketDrawer(props: TicketDrawerProps) {
  const navigate = useNavigate();
  const setStatus = useTicketStore((s) => s.setStatus);
  const toggleAgentId = useTicketStore((s) => s.toggleAgentId);
  const assignCrew = useTicketStore((s) => s.assignCrew);
  const addFixNote = useTicketStore((s) => s.addFixNote);
  const submitChecklist = useTicketStore((s) => s.submitChecklist);
  const submitFix = useTicketStore((s) => s.submitFix);
  const closeTicket = useTicketStore((s) => s.closeTicket);
  const setModelFeedback = useTicketStore((s) => s.setModelFeedback);
  const createTicket = useTicketStore((s) => s.createTicket);
  const pinnedSkills = useTicketStore((s) => s.pinnedSkills);

  // Real live towers (not the frontend's static fixture) — see
  // useTicketStore's createEmergencyTicket doc comment for why: a tower_id
  // the backend has never heard of 404s the moment it reaches /schedule/pin.
  // useLiveTower is called here (above the mode==='create' early return)
  // rather than after it, since hooks can't follow a conditional return.
  const weights = useWeights((s) => s.weights);
  const { towers: liveTowers } = useLiveTowers(weights);
  const viewTower = useLiveTower(props.mode === 'view' ? props.ticket.tower_id : null, weights);
  // Same reason: hooks can't follow the mode==='create' early return below.
  const { data: viewRunbook } = useConfluenceRunbookQuery(viewTower?.dominant_factor ?? null);
  // The live roster, for the same reason as the live towers above: the CREWS
  // fixture holds 12 crews across 3 territories, while config/crews.json
  // rosters 30 across all 16. Offering only the fixture cannot name the crew
  // the solver would actually send to a Penang or Sabah tower.
  const crewsQuery = useCrewsQuery();
  const crews = crewsQuery.data ?? CREWS;

  // THE SCHEDULE THE ASSIGNEE PICKER WAS IGNORING.
  //
  // This drawer had no schedule dependency at all, so "assign a crew" could
  // not tell a crew with an empty day from one already booked to the end of
  // its shift. The store's `run` is the same object the Schedule tab's board
  // draws, so the two now read one source.
  //
  // The WHOLE horizon, not one day. A manual assignment books no day at all —
  // assignCrew() records a crew on the ticket and nothing else — so a single
  // day would be arbitrary, and horizon[0] was measurably the worst arbitrary
  // choice: on a live national run it held 1 of 54 entries, so 29 of 30 crews
  // read "free" and the column said nothing.
  //
  // An unsolved board has an empty horizon, which makes the load ABSENT
  // rather than zero (see crewOptions.ts) — a zeroed load is truthy and would
  // read as an empty diary for a plan nobody has solved.
  const run = useScheduleStore((s) => s.run);

  const [noteText, setNoteText] = useState('');
  const [noteLink, setNoteLink] = useState('');
  // Attachment scratch state for the note being composed. Declared here with
  // every other hook — `ticket` is destructured after an early return, so
  // nothing below it may seed a hook without breaking hook order. Saved
  // feedback is therefore shown as text rather than pre-filled into the form.
  const [noteFile, setNoteFile] = useState<FixAttachment | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fbAccurate, setFbAccurate] = useState<boolean | null>(null);
  const [fbFactor, setFbFactor] = useState('');
  const [fbComment, setFbComment] = useState('');

  // 2 MB, because the whole file is held as a base64 data URL in memory and
  // this store has no persistence layer to spill to. Rejected loudly rather
  // than silently truncated — a technician who thinks they attached a photo
  // and did not is worse off than one who was told no.
  const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

  function readAttachment(file: File) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setFileError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 2 MB.`);
      setNoteFile(undefined);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFileError(null);
      setNoteFile({ name: file.name, type: file.type, size: file.size, dataUrl: String(reader.result) });
    };
    reader.onerror = () => setFileError(`Could not read ${file.name}.`);
    reader.readAsDataURL(file);
  }
  // Compliance checklist scratch state — a person's in-progress ticks before
  // they submit. Not persisted until submitChecklist() runs; resets whenever
  // the drawer opens on a ticket that already has a checklist result, since
  // the read-only table (driven by ticket.compliance_checklist) takes over.
  const [checklistChecked, setChecklistChecked] = useState<Record<string, boolean>>({});
  const [checklistEditing, setChecklistEditing] = useState(false);

  const [form, setForm] = useState<NewTicketInput>({
    title: '',
    tower_id: liveTowers[0]?.tower_id ?? '',
    issue_type: ISSUE_TYPES[0],
    reporter: '',
    description: '',
  });

  if (props.mode === 'create') {
    const canSubmit = form.title.trim().length > 0 && form.reporter.trim().length > 0 && form.tower_id;

    return (
      <div className="glass-raised spine flex h-full w-[520px] shrink-0 flex-col overflow-hidden rise" style={{ '--spine': 'var(--color-accent)' } as React.CSSProperties}>
        <div className="flex items-center gap-2 border-b border-overlay/10 px-5 py-3.5">
          <button
            type="button"
            onClick={props.onClose}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <BackArrowIcon />
            Cancel
          </button>
          <h2 className="ml-1 font-display text-sm font-semibold text-fg">New Ticket</h2>
        </div>

        <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="eyebrow mb-1.5 block">Title</span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Short summary of the issue"
              className="w-full rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 text-xs text-fg placeholder:text-dim focus:border-accent focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="eyebrow mb-1.5 block">Tower</span>
            <select
              value={form.tower_id}
              onChange={(e) => setForm((f) => ({ ...f, tower_id: e.target.value }))}
              className="w-full rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 text-xs text-fg focus:border-accent focus:outline-none"
            >
              {liveTowers.map((t) => (
                <option key={t.tower_id} value={t.tower_id}>
                  {placeName(t.tower_id)} — {t.tower_id}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="eyebrow mb-1.5 block">Issue Type</span>
              <select
                value={form.issue_type}
                onChange={(e) => setForm((f) => ({ ...f, issue_type: e.target.value }))}
                className="w-full rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 text-xs text-fg focus:border-accent focus:outline-none"
              >
                {ISSUE_TYPES.map((it) => (
                  <option key={it} value={it}>
                    {it}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow mb-1.5 block">Reported By</span>
              <input
                type="text"
                value={form.reporter}
                onChange={(e) => setForm((f) => ({ ...f, reporter: e.target.value }))}
                placeholder="e.g. field-tech-03"
                className="w-full rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 text-xs text-fg placeholder:text-dim focus:border-accent focus:outline-none"
              />
            </label>
          </div>

          <label className="block">
            <span className="eyebrow mb-1.5 block">Description</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={5}
              placeholder="What was observed on site..."
              className="w-full resize-none rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 text-xs text-fg placeholder:text-dim focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-overlay/10 px-5 py-3.5">
          <Button tone="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={!canSubmit}
            onClick={() => {
              const ticket = createTicket(form);
              props.onCreated(ticket);
            }}
          >
            Create Ticket
          </Button>
        </div>
      </div>
    );
  }

  const { ticket, onClose } = props;
  const tower = viewTower;
  const band = tower ? bandColor(tower.decision) : 'var(--color-unscored)';
  const ink = tower ? bandInk(tower.decision) : 'var(--color-dim)';
  const priority = priorityFor(tower);
  const crew = ticket.assignee_crew_id ? crews.find((c) => c.crew_id === ticket.assignee_crew_id) : undefined;
  const closed = ticket.status === 'closed';
  const runbook = viewRunbook;
  const checklistDef = checklistForIssueType(ticket.issue_type);
  const checklistResult = ticket.compliance_checklist;
  const showChecklistForm = !checklistResult || checklistEditing;
  const checklistCheckedCount = Object.values(checklistChecked).filter(Boolean).length;
  // Once the PIC has submitted a fix, assignment and status are done —
  // only the admin/reporter's Close Ticket action can move it further.
  const locked = ticket.status === 'resolved' || closed;
  const canClose = ticket.status === 'resolved';

  const isAgent = (id: string) => Boolean(ticket.agent_ids?.includes(id)) || pinnedSkills[ticket.status] === id;
  const showAssigneeAgent = isAgent('assignee_agent') && !locked;
  const showIssueDescriptor = isAgent('issue_descriptor');
  const showValidationAssistant = isAgent('validation_assistant') && ticket.status === 'resolved';
  // Live tower and roster, not the fixtures: rankCandidateCrews' fallbacks
  // return [] for a real OSM tower_id, which renders as "no crew within range"
  // for exactly the tickets the demo button generates.
  const candidates = showAssigneeAgent
    ? rankCandidateCrews(ticket, { tower: viewTower, crews })
    : [];

  return (
    <div
      className="glass-raised spine flex h-full w-[520px] shrink-0 flex-col overflow-hidden rise"
      style={{ '--spine': band } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 border-b border-overlay/10 px-5 py-3.5">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <BackArrowIcon />
          Back
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <h2 className="font-display text-lg font-semibold leading-snug text-fg">{ticket.title}</h2>
            {ticket.agent_ids && ticket.agent_ids.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {ticket.agent_ids.map((id) => {
                  const skill = SKILLS.find((s) => s.id === id);
                  return (
                    <div
                      key={id}
                      className="flex items-center gap-1.5 w-fit rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                      style={{
                        borderColor: `color-mix(in srgb, ${skill?.color ?? 'var(--color-accent)'} 20%, transparent)`,
                        backgroundColor: `color-mix(in srgb, ${skill?.color ?? 'var(--color-accent)'} 8%, transparent)`,
                        color: skill?.color ?? 'var(--color-accent)',
                      }}
                    >
                      <span className="[&>svg]:h-3 [&>svg]:w-3">{skill ? <skill.icon /> : <SparkleIcon />}</span>
                      {skill?.label || id}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <span className="shrink-0 rounded-md border border-overlay/15 bg-overlay/[0.05] px-2 py-0.5 font-mono text-[11px] font-semibold text-muted">
            {ticket.ticket_id}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-overlay/10 bg-overlay/[0.02] p-3.5 text-xs">
          <div>
            <div className="eyebrow mb-1">Tower</div>
            <div className="font-mono font-semibold text-fg">{ticket.tower_id}</div>
            <div className="text-[11px] text-dim">{tower ? placeName(tower.tower_id) : '—'}</div>
          </div>
          <div>
            <div className="eyebrow mb-1">Status</div>
            {locked ? (
              <div className="font-semibold text-fg">{closed ? 'Closed' : 'Resolved'}</div>
            ) : (
              <select
                value={ticket.status}
                onChange={(e) => setStatus(ticket.ticket_id, e.target.value as TicketStatus)}
                className="w-full rounded-md border border-overlay/15 bg-ink-800 px-2 py-1 text-[11px] text-fg focus:border-accent focus:outline-none"
              >
                {EDITABLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <div className="eyebrow mb-1">Reported By</div>
            <div className="text-fg">{ticket.reporter}</div>
          </div>
          <div>
            <div className="eyebrow mb-1">Priority</div>
            <span
              className="inline-block rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{ color: priority.ink, borderColor: `${priority.band}66`, backgroundColor: `${priority.band}1a` }}
            >
              {priority.label}
            </span>
          </div>

          <div>
            <div className="eyebrow mb-1">Assignee</div>
            {locked ? (
              <div className="text-fg">{crew ? crew.name : 'Unassigned'}</div>
            ) : (
              <select
                value={ticket.assignee_crew_id ?? ''}
                onChange={(e) => assignCrew(ticket.ticket_id, e.target.value || null)}
                className="w-full rounded-md border border-overlay/15 bg-ink-800 px-2 py-1 text-[11px] text-fg focus:border-accent focus:outline-none"
              >
                <option value="">Unassigned</option>
                {/* GROUPED BY WHAT THE SOLVER WOULD ACTUALLY ACCEPT.
                    Capability grouping alone was not enough, and the gap was
                    measured: for a real Kelantan Power ticket the group
                    headed "Power — suits this issue" listed EIGHT crews of
                    which one was dispatchable, including a Sabah crew 1,600 km
                    away across the South China Sea. The same drawer already
                    contradicted itself — the "Assignee Agent — suggested
                    crews" block below is range-filtered and showed 1 while
                    this dropdown showed 8.

                    Three groups now: in range, out of range, wrong trade. The
                    range test is `rankCandidateCrews`' own, so the two lists
                    in this drawer can no longer disagree. Each option carries
                    its distance, how far past its limit it is, and what it is
                    already booked for that day.

                    NOTHING IS REMOVED. The range and capability rules are the
                    solver's, and a planner overriding them deliberately is a
                    real workflow — scheduler/override.py's "never blocked"
                    contract is the backend half of the same idea. */}
                {(() => {
                  const needed = crewTypeForTicket(ticket, tower ?? undefined);
                  const g = groupCrewOptions({
                    neededType: needed,
                    tower,
                    crews,
                    entries: run.entries,
                    horizon: run.horizon,
                  });
                  const trade = needed ? (roleTeam(needed)?.label ?? needed) : null;
                  const opt = (o: (typeof g.inRange)[number]) => (
                    <option key={o.crew.crew_id} value={o.crew.crew_id}>
                      {o.crew.name} · {optionDetail(o)}
                    </option>
                  );
                  return (
                    <>
                      {g.inRange.length > 0 && (
                        <optgroup
                          label={
                            trade
                              ? `${trade}, in range — ${g.inRange.length}`
                              : `In range — ${g.inRange.length}`
                          }
                        >
                          {g.inRange.map(opt)}
                        </optgroup>
                      )}
                      {g.outOfRange.length > 0 && (
                        <optgroup
                          label={
                            trade
                              ? `${trade}, out of range — override`
                              : 'Out of range — override'
                          }
                        >
                          {g.outOfRange.map(opt)}
                        </optgroup>
                      )}
                      {g.otherCapability.length > 0 && (
                        <optgroup label="Other capabilities — override">
                          {g.otherCapability.map(opt)}
                        </optgroup>
                      )}
                    </>
                  );
                })()}
              </select>
            )}
            {/* SAY WHICH DAY THE HOURS DESCRIBE, or say there are none.
                "free that day" is meaningless without a day, and an unsolved
                board must read as absence rather than as an empty diary —
                the same rule withOfflineFallback follows for a zeroed
                struct. */}
            {!locked && (
              <p className="mt-1 text-[10px] leading-relaxed text-dim">
                {run.horizon.length > 0
                  ? `Booked work is across the current plan, ${dayLabel(run.horizon[0])} to ${dayLabel(run.horizon[run.horizon.length - 1])}.`
                  : 'Crew workload appears once the Schedule tab has solved a plan.'}
              </p>
            )}
            {showAssigneeAgent && (
              <div className="mt-2 rounded-md border border-accent/25 bg-accent/[0.06] p-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
                  <SparkleIcon />
                  Assignee Agent — suggested crews
                </div>
                {candidates.length === 0 ? (
                  <p className="text-[11px] text-dim">No crew within range for this issue type.</p>
                ) : (
                  <ul className="space-y-1">
                    {candidates.map(({ crew: c, distance_km }) => (
                      <li key={c.crew_id} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="min-w-0 truncate text-fg">
                          {c.name} <span className="text-dim">· {distance_km.toFixed(0)} km</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => assignCrew(ticket.ticket_id, c.crew_id)}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                        >
                          Assign
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Assigning this agent only hands the ticket off
                    (useAutoDispatch sets schedule_pending) — it does not
                    dispatch anything itself. The actual crew/day suggestion,
                    approval and pin happen on the Schedule side (Ranger
                    chat), which is a teammate's build; this strip only
                    reflects that hand-off status. The candidate list above
                    stays as a manual fallback: the Assignee dropdown's own
                    "Assign" click still lets a human pick a crew directly
                    without going through the agent or Schedule at all. */}
                <div className="mt-2.5 border-t border-accent/15 pt-2.5">
                  {ticket.schedule_pending ? (
                    <p className="text-[11px] text-dim">Sent to Schedule — awaiting approval there.</p>
                  ) : ticket.status !== 'open' ? (
                    <p className="text-[11px] text-ok-ink">Approved on Schedule — crew assigned.</p>
                  ) : ticket.schedule_failed ? (
                    <p className="text-[11px] text-alert-ink">
                      Rejected on Schedule. Reassign the agent to send it again.
                    </p>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="eyebrow mb-1">Logged</div>
            <div className="tnum text-fg">{formatDate(ticket.created_at)}</div>
          </div>

          <div>
            <div className="eyebrow mb-1">Issue Type</div>
            <div className="text-fg">{ticket.issue_type}</div>
          </div>
          <div>
            <div className="eyebrow mb-1">Target SLA</div>
            <div className="tnum text-fg">{ticket.target_sla ? formatDate(ticket.target_sla) : '—'}</div>
          </div>

          {tower && (
            <div className="col-span-2 pt-1">
              <button
                type="button"
                onClick={() => navigate(`/investigation/${tower.tower_id}`)}
                className="text-[11px] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 rounded"
              >
                ↗ View Investigation
              </button>
            </div>
          )}
        </div>

        {/* The hand-off, reachable from the drawer.

            toggleAgentId previously had exactly one caller — TicketCard's sparkle
            picker, out on the board — so a dispatcher who opened the drawer
            (the obvious thing to do) could only reach the manual Assignee
            dropdown, which calls assignCrew(), flips status open -> active,
            and permanently disqualifies the ticket from the hand-off with
            nothing visibly failing. Same action as the sparkle picker, named
            for what it does rather than for the agent it selects. The
            contract is untouched: useAutoDispatch still owns the flag. */}
        {ticket.status === 'open' && !ticket.agent_ids?.includes('assignee_agent') && (
          <button
            type="button"
            onClick={() => toggleAgentId(ticket.ticket_id, 'assignee_agent')}
            className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-ui font-semibold text-white shadow-[var(--shadow-2)] transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98]"
          >
            <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">
              <SparkleIcon />
            </span>
            Send to Schedule for approval
          </button>
        )}

        <div className="mt-5">
          <div className="eyebrow mb-2">Description</div>
          <p className="whitespace-pre-line text-xs leading-relaxed text-fg/90">{ticket.description}</p>
          {showIssueDescriptor && (
            <div className="mt-2 rounded-md border border-accent/25 bg-accent/[0.06] p-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
                <SparkleIcon />
                Issue Descriptor — draft (mocked)
              </div>
              <p className="text-xs italic leading-relaxed text-fg/80">{draftDescription(ticket)}</p>
            </div>
          )}
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-accent/20 bg-accent/[0.05]">
          <div className="flex items-center justify-between px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
              <SparkleIcon />
              Compliance Checklist
              <span className="rounded-full bg-accent px-1.5 py-px text-[9px] font-bold tracking-wide text-white">
                {checklistDef.title.toUpperCase()}
              </span>
            </div>
            {showChecklistForm ? (
              <span className="tnum text-[10px] text-dim">
                {checklistCheckedCount} / {checklistDef.items.length}
              </span>
            ) : (
              <span className="tnum text-[10px] text-dim">
                {checklistResult!.checked_ids.length} / {checklistDef.items.length} completed
              </span>
            )}
          </div>

          {showChecklistForm ? (
            <>
              <div className="border-t border-accent/15">
                {checklistDef.items.map((it) => (
                  <label
                    key={it.id}
                    className="flex items-start gap-2 border-b border-overlay/5 px-3 py-1.5 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0 accent-accent"
                      checked={checklistChecked[it.id] ?? false}
                      onChange={(e) =>
                        setChecklistChecked((c) => ({ ...c, [it.id]: e.target.checked }))
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-[11.5px] font-semibold text-fg">{it.item}</span>
                      <span className="block text-[10.5px] text-dim">{it.requirement}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-accent/15 px-3 py-2">
                <span className="text-[9.5px] italic text-dim">{checklistDef.source}</span>
                <Button
                  tone="primary"
                  disabled={checklistCheckedCount === 0}
                  onClick={() => {
                    submitChecklist(ticket.ticket_id, {
                      issue_type: ticket.issue_type,
                      checked_ids: Object.entries(checklistChecked)
                        .filter(([, v]) => v)
                        .map(([id]) => id),
                      completed_by: crew?.name ?? ticket.reporter,
                    });
                    setChecklistEditing(false);
                  }}
                >
                  Submit checklist
                </Button>
              </div>
            </>
          ) : (
            <>
              <table className="w-full border-t border-accent/15 text-left">
                <tbody>
                  {checklistDef.items.map((it) => {
                    const done = checklistResult!.checked_ids.includes(it.id);
                    return (
                      <tr key={it.id} className="border-b border-overlay/5 last:border-b-0">
                        <td className="px-3 py-1.5 align-top">
                          <span className="block text-[11.5px] font-semibold text-fg">{it.item}</span>
                          <span className="block text-[10.5px] text-dim">{it.requirement}</span>
                        </td>
                        <td className="w-10 px-3 py-1.5 text-center align-top">
                          {done ? (
                            <span className="font-bold" style={{ color: 'var(--color-ok-ink)' }}>✓</span>
                          ) : (
                            <span className="text-dim">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-accent/15 px-3 py-2">
                <span className="text-[10px] text-dim">
                  {checklistResult!.completed_by} · {formatDate(checklistResult!.completed_at)}
                </span>
                <button
                  type="button"
                  className="text-[10.5px] font-semibold text-accent underline"
                  onClick={() => {
                    setChecklistChecked(
                      Object.fromEntries(checklistResult!.checked_ids.map((id) => [id, true])),
                    );
                    setChecklistEditing(true);
                  }}
                >
                  Edit checklist
                </button>
              </div>
            </>
          )}
        </div>

        {runbook && (
          <div className="mt-4 overflow-hidden rounded-lg border border-accent/20 bg-accent/[0.05]">
            <div className="flex items-center justify-between px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
                <SparkleIcon />
                Resolution Runbook
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-accent/15 px-3 py-2">
              <span className="text-[11.5px] font-semibold text-fg">{runbook.title}</span>
              <a
                href={runbook.url}
                target="_blank"
                rel="noreferrer"
                className="text-[10.5px] font-semibold text-accent underline"
              >
                Open in Confluence
              </a>
            </div>
          </div>
        )}

        <div className="mt-6">
          <div className="eyebrow mb-2 flex items-center gap-2 border-b border-overlay/10 pb-2">Fix Notes</div>
          <div className="space-y-3">
            {ticket.fix_notes.length === 0 && (
              <p className="text-[11px] italic text-dim">No fix notes yet.</p>
            )}
            {ticket.fix_notes.map((note, i) => (
              <div key={i} className="rounded-lg border border-overlay/10 bg-overlay/[0.02] p-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-fg">{note.author}</span>
                  <span className="tnum text-dim">{formatDate(note.created_at)}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-fg/85">{note.text}</p>
                {note.link && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-dim">
                    <AttachmentIcon />
                    <span className="italic">{note.link} (mock, not a real upload)</span>
                  </div>
                )}
                {note.attachment && (
                  <div className="mt-2">
                    {note.attachment.type.startsWith('image/') && (
                      <img
                        src={note.attachment.dataUrl}
                        alt={note.attachment.name}
                        className="max-h-32 rounded border border-overlay/15"
                      />
                    )}
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-dim">
                      <AttachmentIcon />
                      <span>{note.attachment.name}</span>
                      <span className="tnum">({(note.attachment.size / 1024).toFixed(0)} KB)</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {ticket.status === 'active' && (
            <div className="mt-3 space-y-2">
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={2}
                placeholder="Add a fix note..."
                className="w-full resize-none rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 text-xs text-fg placeholder:text-dim focus:border-accent focus:outline-none"
              />
              <input
                type="text"
                value={noteLink}
                onChange={(e) => setNoteLink(e.target.value)}
                placeholder="Optional link/filename (mock)"
                className="w-full rounded-lg border border-overlay/15 bg-ink-800 px-3 py-1.5 text-[11px] text-fg placeholder:text-dim focus:border-accent focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) readAttachment(file);
                  }}
                  className="w-full text-[11px] text-dim file:mr-2 file:rounded file:border file:border-overlay/15 file:bg-ink-800 file:px-2 file:py-1 file:text-[11px] file:text-fg"
                />
                {noteFile && (
                  <button
                    type="button"
                    onClick={() => { setNoteFile(undefined); setFileError(null); }}
                    className="shrink-0 text-[11px] text-dim underline hover:text-fg"
                  >
                    clear
                  </button>
                )}
              </div>
              {fileError && <p className="text-[11px] text-alert">{fileError}</p>}
              {noteFile && !fileError && (
                <p className="text-[11px] text-dim">
                  Attached {noteFile.name} — stays in this browser, never uploaded.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  tone="ghost"
                  disabled={noteText.trim().length === 0}
                  onClick={() => {
                    addFixNote(ticket.ticket_id, {
                      author: crew?.name ?? ticket.reporter,
                      text: noteText.trim(),
                      link: noteLink.trim() || undefined,
                      attachment: noteFile,
                    });
                    setNoteText('');
                    setNoteLink('');
                    setNoteFile(undefined);
                  }}
                >
                  Add Note
                </Button>
                <Button
                  tone="primary"
                  disabled={noteText.trim().length === 0}
                  title="Logs this note as the final fix and moves the ticket to Resolved, awaiting validation"
                  onClick={() => {
                    submitFix(ticket.ticket_id, {
                      author: crew?.name ?? ticket.reporter,
                      text: noteText.trim(),
                      link: noteLink.trim() || undefined,
                      attachment: noteFile,
                    });
                    setNoteText('');
                    setNoteLink('');
                    setNoteFile(undefined);
                  }}
                >
                  Submit Fix → Resolved
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 border-t border-overlay/10 pt-4">
          <div className="eyebrow mb-2">Feedback to the model</div>
          {/* Separate from the close verdict on purpose. `resolution` answers
              "was there really a problem" — the model's own training label.
              This answers "did the model reason correctly". A ticket can be
              confirmed while the model blamed the wrong factor, and that is a
              different correction. */}
          <p className="mb-2 text-[11px] text-dim">
            Did the model read this site correctly? Recorded with the closure, and
            never required to close it.
          </p>
          {ticket.model_feedback && (
            <p className="mb-2 rounded-md border border-overlay/15 bg-overlay/[0.03] p-2 text-[11px] text-fg/85">
              <span className="font-semibold">
                {ticket.model_feedback.accurate === null
                  ? 'Comment only'
                  : ticket.model_feedback.accurate
                    ? 'Marked accurate'
                    : 'Marked wrong'}
              </span>
              {ticket.model_feedback.actual_factor && ` — really ${ticket.model_feedback.actual_factor}`}
              {ticket.model_feedback.comment && `: ${ticket.model_feedback.comment}`}
            </p>
          )}
          <div className="mb-2 flex gap-2">
            {([['Accurate', true], ['Wrong', false]] as const).map(([label, value]) => (
              <button
                key={label}
                type="button"
                onClick={() => setFbAccurate(fbAccurate === value ? null : value)}
                className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                  fbAccurate === value
                    ? 'border-accent/60 bg-accent/10 text-fg'
                    : 'border-overlay/15 text-dim hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {fbAccurate === false && (
            <input
              type="text"
              value={fbFactor}
              onChange={(e) => setFbFactor(e.target.value)}
              placeholder="What was the real cause? e.g. power"
              className="mb-2 w-full rounded-lg border border-overlay/15 bg-ink-800 px-3 py-1.5 text-[11px] text-fg placeholder:text-dim focus:border-accent focus:outline-none"
            />
          )}
          <textarea
            value={fbComment}
            onChange={(e) => setFbComment(e.target.value)}
            rows={2}
            placeholder="Anything the model should learn from this site (optional)"
            className="w-full resize-none rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 text-xs text-fg placeholder:text-dim focus:border-accent focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-dim">
              {ticket.model_feedback
                ? `Recorded ${formatDate(ticket.model_feedback.created_at)}`
                : 'Not recorded yet'}
            </span>
            <Button
              tone="ghost"
              disabled={fbAccurate === null && fbComment.trim().length === 0}
              onClick={() => {
                setModelFeedback(ticket.ticket_id, {
                  accurate: fbAccurate,
                  actual_factor: fbFactor.trim() || undefined,
                  comment: fbComment.trim() || undefined,
                  author: crew?.name ?? ticket.reporter,
                  created_at: new Date().toISOString(),
                });
                setFbAccurate(null);
                setFbFactor('');
                setFbComment('');
              }}
            >
              Save feedback
            </Button>
          </div>
        </div>

        <div className="mt-6 border-t border-overlay/10 pt-4">
          <div className="eyebrow mb-2">Close Ticket (admin/reporter only)</div>
          {closed ? (
            <p className="text-xs text-fg">
              Marked{' '}
              <strong style={{ color: ticket.resolution === 'confirmed' ? ink : 'var(--color-dim)' }}>
                {ticket.resolution === 'confirmed' ? 'Confirmed' : 'False Positive'}
              </strong>
              .
            </p>
          ) : (
            <>
              {showValidationAssistant && (
                <div className="mb-3 rounded-md border border-accent/25 bg-accent/[0.06] p-2.5">
                  <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
                    <SparkleIcon />
                    Validation Assistant — draft closeout (mocked)
                  </div>
                  <p className="text-xs italic leading-relaxed text-fg/80">{draftCloseoutSummary(ticket)}</p>
                </div>
              )}
              {showValidationAssistant ? (
                <div className="flex gap-2">
                  <Button
                    tone="ghost"
                    disabled={!canClose}
                    onClick={() => closeTicket(ticket.ticket_id, 'confirmed')}
                    className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:border-emerald-500/60 hover:bg-emerald-500/20"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="[&>svg]:h-3 [&>svg]:w-3"><SparkleIcon /></span>
                      Close Case with Validation
                    </div>
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    tone="primary"
                    disabled={!canClose}
                    title={!canClose ? 'Enabled once the PIC has submitted a fix (status: Resolved)' : undefined}
                    onClick={() => closeTicket(ticket.ticket_id, 'confirmed')}
                  >
                    Confirm Issue
                  </Button>
                  <Button
                    tone="ghost"
                    disabled={!canClose}
                    title={!canClose ? 'Enabled once the PIC has submitted a fix (status: Resolved)' : undefined}
                    onClick={() => closeTicket(ticket.ticket_id, 'false_positive')}
                  >
                    Mark False Positive
                  </Button>
                </div>
              )}
              {!canClose && (
                <p className="mt-2 text-[11px] text-dim">Enabled once status is Resolved.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
