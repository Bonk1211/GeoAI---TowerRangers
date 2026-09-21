# Ticket → Schedule Approval Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Schedule-side approval surface so a ticket marked `schedule_pending` gets a crew suggestion, shows what that dispatch costs already-scheduled work, and on approval commits a real pin and flips the ticket to Active.

**Architecture:** Two pure `lib/` modules (crew position from solver output, position-ranked crew suggestion) feed two React surfaces — a pinned strip inside the Ranger dock that announces pending tickets, and a `DetailPanel` variant that previews the compensation and commits. The commit reuses the existing `/schedule/preview` → `/schedule/pin` path unchanged; the ticket store's existing `markScheduled`/`markScheduleFailed` actions are called for the first time. No backend change.

**Tech Stack:** React 19 + TypeScript, Zustand, TanStack Query, Tailwind v4, Vite. Tests via `node:test` with `--experimental-strip-types`.

**Spec:** `docs/superpowers/specs/2026-09-03-ticket-approval-flow-design.md`

## Global Constraints

- **No backend files change.** `cd src/backend && pytest -q -p no:cacheprovider` must stay at its current pass count; a change there is a regression signal.
- **Never call `setStatus`/`assignCrew` for this flow** — only `markScheduled(ticket_id, crew_id)` and `markScheduleFailed(ticket_id)`. Those carry the "came from Schedule" semantics the ticket drawer's status strip reads.
- **Resolve towers with `useLiveTower(tower_id, weights)`**, never `fixtures/towers.ts`. Ticket tower ids are from the live population and do not exist in the offline fixture id space.
- **Crew eligibility comes from `rankCandidateCrews(ticket, limit)`** (`lib/ticketSkills.ts`), never from `crewTypeForFactor(tower.dominant_factor)`. The two vocabularies do not match 1:1.
- **`pin_reason: 'emergency'`** for every commit in this flow.
- **Type scale only** — `eyebrow` / `text-micro` / `text-ui` / `text-lead`. No `text-[13px]`-style arbitrary sizes.
- **Colour rules:** `--color-alert` for the emergency (data/severity); violet accent for controls only. Band colours only via `lib/colors.ts`. Warm hue on a control is a bug.
- **No new `backdrop-filter` surface.** The blur budget is 8 and the dock already spends one.
- Verify with `npm run build` and `npm run lint` from `src/frontend`. A passing build does not verify visual or interaction work — a browser pass is mandatory.

---

### Task 1: Crew position from solver output

**Files:**
- Create: `src/frontend/src/lib/crewPosition.ts`
- Test: `src/frontend/src/lib/crewPosition.test.mjs`

**Interfaces:**
- Consumes: `ScheduleEntry` from `../api/types` (`{ crew_id, day, order, tower_id, work_order, pinned, pin_reason?, travel_min?, start_min?, end_min? }`), `Crew` from `../api/types` (`{ crew_id, name, crew_type, depot: {lon,lat,name}, territory, max_travel_km, shift_hours, members }`).
- Produces: `export interface CrewPosition { lon: number; lat: number; label: string; state: 'on_site' | 'idle' | 'depot' }` and `export function crewPositionNow(crew: Crew, entriesToday: ScheduleEntry[], nowMin: number, towerCoords: Map<string, {lon: number; lat: number}>, placeNameOf: (tower_id: string) => string): CrewPosition`.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/lib/crewPosition.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

import { crewPositionNow } from './crewPosition.ts';

const CREW = {
  crew_id: 'SEL-C1',
  name: 'Subang Jaya Civil 1',
  crew_type: 'civil',
  depot: { lon: 101.58, lat: 3.05, name: 'Subang Jaya' },
  territory: 'Selangor',
  max_travel_km: 40,
  shift_hours: 8,
  members: ['Ahmad'],
};

const COORDS = new Map([
  ['T_A', { lon: 101.6, lat: 3.07 }],
  ['T_B', { lon: 101.7, lat: 3.12 }],
]);

const placeNameOf = (id) => (id === 'T_A' ? 'Site A' : 'Site B');

function entry(tower_id, start_min, end_min) {
  return {
    crew_id: 'SEL-C1',
    day: '2026-09-03',
    order: 1,
    tower_id,
    work_order: { tower_id, action: 'x', crew_type: 'civil', parts: [], urgency_days: 7, why: '' },
    pinned: false,
    travel_min: 10,
    start_min,
    end_min,
  };
}

test('a crew mid-job is on site at that tower', () => {
  const pos = crewPositionNow(CREW, [entry('T_A', 540, 780)], 600, COORDS, placeNameOf);
  assert.equal(pos.state, 'on_site');
  assert.deepEqual([pos.lon, pos.lat], [101.6, 3.07]);
  assert.match(pos.label, /Site A/);
});

test('after the last job the crew is idle at that tower, not back at depot', () => {
  const pos = crewPositionNow(CREW, [entry('T_A', 540, 660), entry('T_B', 700, 800)], 900, COORDS, placeNameOf);
  assert.equal(pos.state, 'idle');
  assert.deepEqual([pos.lon, pos.lat], [101.7, 3.12]);
  assert.match(pos.label, /Site B/);
});

test('before the first job the crew is at its depot', () => {
  const pos = crewPositionNow(CREW, [entry('T_A', 540, 780)], 480, COORDS, placeNameOf);
  assert.equal(pos.state, 'depot');
  assert.deepEqual([pos.lon, pos.lat], [101.58, 3.05]);
  assert.match(pos.label, /Subang Jaya/);
});

test('no jobs today means depot', () => {
  const pos = crewPositionNow(CREW, [], 600, COORDS, placeNameOf);
  assert.equal(pos.state, 'depot');
});

test('an untimed entry is ignored rather than treated as midnight', () => {
  const untimed = { ...entry('T_A', 540, 780), start_min: undefined, end_min: undefined };
  const pos = crewPositionNow(CREW, [untimed], 600, COORDS, placeNameOf);
  assert.equal(pos.state, 'depot');
});

test('a tower missing from the coordinate map falls back to depot', () => {
  const pos = crewPositionNow(CREW, [entry('T_MISSING', 540, 780)], 600, COORDS, placeNameOf);
  assert.equal(pos.state, 'depot');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/crewPosition.test.mjs`
Expected: FAIL — cannot find module `./crewPosition.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/frontend/src/lib/crewPosition.ts`:

```typescript
import type { Crew, ScheduleEntry } from '../api/types';

export interface CrewPosition {
  lon: number;
  lat: number;
  label: string;
  /** on_site: mid-job now. idle: finished, still at the last tower. depot: not out yet. */
  state: 'on_site' | 'idle' | 'depot';
}

/**
 * Where a crew actually is right now, derived from the schedule the solver
 * committed plus the wall clock — never from GPS, because there is no
 * telemetry in this system and simulated pings would be fabricated data
 * presented as live tracking.
 *
 * An entry with no clock fields is skipped rather than read as midnight:
 * lib/gantt.ts already reports such a lane as `untimed` instead of inventing
 * geometry for it, and inventing a position here would be the same bug.
 */
export function crewPositionNow(
  crew: Crew,
  entriesToday: ScheduleEntry[],
  nowMin: number,
  towerCoords: Map<string, { lon: number; lat: number }>,
  placeNameOf: (tower_id: string) => string,
): CrewPosition {
  const atDepot = (): CrewPosition => ({
    lon: crew.depot.lon,
    lat: crew.depot.lat,
    label: `at ${crew.depot.name} depot`,
    state: 'depot',
  });

  const timed = entriesToday
    .filter((e) => e.crew_id === crew.crew_id)
    .filter((e) => typeof e.start_min === 'number' && typeof e.end_min === 'number')
    .sort((a, b) => (a.start_min as number) - (b.start_min as number));

  const onSite = timed.find(
    (e) => (e.start_min as number) <= nowMin && nowMin <= (e.end_min as number),
  );
  if (onSite) {
    const at = towerCoords.get(onSite.tower_id);
    if (!at) return atDepot();
    return { ...at, label: `on site at ${placeNameOf(onSite.tower_id)}`, state: 'on_site' };
  }

  const finished = [...timed].reverse().find((e) => (e.end_min as number) <= nowMin);
  if (finished) {
    const at = towerCoords.get(finished.tower_id);
    if (!at) return atDepot();
    return { ...at, label: `finished at ${placeNameOf(finished.tower_id)}`, state: 'idle' };
  }

  return atDepot();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/crewPosition.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/lib/crewPosition.ts src/frontend/src/lib/crewPosition.test.mjs
git commit -m "feat(schedule): derive live crew position from solver output

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Position-ranked crew suggestion

**Files:**
- Create: `src/frontend/src/lib/ticketSuggestion.ts`
- Test: `src/frontend/src/lib/ticketSuggestion.test.mjs`

**Interfaces:**
- Consumes: `crewPositionNow` / `CrewPosition` from Task 1; `CrewCandidate` (`{ crew: Crew; distance_km: number }`) from `./ticketSkills`; `haversineKm(a, b)` from `./geo` taking `{lon, lat}` objects.
- Produces: `export interface Suggestion { crew: Crew; from: CrewPosition; distance_km: number; eta_min: number }` and `export function rankSuggestions(candidates: CrewCandidate[], entriesToday: ScheduleEntry[], tower: {lon:number;lat:number}, nowMin: number, towerCoords: Map<string,{lon:number;lat:number}>, placeNameOf: (id:string)=>string): Suggestion[]`, plus `export const ROAD_FACTOR = 1.35` and `export const AVG_SPEED_KMH = 45`.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/lib/ticketSuggestion.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

import { rankSuggestions, ROAD_FACTOR, AVG_SPEED_KMH } from './ticketSuggestion.ts';

function crew(crew_id, depotLon) {
  return {
    crew_id,
    name: crew_id,
    crew_type: 'civil',
    depot: { lon: depotLon, lat: 3.0, name: `${crew_id} depot` },
    territory: 'Selangor',
    max_travel_km: 60,
    shift_hours: 8,
    members: [],
  };
}

function entry(crew_id, tower_id, start_min, end_min) {
  return {
    crew_id,
    day: '2026-09-03',
    order: 1,
    tower_id,
    work_order: { tower_id, action: 'x', crew_type: 'civil', parts: [], urgency_days: 7, why: '' },
    pinned: false,
    travel_min: 10,
    start_min,
    end_min,
  };
}

const TOWER = { lon: 101.0, lat: 3.0 };
const COORDS = new Map([['T_NEAR', { lon: 101.01, lat: 3.0 }]]);
const placeNameOf = () => 'Near Site';

test('ranks by where the crew is NOW, not by depot distance', () => {
  // FAR's depot is far, but it is standing at T_NEAR right now; NEAR is at its depot.
  const candidates = [
    { crew: crew('NEAR', 100.9), distance_km: 11 },
    { crew: crew('FAR', 102.5), distance_km: 167 },
  ];
  const entries = [entry('FAR', 'T_NEAR', 540, 780)];
  const ranked = rankSuggestions(candidates, entries, TOWER, 600, COORDS, placeNameOf);
  assert.equal(ranked[0].crew.crew_id, 'FAR');
  assert.equal(ranked[0].from.state, 'on_site');
  assert.ok(ranked[0].distance_km < ranked[1].distance_km);
});

test('distance carries the road factor and eta follows the speed assumption', () => {
  const candidates = [{ crew: crew('A', 101.0), distance_km: 0 }];
  const ranked = rankSuggestions(candidates, [], TOWER, 600, COORDS, placeNameOf);
  // Depot is exactly the tower's coordinates, so straight-line distance is 0.
  assert.equal(ranked[0].distance_km, 0);
  assert.equal(ranked[0].eta_min, 0);
  assert.equal(ROAD_FACTOR, 1.35);
  assert.equal(AVG_SPEED_KMH, 45);
});

test('eta is whole minutes, rounded, never fractional', () => {
  const candidates = [{ crew: crew('A', 100.5), distance_km: 55 }];
  const ranked = rankSuggestions(candidates, [], TOWER, 600, COORDS, placeNameOf);
  assert.equal(Number.isInteger(ranked[0].eta_min), true);
  assert.ok(ranked[0].eta_min > 0);
});

test('an empty candidate list yields no suggestions rather than throwing', () => {
  assert.deepEqual(rankSuggestions([], [], TOWER, 600, COORDS, placeNameOf), []);
});

test('every candidate survives ranking — eligibility is decided upstream', () => {
  const candidates = [
    { crew: crew('A', 100.5), distance_km: 55 },
    { crew: crew('B', 101.4), distance_km: 44 },
    { crew: crew('C', 101.1), distance_km: 11 },
  ];
  const ranked = rankSuggestions(candidates, [], TOWER, 600, COORDS, placeNameOf);
  assert.equal(ranked.length, 3);
  assert.deepEqual(
    ranked.map((s) => s.crew.crew_id),
    ['C', 'B', 'A'],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/ticketSuggestion.test.mjs`
Expected: FAIL — cannot find module `./ticketSuggestion.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/frontend/src/lib/ticketSuggestion.ts`:

```typescript
import type { Crew, ScheduleEntry } from '../api/types';
import type { CrewCandidate } from './ticketSkills';
import { crewPositionNow, type CrewPosition } from './crewPosition';
import { haversineKm } from './geo';

/**
 * Mirrors config/policy.yaml's travel block. Duplicated here rather than
 * fetched because the panel needs a figure before the solver has run, and the
 * solver is the only thing that can produce the real one. Both are DECLARED
 * ASSUMPTIONS in policy.yaml, not measurements — which is why the UI labels
 * anything derived from them as an estimate, and prints the solver's own
 * travel_min once the pin has committed. Sub-project 1a (OSRM road matrix)
 * replaces both ends of this.
 */
export const ROAD_FACTOR = 1.35;
export const AVG_SPEED_KMH = 45;

export interface Suggestion {
  crew: Crew;
  from: CrewPosition;
  /** Road-adjusted km from where the crew is now to the tower. */
  distance_km: number;
  /** Estimated whole minutes at the policy speed assumption. */
  eta_min: number;
}

/**
 * Orders already-eligible crews by how far each is from the tower RIGHT NOW.
 *
 * Eligibility (issue_type -> crew_type, max_travel_km) is decided upstream by
 * rankCandidateCrews(), which can only measure from the depot. This re-ranks
 * that set against live position, so a crew finishing a job next door outranks
 * one idling at a nearer depot.
 */
export function rankSuggestions(
  candidates: CrewCandidate[],
  entriesToday: ScheduleEntry[],
  tower: { lon: number; lat: number },
  nowMin: number,
  towerCoords: Map<string, { lon: number; lat: number }>,
  placeNameOf: (tower_id: string) => string,
): Suggestion[] {
  return candidates
    .map(({ crew }) => {
      const from = crewPositionNow(crew, entriesToday, nowMin, towerCoords, placeNameOf);
      const distance_km = haversineKm(from, tower) * ROAD_FACTOR;
      return {
        crew,
        from,
        distance_km,
        eta_min: Math.round((distance_km / AVG_SPEED_KMH) * 60),
      };
    })
    .sort((a, b) => a.distance_km - b.distance_km);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/ticketSuggestion.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/lib/ticketSuggestion.ts src/frontend/src/lib/ticketSuggestion.test.mjs
git commit -m "feat(schedule): rank ticket dispatch candidates by live crew position

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Selection kind + panel routing

**Files:**
- Modify: `src/frontend/src/state/useScheduleStore.ts` (the `Selection` union)
- Modify: `src/frontend/src/components/schedule/WhySlotPanel.tsx`
- Modify: `src/frontend/src/components/schedule/DetailPanel.tsx`
- Create: `src/frontend/src/components/schedule/TicketApprovalPanel.tsx` (stub in this task, filled in Task 4)

**Interfaces:**
- Produces: selection variant `{ kind: 'ticket_approval'; ticket_id: string; day: string }`, and `export function TicketApprovalPanel({ ticket_id, day, onDone }: { ticket_id: string; day: string; onDone: () => void })`.

- [ ] **Step 1: Add the selection variant**

In `src/frontend/src/state/useScheduleStore.ts`, extend the `Selection` union:

```typescript
export type Selection =
  | { kind: 'job'; crew_id: string; day: string; tower_id: string }
  | { kind: 'free'; crew_id: string; day: string }
  | { kind: 'reserve'; crew_id: string; day: string }
  | { kind: 'emergency'; tower_id: string; day: string }
  // Raised from the Ranger dock's pending-ticket strip. Carries day like every
  // other variant so select() keeps the board on the day being decided.
  | { kind: 'ticket_approval'; ticket_id: string; day: string };
```

- [ ] **Step 2: Create the stub panel**

Create `src/frontend/src/components/schedule/TicketApprovalPanel.tsx`:

```tsx
interface TicketApprovalPanelProps {
  ticket_id: string;
  day: string;
  onDone: () => void;
}

export function TicketApprovalPanel({ ticket_id }: TicketApprovalPanelProps) {
  return (
    <div className="p-5">
      <h3 className="eyebrow mb-2">Emergency — awaiting approval</h3>
      <p className="text-ui text-dim">{ticket_id}</p>
    </div>
  );
}
```

- [ ] **Step 3: Route the new kind**

In `src/frontend/src/components/schedule/WhySlotPanel.tsx`, add an import and a branch alongside the existing `selection.kind === 'emergency'` branch:

```tsx
import { TicketApprovalPanel } from './TicketApprovalPanel';
```

```tsx
  if (selection.kind === 'ticket_approval') {
    return (
      <TicketApprovalPanel
        ticket_id={selection.ticket_id}
        day={selection.day}
        onDone={() => select(null)}
      />
    );
  }
```

In `src/frontend/src/components/schedule/DetailPanel.tsx`, add the header label beside the existing ones:

```tsx
          {selection.kind === 'ticket_approval' && 'Emergency ticket'}
```

- [ ] **Step 4: Verify it compiles and lints**

Run: `cd src/frontend && npx tsc -b --noEmit && npm run lint`
Expected: no errors from these files. (`useLiveTowers.ts` has two pre-existing `react-hooks/exhaustive-deps` warnings — those are expected and unrelated.)

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/state/useScheduleStore.ts src/frontend/src/components/schedule/WhySlotPanel.tsx src/frontend/src/components/schedule/DetailPanel.tsx src/frontend/src/components/schedule/TicketApprovalPanel.tsx
git commit -m "feat(schedule): route a ticket_approval selection to its own panel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Approval panel — identity, suggestion, compensation, commit

**Files:**
- Modify: `src/frontend/src/components/schedule/TicketApprovalPanel.tsx` (replace the Task 3 stub)

**Interfaces:**
- Consumes: `rankSuggestions` / `Suggestion` (Task 2); `rankCandidateCrews` from `../../lib/ticketSkills`; `useTicketStore` (`tickets`, `markScheduled`, `markScheduleFailed`); `usePreviewOverride()` (`mutate({ run_id, tower_id, target_crew_id, target_day })` → `OverridePreview`); `usePinOverride(runId)` (`mutate({ tower_id, target_crew_id, target_day, pin_reason })` → `ScheduleRun`); `useLiveTower(tower_id, weights)`; `useCrewsQuery()`; `placeName` / `hasPlaceName` from `../../fixtures/schedule`; `dayLabel` from `../../lib/scheduleDays`; `roleTeam` from `../../lib/roleTeams`; `Button` from `../ui/Panel`.

- [ ] **Step 1: Replace the stub with the full panel**

Replace the entire contents of `src/frontend/src/components/schedule/TicketApprovalPanel.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { CREWS } from '../../fixtures/crews';
import { placeName, hasPlaceName } from '../../fixtures/schedule';
import { dayLabel } from '../../lib/scheduleDays';
import { rankCandidateCrews } from '../../lib/ticketSkills';
import { rankSuggestions } from '../../lib/ticketSuggestion';
import { roleTeam } from '../../lib/roleTeams';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useTicketStore } from '../../state/useTicketStore';
import { useWeights } from '../../state/useWeights';
import { useLiveTower, useLiveTowers } from '../../api/useLiveTowers';
import { useCrewsQuery, usePinOverride, usePreviewOverride } from '../../api/queries';
import { Button } from '../ui/Panel';
import type { OverridePreview, ScheduleRun } from '../../api/types';

interface TicketApprovalPanelProps {
  ticket_id: string;
  day: string;
  onDone: () => void;
}

/**
 * The approval half of docs/Ticket_To_Schedule_Handoff.md §1.
 *
 * A ticket reaches here already flagged schedule_pending by useAutoDispatch;
 * nothing has been booked. This panel proposes a crew, shows what committing
 * it costs the work already on the board, and only then commits — the pin is
 * what unlocks the ticket's Active state, via markScheduled(). Rejecting calls
 * markScheduleFailed(), which leaves the ticket Open with the drawer's retry
 * hint. Those two actions are the ONLY ways this flow may move a ticket;
 * setStatus/assignCrew carry manual-path semantics the drawer reads
 * differently.
 */
export function TicketApprovalPanel({ ticket_id, day, onDone }: TicketApprovalPanelProps) {
  const ticket = useTicketStore((s) => s.tickets.find((t) => t.ticket_id === ticket_id));
  const markScheduled = useTicketStore((s) => s.markScheduled);
  const markScheduleFailed = useTicketStore((s) => s.markScheduleFailed);

  const run = useScheduleStore((s) => s.run);
  const runId = useScheduleStore((s) => s.runId);
  const setRun = useScheduleStore((s) => s.setRun);

  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const tower = useLiveTower(ticket?.tower_id ?? null, weights);
  const crewsQuery = useCrewsQuery();

  const previewMutation = usePreviewOverride();
  const pinMutation = usePinOverride(runId);

  const [suggestIndex, setSuggestIndex] = useState(0);
  const [preview, setPreview] = useState<OverridePreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [committed, setCommitted] = useState<{ crew_id: string; dropped: string[] } | null>(null);
  const [commitFailed, setCommitFailed] = useState(false);

  // Same clock basis crewPositionNow expects: minutes from local midnight.
  const nowMin = useMemo(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }, []);

  const towerCoords = useMemo(
    () => new Map(towers.map((t) => [t.tower_id, { lon: t.lon, lat: t.lat }])),
    [towers],
  );

  const entriesToday = useMemo(
    () => run.entries.filter((e) => e.day === day),
    [run.entries, day],
  );

  const suggestions = useMemo(() => {
    if (!ticket || !tower) return [];
    // limit = CREWS.length, not the default 3: this returns the eligible POOL,
    // which rankSuggestions then re-orders by live position. Leaving the
    // default would silently truncate to the three nearest DEPOTS first.
    const eligible = rankCandidateCrews(ticket, (crewsQuery.data ?? CREWS).length);
    return rankSuggestions(eligible, entriesToday, tower, nowMin, towerCoords, placeName);
  }, [ticket, tower, crewsQuery.data, entriesToday, nowMin, towerCoords]);

  const suggestion = suggestions[suggestIndex];

  // Preview whenever the proposed crew changes, so the compensation on screen
  // always describes the crew named above it.
  useEffect(() => {
    if (!ticket || !suggestion || !runId || committed) return;
    setPreview(null);
    setPreviewFailed(false);
    previewMutation.mutate(
      {
        run_id: runId,
        tower_id: ticket.tower_id,
        target_crew_id: suggestion.crew.crew_id,
        target_day: day,
      },
      { onSuccess: setPreview, onError: () => setPreviewFailed(true) },
    );
    // previewMutation is recreated per render by TanStack Query; including it
    // would re-fire this effect forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.tower_id, suggestion?.crew.crew_id, runId, day, committed]);

  if (!ticket) {
    return (
      <div className="p-5">
        <h3 className="eyebrow mb-2">Ticket unavailable</h3>
        <p className="text-ui leading-relaxed text-dim">
          This ticket is no longer pending — it may have been resolved elsewhere.
        </p>
        <div className="mt-4">
          <Button onClick={onDone}>Close</Button>
        </div>
      </div>
    );
  }

  const site = hasPlaceName(ticket.tower_id) ? placeName(ticket.tower_id) : (tower?.territory ?? ticket.tower_id);

  if (committed) {
    const entry = run.entries.find((e) => e.tower_id === ticket.tower_id);
    return (
      <div className="p-5">
        <h3 className="eyebrow mb-2">Crew dispatched</h3>
        <p className="text-ui leading-relaxed text-ok-ink">
          {committed.crew_id} is booked for {site} on {dayLabel(day)}.
        </p>
        {/* Solver truth, not the pre-approval estimate. */}
        {entry && typeof entry.start_min === 'number' && typeof entry.end_min === 'number' && (
          <p className="tnum mt-1.5 text-micro text-muted">
            On site {clock(entry.start_min)}–{clock(entry.end_min)}
            {entry.travel_min ? ` after a ${entry.travel_min} min drive` : ''}
          </p>
        )}
        {committed.dropped.length > 0 ? (
          <div className="mt-3 rounded-lg border border-watch/30 bg-watch/[0.08] p-3">
            <p className="text-micro font-medium text-watch-ink">
              {committed.dropped.length === 1 ? 'One booked job' : `${committed.dropped.length} booked jobs`} dropped to
              unscheduled:
            </p>
            <ul className="mt-1.5 space-y-1 text-ui text-muted">
              {committed.dropped.map((id) => (
                <li key={id} className="text-fg">{placeName(id)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-1.5 text-micro leading-relaxed text-muted">
            Nothing already booked was dropped.
          </p>
        )}
        <div className="mt-4">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  const approve = () => {
    if (!suggestion || !runId) return;
    setCommitFailed(false);
    const before = new Set(run.unscheduled);
    pinMutation.mutate(
      {
        tower_id: ticket.tower_id,
        target_crew_id: suggestion.crew.crew_id,
        target_day: day,
        pin_reason: 'emergency',
      },
      {
        onSuccess: (result) => {
          const next = result as ScheduleRun;
          const dropped = next.unscheduled.filter((id) => !before.has(id) && id !== ticket.tower_id);
          setRun(next);
          markScheduled(ticket.ticket_id, suggestion.crew.crew_id);
          setCommitted({ crew_id: suggestion.crew.crew_id, dropped });
        },
        onError: () => {
          // Doc §3: markScheduleFailed covers a rejected suggestion OR a failed
          // commit. The ticket returns to Open so the agent can be reassigned.
          markScheduleFailed(ticket.ticket_id);
          setCommitFailed(true);
        },
      },
    );
  };

  const reject = () => {
    markScheduleFailed(ticket.ticket_id);
    onDone();
  };

  const team = suggestion ? roleTeam(suggestion.crew.crew_type) : undefined;
  const deltaPct =
    preview && preview.risk_weighted_wait_before > 0
      ? Math.round(
          ((preview.risk_weighted_wait_after - preview.risk_weighted_wait_before) /
            preview.risk_weighted_wait_before) *
            100,
        )
      : null;

  return (
    <div className="spine p-5" style={{ '--spine': 'var(--color-alert)' } as React.CSSProperties}>
      <h3 className="eyebrow mb-2 text-alert-ink">Emergency — awaiting approval</h3>
      <p className="text-lead text-fg">{ticket.title}</p>
      <p className="font-mono text-micro text-dim">
        {ticket.ticket_id} · {ticket.tower_id}
      </p>

      <dl className="mt-3 space-y-2 rounded-lg border border-overlay/10 bg-overlay/[0.03] p-3 text-ui">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Site</dt>
          <dd className="text-right text-fg">{site}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Issue type</dt>
          <dd className="text-fg">{ticket.issue_type}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Day</dt>
          <dd className="text-fg">{dayLabel(day)}</dd>
        </div>
      </dl>

      <h4 className="eyebrow mt-5 mb-2">Suggested crew</h4>
      {!tower ? (
        // Distinguished from "no crew in range" on purpose: an unknown tower
        // and an unreachable one are different problems, and reporting the
        // wrong one sends the planner hunting for crews that were never the
        // issue.
        <p className="text-ui leading-relaxed text-dim">
          Tower {ticket.tower_id} is not in the population the scheduler is serving, so no crew can be
          proposed for it. Reject to send this back to the ticket.
        </p>
      ) : !suggestion ? (
        <p className="text-ui leading-relaxed text-dim">
          No {ticket.issue_type.toLowerCase()} crew is within range of this tower, so there is nothing to
          approve. Reject to send it back, or assign a crew manually from the ticket.
        </p>
      ) : (
        <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02] p-3">
          <div className="text-ui font-medium text-fg">{suggestion.crew.name}</div>
          <div className="text-micro text-muted">
            {team?.label ?? suggestion.crew.crew_type} · {suggestion.crew.crew_id}
          </div>
          <div className="mt-1.5 text-micro text-dim">
            {suggestion.from.label} · <span className="tnum">{suggestion.distance_km.toFixed(0)} km</span>
          </div>
          {/* Labelled estimate, never a bare figure: the solver has not run
              yet, and its own travel_min is shown after approval instead. */}
          <div className="tnum mt-0.5 text-micro text-dim">~{suggestion.eta_min} min drive (estimate)</div>
          {suggestions.length > 1 && (
            <button
              type="button"
              onClick={() => setSuggestIndex((i) => (i + 1) % suggestions.length)}
              className="mt-2 text-micro font-medium text-muted hover:text-accent"
            >
              Suggest another ({suggestIndex + 1} of {suggestions.length})
            </button>
          )}
        </div>
      )}

      <h4 className="eyebrow mt-5 mb-2">What this costs the plan</h4>
      {!runId ? (
        // Offline (the store's fixture-backed run) has no run_id to preview or
        // pin against. EmergencyPanel carries a local-mutation branch for this;
        // this flow deliberately does not, because approving here also flips a
        // ticket to Active via markScheduled(), and a ticket recorded as
        // dispatched against a schedule the backend never saw is a worse
        // failure than a disabled button. Say so instead.
        <p className="text-ui leading-relaxed text-dim">
          The schedule is running offline, so there is no live plan to book against. Approval needs the
          scheduler; reject to send this back to the ticket.
        </p>
      ) : previewFailed ? (
        <p className="rounded-lg border border-alert/35 bg-alert/[0.09] p-3 text-micro leading-relaxed text-alert-ink">
          The impact could not be computed, so this cannot be approved yet. Nothing has changed. Try again,
          or reject to send it back to the ticket.
        </p>
      ) : !preview ? (
        <p className="text-ui text-dim">Working out what would move…</p>
      ) : preview.moved.length === 0 && preview.dropped.length === 0 ? (
        <p className="text-ui leading-relaxed text-ok-ink">
          Nothing already booked would move.
        </p>
      ) : (
        <ul className="space-y-1.5 text-ui">
          {preview.moved.map((m) => (
            <li key={m.tower_id} className="text-muted">
              <span className="text-fg">{placeName(m.tower_id)}</span> moves {dayLabel(m.from)} →{' '}
              {dayLabel(m.to)}{' '}
              <span className="tnum text-dim">
                ({m.delta_days > 0 ? '+' : ''}
                {m.delta_days}d)
              </span>
            </li>
          ))}
          {preview.dropped.map((id) => (
            <li key={id} className="text-watch-ink">
              <span className="text-fg">{placeName(id)}</span> falls to unscheduled
            </li>
          ))}
        </ul>
      )}

      {preview && deltaPct !== null && (
        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-overlay/10 pt-3 text-ui">
          <span className="text-muted">Risk-weighted wait</span>
          <span className={`tnum ${deltaPct > 0 ? 'text-watch-ink' : 'text-ok-ink'}`}>
            {deltaPct > 0 ? '+' : ''}
            {deltaPct}%
          </span>
        </div>
      )}

      {commitFailed && (
        <p className="mt-3 rounded-lg border border-alert/35 bg-alert/[0.09] p-3 text-micro leading-relaxed text-alert-ink">
          The dispatch failed and nothing was booked. The ticket has been sent back — reassign its agent to
          try again.
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          tone="primary"
          disabled={!suggestion || !preview || pinMutation.isPending}
          onClick={approve}
        >
          {pinMutation.isPending ? 'Dispatching…' : 'Approve'}
        </Button>
        <Button onClick={reject}>Reject</Button>
      </div>
    </div>
  );
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `cd src/frontend && npx tsc -b --noEmit && npm run lint`
Expected: no new errors or warnings from this file.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/schedule/TicketApprovalPanel.tsx
git commit -m "feat(schedule): approval panel with compensation preview and pin commit

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Pending strip in the Ranger dock

**Files:**
- Create: `src/frontend/src/components/schedule/TicketApprovalStrip.tsx`
- Modify: `src/frontend/src/components/schedule/AgentChat.tsx`
- Modify: `src/frontend/src/components/schedule/AgentDock.tsx`

**Interfaces:**
- Produces: `export function TicketApprovalStrip()` (no props — reads both stores itself) and `export function usePendingTickets(): Ticket[]` exported from the same file for `AgentDock`'s badge.

- [ ] **Step 1: Create the strip**

Create `src/frontend/src/components/schedule/TicketApprovalStrip.tsx`:

```tsx
import { useMemo } from 'react';
import { placeName, hasPlaceName } from '../../fixtures/schedule';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useTicketStore } from '../../state/useTicketStore';
import { AlertIcon } from '../shell/icons';
import type { Ticket } from '../../fixtures/tickets';

/**
 * Tickets handed to Schedule by useAutoDispatch and not yet resolved here.
 * Exported so AgentDock's collapsed pill can badge the same count without
 * duplicating the filter.
 */
export function usePendingTickets(): Ticket[] {
  // Select the stable `tickets` reference and filter in useMemo — NOT
  // `useTicketStore((s) => s.tickets.filter(...))`. A selector that builds a
  // new array on every call returns a fresh snapshot each time React asks for
  // one, which under useSyncExternalStore is the "getSnapshot should be
  // cached" infinite-render fault.
  const tickets = useTicketStore((s) => s.tickets);
  return useMemo(
    () => tickets.filter((t) => t.schedule_pending && t.status === 'open'),
    [tickets],
  );
}

/**
 * The announce half of the ticket hand-off: a pinned index of tickets waiting
 * on a decision, sitting above Ranger's transcript.
 *
 * Deliberately NOT a Block in AgentChat's transcript (docs/ spec §2.2):
 * transcript blocks are local streaming state, they scroll away, and they can
 * be lost when the planner sends a message. This region touches the SSE path
 * not at all. It is also not a glass surface — the dock already spends one of
 * the eight blur budget slots and nesting another buys nothing.
 */
export function TicketApprovalStrip() {
  const pending = usePendingTickets();
  const select = useScheduleStore((s) => s.select);
  const run = useScheduleStore((s) => s.run);

  if (pending.length === 0) return null;

  const day = run.horizon[0];

  return (
    <div className="shrink-0 border-b border-overlay/10 px-3 py-2.5">
      <div className="eyebrow mb-1.5 flex items-center gap-1.5 text-alert-ink">
        <span className="[&>svg]:h-3 [&>svg]:w-3">
          <AlertIcon />
        </span>
        Awaiting approval ({pending.length})
      </div>
      <ul className="space-y-1.5">
        {pending.map((t) => (
          <li
            key={t.ticket_id}
            className="spine glass-field flex items-center justify-between gap-2 rounded-lg py-1.5 pl-2.5 pr-1.5"
            style={{ '--spine': 'var(--color-alert)' } as React.CSSProperties}
          >
            <span className="min-w-0">
              <span className="block truncate text-ui font-medium text-fg">
                {hasPlaceName(t.tower_id) ? placeName(t.tower_id) : t.tower_id}
              </span>
              <span className="block truncate font-mono text-eyebrow text-dim">{t.ticket_id}</span>
            </span>
            {/* No day yet means the schedule has not loaded; approving into a
                day outside the horizon is what EmergencyPanel's own
                dayIsPlannable guard exists to prevent. */}
            {day ? (
              <button
                type="button"
                onClick={() => select({ kind: 'ticket_approval', ticket_id: t.ticket_id, day })}
                className="shrink-0 rounded-lg border border-accent/40 bg-accent/10 px-2 py-1 text-micro font-semibold text-accent transition-colors duration-150 hover:bg-accent hover:text-white"
              >
                Review
              </button>
            ) : (
              <span className="shrink-0 text-micro text-dim">waiting for schedule</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Mount it above the transcript**

In `src/frontend/src/components/schedule/AgentChat.tsx`, add the import:

```tsx
import { TicketApprovalStrip } from './TicketApprovalStrip';
```

Then render it immediately after the header bar's closing `</div>` and before the transcript's scroll container (`<div ref={scrollRef} ...>`):

```tsx
      <TicketApprovalStrip />
```

- [ ] **Step 3: Badge the collapsed pill**

In `src/frontend/src/components/schedule/AgentDock.tsx`, add the import:

```tsx
import { usePendingTickets } from './TicketApprovalStrip';
```

Inside the component, above the `return`:

```tsx
  // A pending approval must be visible without opening the dock — the dock is
  // collapsed by default, and an approval nobody can see is an approval that
  // never happens.
  const pendingCount = usePendingTickets().length;
```

Then, inside the collapsed-pill `<button>`, immediately after the `<span className="text-eyebrow text-muted pl-1 font-medium">Ask to optimize…</span>` element, add:

```tsx
          {pendingCount > 0 && (
            <span className="flex items-center gap-1 rounded-full border border-alert/40 bg-alert/10 px-2 py-0.5 text-eyebrow font-semibold text-alert-ink">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-alert" />
              {pendingCount} awaiting approval
            </span>
          )}
```

- [ ] **Step 4: Verify it compiles and lints**

Run: `cd src/frontend && npx tsc -b --noEmit && npm run lint`
Expected: no new errors or warnings.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/schedule/TicketApprovalStrip.tsx src/frontend/src/components/schedule/AgentChat.tsx src/frontend/src/components/schedule/AgentDock.tsx
git commit -m "feat(schedule): announce pending ticket approvals in the Ranger dock

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Full-stack verification

**Files:** none modified — this task is verification only.

- [ ] **Step 1: Run every automated check**

```bash
cd src/frontend && node --experimental-strip-types --test src/lib/crewPosition.test.mjs
cd src/frontend && node --experimental-strip-types --test src/lib/ticketSuggestion.test.mjs
cd src/frontend && node --experimental-strip-types --test src/lib/inundation.test.mjs
cd src/frontend && npm run build
cd src/frontend && npm run lint
cd src/backend && py -m pytest -q -p no:cacheprovider
```

Expected: all frontend tests pass; build succeeds; lint shows only the two pre-existing `useLiveTowers.ts` warnings; backend suite passes at its current count (this plan changes no backend file, so any backend failure is a regression signal).

- [ ] **Step 2: Start both ends**

```bash
cd src/backend && USE_FIXTURE=1 uvicorn api.main:app --port 8001
cd src/frontend && npm run dev
```

`VITE_API_BASE` must point at `http://127.0.0.1:8001` (see `.env.example`). `USE_FIXTURE=1` is optional here — the demo ticket button draws from whatever `/towers` serves, so both populations work.

- [ ] **Step 3: Walk the approve path in a browser**

1. Tickets tab → **+ Demo Emergency Ticket** → modal appears → **Review Ticket**.
2. In the drawer or on the card, pick **Assignee Agent** from the sparkle picker.
3. Drawer strip reads "Sent to Schedule — awaiting approval there."
4. Navigate to Schedule. The collapsed Ranger pill shows "1 awaiting approval" with a red dot.
5. Open the dock → the strip lists the ticket → **Review**.
6. Panel shows: ticket identity, suggested crew with where it is now and distance, an estimate-labelled ETA, and the compensation list (or "nothing already booked would move").
7. **Approve** → confirmation shows the committed crew, the solver's on-site window and drive time, and what actually dropped.
8. Return to Tickets → the ticket is now in **Active** with that crew assigned.

- [ ] **Step 4: Walk the reject path**

1. Generate another demo emergency, assign the agent, go to Schedule, Review.
2. **Reject** → panel closes, strip empties.
3. Tickets tab → ticket is still **Open**, drawer reads "Rejected on Schedule. Reassign the agent to send it again."
4. Re-pick the Assignee Agent → the ticket reappears in the Schedule strip (this proves `setAgentId` clearing `schedule_failed` re-arms `useAutoDispatch`).

- [ ] **Step 5: Check the two failure branches**

1. With the backend stopped, open a pending ticket's panel — the compensation section must read "The impact could not be computed…" and **Approve must be disabled**. Never approve blind.
2. Restart the backend and confirm the panel recovers on the next Review.

- [ ] **Step 6: Commit any fixes found**

```bash
git add -A
git commit -m "fix(schedule): address issues found in ticket approval browser pass

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan

- **Sub-project 1a — OSRM road matrix.** Replaces `ROAD_FACTOR`/`AVG_SPEED_KMH` in `lib/ticketSuggestion.ts` and the solver's haversine with real road distance. Its own spec and plan.
- **Sub-project 2 — the reschedule animation.** Sits on top of Task 4's confirmation state. Its own spec and plan.
- Fixing `agent/tools.py`'s `to_pins()` emergency-dispatch stub — a separate, known gap.
