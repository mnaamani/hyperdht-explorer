import fs from 'bare-fs';
import { openDb, nodesRepo, snapshotsRepo } from '../db.mjs';
import { htmlPath, ensureDirs } from '../paths.mjs';

// Render index.html — the landing page that links to the other render:* reports.
//
// It is a directory, not a dashboard: a few headline numbers for freshness, then
// one card per report. Cards are generated from PAGES and each is checked against
// the filesystem, so a report that has never been rendered shows up greyed out
// with the command needed to produce it, rather than as a dead link. Fully
// self-contained (no CDN) — but note some of the pages it links to are not, which
// the page says out loud.

const PAGES = [
  {
    file: 'summary.html',
    title: 'summary',
    blurb:
      'Sortable tables by ASN / operator and /24 — who actually hosts the ' +
      'network, and what kind of host it is.',
    command: 'render:summary',
    offline: true
  },
  {
    file: 'map.html',
    title: 'world map',
    blurb:
      'Geographic distribution of discovered nodes, coloured by host type ' +
      '(datacenter / residential / mobile / proxy).',
    command: 'render:map',
    offline: false
  },
  {
    file: 'ring.html',
    title: 'keyspace ring',
    blurb:
      'Circular projection of the 256-bit id space showing distribution and ' +
      'popularity. Ring adjacency is not routing distance.',
    command: 'render:ring',
    offline: true
  },
  {
    file: 'timeline.html',
    title: 'timeline',
    blurb:
      'Time series across crawls: churn, growth, liveness, observed peers ' +
      'and storage-health decay.',
    command: 'render:timeline',
    offline: false
  },
  {
    file: 'topology.html',
    title: 'AS topology',
    blurb:
      'Force graph of the BGP/AS interconnection underlying the nodes. This ' +
      'is the underlay, not DHT overlay links.',
    command: 'render:topo',
    offline: false
  }
];

// --- theme (matches ring.mjs / map.mjs) ---------------------------------------
const BG = '#060a08';
const PANEL = 'rgba(8,16,12,0.82)';
const TEXT = '#eafff2';
const MUTED = '#5f7d6e';
const GRID = 'rgba(120,200,150,0.10)';
const ACCENT = '#b6ff3c';

function fmtAgo(ts) {
  if (!ts) {
    return 'never';
  }
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

function statCard(label, value) {
  return (
    `<div class="stat"><div class="num">${value}</div>` +
    `<div class="lbl">${label}</div></div>`
  );
}

function pageCard(page, exists) {
  const note = page.offline
    ? '<span class="tag off">self-contained</span>'
    : '<span class="tag cdn">needs internet</span>';
  if (!exists) {
    return `<div class="card missing">
      <h2>${page.title}</h2>
      <p>${page.blurb}</p>
      <div class="foot"><span class="tag gone">not rendered yet</span>
      <code>hyperdht-explorer ${page.command}</code></div>
    </div>`;
  }
  return `<a class="card" href="${page.file}">
      <h2>${page.title} <span class="arrow">→</span></h2>
      <p>${page.blurb}</p>
      <div class="foot">${note}<code>${page.file}</code></div>
    </a>`;
}

export function run() {
  const db = openDb();
  const nodes = nodesRepo(db);
  const snapshots = snapshotsRepo(db);

  const breakdown = nodes.breakdown();
  const snap = snapshots.latest();
  const total =
    (breakdown.alive ?? 0) + (breakdown.dead ?? 0) + (breakdown.unprobed ?? 0);

  const stats = [
    statCard('nodes known', total),
    statCard('alive at last probe', breakdown.alive ?? 0),
    statCard('countries', snap?.countries ?? '—'),
    statCard('networks (ASN)', snap?.asns ?? '—'),
    statCard('app seeders', breakdown.seeders ?? 0),
    statCard('peers observed', snap?.observed ?? '—')
  ].join('\n      ');

  const cards = PAGES.map((page) =>
    pageCard(page, fs.existsSync(htmlPath(page.file)))
  ).join('\n      ');

  const missing = PAGES.filter(
    (page) => !fs.existsSync(htmlPath(page.file))
  ).length;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>hyperdht-explorer</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; min-height: 100%; background: ${BG};
      color: ${TEXT}; font-family: Inter, system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 48px 22px 64px; }
    header h1 { margin: 0 0 6px; font-size: 26px; font-weight: 600;
      letter-spacing: .3px; }
    header .sub { color: ${MUTED}; font-size: 14px; line-height: 1.6; }
    .accent { color: ${ACCENT}; }
    .stats { display: grid; gap: 10px; margin: 28px 0 34px;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
    .stat { background: ${PANEL}; border: 1px solid ${GRID};
      border-radius: 10px; padding: 14px 16px; }
    .stat .num { font-size: 22px; font-weight: 600; color: ${ACCENT}; }
    .stat .lbl { color: ${MUTED}; font-size: 12px; margin-top: 2px; }
    .cards { display: grid; gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); }
    .card { display: block; background: ${PANEL}; border: 1px solid ${GRID};
      border-radius: 12px; padding: 18px 20px; text-decoration: none;
      color: ${TEXT}; transition: border-color .15s, transform .15s; }
    a.card:hover { border-color: ${ACCENT}; transform: translateY(-2px); }
    .card h2 { margin: 0 0 6px; font-size: 17px; font-weight: 600; }
    .card p { margin: 0 0 14px; color: ${MUTED}; font-size: 13px;
      line-height: 1.55; }
    .card .arrow { color: ${ACCENT}; opacity: 0; transition: opacity .15s; }
    a.card:hover .arrow { opacity: 1; }
    .foot { display: flex; align-items: center; justify-content: space-between;
      gap: 8px; flex-wrap: wrap; }
    .foot code { color: ${MUTED}; font-size: 11px; }
    .tag { font-size: 10.5px; padding: 3px 8px; border-radius: 999px;
      border: 1px solid ${GRID}; color: ${MUTED}; white-space: nowrap; }
    .tag.off { color: #8ef94b; border-color: rgba(142,249,75,.28); }
    .tag.cdn { color: #e8c65a; border-color: rgba(232,198,90,.28); }
    .tag.gone { color: #d2685f; border-color: rgba(210,104,95,.3); }
    .card.missing { opacity: .5; }
    footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid ${GRID};
      color: ${MUTED}; font-size: 12px; line-height: 1.7; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>hyperdht-explorer · <span class="accent">network health</span></h1>
      <div class="sub">
        Aggregate health and topology of the hyperdht network, from a
        random-walk crawl of routing nodes.<br>
        Last crawl ${fmtAgo(snap?.ts)} · last probe ${fmtAgo(breakdown.last_ping)}
      </div>
    </header>

    <div class="stats">
      ${stats}
    </div>

    <div class="cards">
      ${cards}
    </div>

    <footer>
      Counts are what this crawler has <em>seen</em>, not a census — the DHT is
      deliberately non-enumerable, so nodes are discovered by random walk and
      seeders are only those announcing a known public app key. Node ids are
      <code>hash(ip:port)</code>, not connectable identities. IPv4 only: the
      protocol carries no IPv6 addresses at the routing layer.
      Pages marked <span class="tag cdn">needs internet</span> load Chart.js,
      D3 or map tiles from a CDN at view time.
    </footer>
  </div>
</body>
</html>
`;

  ensureDirs();
  const out = htmlPath('index.html');
  fs.writeFileSync(out, html);
  console.log(
    `index: linked ${PAGES.length - missing}/${PAGES.length} report(s)` +
      (missing ? `, ${missing} not rendered yet` : '')
  );
  console.log(`index: wrote index.html`);
  console.log(`open it in a browser:  file://${out}`);
  db.close();
}
