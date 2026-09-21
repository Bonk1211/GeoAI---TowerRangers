# ASEAN Atlas — Interactive Web Map (Leaflet.js)

**AGAIF 2026 · Bootcamp 1, Day 1 · Certified Assessment 3**
Participant: CHIN PEI KANG · Reference code: MY-637

An interactive web map of the ten ASEAN member states and 230 populated places,
built with Leaflet.js, plain HTML/CSS/JavaScript, and the supplied
**ASEAN Shp Data** shapefile dataset.

---

## How to open the application

The page loads its data with `fetch()`, and browsers block `fetch()` on
`file://` URLs. **Double-clicking `index.html` will show an error message** —
run a tiny local web server instead. Any one of these works:

### Option A — Python (already installed on most machines)

```bash
cd "AGAIF2026_BC1_CA3_MY-637_CHIN PEI KANG"
python -m http.server 8000
```

Then open <http://localhost:8000> in your browser.

### Option B — Node.js

```bash
cd "AGAIF2026_BC1_CA3_MY-637_CHIN PEI KANG"
npx serve .
```

### Option C — VS Code

Install the **Live Server** extension, right-click `index.html` →
*Open with Live Server*.

An internet connection is needed for the basemap tiles (CARTO / OpenStreetMap)
and the web fonts. Leaflet itself is bundled in `vendor/`, so the application
does not depend on any CDN for its code.

Tested in Chrome/Chromium 1440×900. Works down to mobile widths (the side panel
stacks above the map below 900 px).

---

## What the map does

| Requirement | Where it is implemented |
|---|---|
| Base map | Three switchable basemaps (Dark Matter, Light Positron, OpenStreetMap) via the layers control, top-right |
| Provided geospatial data | `data/asean_countries.geojson` (10 polygons) + `data/asean_places.geojson` (230 points) |
| Labels / feature identifiers | Permanent country labels; place labels toggled from the panel; hover tooltip on every place marker |
| Zooming & panning | Leaflet zoom control, scroll/pinch zoom, drag pan, double-click zoom, `fitBounds` on country click |
| Information pop-ups | Place pop-up: name, type, country, population, lat/long, OSM ID. Country pop-up: name, place count, aggregated population |
| Appropriate initial extent | `map.fitBounds()` on the combined data bounds — no hard-coded view |
| Attribution | Leaflet, OpenStreetMap, CARTO, and the ASEAN Shp Data source, all in the attribution control and the panel footer |

Extras beyond the brief: country filter, place search, layer toggles, a live
lat/long/zoom readout, and a collapsible panel.

---

## Folder contents

```
AGAIF2026_BC1_CA3_MY-637_CHIN PEI KANG/
├── index.html                    the application
├── css/styles.css                glassmorphism / iOS-style theme
├── js/map.js                     all Leaflet logic
├── data/
│   ├── asean_countries.geojson   10 ASEAN member states (MultiPolygon)
│   └── asean_places.geojson      230 populated places (Point)
├── vendor/leaflet/               Leaflet 1.9.4 (BSD-2-Clause), bundled locally
├── convert_shp_to_geojson.py     shapefile → GeoJSON converter used to build data/
├── screenshots/                  two screenshots of the running map
├── REPORT.md                     the assessment report (export to PDF)
└── README.md                     this file
```

## Regenerating the GeoJSON from the shapefiles

```bash
pip install pyshp
python convert_shp_to_geojson.py "path/to/Asean Shp Data" data
```

The converter reprojects `Asean.shp` from EPSG:3857 (Web Mercator) to
EPSG:4326, which Leaflet requires; `Place.shp` is already EPSG:4326.

---

## Attribution & licences

- **Leaflet 1.9.4** — © Volodymyr Agafonkin, BSD-2-Clause.
- **Basemap tiles** — © [CARTO](https://carto.com/attributions), data ©
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
- **Dataset** — *ASEAN Shp Data* supplied by the AGAIF 2026 Secretariat;
  place attributes derive from OpenStreetMap; country flag links reference
  ArcGIS Online items.
- **Fonts** — Space Grotesk, IBM Plex Sans, IBM Plex Mono (Google Fonts, OFL).
