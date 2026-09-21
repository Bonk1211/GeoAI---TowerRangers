export type TicketStatus = 'open' | 'active' | 'resolved' | 'closed';
export type TicketResolution = 'confirmed' | 'false_positive' | null;

/**
 * What the model believed WHEN THE TICKET WAS RAISED.
 *
 * Without this, the Close Loop page would compare a verdict recorded weeks ago
 * against whatever the model says today and present the pair as a measurement.
 * Absent on manually-raised tickets, which no model prediction produced.
 */
export interface ModelSnapshot {
  risk: number;
  /** The blended rank `decision` is actually cut on (model/ensemble.py). */
  priority: number;
  decision: 'maintain' | 'watch' | 'ok';
  dominant_factor: string;
  captured_at: string;
}

/**
 * The technician's verdict ON THE MODEL — distinct from `resolution`, which is
 * the verdict on the tower.
 *
 * `resolution` answers "was there really a problem?" and is the training label.
 * `accurate` answers "did the model reason correctly?" and is the attribution
 * signal. A ticket can be `confirmed` (a real fault) while the model blamed the
 * wrong factor; collapsing the two would discard the second correction.
 */
export interface ModelFeedback {
  accurate: boolean | null;
  /** Set when `accurate` is false: it said flood, it was really power. */
  actual_factor?: string;
  comment?: string;
  author: string;
  created_at: string;
}

/**
 * A file a technician attached to a fix note. Held in the browser only — the
 * bytes never reach a server, and the JSONL export carries name/type/size, not
 * `dataUrl`.
 */
export interface FixAttachment {
  name: string;
  type: string;
  size: number;
  /** base64 data URL, capped at 2 MB by the picker in TicketDrawer. */
  dataUrl: string;
}

export interface Ticket {
  ticket_id: string; // e.g. "T-1042"
  tower_id: string; // FK into TOWERS — never mutates the tower record
  title: string;
  description: string;
  issue_type: string; // free choice at report time, e.g. Equipment / Power / Structural / Other
  reporter: string;
  status: TicketStatus;
  assignee_crew_id: string | null; // FK into CREWS
  agent_ids?: string[]; // Optional AI Agents assigned — 0..SKILLS.length, any combination
  created_at: string; // ISO date
  target_sla: string | null; // ISO date, optional
  fix_notes: {
    author: string;
    created_at: string;
    text: string;
    /** Retained: seeded fixtures use it, and it predates real attachments. */
    link?: string;
    attachment?: FixAttachment;
  }[];
  resolution: TicketResolution; // set only when status = closed
  // manual         — a person filed it
  // demo_emergency — the Tickets page demo button
  // risk_model     — the risk model escalated a work order it could not get
  //                  scheduled before its deadline (state/useRiskEscalation.ts).
  //                  NOT every work order: the model raises 117 per run and
  //                  re-derives them whenever weights change, and a record
  //                  with a lifecycle and a reporter cannot be minted from
  //                  something that churns. Only the ones that ran out of
  //                  time become tickets.
  // contested_observation
  //                — a human raised it from the Close Loop queue, where the
  //                  served decision and the sampled imagery disagree. Distinct
  //                  from risk_model: the model did NOT ask for this one, it
  //                  said `ok`. The satellite is the dissenting party and a
  //                  person chose to act on the dissent.
  source: 'manual' | 'demo_emergency' | 'risk_model' | 'contested_observation';
  // Set automatically the moment agent_id becomes 'assignee_agent' on an
  // open ticket (state/useAutoDispatch.ts) — a hand-off flag to the Schedule
  // side, not a dispatch trigger. Ticket stays 'open' while this is true;
  // only a Schedule-side approval calling markScheduled() flips status to
  // 'active'. markScheduleFailed() is the reject path. See
  // docs/Ticket_To_Schedule_Handoff.md.
  schedule_pending?: boolean;
  schedule_failed?: boolean;
  // Compliance checklist (lib/fixChecklists.ts, MCMC TC G041:2023 Annex B/C)
  // submitted from the drawer. A record of what was checked, separate from
  // fix_notes — submitting does not add a fix note and does not change
  // status; the field-tech still writes the actual diagnosis/fix as text.
  // Re-submitting overwrites the previous result (single snapshot, not a log).
  compliance_checklist?: {
    issue_type: string; // the issue_type the checklist was run against
    checked_ids: string[]; // ChecklistItem ids the tech ticked
    completed_by: string;
    completed_at: string; // ISO date
  };
  /** Set by escalateWorkOrder at raise time. Absent on manual tickets. */
  model_snapshot?: ModelSnapshot;
  /** Set by setModelFeedback from the ticket drawer. */
  model_feedback?: ModelFeedback;
}

// Mock only — no ticket backend exists yet. Counts (3 open / 3 active /
// 1 resolved / 5 closed) match the board wireframe in
// docs/Ticket_System_Handoff.md §3 so the demo board looks exactly like the
// spec. Status meaning per §2: open (no crew yet) -> active (crew assigned,
// working) -> resolved (PIC submitted a fix, awaiting validation) -> closed
// (admin/reporter validated, resolution set).
export const TICKETS: Ticket[] = [
  {
    ticket_id: 'T-1040',
    tower_id: 'MY_N7033248825',
    title: 'Flood Damage to Base Cabinet',
    description: 'Standing water found around base cabinet after heavy rain, possible ingress.',
    issue_type: 'Structural',
    reporter: 'field-tech-02',
    status: 'open',
    assignee_crew_id: null,
    created_at: '2026-08-26T07:15:00Z',
    target_sla: '2026-08-30',
    fix_notes: [],
    resolution: null,
    source: 'manual',
  },
  {
    ticket_id: 'T-1041',
    tower_id: 'MY_N11484371222',
    title: 'Fence Breach Reported',
    description: 'Perimeter fence found breached, site tech flagged possible access risk.',
    issue_type: 'Other',
    reporter: 'field-tech-08',
    status: 'open',
    assignee_crew_id: null,
    created_at: '2026-08-26T15:50:00Z',
    target_sla: null,
    fix_notes: [],
    resolution: null,
    source: 'manual',
  },
  {
    ticket_id: 'T-1043',
    tower_id: 'MY_N9084071195',
    title: 'Signal Drop-outs After Lightning',
    description: 'Intermittent signal drop-outs reported following a lightning event overnight.',
    issue_type: 'Equipment',
    reporter: 'field-tech-04',
    status: 'open',
    assignee_crew_id: null,
    created_at: '2026-08-27T06:30:00Z',
    target_sla: '2026-09-02',
    fix_notes: [],
    resolution: null,
    source: 'manual',
  },
  {
    ticket_id: 'T-1038',
    tower_id: 'MY_N8899964134',
    title: 'Power Flicker at Cabinet',
    description: 'Cabinet power flickers intermittently, reported by site tech during routine visit.',
    issue_type: 'Power',
    reporter: 'field-tech-01',
    status: 'active',
    assignee_crew_id: 'KEL-P1',
    created_at: '2026-08-24T13:40:00Z',
    target_sla: '2026-08-29',
    fix_notes: [],
    resolution: null,
    source: 'manual',
  },
  {
    ticket_id: 'T-1039',
    tower_id: 'MY_N10802588425',
    title: "Generator Won't Start",
    description: 'Backup generator failed to start during scheduled test run.',
    issue_type: 'Equipment',
    reporter: 'field-tech-05',
    status: 'active',
    assignee_crew_id: 'KEL-E1',
    agent_ids: ['assignee_agent'],
    created_at: '2026-08-25T08:05:00Z',
    target_sla: '2026-08-31',
    fix_notes: [],
    resolution: null,
    source: 'manual',
  },
  {
    ticket_id: 'T-1042',
    tower_id: 'MY_N4758418627',
    title: 'Antenna Tilt After Storm',
    description:
      'Antenna visibly tilted after storm, needs inspection before next monsoon window.\nAttachment: site_photo_link.jpg (mock, not a real upload)',
    issue_type: 'Equipment',
    reporter: 'field-tech-03',
    status: 'active',
    assignee_crew_id: 'KEL-C2',
    created_at: '2026-08-25T09:10:00Z',
    target_sla: '2026-08-30',
    fix_notes: [
      {
        author: 'Gua Musang Civil',
        created_at: '2026-08-26T10:20:00Z',
        text: 'Inspected — bracket loosened, tightening scheduled.',
        link: 'inspection_note.pdf',
      },
    ],
    resolution: null,
    source: 'manual',
  },
  {
    ticket_id: 'T-1044',
    tower_id: 'MY_W1388820991',
    title: 'Battery Backup Draining Fast',
    description: 'Backup battery observed draining faster than rated capacity during outage test.',
    issue_type: 'Power',
    reporter: 'field-tech-01',
    status: 'resolved',
    assignee_crew_id: 'KEL-P1',
    agent_ids: ['validation_assistant'],
    created_at: '2026-08-19T10:30:00Z',
    target_sla: '2026-08-23',
    fix_notes: [
      {
        author: 'Kelantan Power',
        created_at: '2026-08-22T11:30:00Z',
        text: 'Swapped degraded battery pack, load test passed. Ready for validation.',
        link: 'battery_swap_report.pdf',
      },
    ],
    resolution: null,
    source: 'manual',
  },
  {
    ticket_id: 'T-1035',
    tower_id: 'MY_N8422298542',
    title: 'Corroded Anchor Bolts',
    description: 'Visible corrosion on tower base anchor bolts, flagged during routine inspection.',
    issue_type: 'Structural',
    reporter: 'field-tech-06',
    status: 'closed',
    assignee_crew_id: 'KEL-C1',
    created_at: '2026-08-20T09:00:00Z',
    target_sla: '2026-08-24',
    fix_notes: [
      {
        author: 'Kota Bharu Civil',
        created_at: '2026-08-23T09:00:00Z',
        text: 'Replaced anchor bolts, retested load rating — within spec.',
        link: 'load_test_report.pdf',
      },
    ],
    resolution: 'confirmed',
    source: 'manual',
  },
  {
    ticket_id: 'T-1030',
    tower_id: 'MY_N8987661324',
    title: 'False Motion Alarm',
    description: 'Site alarm triggered overnight with no visible cause on arrival.',
    issue_type: 'Other',
    reporter: 'field-tech-07',
    status: 'closed',
    assignee_crew_id: 'KEL-R1',
    created_at: '2026-08-18T11:00:00Z',
    target_sla: '2026-08-22',
    fix_notes: [
      {
        author: 'Kelantan RF',
        created_at: '2026-08-21T14:00:00Z',
        text: 'Investigated on-site, no fault found. Sensor false-triggered by foliage.',
      },
    ],
    resolution: 'false_positive',
    source: 'manual',
  },
  {
    ticket_id: 'T-1031',
    tower_id: 'MY_N5742976628',
    title: 'Corroded Battery Terminals',
    description: 'Battery terminals showing corrosion during scheduled power audit.',
    issue_type: 'Power',
    reporter: 'field-tech-01',
    status: 'closed',
    assignee_crew_id: 'KEL-P1',
    created_at: '2026-08-19T10:30:00Z',
    target_sla: '2026-08-23',
    fix_notes: [
      {
        author: 'Kelantan Power',
        created_at: '2026-08-22T11:30:00Z',
        text: 'Cleaned and resealed terminals, load test passed.',
      },
    ],
    resolution: 'confirmed',
    source: 'manual',
  },
  {
    ticket_id: 'T-1032',
    tower_id: 'MY_N13678930905',
    title: 'Cracked Equipment Housing',
    description: 'Hairline crack found on outdoor equipment housing during weather inspection.',
    issue_type: 'Equipment',
    reporter: 'field-tech-03',
    status: 'closed',
    assignee_crew_id: 'KEL-E1',
    created_at: '2026-08-19T14:20:00Z',
    target_sla: '2026-08-25',
    fix_notes: [
      {
        author: 'Kelantan Electrical',
        created_at: '2026-08-24T16:00:00Z',
        text: 'Housing resealed, no equipment ingress detected.',
      },
    ],
    resolution: 'confirmed',
    source: 'manual',
  },
  {
    ticket_id: 'T-1033',
    tower_id: 'MY_N11515263684',
    title: 'Overgrown Access Track',
    description: 'Access track overgrown, crew reported difficulty reaching the site on last visit.',
    issue_type: 'Structural',
    reporter: 'field-tech-08',
    status: 'closed',
    assignee_crew_id: 'KEL-C2',
    created_at: '2026-08-20T08:45:00Z',
    target_sla: '2026-08-26',
    fix_notes: [
      {
        author: 'Gua Musang Civil',
        created_at: '2026-08-25T08:00:00Z',
        text: 'Vegetation cleared, access track passable for service vehicle.',
      },
    ],
    resolution: 'confirmed',
    source: 'manual',
  },
];

export const ISSUE_TYPES = ['Equipment', 'Power', 'Structural', 'Other'] as const;

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  active: 'Active',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const TICKET_STATUSES: TicketStatus[] = ['open', 'active', 'resolved', 'closed'];

// Manual dropdown only ever offers these two — `resolved` is reached by the
// PIC's Submit Fix action and `closed` only by the admin/reporter's Confirm
// Issue / Mark False Positive action (§4), never a bare status pick.
export const EDITABLE_STATUSES: TicketStatus[] = ['open', 'active'];
