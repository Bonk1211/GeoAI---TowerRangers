import { useEffect } from 'react';
import { useScheduleStore } from './useScheduleStore';
import { useTicketStore } from './useTicketStore';
import { useWeights } from './useWeights';
import { useLiveTowers } from '../api/useLiveTowers';

/**
 * The missing first link: risk model -> ticket -> schedule.
 *
 * Until this existed, every ticket in the system was either a fixture or the
 * demo button firing at a RANDOM maintain-band tower — so the story the demo
 * tells ("the model flagged this site, and it needs a crew now") was being
 * narrated over a tower the model had said nothing in particular about. The
 * schedule half of that pipeline was already built and verified; only its
 * source was fictional.
 *
 * WHAT ESCALATES, AND WHY NOT EVERYTHING
 *
 * The solver returns ~117 work orders per run and re-derives all of them
 * whenever anything changes — a weight slider, a re-optimise, a pin. Minting
 * a ticket per work order would put a lifecycle, a reporter and a resolution
 * on something that churns, and would need reconciliation logic nobody wants
 * (which tickets close when risk shifts? which duplicate?).
 *
 * TWO CONDITIONS ESCALATE, AND THE DEADLINE ONE IS NOT THE USEFUL ONE
 *
 * 1. `no_crew_type` — the solver has NO crew of the required capability in
 *    that tower's territory. This is not a queue that will clear: no amount
 *    of waiting produces a crew, so the job is unschedulable until somebody
 *    changes the roster. Measured on the live board: 6 towers, risk 0.85 to
 *    0.96, needing power crews in Johor / Sarawak / Negeri Sembilan and civil
 *    crews in Penang. A permanent capability gap on high-risk sites is
 *    exactly what a durable record is for.
 *
 * 2. SLA — `past_sla`, or a deadline landing inside the horizon. Same
 *    predicate as WorkQueue's "SLA at risk" tab, so the two can never
 *    disagree.
 *
 * **Condition 2 currently never fires, and that is a property of the data,
 * not a bug here.** Deadlines are `today + urgency_days`; the smallest
 * urgency_days the model produces is 8 days against a 7-day horizon, so
 * measured across the whole run, 0 of 62 deadlines fall inside it — and
 * advancing the clock moves both ends together, so it stays 0. The condition
 * is kept because it is the correct trigger the moment urgency tightens (a
 * weather multiplier shortening a flood-dominant SLA does exactly that), and
 * because leaving the tab and this hook on different predicates is how they
 * drift apart. It is simply not the one carrying the demo.
 *
 * Both counts are small by construction, which is what makes an automatic
 * write safe.
 */
export function useRiskEscalation() {
  const run = useScheduleStore((s) => s.run);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const escalateWorkOrder = useTicketStore((s) => s.escalateWorkOrder);
  const toggleAgentId = useTicketStore((s) => s.toggleAgentId);

  useEffect(() => {
    const lastDay = run.horizon[run.horizon.length - 1];
    if (!lastDay || towers.length === 0) return;

    for (const detail of run.unscheduled_detail) {
      // Same predicate as WorkQueue's isSlaAtRisk: past its SLA already, or
      // its deadline lands on or before the last day we are planning.
      const atRisk =
        detail.reason === 'past_sla' || (!!detail.deadline && detail.deadline <= lastDay);
      // No crew of this capability exists in this territory — waiting cannot
      // fix it, so it never leaves the queue on its own.
      const unservable = detail.reason === 'no_crew_type';
      if (!atRisk && !unservable) continue;

      const tower = towers.find((t) => t.tower_id === detail.tower_id);
      // No live tower record means no coordinates, no risk and no factor —
      // every field the ticket would carry. Skipped rather than filled with
      // placeholders, for the same reason createEmergencyTicket refuses to
      // invent a tower_id: a ticket the backend cannot resolve 404s the
      // moment it reaches /schedule/pin.
      if (!tower) continue;

      const ticket = escalateWorkOrder({
        tower,
        deadline: detail.deadline,
        reason: detail.reason.replace(/_/g, ' '),
        atRisk,
      });
      // null means this tower already has a live escalation — the dedup that
      // makes running on every resolve safe.
      if (!ticket) continue;

      // ONLY dispatchable work is routed to the approval flow.
      //
      // An at-risk job is late but schedulable, so it goes straight into the
      // hand-off: useAutoDispatch sees the agent on an open ticket and sets
      // schedule_pending. Nothing is booked until a human approves.
      //
      // An UNSERVABLE one must not. There is no crew to propose, so the
      // approval panel could only ever tell the planner the same thing again
      // and offer them Reject — a pending approval that exists solely to be
      // dismissed. What that ticket actually needs is a roster decision
      // (extend a range, add a depot, accept the site is out of scope), which
      // is a person's call, so it lands Open and unassigned and waits for one.
      if (atRisk) toggleAgentId(ticket.ticket_id, 'assignee_agent');
    }
    // `towers` gets a fresh array identity on most renders (useLiveTowers),
    // so it is deliberately keyed on length rather than the array itself —
    // otherwise this fires on every render instead of on every resolve. The
    // dedup inside escalateWorkOrder is the real guard; this only keeps the
    // effect from spinning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.run_id, run.unscheduled_detail, run.horizon, towers.length]);
}
