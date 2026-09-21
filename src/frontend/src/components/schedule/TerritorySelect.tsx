import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useCrewsQuery } from '../../api/queries';
import { CREWS } from '../../fixtures/crews';
import { useScheduleStore } from '../../state/useScheduleStore';

/**
 * Territories with scored work behind them. `GET /towers` serves 132 Sunway
 * towers only (`adapter/ml_source.py`) — the pilot dataset is Sunway /
 * Selangor alone. Placeholder-ness in `crews.json` is the wrong predicate
 * (Kelantan carries five real crews and still has nothing scored), so this
 * is named for what actually gates a territory: whether there is scored work
 * to schedule against it. One set, so enabling a territory later is a
 * one-line change here instead of a predicate rewritten in four components.
 */
const TERRITORIES_WITH_SCORED_WORK = new Set(['Selangor']);

const NO_SCORED_WORK_TITLE =
  'No scored towers in this territory — the pilot dataset covers Sunway/Selangor only.';

/**
 * Territory picker for the Schedule PageHeader. Replaces the
 * `territory === 'Selangor'` filter hardcoded across four components with
 * one store field (`useScheduleStore().territory`).
 *
 * The roster is derived from live crew data at render time, never a
 * hardcoded list — `crews.json` actually carries 16 territories, not the 15
 * once assumed, and counting them by hand would drift again the next time a
 * crew is added. Offline, `CREWS` (the fixture) only covers 4 territories;
 * that shorter list is correct and honest rather than padded out to a full
 * roster the fixture cannot back.
 *
 * The popover is a `role="group"` button list (same contract as
 * `ViewToggle`), not a `role="listbox"` — a listbox role obligates arrow-key
 * roving tabindex and `aria-activedescendant`, none of which this
 * implements, and `role="option"` overrides the button's native role so a
 * screen reader stops announcing "button — press Enter". Plain buttons in a
 * group keep every option in the natural Tab order with its native
 * semantics intact. It still owns real popover behaviour a native `<select>`
 * cannot express per-option: Escape and an outside click both close it,
 * closing returns focus to the trigger whenever the panel still held it
 * (`setOpen(false)` alone would unmount whichever button had focus and drop
 * focus to `<body>`) while leaving focus alone when an outside click already
 * moved it somewhere deliberate, and Tab /
 * Shift+Tab cycle within the panel's own buttons instead of escaping into
 * the page behind it while the popover is open.
 *
 * Options outside `TERRITORIES_WITH_SCORED_WORK` use `aria-disabled` rather
 * than the `disabled` attribute — same call as the AOI-tools model-vintage
 * scrubber (`components/hud/VintageScrubber.tsx`) — because `disabled`
 * removes an element from the tab order, leaving a keyboard user unable to
 * reach the option or its explanation. `title` alone does not reach that
 * user reliably (not surfaced on keyboard focus in Firefox, not always
 * announced by a screen reader, never shown on touch), so the explanation is
 * folded into the accessible name too via `aria-label`. Activating a
 * disabled option is a no-op.
 */
export function TerritorySelect() {
  const territory = useScheduleStore((s) => s.territory);
  const setTerritory = useScheduleStore((s) => s.setTerritory);
  const crewsQuery = useCrewsQuery();
  const crews = crewsQuery.data ?? CREWS;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const territories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const crew of crews) {
      counts.set(crew.territory, (counts.get(crew.territory) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [crews]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const selectTerritory = (name: string) => {
    if (!TERRITORIES_WITH_SCORED_WORK.has(name)) return;
    setTerritory(name);
    close();
  };

  useEffect(() => {
    if (!open) return;

    // First option gets initial focus so Tab/Shift+Tab below has a starting
    // point inside the panel rather than nowhere.
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();

    const handlePointerDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (e.target === triggerRef.current) return;
      // Only reclaim focus if the panel still held it. A click that lands on
      // something focusable should keep the focus the user just aimed at, but
      // a click on inert chrome would otherwise unmount the focused option and
      // drop focus to <body> — the same defect close() exists to prevent.
      if (panelRef.current?.contains(document.activeElement)) close();
      else setOpen(false);
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusables = panelRef.current.querySelectorAll<HTMLButtonElement>('button');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-[34px] min-w-[152px] items-center justify-between gap-2 rounded-lg border border-overlay/10 bg-overlay/[0.04] px-3 text-ui text-fg focus:border-accent/45 focus:outline-none focus:ring-1 focus:ring-accent/45"
      >
        <span className="truncate">{territory}</span>
        <span aria-hidden="true" className="text-dim">
          ▾
        </span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="group"
          aria-label="Territory"
          onKeyDown={trapTab}
          className="scroll-thin absolute right-0 top-[calc(100%+6px)] z-50 max-h-80 w-64 overflow-y-auto rounded-xl border border-overlay/15 bg-ink-900 p-1.5 shadow-[var(--shadow-3)]"
        >
          <div className="flex items-center justify-between border-b border-overlay/10 px-2.5 py-1.5">
            <span className="eyebrow text-dim">Select Territory</span>
            <span className="text-eyebrow text-muted font-medium">Pilot: Selangor</span>
          </div>

          <div className="py-1">
            {territories.map(([name, count]) => {
              const enabled = TERRITORIES_WITH_SCORED_WORK.has(name);
              const active = name === territory;
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={active}
                  aria-disabled={!enabled}
                  title={enabled ? undefined : NO_SCORED_WORK_TITLE}
                  // aria-label REPLACES the button's content for a screen
                  // reader, so it has to carry the crew count too — otherwise
                  // 15 of the 16 rows lose the one figure the row exists to
                  // show.
                  aria-label={enabled ? undefined : `${name}, ${count} crews — ${NO_SCORED_WORK_TITLE}`}
                  onClick={() => selectTerritory(name)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-150 ${
                    active
                      ? 'bg-accent/15 font-medium text-accent'
                      : enabled
                        ? 'cursor-pointer text-fg hover:bg-overlay/[0.08]'
                        : 'cursor-not-allowed text-dim/60 opacity-60 hover:bg-transparent'
                  }`}
                >
                  <div className="flex items-center gap-1.5 truncate">
                    {active && (
                      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    )}
                    <span className="truncate">{name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!enabled && (
                      <span className="rounded bg-overlay/[0.06] px-1 py-0.5 text-[9.5px] text-dim">
                        no data
                      </span>
                    )}
                    <span className="tnum text-eyebrow text-dim">{count}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
