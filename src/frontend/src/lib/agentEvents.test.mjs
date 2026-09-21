import assert from 'node:assert/strict';
import test from 'node:test';

import { SseFrameBuffer, parseFrames } from './agentEvents.ts';

test('two complete frames in one chunk yield two events, in order', () => {
  const chunk =
    'event: text\ndata: {"text":"hello"}\n\n' +
    'event: constraint_echo\ndata: {"text":"noted"}\n\n';
  const { events, rest } = parseFrames(chunk);
  assert.deepEqual(events, [
    { event: 'text', data: { text: 'hello' } },
    { event: 'constraint_echo', data: { text: 'noted' } },
  ]);
  assert.equal(rest, '');
});

test('a frame split across chunk boundaries is buffered and yields one correct event', () => {
  const buf = new SseFrameBuffer();

  // Split in the middle of the JSON payload.
  const full = 'event: text\ndata: {"text":"hello world"}\n\n';
  const cut = 20;
  const part1 = full.slice(0, cut);
  const part2 = full.slice(cut);

  assert.deepEqual(buf.push(part1), []);
  assert.deepEqual(buf.push(part2), [{ event: 'text', data: { text: 'hello world' } }]);
});

test('a frame split between the event: line and the data: line is buffered correctly', () => {
  const buf = new SseFrameBuffer();
  const part1 = 'event: tool_call\n';
  const part2 = 'data: {"name":"optimize_schedule","input":{}}\n\n';

  assert.deepEqual(buf.push(part1), []);
  assert.deepEqual(buf.push(part2), [
    { event: 'tool_call', data: { name: 'optimize_schedule', input: {} } },
  ]);
});

test('a split mid-frame across three chunks still yields exactly one event once complete', () => {
  const buf = new SseFrameBuffer();
  const full = 'event: tool_result\ndata: {"name":"score_towers","output":{"n":3}}\n\n';
  const a = full.slice(0, 10);
  const b = full.slice(10, 40);
  const c = full.slice(40);

  assert.deepEqual(buf.push(a), []);
  assert.deepEqual(buf.push(b), []);
  assert.deepEqual(buf.push(c), [
    { event: 'tool_result', data: { name: 'score_towers', output: { n: 3 } } },
  ]);
});

test('a schedule event parses its payload as a ScheduleRun-shaped object', () => {
  const scheduleRun = {
    run_id: 'run-1',
    horizon: ['2026-08-17'],
    entries: [],
    reserve: [],
    unscheduled: [],
    unscheduled_detail: [],
    risk_weighted_wait: 0,
  };
  const chunk = `event: schedule\ndata: ${JSON.stringify(scheduleRun)}\n\n`;
  const { events } = parseFrames(chunk);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'schedule');
  assert.deepEqual(events[0].data, scheduleRun);
});

test('done yields { event: "done", data: {} } and is terminal', () => {
  const chunk = 'event: done\ndata: {}\n\n';
  const { events, rest } = parseFrames(chunk);
  assert.deepEqual(events, [{ event: 'done', data: {} }]);
  assert.equal(rest, '');
});

test('a partial trailing frame with no closing blank line yields nothing rather than throwing', () => {
  const chunk = 'event: text\ndata: {"text":"incomple';
  assert.doesNotThrow(() => parseFrames(chunk));
  const { events, rest } = parseFrames(chunk);
  assert.deepEqual(events, []);
  assert.equal(rest, chunk);
});

test('an unknown event name is skipped without throwing, leaving surrounding events intact', () => {
  const chunk =
    'event: text\ndata: {"text":"before"}\n\n' +
    'event: future_thing\ndata: {"whatever":1}\n\n' +
    'event: done\ndata: {}\n\n';
  assert.doesNotThrow(() => parseFrames(chunk));
  const { events } = parseFrames(chunk);
  assert.deepEqual(events, [
    { event: 'text', data: { text: 'before' } },
    { event: 'done', data: {} },
  ]);
});

test('malformed JSON in a data line is skipped without throwing', () => {
  const chunk = 'event: text\ndata: {not json}\n\nevent: done\ndata: {}\n\n';
  assert.doesNotThrow(() => parseFrames(chunk));
  const { events } = parseFrames(chunk);
  assert.deepEqual(events, [{ event: 'done', data: {} }]);
});
