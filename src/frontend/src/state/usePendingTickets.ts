import { useEffect, useMemo, useRef } from 'react';
import { useTicketStore } from './useTicketStore';
import type { Ticket } from '../fixtures/tickets';

/**
 * Tickets handed to Schedule by useAutoDispatch and not yet resolved here —
 * the queue the Ranger dock's strip lists and its collapsed pill counts.
 *
 * Lives in state/ rather than beside the strip component so both consumers
 * share one definition without a component file also exporting a hook, which
 * costs Fast Refresh (react/only-export-components).
 */
export function usePendingTickets(): Ticket[] {
  // Select the stable `tickets` reference and filter in useMemo — NOT
  // `useTicketStore((s) => s.tickets.filter(...))`. A selector that builds a
  // new array on every call returns a fresh snapshot each time React asks for
  // one, which under useSyncExternalStore is the "getSnapshot should be
  // cached" infinite-render fault.
  const tickets = useTicketStore((s) => s.tickets);
  const pending = useMemo(
    () => tickets.filter((t) => t.schedule_pending && t.status === 'open'),
    [tickets],
  );

  // Dev-only, and only on CHANGE — this hook has two consumers (the strip and
  // the dock's badge) and runs on every render, so an unguarded log would
  // spam. Confirms the flag actually crossed from the Tickets page to the
  // Schedule page, which is the half useAutoDispatch's own trace cannot see.
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (lastCount.current === pending.length) return;
    lastCount.current = pending.length;
    console.info(
      `[ticket handoff] Schedule side sees ${pending.length} pending:`,
      pending.map((t) => `${t.ticket_id} (${t.tower_id})`),
    );
  }, [pending]);

  return pending;
}
