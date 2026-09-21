"""FastAPI app — scheduler surface (Backend_Handoff §6, step 7).

Owned here: /crews, /schedule/*. Also served from this app (Integration_Gaps
§5.1, step 3): /towers, /score, /stability — the scheduler backend serves the
ML routes so the frontend needs one base URL; the ML team keeps working in
notebooks. adapter/ml_source.py owns the CSV -> contract mapping.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

# Must run before any route module reads os.environ (tiles/ee_session.py's
# GEE_* vars, agent/runner.py's ANTHROPIC_API_KEY) — .gitignore already
# reserved src/backend/.env for exactly these two secrets, but nothing
# actually loaded it until now, so dropping a .env there silently did
# nothing and the missing-credentials error looked like a bad key rather
# than a bad setup. override=False (the default) so a real environment
# variable — CI, a container, an operator's shell — always wins over the
# file.
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import agent, backhaul, baseline, confluence, crews, fire, flood, integrations, land, maps, model, schedule, towers, travel
from tiles import preload, ee_session
from tiles.supabase_store import SupabaseMapStore


@asynccontextmanager
async def lifespan(app):
    previous_mode = ee_session.manual_only
    ee_session.manual_only = True
    service = None
    try:
        service = preload.MapPreloader(cloud=SupabaseMapStore.from_env())
        preload._service = service
        service.start()
        yield
    finally:
        if service:
            await asyncio.to_thread(service.close)
        preload._service = None
        ee_session.manual_only = previous_mode


app = FastAPI(title="Tower Maintenance Scheduler", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # competition prototype; tighten if this ever ships
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(crews.router)
app.include_router(towers.router)
# /model/health — no path conflict with any other router's prefix.
app.include_router(model.router)
# baseline registered before schedule: /schedule/baseline is a literal path
# that would otherwise be shadowed by schedule.router's /schedule/{run_id}
app.include_router(baseline.router)
app.include_router(schedule.router)
app.include_router(agent.router)
# /travel/legs — NOT under /schedule, which would shadow it behind
# /schedule/{run_id} exactly as /schedule/baseline once was.
app.include_router(travel.router)
# Earth Engine overlays. The catalogue answers with or without credentials; only
# /flood/tiles needs them, and it 503s with the reason rather than returning an
# empty layer.
app.include_router(flood.router)
# /land has no path overlap with anything above, so order is free here — unlike
# the baseline-before-schedule case.
app.include_router(land.router)
# /fire is in the same position: a third peer catalogue whose prefix collides
# with nothing. Its own two literal paths (/fire/tiles/{layer_id} and
# /fire/exposure) cannot shadow each other either, so there is no ordering
# trap inside the router the way /schedule/baseline has one.
app.include_router(fire.router)
# /backhaul is the fourth peer catalogue and the only one that never reaches
# Earth Engine — ITU serves the backbone from its own GeoServer. No prefix
# overlap, so order is free here too.
app.include_router(backhaul.router)
app.include_router(maps.router)
# /confluence has no path overlap with anything above. Read-only; the status
# route always answers, only /search and /pages/{id} need real credentials.
app.include_router(confluence.router)
# /integrations serves the agent's tool set for the Integrations page. Offline.
app.include_router(integrations.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


# --- Single-origin production serving (Railway) -----------------------------
#
# In development the browser talks to Vite, which proxies /api to this app and
# strips the prefix (see src/frontend/vite.config.ts). In a one-service deploy
# there is no Vite, so this app has to do both halves itself: answer the same
# /api-prefixed requests the built bundle sends, and serve that bundle.
#
# The prefix is stripped in middleware rather than by mounting a second app,
# because a mounted sub-app does not run its own lifespan — the map preloader
# in `lifespan` above would silently never start. Rewriting the path keeps one
# app, one lifespan, one router table, and leaves every route module's own
# prefix untouched.
#
# STATIC_DIR is the Vite build output copied into the image. When it is absent
# (any local checkout running `uvicorn api.main:app`) this whole block is inert
# and the app behaves exactly as before.
# Three of the frontend's client-side routes collide with real API paths —
# /health (the router below AND Railway's healthcheck), /integrations and
# /flood (the bundle's own PNGs live at /flood/*.png, while /flood/layers is a
# route). A browser navigating to one of them must get the app shell; the
# bundle asking for the same name under /api must get JSON. Both are resolved
# here rather than by route registration order, which cannot see the
# difference:
#
#   /api/<anything>  -> prefix stripped, routed as normal (JSON)
#   a real file      -> served from disk (wins over any route of that name)
#   anything else    -> index.html, so React Router owns the path
#
# Doing it in middleware, before routing, is what makes the file case win. It
# also keeps one app and one lifespan — a mounted sub-app does not run its own,
# so the map preloader in `lifespan` above would silently never start.
#
# STATIC_DIR is the Vite build copied into the image. Absent (any local
# checkout running `uvicorn api.main:app` against Vite) this is all inert and
# the app behaves exactly as before.
import os
import posixpath
from pathlib import Path

from fastapi.responses import FileResponse

STATIC_DIR = Path(os.getenv("FRONTEND_DIST", Path(__file__).resolve().parents[1] / "static"))
_STATIC_ROOT = STATIC_DIR.resolve() if STATIC_DIR.is_dir() else None


def _static_file(path: str) -> Path | None:
    """Resolve a URL path to a file inside STATIC_DIR, or None.

    posixpath.normpath collapses any `..` before the join, and the result is
    re-checked against the root, so a crafted path cannot escape the build
    directory and read the data/ or config/ trees sitting beside it.
    """
    if _STATIC_ROOT is None:
        return None
    relative = posixpath.normpath(path.lstrip("/"))
    if not relative or relative.startswith(("..", "/")):
        return None
    candidate = (_STATIC_ROOT / relative).resolve()
    if _STATIC_ROOT not in candidate.parents:
        return None
    return candidate if candidate.is_file() else None


@app.middleware("http")
async def serve_spa(request, call_next):
    path = request.scope["path"]

    if path.startswith("/api/") or path == "/api":
        # The prefix exists only so Vite knows what to forward in development;
        # the routers below never see it. Strip it and route as normal.
        request.scope["path"] = path[4:] or "/"
        return await call_next(request)

    if _STATIC_ROOT is not None and request.method in ("GET", "HEAD"):
        file = _static_file(path)
        if file is not None:
            return FileResponse(file)

        response = await call_next(request)
        # Only a genuinely unclaimed path becomes a client-side route. A 404
        # from a real API route (an unknown run_id, say) stays a 404, and a
        # missing /assets/*.js stays a 404 too — serving index.html there
        # returns HTML for a script request, which fails in the browser as a
        # MIME error that reads like a bundler bug.
        if response.status_code == 404 and not path.startswith("/assets/"):
            return FileResponse(_STATIC_ROOT / "index.html")
        return response

    return await call_next(request)
