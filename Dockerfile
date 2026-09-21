# One-service deploy: FastAPI serves the API and the built frontend from one
# origin, so there is no CORS, no VITE_API_BASE, and no second Railway service.
#
# Layout inside the image mirrors the repo, because the backend resolves data
# with Path(__file__).resolve().parents[3] (see scheduler/travel.py,
# model/flood_eval.py). Flattening src/backend into /app would silently point
# every data path at the wrong directory.

# --- stage 1: build the frontend -------------------------------------------
FROM node:22-slim AS frontend

WORKDIR /build
COPY src/frontend/package.json src/frontend/package-lock.json ./
RUN npm ci

COPY src/frontend/ ./
# VITE_API_BASE stays unset: the bundle calls the same-origin /api prefix,
# which api/main.py's strip_api_prefix middleware rewrites for the routers.
RUN npm run build


# --- stage 2: runtime -------------------------------------------------------
FROM python:3.12-slim AS runtime

# libgomp1 is LightGBM's OpenMP runtime. Without it `import lightgbm` raises
# and adapter/ml_source.py falls back to the physical noisy-OR index — the API
# still boots, the served model is simply absent, and nothing says so at
# startup. Installing it is cheaper than debugging that.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /repo

# requirements-dataset.txt is NOT optional here: lightgbm and scikit-learn both
# sit on the serving path (the Makefile's install target says the same).
# requirements-flood.txt is deliberately omitted — earthengine-api and
# hydrafloods are large, need Google credentials this deploy does not have, and
# every /flood and /land tile route already 503s with setup instructions when
# they are missing.
COPY src/backend/requirements.txt src/backend/requirements-dataset.txt ./deps/
RUN pip install -r deps/requirements.txt -r deps/requirements-dataset.txt

COPY src/backend/ ./src/backend/
COPY data/ ./data/

COPY --from=frontend /build/dist ./src/backend/static

# Routes import `api`, `scheduler`, `model` as top-level packages, so the
# working directory is src/backend — same as the documented local run.
WORKDIR /repo/src/backend

# Railway injects PORT. Shell form so it expands; 8001 matches the local default.
CMD uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8001}
