import { PlayIcon } from '../shell/icons';

/**
 * Model-vintage scrubber.
 *
 * The API exposes exactly one model vintage — there is no historical series
 * behind this control. Rather than invent one, every year before the current
 * vintage renders dimmed and the range input is fixed at the only real value.
 * The sub-line says so in as many words. A scrubber that animated through
 * fabricated history would be the most convincing lie on the screen.
 */

const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const CURRENT_VINTAGE = '2026.1';
const CURRENT_YEAR = 2026;

const UNAVAILABLE = 'Only the current model vintage exists — no historical series is published.';

export function VintageScrubber() {
  const index = YEARS.indexOf(CURRENT_YEAR);
  const progress = (index / (YEARS.length - 1)) * 100;

  return (
    <section
      className="glass-float pointer-events-auto absolute bottom-5 left-[340px] right-[332px] z-20 rounded-[14px] px-[18px] py-[13px]"
      aria-label="Model vintage"
    >
      <div className="mb-3 flex items-baseline gap-3.5">
        <h2 className="eyebrow shrink-0">Model vintage</h2>
        <p className="min-w-0 flex-1 truncate font-mono text-micro text-dim">
          fuels + flood inputs rebuilt annually — only {CURRENT_VINTAGE} is published
        </p>
        <button
          type="button"
          aria-disabled="true"
          title={UNAVAILABLE}
          aria-label={`Step through model vintages — ${UNAVAILABLE}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-overlay/[0.12] text-muted opacity-45"
        >
          <PlayIcon />
        </button>
        <span className="shrink-0 font-mono text-ui tnum text-accent">{CURRENT_VINTAGE}</span>
      </div>

      <div className="relative h-[30px]">
        {/* Track. The input sits on top of it and carries the real semantics. */}
        <div className="pointer-events-none absolute inset-x-0 top-[5px] h-0.5 rounded-full bg-overlay/10" />
        <div
          className="pointer-events-none absolute left-0 top-[5px] h-0.5 rounded-full"
          style={{
            width: `${progress}%`,
            background:
              'linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-accent) 70%, transparent))',
          }}
        />

        <input
          type="range"
          min={0}
          max={YEARS.length - 1}
          step={1}
          value={index}
          readOnly
          aria-label="Model vintage"
          aria-valuetext={CURRENT_VINTAGE}
          title={UNAVAILABLE}
          className="absolute inset-x-0 top-0 h-8 opacity-0"
        />

        {/* Handle, drawn rather than relying on the disabled input's own thumb. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-accent"
          style={{
            left: `${progress}%`,
            border: '3px solid var(--color-ink-900)',
            boxShadow: '0 0 14px 2px color-mix(in srgb, var(--color-accent) 60%, transparent)',
          }}
        />

        <div className="absolute inset-x-0 top-[14px] flex justify-between">
          {YEARS.map((year) => {
            const available = year === CURRENT_YEAR;
            return (
              <div key={year} className="flex flex-col items-center gap-1" style={{ opacity: available ? 1 : 0.4 }}>
                <span className="h-3 w-px bg-[rgba(13,21,38,.28)]" />
                <span className="font-mono text-eyebrow tnum text-[#33415c]">{year}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
