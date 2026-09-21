import { useMapInstance } from '../../state/useMapInstance';
import { graticuleGeometry, scaleBar, formatCoord } from '../../lib/graticule';

// Where the edge labels sit. Shared with the projection so a line and its own
// label anchor to the same screen position — previously the lines were placed
// at true fractions while the labels were spread with `justify-between`, so the
// two only agreed when the first tick happened to land on the west edge.
const LON_LABEL_Y = 66;

/**
 * The non-interactive layer between the map canvas and the floating modules.
 *
 * Every element here is `pointer-events:none` — nothing in this file may
 * swallow a click meant for a tower.
 *
 * The graticule is drawn from the same bounds as the edge tick labels. A
 * fixed-pitch grid would have been cheaper, but the ticks carry real
 * coordinates, and a grid that does not line up with its own labels is a
 * coordinate readout that lies.
 */
export function MapOverlays() {
  const map = useMapInstance((s) => s.map);
  const view = useMapInstance((s) => s.view);
  const cursor = useMapInstance((s) => s.cursor);
  const labelInsetRight = (view?.size.width ?? 0) >= 1280 ? 504 : 432;

  // Projected rather than fractional, so the grid stays true under pitch. The
  // map is read for its projection only; nothing here writes to the store.
  const grid =
    map && view
      ? graticuleGeometry(
          view,
          (lon, lat) => {
            const p = map.project([lon, lat]);
            return { x: p.x, y: p.y };
          },
          view.size,
          LON_LABEL_Y,
          Math.max(0, view.size.width - labelInsetRight),
        )
      : { lon: [], lat: [] };

  const scale = view ? scaleBar(view.metresPerPixel) : null;
  const pitched = (view?.pitch ?? 0) > 1;

  return (
    <>
      {/* Graticule, projected onto the frame. Straight lines while the
             camera is flat; under pitch they converge toward the horizon,
             because that is where those meridians actually are. */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-hidden"
      >
        {[...grid.lon, ...grid.lat].map((line, i) =>
          line.points.length > 1 ? (
            <polyline
              key={`g-${i}-${line.value}`}
              points={line.points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke="rgba(13,21,38,.065)"
              strokeWidth={1}
            />
          ) : null,
        )}
      </svg>

      {/* A light edge fade leaves imagery and tower colours clear. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background:
            'radial-gradient(118% 90% at 50% 48%, transparent 64%, rgba(246,244,239,.4) 100%)',
        }}
      />

      {/* Longitude ticks, anchored where each meridian actually crosses the
          label row. Hidden outside the gutter so they never sit under the side
          modules — the constraint the old fixed insets encoded. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
        {grid.lon.map((line) =>
          line.labelAt &&
          line.labelAt.x > 340 &&
          line.labelAt.x < (view?.size.width ?? 0) - labelInsetRight ? (
            <div
              key={`lonlabel-${line.value}`}
              className="absolute flex -translate-x-1/2 flex-col items-center gap-1"
              style={{ left: `${line.labelAt.x}px`, top: `${LON_LABEL_Y}px` }}
            >
              <span className="h-1.5 w-px" style={{ background: 'rgba(13,21,38,.35)' }} />
              <span className="rounded bg-ink-900/90 px-1 font-mono text-eyebrow tnum text-muted" style={{ letterSpacing: '.04em' }}>
                {line.label}
              </span>
            </div>
          ) : null,
        )}
      </div>

      {/* Match the inspector's responsive width and leave room beside it. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
        {grid.lat.map((line) =>
          line.labelAt && line.labelAt.y > 200 && line.labelAt.y < (view?.size.height ?? 0) - 150 ? (
            <div
              key={`latlabel-${line.value}`}
              className="absolute flex -translate-y-1/2 items-center gap-1"
              style={{
                left: `${Math.max(0, (view?.size.width ?? 0) - labelInsetRight)}px`,
                top: `${line.labelAt.y}px`,
                transform: 'translate(-100%, -50%)',
              }}
            >
              <span className="rounded bg-ink-900/90 px-1 font-mono text-eyebrow tnum text-muted" style={{ letterSpacing: '.04em' }}>
                {line.label}
              </span>
              <span className="h-px w-1.5" style={{ background: 'rgba(13,21,38,.35)' }} />
            </div>
          ) : null,
        )}
      </div>

      {/* A local backplate keeps coordinates readable over dark imagery. */}
      <div
        className="pointer-events-none absolute bottom-5 left-5 z-20 flex items-center gap-3 rounded bg-ink-900/95 px-2 py-1 font-mono text-eyebrow text-fg"
      >
        <span className="tnum">
          {cursor ? formatCoord(cursor.lon, cursor.lat) : '—'}
        </span>
        {scale && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-[6px] border-x border-b"
              style={{ width: `${Math.round(scale.px)}px`, borderColor: 'rgba(13,21,38,.65)' }}
            />
            {/* Under pitch the ground stretches away from the camera, so one
                bar cannot describe the whole frame. The measurement is taken at
                the screen centre and the label says so rather than implying it
                holds everywhere. */}
            <span className="tnum">
              {scale.label}
              {pitched && <span className="text-dim"> at centre</span>}
            </span>
          </span>
        )}
      </div>
    </>
  );
}
