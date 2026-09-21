import { useEffect, useRef, useState } from 'react';
import { SKILLS, type SkillId } from '../../fixtures/skills';
import { SparkleIcon, ChevronDownIcon } from '../shell/icons';
import { TICKET_STATUS_LABEL, type TicketStatus } from '../../fixtures/tickets';

interface SkillPickerProps {
  status: TicketStatus;
  pinned: SkillId | null;
  onSelect: (skill: SkillId | null) => void;
}

/**
 * Adapted from the Jira/Rovo board-agent picker (docs/Ticket_System_Handoff.md
 * §5): a small icon in each column header opens a "Select a skill" list.
 * Same mechanic, four fixed skills (three here + None) instead of a
 * third-party tool marketplace — no "Browse agents" / "Create agent" footer,
 * that's explicitly dropped in §6.
 */
export function SkillPicker({ status, pinned, onSelect }: SkillPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const pinnedSkill = SKILLS.find((s) => s.id === pinned);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Skill for ${TICKET_STATUS_LABEL[status]} column${pinnedSkill ? `, currently ${pinnedSkill.label}` : ', currently none'}`}
        title={pinnedSkill ? pinnedSkill.label : 'No skill pinned'}
        className="flex items-center gap-0.5 rounded-md p-1.5 text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <SparkleIcon />
        <ChevronDownIcon />
      </button>

      {open && (
        <div
          role="menu"
          className="glass-raised absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg p-1"
        >
          <div className="eyebrow px-2 py-1.5">Select a skill</div>
          {SKILLS.map((skill) => {
            const isPinned = skill.id === pinned;
            return (
              <button
                key={skill.id}
                type="button"
                role="menuitemradio"
                aria-checked={isPinned}
                onClick={() => {
                  onSelect(skill.id);
                  setOpen(false);
                }}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-150 ${
                  isPinned ? 'bg-accent/12 text-accent' : 'text-fg hover:bg-overlay/[0.06]'
                }`}
              >
                <span style={{ color: skill.color }}><skill.icon /></span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{skill.label}</span>
                  <span className="block text-[10px] text-dim">{skill.description}</span>
                </span>
                {isPinned && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={pinned === null}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-150 ${
              pinned === null ? 'bg-accent/12 text-accent' : 'text-fg hover:bg-overlay/[0.06]'
            }`}
          >
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-current" aria-hidden="true" />
            None
            {pinned === null && <span className="ml-auto" aria-hidden="true">✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}
