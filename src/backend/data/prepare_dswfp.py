"""Daily Surface Water Fusion Process (DSWFP) over the Klang Valley.

HYDRAFloods' three-stage workflow: sample coincident SAR-optical acquisitions,
fit long-term surface-water harmonics from them, then predict water for a given
day by correcting the harmonic trend with recent observations.

What it buys over the single-date `edge_otsu` layer already in flood/layers.py
is gap-free daily water. Sentinel-1 revisits this latitude about every six days,
so `flood_extent` simply has no answer for most dates; DSWFP fills those gaps
from the harmonic model. That matters for monitoring. It matters much less for a
demo pinned to a date that has scenes.

Run it stage by stage — each stage consumes the asset the previous one wrote:

    python3 prepare_dswfp.py samples    --project <id>
    python3 prepare_dswfp.py harmonics  --project <id>
    python3 prepare_dswfp.py daily      --project <id> --date 2021-12-20

Every stage starts an Earth Engine BATCH EXPORT and returns immediately. Nothing
is displayable until the task finishes: stage 1 takes tens of minutes, stage 2
can take a day, stage 3 minutes to hours. `--wait` polls to completion; without
it the task keeps running server-side and `status` reports on it.

Producer-only. Nothing under api/ imports this, and earthengine-api/hydrafloods
stay in requirements-flood.txt so the app runs without them.

Setup:
    pip install -r ../requirements-flood.txt
    gcloud init && earthengine authenticate     # or a service account
    export GEE_PROJECT=<gcp-project-id>
    export GEE_DSWFP_ASSET_ROOT=projects/<gcp-project-id>/assets/dswfp
    earthengine --project "$GEE_PROJECT" create folder -p "$GEE_DSWFP_ASSET_ROOT"
"""

from __future__ import annotations

import argparse
import inspect
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime

# The AOI, and the single most important number in this file.
#
# NOT hf.country_bbox("Malaysia"). That returns the LSIB polygon's *bounds*, and
# Malaysia spans both the peninsula and Borneo — the box runs roughly 99..119 degE
# and 0.8..7.4 degN, swallowing Singapore, Brunei, much of Indonesia and a great
# deal of the South China Sea. On a workflow whose own documentation warns it can
# take days, that is the difference between an overnight run and an enormous one
# that is mostly ocean.
#
# This is the Klang Valley: Selangor and the federal territory, wide enough to
# carry the Klang basin that actually floods, and about 1/500th the area.
KLANG_VALLEY_BBOX = (100.95, 2.60, 101.95, 3.60)

# Stage 1 samples coincident SAR-optical pairs, so it needs a window long enough
# to collect them across seasons rather than a single event.
DEFAULT_SAMPLE_START = "2021-01-01"
DEFAULT_SAMPLE_END = "2021-12-31"

# Stage 2 fits interannual harmonics, so it wants years rather than months.
DEFAULT_HARMONIC_START = "2019-01-01"
DEFAULT_HARMONIC_END = "2022-01-01"

# SAR bands used to predict the optical water index, and the index predicted.
FEATURE_NAMES = ["VV", "VH", "ratio", "ndpi"]
TARGET_LABEL = "mndwi"

ASSET_ROOT_ENV = "GEE_DSWFP_ASSET_ROOT"
PROJECT_ENV = "GEE_PROJECT"

SAMPLES_ASSET = "fusion_samples"
HARMONICS_ASSET = "surface_water_harmonics"
DAILY_PREFIX = "daily_water"

POLL_SECONDS = 30


class DswfpError(RuntimeError):
    """Setup or Earth Engine failure, carrying what to do about it."""


def _import_ee():
    try:
        import ee
        import hydrafloods as hf
        from hydrafloods.workflows import dswfp
    except ImportError as error:
        raise DswfpError(
            f"Earth Engine dependencies are not installed ({error}). Run:\n"
            "  pip install -r src/backend/requirements-flood.txt\n"
            "  gcloud init && earthengine authenticate"
        ) from error
    _accept_obsolete_rescale(hf)
    return ee, hf, dswfp


def _accept_obsolete_rescale(hf) -> None:
    """Ignore the stale DSWFP ``rescale=`` argument in HYDRAFloods 2023.10.14."""
    original = hf.datasets.Dataset.__init__
    if "rescale" in inspect.signature(original).parameters or getattr(
        original, "_dswfp_rescale_compat", False
    ):
        return

    # ponytail: remove when HYDRAFloods stops passing this deleted keyword.
    def compatible(self, *args, rescale=None, **kwargs):
        return original(self, *args, **kwargs)

    compatible._dswfp_rescale_compat = True
    hf.datasets.Dataset.__init__ = compatible


def asset_root() -> str:
    root = os.environ.get(ASSET_ROOT_ENV, "").strip()
    if not root:
        raise DswfpError(
            f"{ASSET_ROOT_ENV} is not set. Point it at a folder you can write in "
            "Earth Engine, e.g.\n"
            "  export GEE_DSWFP_ASSET_ROOT=projects/<gcp-project-id>/assets/dswfp"
        )
    return root.rstrip("/")


def daily_asset_name(date: str) -> str:
    """`2021-12-20` -> HYDRAFloods base path `daily_water_20211220`.

    export_daily_surface_water appends `_water` to this base path. The reader's
    dswfp_asset_name() must include that suffix; a mismatch surfaces as a
    confusing 503 from Earth Engine.
    """
    parsed = datetime.strptime(date, "%Y-%m-%d")
    return f"{DAILY_PREFIX}_{parsed.strftime('%Y%m%d')}"


def _region(ee):
    return ee.Geometry.Rectangle(list(KLANG_VALLEY_BBOX))


def _initialise(project: str):
    ee, hf, dswfp = _import_ee()
    try:
        ee.Initialize(project=project)
    except Exception as error:
        raise DswfpError(
            f"Earth Engine failed to initialise for project {project!r}: {error}\n"
            "The project needs the Earth Engine API enabled and must be registered "
            "for Earth Engine access."
        ) from error
    return ee, hf, dswfp


def _tasks_before(ee) -> set:
    """Task ids that already exist, so a new one can be identified afterwards.

    The dswfp functions return None rather than a task handle, so the only way to
    monitor what they started is to diff the task list around the call.
    """
    return {task.id for task in ee.batch.Task.list()}


def _task_started(ee, before: set):
    for task in ee.batch.Task.list():
        if task.id not in before:
            return task
    return None


def _wait(task, label: str) -> None:
    if task is None:
        print(f"{label}: task started but could not be identified; check the EE Task Manager")
        return
    print(f"{label}: task {task.id} running — polling every {POLL_SECONDS}s")
    while True:
        status = task.status()
        state = status.get("state", "UNKNOWN")
        if state in ("COMPLETED", "FAILED", "CANCELLED"):
            if state == "COMPLETED":
                print(f"{label}: completed")
                return
            raise DswfpError(
                f"{label}: task {state} — {status.get('error_message', 'no message')}"
            )
        print(f"  {state} …")
        time.sleep(POLL_SECONDS)


def _report(task, label: str, note: str = "") -> None:
    task_id = task.id if task else "unknown"
    print(f"{label} — export started (task {task_id}){note}")


def stage_samples(args) -> None:
    ee, _, dswfp = _initialise(args.project)
    output = f"{asset_root()}/{SAMPLES_ASSET}"
    print(f"stage 1 — sampling SAR-optical pairs {args.start}..{args.end} -> {output}")

    before = _tasks_before(ee)
    # output_asset_path is the fourth POSITIONAL parameter, not a keyword with a
    # None default. The published Getting Started page passes None here, which
    # raises ValueError before anything is exported.
    dswfp.export_fusion_samples(
        _region(ee),
        args.start,
        args.end,
        output,
        stratify_samples=True,
    )
    task = _task_started(ee, before)
    if args.wait:
        _wait(task, "stage 1")
    else:
        _report(task, "stage 1", "; expect 30+ minutes")


def stage_harmonics(args) -> None:
    ee, _, dswfp = _initialise(args.project)
    root = asset_root()
    output = f"{root}/{HARMONICS_ASSET}"
    print(f"stage 2 — fitting harmonics {args.start}..{args.end} -> {output}")
    print("  this is the long one; the upstream docs say it can take days")

    before = _tasks_before(ee)
    dswfp.export_surface_water_harmonics(
        _region(ee),
        args.start,
        args.end,
        output,
        feature_names=FEATURE_NAMES,
        label=TARGET_LABEL,
        fusion_samples=f"{root}/{SAMPLES_ASSET}",
    )
    task = _task_started(ee, before)
    if args.wait:
        _wait(task, "stage 2")
    else:
        _report(task, "stage 2")


def stage_daily(args) -> None:
    ee, _, dswfp = _initialise(args.project)
    root = asset_root()
    output = f"{root}/{daily_asset_name(args.date)}"
    print(f"stage 3 — predicting water for {args.date} -> {output}_water")

    before = _tasks_before(ee)
    with _masked_daily_gaps(ee, dswfp):
        dswfp.export_daily_surface_water(
            _region(ee),
            args.date,
            # `harmonic_image`, not `harmonic_coefs` — the docs page names a
            # parameter this function does not have, and passing it is a TypeError.
            harmonic_image=ee.Image(f"{root}/{HARMONICS_ASSET}"),
            feature_names=FEATURE_NAMES,
            label=TARGET_LABEL,
            fusion_samples=f"{root}/{SAMPLES_ASSET}",
            look_back=args.look_back,
            # `include_confidence`, not `output_confidence`, for the same reason.
            include_confidence=True,
            # Adds a flood band — water beyond the long-term expectation. That is the
            # band this project actually wants: "water where water does not belong",
            # the same distinction flood_extent draws using JRC permanent water.
            include_flood=True,
            # HYDRAFloods appends `_water` to this base path.
            output_asset_path=output,
        )
    task = _task_started(ee, before)
    if args.wait:
        _wait(task, "stage 3")
    else:
        _report(task, "stage 3")


@contextmanager
def _masked_daily_gaps(ee, dswfp):
    """Keep unobserved days masked when HYDRAFloods reduces a daily collection.

    Its residual loop calls median() on days with no images, yielding no bands
    and failing Image.subtract. A masked band gives that day a schema without
    contributing a value or increasing the regression's observation count.
    """
    original = dswfp._fuse_dataset

    def fuse(region, start, end, *args, **kwargs):
        dataset = original(region, start, end, *args, **kwargs)
        start = ee.Date(start)
        days = ee.List.sequence(0, ee.Date(end).difference(start, "day").subtract(1))
        empty = ee.Image.constant(0).rename(kwargs["target_band"]).selfMask()
        padding = ee.ImageCollection.fromImages(days.map(
            lambda day: empty.set("system:time_start", start.advance(day, "day").millis())
        ))
        dataset.collection = dataset.collection.merge(padding)
        return dataset

    # ponytail: producer-only compatibility shim; remove when upstream handles empty days.
    dswfp._fuse_dataset = fuse
    try:
        yield
    finally:
        dswfp._fuse_dataset = original




def stage_status(args) -> None:
    ee, _, _ = _initialise(args.project)
    tasks = list(ee.batch.Task.list())[:15]
    if not tasks:
        print("no Earth Engine tasks found for this account")
        return
    print(f"{'state':<12} {'id':<26} description")
    for task in tasks:
        status = task.status()
        print(f"{status.get('state', '?'):<12} {task.id:<26} {status.get('description', '')}")


def parser() -> argparse.ArgumentParser:
    # Shared options live on a parent parser rather than only on the top-level
    # one, so they are accepted on BOTH sides of the subcommand. Declared only at
    # the top, `prepare_dswfp.py daily --project x` — the form this module's own
    # docstring uses — fails with "unrecognized arguments".
    #
    # The defaults are SUPPRESS rather than real values, because `parents=` gives
    # the subparser its own copy of each action: with an ordinary default, the
    # subparser would overwrite whatever the top-level parser had already parsed,
    # so `--project x daily` would silently lose the project. SUPPRESS leaves the
    # attribute unset when the flag is absent, so whichever side supplied it wins
    # and main() falls back to the environment.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--project", default=argparse.SUPPRESS,
        help=f"Google Cloud project id (default: ${PROJECT_ENV})",
    )
    common.add_argument(
        "--wait", action="store_true", default=argparse.SUPPRESS,
        help="poll until the export finishes",
    )

    result = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        parents=[common],
    )
    sub = result.add_subparsers(dest="stage", required=True)

    samples = sub.add_parser(
        "samples", parents=[common], help="stage 1 — export SAR-optical fusion samples"
    )
    samples.add_argument("--start", default=DEFAULT_SAMPLE_START)
    samples.add_argument("--end", default=DEFAULT_SAMPLE_END)
    samples.set_defaults(func=stage_samples)

    harmonics = sub.add_parser(
        "harmonics", parents=[common], help="stage 2 — export surface water harmonics"
    )
    harmonics.add_argument("--start", default=DEFAULT_HARMONIC_START)
    harmonics.add_argument("--end", default=DEFAULT_HARMONIC_END)
    harmonics.set_defaults(func=stage_harmonics)

    daily = sub.add_parser(
        "daily", parents=[common], help="stage 3 — export one day's surface water"
    )
    daily.add_argument("--date", required=True, help="YYYY-MM-DD")
    daily.add_argument(
        "--look-back", type=int, default=30,
        help="days of recent observations used to correct the trend (default: 30)",
    )
    daily.set_defaults(func=stage_daily)

    status = sub.add_parser("status", parents=[common], help="list recent Earth Engine tasks")
    status.set_defaults(func=stage_status)

    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    # SUPPRESS means the attribute may be absent entirely; resolve it here.
    args.project = getattr(args, "project", "") or os.environ.get(PROJECT_ENV, "").strip()
    args.wait = getattr(args, "wait", False)
    if not args.project:
        print(f"--project is required (or set {PROJECT_ENV})", file=sys.stderr)
        return 2
    if getattr(args, "date", None):
        try:
            datetime.strptime(args.date, "%Y-%m-%d")
        except ValueError:
            print(f"--date must be YYYY-MM-DD, got {args.date!r}", file=sys.stderr)
            return 2
    try:
        args.func(args)
    except DswfpError as error:
        print(f"dswfp failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
