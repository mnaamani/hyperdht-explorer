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
      'Time series across crawls: churn, growth, liveness, observed peers, ' +
      'storage-health decay and inbound request load.',
    command: 'render:timeline',
    offline: true
  },
  {
    file: 'topology.html',
    title: 'AS topology',
    blurb:
      'Force graph of the BGP/AS interconnection underlying the nodes. This ' +
      'is the underlay, not DHT overlay links.',
    command: 'render:topo',
    offline: true
  },
  {
    file: 'stats.html',
    title: 'stats',
    blurb:
      'Deployment status: what each collector last wrote, database size, and ' +
      'the inbound RPC load this node carries.',
    command: 'render:stats',
    offline: true
  },
  {
    file: 'privacy.html',
    title: 'privacy notice',
    blurb:
      'What is collected about network participants and site visitors, why, ' +
      'how long it is kept, and how to be excluded.',
    command: 'render:privacy',
    offline: true
  }
];

// --- theme (matches ring.mjs / map.mjs) ---------------------------------------
const BG = '#060a08';
const PANEL = 'rgba(8,16,12,0.82)';
const TEXT = '#eafff2';
const MUTED = '#5f7d6e';
const GRID = 'rgba(120,200,150,0.10)';
const ACCENT = '#b6ff3c';
const REPO_URL = 'https://github.com/mnaamani/hyperdht-explorer';

// GitHub mark, inlined so the page stays self-contained (no CDN, no image file).
const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" ' +
  'fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 ' +
  '5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-' +
  '2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 ' +
  '1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-' +
  '3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 ' +
  '2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 ' +
  '2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 ' +
  '3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55 ' +
  '.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

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
    .banner { position: sticky; top: 0; z-index: 5; background: ${PANEL};
      backdrop-filter: blur(8px); border-bottom: 1px solid ${GRID}; }
    .banner-in { max-width: 980px; margin: 0 auto; padding: 12px 22px;
      display: flex; align-items: center; justify-content: space-between;
      gap: 14px; }
    .brand { display: flex; align-items: baseline; gap: 10px;
      font-size: 15px; font-weight: 600; letter-spacing: .3px; }
    .brand .dot { color: ${ACCENT}; }
    .brand .tagline { color: ${MUTED}; font-size: 12px; font-weight: 400; }
    .gh { display: inline-flex; align-items: center; gap: 7px; color: ${MUTED};
      text-decoration: none; font-size: 12.5px; padding: 5px 10px;
      border: 1px solid ${GRID}; border-radius: 999px;
      transition: color .15s, border-color .15s; }
    .gh:hover { color: ${ACCENT}; border-color: ${ACCENT}; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 40px 22px 64px; }
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
  <div class="banner">
    <div class="banner-in">
      <div class="brand">
        hyperdht<span class="dot">·</span>explorer
        <span class="tagline">network health reports</span>
      </div>
      <a class="gh" href="${REPO_URL}" target="_blank" rel="noopener"
         title="source on GitHub">${GITHUB_ICON}<span>GitHub</span></a>
    </div>
  </div>

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
      Pages marked <span class="tag cdn">needs internet</span> load map tiles
      from a third party at view time; everything else is served from here, so
      viewing a report discloses nothing to anyone else.
      <br><a href="privacy.html">Privacy notice</a> ·
      <a href="scanner.html">did a node from here contact you?</a>
      <br>Built with <a href="https://leafletjs.com" rel="noopener">Leaflet</a>,
      <a href="https://www.chartjs.org" rel="noopener">Chart.js</a> and
      <a href="https://d3js.org" rel="noopener">D3</a>, served from this site —
      licences in <code>vendor/licenses/</code>.
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
