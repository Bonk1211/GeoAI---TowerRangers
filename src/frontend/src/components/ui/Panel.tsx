import { useId, type ReactNode } from 'react';
import { BrandMark } from '../shell/BrandMark';
import { NavPill } from '../shell/NavPill';
import { StatusChips } from '../shell/StatusChips';

interface PanelProps {
  children: ReactNode;
  /** Small uppercase label above the panel body. */
  title?: string;
  /** One short line under the body explaining provenance or a caveat. */
  footnote?: string;
  /** Band colour for the risk spine on the left edge. */
  spine?: string;
  /**
   * One or two sentences on what this panel is for, behind a "!" next to the
   * title. Answers "what am I looking at" without spending panel space on a
   * paragraph every reader only needs once.
   */
  hint?: string;
  className?: string;
}

/**
 * The one card in the system. Everything on a page is either a Panel or lives
 * inside one, which is what keeps five separately-built pages reading as a
 * single product.
 */
/**
 * The "!" affordance and its tooltip.
 *
 * Hover alone would not do: there is no hover on a touch screen and none from
 * a keyboard, so this is a real <button> and the tooltip shows on
 * group-focus-within as well as group-hover. It stays mounted at opacity 0
 * rather than being removed, so aria-describedby always resolves for a screen
 * reader whatever the pointer is doing.
 *
 * Anchored to the HEADING, not to the button. Anchoring to the button pushed
 * the tooltip off the right edge whenever the title was long — which is most
 * of them in the 340px rail. From the heading it always opens at the panel's
 * left padding and is width-capped to stay inside.
 *
 * Staying inside matters: `.spine` sets overflow:hidden to clip its 3px band
 * to the border radius, so anything escaping a spined panel is simply cut off.
 */
function Hint({ text }: { text: string }) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-label="What is this panel for?"
        aria-describedby={id}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-overlay/25 text-[10px] font-bold leading-none text-dim transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent group-hover:border-accent/60 group-hover:text-accent"
      >
        !
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-20 mt-1.5 w-[min(18rem,88%)] rounded-lg border border-overlay/15 bg-ink-900 px-3 py-2 text-micro font-normal normal-case leading-relaxed tracking-normal text-muted opacity-0 shadow-[var(--shadow-2)] transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </>
  );
}

export function Panel({ children, title, footnote, spine, hint, className = '' }: PanelProps) {
  return (
    <section
      className={`glass glass-sheen ${spine ? 'spine' : ''} rounded-xl p-4 ${className}`}
      style={spine ? ({ '--spine': spine } as React.CSSProperties) : undefined}
    >
      {title && (
        <h3 className="eyebrow group relative mb-3 flex items-center gap-1.5">
          <span className="min-w-0">{title}</span>
          {hint && <Hint text={hint} />}
        </h3>
      )}
      {children}
      {footnote && <p className="mt-3 text-micro leading-snug text-dim">{footnote}</p>}
    </section>
  );
}

interface PageHeaderProps {
  title?: string;
  /** What this screen is for, in one plain sentence. */
  subtitle?: string;
  leftContent?: ReactNode;
  children?: ReactNode;
}

/**
 * The console bar. One surface, two rows, on every route except the map.
 *
 * Row one is the navigation deck — brand, nav pill, status — and is laid out to
 * match the map console's floating modules position for position, so the pill
 * does not move as you navigate between routes. Row two is the page's own
 * title, subtitle and actions.
 *
 * The nav lives here rather than in a rail because the map route runs
 * full-bleed and cannot carry one; two navigation systems in one app was the
 * larger cost. Every page that already used PageHeader gets this for free.
 */
export function PageHeader({ title, subtitle, leftContent, children }: PageHeaderProps) {
  /*
   * The header is z-30, and it matters that this outranks every page's own
   * content.
   *
   * `relative` plus a z-index makes this a stacking context, so a popover
   * opened from inside the header — the schedule's filter menu, for one —
   * can never escape it: the popover's own z-40 is resolved against the
   * header's children, not against the page. The header must therefore sit
   * above anything a page can stack: sticky table headers, sticky hour axes,
   * boards. It was z-20, which TIED with the schedule's sticky hour axis and
   * then lost on DOM order, so the axis painted a band straight through the
   * open filter popover.
   */
  return (
    <header className="glass-raised glass-sheen relative z-30 shrink-0 border-x-0 border-t-0">
      <div className="flex items-center gap-4 px-5 pt-3">
        <BrandMark variant="inline" />
        <div className="mx-auto">
          <NavPill variant="inline" />
        </div>
        <StatusChips variant="inline" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pb-3.5 pt-3">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          {title && (
            <div className="min-w-0 mr-1">
              <h1 className="h-title text-lead">{title}</h1>
              {subtitle && <p className="mt-0.5 text-ui text-muted">{subtitle}</p>}
            </div>
          )}
          {leftContent}
        </div>
        {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}

type ButtonTone = 'primary' | 'ghost' | 'danger';

const TONES: Record<ButtonTone, string> = {
  primary:
    'border-accent/45 bg-accent/12 text-accent hover:bg-accent/22 hover:border-accent/70',
  ghost: 'border-overlay/12 bg-overlay/[0.04] text-muted hover:bg-overlay/[0.09] hover:text-fg',
  danger: 'border-alert/45 bg-alert/12 text-alert-ink hover:bg-alert/22 hover:border-alert/70',
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
}

export function Button({ tone = 'ghost', className = '', ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-[34px] items-center justify-center gap-2 rounded-lg border px-3.5 text-ui font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${TONES[tone]} ${className}`}
    />
  );
}

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  color?: string;
}

/** A single figure with its label. Used across the KPI strip and the tiles. */
export function Stat({ label, value, hint, color }: StatProps) {
  return (
    <div className="min-w-0">
      <div
        className="font-display text-title font-semibold leading-none tracking-tight tnum"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      <div className="eyebrow mt-1.5 truncate">{label}</div>
      {hint && <div className="mt-1 text-micro text-dim">{hint}</div>}
    </div>
  );
}
