import { useMemo, useState } from 'react';
import { PageHeader, Button } from '../components/ui/Panel';
import { TicketBoard } from '../components/tickets/TicketBoard';
import { TicketDrawer } from '../components/tickets/TicketDrawer';
import { NotificationToasts } from '../components/tickets/NotificationToasts';
import { EmergencyTicketModal } from '../components/tickets/EmergencyTicketModal';
import { useTicketStore } from '../state/useTicketStore';
import { useAutoDispatch } from '../state/useAutoDispatch';
import { useWeights } from '../state/useWeights';
import { useLiveTowers } from '../api/useLiveTowers';
import { placeName } from '../fixtures/schedule';
import type { Ticket } from '../fixtures/tickets';

export function Tickets() {
  // Fires the dispatch the moment a ticket's agent_id becomes
  // 'assignee_agent' — see useAutoDispatch's own doc comment. Mounted here
  // (not in TicketDrawer) so it fires from TicketCard's agent picker too,
  // and survives the drawer being closed.
  useAutoDispatch();
  const tickets = useTicketStore((s) => s.tickets);
  const pinnedSkills = useTicketStore((s) => s.pinnedSkills);
  const setPinnedSkill = useTicketStore((s) => s.setPinnedSkill);
  const createEmergencyTicket = useTicketStore((s) => s.createEmergencyTicket);
  // Real live towers (not the frontend's static fixture) so a generated
  // ticket's tower_id always exists in whatever population the backend is
  // actually serving — see createEmergencyTicket's own doc comment.
  const weights = useWeights((s) => s.weights);
  const { towers: liveTowers } = useLiveTowers(weights);
  const [search, setSearch] = useState('');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [emergencyTicket, setEmergencyTicket] = useState<Ticket | null>(null);

  const filteredTickets = useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) return tickets;
    return tickets.filter(
      (t) =>
        t.ticket_id.toLowerCase().includes(query) ||
        t.tower_id.toLowerCase().includes(query) ||
        t.title.toLowerCase().includes(query) ||
        placeName(t.tower_id).toLowerCase().includes(query),
    );
  }, [tickets, search]);

  const selectedTicket = selectedTicketId ? tickets.find((t) => t.ticket_id === selectedTicketId) : undefined;
  const drawerOpen = creating || Boolean(selectedTicket);

  const openTicket = (ticket: Ticket) => {
    setCreating(false);
    setSelectedTicketId(ticket.ticket_id);
  };

  const closeDrawer = () => {
    setCreating(false);
    setSelectedTicketId(null);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="Tickets" subtitle="Field-reported issues logged against towers">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search..."
            aria-label="Search tickets by ID, tower, or title"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-48 h-[34px] rounded-lg border border-overlay/10 bg-overlay/[0.04] px-3 text-xs text-fg placeholder:text-dim focus:border-accent/45 focus:outline-none focus:ring-1 focus:ring-accent/45"
          />
          <Button
            tone="danger"
            disabled={liveTowers.length === 0}
            title={liveTowers.length === 0 ? 'Towers are still loading' : undefined}
            onClick={() => {
              const ticket = createEmergencyTicket(liveTowers);
              if (!ticket) return;
              setSelectedTicketId(null);
              setCreating(false);
              setEmergencyTicket(ticket);
            }}
          >
            + Demo Emergency Ticket
          </Button>
        </div>
      </PageHeader>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="scroll-thin h-full overflow-y-auto">
          <TicketBoard
            tickets={filteredTickets}
            onSelect={openTicket}
            pinnedSkills={pinnedSkills}
            onPinSkill={setPinnedSkill}
          />
        </div>

        <NotificationToasts />

        {emergencyTicket && (
          <EmergencyTicketModal
            ticket={emergencyTicket}
            onDismiss={() => {
              const t = emergencyTicket;
              setEmergencyTicket(null);
              openTicket(t);
            }}
          />
        )}

        {drawerOpen && (
          <>
            {/* Backdrop dims the board without blocking the header's own controls. */}
            <div
              className="absolute inset-0 bg-ink-950/40 backdrop-blur-[1px]"
              onClick={closeDrawer}
              aria-hidden="true"
            />
            <div className="absolute inset-y-0 right-0">
              {creating ? (
                <TicketDrawer mode="create" onClose={closeDrawer} onCreated={(t) => openTicket(t)} />
              ) : selectedTicket ? (
                <TicketDrawer mode="view" ticket={selectedTicket} onClose={closeDrawer} />
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
