import process from 'bare-process';
import fs from 'bare-fs';
import fetch from 'bare-fetch';
import {
  openDb,
  nodesRepo,
  geoRepo,
  asTopologyRepo,
  rpkiRepo,
  prefixOf,
  parseAs,
  cleanName
} from '../db.mjs';
import { htmlPath, ensureDirs } from '../paths.mjs';

// AS-level BGP topology of the networks hosting DHT nodes -> topology.html.
//
// This is the UNDERLAY view: not DHT overlay links (any node talks to any node),
// but how the ASNs our nodes live on interconnect in the global routing fabric.
// Adjacencies come from RIPEstat (OSINT, BGP-path-inferred, free/no-key) and are
// cached in as_neighbours. The graph shows our ASNs (sized by node count) plus the
// shared transit ASNs that link them, as a D3 force-directed network.
//
//   bare bin.mjs topo [--refresh] [--min-share N] [--max-connectors N]
//
// Caveat: BGP relationships are inferred/approximate and differ between sources.

export async function run(ctx) {
  const argv = ctx.argv;
  const REFRESH = argv.includes('--refresh');
  const flagNum = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? Number(argv[i + 1]) : fallback;
  };
  const MIN_SHARE = flagNum('--min-share', 3); // a transit AS must link >= this many of our ASNs
  const MAX_CONNECTORS = flagNum('--max-connectors', 20);
  const MAX_AGE = 7 * 24 * 3600 * 1000; // refetch neighbours older than a week
  const RIPE = 'https://stat.ripe.net/data';

  const sleep = (ms) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, ms));
  const db = openDb();
  const nodeRepo = nodesRepo(db);
  const geoReader = geoRepo(db);
  const asTopo = asTopologyRepo(db);
  const rpkiReader = rpkiRepo(db);

  // --- 1. our primary ASNs (with node counts + operator names) ----------------
  const geo = geoReader.locatedNetworks();

  const primaries = new Map(); // asnNum -> { asn, name, nodes }
  for (const host of nodeRepo.hosts()) {
    const geoRow = geo.get(prefixOf(host));
    if (!geoRow) {
      continue;
    }
    const as = parseAs(geoRow.as_info, geoRow.org, geoRow.isp);
    if (as.asnNum === null) {
      continue;
    }
    let prim = primaries.get(as.asnNum);
    if (!prim) {
      prim = { asn: as.asnNum, name: as.name, nodes: 0 };
      primaries.set(as.asnNum, prim);
    }
    prim.nodes++;
  }
  const primaryAsns = [...primaries.keys()];
  console.log(`topo: ${primaryAsns.length} DHT-hosting ASNs`);

  // --- 2. ensure BGP neighbour data is cached ---------------------------------
  const fresh = new Set();
  if (!REFRESH) {
    for (const row of asTopo.neighbourFreshness()) {
      if (Date.now() - row.f < MAX_AGE) {
        fresh.add(row.asn);
      }
    }
  }

  const toFetch = primaryAsns.filter((a) => !fresh.has(a));
  if (toFetch.length) {
    console.log(
      `topo: fetching BGP neighbours for ${toFetch.length} ASN(s) from RIPEstat…`
    );
  }
  for (const asn of toFetch) {
    try {
      const res = await fetch(
        `${RIPE}/asn-neighbours/data.json?resource=AS${asn}&sourceapp=hyperdht-explorer`
      );
      const json = await res.json();
      const neighbours = json?.data?.neighbours || [];
      asTopo.deleteNeighbours(asn);
      const now = Date.now();
      for (const neighbour of neighbours) {
        asTopo.insertNeighbour({
          asn,
          neighbour: neighbour.asn,
          type: neighbour.type || null,
          power: neighbour.power || 0,
          at: now
        });
      }
      console.log(`  AS${asn}: ${neighbours.length} neighbours`);
    } catch (err) {
      console.error(`  AS${asn}: fetch failed (${err.message})`);
    }
    await sleep(150);
  }

  // --- 3. build the graph -----------------------------------------------------
  const primarySet = new Set(primaryAsns);
  const neighboursOf = new Map(); // asn -> Set(neighbour)
  for (const asn of primaryAsns) {
    neighboursOf.set(asn, new Set(asTopo.neighboursOf(asn)));
  }

  const edges = new Map(); // "min-max" -> {source,target}
  const addEdge = (a, b) => {
    if (a === b) {
      return;
    }
    const k = Math.min(a, b) + '-' + Math.max(a, b);
    if (!edges.has(k)) {
      edges.set(k, { source: a, target: b });
    }
  };

  // direct adjacency among our ASNs
  for (const a of primaryAsns) {
    for (const neighbour of neighboursOf.get(a)) {
      if (primarySet.has(neighbour)) {
        addEdge(a, neighbour);
      }
    }
  }

  // shared transit connectors: non-primary ASNs adjacent to >= MIN_SHARE of ours
  const share = new Map(); // connector asn -> Set(primary)
  for (const a of primaryAsns) {
    for (const neighbour of neighboursOf.get(a)) {
      if (primarySet.has(neighbour)) {
        continue;
      }
      if (!share.has(neighbour)) {
        share.set(neighbour, new Set());
      }
      share.get(neighbour).add(a);
    }
  }
  const connectors = [...share.entries()]
    .filter(([, ps]) => ps.size >= MIN_SHARE)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, MAX_CONNECTORS);
  for (const [connectorAsn, ps] of connectors) {
    for (const a of ps) {
      addEdge(a, connectorAsn);
    }
  }

  // --- 4. names for connector ASNs (cached; fetch missing from RIPEstat) ------
  const nameCache = new Map(asTopo.names().map((row) => [row.asn, row.name]));
  for (const [connectorAsn] of connectors) {
    if (nameCache.has(connectorAsn)) {
      continue;
    }
    try {
      const res = await fetch(
        `${RIPE}/as-overview/data.json?resource=AS${connectorAsn}&sourceapp=hyperdht-explorer`
      );
      const json = await res.json();
      const holder = json?.data?.holder || null;
      nameCache.set(connectorAsn, holder);
      asTopo.insertName({ asn: connectorAsn, name: holder, at: Date.now() });
    } catch {
      nameCache.set(connectorAsn, null);
    }
    await sleep(150);
  }

  // --- 5. node + link arrays --------------------------------------------------
  // --- RPKI status per ASN (aggregated from rpki rows via geo's /24 -> ASN) ----
  const rpkiByPrefix = new Map(
    rpkiReader.statuses().map((row) => [row.prefix24, row.status])
  );
  const asnRpki = new Map(); // asnNum -> {valid, invalid, unknown, unannounced}
  for (const [prefix24, status] of rpkiByPrefix) {
    const geoRow = geo.get(prefix24);
    if (!geoRow) {
      continue;
    }
    const as = parseAs(geoRow.as_info, geoRow.org, geoRow.isp);
    if (as.asnNum === null) {
      continue;
    }
    let counts = asnRpki.get(as.asnNum);
    if (!counts) {
      counts = { valid: 0, invalid: 0, unknown: 0, unannounced: 0 };
      asnRpki.set(as.asnNum, counts);
    }
    counts[status] = (counts[status] || 0) + 1;
  }
  function rpkiClass(counts) {
    if (!counts || counts.valid + counts.invalid + counts.unknown === 0) {
      return 'none';
    }
    if (counts.invalid > 0) {
      return 'invalid';
    }
    if (counts.valid > 0 && counts.unknown > 0) {
      return 'mixed';
    }
    if (counts.valid > 0) {
      return 'valid';
    }
    return 'unknown';
  }

  // --- apps hosted per ASN (from app_seeder tags via /24 -> ASN) ---------------
  const asnApps = new Map(); // asnNum -> Set(app)
  for (const row of nodeRepo.seederHosts()) {
    const geoRow = geo.get(prefixOf(row.host));
    if (!geoRow) {
      continue;
    }
    const as = parseAs(geoRow.as_info, geoRow.org, geoRow.isp);
    if (as.asnNum === null) {
      continue;
    }
    if (!asnApps.has(as.asnNum)) {
      asnApps.set(as.asnNum, new Set());
    }
    asnApps.get(as.asnNum).add(row.app_seeder);
  }
  const allApps = [
    ...new Set([].concat(...[...asnApps.values()].map((set) => [...set])))
  ].sort();

  const nodes = [];
  for (const [asn, prim] of primaries) {
    const counts = asnRpki.get(asn) || null;
    nodes.push({
      id: asn,
      name: cleanName(prim.name) || 'AS' + asn,
      primary: true,
      weight: prim.nodes,
      rpki: rpkiClass(counts),
      rpkiCounts: counts,
      apps: [...(asnApps.get(asn) || [])]
    });
  }
  for (const [connectorAsn, ps] of connectors) {
    nodes.push({
      id: connectorAsn,
      name: cleanName(nameCache.get(connectorAsn)) || 'AS' + connectorAsn,
      primary: false,
      weight: ps.size,
      rpki: 'none',
      rpkiCounts: null,
      apps: []
    });
  }
  // only keep nodes that have at least one edge, so isolated ASNs don't clutter
  const linked = new Set();
  for (const edge of edges.values()) {
    linked.add(edge.source);
    linked.add(edge.target);
  }
  const graphNodes = nodes.filter((node) => linked.has(node.id));
  const graphLinks = [...edges.values()];

  console.log(
    `topo: graph = ${graphNodes.length} nodes (${graphNodes.filter((node) => node.primary).length} ours + ${graphNodes.filter((node) => !node.primary).length} transit), ${graphLinks.length} links`
  );

  const DATA = { nodes: graphNodes, links: graphLinks, apps: allApps };

  const BG = '#060a08';
  const PANEL = 'rgba(8,16,12,0.85)';
  const TEXT = '#eafff2';
  const MUTED = '#5f7d6e';
  const GREEN = '#b6ff3c';
  const CYAN = '#4cd9ff';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>hyperdht-explorer · BGP topology</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <style>
    html, body { margin: 0; height: 100%; background: ${BG}; color: ${TEXT};
      font-family: Inter, system-ui, -apple-system, sans-serif; overflow: hidden; }
    svg { width: 100vw; height: 100vh; display: block; }
    .panel { position: fixed; background: ${PANEL}; border: 1px solid rgba(120,200,150,0.12);
      border-radius: 10px; padding: 12px 14px; font-size: 12px; backdrop-filter: blur(4px); }
    #title { top: 16px; left: 16px; }
    #title h1 { margin: 0 0 2px; font-size: 16px; } #title h1 .accent { color: ${GREEN}; }
    #title .sub { color: ${MUTED}; max-width: 320px; line-height: 1.4; }
    #legend { bottom: 16px; left: 16px; line-height: 1.7; }
    #legend i { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 7px; }
    #controls { top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 5px; }
    #appfilter { top: 56px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 5px; flex-wrap: wrap; max-width: 80vw; }
    #controls button, #appfilter button { background: transparent; color: ${MUTED}; border: 1px solid rgba(120,200,150,0.25);
      border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
    #controls button.on, #appfilter button.on { color: ${BG}; background: ${GREEN}; border-color: ${GREEN}; font-weight: 600; }
    text { fill: ${TEXT}; font-size: 10px; pointer-events: none; }
    line.link { stroke: rgba(120,200,150,0.18); }
  </style>
</head>
<body>
  <div id="title" class="panel">
    <h1>hyperdht-explorer · <span class="accent">BGP topology</span></h1>
    <div class="sub">how the ASNs hosting DHT nodes interconnect in the global routing fabric (RIPEstat, BGP-inferred). <b>Click a green AS</b> to highlight shortest paths to the other DHT ASNs. Drag to pin, double-click to release, scroll to zoom.</div>
  </div>
  <div id="info" class="panel" style="display:none; top:16px; right:16px; max-width:300px; line-height:1.5"></div>
  <div id="legend" class="panel"></div>
  <div id="controls" class="panel">
    <span style="color:${MUTED}">colour by:</span>
    <button data-mode="role" class="on">role</button>
    <button data-mode="rpki">RPKI</button>
  </div>
  ${
    allApps.length
      ? `<div id="appfilter" class="panel">
    <span style="color:${MUTED}">app:</span>
    <button data-app="all" class="on">all</button>
    ${allApps.map((a) => `<button data-app="${a}">${a}</button>`).join('')}
  </div>`
      : ''
  }
  <svg></svg>
  <script>
    const D = ${JSON.stringify(DATA)};
    const svg = d3.select('svg');
    const W = window.innerWidth, H = window.innerHeight;
    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.2, 5]).on('zoom', (e) => g.attr('transform', e.transform)));

    const r = (n) => n.primary ? 6 + Math.sqrt(n.weight) * 1.6 : 5 + Math.sqrt(n.weight) * 1.2;

    const sim = d3.forceSimulation(D.nodes)
      .force('link', d3.forceLink(D.links).id((d) => d.id).distance(70).strength(0.12))
      .force('charge', d3.forceManyBody().strength(-480).distanceMax(700))
      .force('x', d3.forceX(W / 2).strength(0.035))
      .force('y', d3.forceY(H / 2).strength(0.035))
      .force('collide', d3.forceCollide().radius((d) => r(d) + 9));

    const link = g.append('g').selectAll('line').data(D.links).join('line').attr('class', 'link');

    let selected = null;
    let dragMoved = false;
    let colorMode = 'role'; // 'role' | 'rpki'
    let activeApp = 'all';  // app_seeder filter
    let filterSet = null;   // Set of visible node ids when an app filter is active

    const RPKI_COLORS = { valid: '#2ecc71', invalid: '#e74c3c', mixed: '#f1c40f', unknown: '#888', none: '#3a4a40' };
    function nodeColor (d) {
      if (colorMode === 'rpki') return d.primary ? (RPKI_COLORS[d.rpki] || '#555') : '#2a3a31';
      return d.primary ? '${GREEN}' : '${CYAN}';
    }

    const node = g.append('g').selectAll('g').data(D.nodes).join('g').call(
      d3.drag()
        .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; dragMoved = false; })
        .on('drag', (e, d) => { dragMoved = true; d.fx = e.x; d.fy = e.y; })
        // keep the node pinned where you drop it (don't null fx/fy) so it stays put
        .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); })
    );
    // double-click a node to release it back to the simulation
    node.on('dblclick', (e, d) => {
      e.stopPropagation();
      d.fx = null; d.fy = null;
      sim.alphaTarget(0.15).restart();
      window.setTimeout(() => sim.alphaTarget(0), 400);
    });
    node.append('circle')
      .attr('r', r)
      .attr('fill', nodeColor)
      .attr('fill-opacity', 0.85)
      .attr('stroke', '${BG}').attr('stroke-width', 1.5)
      .append('title').text((d) => 'AS' + d.id + ' · ' + d.name +
        (d.primary ? ' · ' + d.weight + ' DHT nodes' + (d.rpkiCounts ? ' · RPKI ' + d.rpki + ' (✓' + d.rpkiCounts.valid + ' ✗' + d.rpkiCounts.invalid + ' ?' + d.rpkiCounts.unknown + ')' : '') : ' · transit, links ' + d.weight + ' of ours'));
    // label shows only the ASN; the full operator name is in the hover <title>
    node.append('text')
      .attr('x', (d) => r(d) + 3).attr('y', 4)
      .text((d) => 'AS' + d.id);

    // ---- shortest-path highlighting (BFS over the BGP graph) ----------------
    const HL = '#ff2bd6';
    const info = d3.select('#info');
    const lid = (x) => (x && x.id != null) ? x.id : x;
    const ekey = (a, b) => Math.min(a, b) + '-' + Math.max(a, b);

    const adj = new Map();
    D.nodes.forEach((n) => adj.set(n.id, []));
    D.links.forEach((l) => { const s = lid(l.source), t = lid(l.target); adj.get(s).push(t); adj.get(t).push(s); });

    function shortestPaths (srcId) {
      const dist = new Map([[srcId, 0]]); const prev = new Map(); const q = [srcId];
      while (q.length) {
        const u = q.shift();
        for (const v of adj.get(u)) if (!dist.has(v)) { dist.set(v, dist.get(u) + 1); prev.set(v, u); q.push(v); }
      }
      // edgeHop maps each path edge to its hop index from the source (the deeper
      // endpoint's distance), so we can fade edges further along the path.
      const edgeHop = new Map(); const onPath = new Set([srcId]); let reached = 0; let hops = 0;
      for (const n of D.nodes) {
        if (!n.primary || n.id === srcId || !dist.has(n.id)) continue;
        reached++; hops += dist.get(n.id);
        let cur = n.id;
        while (cur !== srcId) { const p = prev.get(cur); edgeHop.set(ekey(p, cur), dist.get(cur)); onPath.add(cur); onPath.add(p); cur = p; }
      }
      return { edgeHop, onPath, reached, hops };
    }

    // edges fade as they get further (in hops) from the selected AS — sharp drop
    // after the first hop so the directly-connected edges stand out clearly.
    const hopOpacity = (h) => h === 1 ? 1 : Math.max(0.1, 0.32 - (h - 2) * 0.1);
    const hopWidth = (h) => h === 1 ? 3.5 : 1.3;

    // Restrict the graph to the ASNs hosting a given app's seeders, plus the
    // transit ASNs that interconnect them.
    function computeFilter () {
      if (activeApp === 'all') { filterSet = null; return; }
      const appPrim = new Set(D.nodes.filter((n) => n.primary && n.apps.includes(activeApp)).map((n) => n.id));
      const vis = new Set(appPrim);
      const thr = appPrim.size <= 4 ? 1 : 2; // shared-transit threshold
      for (const n of D.nodes) {
        if (n.primary) continue;
        let c = 0; for (const v of adj.get(n.id)) if (appPrim.has(v)) c++;
        if (c >= thr) vis.add(n.id);
      }
      filterSet = vis;
    }
    const inFilter = (id) => !filterSet || filterSet.has(id);

    // The resting view (no path selected): full graph, or the app-filtered subgraph.
    function applyFilterView () {
      info.style('display', 'none');
      if (activeApp === 'all') {
        link.attr('class', 'link').attr('stroke', null).attr('stroke-opacity', null).attr('stroke-width', 1);
        node.attr('opacity', 1).select('circle').attr('r', r).attr('fill', nodeColor).attr('stroke', '${BG}').attr('stroke-width', 1.5);
        node.select('text').attr('opacity', 1);
        return;
      }
      const vEdge = (d) => inFilter(lid(d.source)) && inFilter(lid(d.target));
      link.attr('class', null)
        .attr('stroke', (d) => vEdge(d) ? HL : '#243')
        .attr('stroke-opacity', (d) => vEdge(d) ? 0.6 : 0.03)
        .attr('stroke-width', (d) => vEdge(d) ? 2 : 1);
      node.attr('opacity', (d) => inFilter(d.id) ? 1 : 0.07)
        .select('circle').attr('r', r).attr('fill', nodeColor).attr('stroke', '${BG}').attr('stroke-width', 1.5);
      node.select('text').attr('opacity', (d) => inFilter(d.id) ? 1 : 0.07);
      const hosts = D.nodes.filter((n) => n.primary && n.apps.includes(activeApp)).length;
      info.style('display', 'block').html(
        '<b>' + activeApp + '</b> hosted by <b>' + hosts + '</b> AS(es) · showing them + shared transit' +
        '<br><span style="color:${MUTED}">click a node for paths, or pick "all" to reset</span>'
      );
    }

    function apply () {
      if (selected == null) { applyFilterView(); return; }
      const { edgeHop, onPath, reached, hops } = shortestPaths(selected);
      const hopOf = (d) => edgeHop.get(ekey(lid(d.source), lid(d.target)));
      link.attr('class', null)
        .attr('stroke', (d) => hopOf(d) ? HL : '#2a3a31')
        .attr('stroke-opacity', (d) => hopOf(d) ? hopOpacity(hopOf(d)) : 0.05)
        .attr('stroke-width', (d) => hopOf(d) ? hopWidth(hopOf(d)) : 1);
      node.attr('opacity', (d) => onPath.has(d.id) ? 1 : 0.12)
        .select('circle')
        // selected AS pops: white core, magenta ring, bigger
        .attr('r', (d) => d.id === selected ? r(d) + 3 : r(d))
        .attr('fill', (d) => d.id === selected ? '#ffffff' : nodeColor(d))
        .attr('stroke', (d) => d.id === selected ? HL : '${BG}')
        .attr('stroke-width', (d) => d.id === selected ? 3.5 : 1.5);
      const total = D.nodes.filter((n) => n.primary).length - 1;
      info.style('display', 'block').html(
        '<b>AS' + selected + '</b> · shortest BGP paths to <b>' + reached + '/' + total +
        '</b> other DHT-hosting ASNs' + (reached ? ' · avg <b>' + (hops / reached).toFixed(1) + '</b> hops' : '') +
        '<br><span style="color:${MUTED}">click empty space to clear</span>'
      );
    }

    node.style('cursor', (d) => d.primary ? 'pointer' : 'default')
      .on('click', (e, d) => {
        e.stopPropagation();
        if (dragMoved) { dragMoved = false; return; }
        if (!d.primary) return; // only DHT-hosting ASNs are selectable
        selected = (selected === d.id) ? null : d.id;
        apply();
      });
    svg.on('click', () => { selected = null; apply(); });

    // colour-mode legend + toggle
    function renderLegend () {
      const el = document.getElementById('legend');
      if (colorMode === 'rpki') {
        el.innerHTML =
          '<div><b>RPKI route-origin</b></div>' +
          '<div><i style="background:' + RPKI_COLORS.valid + '"></i>valid</div>' +
          '<div><i style="background:' + RPKI_COLORS.invalid + '"></i>invalid</div>' +
          '<div><i style="background:' + RPKI_COLORS.mixed + '"></i>mixed (valid + unknown)</div>' +
          '<div><i style="background:' + RPKI_COLORS.unknown + '"></i>unknown (no ROA)</div>' +
          '<div><i style="background:' + RPKI_COLORS.none + '"></i>n/a (transit / no data)</div>';
      } else {
        el.innerHTML =
          '<div><i style="background:${GREEN}"></i>DHT-hosting AS (size = node count)</div>' +
          '<div><i style="background:${CYAN}"></i>shared transit AS (links ≥${MIN_SHARE} of ours)</div>';
      }
    }
    renderLegend();
    document.querySelectorAll('#controls button').forEach((b) => {
      b.addEventListener('click', () => {
        colorMode = b.dataset.mode;
        document.querySelectorAll('#controls button').forEach((x) => x.classList.toggle('on', x === b));
        renderLegend();
        apply(); // recolour, respecting any active selection
      });
    });
    // app filter
    document.querySelectorAll('#appfilter button').forEach((b) => {
      b.addEventListener('click', () => {
        activeApp = b.dataset.app;
        document.querySelectorAll('#appfilter button').forEach((x) => x.classList.toggle('on', x === b));
        selected = null;   // clear any path selection so the filter view shows
        computeFilter();
        apply();
      });
    });

    sim.on('tick', () => {
      link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
      node.attr('transform', (d) => 'translate(' + d.x + ',' + d.y + ')');
    });
  </script>
</body>
</html>
`;

  ensureDirs();
  const out = htmlPath('topology.html');
  fs.writeFileSync(out, html);
  console.log('topo: wrote topology.html');
  console.log(`open it in a browser:  file://${out}`);
  db.close();
}
