# Scheduling Tab — UI/UX Rework

Scope: the Schedule tab only (`src/frontend/src/pages/Schedule.tsx` and
`src/frontend/src/components/schedule/**`), plus the token additions those
components need in `src/frontend/src/index.css`.

Driven by `/ui-ux-pro-max` (§4 Style Selection, §6 Typography & Color,
§1 Accessibility) and the four reference screenshots supplied.

---

## 1. Diagnosis — why it currently reads flat

Read of the current code, not a guess:

| # | Problem | Evidence in code |
|---|---------|------------------|
| D1 | **Every surface is the same surface.** Bars, rails, group headers, the work queue and the detail panel are all `bg-ink-900` (= `#ffffff`) with an `border-overlay/[0.07]–/12` hairline. Nothing tells the eye what kind of thing it is looking at. | `RoleGroup.tsx` Bar `bg-ink-900`, group header `bg-ink-950/95`, lane `hover:bg-overlay/[0.02]` |
| D2 | **Crew-type identity is invisible.** `roleTeams.ts` deliberately refuses colour ("identity is carried by grouping, label and glyph, NOT by colour"). In practice the glyph is a 14px grey stroke and the label is 12px — so Civil / Power / RF / Electrical are four visually identical stripes down a 900px board. | `RoleGroup.tsx` header, `GlyphIcon` `text-muted` |
| D3 | **The severity ramp is spent on a 3px edge.** The only colour on a job bar is `borderLeft: 3px solid band`. At 46px tall on white that is ~2% of the bar's area — hence "dull colour and almost the same all over the calendar". | `RoleGroup.tsx` Bar `style.borderLeft` |
| D4 | **Weird rail layout.** The 208px crew rail stacks four unrelated things (glyph+id / label·depot / util meter) with `gap-1` and no alignment grid, and the group header fakes its alignment with `paddingLeft: calc(RAIL - 16px)` — so header text does not line up with the rail content below it. | `RoleGroup.tsx` `RAIL`, header `style.paddingLeft` |
| D5 | **The detail panel is not glass.** `DetailPanel` uses `.glass-raised`, whose fill is `rgba(255,255,255,0.94)` → effectively opaque. Its docblock refuses blur because the panel "animates its width" — but it no longer does; it mounts and unmounts. | `index.css` `.glass-raised`, `DetailPanel.tsx` |
| D6 | **The optimizer dock is a white card with a blur class.** `bg-white/95`, `/90`, `/95` at every level, so `backdrop-filter` has almost nothing to show through. Bubbles, chips and the input bar are each `/95`. | `AgentDock.tsx`, `AgentChat.tsx` |
| D7 | **Emoji used as icons** in the suggestion chips (⚡ 🚨 🛡️ ⏱️) — breaks the skill's `no-emoji-icons` rule and renders differently per platform. | `AgentChat.tsx` `SUGGESTED_PROMPTS` |
| D8 | **No hour-band rhythm.** Gridlines are `overlay/[0.06]` single hairlines with no alternating wash, so a bar's horizontal position is hard to read back to a clock time. | `RoleGroup.tsx` lane ticks |

## 2. Colour policy — OVERRULED, now aligned to the map tab

The previous rule ("cool accent = interface chrome; warm colour is data, never
control chrome" — [CLAUDE.md:173](CLAUDE.md#L173), `index.css:5-11`,
originally `73ed5f0` / refined in `cf4cda4`) **is overruled by the repo owner
for the Schedule tab.** Crew types may now carry their own hue.

What replaces it is not "anything goes" — it is **the map tab's own visual
vocabulary**, extended to a new dimension. Read out of
`pages/Overview.tsx`, `components/hud/*`, `components/shell/NavPill.tsx` and
`components/ui/Panel.tsx`, the map tab is built from six recipes. The Schedule
tab adopts all six rather than inventing its own.

### The six map-tab recipes this rework adopts

| # | Recipe | Where it lives on the map tab | Where it goes on the calendar |
|---|--------|-------------------------------|-------------------------------|
| M1 | **Tinted chip trio** — `color: ink`, `borderColor: hue + '66'`, `backgroundColor: hue + '1a'` | `SelectionHud.tsx` band chip | Job bars, role headers, risk chips |
| M2 | **`.glass-float` detached module** — gradient white, `rgba(13,21,38,0.14)` hairline, `--shadow-3`, `rounded-xl`, `p-[13px]` | Every HUD module | Detail panel, Ranger dock |
| M3 | **Meter row** — `h-[5px] rounded-full bg-overlay/[0.07]` track, hue fill, `min-h-[32px]` hit row, count left / label right | `BandModule` band rows, driver mix | Utilisation meters, role group aggregate |
| M4 | **Accent-tinted active state** — `bg-accent/15 font-medium text-accent` | `NavPill` | Selected bar, active WorkQueue tab, selected day |
| M5 | **Tinted callout** — `border-<hue>/35 bg-<hue>/10 text-<hue>-ink` | `StatusNote`, disagreement note, unscheduled note | Empty-group reasons, offline notice, over-committed warning |
| M6 | **Isolate-by-dimming** — tap a row to filter, non-matching go `opacity-45` | `BandModule` band filter | `CalendarFilter` role/status filter on the board |

### Crew-type hues (the new part)

Authored with the **same trio structure** as `lib/colors.ts` (`COLORS` fill ramp
≥3:1, `INK_COLORS` text ramp ≥4.5:1), so the new file is a sibling of the file
the map tab already reads from, not a competing system.

New `lib/roleColors.ts`:

```ts
export const ROLE_COLORS: Record<string, string> = {   // fill, >=3:1
  civil:      '#4f46e5',   // indigo
  power:      '#0284c7',   // sky
  rf:         '#0891b2',   // cyan
  electrical: '#64748b',   // slate — the workless role, deliberately mute
};
export const ROLE_INK: Record<string, string> = { ... };  // text, >=4.5:1
export function roleColor(t: string): string
export function roleInk(t: string): string
```

Deliberately chosen **cool/blue-family**, not because the old rule still binds,
but because the warm triad is still doing severity work *on the same bar*. A
job bar shows role AND risk simultaneously; if role could be orange the two
readings would collide on one element. Cool role + warm risk keeps both
legible at once. That is a legibility constraint, not the old policy.

`roleTeams.ts` gains a `tone: string` key pointing at these, replacing its
current docblock paragraph refusing colour.

### CLAUDE.md must be updated

The rule is stated in three places and enforced by review. Leaving it while the
code contradicts it makes the next reviewer revert this work. Part of this task:

- `CLAUDE.md:173` — amend to: cool accent = chrome; **warm triad = tower
  severity, still exclusive**; **cool role family = crew capability**; a warm
  hue on a control is still a bug.
- `index.css:5-11` — same amendment in the header comment.
- `docs/superpowers/specs/2026-08-30-schedule-tab-rework-design.md:276` — mark
  the "colour is deliberately not the identity channel" paragraph superseded,
  with the date and the reason.

## 3. Work items

### 3.1 Calendar — vibrancy and readability

**Files:** `components/schedule/RoleGroup.tsx`, `components/schedule/TimelineBoard.tsx`,
`lib/roleTeams.ts`, `lib/roleColors.ts` (new), `index.css`

- **W1 — Role-coloured group headers (recipe M1).** The header band takes the
  chip trio at group scale: `background: linear-gradient(90deg, hue1a, transparent)`,
  a 3px `hue` left spine, the glyph in a 24px `hue1a` / `hue66` rounded chip
  with `roleInk()` stroke, label `text-body`/600, and the Annex-C `answers`
  string as a `hue`-tinted pill. This is the single change that makes the four
  capability groups scannable.
- **W2 — Group left spine.** Each `<section>` gets `border-l-[3px]` in the role
  hue, so a lane still says which capability it belongs to after the header
  scrolls away. Reuses the existing `.spine` class + `--spine` custom property
  that `Panel` and `TowerDrawer` already use — not a new mechanism.
- **W3 — Redesigned job bar (recipe M1, severity ramp).** Replace the flat
  white bar with the chip trio driven by `bandColor`/`bandInk`:
  - fill `band + '1a'`, border `band + '66'`, 3px band spine (kept),
  - a **risk chip** at the bar’s right edge when `widthPct > 11`: `tnum`,
    `bandInk` text on a `band + '26'` wash — same construction as the
    `SelectionHud` band chip, at bar scale,
  - place name `text-ui`/600 `text-fg`, time `text-eyebrow text-muted`,
  - hover → wash to `band + '2e'` + `--shadow-2`; selected → M4 accent
    treatment (`bg-accent/15`, accent ring). Colour and shadow only, never
    size, so the board never reflows on hover.
- **W4 — Fix the rail (D4).** Rail `208px → 224px`, laid out as a real 2-row
  grid: row 1 = role chip + crew id (`text-ui`/600), row 2 = depot
  (`text-micro text-muted`) with the utilisation meter right-aligned on the
  same baseline. The group header stops faking alignment with
  `calc(RAIL - 16px)` and uses a `width: RAIL` spacer element, so header and
  rail share one edge.
- **W5 — Utilisation meter (recipe M3).** Restated as a `BandModule` meter row:
  `h-[5px] rounded-full bg-overlay/[0.07]` track, `transition-[width] 300ms`,
  percentage `tnum` right-aligned at a fixed `w-[30px]` so the column cannot
  jitter. Fill switches ramp by load: `<60%` role hue, `60–85%` accent,
  `>85%` `--color-watch` — over-committed crews become findable. `title` +
  `aria-label` restate the same fact in words (§1 `color-not-only`).
- **W6 — Hour-band rhythm.** Alternate hour columns get an `overlay/[0.025]`
  wash behind the lanes and the current hour an `accent/25` vertical rule, so a
  bar’s x-position reads back to a clock time. One absolutely-positioned
  `pointer-events-none` layer per lane.
- **W7 — Reserve / free / empty states.** Reserve keeps
  `lib/reserveHatch.ts`’s `RESERVE_HATCH_STYLE` unchanged — it is the shared
  definition four other components draw from, and reserve is deliberately
  neither severity nor role. "Free — assign work" keeps its dashed affordance
  and picks up the role tint on hover. Empty-group reasons become M5 callouts.
- **W8 — Filter dimming (recipe M6).** `CalendarFilter`’s role/status filter
  stops hiding lanes outright and instead dims non-matching ones to
  `opacity-45`, exactly as `BandModule` dims non-selected bands — so filtering
  keeps the board’s shape and the planner does not lose their place.
- **W9 — Sticky z-order audit.** Hour axis `z-10`, group header `z-[5]`; after
  the spine wrapper is added, re-verify the axis still covers the header on
  scroll.

### 3.2 Detail side panel — glassmorphism

**Files:** `components/schedule/DetailPanel.tsx`, `WhySlotPanel.tsx`,
`MoveControl.tsx`, `index.css`

- **W10 — New `.glass-panel` surface class** in `@layer components`:
  `background: linear-gradient(180deg, rgba(255,255,255,0.72), rgba(246,249,255,0.58))`,
  `backdrop-filter: blur(20px) saturate(1.35)`,
  `border-left: 1px solid rgba(255,255,255,0.75)`, outer `--shadow-3`, and an
  inner top catchlight `inset 0 1px 0 rgba(255,255,255,0.9)`. Registered in the
  existing `@media (prefers-reduced-transparency: reduce)` block so it goes
  solid white like every other glass class.
- **W11 — Panel entrance.** `translateX(12px)` + opacity on mount, 220ms
  `cubic-bezier(0.16,1,0.3,1)` (§7 `duration-timing`, `easing`). Transform
  only — the old docblock's objection was to blurring a *width*-animating
  surface, which this is not.
- **W12 — Futuristic controls inside the panel.**
  - Section headers → `eyebrow` plus a hairline rule that fades out
    (`linear-gradient(90deg, line, transparent)`).
  - `MoveControl`'s crew/day `<select>`s get a glass field treatment:
    `bg-white/45`, `border-white/60`, inner highlight, 2px `focus-visible`
    accent ring (the global focus rule is preserved, not overridden).
  - "Pin to this slot" becomes the panel's single primary CTA
    (§4 `primary-action`): violet→indigo gradient, `--shadow-2`,
    `active:scale-[0.98]`, 44px tall (§2 `touch-target-size`).
  - The reasons list gets an accent vertical rail instead of loose bullet dots.
  - Route map corners rounded and inset so it reads as a card inside the glass
    rather than a bleeding rectangle.
- **W13 — Header row.** "Scheduled visit" eyebrow plus a 36×36 glass icon
  close button, `aria-label` kept.

### 3.3 Ranger optimizer chat — glassmorphism

**Files:** `components/schedule/AgentDock.tsx`, `components/schedule/AgentChat.tsx`

- **W14 — Real glass on the dock.** Fill drops from `/95` to
  `rgba(255,255,255,0.62)` over `blur(24px) saturate(1.4)`, border
  `1px solid rgba(255,255,255,0.7)`, plus a violet ambient bloom behind the
  panel (`radial-gradient` on a `pointer-events-none` `::before`) so the frost
  has something to refract. The collapsed pill gets the same at a smaller blur.
- **W15 — Transcript on glass.** User bubble keeps its violet→indigo gradient
  (it already reads well); Ranger → `bg-white/55 + blur(8px) + border-white/60`;
  constraint → `accent/10` with an accent hairline; tool → pill with a live
  dot; error keeps the alert ramp, contrast re-checked on the translucent fill.
- **W16 — Replace emoji chips with SVG glyphs** (D7). Four inline 16px stroke
  icons at `strokeWidth 1.6` matching `shell/icons.tsx`: bolt (unavailable),
  triangle/siren (emergency), shield (reserve), clock (day off). Chips become
  glass: `bg-white/50`, `border-white/60`, hover `accent/12` + accent border.
- **W17 — Input bar.** Keeps its pill shape, goes `bg-white/55` + `blur(16px)`;
  `focus-within` raises to `/75` with an accent ring. Send button keeps its
  gradient — it is the one saturated element and should stay.
- **W18 — Empty state.** Mascot badge gets a soft violet aurora ring (two
  stacked radial gradients) instead of the flat tinted square.
- **W19 — Motion discipline.** The permanent `animate-ping` status dot drops to
  a 2s cycle so an always-on animation is not competing with the board
  (§7 `excessive-motion`); the global reduced-motion clamp still applies.

### 3.4 Chrome around the board

**Files:** `pages/Schedule.tsx`, `WeekStrip.tsx`, `WorkQueue.tsx`, `CalendarFilter.tsx`

- **W20 — Header/filter bar** takes the `.glass` surface so the toolbar reads
  as a layer above the board rather than as more board.
- **W21 — WorkQueue tab strip** gets a filled active-tab pill (`accent/12` +
  accent text) so the current tab is unmistakable (§9 `nav-state-active`).
- **W22 — WeekStrip day cells** pick up the same alternating rhythm and a
  filled accent state for the selected day.

## 4. Accessibility gates (must pass before this is called done)

- [ ] Every new colour pair measured: body text ≥4.5:1, large/UI marks ≥3:1,
      against **both** `#ffffff` and `#f2f5fa`. Glass fills measured against
      their *worst-case* backdrop (a white board), not the gradient.
- [ ] No information by colour alone: role keeps glyph + label, severity keeps
      its numeric risk, utilisation keeps its percentage.
- [ ] Bars/chips ≥32px hit height on the board; panel CTAs ≥44px; ≥8px between
      adjacent targets.
- [ ] `:focus-visible` accent ring survives on every restyled control — no
      class removes the outline.
- [ ] `prefers-reduced-transparency: reduce` → every new glass class solid.
- [ ] `prefers-reduced-motion: reduce` → panel entrance and dock expansion clamp.
- [ ] Hover/selected states change colour and shadow only, never box size.
- [ ] No new horizontal scrollbar: the board's `min-w-[860px]` and the
      "skip the closing tick" workaround in `RoleGroup` must both survive the
      rail width change.

## 5. Order of work

1. `index.css` — `.glass-panel`, glass field/chip helpers, the amended
   colour-policy header comment, reduced-transparency registration.
   *(nothing renders differently yet)*
2. `lib/roleColors.ts` (new) + `lib/roleTeams.ts` — the role hue trio and the
   `tone` key; delete the "refuses colour" paragraph from `roleTeams.ts`.
3. `RoleGroup.tsx` — W1–W5, W7 (the largest single change).
4. `TimelineBoard.tsx` + `CalendarFilter.tsx` — W6, W8, W9, rail-width sync.
5. `DetailPanel.tsx` / `WhySlotPanel.tsx` / `MoveControl.tsx` — W10–W13.
6. `AgentDock.tsx` / `AgentChat.tsx` — W14–W19.
7. `Schedule.tsx` / `WeekStrip.tsx` / `WorkQueue.tsx` — W20–W22.
8. `CLAUDE.md` + the design spec — record the overruled rule (§2), so the next
   reviewer does not revert this work as a policy violation.
9. Accessibility pass over §4, then `npm run lint` + `npm run build` clean,
   plus a browser check (per CLAUDE.md, a passing build does not verify visual
   or accessibility work).

## 6. Explicitly out of scope

- `ScheduleGridByTower` (the tower view) beyond inheriting the new tokens.
- Any backend, solver, or `api/` change. No data shape moves.
- The map, investigation, and method tabs.
- Dark theme: the app ships light-only (`color-scheme: light`). The new tokens
  are authored so a future flip of `--color-overlay` still works, but dark mode
  is not being introduced here.
