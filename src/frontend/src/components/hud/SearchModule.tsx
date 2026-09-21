import { useEffect, useRef, useState } from 'react';
import { useMapInstance } from '../../state/useMapInstance';
import { SOUTHEAST_ASIA_BBOX } from '../map/basemap';

/**
 * Place search over the whole map, Google-Maps style.
 *
 * ponytail: OpenStreetMap's Nominatim by plain `fetch` — keyless, CORS-open,
 * and returns a bounding box per hit, so a result frames itself with
 * `fitBounds` instead of guessing a zoom. No geocoding SDK, no autocomplete
 * library. Nominatim asks for at most 1 request/second, which the 400ms
 * debounce plus a single in-flight request already satisfies.
 *
 * Results are biased to Southeast Asia but not restricted to it.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const VIEWBOX = `${SOUTHEAST_ASIA_BBOX[0]},${SOUTHEAST_ASIA_BBOX[3]},${SOUTHEAST_ASIA_BBOX[2]},${SOUTHEAST_ASIA_BBOX[1]}`;
const DEBOUNCE_MS = 400;

interface Hit {
  name: string;
  lon: number;
  lat: number;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
}

async function geocode(query: string, signal: AbortSignal): Promise<Hit[]> {
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=jsonv2&limit=5&viewbox=${VIEWBOX}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Search unavailable (${res.status})`);
  const raw: { display_name: string; lon: string; lat: string; boundingbox: string[] }[] =
    await res.json();
  return raw.map((r) => {
    // Nominatim orders boundingbox as [south, north, west, east].
    const [south, north, west, east] = r.boundingbox.map(Number);
    return {
      name: r.display_name,
      lon: Number(r.lon),
      lat: Number(r.lat),
      bbox: [west, south, east, north],
    };
  });
}

export function SearchModule() {
  const map = useMapInstance((s) => s.map);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setHits(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      geocode(q, controller.signal)
        .then((results) => {
          setHits(results);
          setError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // Surfaced, never swallowed: an empty dropdown would read as "no
          // such place" when the real answer is "we could not ask".
          setError(err instanceof Error ? err.message : 'Search failed');
          setHits(null);
        })
        .finally(() => setBusy(false));
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  // Dismiss the dropdown on an outside click, the way a search box behaves.
  useEffect(() => {
    if (!hits && !error) return;
    function onDown(e: PointerEvent) {
      if (!boxRef.current?.contains(e.target as Node)) {
        setHits(null);
        setError(null);
      }
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [hits, error]);

  function go(hit: Hit) {
    if (!map) return;
    const [west, south, east, north] = hit.bbox;
    // A point of interest comes back with a degenerate box; fly to it instead
    // of fitting a zero-area rectangle, which pins MapLibre at max zoom.
    if (east - west < 0.002 || north - south < 0.002) {
      map.flyTo({ center: [hit.lon, hit.lat], zoom: 14, duration: 900 });
    } else {
      map.fitBounds([west, south, east, north], { padding: 48, duration: 900 });
    }
    setQuery(hit.name.split(',')[0]);
    setHits(null);
  }

  return (
    <div ref={boxRef} className="relative w-[268px]">
      <form
        className="glass-float flex items-center gap-1.5 rounded-xl p-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (hits?.length) go(hits[0]);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search places"
          aria-label="Search places"
          className="h-[30px] flex-1 rounded-[8px] border border-overlay/[0.11] bg-overlay/[0.04] px-2.5 text-[11.5px] text-fg placeholder:text-dim focus:border-accent/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!hits?.length}
          className="h-[30px] rounded-[8px] bg-accent/25 px-2.5 text-[11.5px] font-medium text-accent disabled:opacity-45"
        >
          {busy ? '…' : 'Go'}
        </button>
      </form>

      {(hits || error) && (
        <div
          className="glass-float absolute bottom-[46px] left-0 w-full overflow-hidden rounded-xl p-1"
          aria-live="polite"
        >
          {error ? (
            <p role="alert" className="px-2 py-1.5 text-[10.5px] text-dim">
              {error}
            </p>
          ) : hits && hits.length === 0 ? (
            <p className="px-2 py-1.5 text-[10.5px] text-dim">No match.</p>
          ) : (
            hits?.map((hit) => (
              <button
                key={`${hit.lon},${hit.lat}`}
                type="button"
                onClick={() => go(hit)}
                className="block w-full truncate rounded-[8px] px-2 py-1.5 text-left text-[11px] text-muted hover:bg-overlay/[0.06] hover:text-fg"
                title={hit.name}
              >
                {hit.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
