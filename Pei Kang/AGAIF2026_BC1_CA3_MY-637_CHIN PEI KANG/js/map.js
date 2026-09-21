/* ============================================================
   ASEAN Atlas — Leaflet application logic
   AGAIF 2026 Bootcamp 1 / Day 1 — Certified Assessment 3

   Layers
     asean_countries.geojson  10 MultiPolygon member states
     asean_places.geojson     230 Point populated places (OSM)

   Both files are produced by convert_shp_to_geojson.py from the
   supplied "ASEAN Shp Data.zip" shapefiles.
   ============================================================ */

(function () {
  "use strict";

  var DATA = {
    countries: "data/asean_countries.geojson",
    places: "data/asean_places.geojson"
  };

  // ---------------------------------------------------------
  // Map + base layers
  // ---------------------------------------------------------

  var map = L.map("map", {
    zoomControl: false,
    minZoom: 3,
    maxZoom: 18,
    // Fractional zoom steps so fitBounds frames the region tightly instead of
    // snapping down a whole level and leaving half the viewport empty.
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    worldCopyJump: true,
    // Fallback view; replaced by fitBounds() once the data loads.
    center: [6, 116],
    zoom: 4
  });

  var osmAttr =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var cartoAttr = osmAttr + ' &copy; <a href="https://carto.com/attributions">CARTO</a>';

  var baseLayers = {
    "Dark matter": L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      { attribution: cartoAttr, subdomains: "abcd", maxZoom: 20 }
    ),
    "Light positron": L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      { attribution: cartoAttr, subdomains: "abcd", maxZoom: 20 }
    ),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: osmAttr,
      maxZoom: 19
    })
  };

  baseLayers["Dark matter"].addTo(map);

  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.layers(baseLayers, null, { position: "topright", collapsed: true }).addTo(map);
  L.control.scale({ position: "bottomright", imperial: false }).addTo(map);

  map.attributionControl.addAttribution(
    'Data: ASEAN Shp Data (AGAIF 2026) &middot; places from OpenStreetMap'
  );

  // ---------------------------------------------------------
  // Layer groups
  // ---------------------------------------------------------

  var countryLayer = L.geoJSON(null, {
    style: countryStyle,
    onEachFeature: onEachCountry
  }).addTo(map);

  var placeLayer = L.layerGroup().addTo(map);
  var labelLayer = L.layerGroup();
  var countryLabelLayer = L.layerGroup().addTo(map);

  var state = {
    places: [],           // { props, marker, label }
    countries: {},        // country -> { layer, places, population }
    filter: "",
    dataBounds: null,
    selected: null
  };

  // ---------------------------------------------------------
  // Styling
  // ---------------------------------------------------------

  function countryStyle() {
    return {
      color: "rgba(88, 214, 232, 0.6)",
      weight: 1.2,
      fillColor: "#58d6e8",
      fillOpacity: 0.14,
      opacity: 0.85
    };
  }

  function countryHoverStyle() {
    return { weight: 2.2, color: "#58d6e8", fillOpacity: 0.28 };
  }

  function countryDimStyle() {
    return {
      color: "rgba(148, 162, 188, 0.25)",
      weight: 0.8,
      fillColor: "#94a2bc",
      fillOpacity: 0.04,
      opacity: 0.5
    };
  }

  // Marker radius bins mirror the legend in the side panel.
  function radiusFor(population) {
    if (population >= 1000000) return 11;
    if (population >= 250000) return 8;
    if (population >= 50000) return 6;
    return 4;
  }

  function placeStyle(props) {
    return {
      radius: radiusFor(props.population),
      color: "#58d6e8",
      weight: 1.4,
      fillColor: "#58d6e8",
      fillOpacity: 0.35,
      opacity: 0.9
    };
  }

  // ---------------------------------------------------------
  // Popups
  // ---------------------------------------------------------

  function num(value) {
    return value.toLocaleString("en-US");
  }

  function row(label, value) {
    return "<tr><th>" + label + "</th><td>" + value + "</td></tr>";
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[character];
    });
  }

  function placePopup(props) {
    var population = props.population > 0 ? num(props.population) : "not recorded";
    return (
      '<p class="pop-kicker">' + escapeHtml(props.type || "place") + "</p>" +
      '<h2 class="pop-title">' + escapeHtml(props.name || "Unnamed place") + "</h2>" +
      '<table class="pop-table">' +
      row("Country", escapeHtml(props.country)) +
      row("Population", population) +
      row("Latitude", props.lat.toFixed(4) + "&deg;") +
      row("Longitude", props.lon.toFixed(4) + "&deg;") +
      row("OSM ID", escapeHtml(props.osm_id)) +
      "</table>"
    );
  }

  function countryPopup(country) {
    var entry = state.countries[country] || { places: 0, population: 0 };
    return (
      '<p class="pop-kicker">ASEAN member state</p>' +
      '<h2 class="pop-title">' + escapeHtml(country) + "</h2>" +
      '<table class="pop-table">' +
      row("Places in dataset", num(entry.places)) +
      row("Recorded population", num(entry.population)) +
      "</table>"
    );
  }

  // ---------------------------------------------------------
  // Country layer behaviour
  // ---------------------------------------------------------

  function onEachCountry(feature, layer) {
    var country = feature.properties.country;

    layer.bindPopup(function () {
      return countryPopup(country);
    });

    layer.on({
      mouseover: function () {
        if (state.filter && state.filter !== country) return;
        layer.setStyle(countryHoverStyle());
        layer.bringToFront();
      },
      mouseout: function () {
        applyCountryStyle(layer, country);
      },
      click: function () {
        map.fitBounds(layer.getBounds(), { padding: [40, 40] });
      }
    });
  }

  function applyCountryStyle(layer, country) {
    var dimmed = state.filter && state.filter !== country;
    layer.setStyle(dimmed ? countryDimStyle() : countryStyle());
  }

  // ---------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------

  function loadJSON(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error(url + " -> HTTP " + response.status);
      return response.json();
    });
  }

  Promise.all([loadJSON(DATA.countries), loadJSON(DATA.places)])
    .then(function (results) {
      buildCountries(results[0]);
      buildPlaces(results[1]);
      finishSetup();
    })
    .catch(function (error) {
      showFatal(error);
    });

  function buildCountries(collection) {
    countryLayer.addData(collection);

    countryLayer.eachLayer(function (layer) {
      var country = layer.feature.properties.country;
      state.countries[country] = { layer: layer, places: 0, population: 0 };

      // Label sits on the largest landmass, not the bounds centre — an
      // archipelago's bounds centre usually falls in open water.
      L.marker(largestPartCenter(layer.feature), {
        interactive: false,
        icon: L.divIcon({
          className: "country-label",
          html: escapeHtml(country),
          iconSize: [140, 16],
          iconAnchor: [70, 8]
        })
      }).addTo(countryLabelLayer);
    });

    state.dataBounds = countryLayer.getBounds();
  }

  // Returns the centre of the largest polygon part of a MultiPolygon feature,
  // measured by bounding-box area. Good enough to keep every country label on
  // land without pulling in a full centroid implementation.
  function largestPartCenter(feature) {
    var best = null;
    var bestArea = -1;
    feature.geometry.coordinates.forEach(function (polygon) {
      var ring = polygon[0];
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      ring.forEach(function (point) {
        if (point[0] < minX) minX = point[0];
        if (point[0] > maxX) maxX = point[0];
        if (point[1] < minY) minY = point[1];
        if (point[1] > maxY) maxY = point[1];
      });
      var area = (maxX - minX) * (maxY - minY);
      if (area > bestArea) {
        bestArea = area;
        best = L.latLng((minY + maxY) / 2, (minX + maxX) / 2);
      }
    });
    return best;
  }

  function buildPlaces(collection) {
    collection.features.forEach(function (feature) {
      var props = feature.properties;
      var latlng = L.latLng(props.lat, props.lon);

      var marker = L.circleMarker(latlng, placeStyle(props));
      marker.bindPopup(placePopup(props), { maxWidth: 300 });
      marker.bindTooltip(props.name, { direction: "top", offset: [0, -6] });

      var label = L.marker(latlng, {
        interactive: false,
        icon: L.divIcon({
          className: "place-label",
          html: escapeHtml(props.name),
          iconSize: [120, 14],
          iconAnchor: [-8, 7]
        })
      });

      state.places.push({ props: props, marker: marker, label: label });

      var entry = state.countries[props.country];
      if (entry) {
        entry.places += 1;
        entry.population += props.population;
      }
    });

    renderPlaces();
  }

  // Rebuilds the visible marker set for the current country filter.
  function renderPlaces() {
    placeLayer.clearLayers();
    labelLayer.clearLayers();

    var visible = 0;
    var population = 0;

    state.places.forEach(function (place) {
      if (state.filter && place.props.country !== state.filter) return;
      placeLayer.addLayer(place.marker);
      labelLayer.addLayer(place.label);
      visible += 1;
      population += place.props.population;
    });

    text("stat-places", num(visible));
    text("stat-pop", compact(population));
    text("stat-countries", state.filter ? "1" : String(Object.keys(state.countries).length));
  }

  function compact(value) {
    if (value >= 1000000) return (value / 1000000).toFixed(1) + "M";
    if (value >= 1000) return Math.round(value / 1000) + "k";
    return String(value);
  }

  // ---------------------------------------------------------
  // Controls
  // ---------------------------------------------------------

  function byId(id) {
    return document.getElementById(id);
  }

  function text(id, value) {
    byId(id).textContent = value;
  }

  function finishSetup() {
    // Initial extent: fit the data rather than hard-coding a view.
    map.fitBounds(state.dataBounds, { padding: [30, 30] });
    map.setMaxBounds(state.dataBounds.pad(1.2));

    var select = byId("country");
    Object.keys(state.countries)
      .sort()
      .forEach(function (country) {
        var option = document.createElement("option");
        option.value = country;
        option.textContent = country + "  (" + state.countries[country].places + ")";
        select.appendChild(option);
      });

    select.addEventListener("change", function () {
      state.filter = select.value;
      renderPlaces();
      countryLayer.eachLayer(function (layer) {
        applyCountryStyle(layer, layer.feature.properties.country);
      });
      if (state.filter) {
        map.fitBounds(state.countries[state.filter].layer.getBounds(), { padding: [40, 40] });
      } else {
        map.fitBounds(state.dataBounds, { padding: [30, 30] });
      }
    });

    wireToggle("toggle-countries", [countryLayer, countryLabelLayer]);
    wireToggle("toggle-places", [placeLayer]);
    wireToggle("toggle-labels", [labelLayer]);

    byId("reset").addEventListener("click", function () {
      state.filter = "";
      select.value = "";
      renderPlaces();
      countryLayer.eachLayer(function (layer) {
        applyCountryStyle(layer, layer.feature.properties.country);
      });
      map.closePopup();
      map.fitBounds(state.dataBounds, { padding: [30, 30] });
    });

    wireSearch();
    wirePanelToggle();
    wireReadout();
  }

  function wireToggle(id, layers) {
    var input = byId(id);
    input.addEventListener("change", function () {
      layers.forEach(function (layer) {
        if (input.checked) map.addLayer(layer);
        else map.removeLayer(layer);
      });
    });
    // Sync the initial DOM state with what is actually on the map.
    layers.forEach(function (layer) {
      if (input.checked && !map.hasLayer(layer)) map.addLayer(layer);
      if (!input.checked && map.hasLayer(layer)) map.removeLayer(layer);
    });
  }

  function wireSearch() {
    var input = byId("search");
    var list = byId("results");

    input.addEventListener("input", function () {
      var query = input.value.trim().toLowerCase();
      list.innerHTML = "";

      if (query.length < 2) {
        list.hidden = true;
        return;
      }

      var matches = state.places
        .filter(function (place) {
          return (place.props.name || "").toLowerCase().indexOf(query) !== -1;
        })
        .slice(0, 12);

      if (matches.length === 0) {
        list.innerHTML = '<li class="empty">No place matches that name.</li>';
        list.hidden = false;
        return;
      }

      matches.forEach(function (place) {
        var item = document.createElement("li");
        item.setAttribute("role", "option");
        item.innerHTML =
          "<span>" + escapeHtml(place.props.name) + "</span>" +
          '<span class="r-country">' + escapeHtml(place.props.country) + "</span>";
        item.addEventListener("click", function () {
          flyToPlace(place);
          list.hidden = true;
          input.value = place.props.name;
        });
        list.appendChild(item);
      });

      list.hidden = false;
    });

    input.addEventListener("blur", function () {
      // Delay so a click on a result still registers.
      window.setTimeout(function () {
        list.hidden = true;
      }, 180);
    });
  }

  function flyToPlace(place) {
    // A filtered-out place has to come back on the map before it can open.
    if (state.filter && place.props.country !== state.filter) {
      state.filter = "";
      byId("country").value = "";
      renderPlaces();
      countryLayer.eachLayer(function (layer) {
        applyCountryStyle(layer, layer.feature.properties.country);
      });
    }
    if (!map.hasLayer(placeLayer)) {
      byId("toggle-places").checked = true;
      map.addLayer(placeLayer);
    }
    map.flyTo([place.props.lat, place.props.lon], 9, { duration: 0.9 });
    map.once("moveend", function () {
      place.marker.openPopup();
    });
  }

  function wirePanelToggle() {
    var button = byId("panel-toggle");
    button.addEventListener("click", function () {
      var app = byId("app");
      var collapsed = app.classList.toggle("collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
      window.setTimeout(function () {
        map.invalidateSize();
      }, 340);
    });
  }

  function wireReadout() {
    function update(latlng) {
      text("ro-lat", latlng.lat.toFixed(3));
      text("ro-lon", latlng.lng.toFixed(3));
      text("ro-zoom", map.getZoom().toFixed(2));
    }
    map.on("mousemove", function (event) {
      update(event.latlng);
    });
    map.on("zoomend moveend", function () {
      update(map.getCenter());
    });
    update(map.getCenter());
  }

  function showFatal(error) {
    console.error(error);
    byId("map").innerHTML =
      '<div style="padding:28px;font:14px/1.6 system-ui;color:#e9eef7">' +
      "<strong>The map data could not be loaded.</strong><br>" +
      escapeHtml(error.message) +
      "<br><br>Open the folder through a local web server " +
      "(<code>python -m http.server 8000</code>) rather than double-clicking " +
      "index.html — browsers block <code>fetch()</code> on <code>file://</code> URLs." +
      "</div>";
  }
})();
