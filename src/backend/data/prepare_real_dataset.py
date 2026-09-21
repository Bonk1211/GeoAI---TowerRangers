"""Prepare the real-source datasets used by the Tower Health Risk Index.

This command extracts:

* every entry in Geospatial Catalog's ``Data`` category;
* ITU's public indicator catalogue and complete series metadata; and
* full-history ITU observations for the eleven ASEAN member states.

Only the Python standard library is required.  The ITU API currently rejects
some direct clients at its CloudFront edge, so ``--itu-transport auto`` falls
back to the read-only Jina transport while retaining the official API URL as
the source URL in every manifest entry.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import ssl
import sys
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

GEOSPATIAL_URL = "https://geospatialcatalog.com/categories/data?page={page}"
ITU_API = "https://api.datahub.itu.int/v3"
JINA_PREFIX = "https://r.jina.ai/http://api.datahub.itu.int/v3"
USER_AGENT = "starlink-tower-risk-dataset/1.0 (source-backed research dataset)"

# Timor-Leste became ASEAN's eleventh member in 2025.  The 2026 project scope
# therefore includes all eleven current member states.
ASEAN_ISO3 = (
    "BRN", "KHM", "IDN", "LAO", "MYS", "MMR",
    "PHL", "SGP", "THA", "TLS", "VNM",
)

OBSERVATION_COLUMNS = (
    "SeriesID", "SeriesCode", "Series", "Unit", "Database", "Year",
    "AreaName", "AreaCode", "DisaggregationGroup", "Disaggregation1",
    "Disaggregation2", "Value", "Notes", "Source", "LastModifiedOn",
)

RELEVANCE_RULES = {
    "tower_locations": re.compile(
        r"\b(beacondb|cell(?:ular)? tower|wireless geolocation)\b", re.I),
    "terrain_dem": re.compile(
        r"\b(dem|digital elevation|elevation model|topograph|terrain)\b", re.I),
    "hand_flood": re.compile(
        r"\b(height above nearest drainage|hand|flood|hydrolog|water)\b", re.I),
    "satellite_imagery": re.compile(
        r"\b(sentinel[- ]?2|copernicus browser|earth observation)\b", re.I),
    "buildings_exposure": re.compile(
        r"\b(building footprint|building density|population density)\b", re.I),
    "lightning": re.compile(r"\b(lightning|thunderstorm|lis/otd)\b", re.I),
    "power_grid": re.compile(
        r"\b(open infrastructure map|power grid|electricity infrastructure|"
        r"openstreetmap data extract|geofabrik)\b", re.I),
}

MODEL_SOURCE_MAP = (
    ("tower_locations", "tower_id|lon|lat", "beacondb",
     "tower location candidate", "blocked_no_bulk_dump",
     "The public API performs geolocation lookups; the provider states that bulk dumps are not yet available."),
    ("terrain_dem", "slope_deg|tri", "copernicus-digital-elevation-model-dem",
     "30 m elevation raster", "downloadable",
     "Surface model includes buildings and vegetation; derive slope/TRI with documented raster processing."),
    ("hand_flood", "hand_m", "global-30m-height-above-nearest-drainage-hand",
     "precomputed 30 m HAND raster", "downloadable",
     "Near-worldwide land coverage; confirm tile coverage for the selected AOI."),
    ("satellite_imagery", "dist_water_m", "sentinel-2-cloud-optimized-geotiffs",
     "Sentinel-2 L2A imagery for water segmentation", "downloadable",
     "Select a low-cloud observation window and cache the exact scene IDs."),
    ("buildings_exposure", "exposed_pop", "microsoft-buildings",
     "global building footprints", "downloadable",
     "Coverage and model vintage vary; validate footprint density in the chosen AOI."),
    ("population_exposure", "exposed_pop", "population-density-maps",
     "high-resolution population estimates", "provider_review_required",
     "Confirm current download route, licence, vintage, and ASEAN coverage with the provider."),
    ("lightning", "flash_density", "nasa-earthdata-lightning",
     "NASA lightning products", "provider_review_required",
     "Select and document the exact LIS/OTD climatology product and units before sampling."),
    ("power_grid", "dist_power_m", "geofabrik",
     "downloadable OpenStreetMap regional extracts", "downloadable",
     "Filter power=line/cable features; community completeness varies by country."),
    ("power_grid", "dist_power_m", "open-infrastructure-map",
     "power-infrastructure discovery and visual QA", "discovery_only",
     "Use underlying OpenStreetMap extracts for reproducible computation, not map tiles."),
)


class SourceError(RuntimeError):
    """Raised when a source response violates its public data contract."""


def _request(url: str, timeout: int = 120) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json,text/csv,*/*"},
    )
    verify_paths = ssl.get_default_verify_paths()
    cafile = verify_paths.cafile
    # The python.org macOS build may point at an uninstalled private bundle even
    # though the operating system bundle is present. Keep TLS verification on.
    if (not cafile or not Path(cafile).exists()) and Path("/etc/ssl/cert.pem").exists():
        cafile = "/etc/ssl/cert.pem"
    context = ssl.create_default_context(cafile=cafile)
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        return response.read()


def _strip_jina(payload: bytes) -> bytes:
    text = payload.decode("utf-8-sig")
    marker = "Markdown Content:\n"
    if marker not in text:
        raise SourceError("Jina response did not contain a Markdown Content payload")
    return text.split(marker, 1)[1].encode("utf-8")


def _jina_url(path: str, query: str = "") -> str:
    # Encode ampersands so every query component remains part of the nested
    # official API URL instead of becoming a parameter of the proxy URL.
    suffix = f"?{query.replace('&', '%26')}" if query else ""
    return f"{JINA_PREFIX}/{path}{suffix}"


def fetch_itu(path: str, query: str, transport: str) -> bytes:
    direct = f"{ITU_API}/{path}" + (f"?{query}" if query else "")
    if transport in {"auto", "direct"}:
        try:
            return _request(direct)
        except (urllib.error.HTTPError, urllib.error.URLError) as error:
            if transport == "direct":
                raise SourceError(f"ITU direct request failed: {direct}: {error}") from error
    if transport not in {"auto", "jina"}:
        raise ValueError(f"unsupported ITU transport: {transport}")
    return _strip_jina(_request(_jina_url(path, query)))


def cached_fetch(
    cache_path: Path,
    fetcher,
    refresh: bool,
) -> bytes:
    if cache_path.exists() and not refresh:
        return cache_path.read_bytes()
    payload = fetcher()
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(payload)
    return payload


def parse_geospatial_page(html: str) -> list[dict]:
    """Extract the server-provided tool records from one Next.js page."""
    records: list[dict] = []
    pattern = re.compile(r"self\.__next_f\.push\((\[.*?\])\)</script>", re.S)
    for match in pattern.finditer(html):
        try:
            frame = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if len(frame) < 2 or not isinstance(frame[1], str):
            continue
        chunk = frame[1]
        marker = '"tools":'
        if marker not in chunk:
            continue
        start = chunk.index(marker) + len(marker)
        tools, _ = json.JSONDecoder().raw_decode(chunk[start:])
        if isinstance(tools, list):
            records.extend(
                item for item in tools
                if isinstance(item, dict) and isinstance(item.get("slug"), str)
            )
    if not records:
        raise SourceError("Geospatial Catalog page contained no tool records")
    return records


def flatten_geospatial(records: list[dict]) -> list[dict]:
    flat = []
    for item in records:
        categories = sorted({category["name"] for category in item["categories"]})
        flat.append({
            "catalog_id": item["id"],
            "name": item["name"],
            "slug": item["slug"],
            "catalog_url": f"https://geospatialcatalog.com/{item['slug']}",
            "website_url": item.get("affiliateUrl") or item.get("websiteUrl") or "",
            "tagline": item.get("tagline") or "",
            "description": item.get("description") or "",
            "categories": "|".join(categories),
            "is_featured": bool(item.get("isFeatured")),
            "is_affiliate": bool(item.get("isAffiliate")),
            "published_at": (item.get("publishedAt") or "").removeprefix("$D"),
            "updated_at": (item.get("updatedAt") or "").removeprefix("$D"),
        })
    return sorted(flat, key=lambda row: (row["name"].casefold(), row["slug"]))


def relevant_geospatial(records: list[dict]) -> list[dict]:
    selected = []
    for row in records:
        text = " ".join((row["name"], row["tagline"], row["description"]))
        factors = [name for name, rule in RELEVANCE_RULES.items() if rule.search(text)]
        if factors:
            selected.append({
                "name": row["name"],
                "website_url": row["website_url"],
                "catalog_url": row["catalog_url"],
                "candidate_factors": "|".join(factors),
                "catalog_description": row["description"],
                "status": "discovery_metadata_only",
            })
    return selected


def model_source_mapping(records: list[dict]) -> list[dict]:
    by_slug = {row["slug"]: row for row in records}
    mapped = []
    for factor, columns, slug, role, readiness, limitation in MODEL_SOURCE_MAP:
        if slug not in by_slug:
            raise SourceError(f"required Geospatial Catalog entry disappeared: {slug}")
        source = by_slug[slug]
        mapped.append({
            "factor": factor,
            "feature_columns": columns,
            "catalog_name": source["name"],
            "website_url": source["website_url"],
            "catalog_url": source["catalog_url"],
            "role": role,
            "readiness": readiness,
            "limitation": limitation,
        })
    return mapped


def flatten_catalogue(catalogue: list[dict]) -> list[dict]:
    families = []
    for category in catalogue:
        for subcategory in category.get("subCategory", []):
            for item in subcategory.get("items", []):
                families.append({
                    **item,
                    "category_name": category["category"],
                    "subcategory_name": subcategory["subCategory"],
                })
    return families


def walk_dicts(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_dicts(child)


def flatten_series(catalogue: list[dict], details: list[dict]) -> list[dict]:
    families = flatten_catalogue(catalogue)
    if len(families) != len(details):
        raise SourceError(
            f"ITU family/detail mismatch: {len(families)} catalogue items, "
            f"{len(details)} detail records"
        )
    series: dict[int, dict] = {}
    for family, detail in zip(families, details):
        for node in walk_dicts(detail):
            series_id = node.get("codeID")
            if not isinstance(series_id, int) or series_id in series:
                continue
            series[series_id] = {
                "series_id": series_id,
                "series_code": node.get("code") or "",
                "series_label": node.get("label") or "",
                "family_id": family["codeID"],
                "family_label": family["label"],
                "category": node.get("category") or family["category_name"],
                "subcategory": node.get("subCategory") or family["subcategory_name"],
                "collection": node.get("collection") or detail.get("collection")
                or detail.get("subCollection") or "",
                "indicator_category": node.get("indicatorCategory") or "",
                "indicator_subcategory": node.get("indicatorSubCategory") or "",
                "disaggregation_label": node.get("disaggregationLabel") or "",
                "series_type": node.get("seriesType") or "",
                "answer_type": node.get("answerType") or "",
                "unit": node.get("units") or "",
                "unit_type": node.get("unitsType") or "",
                "start_year": node.get("startYear"),
                "end_year": node.get("endYear"),
                "database_id": node.get("databaseID"),
                "database_name": node.get("databaseName") or "",
                "definition": node.get("codeDef") or "",
                "description": node.get("codeDesc") or "",
                "visibility": node.get("codeVisibility") or "Public/Free",
                "external": bool(node.get("external", False)),
                "archived": bool(node.get("archive", False)),
                "metadata_origin": "indicator_details",
            }
    return [series[key] for key in sorted(series)]


def augment_series_from_observations(
    series_rows: list[dict], observations: list[dict]
) -> tuple[list[dict], int]:
    """Add series expanded by the bulk endpoint but absent from getbyids.

    ITU's bulk download expands some collection siblings and alternative-unit
    series that ``dictionaries/getbyids`` omits.  The export still supplies a
    stable ID, code, label, unit, database, and year, which are sufficient to
    maintain referential integrity without inventing definitions or parents.
    """
    by_id = {int(row["series_id"]): row for row in series_rows}
    grouped: dict[int, list[dict]] = {}
    for observation in observations:
        grouped.setdefault(int(observation["SeriesID"]), []).append(observation)
    added = 0
    template_keys = list(series_rows[0])
    for series_id, records in grouped.items():
        if series_id in by_id:
            continue
        first = records[0]
        row = {key: "" for key in template_keys}
        row.update({
            "series_id": series_id,
            "series_code": first["SeriesCode"],
            "series_label": first["Series"],
            "answer_type": "Numeric",
            "unit": first["Unit"],
            "start_year": min(int(record["Year"]) for record in records),
            "end_year": max(int(record["Year"]) for record in records),
            "database_name": first["Database"],
            "visibility": "Public/Free",
            "external": False,
            "archived": False,
            "metadata_origin": "observation_export",
        })
        by_id[series_id] = row
        added += 1
    return [by_id[key] for key in sorted(by_id)], added


def primary_series_ids(details: list[dict]) -> list[int]:
    """Replicate ITU's 'All indicators' selection without disaggregations."""
    result = set()
    for detail in details:
        if "collection" not in detail and "subCollection" not in detail:
            if isinstance(detail.get("codeID"), int):
                result.add(detail["codeID"])
            continue
        for group in detail.get("codes", []):
            for key in ("collectionOverview", "indicatorOverview"):
                for item in group.get(key) or []:
                    if isinstance(item.get("codeID"), int):
                        result.add(item["codeID"])
    if not result:
        raise SourceError("ITU details yielded no primary indicator series")
    return sorted(result)


def parse_observations(payload: bytes) -> tuple[list[dict], int]:
    """Parse ITU CSV and repair known unquoted source newlines losslessly."""
    reader = csv.reader(io.StringIO(payload.decode("utf-8-sig"), newline=""))
    rows = list(reader)
    if not rows or tuple(rows[0]) != OBSERVATION_COLUMNS:
        raise SourceError("ITU observation export schema changed")
    data, repaired, index = [], 0, 1
    width = len(OBSERVATION_COLUMNS)
    while index < len(rows):
        row = rows[index]
        if len(row) == width:
            data.append(dict(zip(OBSERVATION_COLUMNS, row)))
            index += 1
            continue
        # ITU currently has two source values containing an unquoted newline:
        # a 14-field prefix followed by [source_tail, LastModifiedOn].
        if len(row) == width - 1 and index + 1 < len(rows) and len(rows[index + 1]) == 2:
            tail = rows[index + 1]
            merged = row[:-1] + [row[-1] + "\n" + tail[0], tail[1]]
            data.append(dict(zip(OBSERVATION_COLUMNS, merged)))
            repaired += 1
            index += 2
            continue
        raise SourceError(
            f"malformed ITU CSV record near parsed row {index + 1}: "
            f"expected {width} fields, found {len(row)}"
        )
    return data, repaired


def validate_observations(rows: list[dict]) -> dict:
    areas = sorted({row["AreaCode"] for row in rows})
    if areas != sorted(ASEAN_ISO3):
        raise SourceError(f"ITU observation economy coverage mismatch: {areas}")
    # Blank Value is an explicit ITU no-data record, not a parse failure.  Keep
    # it so missingness remains auditable; identifiers and grain may not be blank.
    required = ("SeriesID", "SeriesCode", "Series", "Year", "AreaCode")
    missing = {column: sum(not row[column].strip() for row in rows) for column in required}
    if any(missing.values()):
        raise SourceError(f"ITU observations contain missing required values: {missing}")
    invalid_numeric_values = 0
    for row in rows:
        value = row["Value"].strip()
        if not value:
            continue
        try:
            float(value)
        except ValueError:
            invalid_numeric_values += 1
    if invalid_numeric_values:
        raise SourceError(
            f"ITU quantitative export contains {invalid_numeric_values} non-numeric values"
        )
    keys = [
        (row["SeriesID"], row["Year"], row["AreaCode"],
         row["DisaggregationGroup"], row["Disaggregation1"], row["Disaggregation2"])
        for row in rows
    ]
    duplicates = sum(count - 1 for count in Counter(keys).values() if count > 1)
    years = [int(row["Year"]) for row in rows]
    last_modified = [row["LastModifiedOn"] for row in rows if row["LastModifiedOn"]]
    totals_by_economy = Counter(row["AreaCode"] for row in rows)
    missing_by_economy = Counter(
        row["AreaCode"] for row in rows if not row["Value"].strip()
    )
    return {
        "records": len(rows),
        "distinct_series": len({row["SeriesID"] for row in rows}),
        "economies": areas,
        "year_min": min(years),
        "year_max": max(years),
        "last_modified_max": max(last_modified) if last_modified else None,
        "missing_required": missing,
        "missing_values": sum(not row["Value"].strip() for row in rows),
        "invalid_numeric_values": invalid_numeric_values,
        "missing_values_by_economy": {
            economy: {
                "missing": missing_by_economy[economy],
                "records": totals_by_economy[economy],
                "rate": round(missing_by_economy[economy] / totals_by_economy[economy], 6),
            }
            for economy in sorted(totals_by_economy)
        },
        "duplicate_grain_rows": duplicates,
    }


def write_csv(path: Path, rows: list[dict], fieldnames: list[str] | tuple[str, ...] | None = None):
    path.parent.mkdir(parents=True, exist_ok=True)
    names = list(fieldnames or (rows[0].keys() if rows else []))
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=names, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare(args) -> dict:
    output = args.output.resolve()
    cache = args.cache_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)

    geospatial_raw = []
    for page in range(1, 15):
        payload = cached_fetch(
            cache / f"geospatial-page-{page}.html",
            lambda page=page: _request(GEOSPATIAL_URL.format(page=page)),
            args.refresh,
        )
        geospatial_raw.extend(parse_geospatial_page(payload.decode("utf-8")))
    by_slug = {item["slug"]: item for item in geospatial_raw}
    if len(by_slug) != 474:
        raise SourceError(
            f"expected 474 unique Geospatial Catalog entries, found {len(by_slug)}"
        )
    geospatial = flatten_geospatial(list(by_slug.values()))

    endpoints = {
        "countries": ("country/all", ""),
        "regions": ("region/all", ""),
        "methodology": ("methodology/dataset", ""),
        "catalogue": ("dictionaries/getcategories", ""),
    }
    itu = {}
    for name, (path, query) in endpoints.items():
        payload = cached_fetch(
            cache / f"itu-{name}.json",
            lambda path=path, query=query: fetch_itu(path, query, args.itu_transport),
            args.refresh,
        )
        itu[name] = json.loads(payload)

    families = flatten_catalogue(itu["catalogue"])
    family_ids = [str(item["codeID"]) for item in families]
    details_payload = cached_fetch(
        cache / "itu-details.json",
        lambda: fetch_itu(
            "dictionaries/getbyids", f"codeids={','.join(family_ids)}",
            args.itu_transport,
        ),
        args.refresh,
    )
    details = json.loads(details_payload)
    primary_ids = primary_series_ids(details)

    country_ids = sorted(
        country["CountryID"] for country in itu["countries"]
        if country["IsoCode"] in ASEAN_ISO3
    )
    if len(country_ids) != len(ASEAN_ISO3):
        raise SourceError("ITU country dictionary did not contain all ASEAN members")
    observation_query = (
        f"codesid={','.join(map(str, primary_ids))}&"
        f"countriesid={','.join(map(str, country_ids))}"
    )
    observations_payload = cached_fetch(
        cache / "itu-asean-observations.csv",
        lambda: fetch_itu("data/download", observation_query, args.itu_transport),
        args.refresh,
    )
    observations_all, repaired = parse_observations(observations_payload)
    observations = [
        row for row in observations_all if row["AreaCode"] in ASEAN_ISO3
    ]
    aggregate_rows_excluded = len(observations_all) - len(observations)
    observation_quality = validate_observations(observations)
    series = flatten_series(itu["catalogue"], details)
    series, export_only_series = augment_series_from_observations(series, observations)
    metadata_ids = {str(row["series_id"]) for row in series}
    unmatched_observation_series = sorted(
        {row["SeriesID"] for row in observations} - metadata_ids,
        key=int,
    )
    if unmatched_observation_series:
        raise SourceError(
            f"{len(unmatched_observation_series)} observation series lack metadata"
        )

    files = {
        "geospatial_catalog": output / "geospatial_catalog_data.csv",
        "geospatial_ml_sources": output / "geospatial_ml_sources.csv",
        "model_source_mapping": output / "model_source_mapping.csv",
        "itu_observations": output / "itu_asean_observations.csv",
        "itu_series": output / "itu_series_metadata.csv",
        "itu_catalogue": output / "itu_indicator_catalogue.json",
        "itu_details": output / "itu_indicator_details.json",
        "itu_countries": output / "itu_countries.json",
        "itu_regions": output / "itu_regions.json",
        "itu_methodology": output / "itu_methodology.json",
    }
    write_csv(files["geospatial_catalog"], geospatial)
    write_csv(files["geospatial_ml_sources"], relevant_geospatial(geospatial))
    write_csv(files["model_source_mapping"], model_source_mapping(geospatial))
    write_csv(files["itu_observations"], observations, OBSERVATION_COLUMNS)
    write_csv(files["itu_series"], series)
    write_json(files["itu_catalogue"], itu["catalogue"])
    write_json(files["itu_details"], details)
    write_json(files["itu_countries"], itu["countries"])
    write_json(files["itu_regions"], itu["regions"])
    write_json(files["itu_methodology"], itu["methodology"])

    quality = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "geospatial_catalog": {
            "records": len(geospatial),
            "unique_slugs": len({row["slug"] for row in geospatial}),
            "missing_website_urls": sum(not row["website_url"] for row in geospatial),
            "ml_candidate_records": len(relevant_geospatial(geospatial)),
        },
        "itu": {
            "catalogue_families": len(families),
            "metadata_series": len(series),
            "metadata_series_from_observation_export": export_only_series,
            "observation_series_without_metadata": 0,
            "primary_series_requested": len(primary_ids),
            "repaired_multiline_source_records": repaired,
            "regional_aggregate_rows_excluded": aggregate_rows_excluded,
            **observation_quality,
        },
    }
    quality_path = output / "quality_report.json"
    write_json(quality_path, quality)

    manifest = {
        "title": "Tower Health Risk Index real-source dataset",
        "generated_at": quality["generated_at"],
        "scope": "Geospatial source catalogue plus full-history ITU data for 11 ASEAN members",
        "sources": [
            {
                "name": "Geospatial Catalog - Data",
                "url": "https://geospatialcatalog.com/categories/data",
                "role": "discovery metadata; not tower-level measurements",
            },
            {
                "name": "ITU DataHub",
                "url": "https://datahub.itu.int/data/",
                "api": f"{ITU_API}/data/download",
                "role": "country-level ICT observations and provenance",
                "license": "CC BY-NC-SA 3.0 IGO; third-party series retain owner terms",
            },
            {
                "name": "ITU Indicator Catalogue",
                "url": "https://datahub.itu.int/indicators/",
                "api": f"{ITU_API}/dictionaries/getcategories",
                "role": "indicator and series metadata",
            },
        ],
        "files": {
            name: {
                "path": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for name, path in files.items()
        } | {
            "quality_report": {
                "path": quality_path.name,
                "bytes": quality_path.stat().st_size,
                "sha256": sha256(quality_path),
            }
        },
        "limitations": [
            "ITU observations are country-level context and must not be joined to tower rows as if they were local measurements.",
            "Geospatial Catalog records are discovery metadata; each linked provider's data and licence must be acquired separately.",
            "The supplied sources do not expose a bulk tower-level radio-generation dataset. A model-contract feature table still requires a licensed OpenCellID export or an equivalent operator source.",
            "No outage/failure labels are present; this dataset supports an index, not predictive-accuracy claims.",
        ],
    }
    write_json(output / "manifest.json", manifest)
    return quality


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--output", type=Path, default=Path("data/real_sources"),
        help="dataset output directory (default: data/real_sources)",
    )
    result.add_argument(
        "--cache-dir", type=Path, default=Path(".cache/real_sources"),
        help="download cache used for reproducible reruns",
    )
    result.add_argument(
        "--itu-transport", choices=("auto", "direct", "jina"), default="auto",
        help="ITU download transport; auto tries the official API first",
    )
    result.add_argument("--refresh", action="store_true", help="ignore cached downloads")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        quality = prepare(args)
    except (SourceError, urllib.error.URLError, json.JSONDecodeError) as error:
        print(f"dataset preparation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(quality, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
