import { useState, useRef, useEffect } from 'react';
import { placeName } from '../../fixtures/schedule';
import { CREWS } from '../../fixtures/crews';
import { bandColor, bandInk } from '../../lib/colors';
import { formatRelativeAge, initials } from '../../lib/format';
import type { Ticket } from '../../fixtures/tickets';
import { SparkleIcon } from '../shell/icons';
import { SKILLS } from '../../fixtures/skills';
import { useTicketStore } from '../../state/useTicketStore';
import { useWeights } from '../../state/useWeights';
import { useLiveTower } from '../../api/useLiveTowers';

interface TicketCardProps {
  ticket: Ticket;
  onClick: () => void;
}

export function TicketCard({ ticket, onClick }: TicketCardProps) {
  // Real live tower (not the frontend's static fixture) — a ticket can now
  // carry a real-dataset tower_id, which fixtures/towers.ts never contains.
  const weights = useWeights((s) => s.weights);
  const tower = useLiveTower(ticket.tower_id, weights);
  const band = tower ? bandColor(tower.decision) : 'var(--color-unscored)';
  const ink = tower ? bandInk(tower.decision) : 'var(--color-dim)';
  const crew = ticket.assignee_crew_id ? CREWS.find((c) => c.crew_id === ticket.assignee_crew_id) : undefined;

  const toggleAgentId = useTicketStore((s) => s.toggleAgentId);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const assignedAgentIds = ticket.agent_ids ?? [];
  const agentMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setAgentMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [agentMenuOpen]);

  const assignedSkills = assignedAgentIds
    .map((id) => SKILLS.find((s) => s.id === id))
    .filter((s): s is (typeof SKILLS)[number] => Boolean(s));

  return (
    <div className="relative" ref={agentMenuRef}>
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full cursor-pointer flex-col rounded-lg border border-overlay/5 bg-ink-900 p-3 text-left shadow-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <div className="flex w-full items-start justify-between">
          <div className="mb-2 w-full pr-2">
            <div className="line-clamp-2 text-[13.5px] font-medium leading-snug text-fg group-hover:text-accent transition-colors">
              {ticket.title}
            </div>
            <div className="mt-1 truncate text-[11.5px] text-dim">
              {tower ? placeName(tower.tower_id) : ticket.tower_id}
              <span className="mx-1 text-overlay/25">·</span>
              {ticket.tower_id}
            </div>
          </div>

          {/* Add Agent Button at top right */}
          <div
            onClick={(e) => {
              e.stopPropagation();
              setAgentMenuOpen((v) => !v);
            }}
            className={`mt-0 flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-dashed text-muted shadow-sm transition-all hover:scale-110 hover:border-accent hover:bg-accent/10 hover:text-accent ${agentMenuOpen ? 'border-accent bg-accent/10 text-accent' : 'border-overlay/40 bg-overlay/5'}`}
            title="Add Agent"
          >
            <div className="relative flex items-center justify-center [&>svg]:h-[14px] [&>svg]:w-[14px]">
              <SparkleIcon />
              <div className="absolute -right-1.5 -top-1 text-[13px] font-bold leading-none">+</div>
            </div>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          <span className="rounded bg-overlay/[0.04] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
            {ticket.issue_type}
          </span>
          {ticket.status === 'closed' ? (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
              style={{
                backgroundColor: ticket.resolution === 'confirmed' ? `color-mix(in srgb, ${ink} 10%, transparent)` : 'var(--color-ink-800)',
                color: ticket.resolution === 'confirmed' ? ink : 'var(--color-dim)',
              }}
            >
              {ticket.resolution === 'confirmed' ? 'Confirmed' : 'False Positive'}
            </span>
          ) : ticket.status === 'resolved' ? (
            <span className="rounded bg-overlay/5 px-1.5 py-0.5 text-[10px] font-semibold text-dim">
              Awaiting Review
            </span>
          ) : null}
        </div>

        <div className="mt-auto flex w-full items-center justify-between pt-1">
          <div className="flex items-center gap-2">
            {/* Priority/Severity indicator dot */}
            <div className="h-2 w-2 rounded-full shadow-sm" style={{ backgroundColor: band }} title="Severity level" />
            <span className="font-mono text-[11.5px] font-semibold text-muted transition-colors">
              {ticket.ticket_id}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="shrink-0 tnum text-[10.5px] text-dim mr-0.5">{formatRelativeAge(ticket.created_at)}</span>

            {/* Assigned Agent Icons (Bottom Right) — one chip per agent, stacked with overlap */}
            {assignedSkills.length > 0 && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setAgentMenuOpen((v) => !v);
                }}
                className="flex cursor-pointer items-center"
              >
                {assignedSkills.map((skill, i) => (
                  <span
                    key={skill.id}
                    className={`relative flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full shadow-sm ring-1 ring-white/80 transition-transform hover:z-10 hover:scale-110 ${agentMenuOpen ? 'ring-accent ring-2' : ''} ${i > 0 ? '-ml-2.5' : ''}`}
                    style={{ backgroundColor: skill.color }}
                    title={`Assigned Agent: ${skill.label}`}
                  >
                    <div className="flex items-center justify-center text-white [&>svg]:h-[15px] [&>svg]:w-[15px]">
                      <skill.icon />
                    </div>
                  </span>
                ))}
              </div>
            )}

            {crew ? (
              <span
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10.5px] font-bold text-accent ring-1 ring-white/50"
                title={crew.name}
              >
                {initials(crew.name)}
              </span>
            ) : (
              <span
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-dashed border-overlay/30 bg-ink-950 text-overlay/30"
                title="Unassigned"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Agent Selection Dropdown */}
      {agentMenuOpen && (
        <div
          role="menu"
          className="glass-raised absolute right-0 top-12 z-30 mt-1 w-56 overflow-hidden rounded-lg p-1 animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="eyebrow px-2 py-1.5 opacity-80">Agents (select any)</div>
          {SKILLS.map((skill) => {
            const isAssigned = assignedAgentIds.includes(skill.id);
            return (
              <button
                key={skill.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={isAssigned}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleAgentId(ticket.ticket_id, skill.id);
                }}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-150 ${isAssigned ? 'bg-accent/12 text-accent font-medium' : 'text-fg hover:bg-overlay/[0.06]'
                  }`}
              >
                <span style={{ color: skill.color }}><skill.icon /></span>
                <span className="min-w-0 flex-1">
                  <span className="block">{skill.label}</span>
                  <span className="block text-[10px] text-dim">{skill.description}</span>
                </span>
                {isAssigned && <span className="font-bold opacity-80" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
