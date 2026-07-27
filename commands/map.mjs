import process from 'bare-process';
import fs from 'bare-fs';
import {
  openDb,
  nodesRepo,
  observationsRepo,
  geoRepo,
  prefixOf,
  hostKind,
  publishedNetwork,
  isSmallEndUserNetwork
} from '../db.mjs';
import { htmlPath, ensureDirs } from '../paths.mjs';
import { ensureVendor } from '../vendor/index.mjs';

// Render the discovered + geo-located nodes onto an interactive world map.
// Produces a self-contained map.html (Leaflet served locally, data embedded inline),
// grouping nodes by /24 subnet (one marker per network). Marker colour encodes
// stability: how many distinct crawl sessions the network's nodes have appeared
// in (red = transient, green = long-lived / likely dedicated).

export function run(ctx) {
  const db = openDb();
  const nodes = nodesRepo(db);
  const observations = observationsRepo(db);
  const geoData = geoRepo(db);

  // geo rows keyed by /24 prefix (only successfully located networks)
  const geo = geoData.locatedWithCoords();

  // aggregate node stats per /24
  const groups = new Map();
  for (const node of nodes.allWithStats()) {
    const prefix = prefixOf(node.host);
    const geoRow = geo.get(prefix);
    if (!geoRow) {
      continue;
    }
    let agg = groups.get(prefix);
    if (!agg) {
      agg = {
        prefix,
        lat: geoRow.lat,
        lon: geoRow.lon,
        city: geoRow.city,
        country: geoRow.country,
        isp: geoRow.isp,
        org: geoRow.org,
        kind: hostKind(geoRow),
        nodes: 0,
        hits: 0,
        maxSessions: 0,
        firstSeen: node.first_seen,
        lastSeen: node.last_seen,
        aliveNodes: 0,
        probed: 0,
        minRtt: null,
        apps: new Set()
      };
      groups.set(prefix, agg);
    }
    agg.nodes++;
    agg.hits += node.seen_count;
    agg.maxSessions = Math.max(agg.maxSessions, node.sessions);
    agg.firstSeen = Math.min(agg.firstSeen, node.first_seen);
    agg.lastSeen = Math.max(agg.lastSeen, node.last_seen);
    if (node.alive !== null) {
      agg.probed++;
    }
    if (node.alive === 1) {
      agg.aliveNodes++;
      if (node.rtt_ms !== null) {
        agg.minRtt =
          agg.minRtt === null ? node.rtt_ms : Math.min(agg.minRtt, node.rtt_ms);
      }
    }
    if (node.app_seeder) {
      agg.apps.add(node.app_seeder);
    }
  }

  // Set -> sorted array so it serialises to JSON for the page. `network` is the
  // publishable label for the subnet — widened to a /16, with the city dropped,
  // when the /24 is a small end-user network (see publishedNetwork in db.mjs).
  // `prefix` itself is deliberately not carried into the page.
  const points = [...groups.values()].map((group) => {
    const small = isSmallEndUserNetwork({
      kind: group.kind,
      count: group.nodes
    });
    const { prefix, ...rest } = group;
    return {
      ...rest,
      network: publishedNetwork({
        prefix,
        kind: group.kind,
        count: group.nodes
      }),
      city: small ? null : group.city,
      apps: [...group.apps].sort()
    };
  });
  const totalNodes = nodes.count();
  const located = points.reduce((sum, point) => sum + point.nodes, 0);

  // observed participants (observe.mjs) grouped by /24
  const obs = new Map();
  for (const obsRow of observations.all()) {
    const geoRow = geo.get(obsRow.prefix24);
    if (!geoRow) {
      continue;
    }
    let a = obs.get(geoRow.prefix);
    if (!a) {
      a = {
        prefix: geoRow.prefix,
        lat: geoRow.lat,
        lon: geoRow.lon,
        city: geoRow.city,
        country: geoRow.country,
        kind: hostKind(geoRow),
        apps: new Set(),
        peers: new Set()
      };
      obs.set(geoRow.prefix, a);
    }
    if (obsRow.app) {
      a.apps.add(obsRow.app);
    }
    a.peers.add(obsRow.key_hash);
  }
  const observed = [...obs.values()].map((a) => ({
    network: publishedNetwork({
      prefix: a.prefix,
      kind: a.kind,
      count: a.peers.size
    }),
    lat: a.lat,
    lon: a.lon,
    city: isSmallEndUserNetwork({ kind: a.kind, count: a.peers.size })
      ? null
      : a.city,
    country: a.country,
    kind: a.kind,
    apps: [...a.apps].sort(),
    peers: a.peers.size
  }));

  // observed participants aggregated to one bubble per country — placed at the mean
  // lat/lon of that country's observed /24s (no external boundary data needed), sized
  // by distinct participants, coloured by dominant host-type. The overview layer that
  // keeps the map readable as /24s accumulate; the per-/24 dots remain as a detail layer.
  const oc = new Map();
  for (const a of obs.values()) {
    if (!a.country) {
      continue;
    }
    let countryAgg = oc.get(a.country);
    if (!countryAgg) {
      countryAgg = {
        country: a.country,
        latSum: 0,
        lonSum: 0,
        nets: 0,
        peers: new Set(),
        kinds: {},
        apps: new Set()
      };
      oc.set(a.country, countryAgg);
    }
    countryAgg.latSum += a.lat;
    countryAgg.lonSum += a.lon;
    countryAgg.nets++;
    for (const pk of a.peers) {
      countryAgg.peers.add(pk);
    }
    countryAgg.kinds[a.kind] = (countryAgg.kinds[a.kind] || 0) + a.peers.size;
    for (const app of a.apps) {
      countryAgg.apps.add(app);
    }
  }
  const observedCountries = [...oc.values()].map((countryAgg) => ({
    country: countryAgg.country,
    lat: countryAgg.latSum / countryAgg.nets,
    lon: countryAgg.lonSum / countryAgg.nets,
    nets: countryAgg.nets,
    peers: countryAgg.peers.size,
    kind:
      Object.entries(countryAgg.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      'unknown',
    apps: [...countryAgg.apps].sort()
  }));

  console.log(
    `map: ${points.length} networks, ${located}/${totalNodes} nodes located, ${observed.length} observed-peer network(s) across ${observedCountries.length} country(ies)`
  );

  // Serialize for inlining inside a <script> tag: escape '<' so a string value
  // containing '</script>' can't close the element and inject markup.
  const jsonSafe = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>hyperdht-explorer map</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- The basemap tiles are the one thing on this page still fetched from a
       third party (they cannot be self-hosted at any sane size). no-referrer
       keeps the tile server from learning which page requested them; it still
       sees the visitor's IP, which the privacy notice discloses. -->
  <meta name="referrer" content="no-referrer" />
  <link rel="stylesheet" href="vendor/leaflet.css" />
  <link rel="stylesheet" href="vendor/MarkerCluster.css" />
  <link rel="stylesheet" href="vendor/MarkerCluster.Default.css" />
  <script src="vendor/leaflet.js"></script>
  <script src="vendor/leaflet.markercluster.js"></script>
  <style>
    html, body, #map { height: 100%; margin: 0; background: #1a1a1a; }
    /* The legend is a <details>: open on desktop, collapsed to a one-line
       summary on small screens so it stops covering the map. */
    .legend { background: #fff; border-radius: 4px; font: 12px sans-serif; line-height: 18px; }
    .legend > summary { cursor: pointer; padding: 6px 10px; font-weight: bold;
      list-style: none; display: flex; gap: 8px; align-items: center;
      justify-content: space-between; user-select: none; }
    .legend > summary:hover { background: #eee; border-radius: 4px; }
    .legend > summary::-webkit-details-marker { display: none; }
    .legend > summary::after { content: '\\25b8'; color: #666; }
    .legend[open] > summary::after { content: '\\25be'; }
    .legend-body { padding: 0 10px 8px; }
    /* one view at a time: the layer control holds radios, so give each option
       room for a title plus a line explaining what it actually plots */
    .leaflet-control-layers-base label { margin-bottom: 6px; }
    .leaflet-control-layers-base label > span { display: flex; gap: 6px; }
    .lyr { display: block; font: 12px sans-serif; max-width: 230px; }
    .lyr b { display: block; }
    .lyr small { color: #666; font-size: 11px; line-height: 14px; display: block; }
    .lyr-hint { font: 11px sans-serif; color: #666; padding: 2px 4px 6px;
      max-width: 230px; line-height: 14px; }
    .legend i { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border-radius: 50%; }
    .leaflet-popup-content { font: 12px/1.4 sans-serif; }

    /* Phone-sized screens: shrink the two overlays and cap how much of the
       viewport they can eat. Both stay scrollable rather than overflowing. */
    @media (max-width: 700px) {
      .legend { font-size: 11px; line-height: 15px; max-width: 62vw; }
      .legend[open] .legend-body { max-height: 42vh; overflow-y: auto; }
      .legend i { width: 10px; height: 10px; margin-right: 4px; }
      .leaflet-control-layers-expanded { max-width: 66vw; max-height: 52vh; overflow-y: auto; }
      /* titles are enough when space is scarce; the descriptions stay on desktop */
      .lyr { font-size: 12px; max-width: none; }
      .lyr small, .lyr-hint { display: none; }
      .leaflet-popup-content { max-width: 66vw; }
      .leaflet-control-attribution { font-size: 9px; }
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const POINTS = ${jsonSafe(points)};
    const OBSERVED = ${jsonSafe(observed)};
    const OBSERVED_COUNTRIES = ${jsonSafe(observedCountries)};
    const KIND_COLOR = { residential: '#b6ff3c', mobile: '#4cd9ff', datacenter: '#5f7d6e', proxy: '#ff2bd6', unknown: '#5f7d6e' };

    // preferCanvas: draw circleMarkers into one <canvas> instead of one SVG
    // <path> element each. With thousands of /24 dots the DOM node count is
    // what makes zoom/pan stutter and holds the memory; canvas is flat cost.
    const map = L.map('map', { worldCopyJump: true, preferCanvas: true })
      .setView([20, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO &middot; <a href="privacy.html">privacy</a>',
      subdomains: 'abcd', maxZoom: 19
    }).addTo(map);

    // colour by stability (distinct sessions seen)
    function color(sessions) {
      if (sessions >= 10) return '#2ecc71';
      if (sessions >= 5)  return '#a3e635';
      if (sessions >= 3)  return '#f1c40f';
      if (sessions >= 2)  return '#e67e22';
      return '#e74c3c';
    }
    function ago(ms) {
      const s = Math.round((Date.now() - ms) / 1000);
      if (s < 3600) return Math.round(s/60) + 'm';
      if (s < 86400) return Math.round(s/3600) + 'h';
      return Math.round(s/86400) + 'd';
    }
    // human duration for a span in ms (e.g. observed uptime = last_seen - first_seen)
    function dur(ms) {
      const s = Math.round(ms / 1000);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.round(s/60) + 'm';
      if (s < 86400) return (s/3600).toFixed(1) + 'h';
      return (s/86400).toFixed(1) + 'd';
    }

    // HTML-escape untrusted strings (whois isp/org/city, app tags) before they
    // go into popup innerHTML, so operator names can't inject markup/scripts.
    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function popupHtml(p, probeLine) {
      return '<b>' + esc(p.city || '?') + ', ' + esc(p.country || '?') + '</b><br>' +
        'network <code>' + esc(p.network) + '</code><br>' +
        (p.isp ? esc(p.isp) + '<br>' : '') +
        (p.org && p.org !== p.isp ? '<i>' + esc(p.org) + '</i><br>' : '') +
        '<hr style="margin:4px 0">' +
        p.nodes + ' node(s) &middot; ' + p.hits + ' sightings<br>' +
        'up to ' + p.maxSessions + ' session(s) &middot; last seen ' + ago(p.lastSeen) + ' ago<br>' +
        'uptime ' + dur(p.lastSeen - p.firstSeen) + ' (first→last seen)<br>' +
        '<b>' + probeLine + '</b>' +
        (p.apps.length ? '<br>★ seeds: <b>' + esc(p.apps.join(', ')) + '</b>' : '');
    }

    const cluster = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      chunkedLoading: true
    });
    const seederLayer = L.layerGroup();  // highlight rings, toggleable on their own
    const nodeMarkers = [];

    // Same lazy-popup treatment as the observed layer: the crawl's /24 count
    // grows the same way, so don't build a string per marker up front.
    function nodePopup(layer) {
      return popupHtml(layer.point, layer.probeLine);
    }

    for (const p of POINTS) {
      // grey out networks that were probed but had nothing answer; otherwise
      // colour by stability (sessions seen)
      const reachable = p.probed > 0 && p.aliveNodes > 0;
      const dead = p.probed > 0 && p.aliveNodes === 0;
      const c = dead ? '#777' : color(p.maxSessions);
      const probeLine = p.probed === 0
        ? 'not yet probed'
        : (reachable
            ? p.aliveNodes + '/' + p.nodes + ' reachable' + (p.minRtt !== null ? ' &middot; ' + p.minRtt + 'ms' : '')
            : 'unreachable (' + p.probed + ' probed)');
      const r = 4 + Math.min(12, Math.log2(p.nodes + 1) * 2);

      const marker = L.circleMarker([p.lat, p.lon], {
        radius: r, color: c, fillColor: c, fillOpacity: dead ? 0.3 : 0.6, weight: 1
      });
      marker.point = p;
      marker.probeLine = probeLine;
      marker.bindPopup(nodePopup);
      nodeMarkers.push(marker);

      // App seeders on their own layer. Since views are exclusive, this layer
      // has to stand alone: draw a filled dot (stability colour, as in the base
      // view) with a magenta outline marking it as a seeder — not a bare ring,
      // which would have nothing underneath it.
      if (p.apps.length) {
        const seeder = L.circleMarker([p.lat, p.lon], {
          radius: r, color: '#ff2bd6', fillColor: c,
          fillOpacity: dead ? 0.3 : 0.75, weight: 2
        });
        seeder.point = p;
        seeder.probeLine = probeLine;
        seeder.bindPopup(nodePopup);
        seeder.addTo(seederLayer);
      }
    }
    cluster.addLayers(nodeMarkers);  // bulk add, one index build
    map.addLayer(cluster); // the only layer on by default — plain DHT nodes

    // Observed participants (observe.mjs), one dot per /24 — the layer that
    // grows without bound as observe runs accumulate. Clustered rather than a
    // plain layerGroup: markerClusterGroup only keeps markers inside the
    // current viewport attached (removeOutsideVisibleBounds, on by default),
    // so pan/zoom cost tracks what's on screen, not the total marker count.
    const observedLayer = L.markerClusterGroup({
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      chunkedLoading: true  // add in timed chunks; keeps the first paint responsive
    });

    // One shared popup builder, called on click. Binding a prebuilt string per
    // marker would build and retain thousands of HTML strings at load time.
    function observedPopup(layer) {
      const row = layer.observed;
      return '<b>' + esc(row.city || '?') + ', ' + esc(row.country || '?') + '</b><br>' +
        'network <code>' + esc(row.network) + '</code> &middot; ' + esc(row.kind) + '<br>' +
        '<hr style="margin:4px 0">' +
        '👁 ' + row.peers + ' observed participant(s)<br>' +
        (row.apps.length ? 'app: <b>' + esc(row.apps.join(', ')) + '</b>' : '');
    }

    let observedPeers = 0;
    const observedMarkers = [];
    for (const row of OBSERVED) {
      observedPeers += row.peers;
      const marker = L.circleMarker([row.lat, row.lon], {
        radius: 5 + Math.min(10, Math.log2(row.peers + 1) * 2.5),
        color: '#ff9f1c', fillColor: '#ff9f1c', fillOpacity: 0.55, weight: 1.5
      });
      marker.observed = row;
      marker.bindPopup(observedPopup);
      observedMarkers.push(marker);
    }
    // bulk add: one index build instead of a reflow per marker
    observedLayer.addLayers(observedMarkers);

    // observed participants aggregated per country — overview layer (on by default).
    const observedCountryLayer = L.layerGroup();
    for (const c of OBSERVED_COUNTRIES) {
      const col = KIND_COLOR[c.kind] || '#ff9f1c';
      L.circleMarker([c.lat, c.lon], {
        radius: 8 + Math.min(24, Math.log2(c.peers + 1) * 4),
        color: col, fillColor: col, fillOpacity: 0.35, weight: 2
      }).bindPopup(
        '<b>' + esc(c.country) + '</b><br>' +
        '👁 ' + c.peers + ' participant(s) &middot; ' + c.nets + ' /24(s)<br>' +
        'dominant type: <b>' + esc(c.kind) + '</b><br>' +
        (c.apps.length ? 'app: <b>' + esc(c.apps.join(', ')) + '</b>' : '')
      ).addTo(observedCountryLayer);
    }
    const seederCount = POINTS.filter((p) => p.apps.length).length;

    // One view at a time: these go in the control's BASE-layer slot, so Leaflet
    // renders them as radios and swaps layers rather than stacking them. The
    // crawl's plain DHT nodes are the default view; the app/observation views
    // are opt-in because they answer a different question.
    function label(title, desc) {
      return '<span class="lyr"><b>' + title + '</b><small>' + desc + '</small></span>';
    }
    const views = {};
    views[label('DHT routing nodes (' + POINTS.length + ' networks)',
      'Every /24 the random-walk crawl has met. Colour = sessions seen, size = nodes.')] = cluster;
    views[label('★ App seeders (' + seederCount + ' networks)',
      'Only networks announcing a public app-update feed — relay endpoints of online installs.')] = seederLayer;
    views[label('🌐 Observed peers by country (' + OBSERVED_COUNTRIES.length + ')',
      'Peers that connected to us during observe runs, aggregated per country. Size = participants.')] = observedCountryLayer;
    views[label('👁 Observed peers by /24 (' + observedPeers + ')',
      'The same observed peers at network detail, one dot per /24 instead of per country.')] = observedLayer;

    // Phones: start both overlays folded away so the map itself is visible.
    const small = window.matchMedia('(max-width: 700px)').matches;

    const layerControl = L.control.layers(views, null, { collapsed: small });
    layerControl.addTo(map);

    const hint = L.DomUtil.create('div', 'lyr-hint');
    hint.textContent = 'Pick one view — the map shows a single layer at a time.';
    layerControl.getContainer().appendChild(hint);

    // On a phone the expanded control covers the map, so fold it back up once a
    // view has been picked (Leaflet only auto-collapses on mouse-out).
    if (small) {
      map.on('baselayerchange', function () {
        const el = layerControl.getContainer();
        L.DomUtil.removeClass(el, 'leaflet-control-layers-expanded');
      });
    }

    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('details', 'legend');
      // Remember whether the reader minimized it; default open on desktop,
      // minimized on phones where it would otherwise cover the map.
      // (localStorage can throw on a sandboxed file:// origin — never fatal)
      let stored = null;
      try {
        stored = localStorage.getItem('legendOpen');
      } catch (err) {
        stored = null;
      }
      div.open = stored === null ? !small : stored === '1';
      div.innerHTML = '<summary>legend</summary><div class="legend-body">' +
        '<b>sessions seen</b><br>' +
        '<i style="background:#2ecc71"></i>10+ (stable)<br>' +
        '<i style="background:#a3e635"></i>5–9<br>' +
        '<i style="background:#f1c40f"></i>3–4<br>' +
        '<i style="background:#e67e22"></i>2<br>' +
        '<i style="background:#e74c3c"></i>1 (transient)<br>' +
        '<i style="background:#777"></i>unreachable<br>' +
        '<i style="background:#a3e635;border:2px solid #ff2bd6"></i>app seeder (fill = sessions)<br>' +
        '<i style="background:#ff9f1c"></i>observed /24 (detail)<br>' +
        '<i style="background:#b6ff3c"></i>observed by country<br>' +
        '<span style="color:#5f7d6e;font-size:11px">↑ size = participants, colour = host-type</span>' +
        '</div>';
      div.addEventListener('toggle', function () {
        try {
          localStorage.setItem('legendOpen', div.open ? '1' : '0');
        } catch (err) {
          /* no persistence available; the panel still toggles */
        }
      });
      // taps on the legend must not reach the map underneath (pan/zoom)
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    legend.addTo(map);
  </script>
</body>
</html>
`;

  ensureDirs();
  ensureVendor('leaflet');
  const out = htmlPath('map.html');
  fs.writeFileSync(out, html);
  console.log(`map: wrote map.html (${points.length} markers)`);
  console.log(`open it in a browser:  file://${out}`);
  db.close();
}
