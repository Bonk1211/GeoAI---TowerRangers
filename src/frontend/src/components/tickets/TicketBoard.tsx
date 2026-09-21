import { TICKET_STATUSES, TICKET_STATUS_LABEL } from '../../fixtures/tickets';
import type { Ticket, TicketStatus } from '../../fixtures/tickets';
import type { SkillId } from '../../fixtures/skills';
import { TicketCard } from './TicketCard';
import { SkillPicker } from './SkillPicker';

interface TicketBoardProps {
  tickets: Ticket[];
  onSelect: (ticket: Ticket) => void;
  pinnedSkills: Record<TicketStatus, SkillId | null>;
  onPinSkill: (status: TicketStatus, skill: SkillId | null) => void;
}

export function TicketBoard({ tickets, onSelect, pinnedSkills, onPinSkill }: TicketBoardProps) {
  return (
    <div className="grid h-full grid-cols-4 gap-4 p-4">
      {TICKET_STATUSES.map((status) => {
        const columnTickets = tickets.filter((t) => t.status === status);
        return (
          <div
            key={status}
            className="flex min-h-0 flex-col rounded-xl bg-overlay/[0.02]"
          >
            <div className="flex items-center justify-between px-3.5 pt-4 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-fg/90">
                  {TICKET_STATUS_LABEL[status]}
                </span>
                <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-overlay/10 px-1 text-[11px] font-medium text-fg/70">
                  {columnTickets.length}
                </span>
              </div>
              <SkillPicker
                status={status}
                pinned={pinnedSkills[status]}
                onSelect={(skill) => onPinSkill(status, skill)}
              />
            </div>

            <div className="px-2.5 pb-2">
              <button
                type="button"
                className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-dim hover:bg-overlay/5 hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded bg-transparent text-lg font-light leading-none group-hover:bg-overlay/5">
                  +
                </span>
                Create
              </button>
            </div>

            <div className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-3">
              {columnTickets.length === 0 ? (
                <div className="mx-0.5 mt-2 rounded-lg border border-dashed border-overlay/15 bg-overlay/[0.015] p-6 text-center text-[12px] text-dim/60">
                  What needs to be done?
                </div>
              ) : (
                columnTickets.map((ticket) => (
                  <TicketCard key={ticket.ticket_id} ticket={ticket} onClick={() => onSelect(ticket)} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
