"""GET /confluence/status, GET /confluence/search, GET /confluence/pages/{page_id}.

Read-only. The catalogue-style status route always answers, with or without
credentials, so the frontend can say precisely why a doc link is unavailable —
same shape as flood.py's /flood/layers vs /flood/tiles split. Unavailability
(missing config, or a real Confluence-side failure) is a 503 carrying the
operator-facing reason, never an empty 200.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from api.confluence_client import (
    ConfluenceUnavailable,
    credentials_status,
    get_page,
    load_config,
    page_id_for_factor,
    search_pages,
)

router = APIRouter(prefix="/confluence", tags=["confluence"])


@router.get("/status")
def get_status() -> dict:
    """Whether CONFLUENCE_* env vars are set. Never a promise the API is reachable."""
    return credentials_status()


@router.get("/search")
def search(q: str = Query(..., min_length=1), limit: int = Query(10, ge=1, le=50)) -> dict:
    config = load_config()
    if config is None:
        raise HTTPException(status_code=503, detail="Confluence is not configured")
    try:
        results = search_pages(config, q, limit=limit)
    except ConfluenceUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {"results": results}


@router.get("/pages/{page_id}")
def get_page_route(page_id: str) -> dict:
    config = load_config()
    if config is None:
        raise HTTPException(status_code=503, detail="Confluence is not configured")
    try:
        return get_page(config, page_id)
    except ConfluenceUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/runbook/{factor}")
def get_runbook(factor: str) -> dict:
    """dominant_factor -> its runbook page, via config/confluence_runbooks.yaml.

    404 (not 503) when no page is mapped for this factor — that is caller
    error (an unconfigured factor), distinct from "Confluence is unreachable".
    """
    page_id = page_id_for_factor(factor)
    if page_id is None:
        raise HTTPException(status_code=404, detail=f"no runbook configured for factor {factor!r}")
    config = load_config()
    if config is None:
        raise HTTPException(status_code=503, detail="Confluence is not configured")
    try:
        return get_page(config, page_id)
    except ConfluenceUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
