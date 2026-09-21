"""Confluence Cloud REST client — read-only page fetch/search.

Auth is HTTP Basic with an Atlassian API token (email + token), the standard
credential shape for Confluence Cloud's REST API v2. Never construct this
client with a hardcoded token — it reads CONFLUENCE_* from the environment,
same convention as tiles/ee_session.py's GEE_* vars and agent/runner.py's
ANTHROPIC_API_KEY: absent config is a normal, always-answerable state, not an
error, so every caller must be able to ask "is this configured" before trying
a request.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import httpx
import yaml

RUNBOOKS_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "confluence_runbooks.yaml"


class ConfluenceUnavailable(Exception):
    """Configured-but-failing, or not configured at all. Message is operator-facing."""


@lru_cache(maxsize=1)
def _runbook_map() -> dict[str, str]:
    """dominant_factor -> Confluence page id. Missing file means no runbooks configured."""
    if not RUNBOOKS_CONFIG_PATH.exists():
        return {}
    with RUNBOOKS_CONFIG_PATH.open(encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    return {str(k): str(v) for k, v in raw.items() if v}


def page_id_for_factor(factor: str) -> str | None:
    """None means no runbook exists for this factor yet — never fabricate an id."""
    return _runbook_map().get(factor)


@dataclass(frozen=True)
class ConfluenceConfig:
    site_url: str  # e.g. https://yoursite.atlassian.net/wiki
    email: str
    api_token: str
    space_key: str | None = None


def load_config() -> ConfluenceConfig | None:
    """None means "not configured" — callers must not treat that as an error."""
    site_url = os.environ.get("CONFLUENCE_SITE_URL", "").strip()
    email = os.environ.get("CONFLUENCE_EMAIL", "").strip()
    api_token = os.environ.get("CONFLUENCE_API_TOKEN", "").strip()
    if not (site_url and email and api_token):
        return None
    return ConfluenceConfig(
        site_url=site_url.rstrip("/"),
        email=email,
        api_token=api_token,
        space_key=os.environ.get("CONFLUENCE_SPACE_KEY", "").strip() or None,
    )


def credentials_status() -> dict:
    config = load_config()
    return {
        "configured": config is not None,
        "space_key": config.space_key if config else None,
    }


def _client(config: ConfluenceConfig) -> httpx.Client:
    return httpx.Client(
        base_url=f"{config.site_url}/api/v2",
        auth=(config.email, config.api_token),
        headers={"Accept": "application/json"},
        timeout=10.0,
    )


def search_pages(config: ConfluenceConfig, query: str, limit: int = 10) -> list[dict]:
    """Title/text search, scoped to the configured space when one is set."""
    cql = f'text ~ "{query}"'
    if config.space_key:
        cql += f' and space = "{config.space_key}"'
    try:
        with httpx.Client(
            base_url=f"{config.site_url}/rest/api",
            auth=(config.email, config.api_token),
            headers={"Accept": "application/json"},
            timeout=10.0,
        ) as client:
            response = client.get("/content/search", params={"cql": cql, "limit": limit})
            response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise ConfluenceUnavailable(
            f"Confluence search failed: {error.response.status_code} {error.response.text[:200]}"
        ) from error
    except httpx.HTTPError as error:
        raise ConfluenceUnavailable(f"Confluence unreachable: {error}") from error

    results = response.json().get("results", [])
    return [
        {
            "id": item["id"],
            "title": item["title"],
            "space_key": item.get("space", {}).get("key"),
            "url": f"{config.site_url}{item['_links']['webui']}",
        }
        for item in results
    ]


def get_page(config: ConfluenceConfig, page_id: str) -> dict:
    """Full page body (storage format converted to a plain excerpt) + metadata."""
    try:
        with _client(config) as client:
            response = client.get(
                f"/pages/{page_id}", params={"body-format": "storage"}
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            raise ConfluenceUnavailable(f"page {page_id!r} not found") from error
        raise ConfluenceUnavailable(
            f"Confluence fetch failed: {error.response.status_code} {error.response.text[:200]}"
        ) from error
    except httpx.HTTPError as error:
        raise ConfluenceUnavailable(f"Confluence unreachable: {error}") from error

    page = response.json()
    body_html = page.get("body", {}).get("storage", {}).get("value", "")
    return {
        "id": page["id"],
        "title": page["title"],
        "space_id": page.get("spaceId"),
        "url": f"{config.site_url}{page.get('_links', {}).get('webui', '')}",
        "body_html": body_html,
        "version": page.get("version", {}).get("number"),
    }
