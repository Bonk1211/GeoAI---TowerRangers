# Tower Icon Layer — implementation plan

**Option A from the icon discussion: icon + coloured halo.** Tower PNG on top of a coloured circle. The circle carries every signal the current plain-circle layer carries (band colour, risk-scaled size, borderline ring); the icon is a visual layer on top of it, not a replacement for it.

**Owner: frontend.** One file mainly, [`towerLayer.ts`](../src/frontend/src/components/map/towerLayer.ts), plus a few lines in [`MapView.tsx`](../src/frontend/src/components/map/MapView.tsx).

---

## 0. Why halo-behind-icon, not just swap the layer type

Two constraints killed the simpler options:

1. **Scale.** 132 scored + 2000 unscored = 2132 features. A `symbol` layer renders that fine; it just can't carry a *continuous* size ramp scaled by risk the way `circle-radius` with an `interpolate` expression currently does ([towerLayer.ts:33](../src/frontend/src/components/map/towerLayer.ts#L33)) without it looking like scattered confetti at different sizes with no shape consistency.
2. **The PNG is not recolourable.** It's a photographic red/white render, not an SDF (signed-distance-field) icon. MapLibre can only tint SDF icons via `icon-color`. A raster PNG icon is always shown in its baked-in colours — so band colour (`maintain` orange / `watch` amber / `ok` green) **cannot live on the icon itself.**

So the coloured circle stays as the source of truth for band/risk/borderline, and the icon sits on top as a purely visual cue that these dots are towers. This is additive — nothing existing is removed.

---

## 1. Zoom gate — icons only at zoom ≥ 10

At national zoom (5–7), 2132 icons on screen is unreadable regardless of icon quality — it was already circles-only there and should stay that way. Icons appear once the map is zoomed into the AOI.

```ts
'icon-opacity': ['step', ['zoom'], 0, 10, 1],   // hidden below z10, visible at/above
```

Keep the existing circle halo visible at all zooms — it's the layer that currently makes the national "scalability" view work, and nothing here should touch that.

---

## 2. Asset

**Use the attached PNG.** Save it as:

```
src/frontend/public/brand/tower-icon.png
```

(sibling to the existing `mcmc-logo.png` already there — `ls src/frontend/public/brand/` confirms that directory exists and is the established location for image assets.)

No conversion needed for MapLibre to render it as a raster icon — SDF only matters if we want `icon-color` tinting, which per §0 we're deliberately not doing.

---

## 3. Load the image into the map

MapLibre requires images to be registered with `map.addImage()` before a `symbol` layer can reference them. Add inside the existing `map.on('load', ...)` handler in [`MapView.tsx`](../src/frontend/src/components/map/MapView.tsx), near where `TOWER_SOURCE_ID` and `TOWER_LAYER_ID` are currently set up:

```ts
map.loadImage('/brand/tower-icon.png', (err, image) => {
  if (err || !image) {
    console.error('tower icon failed to load', err);
    return;   // symbol layer below simply renders nothing extra — halo layer still works
  }
  if (!map.hasImage('tower-icon')) {
    map.addImage('tower-icon', image);
  }
});
```

**Order matters, but failure must not be fatal.** If the icon fails to load (bad path, network hiccup on a cold cache), the halo circles must keep working exactly as they do today — this is a decoration, not the core signal. Wrap it so a failure here can't throw and break map init, matching the existing pattern in this file where a failed basemap style degrades to a visible error banner rather than a blank map ([MapView.tsx](../src/frontend/src/components/map/MapView.tsx) — the `status === 'error'` block).

---

## 4. New symbol layer, added after the existing circle layer

In [`towerLayer.ts`](../src/frontend/src/components/map/towerLayer.ts), export a second layer spec alongside the existing `towerPaint`:

```ts
export const TOWER_ICON_LAYER_ID = 'towers-icon-layer';

export const towerIconLayout: SymbolLayerSpecification['layout'] = {
  'icon-image': 'tower-icon',
  'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.12, 15, 0.28],
  'icon-allow-overlap': true,     // dense clusters (e.g. Sunway) shouldn't drop icons silently
  'icon-ignore-placement': true,
};

export const towerIconPaint: SymbolLayerSpecification['paint'] = {
  'icon-opacity': ['step', ['zoom'], 0, 10, 1],
};
```

Register it in `MapView.tsx` immediately after the existing `TOWER_LAYER_ID` circle layer is added, referencing the **same source** (`TOWER_SOURCE_ID`) — no second data source, no duplicated `setData` calls:

```ts
map.addLayer({
  id: TOWER_ICON_LAYER_ID,
  type: 'symbol',
  source: TOWER_SOURCE_ID,
  layout: towerIconLayout,
  paint: towerIconPaint,
});
```

**Unscored towers should not get an icon.** They're the greyed national-scale layer, deliberately visually recessive. Filter them out of the icon layer alone (the halo circle layer keeps rendering them as today):

```ts
map.setFilter(TOWER_ICON_LAYER_ID, ['==', ['get', 'scored'], true]);
```

`scored` is already a property on every feature via [`towersToGeoJSON`](../src/frontend/src/components/map/towerLayer.ts#L9) — no data-shape change needed.

---

## 5. Click handling

Currently `map.on('click', TOWER_LAYER_ID, ...)` selects a tower ([MapView.tsx](../src/frontend/src/components/map/MapView.tsx)). Add the same handler bound to `TOWER_ICON_LAYER_ID` too, so clicking the icon (which visually sits on top of the circle) also selects the tower — otherwise a click that lands on icon pixels but misses the underlying circle's hit area does nothing, which reads as a broken map.

```ts
map.on('click', TOWER_ICON_LAYER_ID, (e) => { /* same body as the circle click handler */ });
map.on('mouseenter', TOWER_ICON_LAYER_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', TOWER_ICON_LAYER_ID, () => { map.getCanvas().style.cursor = ''; });
```

---

## 6. What stays exactly as-is

- `towerPaint` (the circle halo) — unchanged. Band colour, risk-scaled radius, borderline stroke all keep working exactly as today.
- The map-data race-condition fix already applied (`status === 'ready'` gating in `MapView.tsx`) — the new layer additions happen inside the same `load` handler block, so they're covered by that same fix. Nothing new to guard there.
- `bandFilter` (maintain/watch/ok filter from the bands legend) — must apply to **both** layers, not just the circle one, or filtering by band will hide halos but leave stray icons floating with no colour underneath them. One extra line where `setFilter` is currently called on `TOWER_LAYER_ID`.

---

## 7. Order of work

1. Save the PNG to `src/frontend/public/brand/tower-icon.png`.
2. `map.loadImage` + `addImage` in the load handler (§3), with the non-fatal error path.
3. Add `TOWER_ICON_LAYER_ID` layer spec to `towerLayer.ts` (§4).
4. Register the layer in `MapView.tsx` right after the circle layer, apply the `scored` filter.
5. Wire click/hover on the icon layer (§5).
6. Extend the existing `bandFilter` effect to also filter the icon layer (§6).
7. Verify.

---

## 8. Verify

- Zoom out to national view: **circles only**, no icons — confirms the zoom gate and confirms the unscored/national layer is untouched.
- Zoom into Sunway (≥ z10): each scored tower shows a coloured halo **with a tower icon centred on it**. Band colour still visibly distinguishes maintain/watch/ok — confirms the icon isn't obscuring the colour signal.
- Click an icon directly (not just the halo edge): drawer opens for that tower — confirms the layered click handler.
- Filter by band (maintain-only, say) via the legend: towers outside that band disappear **completely** — no bare icons left floating without their halo.
- Kill the icon file path temporarily (rename it) and reload: map still loads, halos still render, just no icons and one console error — confirms the icon load failure doesn't break the map.

---

## 9. Not in scope here

- Re-authoring the PNG as an SDF glyph for per-band tinting (option B from the earlier discussion) — deliberately deferred; halo carries colour instead.
- Any change to `towerPaint` radius/colour logic — untouched.
- Selected-tower highlight ring, if one exists elsewhere in the app — out of scope, this plan only adds the base icon layer.
