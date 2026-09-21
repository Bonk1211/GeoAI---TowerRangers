.PHONY: dev stop backend frontend install

# Both ends pin the same LITERAL address rather than trusting name resolution.
#
# `localhost` resolves to ::1 (IPv6) before 127.0.0.1 here, uvicorn's default
# bind is IPv4-only, and Vite serves on [::1] — so the browser looks up
# localhost, gets ::1, finds nothing listening, and every request fails. curl
# keeps working because it falls back to IPv4, which is what makes this look
# like a frontend bug for an hour. It hits every route, not one page.
#
# Measured, not assumed: `uvicorn --host ::` does NOT fix it. On this platform
# it binds IPv6 only and 127.0.0.1 then answers nothing, trading one broken
# stack for the other. Serving both would need two workers or a proxy, which is
# more moving parts than agreeing on an address.
#
# 8001, not 8000. 8000 is the default for uvicorn, FastAPI, Django and half the
# tutorials, so it is the most contested port on a developer machine — and it
# was already held here by an unrelated project serving `app.main:app`, which
# meant this app's requests reached a stranger's API and came back 404 instead
# of refusing the connection. A wrong answer is slower to debug than no answer.
# 8001 is not special; it is merely not 8000.
#
# Override any of these: make dev BACKEND_PORT=8000
# Vite gives process env priority over .env files (verified with loadEnv), so
# API_BASE set here wins over a developer's src/frontend/.env.local rather than
# being silently ignored by it.
BACKEND_HOST ?= 127.0.0.1
BACKEND_PORT ?= 8001
API_BASE     ?= http://$(BACKEND_HOST):$(BACKEND_PORT)
# Install and serve from one environment, independent of the shell's PATH.
# venv layout differs by platform: POSIX puts the interpreter at bin/python,
# Windows at Scripts/python.exe. Resolved in shell, not via $(wildcard) —
# make's wildcard splits its argument on whitespace before globbing, so a
# CURDIR containing a space (e.g. "Project (Comp)") silently matches nothing
# and BACKEND_PYTHON resolves empty.
BACKEND_PYTHON ?= $(shell [ -x "$(CURDIR)/src/backend/.venv/bin/python" ] && echo "$(CURDIR)/src/backend/.venv/bin/python" || echo "$(CURDIR)/src/backend/.venv/Scripts/python.exe")

# ponytail: `wait` + trap, no procfile runner dependency
dev:
	@trap 'kill 0' INT TERM; $(MAKE) backend & $(MAKE) frontend & wait

# Kills only THIS checkout's processes, and never "whatever holds $$(BACKEND_PORT)".
# A sibling project was found serving `app.main:app` on 8000 during development,
# and a stop target that frees a port by killing its owner would have taken down
# someone else's server without saying so. The backend is matched on
# `api.main:app` — a sibling's is `app.main:app`, so the two do not collide —
# and the frontend on this checkout's own vite path, which is why $(CURDIR) is
# used rather than a bare `vite`.
#
# pkill exits 1 when nothing matched, so each line ends in `|| echo` to report
# "not running" instead of failing the target.
#
# The wait is not decoration. `uvicorn --reload` runs a parent and a child, and
# signalling the parent leaves the child holding the port for a moment — so a
# stop that returns immediately makes `make stop && make dev` race into
# "address already in use", which reads as a mystery rather than as a race.
# Observed: a second `make stop` still found a process to kill. Bounded at ~5s
# and then reported, because hanging forever is worse than saying what is up.
stop:
	@pkill -f 'uvicorn api.main:app' >/dev/null 2>&1 && echo "stopped backend" || echo "backend not running"
	@pkill -f '$(CURDIR)/src/frontend/node_modules/(.bin/vite|vite/bin/vite.js)' >/dev/null 2>&1 && echo "stopped frontend" || echo "frontend not running"
	@for i in $$(seq 1 25); do \
		pgrep -f 'uvicorn api.main:app' >/dev/null 2>&1 || break; \
		sleep 0.2; \
	done; \
	if pgrep -f 'uvicorn api.main:app' >/dev/null 2>&1; then \
		echo "warning: backend still up after 5s — pgrep -af 'uvicorn api.main:app'"; \
	fi

# Sources src/backend/.env when present (see .env.example). `set -a` exports
# every assignment in it; existing shell env still wins, since the file is
# sourced before the `:-` defaults below read it. Nothing here loads a .env at
# import time — python-dotenv is not a dependency — so a bare `uvicorn` run
# needs the vars exported by hand.
backend:
	cd src/backend && set -a && [ -f .env ] && . ./.env; set +a; project="$${GEE_PROJECT:-$$(command -v gcloud >/dev/null 2>&1 && gcloud config get-value project 2>/dev/null | grep -vx '(unset)')}"; \
	GEE_PROJECT="$$project" GEE_DSWFP_ASSET_ROOT="$${GEE_DSWFP_ASSET_ROOT:-$${project:+projects/$$project/assets/dswfp}}" \
	"$(BACKEND_PYTHON)" -m uvicorn api.main:app --reload --host $(BACKEND_HOST) --port $(BACKEND_PORT)

# VITE_PROXY_TARGET, not VITE_API_BASE: the browser calls the same-origin /api
# prefix and Vite forwards it, so the backend URL is a server-side concern here
# rather than something compiled into the client bundle.
#
# Calls Vite's JS entrypoint directly, not `npm run dev`. Under MSYS2 make's
# `$(MAKE) frontend &` backgrounding, npm's Windows shim (npm.cmd, itself a
# cmd.exe batch file) exits without actually keeping its child vite process
# attached to the job make is waiting on — vite starts, binds the port, then
# the whole job is reported dead and the process is gone a moment later.
# Foreground `npm run dev` is unaffected; this only bites the backgrounded
# path `make dev` relies on. The compiled JS entrypoint is called directly
# with node rather than the `.bin/vite` shim script for the same reason.
frontend:
	cd src/frontend && VITE_PROXY_TARGET=$(API_BASE) node "$(CURDIR)/src/frontend/node_modules/vite/bin/vite.js"

# requirements.txt alone boots the API but silently degrades it: lightgbm and
# scikit-learn live in requirements-dataset.txt and BOTH sit on the serving
# path — without them adapter/ml_source.py falls back to the physical noisy-OR
# index and every tower reads `condition: null`, so the supervised model and
# its second opinion are simply absent with nothing raising. All four files are
# meant to land in one environment; there is no reason to split them, since
# every optional import is already guarded at runtime.
install:
	"$(BACKEND_PYTHON)" -m pip install -r src/backend/requirements.txt \
	            -r src/backend/requirements-flood.txt \
	            -r src/backend/requirements-dataset.txt \
	            -r src/backend/requirements-notebook.txt
	cd src/frontend && npm install
