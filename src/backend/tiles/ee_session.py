"""Earth Engine session handling for the live tile service.

Everything Earth Engine touches in this backend goes through here, for two
reasons. The import is optional — `earthengine-api` lives in
requirements-flood.txt, not requirements.txt, so the app must start and serve
every other route with it absent. And the failure has to be legible: an
unauthenticated Earth Engine raises half a dozen unrelated exception types, and
a flood layer that silently renders nothing is the worst outcome available (see
the MapLibre worker note in CLAUDE.md for how expensive that failure mode is).

Credentials are read from the environment and never logged:

    GEE_PROJECT                  Google Cloud project id with the EE API enabled
    GEE_SERVICE_ACCOUNT_EMAIL    service account address (optional)
    GEE_PRIVATE_KEY_FILE         path to that account's JSON key (optional)

With the service-account pair set, the backend authenticates headlessly — the
only mode that works in a container or on a machine nobody is sitting at. With
neither set, it falls back to whatever `earthengine authenticate` left in the
user's config directory, which is the convenient path on a developer laptop and
is not a deployment story.
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path


class LayerUnavailable(RuntimeError):
    """Earth Engine is not usable — missing package, credentials, or project.

    Carries a message intended to reach the operator through the API response,
    so the frontend can say why the layer is unavailable rather than drawing an
    empty raster and leaving everyone to guess.
    """


PROJECT_ENV = "GEE_PROJECT"
ACCOUNT_ENV = "GEE_SERVICE_ACCOUNT_EMAIL"
KEY_FILE_ENV = "GEE_PRIVATE_KEY_FILE"

_SETUP_HINT = (
    "Set GEE_PROJECT, and either GEE_SERVICE_ACCOUNT_EMAIL + GEE_PRIVATE_KEY_FILE "
    "for headless use, or run `earthengine authenticate` on this machine. The "
    "project must have the Earth Engine API enabled and be registered for Earth "
    "Engine access."
)

_lock = threading.Lock()
_initialised = False
manual_only = False  # Enabled by the API; separately invoked offline export scripts still work.
_requests_allowed = ContextVar("ee_requests_allowed", default=False)


@contextmanager
def allow_requests():
    token = _requests_allowed.set(True)
    try:
        yield
    finally:
        _requests_allowed.reset(token)


def credentials_status() -> dict:
    """What is configured, with nothing secret in the return value.

    Reports the *presence* of a key file and whether it is readable — never its
    contents, never the account's key material. `configured` answers "is it worth
    trying to initialise", not "will it work"; only a real call can answer that,
    and initialise() is where that happens.
    """
    project = os.environ.get(PROJECT_ENV, "").strip()
    account = os.environ.get(ACCOUNT_ENV, "").strip()
    key_file = os.environ.get(KEY_FILE_ENV, "").strip()

    key_present = bool(key_file) and Path(key_file).is_file()
    service_account = bool(account) and key_present
    # `earthengine authenticate` writes here; presence is a hint, not a promise.
    user_creds = (Path.home() / ".config" / "earthengine" / "credentials").is_file()
    # gcloud Application Default Credentials are a third viable path: the EE
    # client falls back to them, and a machine with `gcloud auth
    # application-default login` but no `earthengine authenticate` really can
    # reach Earth Engine. Reporting "none" there is a lie that sends people to
    # redo an auth step they have already done.
    adc = (Path.home() / ".config" / "gcloud" / "application_default_credentials.json").is_file()

    if service_account:
        mode = "service_account"
    elif user_creds:
        mode = "user"
    elif adc:
        mode = "adc"
    else:
        mode = "none"

    return {
        "project_set": bool(project),
        "service_account_set": bool(account),
        "key_file_readable": key_present,
        "user_credentials_present": user_creds,
        "adc_present": adc,
        "mode": mode,
        "configured": bool(project) and mode != "none",
    }


def _import_ee():
    try:
        import ee
    except ImportError as error:
        raise LayerUnavailable(
            f"earthengine-api is not installed ({error}). "
            "Run: pip install -r src/backend/requirements-flood.txt"
        ) from error
    return ee


def initialise():
    """Return an initialised `ee` module, or raise LayerUnavailable.

    Initialisation is process-wide and done once behind a lock: ee.Initialize()
    is global state in the client library, and two requests racing it during
    startup would each pay the round trip.
    """
    global _initialised
    if manual_only and not _requests_allowed.get():
        raise LayerUnavailable("Earth Engine requests are disabled outside Reload all maps; no saved result is available")
    ee = _import_ee()

    if _initialised:
        return ee

    with _lock:
        if _initialised:
            return ee

        status = credentials_status()
        if not status["project_set"]:
            raise LayerUnavailable(f"{PROJECT_ENV} is not set. {_SETUP_HINT}")
        if status["mode"] == "none":
            raise LayerUnavailable(f"No Earth Engine credentials found. {_SETUP_HINT}")

        project = os.environ[PROJECT_ENV].strip()
        try:
            # "adc" takes the same branch as "user": ee.Initialize() with no
            # explicit credentials falls back to Application Default Credentials
            # on its own, so there is nothing extra to pass.
            if status["mode"] == "service_account":
                credentials = ee.ServiceAccountCredentials(
                    os.environ[ACCOUNT_ENV].strip(),
                    os.environ[KEY_FILE_ENV].strip(),
                )
                ee.Initialize(credentials, project=project)
            else:
                ee.Initialize(project=project)
        except Exception as error:
            # Auth, quota, project-registration and network failures all surface
            # as different exception types from the EE client; every one of them
            # means the same thing to a caller, and none should reach the route
            # as a traceback.
            raise LayerUnavailable(
                f"Earth Engine failed to initialise for project {project!r}: {error}. {_SETUP_HINT}"
            ) from error

        _initialised = True
        return ee


def reset_for_tests() -> None:
    """Drop the initialised flag. Only for tests — nothing else should call it."""
    global _initialised
    with _lock:
        _initialised = False
