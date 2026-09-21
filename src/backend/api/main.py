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
