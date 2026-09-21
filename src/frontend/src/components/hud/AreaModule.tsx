import type { Map as MaplibreMap } from 'maplibre-gl';
import { areaCounts } from '../../lib/aggregate';
import { useMapFilter } from '../../state/useMapFilter';
import { useMapInstance } from '../../state/useMapInstance';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { isScored } from '../../fixtures/towers';
import { boundsOf } from '../../lib/geo';
import { COLORS, INK_COLORS } from '../../lib/colors';
import type { Tower } from '../../api/types';

/** Never zoom past this. Two towers 400 m apart span almost nothing, so an
 *  unbounded fit would drop a two-tower territory like Perlis into street
 *  zoom. 11 is the AOI zoom this console is read at, and it sits below the
 *  12.5 gate where tower icons fade in, so a framed territory stays as the
 *  coloured dots the band ramp is designed for. */
const MAX_FRAME_ZOOM = 11;

/**
 * Keep the framed extent clear of the floating chrome.
 *
 * The console is full-bleed and its modules sit ON the map, so fitting to the
 * raw canvas centres a territory underneath this very panel. These are the
 * measured footprints: the left column is 300 px at a 20 px offset, the top bar
 * ends near 104 px, the selection panel holds the right, and the vintage
 * scrubber holds the bottom.
 */
const FRAME_PADDING = { top: 130, bottom: 150, left: 340, right: 320 };

function framePadding(map: MaplibreMap) {
  // Padding larger than the canvas makes fitBounds solve for a negative
  // viewport. Clamp each side to a share of the canvas so a narrow window
  // degrades to a looser fit instead of an exception.
  const { width, height } = map.getCanvas().getBoundingClientRect();
  return {
    top: Math.min(FRAME_PADDING.top, height * 0.2),
    bottom: Math.min(FRAME_PADDING.bottom, height * 0.2),
    left: Math.min(FRAME_PADDING.left, width * 0.3),
    right: Math.min(FRAME_PADDING.right, width * 0.3),
  };
}

function frameTowers(map: MaplibreMap | null, towers: Tower[]) {
  if (!map) return;
  const box = boundsOf(towers.filter(isScored));
  if (!box) return;
  // MapLibre honours prefers-reduced-motion by default
  // (respectPrefersReducedMotion), so this animation becomes an instant jump
  // for anyone who asked for that — no branch needed here.
  map.fitBounds(
    [
      [box.west, box.south],
      [box.east, box.north],
    ],
    { padding: framePadding(map), maxZoom: MAX_FRAME_ZOOM, duration: 900 },
  );
}

/**
 * Filter the map to one territory.
 *
 * The console now serves all 1,164 towers OpenStreetMap has in Malaysia rather
 * than the 132 inside the Sunway pilot box, and at national extent the map is
 * legible but not selective — a planner works one territory at a time. This is
 * the control for that, and it composes with the band rows above rather than
 * replacing them: picking Sarawak and then Maintain shows Sarawak's maintain
 * set, because MapView ANDs the two.
 *
 * Filtering here hides towers; it does not re-score them. That is the whole
 * distinction from AoiModule, which sends the viewport to POST /score and gets
 * bands re-cut for that extent. Both are "area" controls answering different
 * questions, so the copy at the foot says which one this is.
 *
 * The leading number is the MAINTAIN count, not the territory total, because
 * that is also the sort key — leading with the total made the column read as
 * unsorted (232, 188, 78, 80, 148...) while the rows were in fact correctly
 * ordered by work outstanding. The total sits on the right, muted, so both
 * numbers are present and the one that explains the order is the loud one.
 */
export function AreaModule() {
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const areas = areaCounts(towers);
  const areaFilter = useMapFilter((s) => s.areaFilter);
  const toggleAreaFilter = useMapFilter((s) => s.toggleAreaFilter);
  const map = useMapInstance((s) => s.map);

  /**
   * Filter and frame in one gesture. Deliberately in the click handler rather
   * than an effect on `areaFilter`: useLiveTowers hands back a new array
   * identity on most renders, so an effect that needed the towers to compute
   * the box would either re-fly the camera on unrelated renders or need a ref
   * to dodge its own dependencies. A handler already knows both the next
   * filter and the current towers.
   *
   * Clearing frames the whole country, symmetrically — otherwise dismissing a
   * filter leaves you zoomed into one state looking at every tower in Malaysia,
   * most of them off screen.
   */
  const pickArea = (territory: string) => {
    const next = areaFilter === territory ? null : territory;
    toggleAreaFilter(territory);
    frameTowers(map, next ? towers.filter((t) => t.territory === next) : towers);
  };

  const maxTotal = Math.max(...areas.map((a) => a.total), 1);
  // A single-territory table has nothing to filter — this is what keeps the
  // module off screen when the backend falls back to the Sunway pilot table.
  if (areas.length < 2) return null;

  return (
    <section className="glass-float rounded-xl p-[13px]" aria-label="Area">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h2 className="eyebrow">Area</h2>
        <span className="font-mono text-[10px] text-dim">
          {areaFilter ?? `${areas.length} territories`}
        </span>
      </div>

      <div className="scroll-thin max-h-[188px] overflow-y-auto pr-0.5">
        {areas.map((a) => {
          const active = areaFilter === a.territory;
          const dimmed = areaFilter !== null && !active;
          return (
            <button
              key={a.territory}
              type="button"
              aria-pressed={active}
              onClick={() => pickArea(a.territory)}
              className={`mb-[7px] flex min-h-[30px] w-full items-center gap-[9px] rounded-md px-1.5 text-left transition-opacity duration-150 ${
                dimmed ? 'opacity-45' : 'opacity-100'
              } ${active ? 'bg-overlay/[0.08]' : 'hover:bg-overlay/[0.05]'}`}
            >
              {/* INK_COLORS, not COLORS: this is text, and the fill ramp only
                  clears 3:1. bandColor() driving a `color:` property is a bug
                  in this codebase. Zero is muted rather than coloured, so a
                  territory with no outstanding work does not read as a band. */}
              <span
                className="w-[22px] shrink-0 text-left text-[11px] tnum"
                style={{ color: a.maintain ? INK_COLORS.maintain : 'var(--color-dim)' }}
              >
                {a.maintain}
              </span>
              <span className="h-[5px] flex-1 overflow-hidden rounded-full bg-overlay/[0.07]">
                {/* Total is the track, maintain is the fill: the bar reads as
                    "how much of this territory needs a crew" rather than as a
                    second copy of the size number already printed beside it. */}
                <span
                  className="block h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${(a.total / maxTotal) * 100}%`,
                    backgroundColor: 'rgba(13,21,38,0.22)',
                  }}
                >
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${a.total ? (a.maintain / a.total) * 100 : 0}%`,
                      backgroundColor: COLORS.maintain,
                    }}
                  />
                </span>
              </span>
              <span className="w-[74px] shrink-0 truncate text-[11px] text-muted">
                {a.territory}
              </span>
              <span className="w-[26px] shrink-0 text-right text-[11px] tnum text-dim">
                {a.total}
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-2 border-t border-overlay/[0.09] pt-2 text-[10.5px] leading-snug text-dim">
        Maintain count, then total. Picking a territory hides the rest and frames
        it; scores and bands stay national — use AOI below to re-score a viewport.
      </p>
    </section>
  );
}
