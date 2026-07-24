import process from 'bare-process';
import fs from 'bare-fs';
import {
  openDb,
  nodesRepo,
  observationsRepo,
  geoRepo,
  prefixOf,
  hostKind
} from '../db.mjs';
import { htmlPath, ensureDirs } from '../paths.mjs';

// Render the discovered + geo-located nodes onto an interactive world map.
// Produces a self-contained map.html (Leaflet from CDN, data embedded inline),
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

  // Set -> sorted array so it serialises to JSON for the page.
  const points = [...groups.values()].map((group) => ({
    ...group,
    apps: [...group.apps].sort()
  }));
  const totalNodes = nodes.count();
  const located = points.reduce((sum, point) => sum + point.nodes, 0);

  // observed participants (observe.mjs) grouped by /24
  const obs = new Map();
  for (const obsRow of observations.all()) {
    const geoRow = geo.get(prefixOf(obsRow.host));
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
    a.peers.add(obsRow.public_key);
  }
  const observed = [...obs.values()].map((a) => ({
    prefix: a.prefix,
    lat: a.lat,
    lon: a.lon,
    city: a.city,
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
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
  <style>
    html, body, #map { height: 100%; margin: 0; background: #1a1a1a; }
    .legend { background: #fff; padding: 8px 10px; border-radius: 4px; font: 12px sans-serif; line-height: 18px; }
    .legend i { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border-radius: 50%; }
    .leaflet-popup-content { font: 12px/1.4 sans-serif; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const POINTS = ${jsonSafe(points)};
    const OBSERVED = ${jsonSafe(observed)};
    const OBSERVED_COUNTRIES = ${jsonSafe(observedCountries)};
    const KIND_COLOR = { residential: '#b6ff3c', mobile: '#4cd9ff', datacenter: '#5f7d6e', proxy: '#ff2bd6', unknown: '#5f7d6e' };

    const map = L.map('map', { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19
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
        'network <code>' + esc(p.prefix) + '.0/24</code><br>' +
        (p.isp ? esc(p.isp) + '<br>' : '') +
        (p.org && p.org !== p.isp ? '<i>' + esc(p.org) + '</i><br>' : '') +
        '<hr style="margin:4px 0">' +
        p.nodes + ' node(s) &middot; ' + p.hits + ' sightings<br>' +
        'up to ' + p.maxSessions + ' session(s) &middot; last seen ' + ago(p.lastSeen) + ' ago<br>' +
        'uptime ' + dur(p.lastSeen - p.firstSeen) + ' (first→last seen)<br>' +
        '<b>' + probeLine + '</b>' +
        (p.apps.length ? '<br>★ seeds: <b>' + esc(p.apps.join(', ')) + '</b>' : '');
    }

    const cluster = L.markerClusterGroup({ maxClusterRadius: 40, spiderfyOnMaxZoom: true });
    const seederLayer = L.layerGroup();  // highlight rings, toggleable on their own

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

      L.circleMarker([p.lat, p.lon], {
        radius: r, color: c, fillColor: c, fillOpacity: dead ? 0.3 : 0.6, weight: 1
      }).bindPopup(popupHtml(p, probeLine)).addTo(cluster);

      // app seeders get a bright magenta highlight ring on their own layer
      if (p.apps.length) {
        L.circleMarker([p.lat, p.lon], {
          radius: r + 5, color: '#ff2bd6', weight: 3, fill: false
        }).bindPopup(popupHtml(p, probeLine)).addTo(seederLayer);
      }
    }
    map.addLayer(cluster);
    map.addLayer(seederLayer);

    // observed participants (observe.mjs) — orange diamonds, own toggleable layer
    const observedLayer = L.layerGroup();
    let observedPeers = 0;
    for (const o of OBSERVED) {
      observedPeers += o.peers;
      L.circleMarker([o.lat, o.lon], {
        radius: 5 + Math.min(10, Math.log2(o.peers + 1) * 2.5),
        color: '#ff9f1c', fillColor: '#ff9f1c', fillOpacity: 0.55, weight: 1.5
      }).bindPopup(
        '<b>' + esc(o.city || '?') + ', ' + esc(o.country || '?') + '</b><br>' +
        'network <code>' + esc(o.prefix) + '.0/24</code> &middot; ' + esc(o.kind) + '<br>' +
        '<hr style="margin:4px 0">' +
        '👁 ' + o.peers + ' observed participant(s)<br>' +
        (o.apps.length ? 'app: <b>' + esc(o.apps.join(', ')) + '</b>' : '')
      ).addTo(observedLayer);
    }

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
    map.addLayer(observedCountryLayer); // overview on; per-/24 detail is opt-in below

    const seederCount = POINTS.filter((p) => p.apps.length).length;
    L.control.layers(null, {
      'All networks': cluster,
      ['★ App seeders (' + seederCount + ')']: seederLayer,
      ['🌐 Observed by country (' + OBSERVED_COUNTRIES.length + ')']: observedCountryLayer,
      ['👁 Observed /24 detail (' + observedPeers + ')']: observedLayer
    }, { collapsed: false }).addTo(map);

    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'legend');
      div.innerHTML = '<b>sessions seen</b><br>' +
        '<i style="background:#2ecc71"></i>10+ (stable)<br>' +
        '<i style="background:#a3e635"></i>5–9<br>' +
        '<i style="background:#f1c40f"></i>3–4<br>' +
        '<i style="background:#e67e22"></i>2<br>' +
        '<i style="background:#e74c3c"></i>1 (transient)<br>' +
        '<i style="background:#777"></i>unreachable<br>' +
        '<i style="background:none;border:2px solid #ff2bd6"></i>app seeder<br>' +
        '<i style="background:#ff9f1c"></i>observed /24 (detail)<br>' +
        '<i style="background:#b6ff3c"></i>observed by country<br>' +
        '<span style="color:#5f7d6e;font-size:11px">↑ size = participants, colour = host-type</span>';
      return div;
    };
    legend.addTo(map);
  </script>
</body>
</html>
`;

  ensureDirs();
  const out = htmlPath('map.html');
  fs.writeFileSync(out, html);
  console.log(`map: wrote map.html (${points.length} markers)`);
  console.log(`open it in a browser:  file://${out}`);
  db.close();
}
