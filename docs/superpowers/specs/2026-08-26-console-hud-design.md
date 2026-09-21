# Console HUD (direction 1b) — Overview redesign

Date: 2026-08-26
Source handoff: `new design/Geographic Futuristic Frontend Design/design_handoff_map_console/`
Direction: **1b — Console HUD** (`02-console-hud.md`)

## Thesis

The map is the entire frame. Every control becomes a small detached glass module
floating over it. Adds two orientation cues the current screen lacks: a coordinate
graticule with edge ticks, and a model-vintage scrubber.

Chrome-only. No backend, no `api/types.ts`, no `api/queries.ts`, no existing store's
public shape is touched. Every value still comes from `useLiveTowers(weights)`,
`useLiveSchedule()`, `useStabilityQuery()`, `useSelection`, `useMapFilter`, `useWeights`.

## Decisions taken during brainstorming

1. **Direction: 1b.**
2. **Orphaned stats tiles are preserved, split by nature.** `PeopleTile` and
   `BaselineTile` are illustrative (both carry hardcoded assumed constants and say so)
   and move to `/method`, which already hosts an "Assumed parameters" panel. `DriversTile`
   carries real data (`driverMix(towers)`) and becomes a compact meter section on the
   Overview HUD.
3. **Unbacked controls ship disabled and honest.** There is no AOI endpoint in
   `src/backend/api/` and no vintage field in the API. The AOI module renders to full
   visual spec but disabled with an explanatory `title`; the vintage scrubber locks to
   the single real value with past years at `opacity:.4` and a sub-line saying so.
   No fabricated responses, no fabricated history.
4. **The NavRail stays on the other five routes.** Only `/` goes full-bleed with the
   top-centre nav pill. `App.tsx` skips the rail and the `ml-[84px]` offset for `/` only.

## Architecture

### Map instance access (the one non-layout problem)

Four overlays must read live map state: longitude ticks, latitude ticks, cursor
lat/lon and the scale rule. The spec forbids hardcoding them — they derive from
`map.getBounds()` on `move`.

Today the instance is reachable only via `window.__map`, a devtools escape hatch.

**Chosen: a new `state/useMapInstance.ts` Zustand store** holding the instance plus a
`view` snapshot (bounds, zoom, cursor). Overlays subscribe like every other
cross-component value in this app. Adding a *new* store does not change any existing
store's public shape, so the handoff constraint holds.

Rejected: React context (a second state mechanism in a Zustand codebase); reading
`window.__map` directly (promotes a debug hook to load-bearing API, no subscription).

Ticks update on `move`, not `moveend`, or they visibly lag the pan. That is a
high-frequency subscription driving DOM text, so it is coalesced with
`requestAnimationFrame`, and no tick element carries `backdrop-filter`.

### Files

New — `components/hud/`:

| File | Carries |
|---|---|
| `BrandChip.tsx` | `left:20 top:18` logo + wordmark |
| `NavPill.tsx` | top-centre pill; `NavLink` + `end` on `/`, `aria-current="page"` |
| `StatusChips.tsx` | LIVE/OFFLINE, rho, N towers |
| `BandModule.tsx` | band rows as key *and* filter, plus the drivers section |
| `OpacityModule.tsx` | score-opacity slider |
| `AoiModule.tsx` | disabled AOI tools |
| `SelectionHud.tsx` | right column, renders TowerDrawer's content |
| `VintageScrubber.tsx` | locked to the single real vintage |
| `MapOverlays.tsx` | dim, graticule, vignette, ticks, readout, reticle |

Modified: `index.css`, `lib/colors.ts`, `App.tsx`, `pages/Overview.tsx`,
`components/map/MapView.tsx`, `components/method/MethodPage.tsx`.

Deleted: `components/map/Legend.tsx` — band rows are now both key and filter
(handoff step 3).

Untouched: all of `src/backend/`, `api/*`, every existing store, `towerLayer.ts` exports.

`TowerDrawer` stays in use on `/tower/:towerId`. `SelectionHud` reuses
`AttributionBars`, `WorkOrderCard` and `lib/format` rather than duplicating them.

## Spec deviations, deliberate

1. **Band meter denominator.** The spec catches its own prototype's cheat: fill is
   share of total, `count / total * 100`, not `count / max`. Today's `BandsTile`
   divides by `max`.
2. **`ml-[60px]`.** The 1b spec names a 60px offset; the real value in `App.tsx` is
   `ml-[84px]`. Code wins.
3. **`SLA cap {n} d`.** `fallback_sla_days: 30` lives in `src/backend/config/policy.yaml`
   and is not exposed over the API. Since the backend is off-limits it becomes a
   frontend constant with a comment naming the YAML key as its source of truth.
4. **Graticule derives from real bounds.** The spec permits a fixed 120px cosmetic grid
   but conditions it: "if you fake it, do not label it with real coordinates." The edge
   ticks *do* carry real coordinates, so a fixed-pitch grid under real labels would read
   as a coordinate grid that lies. The graticule is drawn from the same bounds as the ticks.

## Invariants and how each is held

- **Violet is chrome only.** `ACCENT` moves cyan to violet in one place. The gauge ring,
  band meters and tower dots take band colour from `bandColor()`; nav pill, opacity
  slider, scrubber and the AOI button take violet. No warm hue on a control.
- **Both tower layers filter together.** `BandModule` writes to `useMapFilter` only. The
  existing effect in `MapView.tsx` already applies to `TOWER_LAYER_ID` and
  `TOWER_ICON_LAYER_ID` and keeps the `bandFilterRef` race fix. The caller changes, not
  the filter path.
- **Blur budget: 8 surfaces, ceiling `blur(14px) saturate(1.25)`.** A naive build counts
  11. The three status chips share one blurred container, and the drivers section merges
  into the band module's surface rather than taking its own. Back to 8. Nothing blurred
  animates. The vignette does the contrast work `backdrop-filter` would otherwise do.
- **No failure-probability language.** Copy verbatim from the spec.
- **Offline stays loud.** `OfflineBanner` still renders; the LIVE chip flips to OFFLINE
  in `--color-watch`.
- **Reticle and gauge ring are decorative.** Both `aria-hidden`; text carries the value.
  Pulse stops under `prefers-reduced-motion`.
- **Component classes stay in `@layer components`.** Pseudo-element rules stay unlayered,
  matching the existing file.

## Verification

No test runner exists in this frontend (`lint` is oxlint, `build` is `tsc -b && vite build`),
so verification is the handoff's own 13-item acceptance checklist, run manually and
reported with evidence rather than assertion.

Expected to cost real time: contrast of the bottom-left readout over the brightest
basemap patch (the spec pre-authorises a `text-shadow` fallback); behaviour with
`backdrop-filter` disabled; map-area measurement (full-bleed passes trivially, so the
honest number to report is unoccluded area); and `prefers-reduced-transparency`.

Commits follow the handoff order: tokens, shell, band controls + legend deletion,
inspector, AOI. `build` and `lint` run at each commit.
