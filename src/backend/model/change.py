"""One-sided satellite encroachment evidence; loss is not a maintenance need."""
from __future__ import annotations

import numpy as np
import pandas as pd

from model.maintenance_need import DATA_DIR

CHANGE_CSV = DATA_DIR / "land_change.csv"
CHANGE_COLUMN = "evi_delta_per_year"


def load_change() -> pd.DataFrame | None:
    """Absent or corrupt measurements stay unavailable on the serving path."""
    try:
        frame = pd.read_csv(CHANGE_CSV)
        if "tower_id" not in frame or frame.tower_id.isna().any() or frame.tower_id.duplicated().any():
            return None
        return frame
    except Exception:  # noqa: BLE001 — a bad artifact must not take the API down
        return None


def change_scores(tower_ids, change: pd.DataFrame | None = None) -> np.ndarray:
    """Per-tower encroachment rank in [0, 1]. Only GROWTH counts; absent is NaN."""
    ids = pd.Index(np.asarray(tower_ids))
    if change is None:
        change = load_change()
    if change is None or "tower_id" not in change or CHANGE_COLUMN not in change:
        return np.full(len(ids), np.nan)
    aligned = change.set_index("tower_id").reindex(ids)[CHANGE_COLUMN]
    delta = pd.to_numeric(aligned, errors="coerce").replace([np.inf, -np.inf], np.nan)
    return delta.clip(lower=0.0).rank(pct=True).to_numpy(dtype=float)
