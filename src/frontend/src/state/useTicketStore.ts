import { create } from 'zustand';
import { TICKETS, type Ticket, type TicketStatus, type TicketResolution, type ModelFeedback, type FixAttachment } from '../fixtures/tickets';
import { DEFAULT_PINNED_SKILLS, type SkillId } from '../fixtures/skills';
import { CREWS } from '../fixtures/crews';
import { placeName, hasPlaceName } from '../fixtures/schedule';
import { actionForFactor } from '../lib/actions';
import type { Tower } from '../api/types';
import type { TowerBelief } from '../lib/feedbackCorpus';

// Reverse of the tower's own dominant_factor -> the ticket-side issue_type
// vocabulary (ISSUE_TYPES). Keeps the demo ticket's stated problem consistent
// with the real reason the tower is flagged, rather than a random pairing.
const FACTOR_TO_ISSUE_TYPE: Record<string, string> = {
  flood: 'Structural',
  terrain: 'Structural',
  lightning: 'Equipment',
  equipment: 'Equipment',
  power: 'Power',
  vegetation: 'Other',
};

const EMERGENCY_TITLES_BY_ISSUE_TYPE: Record<string, string> = {
  Equipment: 'Critical Equipment Fault — Site Down',
  Power: 'Total Power Loss — Site on Backup',
  Structural: 'Structural Failure Risk — Urgent Inspection',
  Other: 'Urgent Field Report — Immediate Attention Needed',
};

let nextTicketSeq = 1045; // one past the highest seeded T-104x id
let nextNotificationSeq = 1;

export interface NewTicketInput {
  title: string;
  tower_id: string;
  issue_type: string;
  reporter: string;
  description: string;
}

export interface TicketNotification {
  id: string;
  text: string;
  created_at: string;
}

interface TicketStoreState {
  tickets: Ticket[];
  setStatus: (ticket_id: string, status: TicketStatus) => void;
  assignCrew: (ticket_id: string, crew_id: string | null) => void;
  addFixNote: (ticket_id: string, note: { author: string; text: string; link?: string; attachment?: FixAttachment }) => void;
  // Records a completed compliance checklist (lib/fixChecklists.ts). Separate
  // from addFixNote/submitFix — does not touch fix_notes or status, only
  // ticket.compliance_checklist. Re-submitting overwrites the prior result.
  submitChecklist: (ticket_id: string, result: { issue_type: string; checked_ids: string[]; completed_by: string }) => void;
  submitFix: (ticket_id: string, note: { author: string; text: string; link?: string; attachment?: FixAttachment }) => void;
  closeTicket: (ticket_id: string, resolution: Exclude<TicketResolution, null>) => void;
  /**
   * Records the technician's assessment OF THE MODEL. Independent of
   * closeTicket: a ticket can be closed without it, and it can be set before
   * closing. Never gates the close — override.py's "never block" rule applies
   * to judgement too.
   */
  setModelFeedback: (ticket_id: string, feedback: ModelFeedback) => void;
  createTicket: (input: NewTicketInput) => Ticket;
  // Takes the caller's real live tower list (useLiveTowers()) rather than
  // reading the frontend's own static fixture — a ticket generated against a
  // tower id the backend has never heard of 404s the moment it reaches
  // /schedule/pin, since the backend's scored_towers() population (real
  // dataset or USE_FIXTURE) is a completely separate id space from
  // fixtures/towers.ts's offline mock towers.
  createEmergencyTicket: (liveTowers: Tower[]) => Ticket | null;
  /**
   * Raise a ticket for a work order the solver could not fit before its
   * deadline. Returns null — raising nothing — when this tower already has a
   * live risk_model ticket, which is what makes it safe to call on every
   * solver run: the run re-derives all 117 work orders each time, so without
   * a dedup the same tower would mint a ticket per re-optimise.
   *
   * `deadline` is the work order's own SLA date, so the ticket carries a real
   * target_sla rather than the demo path's null.
   */
  escalateWorkOrder: (input: {
    tower: Tower;
    deadline: string | null;
    reason: string;
    /**
     * True only when the deadline actually falls inside the planning horizon.
     * The automatic path escalates ONLY at-risk work, but the queue's manual
     * "Raise ticket" can promote any waiting row, including a deferred one
     * whose deadline is weeks out — and a ticket claiming an SLA is in danger
     * when it is not is a false alarm the model gets blamed for.
     */
    atRisk: boolean;
  }) => Ticket | null;
  /**
   * Raise a ticket from the Close Loop adjudication queue.
   *
   * The queue lists towers where the served decision and the sampled imagery
   * disagree and no human has been. This is the gesture that starts the loop
   * turning: ticket -> technician verdict -> corpus row -> exportable label.
   *
   * Returns null when a live ticket already covers the tower, which is what
   * makes it safe to wire straight to a button — a double click, or a second
   * operator working the same queue, cannot mint a duplicate.
   */
  raiseFromContested: (input: {
    /**
     * Only the five belief fields, not a whole Tower. That is genuinely all a
     * raise reads, and the contested queue carries exactly this shape — a live
     * Tower satisfies it structurally, so callers pass one unchanged.
     */
    tower: TowerBelief;
    /** Rank of the imagery contradiction, 0-1. Null when unrecorded. */
    changeRank: number | null;
    /** The decision the ledger row was served against, not today's. */
    modelSaid: string;
    /** The sampled window the contradiction was measured over, if recorded. */
    windowRecent?: string;
  }) => Ticket | null;
  // Toggles one skill in/out of a ticket's agent_ids — a ticket may carry
  // any subset of SKILLS at once, not just one.
  toggleAgentId: (ticket_id: string, agent_id: string) => void;
  // markSchedulePending is set automatically (useAutoDispatch) the moment
  // agent_id becomes 'assignee_agent' on an open ticket — a hand-off flag,
  // not a dispatch trigger. markScheduled/markScheduleFailed are NOT called
  // from this codebase's own ticket UI: they exist for the Schedule-side
  // approval flow (a teammate's build) to call once a human approves or
  // rejects the agent's crew/day suggestion there. Until one of those fires,
  // the ticket stays 'open' with schedule_pending true.
  markSchedulePending: (ticket_id: string) => void;
  markScheduled: (ticket_id: string, crew_id: string) => void;
  markScheduleFailed: (ticket_id: string) => void;

  // §5 per-column skill picker — which of the 3 fixed skills is pinned to
  // each status column. Editable via the dropdown, not hardcoded.
  pinnedSkills: Record<TicketStatus, SkillId | null>;
  setPinnedSkill: (status: TicketStatus, skill: SkillId | null) => void;

  // Notifier (§5) — mocked, in-app only. Fires on Open->Active and
  // Resolved->Closed. Never claims a real email/push was sent.
  notifications: TicketNotification[];
  dismissNotification: (id: string) => void;
}

function notify(text: string): TicketNotification {
  return { id: `n-${nextNotificationSeq++}`, text, created_at: new Date().toISOString() };
}

// No ticket backend exists yet (docs/Ticket_System_Handoff.md §0.4) — every
// mutation here is local state only, mirroring the offline-mutation pattern
// useScheduleStore already uses for its fixture-backed path.
export const useTicketStore = create<TicketStoreState>((set, get) => ({
  tickets: TICKETS,
  pinnedSkills: { ...DEFAULT_PINNED_SKILLS },
  notifications: [],

  setStatus: (ticket_id, status) =>
    set((s) => ({
      tickets: s.tickets.map((t) => (t.ticket_id === ticket_id ? { ...t, status } : t)),
    })),

  assignCrew: (ticket_id, crew_id) => {
    const ticket = get().tickets.find((t) => t.ticket_id === ticket_id);
    const wasOpen = ticket?.status === 'open';
    const crew = crew_id ? CREWS.find((c) => c.crew_id === crew_id) : undefined;

    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id
          ? {
              ...t,
              assignee_crew_id: crew_id,
              // Assigning a crew to an open ticket is the same action a
              // dispatcher takes to move it out of the open column — no
              // separate status click should be required for the common case.
              status: crew_id && t.status === 'open' ? 'active' : t.status,
            }
          : t,
      ),
    }));

    // Notifier: Open -> Active tells the newly-assigned crew.
    if (wasOpen && crew_id && crew) {
      set((s) => ({ notifications: [...s.notifications, notify(`Notified ${crew.name} — new ticket assigned (mocked)`)] }));
    }
  },

  addFixNote: (ticket_id, note) =>
    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id
          ? {
              ...t,
              fix_notes: [...t.fix_notes, { ...note, created_at: new Date().toISOString() }],
            }
          : t,
      ),
    })),

  submitChecklist: (ticket_id, result) =>
    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id
          ? { ...t, compliance_checklist: { ...result, completed_at: new Date().toISOString() } }
          : t,
      ),
    })),

  // PIC-side: logs the final fix note and moves active -> resolved,
  // awaiting admin/reporter validation (§2 status table, §4 drawer).
  submitFix: (ticket_id, note) =>
    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id
          ? {
              ...t,
              fix_notes: [...t.fix_notes, { ...note, created_at: new Date().toISOString() }],
              status: 'resolved',
            }
          : t,
      ),
    })),

  // Admin/reporter-side: validates the PIC's fix, sets resolution, moves
  // resolved -> closed. Never callable from any other status.
  closeTicket: (ticket_id, resolution) => {
    const ticket = get().tickets.find((t) => t.ticket_id === ticket_id);

    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id ? { ...t, status: 'closed', resolution } : t,
      ),
    }));

    // Notifier: Resolved -> Closed tells the reporter.
    if (ticket) {
      set((s) => ({
        notifications: [
          ...s.notifications,
          notify(`Notified ${ticket.reporter} — ticket closed, marked ${resolution === 'confirmed' ? 'confirmed' : 'false positive'} (mocked)`),
        ],
      }));
    }
  },

  setModelFeedback: (ticket_id, feedback) =>
    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id ? { ...t, model_feedback: feedback } : t,
      ),
    })),

  createTicket: (input) => {
    const ticket: Ticket = {
      ticket_id: `T-${nextTicketSeq++}`,
      tower_id: input.tower_id,
      title: input.title,
      description: input.description,
      issue_type: input.issue_type,
      reporter: input.reporter,
      status: 'open',
      assignee_crew_id: null,
      created_at: new Date().toISOString(),
      target_sla: null,
      fix_notes: [],
      resolution: null,
      source: 'manual',
    };
    set((s) => ({ tickets: [ticket, ...s.tickets] }));
    return ticket;
  },

  // Demo Emergency Ticket button (Tickets page header). Picks a real
  // maintain-band tower off the CALLER'S live tower list (useLiveTowers(),
  // real /towers data or its offline fixture fallback — never the frontend's
  // own static fixtures/towers.ts) and generates an urgent ticket against it.
  // Narrative stand-in for a field report arriving out of band, not a live
  // sensor->ticket pipeline (docs/Ticket_System_Handoff.md §7 still holds: no
  // ML->ticket auto-spawn wiring exists). Returns null if no towers are
  // loaded yet (e.g. clicked before /towers resolves) — the caller must not
  // fabricate a tower_id the backend has never heard of, since that 404s the
  // moment it reaches /schedule/pin.
  createEmergencyTicket: (liveTowers) => {
    if (liveTowers.length === 0) return null;
    const maintainTowers = liveTowers.filter((t) => t.decision === 'maintain');
    const pool = maintainTowers.length > 0 ? maintainTowers : liveTowers;
    const tower = pool[Math.floor(Math.random() * pool.length)];
    const issue_type = FACTOR_TO_ISSUE_TYPE[tower.dominant_factor] ?? 'Other';
    // placeName() only knows the small offline-fixture tower set — for a
    // real-dataset tower it falls back to the bare tower_id, which reads as
    // "MY_1017 · MY_1017" in the ticket. territory (the real record's ADM1
    // state) is a genuine field on every real tower and reads better.
    const site = hasPlaceName(tower.tower_id) ? placeName(tower.tower_id) : tower.territory;

    const ticket: Ticket = {
      ticket_id: `T-${nextTicketSeq++}`,
      tower_id: tower.tower_id,
      title: EMERGENCY_TITLES_BY_ISSUE_TYPE[issue_type] ?? EMERGENCY_TITLES_BY_ISSUE_TYPE.Other,
      description: `Field report flags an urgent ${issue_type.toLowerCase()} condition at ${site} (${tower.tower_id}). Immediate assessment requested — dispatch a crew or route to the Assignee Agent.`,
      issue_type,
      reporter: 'field-alert-system',
      status: 'open',
      assignee_crew_id: null,
      created_at: new Date().toISOString(),
      target_sla: null,
      fix_notes: [],
      resolution: null,
      source: 'demo_emergency',
    };
    set((s) => ({ tickets: [ticket, ...s.tickets] }));
    return ticket;
  },

  escalateWorkOrder: ({ tower, deadline, reason, atRisk }) => {
    // Idempotency, and the reason this can run on every solver resolve.
    //
    // A live ticket is one still open or being worked. A resolved/closed one
    // does NOT block a re-raise — the site genuinely came back — but a
    // rejected one does, via schedule_failed: rejecting an escalation and
    // having it reappear on the next re-optimise is a loop, not a workflow.
    const existing = get().tickets.find(
      (t) =>
        t.tower_id === tower.tower_id &&
        t.source === 'risk_model' &&
        (t.status === 'open' || t.status === 'active'),
    );
    if (existing) return null;

    const issue_type = FACTOR_TO_ISSUE_TYPE[tower.dominant_factor] ?? 'Other';
    const site = hasPlaceName(tower.tower_id) ? placeName(tower.tower_id) : tower.territory;
    const spec = actionForFactor(tower.dominant_factor);
    // Reasons no queue will ever clear. Keyed on the space-separated form
    // because useRiskEscalation flattens the solver's snake_case reason.
    //
    // Measured nationally: 47 of 50 towers the solver could not place had no
    // crew able to reach them on ANY day, while 108 of 210 crew-days sat
    // idle. Before the solver split these out of `no_capacity` they all
    // arrived here as "waiting for capacity" — a queue position that does
    // not exist, on a ticket a planner would rightly leave alone. Each one
    // needs a decision (a depot, a dispatch rule) that waiting cannot make.
    const COVERAGE_GAP: Record<string, string> = {
      'no crew type':
        `there is no ${tower.territory} crew of the required capability, so waiting will not schedule it. This needs a roster decision, not a dispatch.`,
      'out of range':
        `no depot staffing the required crew type is within driving range of this site, so waiting will not schedule it. This needs a coverage decision — a depot or a crew — not a dispatch.`,
      'out of territory':
        `the nearest crew able to reach this site belongs to another territory and is never offered it, so waiting will not schedule it. This needs a dispatch-rule decision, not a queue.`,
      'no route':
        `no road route to this site exists from any depot staffing the required crew type, so waiting will not schedule it. This needs an access decision, not a dispatch.`,
    };
    const coverageGap = COVERAGE_GAP[reason];

    const ticket: Ticket = {
      ticket_id: `T-${nextTicketSeq++}`,
      tower_id: tower.tower_id,
      // Names the model as the author. A planner reading a queue of these
      // must never have to guess whether a human saw something.
      // Three different situations, three different headlines. They are not
      // interchangeable: "waiting for capacity" on a tower no crew can serve
      // implies a queue that will clear, and the planner would leave it
      // alone waiting for one.
      title: atRisk
        ? `Maintenance due — ${site} at SLA risk`
        : reason === 'no crew type'
          ? `No crew available — ${site} cannot be scheduled`
          : coverageGap
            ? `Out of reach — ${site} cannot be scheduled`
            : `Maintenance due — ${site} waiting for capacity`,
      // Every clause is a real value: the intervention comes from
      // actions.yaml via lib/actions.ts, the reason is the solver's own
      // unscheduled reason, and the risk is the served score. Nothing here
      // is written to sound like a field report, because nobody was there.
      description:
        `Risk model scored ${tower.tower_id} at ${tower.risk.toFixed(2)} (${tower.dominant_factor}) ` +
        `and raised: ${spec.label}. The scheduler could not fit it this week (${reason})` +
        (coverageGap
          ? ` — ${coverageGap}`
          : !deadline
            ? '.'
            : atRisk
              ? `, and its ${deadline} deadline falls inside the current planning horizon.`
              : `. Its ${deadline} deadline is beyond this horizon, so it is not yet late.`) +
        ` No field report — this is a predicted need, not an observed fault.`,
      issue_type,
      reporter: 'risk-model',
      status: 'open',
      assignee_crew_id: null,
      created_at: new Date().toISOString(),
      target_sla: deadline,
      fix_notes: [],
      resolution: null,
      source: 'risk_model',
      // The model's belief AT RAISE TIME. Read here because this is the only
      // moment it is knowable: the tower is rescored on every weights change,
      // so asking later returns a different model's opinion and the Close Loop
      // page would compare it against a verdict it never produced.
      model_snapshot: {
        risk: tower.risk,
        priority: tower.priority,
        decision: tower.decision,
        dominant_factor: tower.dominant_factor,
        captured_at: new Date().toISOString(),
      },
    };
    set((s) => ({ tickets: [ticket, ...s.tickets] }));
    return ticket;
  },

  raiseFromContested: ({ tower, changeRank, modelSaid, windowRecent }) => {
    // Same dedup rule as escalateWorkOrder: one live ticket per tower. A
    // closed one does not block a fresh raise — that tower was adjudicated
    // once and a standing contradiction deserves another visit.
    const live = get().tickets.find(
      (t) => t.tower_id === tower.tower_id && t.status !== 'closed',
    );
    if (live) return null;

    const rank = changeRank === null ? null : changeRank.toFixed(2);
    const ticket: Ticket = {
      ticket_id: `T-${nextTicketSeq++}`,
      tower_id: tower.tower_id,
      title: `Imagery contradicts "${modelSaid}" at ${tower.tower_id}`,
      // Every clause is a measured value. The point of this ticket is that
      // the model and the satellite disagree, so overstating either side
      // would defeat it — note in particular that this says the imagery
      // changed, NOT that a fault exists. Nobody has been yet.
      description:
        `The served decision for this tower was "${modelSaid}"` +
        ` (priority ${tower.priority.toFixed(2)}, dominant factor ${tower.dominant_factor}).` +
        (rank
          ? ` Sentinel-2 vegetation change over the sampled window ranks ${rank} across the estate,`
          : ' Sentinel-2 sampled a contradicting vegetation change over the window,') +
        ` which contradicts that decision.` +
        (windowRecent ? ` Window: ${windowRecent}.` : '') +
        ` No field report — this is an unadjudicated disagreement between the model and the` +
        ` imagery, not an observed fault. Closing this ticket with a verdict is what labels it.`,
      // Vegetation change around a compound is access, encroachment and
      // erosion — structural, not an equipment complaint.
      issue_type: 'Structural',
      reporter: 'close-loop-queue',
      status: 'open',
      assignee_crew_id: null,
      created_at: new Date().toISOString(),
      target_sla: null,
      fix_notes: [],
      resolution: null,
      source: 'contested_observation',
      // The model's belief AT RAISE TIME, for the same reason
      // escalateWorkOrder captures one: the tower is rescored on every
      // weights change, so asking later returns a different model's opinion.
      // This is also what lets the closure land in the Close Loop 2x2 with
      // belief_at 'raise' rather than falling back to today's score.
      model_snapshot: {
        risk: tower.risk,
        priority: tower.priority,
        decision: tower.decision,
        dominant_factor: tower.dominant_factor,
        captured_at: new Date().toISOString(),
      },
    };
    set((s) => ({ tickets: [ticket, ...s.tickets] }));
    return ticket;
  },

  // Clears schedule_failed whenever a skill is (re)toggled on — reassigning
  // Assignee Agent after a failed dispatch is the retry gesture, and
  // useAutoDispatch's own guard only skips tickets still marked failed.
  toggleAgentId: (ticket_id, agent_id) =>
    set((s) => ({
      tickets: s.tickets.map((t) => {
        if (t.ticket_id !== ticket_id) return t;
        const current = t.agent_ids ?? [];
        const isOn = current.includes(agent_id);
        const agent_ids = isOn ? current.filter((id) => id !== agent_id) : [...current, agent_id];
        return { ...t, agent_ids, schedule_failed: isOn ? t.schedule_failed : false };
      }),
    })),

  markSchedulePending: (ticket_id) =>
    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id ? { ...t, schedule_pending: true, schedule_failed: false } : t,
      ),
    })),

  // The optimizer's own pin success is what unlocks Active — nothing else
  // moves a ticket out of Open (see the schedule_pending doc comment on the
  // Ticket type).
  markScheduled: (ticket_id, crew_id) => {
    const wasOpen = get().tickets.find((t) => t.ticket_id === ticket_id)?.status === 'open';

    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id
          ? { ...t, status: 'active', assignee_crew_id: crew_id, schedule_pending: false, schedule_failed: false }
          : t,
      ),
    }));

    // Notifier (Ticket_System_Handoff §5) fires on Open -> Active, and this
    // is one — the approval flow must not skip the notification just because
    // the transition arrived from Schedule rather than the assign dropdown.
    //
    // Falls back to the raw crew_id: the crew the optimizer booked comes from
    // the LIVE roster (/crews), which carries crews the CREWS fixture does
    // not, and a lookup miss must not silently swallow the notification.
    if (wasOpen) {
      const name = CREWS.find((c) => c.crew_id === crew_id)?.name ?? crew_id;
      set((s) => ({
        notifications: [...s.notifications, notify(`Notified ${name} — new ticket assigned (mocked)`)],
      }));
    }
  },

  markScheduleFailed: (ticket_id) =>
    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.ticket_id === ticket_id ? { ...t, schedule_pending: false, schedule_failed: true } : t,
      ),
    })),

  setPinnedSkill: (status, skill) =>
    set((s) => ({ pinnedSkills: { ...s.pinnedSkills, [status]: skill } })),

  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
}));
