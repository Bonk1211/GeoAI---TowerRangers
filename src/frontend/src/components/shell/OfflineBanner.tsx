import { useOffline } from '../../state/useOffline';

// Step 7: always visible when any query has fallen back to fixture data.
// Silent fixture fallback is the single most dangerous bug in this app.
export function OfflineBanner() {
  const offline = useOffline((s) => s.offline);
  if (!offline) return null;

  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center justify-center gap-2 border-b border-watch/30 bg-watch/15 px-3 text-ui font-medium text-watch-ink"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-watch" />
      Showing sample data — the API is unreachable.
    </div>
  );
}
