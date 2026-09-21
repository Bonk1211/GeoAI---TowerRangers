import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { streamAgentChat } from '../../api/client';
import { parseConstraint } from '../../lib/agentParser';
import { useScheduleStore } from '../../state/useScheduleStore';
import { siteLabel } from '../../fixtures/schedule';
import { TicketApprovalStrip } from './TicketApprovalStrip';
import type { ScheduleRun } from '../../api/types';

/**
 * One rendered thing in the transcript. Every variant records where its text
 * came from, because the whole point of this component is that the user can
 * tell server content from anything the browser worked out for itself.
 */
type Block =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'local-echo'; text: string }
  | { id: number; kind: 'text'; text: string }
  | { id: number; kind: 'constraint'; text: string }
  | { id: number; kind: 'tool'; name: string; settled: boolean }
  | { id: number; kind: 'changes'; lines: string[] }
  | { id: number; kind: 'error'; text: string };

let nextId = 1;

/**
 * Suggestion glyphs are drawn, not typed. These were emoji (bolt, siren,
 * shield, stopwatch), which render as a different picture on every platform,
 * cannot be given the stroke weight the rest of the icon set uses, and cannot
 * be recoloured with the chip they sit in. Paths are 16x16 to match
 * shell/icons.tsx.
 */
const GLYPHS = {
  bolt: 'M9 2 4 9h3l-1 5 5-7H8l1-5Z',
  alert: 'M8 2 14.5 13.5h-13Z M8 6.5v3 M8 11.2v.05',
  shield: 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4Z',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M8 4.8V8l2.2 1.4',
} as const;

const SUGGESTED_PROMPTS: { glyph: string; label: string; prompt: string }[] = [
  { glyph: GLYPHS.bolt, label: 'Crew SEL-C1 unavailable Thursday', prompt: 'crew SEL-C1 unavailable Thursday' },
  { glyph: GLYPHS.alert, label: 'Emergency dispatch to MY_1042', prompt: 'emergency dispatch to MY_1042' },
  { glyph: GLYPHS.shield, label: 'Reserve SEL-C2 for flood', prompt: 'crew SEL-C2 unavailable Friday' },
  { glyph: GLYPHS.clock, label: 'Crew SEL-P1 off Monday', prompt: 'crew SEL-P1 unavailable Monday' },
];

function deriveBoardChanges(before: ScheduleRun, after: ScheduleRun): string[] {
  if (!before.run_id || before.entries.length === 0) return [];

  const beforeBy = new Map(before.entries.map((e) => [e.tower_id, e]));
  const afterBy = new Map(after.entries.map((e) => [e.tower_id, e]));
  const lines: string[] = [];

  for (const [towerId, a] of afterBy) {
    const b = beforeBy.get(towerId);
    if (!b) {
      lines.push(`${siteLabel(towerId)}: now booked — ${a.crew_id}, ${a.day}`);
    } else if (b.crew_id !== a.crew_id || b.day !== a.day) {
      lines.push(`${siteLabel(towerId)}: ${b.crew_id} ${b.day} → ${a.crew_id} ${a.day}`);
    }
  }
  for (const towerId of beforeBy.keys()) {
    if (!afterBy.has(towerId)) lines.push(`${siteLabel(towerId)}: no longer booked`);
  }
  return lines;
}

interface AgentChatProps {
  onClose?: () => void;
}

export function AgentChat({ onClose }: AgentChatProps) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const setRun = useScheduleStore((s) => s.setRun);
  const agentSeed = useScheduleStore((s) => s.agentSeed);
  const clearAgentSeed = useScheduleStore((s) => s.clearAgentSeed);
  const setRunId = useScheduleStore((s) => s.setRunId);
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [blocks]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  /**
   * Take a constraint drafted elsewhere (the detail panel's "Ask Ranger about
   * this visit") into the composer.
   *
   * Filled, never sent. Ranger re-solves the entire board, so a one-click path
   * from selecting a job to a new run would let a planner replace the schedule
   * without having read the sentence that did it. The seed is cleared as soon
   * as it lands so a later selection change cannot silently overwrite
   * something the planner has since typed.
   */
  useEffect(() => {
    if (agentSeed === null) return;
    setInput(agentSeed);
    clearAgentSeed();
    inputRef.current?.focus();
  }, [agentSeed, clearAgentSeed]);

  const sendText = async (textToSend: string) => {
    const text = textToSend.trim();
    if (!text || streaming) return;
    setInput('');

    const parsed = parseConstraint(text);
    const localEchoId = nextId++;
    const opening: Block[] = [{ id: nextId++, kind: 'user', text }];
    if (parsed.kind !== 'unknown') {
      opening.push({ id: localEchoId, kind: 'local-echo', text: parsed.summary });
    }
    setBlocks((prev) => [...prev, ...opening]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let sawServerEvent = false;
    let appliedRunId: string | null = null;
    let textBlockId: number | null = null;

    try {
      for await (const ev of streamAgentChat(text, controller.signal)) {
        if (!sawServerEvent) {
          sawServerEvent = true;
          setBlocks((prev) => prev.filter((b) => b.id !== localEchoId));
        }

        switch (ev.event) {
          case 'text': {
            const chunk = ev.data.text;
            if (textBlockId === null) {
              const id = nextId++;
              textBlockId = id;
              setBlocks((prev) => [...prev, { id, kind: 'text', text: chunk }]);
            } else {
              const id = textBlockId;
              setBlocks((prev) =>
                prev.map((b) => (b.id === id && b.kind === 'text' ? { ...b, text: b.text + chunk } : b)),
              );
            }
            break;
          }
          case 'constraint_echo': {
            textBlockId = null;
            const id = nextId++;
            setBlocks((prev) => [...prev, { id, kind: 'constraint', text: ev.data.text }]);
            break;
          }
          case 'tool_call': {
            textBlockId = null;
            const id = nextId++;
            setBlocks((prev) => [...prev, { id, kind: 'tool', name: ev.data.name, settled: false }]);
            break;
          }
          case 'tool_result': {
            textBlockId = null;
            const name = ev.data.name;
            setBlocks((prev) => {
              const idx = prev.findLastIndex((b) => b.kind === 'tool' && b.name === name && !b.settled);
              if (idx === -1) return prev;
              return prev.map((b, i) => (i === idx && b.kind === 'tool' ? { ...b, settled: true } : b));
            });
            break;
          }
          case 'schedule': {
            textBlockId = null;
            const payload = ev.data;
            if (!Array.isArray(payload.horizon) || payload.horizon.length === 0) {
              const id = nextId++;
              setBlocks((prev) => [
                ...prev,
                {
                  id,
                  kind: 'error',
                  text: `The agent returned schedule ${payload.run_id} with no planning horizon, so the board cannot lay it out and has been left as it was.`,
                },
              ]);
              break;
            }
            const before = useScheduleStore.getState().run;

            queryClient.setQueryData(['scheduleRun', payload.run_id], payload);
            setRunId(payload.run_id);
            setRun(payload);
            appliedRunId = payload.run_id;

            const lines = deriveBoardChanges(before, payload);
            const id = nextId++;
            setBlocks((prev) => [
              ...prev,
              { id, kind: 'changes', lines: lines.length > 0 ? lines : ['No booked work moved.'] },
            ]);
            break;
          }
          case 'done':
            textBlockId = null;
            break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const detail = err instanceof Error ? err.message : String(err);
        const id = nextId++;
        const headline =
          appliedRunId === null
            ? 'The stream to Ranger failed, so nothing was re-planned and the board is unchanged.'
            : `The stream to Ranger failed after schedule ${appliedRunId} was applied.`;
        setBlocks((prev) => [...prev, { id, kind: 'error', text: `${headline}\n${detail}` }]);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  const lastBlock = blocks.at(-1);

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-white/50 bg-white/25 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-tr from-violet-600 via-indigo-600 to-purple-500 text-white shadow-md shadow-violet-500/25">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            <span className="absolute -bottom-0.5 -right-0.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 ring-1 ring-white"></span>
            </span>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-ui font-bold text-fg tracking-tight">Ranger</span>
              <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.2 text-[9px] font-medium text-emerald-600">Active</span>
            </div>
            <span className="text-[10px] text-muted leading-tight">Autonomous Dispatch Optimizer</span>
          </div>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Ranger"
            className="glass-field flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:text-fg"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Pending ticket approvals, pinned above the transcript rather than
          posted into it — see TicketApprovalStrip's own note. */}
      <TicketApprovalStrip />

      {/* Transcript / Scroll Body */}
      <div ref={scrollRef} className="scroll-thin flex-1 space-y-3.5 overflow-y-auto px-4 py-3">
        {blocks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-4 text-center">
            {/* Center Mascot Badge (matching reference) */}
            <div className="relative mb-3 flex h-16 w-16 items-center justify-center rounded-3xl border border-violet-500/30 text-accent shadow-lg shadow-violet-500/15 bg-[radial-gradient(circle_at_30%_25%,rgba(139,92,246,0.35),transparent_60%),radial-gradient(circle_at_75%_80%,rgba(99,102,241,0.28),transparent_62%)]">
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <div className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-gradient-to-tr from-violet-600 to-indigo-500 border-2 border-white"></div>
            </div>

            <h3 className="text-lead font-semibold text-fg tracking-tight">How can I help you today?</h3>
            <p className="mt-1 text-ui text-muted max-w-[280px] leading-snug">
              Describe constraints or emergency dispatches. I'll execute the solver and report the impact.
            </p>

            {/* Quick action suggestion chips */}
            <div className="mt-4 flex w-full flex-col gap-1.5">
              <div className="text-left text-eyebrow font-medium text-dim px-1">Suggested Constraints</div>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_PROMPTS.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => void sendText(item.prompt)}
                    className="glass-field flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-micro font-medium text-fg transition-colors duration-150 hover:border-accent/50 hover:text-accent"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d={item.glyph} />
                    </svg>
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {blocks.map((b) => {
          if (b.kind === 'user') {
            return (
              <div key={b.id} className="flex flex-col items-end">
                <span className="eyebrow mb-1 text-[9px] text-muted">You</span>
                <div className="max-w-[88%] whitespace-pre-line rounded-2xl rounded-tr-xs bg-gradient-to-r from-violet-600 via-indigo-600 to-purple-600 px-3.5 py-2 text-ui leading-relaxed text-white shadow-md shadow-violet-500/20">
                  {b.text}
                </div>
              </div>
            );
          }

          if (b.kind === 'tool') {
            return (
              <div key={b.id} className="flex items-center gap-1.5 py-0.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/20 bg-violet-500/10 px-2.5 py-0.5 text-micro font-medium text-violet-700 dark:text-violet-300">
                  <span className={`h-1.5 w-1.5 rounded-full ${b.settled ? 'bg-emerald-500' : 'bg-violet-500 animate-pulse'}`} />
                  {b.settled ? 'Completed' : 'Running'} {b.name}
                </span>
              </div>
            );
          }

          if (b.kind === 'local-echo') {
            return (
              <div key={b.id} className="flex flex-col items-start">
                <span className="eyebrow mb-1 text-[9px] text-dim">Parsed in browser</span>
                <div className="max-w-[90%] whitespace-pre-line rounded-2xl border border-dashed border-accent/30 bg-accent/[0.04] px-3.5 py-2 text-ui text-dim">
                  {b.text}
                </div>
              </div>
            );
          }

          if (b.kind === 'changes') {
            return (
              <div key={b.id} className="flex flex-col items-start w-full">
                <span className="eyebrow mb-1 text-[9px] text-dim">Board Diff · Optimizer Solution</span>
                <div className="w-full rounded-2xl border border-white/60 bg-white/55 p-3 text-ui text-muted backdrop-blur-sm">
                  <div className="space-y-1">
                    {b.lines.map((line, lIdx) => (
                      <div key={lIdx} className="flex items-start gap-1.5 text-ui text-fg">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        <span className="leading-snug">{line}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          }

          if (b.kind === 'error') {
            return (
              <div key={b.id} className="flex flex-col items-start">
                <span className="eyebrow mb-1 text-[9px] text-alert-ink">Failure</span>
                <div role="alert" className="max-w-[90%] whitespace-pre-line rounded-2xl border border-alert/40 bg-alert/10 px-3.5 py-2 text-ui leading-relaxed text-alert-ink">
                  {b.text}
                </div>
              </div>
            );
          }

          const isConstraint = b.kind === 'constraint';
          return (
            <div key={b.id} className="flex flex-col items-start">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                <span className="eyebrow text-[9px] text-fg font-semibold">
                  {isConstraint ? 'Constraint Verified' : 'Ranger'}
                </span>
              </div>
              <div className={`max-w-[90%] whitespace-pre-line rounded-2xl rounded-tl-xs px-3.5 py-2.5 text-ui leading-relaxed shadow-sm ${
                isConstraint
                  ? 'border border-accent/30 bg-accent/[0.08] text-fg font-medium'
                  : 'border border-white/60 bg-white/55 text-fg backdrop-blur-sm'
              }`}>
                {b.text}
                {streaming && b.kind === 'text' && lastBlock?.id === b.id && (
                  <span aria-hidden="true" className="ml-1 inline-block h-3.5 w-1 animate-pulse bg-accent align-middle" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pill-shaped Input Bar (matching reference design) */}
      <div className="p-3 pt-2 bg-gradient-to-t from-white/45 to-transparent">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendText(input);
          }}
          className="glass-field flex items-center gap-2 rounded-full p-1.5 pl-3.5 shadow-[0_4px_20px_rgba(15,23,42,0.08)] backdrop-blur-md focus-within:shadow-[0_4px_25px_rgba(124,58,237,0.15)]"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Ask Ranger to optimize schedule"
            placeholder="Ask Ranger to add a constraint..."
            className="min-w-0 flex-1 bg-transparent text-ui text-fg placeholder:text-muted/70 focus:outline-none"
          />

          {streaming ? (
            <button
              type="button"
              onClick={stop}
              className="flex h-8 px-3 items-center justify-center rounded-full bg-alert text-white text-micro font-medium shadow-md transition-all hover:bg-alert/90 hover:scale-105 active:scale-95"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send to Ranger"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-violet-600 via-indigo-600 to-purple-600 text-white shadow-md shadow-violet-500/25 transition-all hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 disabled:shadow-none"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 translate-x-px" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
