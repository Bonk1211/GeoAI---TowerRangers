# Dispatch Rearrange Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an emergency dispatch is approved, the by-site board visibly rearranges — displaced jobs slide to their new day columns, then the emergency lands in the freed slot — and keeps a badge saying where each moved job came from.

**Architecture:** The approval panel already diffs the pre-pin run against the returned run. It writes that diff into the schedule store as a display-only descriptor and switches the board to the by-site view; the grid reads the descriptor, derives each cell's horizontal delta from horizon column indices (no rect capture — the grid is not mounted before approval), and plays a two-phase staggered transition. A Replay control re-runs it from retained state.

**Tech Stack:** React 19 + TypeScript, Zustand, Tailwind v4, Vite. Tests via `node:test` with `--experimental-strip-types`.

**Spec:** `docs/superpowers/specs/2026-09-08-dispatch-rearrange-animation-design.md`

## Global Constraints

- **No backend files change.** `cd src/backend && py -m pytest -q -p no:cacheprovider` must stay at **275 passed**; any movement is a regression signal.
- **The animation may only describe real solver output** — it is diffed from two real runs. Never interpolate, reorder, or invent a move.
- **Animate `transform` and `opacity` only.** Never width/height/left/top, which reflow the grid mid-animation.
- **Motion is never the sole carrier of information.** Every moved cell keeps a persistent origin badge, and the confirmation states the same facts in words.
- **Honour `prefers-reduced-motion: reduce`** — final positions immediately, badges still shown.
- **Type scale only** (`text-eyebrow` / `text-micro` / `text-ui`). No arbitrary `text-[13px]`.
- **Colour:** accent for the change badge (chrome describing a change), `--color-alert` for the emergency, band colours only via `lib/colors.ts`.
- Value imports in `lib/` modules that are covered by a `node:test` file need explicit `.ts` extensions (Node's strip-types resolver will not infer one). Type-only imports do not.
- Verify with `npm run build` and `npm run lint` from `src/frontend`. A passing build does not verify motion — a browser pass is mandatory.

---

### Task 1: Animation descriptor and column geometry

**Files:**
- Create: `src/frontend/src/lib/dispatchAnimation.ts`
- Test: `src/frontend/src/lib/dispatchAnimation.test.mjs`

**Interfaces:**
- Produces:
  - `export interface DispatchMove { tower_id: string; from: string; to: string }`
  - `export interface DispatchAnimation { moves: DispatchMove[]; emergency: { tower_id: string; day: string }; token: number }`
  - `export function columnDelta(from: string, to: string, horizon: string[], columnWidth: number): number`
  - `export const SLIDE_MS = 400`, `STAGGER_MS = 150`, `LAND_MS = 250`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/lib/dispatchAnimation.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

import { columnDelta, SLIDE_MS, STAGGER_MS, LAND_MS } from './dispatchAnimation.ts';

const HORIZON = [
  '2026-09-08',
  '2026-09-09',
  '2026-09-10',
  '2026-09-11',
  '2026-09-12',
  '2026-09-13',
  '2026-09-14',
];

test('a job moving earlier starts to the RIGHT of where it lands', () => {
  // Sat 12 (index 4) -> Thu 10 (index 2): it renders in column 2 and must
  // begin two columns to the right, i.e. a positive x offset.
  const dx = columnDelta('2026-09-12', '2026-09-10', HORIZON, 100);
  assert.equal(dx, 200);
});

test('a job moving later starts to the LEFT of where it lands', () => {
  const dx = columnDelta('2026-09-09', '2026-09-12', HORIZON, 100);
  assert.equal(dx, -300);
});

test('magnitude scales with the measured column width', () => {
  assert.equal(columnDelta('2026-09-12', '2026-09-10', HORIZON, 55), 110);
});

test('same day is no movement', () => {
  assert.equal(columnDelta('2026-09-10', '2026-09-10', HORIZON, 100), 0);
});

test('a day outside the horizon yields no slide rather than an arbitrary offset', () => {
  assert.equal(columnDelta('2026-08-01', '2026-09-10', HORIZON, 100), 0);
  assert.equal(columnDelta('2026-09-10', '2026-08-01', HORIZON, 100), 0);
});

test('an unmeasured column width yields no slide', () => {
  assert.equal(columnDelta('2026-09-12', '2026-09-10', HORIZON, 0), 0);
});

test('phase timings are ordered so the emergency lands after the moves settle', () => {
  assert.ok(STAGGER_MS < SLIDE_MS);
  assert.ok(LAND_MS > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/dispatchAnimation.test.mjs`
Expected: FAIL — cannot find module `./dispatchAnimation.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/frontend/src/lib/dispatchAnimation.ts`:

```typescript
/** One job the re-solve moved to a different day to make room. */
export interface DispatchMove {
  tower_id: string;
  from: string; // ISO day it left
  to: string; // ISO day it landed on
}

/**
 * Display-only description of what one approved dispatch did to the board.
 * Derived entirely from the pre-pin run and the run /schedule/pin returned —
 * it never carries anything the solver did not actually do.
 */
export interface DispatchAnimation {
  moves: DispatchMove[];
  emergency: { tower_id: string; day: string };
  /** Bumped to replay the same sequence. */
  token: number;
}

export const SLIDE_MS = 400;
export const STAGGER_MS = 150;
export const LAND_MS = 250;

/**
 * Horizontal offset a moved cell must START at so it appears to travel from
 * its old day column to the new one it now renders in.
 *
 * Derived from horizon indices rather than captured rects on purpose: the
 * by-site grid is not mounted before approval (the planner is in the crew
 * view and approving switches them over), so there are no "before" rects to
 * capture and textbook FLIP does not apply. The grid's day columns are equal
 * width, so index arithmetic is exact.
 *
 * Returns 0 — no slide, cell simply appears — when either day is outside the
 * current horizon or the column width has not been measured yet. Both are
 * real states, and flying a cell in from an arbitrary offset would assert a
 * movement that did not happen.
 */
export function columnDelta(
  from: string,
  to: string,
  horizon: string[],
  columnWidth: number,
): number {
  if (columnWidth <= 0) return 0;
  const fromIndex = horizon.indexOf(from);
  const toIndex = horizon.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return 0;
  return (fromIndex - toIndex) * columnWidth;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/dispatchAnimation.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/lib/dispatchAnimation.ts src/frontend/src/lib/dispatchAnimation.test.mjs
git commit -m "feat(schedule): descriptor and column geometry for the dispatch rearrange

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Store the descriptor

**Files:**
- Modify: `src/frontend/src/state/useScheduleStore.ts`

**Interfaces:**
- Consumes: `DispatchAnimation` from `../lib/dispatchAnimation` (Task 1).
- Produces on the store: `dispatchAnimation: DispatchAnimation | null`, `setDispatchAnimation(a: Omit<DispatchAnimation, 'token'>): void`, `replayDispatchAnimation(): void`, `clearDispatchAnimation(): void`.

- [ ] **Step 1: Add the import**

At the top of `src/frontend/src/state/useScheduleStore.ts`, beside the existing type imports:

```typescript
import type { DispatchAnimation } from '../lib/dispatchAnimation';
```

- [ ] **Step 2: Declare the fields on the interface**

Inside `interface ScheduleStoreState`, after `setPendingEmergency`:

```typescript
  /**
   * What the most recently approved dispatch did to the board, for the
   * by-site grid to animate and badge. Display state only — it is derived
   * from two runs the store already holds, so clearing it changes nothing
   * about the plan.
   */
  dispatchAnimation: DispatchAnimation | null;
  setDispatchAnimation: (a: Omit<DispatchAnimation, 'token'>) => void;
  /** Re-runs the same sequence; the grid keys its transition off `token`. */
  replayDispatchAnimation: () => void;
  clearDispatchAnimation: () => void;
```

- [ ] **Step 3: Implement them**

In the `create<ScheduleStoreState>((set) => ({ ... }))` body, beside `setPendingEmergency`:

```typescript
  dispatchAnimation: null,
  setDispatchAnimation: (a) => set({ dispatchAnimation: { ...a, token: 1 } }),
  replayDispatchAnimation: () =>
    set((s) =>
      s.dispatchAnimation
        ? { dispatchAnimation: { ...s.dispatchAnimation, token: s.dispatchAnimation.token + 1 } }
        : {},
    ),
  clearDispatchAnimation: () => set({ dispatchAnimation: null }),
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src/frontend && npx tsc -b --noEmit && npm run lint`
Expected: no errors; only the two pre-existing `useLiveTowers.ts` warnings.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/state/useScheduleStore.ts
git commit -m "feat(schedule): hold the dispatch rearrange descriptor in the store

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Write the descriptor on approve, switch view, offer Replay

**Files:**
- Modify: `src/frontend/src/components/schedule/TicketApprovalPanel.tsx`

**Interfaces:**
- Consumes: the store actions from Task 2.
- Produces: no new exports; the confirmation gains a Replay button.

- [ ] **Step 1: Pull in the store actions and the view switch**

In the store-hook block near the top of the component, beside `setTerritory`:

```typescript
  const setViewMode = useScheduleStore((s) => s.setViewMode);
  const setDispatchAnimation = useScheduleStore((s) => s.setDispatchAnimation);
  const replayDispatchAnimation = useScheduleStore((s) => s.replayDispatchAnimation);
  const clearDispatchAnimation = useScheduleStore((s) => s.clearDispatchAnimation);
```

- [ ] **Step 2: Write the descriptor in the pin's onSuccess**

In `approve()`'s `onSuccess`, immediately after `setCommitted({ crew_id: suggestion.crew.crew_id, dropped, moved });`:

```typescript
          // The by-site grid is the only view holding the whole horizon, so a
          // cross-day move can only be shown there — the crew timeline draws
          // one day and a move between days is invisible on it.
          setViewMode('tower');
          setDispatchAnimation({
            moves: moved,
            emergency: { tower_id: ticket.tower_id, day },
          });
```

- [ ] **Step 3: Add Replay and clear-on-done to the confirmation**

In the `if (committed)` block, replace the existing single-button footer:

```tsx
        <div className="mt-4">
          <Button onClick={onDone}>Done</Button>
        </div>
```

with:

```tsx
        <div className="mt-4 flex gap-2">
          <Button
            onClick={() => {
              setViewMode('tower');
              replayDispatchAnimation();
            }}
          >
            Replay
          </Button>
          {/* Clearing the descriptor also drops the grid's origin badges —
              they describe THIS dispatch, and leaving them up after the
              planner has moved on would attribute a later board state to it. */}
          <Button
            tone="primary"
            onClick={() => {
              clearDispatchAnimation();
              onDone();
            }}
          >
            Done
          </Button>
        </div>
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src/frontend && npx tsc -b --noEmit && npm run lint`
Expected: no new errors or warnings.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/schedule/TicketApprovalPanel.tsx
git commit -m "feat(schedule): publish the rearrange descriptor and offer replay

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Play the rearrange in the by-site grid

**Files:**
- Modify: `src/frontend/src/components/schedule/ScheduleGridByTower.tsx`

**Interfaces:**
- Consumes: `columnDelta`, `SLIDE_MS`, `STAGGER_MS`, `LAND_MS` from `../../lib/dispatchAnimation`; `dispatchAnimation` from the store.

- [ ] **Step 1: Add imports**

```tsx
import { columnDelta, SLIDE_MS, STAGGER_MS, LAND_MS } from '../../lib/dispatchAnimation';
```

`useState`, `useLayoutEffect` and `useMemo` join the existing `react` import.

- [ ] **Step 2: Read the descriptor, measure a column, and drive the phases**

Add the selector line immediately after the existing `dispatchTarget` line (it is read by
`relevantTowers` in Step 3, which comes next in the file):

```tsx
  const dispatchAnimation = useScheduleStore((s) => s.dispatchAnimation);
```

Everything below goes **after `const horizon = run.horizon;`**, not beside the selector — the
measurement effect's dependency array reads `horizon.length` during render, and `horizon` is
declared further down the component, so placing it earlier throws a temporal-dead-zone
`ReferenceError` on the first render:

```tsx

  // Measured from a real rendered day cell rather than computed from the
  // container: the grid is `190px repeat(n, 1fr)` inside a horizontally
  // scrolling wrapper, so deriving a column width by arithmetic would drift
  // from what is actually on screen.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [columnWidth, setColumnWidth] = useState(0);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const cell = el.querySelector('[data-day-cell]');
      setColumnWidth(cell ? (cell as HTMLElement).getBoundingClientRect().width : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [horizon.length]);

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 'offset' holds the moved cells at their old columns for one frame, then
  // 'settling' releases them; the emergency lands once the moves are done.
  const [phase, setPhase] = useState<'idle' | 'offset' | 'settling' | 'landed'>('idle');
  const animToken = dispatchAnimation?.token ?? 0;
  useLayoutEffect(() => {
    if (!dispatchAnimation || reducedMotion || columnWidth <= 0) {
      setPhase('landed');
      return;
    }
    setPhase('offset');
    // rAF, not a timeout: the offset transform must be committed to the DOM
    // for one frame before the transition to zero, or the browser coalesces
    // both into no visible movement.
    const raf = requestAnimationFrame(() => setPhase('settling'));
    const landAt = window.setTimeout(
      () => setPhase('landed'),
      SLIDE_MS + STAGGER_MS,
    );
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(landAt);
    };
  }, [animToken, dispatchAnimation, reducedMotion, columnWidth]);

  const movesByTower = useMemo(
    () => new Map((dispatchAnimation?.moves ?? []).map((m) => [m.tower_id, m])),
    [dispatchAnimation],
  );
```

- [ ] **Step 3: Force animated towers into the visible rows**

In the non-search branch of `relevantTowers`, replace the `dispatchTarget` force-include block with one that also covers animated towers:

```tsx
        // A routed dispatch target must be visible even if it fell outside
        // the top-30 sample, or the scroll-into-view below has nothing to
        // find. The same holds for every tower the last dispatch MOVED: the
        // confirmation names them, so a board that does not contain them
        // reads as the board disagreeing with the panel.
        const forced: typeof base = [];
        const needed = new Set<string>(dispatchAnimation?.moves.map((m) => m.tower_id) ?? []);
        if (dispatchTarget) needed.add(dispatchTarget.tower_id);
        for (const id of needed) {
          if (base.some((t) => t.tower_id === id)) continue;
          const found = towers.find((t) => t.tower_id === id);
          if (found) forced.push(found);
        }
        return forced.length > 0 ? [...forced, ...base] : base;
```

- [ ] **Step 4: Tag the grid and its day cells, and apply the transform**

Put the ref on the grid container:

```tsx
      <div
        ref={gridRef}
        className="grid min-w-[780px] gap-2"
        style={{ gridTemplateColumns: `190px repeat(${horizon.length}, 1fr)` }}
      >
```

In the `hasEntries` branch, mark the wrapper as a day cell and animate it when this tower moved:

```tsx
                if (hasEntries) {
                  const move = movesByTower.get(tower.tower_id);
                  const isEmergencyCell = dispatchAnimation?.emergency.tower_id === tower.tower_id
                    && dispatchAnimation?.emergency.day === day;
                  const dx =
                    move && move.to === day && phase === 'offset'
                      ? columnDelta(move.from, move.to, horizon, columnWidth)
                      : 0;
                  return (
                    <div
                      key={`${tower.tower_id}-${day}`}
                      data-day-cell
                      className="flex h-full w-full flex-col gap-1 py-0.5"
                      style={{
                        transform: dx !== 0 ? `translateX(${dx}px)` : undefined,
                        transition:
                          phase === 'settling' && move && move.to === day
                            ? `transform ${SLIDE_MS}ms ease-out`
                            : undefined,
                        // The emergency waits for the moves to clear, so the
                        // sequence reads as "room was made, then it landed"
                        // rather than everything shifting at once.
                        opacity: isEmergencyCell && phase !== 'landed' ? 0 : 1,
                        ...(isEmergencyCell
                          ? { transition: `opacity ${LAND_MS}ms ease-out ${STAGGER_MS}ms` }
                          : null),
                      }}
                    >
```

- [ ] **Step 5: Badge the moved cells, and tag empty cells too**

Immediately inside that wrapper, above `{dayEntries.map(...)}`:

```tsx
                      {move && move.to === day && (
                        <span className="self-start rounded border border-accent/35 bg-accent/10 px-1.5 text-eyebrow font-semibold text-accent">
                          moved from {dayLabel(move.from)}
                        </span>
                      )}
```

And on the empty-cell branch's wrapper `<div>`, add `data-day-cell` so a column can still be measured when the first row happens to be empty:

```tsx
                  <div
                    key={`${tower.tower_id}-${day}`}
                    data-day-cell
                    ref={isEmergencyTarget ? targetRef : undefined}
```

- [ ] **Step 6: Verify it compiles, lints and builds**

Run: `cd src/frontend && npx tsc -b --noEmit && npm run lint && npm run build`
Expected: clean; only the two pre-existing warnings.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/components/schedule/ScheduleGridByTower.tsx
git commit -m "feat(schedule): animate the board rearranging around an approved dispatch

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Verification

**Files:** none modified.

- [ ] **Step 1: Automated checks**

```bash
cd src/frontend && node --experimental-strip-types --test src/lib/dispatchAnimation.test.mjs
cd src/frontend && node --experimental-strip-types --test src/lib/crewPosition.test.mjs
cd src/frontend && node --experimental-strip-types --test src/lib/ticketSuggestion.test.mjs
cd src/frontend && node --experimental-strip-types --test src/lib/inundation.test.mjs
cd src/frontend && npm run build && npm run lint
cd src/backend && py -m pytest -q -p no:cacheprovider
```

Expected: 7 + 6 + 5 + 2 frontend tests pass; build clean; lint shows only the two pre-existing warnings; backend **275 passed**.

- [ ] **Step 2: Browser — a dispatch that displaces work**

The animation is only interesting when the re-solve moves something, so pick a ticket whose crew type is busy. Generate demo emergency tickets until the approval panel's "What this costs the plan" lists at least one *other* tower, then approve.

Expect, in order: the board switches to **By site**; the displaced cells slide from their old day columns to their new ones over ~400ms; the emergency cell fades in afterwards; each moved cell keeps a `moved from <day>` badge; the confirmation lists the same moves in words.

- [ ] **Step 3: Browser — Replay**

Press **Replay**. The same sequence re-runs from the retained descriptor. Press **Done** — badges clear.

- [ ] **Step 4: Browser — the no-displacement case**

Approve a dispatch that displaces nothing. Expect no slide phase, the emergency cell still appearing, and the confirmation reading that nothing was moved or dropped.

- [ ] **Step 5: Browser — reduced motion**

DevTools → Rendering → *Emulate CSS prefers-reduced-motion: reduce*. Approve again. Expect no movement at all, cells in final positions immediately, and the badges still present.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(schedule): address issues found in the rearrange animation browser pass

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Out of scope

- Animating the crew timeline — it draws one day, so a cross-day move cannot be shown there.
- Animating week-strip counts or load bars.
- Sub-project 1a (OSRM routing), independent and unchanged.
