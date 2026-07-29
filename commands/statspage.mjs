import fs from 'bare-fs';
import { htmlPath, ensureDirs } from '../paths.mjs';
import { collect, fmtBytes, fmtAgo, fmtTime, fmtPct } from './dbreport.mjs';

// Render stats.html — the same report `stats` prints to a terminal, as a page.
//
// This is the instrument panel rather than an analysis: how big the database
// is, what each collector last wrote and when, and the headline numbers from
// the most recent scan / storeprobe / traffic run. It answers "is this
// deployment actually healthy and up to date" at a glance, which is exactly the
// question a published report can't answer about itself.
//
// Fully self-contained: no chart library, no CDN. The one bar chart (the RPC
// command mix) is CSS widths, which is all a single-series breakdown needs.

// --- theme (matches index.mjs / privacy.mjs) ----------------------------------
const BG = '#060a08';
const PANEL = 'rgba(8,16,12,0.82)';
const TEXT = '#eafff2';
const MUTED = '#5f7d6e';
const GRID = 'rgba(120,200,150,0.10)';
const ACCENT = '#b6ff3c';
const CYAN = '#4cd9ff';

// Freshness thresholds (ms) for the collector traffic-light dots. Generous:
// these say "a scheduler has stopped", not "a run is a few minutes late".
const FRESH_MS = 2 * 3600 * 1000;
const STALE_MS = 24 * 3600 * 1000;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function freshness(ts) {
  if (!ts) {
    return 'gone';
  }
  const age = Date.now() - ts;
  if (age < FRESH_MS) {
    return 'ok';
  }
  return age < STALE_MS ? 'warn' : 'gone';
}

function statCard(label, value, sub) {
  return (
    `<div class="stat"><div class="num">${esc(value)}</div>` +
    `<div class="lbl">${esc(label)}</div>` +
    (sub ? `<div class="sub2">${esc(sub)}</div>` : '') +
    `</div>`
  );
}

function rowsTable(rows) {
  const body = rows
    .map(
      (row) =>
        `<tr><td><code>${esc(row.table)}</code></td>` +
        `<td class="num">${row.count.toLocaleString('en-US')}</td></tr>`
    )
    .join('\n        ');
  return `<table><tr><th>table</th><th class="num">rows</th></tr>
        ${body}
      </table>`;
}

// One line per collector: what it is, when it last wrote, and a dot that goes
// amber then red as that recedes. `never` reads as red on purpose — a collector
// that has never run is not a healthy deployment, it is an unconfigured one.
function collectorsTable(report) {
  const entries = [
    {
      name: 'scan',
      what: 'random-walk crawl → nodes, snapshots',
      ts: report.snapshot?.ts
    },
    {
      name: 'probe',
      what: 'liveness + RTT ping of known nodes',
      ts: report.breakdown.last_ping
    },
    {
      name: 'storeprobe',
      what: 'canary records → storage decay curve',
      ts: report.storeProbe?.ts
    },
    {
      name: 'traffic',
      what: 'inbound RPC load as a routing node',
      ts: report.traffic?.ts
    }
  ];
  const body = entries
    .map(
      (entry) =>
        `<tr><td><span class="dot ${freshness(entry.ts)}"></span>` +
        `<code>${esc(entry.name)}</code></td>` +
        `<td>${esc(entry.what)}</td>` +
        `<td class="num" title="${esc(fmtTime(entry.ts))}">` +
        `${esc(fmtAgo(entry.ts))}</td></tr>`
    )
    .join('\n        ');
  return `<table><tr><th>collector</th><th>what it writes</th>
        <th class="num">last run</th></tr>
        ${body}
      </table>`;
}

// Target diversity, as a count and the requests-per-target ratio it implies.
// NULL targets means the run predates the measurement (not that it saw none),
// so the row is omitted rather than shown as zero.
function targetsRow(report) {
  const traffic = report.traffic;
  if (traffic.targets === null || traffic.targets === undefined) {
    return '';
  }
  const ratio = report.trafficPerTarget;
  return `<tr><th>distinct targets</th><td>${traffic.targets.toLocaleString('en-US')}
          different topics or records asked for, across
          ${(traffic.target_requests ?? 0).toLocaleString('en-US')} application
          request(s)${
            ratio
              ? ` — ${ratio.toFixed(1)} per target, so ${
                  ratio < 1.5
                    ? 'largely one-off lookups'
                    : 'repeat demand for a smaller set'
                }`
              : ''
          }. Counted by one-way fingerprint under a per-run secret: the targets
          themselves are not stored, here or anywhere.</td></tr>`;
}

function trafficSection(report) {
  const traffic = report.traffic;
  if (!traffic) {
    return `<p class="empty">No traffic measurement yet — run
        <code>hyperdht-explorer traffic</code> (≈60 min) and regenerate.</p>`;
  }
  const max = report.trafficMix.length ? report.trafficMix[0].count : 1;
  const bars = report.trafficMix
    .map(
      (entry) =>
        `<div class="bar-row">
          <div class="bar-lbl"><code>${esc(entry.name)}</code>
            <span class="kind ${esc(entry.kind)}">${esc(entry.kind)}</span></div>
          <div class="bar-track"><div class="bar ${esc(entry.kind)}"
            style="width:${((entry.count / max) * 100).toFixed(1)}%"></div></div>
          <div class="bar-num">${entry.count.toLocaleString('en-US')}
            <span class="pct">${esc(fmtPct(entry.share))}</span></div>
        </div>`
    )
    .join('\n        ');

  const caveat = traffic.persistent
    ? ''
    : `<div class="box warn">This run never became routable${
        traffic.firewalled ? ' (the NAT check found us firewalled)' : ''
      }, so almost no inbound work reached it. That is a property of the host
      this ran on, not of the DHT.</div>`;

  return `${caveat}
      <table class="kv">
        <tr><th>window</th><td>${(traffic.duration_s / 60).toFixed(0)} minutes,
          ending ${esc(fmtAgo(traffic.ts + traffic.duration_s * 1000))}</td></tr>
        <tr><th>inbound requests</th><td>${traffic.requests.toLocaleString('en-US')}
          (${report.trafficPerMin.toFixed(1)}/min)</td></tr>
        <tr><th>distinct networks</th><td>${traffic.sources.toLocaleString('en-US')}
          /24s sent us at least one request</td></tr>
        ${targetsRow(report)}
        <tr><th>routable</th><td>${traffic.persistent ? 'yes' : 'no'}</td></tr>
      </table>
      <div class="bars">
        ${bars || '<p class="empty">No requests counted in this window.</p>'}
      </div>`;
}

export function run() {
  const report = collect();
  const snap = report.snapshot;
  const probe = report.storeProbe;

  const stats = [
    statCard('hosts known', report.nodesHosts.toLocaleString('en-US')),
    statCard(
      'endpoints (host:port)',
      report.nodesTotal.toLocaleString('en-US'),
      'one host may rebind many ports'
    ),
    statCard(
      'alive at last probe',
      (report.breakdown.alive ?? 0).toLocaleString('en-US')
    ),
    statCard('countries', snap?.countries ?? '—'),
    statCard('networks (ASN)', snap?.asns ?? '—'),
    statCard('app seeders', report.breakdown.seeders ?? 0),
    statCard('peers observed', snap?.observed ?? '—'),
    statCard(
      'inbound req/min',
      report.trafficPerMin === null ? '—' : report.trafficPerMin.toFixed(1),
      report.traffic
        ? `over ${(report.traffic.duration_s / 60).toFixed(0)}m`
        : null
    ),
    statCard(
      'distinct targets',
      report.traffic?.targets ?? '—',
      report.trafficPerTarget
        ? `${report.trafficPerTarget.toFixed(1)} req/target`
        : null
    ),
    statCard('database', fmtBytes(report.size.total))
  ].join('\n      ');

  const snapRow = snap
    ? `<table class="kv">
        <tr><th>taken</th><td>${esc(fmtTime(snap.ts))}</td></tr>
        <tr><th>nodes</th><td>${snap.total_nodes} total · ${snap.alive} alive ·
          ${snap.new_nodes} new · ${snap.pruned} pruned</td></tr>
        <tr><th>spread</th><td>${snap.countries} countries · ${snap.asns} ASNs ·
          ${snap.seeders} seeders</td></tr>
        <tr><th>median RTT</th><td>${snap.median_rtt ?? '—'} ms</td></tr>
        <tr><th>observed peers</th><td>${snap.observed ?? '—'}</td></tr>
      </table>`
    : `<p class="empty">No scan snapshot yet — run
        <code>hyperdht-explorer scan</code> and regenerate.</p>`;

  const probeRow = probe
    ? `<table class="kv">
        <tr><th>taken</th><td>${esc(fmtTime(probe.ts))}</td></tr>
        <tr><th>canaries</th><td>${probe.canaries} put · ${probe.put_ok} accepted ·
          ${probe.get_ok} retrievable</td></tr>
        <tr><th>replicas</th><td>${(probe.replicas_initial ?? 0).toFixed(1)} at t=0 →
          ${(probe.replicas_after ?? 0).toFixed(1)} after
          ${Math.round((probe.delay_s ?? 0) / 60)} min</td></tr>
        <tr><th>persistence</th><td>${esc(fmtPct(probe.persistence))} survived the
          ~20-min record TTL</td></tr>
      </table>`
    : `<p class="empty">No storage probe yet — run
        <code>hyperdht-explorer storeprobe</code> (≈22 min) and regenerate.</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>hyperdht-explorer · stats</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; min-height: 100%; background: ${BG};
      color: ${TEXT}; font-family: Inter, system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 40px 22px 64px; }
    a { color: ${ACCENT}; }
    h1 { font-size: 25px; font-weight: 600; margin: 0 0 6px; }
    h1 .accent { color: ${ACCENT}; }
    h2 { font-size: 16px; font-weight: 600; margin: 34px 0 10px;
      padding-top: 14px; border-top: 1px solid ${GRID}; }
    p { font-size: 14px; line-height: 1.7; color: #cfe8dc; }
    .nav { font-size: 12.5px; color: ${MUTED}; margin-bottom: 26px; }
    .lede { color: ${MUTED}; font-size: 14px; line-height: 1.7; margin: 0 0 8px; }
    .note { color: ${MUTED}; font-size: 12.5px; line-height: 1.6;
      margin: -2px 0 12px; }
    code { font-size: 12.5px; color: ${ACCENT}; }
    .stats { display: grid; gap: 10px; margin: 26px 0 8px;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .stat { background: ${PANEL}; border: 1px solid ${GRID};
      border-radius: 10px; padding: 14px 16px; }
    .stat .num { font-size: 22px; font-weight: 600; color: ${ACCENT}; }
    .stat .lbl { color: ${MUTED}; font-size: 12px; margin-top: 2px; }
    .stat .sub2 { color: ${MUTED}; font-size: 11px; opacity: .7; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0 4px;
      font-size: 13px; }
    th, td { text-align: left; padding: 7px 10px; vertical-align: top;
      border-bottom: 1px solid ${GRID}; color: #cfe8dc; }
    th { color: ${MUTED}; font-weight: 500; font-size: 11.5px;
      text-transform: uppercase; letter-spacing: .4px; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.kv th { width: 34%; text-transform: none; letter-spacing: 0;
      font-size: 12.5px; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      margin-right: 8px; vertical-align: middle; }
    .dot.ok { background: ${ACCENT}; }
    .dot.warn { background: #e8c65a; }
    .dot.gone { background: #d2685f; }
    .box { background: ${PANEL}; border: 1px solid ${GRID};
      border-radius: 10px; padding: 14px 18px; margin: 16px 0;
      font-size: 13.5px; line-height: 1.65; color: #cfe8dc; }
    .box.warn { border-color: rgba(232,198,90,.35); }
    .empty { color: ${MUTED}; font-size: 13px; padding: 14px 0; }
    .bars { margin-top: 14px; }
    .bar-row { display: grid; grid-template-columns: 190px 1fr 110px;
      gap: 10px; align-items: center; padding: 3px 0; }
    .bar-lbl { font-size: 12.5px; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .kind { font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px;
      padding: 2px 6px; border-radius: 999px; border: 1px solid ${GRID};
      color: ${MUTED}; margin-left: 6px; }
    .bar-track { background: rgba(120,200,150,0.07); border-radius: 4px;
      height: 14px; overflow: hidden; }
    .bar { height: 100%; border-radius: 4px; }
    .bar.internal { background: ${CYAN}; }
    .bar.external { background: ${ACCENT}; }
    .bar-num { font-size: 12px; text-align: right;
      font-variant-numeric: tabular-nums; color: #cfe8dc; }
    .bar-num .pct { color: ${MUTED}; margin-left: 6px; }
    @media (max-width: 620px) {
      .bar-row { grid-template-columns: 130px 1fr 80px; }
      .kind { display: none; }
    }
    footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid ${GRID};
      color: ${MUTED}; font-size: 12px; line-height: 1.7; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="nav"><a href="index.html">← hyperdht-explorer</a></div>

    <h1>hyperdht-explorer · <span class="accent">stats</span></h1>
    <p class="lede">
      The state of this deployment: what each collector last wrote, how big the
      database is, and the headline numbers from the most recent run of each.
      Generated ${esc(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))}.
    </p>

    <div class="stats">
      ${stats}
    </div>

    <h2>Collectors</h2>
    <p class="note">Each runs on its own schedule. A red dot means the last
      write is over a day old (or has never happened) — usually a stopped cron
      job rather than anything about the network.</p>
      ${collectorsTable(report)}

    <h2>Last crawl</h2>
      ${snapRow}

    <h2>Inbound request load</h2>
    <p class="note">Measured by being an ordinary routing node and counting the
      requests other peers send us. This is the only measurement here of
      <em>demand</em> — every other number counts how many nodes exist, not
      whether anyone is using them. <strong>Count-only:</strong> requests are
      tallied by command, and targets are counted for distinctness through a
      one-way fingerprint keyed by a secret that is random per run and never
      written down. So this can say how <em>many</em> different things were
      asked for, and never <em>which</em> — no record of what anyone is looking
      up is kept, or could be reconstructed from what is.</p>
      ${trafficSection(report)}

    <h2>Storage health</h2>
    <p class="note">Canary records put into the DHT and re-polled across
      hyperdht's ~20-minute record TTL.</p>
      ${probeRow}

    <h2>Database</h2>
    <p class="note"><code>${esc(report.path)}</code> —
      ${esc(fmtBytes(report.size.main))} plus
      ${esc(fmtBytes(report.size.wal))} write-ahead log.</p>
      ${rowsTable(report.rows)}

    <footer>
      Row counts are storage facts, not network facts: <code>nodes</code> and
      <code>observations</code> are both pruned on a retention window, so they
      describe what is currently kept rather than everything ever seen.
      <br><a href="privacy.html">Privacy notice</a> ·
      <a href="timeline.html">timeline</a> ·
      <a href="index.html">all reports</a>
    </footer>
  </div>
</body>
</html>
`;

  ensureDirs();
  const out = htmlPath('stats.html');
  fs.writeFileSync(out, html);
  console.log('stats: wrote stats.html');
  console.log(`open it in a browser:  file://${out}`);
}
