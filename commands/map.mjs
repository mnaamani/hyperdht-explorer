import process from 'bare-process'
import fs from 'bare-fs'
import { openDb, prefixOf, hostKind } from '../db.mjs'
import { htmlPath, ensureDirs } from '../paths.mjs'

// Render the discovered + geo-located nodes onto an interactive world map.
// Produces a self-contained map.html (Leaflet from CDN, data embedded inline),
// grouping nodes by /24 subnet (one marker per network). Marker colour encodes
// stability: how many distinct crawl sessions the network's nodes have appeared
// in (red = transient, green = long-lived / likely dedicated).

export function run(ctx) {
  const db = openDb()

  // geo rows keyed by /24 prefix (only successfully located networks)
  const geo = new Map()
  for (const g of db
    .prepare("SELECT * FROM geo WHERE status = 'success' AND lat IS NOT NULL")
    .all()) {
    geo.set(g.prefix, g)
  }

  // aggregate node stats per /24
  const groups = new Map()
  for (const n of db
    .prepare(
      'SELECT host, port, sessions, seen_count, first_seen, last_seen, alive, rtt_ms, app_seeder FROM nodes'
    )
    .all()) {
    const prefix = prefixOf(n.host)
    const g = geo.get(prefix)
    if (!g) continue
    let agg = groups.get(prefix)
    if (!agg) {
      agg = {
        prefix,
        lat: g.lat,
        lon: g.lon,
        city: g.city,
        country: g.country,
        isp: g.isp,
        org: g.org,
        nodes: 0,
        hits: 0,
        maxSessions: 0,
        firstSeen: n.first_seen,
        lastSeen: n.last_seen,
        aliveNodes: 0,
        probed: 0,
        minRtt: null,
        apps: new Set()
      }
      groups.set(prefix, agg)
    }
    agg.nodes++
    agg.hits += n.seen_count
    agg.maxSessions = Math.max(agg.maxSessions, n.sessions)
    agg.firstSeen = Math.min(agg.firstSeen, n.first_seen)
    agg.lastSeen = Math.max(agg.lastSeen, n.last_seen)
    if (n.alive !== null) agg.probed++
    if (n.alive === 1) {
      agg.aliveNodes++
      if (n.rtt_ms !== null) {
        agg.minRtt = agg.minRtt === null ? n.rtt_ms : Math.min(agg.minRtt, n.rtt_ms)
      }
    }
    if (n.app_seeder) agg.apps.add(n.app_seeder)
  }

  // Set -> sorted array so it serialises to JSON for the page.
  const points = [...groups.values()].map((p) => ({ ...p, apps: [...p.apps].sort() }))
  const totalNodes = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n
  const located = points.reduce((s, p) => s + p.nodes, 0)

  // observed participants (observe.mjs) grouped by /24
  const obs = new Map()
  for (const o of db.prepare('SELECT host, app, public_key FROM observations').all()) {
    const g = geo.get(prefixOf(o.host))
    if (!g) continue
    let a = obs.get(g.prefix)
    if (!a) {
      a = {
        prefix: g.prefix,
        lat: g.lat,
        lon: g.lon,
        city: g.city,
        country: g.country,
        kind: hostKind(g),
        apps: new Set(),
        peers: new Set()
      }
      obs.set(g.prefix, a)
    }
    if (o.app) a.apps.add(o.app)
    a.peers.add(o.public_key)
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
  }))

  // observed participants aggregated to one bubble per country — placed at the mean
  // lat/lon of that country's observed /24s (no external boundary data needed), sized
  // by distinct participants, coloured by dominant host-type. The overview layer that
  // keeps the map readable as /24s accumulate; the per-/24 dots remain as a detail layer.
  const oc = new Map()
  for (const a of obs.values()) {
    if (!a.country) continue
    let c = oc.get(a.country)
    if (!c) {
      c = {
        country: a.country,
        latSum: 0,
        lonSum: 0,
        nets: 0,
        peers: new Set(),
        kinds: {},
        apps: new Set()
      }
      oc.set(a.country, c)
    }
    c.latSum += a.lat
    c.lonSum += a.lon
    c.nets++
    for (const pk of a.peers) c.peers.add(pk)
    c.kinds[a.kind] = (c.kinds[a.kind] || 0) + a.peers.size
    for (const app of a.apps) c.apps.add(app)
  }
  const observedCountries = [...oc.values()].map((c) => ({
    country: c.country,
    lat: c.latSum / c.nets,
    lon: c.lonSum / c.nets,
    nets: c.nets,
    peers: c.peers.size,
    kind: Object.entries(c.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown',
    apps: [...c.apps].sort()
  }))

  console.log(
    `map: ${points.length} networks, ${located}/${totalNodes} nodes located, ${observed.length} observed-peer network(s) across ${observedCountries.length} country(ies)`
  )

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
    const POINTS = ${JSON.stringify(points)};
    const OBSERVED = ${JSON.stringify(observed)};
    const OBSERVED_COUNTRIES = ${JSON.stringify(observedCountries)};
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

    function popupHtml(p, probeLine) {
      return '<b>' + (p.city || '?') + ', ' + (p.country || '?') + '</b><br>' +
        'network <code>' + p.prefix + '.0/24</code><br>' +
        (p.isp ? p.isp + '<br>' : '') +
        (p.org && p.org !== p.isp ? '<i>' + p.org + '</i><br>' : '') +
        '<hr style="margin:4px 0">' +
        p.nodes + ' node(s) &middot; ' + p.hits + ' sightings<br>' +
        'up to ' + p.maxSessions + ' session(s) &middot; last seen ' + ago(p.lastSeen) + ' ago<br>' +
        'uptime ' + dur(p.lastSeen - p.firstSeen) + ' (first→last seen)<br>' +
        '<b>' + probeLine + '</b>' +
        (p.apps.length ? '<br>★ seeds: <b>' + p.apps.join(', ') + '</b>' : '');
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
        '<b>' + (o.city || '?') + ', ' + (o.country || '?') + '</b><br>' +
        'network <code>' + o.prefix + '.0/24</code> &middot; ' + o.kind + '<br>' +
        '<hr style="margin:4px 0">' +
        '👁 ' + o.peers + ' observed participant(s)<br>' +
        (o.apps.length ? 'app: <b>' + o.apps.join(', ') + '</b>' : '')
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
        '<b>' + c.country + '</b><br>' +
        '👁 ' + c.peers + ' participant(s) &middot; ' + c.nets + ' /24(s)<br>' +
        'dominant type: <b>' + c.kind + '</b><br>' +
        (c.apps.length ? 'app: <b>' + c.apps.join(', ') + '</b>' : '')
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
`

  ensureDirs()
  const out = htmlPath('map.html')
  fs.writeFileSync(out, html)
  console.log(`map: wrote map.html (${points.length} markers)`)
  console.log(`open it in a browser:  file://${out}`)
  db.close()
}
