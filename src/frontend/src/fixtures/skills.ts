import type { ComponentType } from 'react';
import type { TicketStatus } from './tickets';
import { DescriptorIcon, AssigneeIcon, ValidationIcon } from '../components/shell/icons';

export type SkillId = 'issue_descriptor' | 'assignee_agent' | 'validation_assistant';

export interface Skill {
  id: SkillId;
  label: string;
  description: string;
  /** Real: deterministic client-side logic. Mocked: canned/illustrative text, no live model call. */
  mocked: boolean;
  /** Per-agent glyph so the board's assignment chips are distinguishable at a glance. */
  icon: ComponentType;
  /** Cool-family hue only — warm is reserved for tower severity, never agent chrome. */
  color: string;
}

// docs/Ticket_System_Handoff.md §5 — four fixed skills, no marketplace/custom
// creation (that footer is explicitly dropped, §6). Notifier isn't here: it's
// a global behavior on status transitions, not column-pinned.
export const SKILLS: Skill[] = [
  {
    id: 'issue_descriptor',
    label: 'Issue Descriptor',
    description: 'drafts fuller description',
    mocked: true,
    icon: DescriptorIcon,
    color: '#7c3aed',
  },
  {
    id: 'assignee_agent',
    label: 'Assignee Agent',
    description: 'suggests candidate crew',
    mocked: false,
    icon: AssigneeIcon,
    color: '#0284c7',
  },
  {
    id: 'validation_assistant',
    label: 'Validation Assistant',
    description: 'drafts closeout summary',
    mocked: true,
    icon: ValidationIcon,
    color: '#0891b2',
  },
];

export const DEFAULT_PINNED_SKILLS: Record<TicketStatus, SkillId | null> = {
  open: 'issue_descriptor',
  active: null,
  resolved: 'validation_assistant',
  closed: null,
};
