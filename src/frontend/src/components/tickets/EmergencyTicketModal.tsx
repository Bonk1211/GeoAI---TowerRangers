import { useEffect } from 'react';
import { placeName, hasPlaceName } from '../../fixtures/schedule';
import { Button } from '../ui/Panel';
import { AlertIcon } from '../shell/icons';
import type { Ticket } from '../../fixtures/tickets';

interface EmergencyTicketModalProps {
  ticket: Ticket;
  onDismiss: () => void;
}

/**
 * Alert popup for a freshly-generated demo emergency ticket (Tickets page
 * "+ Demo Emergency Ticket" button). Centered rather than the usual
 * right-side drawer because this is meant to read as an interrupt — an
 * urgent case the admin has to notice, not a card they clicked into.
 * Dismissing opens the normal ticket detail drawer via onDismiss, where the
 * real Assign Crew / Assign Agent controls already live (TicketCard's agent
 * picker, TicketDrawer's crew select) — this modal only announces the case.
 */
export function EmergencyTicketModal({ ticket, onDismiss }: EmergencyTicketModalProps) {
  // placeName() only resolves the small offline-fixture tower set; a
  // real-dataset tower_id falls back to itself here, which the "Tower" row
  // already shows next to it — no live-tower lookup needed just for this.
  const site = hasPlaceName(ticket.tower_id) ? placeName(ticket.tower_id) : ticket.tower_id;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-labelledby="emergency-ticket-title"
        className="glass-raised spine w-[440px] max-w-[calc(100vw-2rem)] rounded-xl p-5 rise"
        style={{ '--spine': 'var(--color-alert)' } as React.CSSProperties}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-alert-ink [&>svg]:h-5 [&>svg]:w-5">
            <AlertIcon />
          </span>
          <div className="min-w-0 flex-1">
            <div className="eyebrow mb-1 text-alert-ink">Urgent — new field report</div>
            <h2 id="emergency-ticket-title" className="font-display text-base font-semibold leading-snug text-fg">
              {ticket.title}
            </h2>
          </div>
        </div>

        <dl className="mt-4 space-y-2 rounded-lg border border-overlay/10 bg-overlay/[0.03] p-3 text-ui">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Ticket</dt>
            <dd className="font-mono text-fg">{ticket.ticket_id}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Tower</dt>
            <dd className="text-fg">{site} · {ticket.tower_id}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Issue Type</dt>
            <dd className="text-fg">{ticket.issue_type}</dd>
          </div>
        </dl>

        <p className="mt-3 text-ui leading-relaxed text-fg/85">{ticket.description}</p>

        <p className="mt-4 text-micro leading-relaxed text-dim">
          Assign a crew directly, or route to the Assignee Agent to send this to Schedule for review — the
          crew and day still need approval there before anything is booked.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="primary" onClick={onDismiss}>
            Review Ticket
          </Button>
        </div>
      </div>
    </div>
  );
}
