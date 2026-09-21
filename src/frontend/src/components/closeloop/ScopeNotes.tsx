import { useEffect, useRef } from 'react';
import { ChevronDownIcon, InfoIcon } from '../shell/icons';

const LIMITS: [string, string][] = [
  ['No retraining happens here', 'Retraining is a manual notebook run. Nothing on this page changes the served model.'],
  ['Nothing is written to the ledger', 'The export produces records a human appends deliberately.'],
  ['Ticket state is in-memory', 'There is no ticket backend, so closing a ticket and reloading resets this corpus to the seeded fixtures.'],
  ['Attachments never leave the browser', 'Files picked on a ticket are read locally and are not uploaded anywhere.'],
];

/**
 * What this page does not do — kept complete, one click away.
 *
 * It used to sit fully open in the rail with an alert spine, which gave the
 * disclaimers more visual weight than the queue of towers actually waiting for
 * a human. Now it is a neutral header chip that opens a popover. A <details>
 * element, like the map's "Map tools", so it works with no JS state; Escape and
 * an outside click close it as a popover is expected to.
 */
export function ScopeNotes() {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      const el = ref.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        el.open = false;
        el.querySelector('summary')?.focus();
        return;
      }
      if (!el.contains(event.target as Node)) el.open = false;
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  return (
    <details ref={ref} className="group relative">
      <summary className="flex min-h-[34px] cursor-pointer list-none items-center gap-1.5 rounded-lg border border-overlay/12 bg-overlay/[0.04] px-3 text-ui font-medium text-muted transition-colors duration-150 hover:bg-overlay/[0.09] hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <InfoIcon size={14} />
        Read-only
        <span className="text-dim">· {LIMITS.length} limits</span>
        <span className="transition-transform group-open:rotate-180">
          <ChevronDownIcon />
        </span>
      </summary>
      <div className="absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-overlay/15 bg-ink-900 p-4 shadow-[var(--shadow-2)]">
        <p className="eyebrow mb-3">What this page does not do</p>
        <dl className="space-y-2.5">
          {LIMITS.map(([claim, detail]) => (
            <div key={claim}>
              <dt className="text-ui font-medium text-fg">{claim}</dt>
              <dd className="mt-0.5 text-micro leading-snug text-dim">{detail}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
