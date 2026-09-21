"""
CA3 — shapefile -> GeoJSON converter.

Reads the two layers in "ASEAN Shp Data.zip":
  Asean.shp   polygons, 10 ASEAN member states, EPSG:3857 (Web Mercator)
  Place.shp   points, 230 populated places, EPSG:4326 (WGS84)

Leaflet consumes WGS84 lon/lat only, so the polygon layer is reprojected
from Web Mercator back to geographic coordinates here.

Usage:  python convert_shp_to_geojson.py <extracted_shp_dir> <out_dir>
Needs:  pip install pyshp
"""
import json
import math
import sys
from pathlib import Path

import shapefile

R = 6378137.0  # WGS84 semi-major axis used by EPSG:3857


def mercator_to_wgs84(x, y):
    """Inverse spherical Web Mercator -> (lon, lat) in degrees."""
    lon = (x / R) * 180.0 / math.pi
    lat = (2.0 * math.atan(math.exp(y / R)) - math.pi / 2.0) * 180.0 / math.pi
    return round(lon, 5), round(lat, 5)


def dedupe(ring):
    """Drop consecutive duplicate vertices left behind by rounding."""
    out = [ring[0]]
    for pt in ring[1:]:
        if pt != out[-1]:
            out.append(pt)
    if out[0] != out[-1]:
        out.append(out[0])
    return out


def polygon_feature(shape, props):
    """Each shapefile part becomes one polygon ring -> MultiPolygon.

    Country outlines here are island archipelagos with no interior holes,
    so every part is treated as an outer ring.
    """
    parts = list(shape.parts) + [len(shape.points)]
    rings = []
    for i in range(len(parts) - 1):
        ring = [mercator_to_wgs84(x, y) for x, y in shape.points[parts[i]:parts[i + 1]]]
        if len(ring) < 4:
            continue
        ring = dedupe(ring)
        if len(ring) >= 4:
            rings.append([list(map(list, ring))])
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": "MultiPolygon", "coordinates": rings},
    }


def convert(src_dir: Path, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- countries ---------------------------------------------------
    reader = shapefile.Reader(str(src_dir / "Asean"))
    fields = [f[0] for f in reader.fields[1:]]
    features = []
    for shape_rec in reader.shapeRecords():
        props = dict(zip(fields, shape_rec.record))
        features.append(polygon_feature(shape_rec.shape, {
            "country": props.get("Country"),
            "objectid": props.get("OBJECTID"),
            "flag_url": props.get("Flag"),
        }))
    write(out_dir / "asean_countries.geojson", features)

    # --- places ------------------------------------------------------
    reader = shapefile.Reader(str(src_dir / "Place"))
    fields = [f[0] for f in reader.fields[1:]]
    features = []
    for shape_rec in reader.shapeRecords():
        props = dict(zip(fields, shape_rec.record))
        lon, lat = shape_rec.shape.points[0]
        pop = props.get("population") or 0
        features.append({
            "type": "Feature",
            "properties": {
                "name": props.get("name"),
                "type": props.get("type"),
                "population": int(pop),
                "country": props.get("Country"),
                "osm_id": props.get("osm_id"),
                "lat": round(float(props.get("Lat", lat)), 6),
                "lon": round(float(props.get("Long", lon)), 6),
            },
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        })
    write(out_dir / "asean_places.geojson", features)


def write(path: Path, features):
    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }
    path.write_text(json.dumps(fc), encoding="utf-8")
    print(f"{path.name}: {len(features)} features, {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("Asean Shp Data")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data")
    convert(src, out)
