import type { ScheduleRun } from '../api/types';

/**
 * Wire vocabulary for `POST /agent/chat`, an SSE stream. Both the real-Claude
 * tool-calling path and the deterministic no-API-key fallback in
 * `agent/runner.py` emit exactly this vocabulary — the frontend never needs
 * to know which one is active.
 */
export type AgentEvent =
  | { event: 'text'; data: { text: string } }
  | { event: 'tool_call'; data: { name: string; input: unknown } }
  | { event: 'tool_result'; data: { name: string; output: unknown } }
  | { event: 'constraint_echo'; data: { text: string } }
  | { event: 'schedule'; data: ScheduleRun }
  | { event: 'done'; data: Record<string, never> };

const KNOWN_EVENTS = new Set<AgentEvent['event']>([
  'text',
  'tool_call',
  'tool_result',
  'constraint_echo',
  'schedule',
  'done',
]);

/**
 * Parse one already-complete SSE frame (no trailing `\n\n`) of the shape
 * `event: <name>\ndata: <json>`. Returns null for anything that isn't a
 * recognised, well-formed frame — unknown event names, malformed JSON, or a
 * missing `data:` line are all skipped rather than thrown, since a future
 * backend vocabulary addition must not take down the whole stream.
 */
function parseFrame(frame: string): AgentEvent | null {
  const lines = frame.split('\n');
  const eventLine = lines.find((l) => l.startsWith('event:'));
  const dataLine = lines.find((l) => l.startsWith('data:'));
  if (!eventLine || !dataLine) return null;

  const name = eventLine.slice('event:'.length).trim();
  if (!KNOWN_EVENTS.has(name as AgentEvent['event'])) return null;

  const rawData = dataLine.slice('data:'.length).trim();
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    return null;
  }

  // The union's `data` shape is trusted to match `name` per the backend
  // contract; there is no runtime schema validation beyond "valid JSON".
  return { event: name, data } as AgentEvent;
}

/**
 * Pure frame splitter: given a buffer that may contain zero or more complete
 * `\n\n`-terminated frames plus a trailing partial frame, returns the parsed
 * events (in order) and whatever remains unconsumed. The remainder is always
 * explicit so chunk-boundary handling — including a split mid-JSON or between
 * the `event:` and `data:` lines — is testable without any network.
 */
export function parseFrames(buffer: string): { events: AgentEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  // The final element is either '' (buffer ended exactly on a frame boundary)
  // or a partial trailing frame; either way it is not yet complete and must
  // be held back for the next chunk.
  const rest = parts.length > 0 ? (parts[parts.length - 1] ?? '') : '';
  const complete = parts.slice(0, -1);

  const events: AgentEvent[] = [];
  for (const frame of complete) {
    if (frame.trim() === '') continue;
    const parsed = parseFrame(frame);
    if (parsed) events.push(parsed);
  }
  return { events, rest };
}

/**
 * Stateful accumulator wrapping `parseFrames` for streaming consumers: feed
 * it each decoded chunk via `push`, get back any events that became complete.
 */
export class SseFrameBuffer {
  private buffer = '';

  push(chunk: string): AgentEvent[] {
    this.buffer += chunk;
    const { events, rest } = parseFrames(this.buffer);
    this.buffer = rest;
    return events;
  }
}
