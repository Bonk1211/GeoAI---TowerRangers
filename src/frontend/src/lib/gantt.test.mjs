import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAxis, buildLanes } from './gantt.ts';

const DAY = '2026-08-17';
const OTHER_DAY = '2026-08-10';

const CREW = {
  crew_id: 'SEL-C1', crew_type: 'civil', territory: 'Selangor', shift_hours: 8,
  depot: { lon: 101.588, lat: 3.045, name: 'Subang Jaya' },
  name: 'Subang Jaya Civil 1', max_travel_km: 40, members: [],
};

const CREW_2 = {
  crew_id: 'SEL-C2', crew_type: 'civil', territory: 'Selangor', shift_hours: 8,
  depot: { lon: 101.6, lat: 3.05, name: 'Petaling Jaya' },
  name: 'Petaling Jaya Civil 1', max_travel_km: 40, members: [],
};

test('a reserved crew-day yields a full-width reserve span and no bars', () => {
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW], [], axis, DAY, [
    { crew_id: 'SEL-C1', day: DAY, crew_type: 'civil' },
  ]);
  assert.equal(lanes[0].reserved, true);
  assert.equal(lanes[0].bars.length, 0);
  assert.ok(lanes[0].reserveSpan);
  assert.equal(Math.round(lanes[0].reserveSpan.widthPct), 100);
});

test('an unreserved lane has no reserve span', () => {
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW], [], axis, DAY, []);
  assert.equal(lanes[0].reserved, false);
  assert.equal(lanes[0].reserveSpan, null);
});

test('utilisation of a reserved lane is null, not zero', () => {
  // Zero would render a 0% meter as though the crew were idle by accident.
  // Reserved capacity is deliberately empty and must read differently.
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW], [], axis, DAY, [
    { crew_id: 'SEL-C1', day: DAY, crew_type: 'civil' },
  ]);
  assert.equal(lanes[0].utilisationPct, null);
});

test('reserve span always covers the full axis regardless of the axis bounds', () => {
  // buildLanes is called once per calendar day (the same convention `entries`
  // already follows — see GanttBoard's `dayEntries` filter). A ReserveSlot
  // marks the *whole day* free, not a sub-range of the intraday hour axis, so
  // the span is full-width whether the axis is the 09:00-17:00 fallback or an
  // axis stretched by real timed work on other crews that day (a
  // non-symmetric, non-fallback axis).
  const timedEntries = [
    {
      crew_id: 'SEL-C2',
      day: DAY,
      order: 1,
      tower_id: 'MY_1',
      work_order: { crew_type: 'civil', duration_hours: 2 },
      pinned: false,
      start_min: 6 * 60,
      end_min: 20 * 60,
      travel_min: 10,
    },
  ];
  const axis = buildAxis(timedEntries);
  assert.notEqual(axis.startMin, 9 * 60); // sanity: this is not the fallback axis
  const lanes = buildLanes([CREW], timedEntries, axis, DAY, [
    { crew_id: 'SEL-C1', day: DAY, crew_type: 'civil' },
  ]);
  assert.equal(lanes[0].reserved, true);
  assert.equal(lanes[0].reserveSpan.leftPct, 0);
  assert.equal(lanes[0].reserveSpan.widthPct, 100);
});

test('only the matching crew is marked reserved among several lanes', () => {
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW, CREW_2], [], axis, DAY, [
    { crew_id: 'SEL-C1', day: DAY, crew_type: 'civil' },
  ]);
  const byId = Object.fromEntries(lanes.map((l) => [l.crew.crew_id, l]));
  assert.equal(byId['SEL-C1'].reserved, true);
  assert.equal(byId['SEL-C2'].reserved, false);
  assert.equal(byId['SEL-C2'].reserveSpan, null);
});

test('a reserve slot for a different day does not reserve this lane (regression guard)', () => {
  // This is the exact bug fixed in this round: buildLanes now takes `day`
  // itself and filters on (crew_id, day) internally, rather than trusting an
  // unstated caller precondition that `reserve` was already filtered to the
  // day being rendered. A slot for SEL-C1 that exists on a DIFFERENT day must
  // not bleed into this day's lane, or a crew reserved anywhere in the
  // horizon would incorrectly paint as reserved on every day.
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW], [], axis, DAY, [
    { crew_id: 'SEL-C1', day: OTHER_DAY, crew_type: 'civil' },
  ]);
  assert.equal(lanes[0].reserved, false);
  assert.equal(lanes[0].reserveSpan, null);
});

test('the same reserve list yields different results depending on which day is being laid out', () => {
  // Direct demonstration of the (crew_id AND day) match: one reserve array,
  // reused across two calls that differ only in `day`, must reserve the lane
  // on exactly the day the slot names and nowhere else.
  const axis = buildAxis([]);
  const reserve = [{ crew_id: 'SEL-C1', day: DAY, crew_type: 'civil' }];

  const onDay = buildLanes([CREW], [], axis, DAY, reserve);
  assert.equal(onDay[0].reserved, true);

  const onOtherDay = buildLanes([CREW], [], axis, OTHER_DAY, reserve);
  assert.equal(onOtherDay[0].reserved, false);
  assert.equal(onOtherDay[0].reserveSpan, null);
});

test('a crew_id reserved on two distinct days still resolves each call to one full-width span, matched to its own day', () => {
  const axis = buildAxis([]);
  const reserve = [
    { crew_id: 'SEL-C1', day: OTHER_DAY, crew_type: 'civil' },
    { crew_id: 'SEL-C1', day: DAY, crew_type: 'civil' },
  ];
  const lanes = buildLanes([CREW], [], axis, DAY, reserve);
  assert.equal(lanes[0].reserved, true);
  assert.deepEqual(lanes[0].reserveSpan, { leftPct: 0, widthPct: 100 });
});

test('omitting reserve entirely (day still required) degrades to every lane unreserved', () => {
  // `day` is now a required parameter (Task 14 deleted the one legacy caller
  // that needed the old default), so this only exercises `reserve`'s default.
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW], [], axis, DAY);
  assert.equal(lanes[0].reserved, false);
  assert.equal(lanes[0].reserveSpan, null);
});
