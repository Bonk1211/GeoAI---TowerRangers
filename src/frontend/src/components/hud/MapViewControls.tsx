import { MapIcon, TerrainIcon } from '../shell/icons';
import { useMap3D } from '../../state/useMap3D';

export function MapViewControls() {
  const is3D = useMap3D((s) => s.enabled);
  const setEnabled3D = useMap3D((s) => s.setEnabled);
  const exaggeration = useMap3D((s) => s.exaggeration);
  const stacked = useMap3D((s) => s.stacked);
  const setStacked = useMap3D((s) => s.setStacked);
  const spacing = useMap3D((s) => s.spacing);
  const setSpacing = useMap3D((s) => s.setSpacing);

  return (
    <section aria-label="Map view" className="pointer-events-auto shrink-0 rounded-xl border border-accent/25 bg-ink-900 p-3 shadow-[var(--shadow-2)]">
      <div className="mb-2 flex items-center justify-between gap-2 text-micro text-muted">
        <h2 className="eyebrow text-accent">Map view</h2>
        {is3D && !stacked && <span className="tnum">Heights ×{Math.round(exaggeration)}</span>}
        {stacked && <span>Ground & sky</span>}
      </div>
      <div role="group" aria-label="Map dimension" className="grid grid-cols-3 gap-1 rounded-lg bg-ink-950 p-1">
        <button
          type="button"
          aria-pressed={!is3D}
          onClick={() => setEnabled3D(false)}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-md text-ui font-medium transition-colors ${!is3D ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-overlay/[0.06] hover:text-fg'}`}
        >
          <MapIcon size={16} /> 2D map
        </button>
        <button
          type="button"
          aria-pressed={is3D && !stacked}
          onClick={() => setEnabled3D(true)}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-md text-ui font-medium transition-colors ${is3D && !stacked ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-overlay/[0.06] hover:text-fg'}`}
        >
          <TerrainIcon /> 3D terrain
        </button>
        <button
          type="button"
          aria-pressed={stacked}
          onClick={setStacked}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-md text-ui font-medium transition-colors ${stacked ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-overlay/[0.06] hover:text-fg'}`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />
          </svg>
          Stack layers
        </button>
      </div>
      {stacked && <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between text-micro text-muted">
          <label htmlFor="layer-spacing">Sky layer spacing</label>
          <span className="tnum">{Math.round(spacing / 90 * 100)}%</span>
        </div>
        <input id="layer-spacing" className="slider-hit" type="range" min={40} max={150} step={5}
          value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
        <p className="text-micro leading-relaxed text-dim">
          Land factors stay on the ground; rainfall sits above it. Move the pointer to trace the same
          location from ground to sky. Drag to pan; right-drag to rotate.
        </p>
        <p className="text-micro leading-relaxed text-dim">
          Sky spacing is for comparison, not measured altitude. Ground overlays share the map surface;
          use their opacity controls to compare them. Check source dates in each layer’s details.
        </p>
      </div>}
    </section>
  );
}
