import { useEffect, useMemo, useState } from 'react';
import type { Tower } from './types';
import type { WeightVector } from '../lib/scorer';
import { AHP_WEIGHTS } from '../lib/scorer';
import { useTowersQuery, useScoreQuery } from './queries';
import { useOffline } from '../state/useOffline';
import { useMitigations } from '../state/useMitigations';
import { applyProtection } from '../lib/protection';
import { liveScoredTowers, liveTower } from '../lib/liveTowers';

const DEBOUNCE_MS = 300;

function weightsEqual(a: WeightVector, b: WeightVector): boolean {
  return a.flood === b.flood && a.power === b.power && a.terrain === b.terrain && a.equipment === b.equipment;
}

function useDebouncedWeights(weights: WeightVector): WeightVector | null {
  const [debounced, setDebounced] = useState<WeightVector | null>(
    weightsEqual(weights, AHP_WEIGHTS) ? null : weights,
  );

  useEffect(() => {
    if (weightsEqual(weights, AHP_WEIGHTS)) {
      setDebounced(null);
      return;
    }
    const timer = window.setTimeout(() => setDebounced(weights), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [weights.flood, weights.power, weights.terrain, weights.equipment]);

  return debounced;
}

// Single source of truth for "towers, re-scored by the current slider
// weights" — used by the map, drawer, and every Overview stat tile so they
// recolour together. Baseline weights read straight from the live /towers
// query; non-baseline weights call POST /score (server authoritative, step
// 6e), debounced ~300ms. If /score is unreachable, falls back to the
// client-side offline scorer (step 7) and flags the global offline banner.
export function useLiveTowers(weights: WeightVector): { towers: Tower[]; isLoading: boolean } {
  const towersQuery = useTowersQuery();
  const debouncedWeights = useDebouncedWeights(weights);
  const scoreQuery = useScoreQuery(debouncedWeights);
  const setOffline = useOffline((s) => s.setOffline);

  const atBaseline = debouncedWeights === null;
  const baseTowers = towersQuery.data ?? [];
  const mitigations = useMitigations((s) => s.applied);

  const scored = useMemo(() => {
    if (atBaseline) return baseTowers;
    if (scoreQuery.data) return scoreQuery.data;
    if (scoreQuery.isError || scoreQuery.data === null) {
      // /score unreachable — offline path, re-derive client-side.
      setOffline(true);
      return liveScoredTowers(weights);
    }
    // score request in flight — show baseline towers rather than stale data.
    return baseTowers;
  }, [atBaseline, baseTowers, scoreQuery.data, scoreQuery.isError, weights, setOffline]);

  // MODELLED PROTECTION rides on top of whichever path produced the scores, so
  // the map, the console modules and every stat tile recolour together — the
  // same reason weight re-scoring lives here rather than in each consumer.
  // `applyProtection` returns the input array unchanged when nothing is
  // protected, so the common case costs one key lookup and does not rebuild
  // the map's GeoJSON source.
  //
  // It runs AFTER the offline fallback deliberately: a protected tower must
  // still be a protected tower when the API drops, and re-scoring the fixture
  // population without the overlay would silently restore the served band
  // mid-demo.
  const towers = useMemo(
    () => applyProtection(scored, mitigations, weights),
    [scored, mitigations, weights],
  );

  return { towers, isLoading: towersQuery.isLoading };
}

export function useLiveTower(tower_id: string | null, weights: WeightVector): Tower | undefined {
  const { towers } = useLiveTowers(weights);
  const offline = useOffline((s) => s.offline);
  return useMemo(() => {
    if (!tower_id) return undefined;
    const found = towers.find((t) => t.tower_id === tower_id);
    if (found) return found;
    // Only reach for the fixture derivation when we are genuinely offline.
    // Doing it unconditionally silently resurrects fixture towers (MY_*) while
    // the API is up and healthy — fixture data on screen with no offline
    // banner, which is exactly the failure step 7 exists to prevent.
    if (!offline) return undefined;
    return liveTower(tower_id, weights);
  }, [towers, tower_id, weights, offline]);
}
