"""Road-network travel lookup — the real distance and drive time between two
points, when we have measured them.

Design: docs/superpowers/specs/2026-09-09-osrm-travel-matrix-design.md

WHAT THIS REPLACES

Every distance in this scheduler was `haversine_km * road_factor` and every
drive time `road_km / avg_speed_kmh`: a straight line on a sphere, scaled by
two constants. It is not a route, and it cannot represent a coastline. The
measured consequence, live on this dataset: eight Langkawi towers read as a
113 km drive from the Alor Setar depot against a 150 km crew limit, so the
solver dispatches a mainland crew to an island with no bridge.

THE THREE STATES, AND WHY TWO WERE NOT ENOUGH

  ROUTED      OSRM returned a route.       -> use it
  UNROUTABLE  OSRM ran and found NO road.  -> reject. NEVER falls back.
  (absent)    the pair was never computed. -> lookup() returns None, caller
                                              falls back to haversine

`UNROUTABLE` is a MEASUREMENT, not a gap. Collapsing it into "no data" is the
bug rather than the fix: falling back to haversine after OSRM has told you
there is no road discards the answer in favour of the guess it replaced. That
distinction is the entire reason this module exists, and it is why there is no
distance sanity bound anywhere in it — no threshold separates 84 km across the
Malacca Strait from 60 km up a trunk road, and the real bug is one of the
short ones.

NO NETWORK. OSRM runs once, offline, in data/prepare_travel_matrix.py; this
module only ever reads the artefact it produced. A checkout without that file
loads empty and every caller falls back, which is the behaviour the scheduler
had before this module existed.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

# Repo-root data/, alongside malaysia/ and pilot_sunway/.
DATA_DIR = Path(__file__).resolve().parents[3] / "data"
DEFAULT_MATRIX_PATH = DATA_DIR / "travel_matrix.npz"

ROUTED = 0
UNROUTABLE = 1

# Depot coordinates are floats read from crews.json and floats written by the
# producer; they must land on the same key. 5 dp is ~1.1 m, far finer than any
# depot's position is known and coarse enough to absorb float round-tripping.
_DEPOT_PRECISION = 5


def depot_key(lon: float, lat: float) -> str:
    """Matrix key for a crew depot.

    Keyed on position, not on crew_id, because 30 crews share 20 distinct
    depots — a crew-keyed matrix would store the same leg up to three times
    and let the copies drift.
    """
    return f"depot:{round(float(lon), _DEPOT_PRECISION)}:{round(float(lat), _DEPOT_PRECISION)}"


@dataclass(frozen=True)
class TravelResult:
    """One measured leg. `km`/`minutes` are None exactly when unroutable."""

    state: int
    km: float | None
    minutes: float | None
    via_ferry: bool

    @property
    def reachable(self) -> bool:
        return self.state == ROUTED


def write_matrix(
    path: Path,
    keys: Sequence[str],
    rows: Iterable[tuple[str, str, float, float, int, bool]],
    meta: dict[str, Any],
) -> int:
    """Write a matrix artefact. Used by the producer and by tests.

    Stored as COO (parallel index arrays) rather than a dense square: the
    solver only ever needs depot->tower plus tower->tower WITHIN one territory,
    which is 172,558 of the 1,401,856 cells a dense matrix would hold.
    """
    index = {k: i for i, k in enumerate(keys)}
    src: list[int] = []
    dst: list[int] = []
    km: list[float] = []
    minutes: list[float] = []
    state: list[int] = []
    ferry: list[bool] = []
    for a, b, d_km, d_min, st, vf in rows:
        src.append(index[a])
        dst.append(index[b])
        km.append(d_km)
        minutes.append(d_min)
        state.append(st)
        ferry.append(vf)

    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        keys=np.array(list(keys), dtype=object),
        src=np.array(src, dtype=np.int32),
        dst=np.array(dst, dtype=np.int32),
        km=np.array(km, dtype=np.float32),
        minutes=np.array(minutes, dtype=np.float32),
        state=np.array(state, dtype=np.uint8),
        via_ferry=np.array(ferry, dtype=bool),
        meta=np.array([json.dumps(meta)], dtype=object),
    )
    return len(src)


class TravelMatrix:
    """Loaded artefact. Immutable after load; safe to share across requests."""

    def __init__(
        self,
        pairs: dict[tuple[int, int], int] | None = None,
        km: np.ndarray | None = None,
        minutes: np.ndarray | None = None,
        state: np.ndarray | None = None,
        via_ferry: np.ndarray | None = None,
        key_index: dict[str, int] | None = None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        self._pairs = pairs or {}
        self._km = km
        self._minutes = minutes
        self._state = state
        self._ferry = via_ferry
        self._key_index = key_index or {}
        self.meta = meta or {}

    @classmethod
    def load(cls, path: Path | None = None) -> "TravelMatrix":
        """Read the artefact, or return an empty matrix if it is not there.

        A missing or unreadable file is a CONFIGURATION STATE, not an error —
        the same contract model/maintenance_need.py's load_booster() keeps. The
        scheduler must boot and serve on the fallback, because that is exactly
        what it did before this module existed.
        """
        path = path or DEFAULT_MATRIX_PATH
        try:
            with np.load(path, allow_pickle=True) as z:
                keys = [str(k) for k in z["keys"]]
                src = z["src"]
                dst = z["dst"]
                meta_raw = z["meta"]
                pairs = {
                    (int(a), int(b)): i for i, (a, b) in enumerate(zip(src, dst))
                }
                return cls(
                    pairs=pairs,
                    km=z["km"],
                    minutes=z["minutes"],
                    state=z["state"],
                    via_ferry=z["via_ferry"],
                    key_index={k: i for i, k in enumerate(keys)},
                    meta=json.loads(str(meta_raw[0])) if len(meta_raw) else {},
                )
        except (FileNotFoundError, OSError, KeyError, ValueError):
            return cls()

    @property
    def available(self) -> bool:
        return bool(self._pairs)

    @property
    def pair_count(self) -> int:
        return len(self._pairs)

    def lookup(self, from_key: str, to_key: str) -> TravelResult | None:
        """The measured leg, or None if this pair was never computed.

        Directional on purpose. OSRM tables are not symmetric — one-way roads
        and turn restrictions make A->B and B->A genuinely different — so a
        reverse hit would be a fabrication, not a saving.
        """
        i = self._key_index.get(from_key)
        j = self._key_index.get(to_key)
        if i is None or j is None:
            return None
        row = self._pairs.get((i, j))
        if row is None:
            return None
        st = int(self._state[row])
        if st == UNROUTABLE:
            return TravelResult(UNROUTABLE, None, None, bool(self._ferry[row]))
        return TravelResult(
            ROUTED,
            float(self._km[row]),
            float(self._minutes[row]),
            bool(self._ferry[row]),
        )

    def status(self) -> dict[str, Any]:
        """What is loaded, for /model-health-style reporting.

        Coverage is surfaced rather than assumed: a matrix built before a
        tower was added still serves every pair it does have, and the caller
        needs to be able to see that it is partial.
        """
        unroutable = int((self._state == UNROUTABLE).sum()) if self._state is not None else 0
        return {
            "available": self.available,
            "pairs": self.pair_count,
            "unroutable": unroutable,
            "osm_extract": self.meta.get("osm_extract"),
            "profile": self.meta.get("profile"),
            "built_at": self.meta.get("built_at"),
        }


_CACHE: TravelMatrix | None = None


def get_matrix(path: Path | None = None) -> TravelMatrix:
    """Process-wide singleton. Loaded once; the artefact never changes under a
    running process (regenerating it is an explicit offline act)."""
    global _CACHE
    if _CACHE is None:
        _CACHE = TravelMatrix.load(path)
    return _CACHE


def reset_cache() -> None:
    """Tests only."""
    global _CACHE
    _CACHE = None
