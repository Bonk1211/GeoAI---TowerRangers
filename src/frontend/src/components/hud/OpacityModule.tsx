import { useScoreOpacity } from '../../state/useScoreOpacity';
import { useFloodSurface } from '../../state/useFloodSurface';
import { useFloodStage } from '../../state/useFloodStage';
import { useMap3D, PITCH_RANGE } from '../../state/useMap3D';
import { FLOOD_STAGES_M, WATER_DEPTH_BANDS } from '../../lib/inundation';
import { EXAGGERATION_RANGE } from '../map/floodVolumeLayer';

/**
 * How loudly the scored towers draw over the basemap. Chrome, not data — the
 * track and thumb are violet; nothing here takes a band colour.
 */
export function OpacityModule() {
  const scoreOpacity = useScoreOpacity((s) => s.scoreOpacity);
  const setScoreOpacity = useScoreOpacity((s) => s.setScoreOpacity);
  const floodSurface = useFloodSurface((s) => s.floodSurface);
  const toggleFloodSurface = useFloodSurface((s) => s.toggleFloodSurface);
  const stage = useFloodStage((s) => s.stage);
  const is3D = useMap3D((s) => s.enabled);
  const stacked = useMap3D((s) => s.stacked);
  const pitch = useMap3D((s) => s.pitch);
  const setPitch = useMap3D((s) => s.setPitch);
  const exaggeration = useMap3D((s) => s.exaggeration);
  const setExaggeration = useMap3D((s) => s.setExaggeration);
  const pct = Math.round(scoreOpacity * 100);
  const pilotDepths =
    stage === null
      ? []
      : FLOOD_STAGES_M.filter((hand) => hand <= stage)
          .map((hand) => stage - hand)
          .sort((a, b) => a - b);

  return (
    <section className="glass-float rounded-xl p-[13px]">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <label htmlFor="score-opacity" className="text-micro text-muted">
          Score opacity
        </label>
        <span className="text-micro tnum text-fg">{pct}%</span>
      </div>
      <input
        id="score-opacity"
        className="slider-hit"
        type="range"
        min={10}
        max={100}
        step={1}
        value={pct}
        aria-valuetext={`${pct} percent`}
        onChange={(e) => setScoreOpacity(Number(e.target.value) / 100)}
      />

      {/* Shares this module rather than opening a fourth floating panel: both
          controls answer "how is the ground drawn", and each new glass surface
          spends part of the blur budget. */}
      <div className="mt-3 border-t border-overlay/[0.09] pt-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={floodSurface}
          onClick={toggleFloodSurface}
          className="flex w-full items-center justify-between gap-2 rounded-lg py-1 text-left"
        >
          <span className="text-micro text-muted">Flood exposure</span>
          <span
            aria-hidden="true"
            className={`relative h-[15px] w-[27px] shrink-0 rounded-full transition-colors ${
              floodSurface ? 'bg-accent' : 'bg-overlay/20'
            }`}
          >
            <span
              className={`absolute top-[2px] h-[11px] w-[11px] rounded-full bg-ink-900 shadow-sm transition-[left] ${
                floodSurface ? 'left-[14px]' : 'left-[2px]'
              }`}
            />
          </span>
        </button>
        <p className="mt-1.5 text-eyebrow leading-snug text-dim">
          Mean flood share per ~2 km cell. Cells with under two towers are not drawn.
        </p>
      </div>

      {/* The visible map switch owns 2D/3D; these are its advanced settings.
          The scenario card still owns the water-level control. */}
      {is3D && !stacked && (
        <div className="mt-3 border-t border-overlay/[0.09] pt-2.5">
          <h3 className="text-micro font-medium text-muted">3D view settings</h3>
          <div className="mt-2.5 flex items-baseline justify-between gap-2">
            <label htmlFor="map-pitch" className="text-micro text-muted">
              Tilt
            </label>
            <span className="text-micro tnum text-fg">{Math.round(pitch)}°</span>
          </div>
          <input
            id="map-pitch"
            className="slider-hit"
            type="range"
            min={PITCH_RANGE.min}
            max={PITCH_RANGE.max}
            step={1}
            value={Math.round(pitch)}
            aria-valuetext={`${Math.round(pitch)} degrees`}
            onChange={(e) => setPitch(Number(e.target.value))}
          />

          <div className="mt-2 flex items-baseline justify-between gap-2">
            <label htmlFor="map-exaggeration" className="text-micro text-muted">
              Vertical
            </label>
            <span className="text-micro tnum text-fg">×{Math.round(exaggeration)}</span>
          </div>
          <input
            id="map-exaggeration"
            className="slider-hit"
            type="range"
            min={EXAGGERATION_RANGE.min}
            max={EXAGGERATION_RANGE.max}
            step={1}
            value={Math.round(exaggeration)}
            aria-valuetext={`${Math.round(exaggeration)} times vertical exaggeration`}
            onChange={(e) => setExaggeration(Number(e.target.value))}
          />

          {/* Depth key. The columns carry depth in both height and colour, so
              without this the second channel is decoration. */}
          {stage !== null && (
            <div className="mt-2.5">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-micro text-muted">Banded scenario depth</span>
                <span className="text-eyebrow text-dim">minimum by stage bucket</span>
              </div>
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                {pilotDepths.map((depth) => (
                  <span key={depth} className="flex items-center gap-1 text-eyebrow tnum text-dim">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 rounded-[3px] border border-overlay/20"
                      style={{
                        backgroundColor: WATER_DEPTH_BANDS.find((band) => depth < band.max)
                          ?.color,
                      }}
                    />
                    {depth} m
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Never silent. 5 m of water across a 14 km AOI is 0.035% of the
              frame, so a readable 3D flood is always an exaggerated one, and
              the number that made it readable belongs on screen next to it. */}
          <p className="mt-1.5 text-micro leading-snug text-dim">
            Heights stretched ×{Math.round(exaggeration)}. Terrain and water share one factor;
            3D depth is the minimum for each HAND stage bucket.
            {stage === null && ' Choose a flood stage to see water.'}
          </p>
        </div>
      )}
    </section>
  );
}
