import { useEffect } from 'react';
import { useTicketStore } from './useTicketStore';

/**
 * Assigning the Assignee Agent skill to an open ticket marks it pending —
 * it does NOT dispatch anything itself. The actual crew/day suggestion,
 * approval, and optimizer pin all happen on the Schedule side (Ranger chat),
 * which is a teammate's build, not this one. This hook's only job is the
 * hand-off: flip `schedule_pending` the moment 'assignee_agent' enters
 * agent_ids on an open ticket, so the Schedule side has a flag +
 * tower_id to watch for and build its own notification/approval UI from.
 *
 * Ticket only reaches 'active' when something on the Schedule side calls
 * markScheduled() after a human approves — never automatically here.
 *
 * Mounted once at the Tickets page level (not per-drawer/per-card) so it
 * fires regardless of where agent_ids got set (TicketCard's picker or the
 * drawer), and survives the drawer being closed.
 */
export function useAutoDispatch() {
  const tickets = useTicketStore((s) => s.tickets);
  const markSchedulePending = useTicketStore((s) => s.markSchedulePending);

  // Dev-only hand-off trace. Kept in its own effect so the decision below is
  // untouched and this is one deletable block.
  //
  // Why it exists: the hand-off has two AND-ed preconditions and three
  // different controls can assign a crew, two of which satisfy NEITHER. The
  // manual Assignee dropdown and the suggested-crews "Assign" button both call
  // assignCrew(), which flips status open -> active, so the ticket is
  // permanently disqualified without anything visibly failing. Only
  // TicketCard's sparkle picker calls setAgentId. When nothing appears on the
  // Schedule side, this table says which precondition is missing.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const rows = tickets.map((t) => ({
      ticket: t.ticket_id,
      status: t.status,
      agent_ids: t.agent_ids?.length ? t.agent_ids.join(', ') : '—',
      schedule_pending: Boolean(t.schedule_pending),
      schedule_failed: Boolean(t.schedule_failed),
      blocked_by:
        !t.agent_ids?.includes('assignee_agent')
          ? 'no Assignee Agent (use the sparkle + on the CARD, not the drawer)'
          : t.status !== 'open'
            ? `status is '${t.status}', hand-off needs 'open' — a crew was assigned manually`
            : t.schedule_pending
              ? '— already handed off'
              : t.schedule_failed
                ? 'rejected on Schedule; re-pick the agent to retry'
                : '— eligible now',
    }));
    const pending = rows.filter((r) => r.schedule_pending).length;
    console.groupCollapsed(
      `[ticket handoff] ${pending} pending · ${tickets.length} tickets — expand for why`,
    );
    console.table(rows);
    console.groupEnd();
  }, [tickets]);

  useEffect(() => {
    const due = tickets.find(
      (t) => t.agent_ids?.includes('assignee_agent') && t.status === 'open' && !t.schedule_pending && !t.schedule_failed,
    );
    if (due) {
      if (import.meta.env.DEV) {
        console.info(`[ticket handoff] ${due.ticket_id} -> schedule_pending (tower ${due.tower_id})`);
      }
      markSchedulePending(due.ticket_id);
    }
  }, [tickets, markSchedulePending]);
}
