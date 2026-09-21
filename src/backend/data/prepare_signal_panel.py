"""Producer: operator drive-test measurements -> a per-session-per-node panel.

Reads the published measurement archive in data/pilot_sunway/raw/mendeley/ and
writes data/pilot_sunway/signal_panel.csv, one row per (node, session), joined
to that node's environment from the tower feature table.

This is a producer like prepare_flood_surface.py — it writes into data/ and is
never a route. Run it once; model/signal_performance.py reads the output.

    python3 src/backend/data/prepare_signal_panel.py

WHY THIS EXISTS. The withdrawn maintenance classifier was trained on a label
that was a quantile cut of a deterministic function of its own features, so its
0.974 AUC measured arithmetic rather than prediction. This panel carries the
only genuinely observed labels in the project: 30,925 RSRP/SNR/CQI readings
taken by somebody else, for their own purposes, before this system existed.

AGGREGATION IS PER SESSION, NOT PER NODE. There are 86 nodes and 23 drive
sessions; collapsing straight to node would discard the only repeated measures
in the dataset and leave 86 points with no within-node variation at all.

TWO PROVENANCE FACTS THE MODEL DOWNSTREAM MUST NOT FORGET.

First, `link_distance_m` is computed from an *estimated* node position. The
archive README says node coordinates come from "signal centroid mapping",
subsequently "validated via OpenCellID and field inspections". Measured here,
the published positions sit a median ~100 m from both the unweighted and the
signal-weighted centroid of each node's own measurements, and neither is
systematically closer — so real correction happened and the positions are not a
pure restatement of the measurements. They are still estimates. Distance is
therefore a control variable measured with error, which under-controls path
loss and leaves some of it for correlated predictors to absorb. That is stated
again in signal_performance.py, where it changes how a result must be read.

Second, the archive is already cleaned. Its authors removed duplicates and
nulls, capped signal metrics against 3GPP TS 36.214, derived Mobility from
speed and assigned SessionID. This script does not re-clean any of that; it
aggregates. Re-cleaning clean columns would produce a panel nobody could
reconcile with the published dataset.

Reads processed_dataset.csv, the archive's analysis-ready table.
prepare_pilot_dataset.py reads raw_dataset.csv from the same directory for a
different job — extracting the 132 operator sites — so the two producers do not
overlap despite sharing a source.

Attribution: Kabeer, M., Nordin, R., Behjati, M. (2025), DOI
10.17632/dx5xyyfz2y.1, CC BY 4.0.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

_THIS_DIR = Path(__file__).resolve().parent
_BACKEND = _THIS_DIR.parent
sys.path.insert(0, str(_BACKEND))

from scheduler.optimize import haversine_km  # one haversine in this repo, not three

_DATA = _BACKEND.parent.parent / "data" / "pilot_sunway"
MEASUREMENTS_CSV = _DATA / "raw" / "mendeley" / "processed_dataset.csv"
FEATURE_TABLE_CSV = _DATA / "tower_feature_table.csv"
OUTPUT_CSV = _DATA / "signal_panel.csv"

# The archive's timestamps use dots, not dashes: 2024.12.03_15.52.02
TIMESTAMP_FORMAT = "%Y.%m.%d_%H.%M.%S"

# A node median over a handful of samples is noise, not a measurement.
#
# Set on measurement error, not tuned against a result. sigma(Level) is 11.1 dB
# and the standard error of a median over n samples is about 1.25*sigma/sqrt(n),
# so n=20 gives 3.1 dB against a between-node spread of roughly 11 dB — noise at
# ~27% of the signal being resolved. n=10 gives 4.4 dB, which is too much; n=30
# gives 2.5 dB but costs eight of the forty-eight usable nodes, and the binding
# constraint on this work is the number of CV groups, not per-row precision.
#
# The archive is very unevenly sampled (median 27 measurements per node, mean
# 360, max 6016), so this threshold decides how many nodes survive at all:
#   n>=10 -> 60 nodes   n>=20 -> 48 nodes   n>=30 -> 40 nodes   n>=50 -> 37
# signal_performance.py reports the fit at 20 and again at 30 as a sensitivity
# check, because a conclusion that only holds at one threshold is not one.
MIN_MEASUREMENTS_PER_NODE = 20

# Environment columns carried through from the feature table. Colocated rows
# (several operators on one mast) were verified to agree exactly on all of
# these, so taking the first row per node is unambiguous.
ENVIRONMENT_COLUMNS = [
    "lon",
    "lat",
    "hand_m",
    "slope_deg",
    "tri",
    "dist_water_m",
    "dist_power_m",
]


def _load_measurements() -> pd.DataFrame:
    if not MEASUREMENTS_CSV.exists():
        raise FileNotFoundError(
            f"measurement archive not found at {MEASUREMENTS_CSV}. It ships with the "
            "pilot dataset; run data/prepare_pilot_dataset.py to fetch it."
        )
    frame = pd.read_csv(MEASUREMENTS_CSV, low_memory=False)
    frame["ts"] = pd.to_datetime(frame["Timestamp"], format=TIMESTAMP_FORMAT, errors="coerce")
    return frame


def _node_environment() -> pd.DataFrame:
    """One environment row per node, keyed by the archive's Node id.

    tower_id embeds the node as its final underscore-separated field, which is
    how the feature table and the measurement archive join: 86 measured nodes,
    all present, against 132 tower rows (several operators share a mast).
    """
    feat = pd.read_csv(FEATURE_TABLE_CSV)
    feat["node"] = feat["tower_id"].str.rsplit("_", n=1).str[-1].astype(int)
    return feat.groupby("node", as_index=False)[ENVIRONMENT_COLUMNS].first()


def build_panel() -> pd.DataFrame:
    frame = _load_measurements()
    total = len(frame)

    frame = frame.dropna(
        subset=["Node", "Level", "Longitude", "Latitude", "Node_Longitude", "Node_Latitude", "ts"]
    )
    frame["node"] = frame["Node"].astype(int)

    # Distance from the handset to the node it was served by. The control
    # variable, computed here rather than assumed — but from an estimated node
    # position; see the module docstring.
    frame["link_distance_m"] = [
        haversine_km(lon, lat, nlon, nlat) * 1000.0
        for lon, lat, nlon, nlat in zip(
            frame["Longitude"],
            frame["Latitude"],
            frame["Node_Longitude"],
            frame["Node_Latitude"],
        )
    ]

    counts = frame.groupby("node").size()
    thin = counts[counts < MIN_MEASUREMENTS_PER_NODE].index
    frame = frame[~frame["node"].isin(thin)]

    def _mode(series):
        modes = series.mode()
        return modes.iat[0] if not modes.empty else ""

    panel = (
        frame.groupby(["node", "SessionID"])
        .agg(
            n_measurements=("Level", "size"),
            median_level_dbm=("Level", "median"),
            median_snr=("SNR", "median"),
            median_cqi=("CQI", "median"),
            link_distance_m=("link_distance_m", "median"),
            median_speed_kmh=("Speed", "median"),
            session_start=("ts", "min"),
            network_tech=("NetworkTech", _mode),
            operator=("Operatorname", _mode),
        )
        .reset_index()
    )

    panel = panel.merge(_node_environment(), on="node", how="inner", validate="many_to_one")
    # The node IS the physical site: several operators share one mast, and CV
    # must never split a mast across folds. 86 groups, against the 84 the
    # withdrawn notebook derived by rounding coordinates — this key is the
    # actual shared structure rather than a proxy for it.
    panel["physical_site_group"] = panel["node"]
    panel["session_ts"] = panel["session_start"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    panel = panel.drop(columns=["session_start"])

    print(f"measurements read          : {total}")
    print(f"nodes dropped (<{MIN_MEASUREMENTS_PER_NODE} obs)  : {len(thin)}")
    print(
        f"panel rows                 : {len(panel)}  "
        f"({panel.node.nunique()} nodes, {panel.SessionID.nunique()} sessions)"
    )
    return panel


def main() -> None:
    panel = build_panel()
    panel.to_csv(OUTPUT_CSV, index=False)
    print(f"wrote {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
