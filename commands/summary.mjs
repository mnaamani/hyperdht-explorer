import process from 'bare-process'
import fs from 'bare-fs'
import { openDb, prefixOf, parseAs, hostKind } from '../db.mjs'
import { htmlPath, ensureDirs } from '../paths.mjs'

// Network summary -> summary.html. Two sortable/filterable tables:
//   1. by operator (ASN / org)  - the "who hosts the DHT" leaderboard
//   2. by /24 network           - detailed per-subnet breakdown
// Self-contained (no CDN), Pear-green theme.

export function run(ctx) {
  const db = openDb()

  const geo = new Map()
  for (const g of db.prepare("SELECT * FROM geo WHERE status = 'success'").all()) {
    geo.set(g.prefix, g)
  }

  const rpkiMap = new Map(
    db
      .prepare('SELECT prefix24, status FROM rpki')
      .all()
      .map((r) => [r.prefix24, r.status])
  )

  function median(arr) {
    if (!arr.length) return null
    const s = [...arr].sort((a, b) => a - b)
    return s[s.length >> 1]
  }

  // --- group by /24 -----------------------------------------------------------
  const nets = new Map()
  for (const n of db
    .prepare(
      'SELECT host, port, seen_count, sessions, first_seen, last_seen, alive, rtt_ms, app_seeder FROM nodes'
    )
    .all()) {
    const prefix = prefixOf(n.host)
    let g = nets.get(prefix)
    if (!g) {
      const ge = geo.get(prefix)
      const as = parseAs(ge?.as_info, ge?.org, ge?.isp)
      g = {
        prefix,
        city: ge?.city || null,
        country: ge?.country || null,
        asn: as.asn,
        asnNum: as.asnNum,
        operator: as.name,
        kind: hostKind(ge),
        nodes: 0,
        alive: 0,
        maxSessions: 0,
        hits: 0,
        first: n.first_seen,
        last: n.last_seen,
        rtts: [],
        seeders: new Set()
      }
      nets.set(prefix, g)
    }
    g.nodes++
    g.hits += n.seen_count
    g.maxSessions = Math.max(g.maxSessions, n.sessions)
    g.first = Math.min(g.first, n.first_seen)
    g.last = Math.max(g.last, n.last_seen)
    if (n.alive === 1) {
      g.alive++
      if (n.rtt_ms !== null) g.rtts.push(n.rtt_ms)
    }
    if (n.app_seeder) g.seeders.add(n.app_seeder)
  }

  const networks = [...nets.values()]
    .map((g) => ({
      prefix: g.prefix,
      city: g.city,
      country: g.country,
      asn: g.asn,
      asnNum: g.asnNum,
      operator: g.operator,
      kind: g.kind,
      nodes: g.nodes,
      alive: g.alive,
      maxSessions: g.maxSessions,
      hits: g.hits,
      uptimeMs: g.last - g.first,
      medianRtt: median(g.rtts),
      rpki: rpkiMap.get(g.prefix) || null,
      seeds: [...g.seeders].sort().join(',')
    }))
    .sort((a, b) => b.nodes - a.nodes)

  // --- group by operator ------------------------------------------------------
  const ops = new Map()
  for (const net of networks) {
    const key = net.asn || net.operator || '(unlocated)'
    let o = ops.get(key)
    if (!o) {
      o = {
        asn: net.asn,
        asnNum: net.asnNum,
        operator: net.operator || '(unlocated)',
        nodes: 0,
        alive: 0,
        subnets: 0,
        countries: new Set(),
        rtts: [],
        seederSubnets: 0,
        rpki: { valid: 0, invalid: 0, unknown: 0 },
        kinds: {}
      }
      ops.set(key, o)
    }
    if (!o.operator || o.operator === '(unlocated)') if (net.operator) o.operator = net.operator
    o.nodes += net.nodes
    o.alive += net.alive
    o.subnets++
    if (net.country) o.countries.add(net.country)
    if (net.medianRtt !== null) o.rtts.push(net.medianRtt)
    if (net.seeds) o.seederSubnets++
    if (net.rpki && o.rpki[net.rpki] !== undefined) o.rpki[net.rpki]++
    if (net.kind) o.kinds[net.kind] = (o.kinds[net.kind] || 0) + 1
  }
  const dominant = (kinds) => Object.entries(kinds).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown'
  const operators = [...ops.values()]
    .map((o) => ({
      asn: o.asn,
      asnNum: o.asnNum,
      operator: o.operator,
      nodes: o.nodes,
      alive: o.alive,
      subnets: o.subnets,
      countries: o.countries.size,
      medianRtt: median(o.rtts),
      seederSubnets: o.seederSubnets,
      rpki: o.rpki,
      kind: dominant(o.kinds)
    }))
    .sort((a, b) => b.nodes - a.nodes)

  const totals = {
    nodes: networks.reduce((s, n) => s + n.nodes, 0),
    alive: networks.reduce((s, n) => s + n.alive, 0),
    subnets: networks.length,
    operators: operators.length,
    countries: new Set(networks.map((n) => n.country).filter(Boolean)).size
  }

  console.log(
    `summary: ${totals.nodes} nodes, ${totals.subnets} /24s, ${totals.operators} operators, ${totals.countries} countries`
  )

  // --- helpers for cell rendering (value + sort key) --------------------------
  function dur(ms) {
    const s = Math.round(ms / 1000)
    if (s < 3600) return Math.round(s / 60) + 'm'
    if (s < 86400) return (s / 3600).toFixed(1) + 'h'
    return (s / 86400).toFixed(1) + 'd'
  }
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const td = (v, sort) => `<td data-v="${esc(sort ?? v)}">${esc(v)}</td>`
  const tdNum = (v, fmt) =>
    `<td data-v="${v ?? -1}">${v === null ? '–' : esc(fmt ? fmt(v) : v)}</td>`

  const KIND_COLOR = {
    datacenter: '#5f7d6e',
    residential: '#b6ff3c',
    mobile: '#4cd9ff',
    proxy: '#ff2bd6',
    unknown: '#5f7d6e'
  }
  function tdKind(kind) {
    const k = kind || 'unknown'
    return `<td data-v="${k}" style="color:${KIND_COLOR[k] || '#5f7d6e'}">${k}</td>`
  }

  const RPKI_COLOR = {
    valid: '#2ecc71',
    invalid: '#e74c3c',
    unknown: '#c9a227',
    mixed: '#c9a227',
    'n/a': '#5f7d6e'
  }
  // per-/24 status cell (sorted by risk so invalid/unknown surface first)
  function tdRpki(status) {
    const s = status || 'n/a'
    const rank = { invalid: 3, unknown: 2, valid: 1, unannounced: 1, 'n/a': 0 }[s] ?? 0
    return `<td data-v="${rank}" style="color:${RPKI_COLOR[s] || '#5f7d6e'}">${s}</td>`
  }
  // per-ASN aggregate cell, e.g. "✓21 ?4"
  function tdRpkiAsn(c) {
    const tot = c.valid + c.invalid + c.unknown
    if (!tot) return '<td data-v="-1">–</td>'
    const cls = c.invalid
      ? 'invalid'
      : c.valid && c.unknown
        ? 'mixed'
        : c.valid
          ? 'valid'
          : 'unknown'
    const parts = []
    if (c.valid) parts.push('✓' + c.valid)
    if (c.invalid) parts.push('✗' + c.invalid)
    if (c.unknown) parts.push('?' + c.unknown)
    const risk = c.invalid * 1000 + c.unknown
    return `<td data-v="${risk}" style="color:${RPKI_COLOR[cls]}">${parts.join(' ')}</td>`
  }

  const opRows = operators
    .map(
      (o) =>
        '<tr>' +
        td(o.asn || '–', o.asnNum ?? -1) +
        td(o.operator) +
        tdKind(o.kind) +
        tdNum(o.nodes) +
        tdNum(o.alive) +
        tdNum(o.subnets) +
        tdNum(o.countries) +
        tdNum(o.medianRtt, (v) => v + 'ms') +
        tdRpkiAsn(o.rpki) +
        tdNum(o.seederSubnets) +
        '</tr>'
    )
    .join('\n')

  const netRows = networks
    .map(
      (n) =>
        '<tr' +
        (n.seeds ? ' class="seeder"' : '') +
        '>' +
        td(n.prefix + '.0/24') +
        td(n.city || '?') +
        td(n.country || '?') +
        td(n.asn || '–', n.asnNum ?? -1) +
        td(n.operator || '?') +
        tdKind(n.kind) +
        tdNum(n.nodes) +
        tdNum(n.alive) +
        tdNum(n.maxSessions) +
        tdNum(n.uptimeMs, dur) +
        tdNum(n.medianRtt, (v) => v + 'ms') +
        tdRpki(n.rpki) +
        td(n.seeds ? '★ ' + n.seeds : '', n.seeds ? 1 : 0) +
        '</tr>'
    )
    .join('\n')

  const BG = '#060a08'
  const PANEL = '#0b1410'
  const TEXT = '#eafff2'
  const MUTED = '#5f7d6e'
  const GREEN = '#b6ff3c'
  const SEEDER = '#ff2bd6'

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>hyperdht-explorer · summary</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; background: ${BG}; color: ${TEXT};
      font-family: Inter, system-ui, -apple-system, sans-serif; font-size: 13px; }
    .wrap { max-width: 1150px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 2px; } h1 .accent { color: ${GREEN}; }
    h2 { font-size: 15px; margin: 26px 0 8px; }
    .sub { color: ${MUTED}; margin-bottom: 14px; }
    a { color: ${GREEN}; }
    .totals { display: flex; gap: 22px; flex-wrap: wrap; background: ${PANEL};
      border: 1px solid rgba(120,200,150,0.12); border-radius: 10px; padding: 12px 16px; }
    .totals b { color: ${GREEN}; font-size: 18px; display: block; }
    .totals span { color: ${MUTED}; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
    input.filter { width: 100%; box-sizing: border-box; margin: 8px 0; padding: 8px 10px;
      background: ${PANEL}; border: 1px solid rgba(120,200,150,0.18); border-radius: 8px; color: ${TEXT}; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: right; padding: 6px 9px; border-bottom: 1px solid rgba(120,200,150,0.08); white-space: nowrap; }
    th:first-child, td:first-child, th.l, td.l { text-align: left; }
    th { color: ${MUTED}; cursor: pointer; user-select: none; position: sticky; top: 0; background: ${BG}; }
    th:hover { color: ${GREEN}; }
    tbody tr:hover { background: rgba(120,200,150,0.06); }
    tr.seeder td:last-child { color: ${SEEDER}; font-weight: 600; }
    .num { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>hyperdht-explorer · <span class="accent">network summary</span></h1>
    <div class="sub">nodes grouped by operator and by /24 subnet · click a column to sort, type to filter</div>
    <div class="sub" style="margin-top:-8px">
      <b>RPKI</b> = route-origin validity — is the prefix cryptographically authorised to be
      announced by this AS?
      <span style="color:#2ecc71">valid</span> ·
      <span style="color:#c9a227">unknown</span> (no ROA, unprotected) ·
      <span style="color:#e74c3c">invalid</span> (hijack-prone).
      <a href="https://www.ripe.net/manage-ips-and-asns/resource-management/rpki/" target="_blank" rel="noopener">what is RPKI?</a>
    </div>

    <div class="totals">
      <div><b>${totals.nodes}</b><span>nodes</span></div>
      <div><b>${totals.alive}</b><span>alive</span></div>
      <div><b>${totals.subnets}</b><span>/24 networks</span></div>
      <div><b>${totals.operators}</b><span>ASNs</span></div>
      <div><b>${totals.countries}</b><span>countries</span></div>
    </div>

    <h2>By ASN / operator</h2>
    <div class="sub" style="margin-top:-2px">This table doubles as the ASN → operator-name mapping.</div>
    <input class="filter" data-for="opTable" placeholder="filter by ASN or operator…" />
    <table id="opTable" class="num">
      <thead><tr>
        <th class="l">ASN</th><th class="l">Operator</th><th class="l">Type</th><th>Nodes</th><th>Alive</th><th>Subnets</th>
        <th>Countries</th><th>Median RTT</th><th>RPKI</th><th>Seeder subnets</th>
      </tr></thead>
      <tbody>${opRows}</tbody>
    </table>

    <h2>By /24 network</h2>
    <input class="filter" data-for="netTable" placeholder="filter networks (prefix, city, operator…)" />
    <table id="netTable" class="num">
      <thead><tr>
        <th class="l">Network</th><th class="l">City</th><th class="l">Country</th>
        <th class="l">ASN</th><th class="l">Operator</th><th class="l">Type</th>
        <th>Nodes</th><th>Alive</th><th>Max sessions</th><th>Uptime</th><th>Median RTT</th><th>RPKI</th><th>Seeds</th>
      </tr></thead>
      <tbody>${netRows}</tbody>
    </table>
  </div>

  <script>
    // click-to-sort on every table header
    document.querySelectorAll('table').forEach((table) => {
      const tbody = table.querySelector('tbody');
      table.querySelectorAll('th').forEach((th, col) => {
        let asc = false;
        th.addEventListener('click', () => {
          asc = !asc;
          const rows = [...tbody.querySelectorAll('tr')];
          rows.sort((a, b) => {
            const av = a.children[col].dataset.v, bv = b.children[col].dataset.v;
            const an = parseFloat(av), bn = parseFloat(bv);
            const both = !isNaN(an) && !isNaN(bn);
            const cmp = both ? an - bn : String(av).localeCompare(String(bv));
            return asc ? cmp : -cmp;
          });
          rows.forEach((r) => tbody.appendChild(r));
        });
      });
    });
    // live filter
    document.querySelectorAll('input.filter').forEach((inp) => {
      const tbody = document.getElementById(inp.dataset.for).querySelector('tbody');
      inp.addEventListener('input', () => {
        const q = inp.value.toLowerCase();
        tbody.querySelectorAll('tr').forEach((r) => {
          r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
    });
  </script>
</body>
</html>
`

  ensureDirs()
  const out = htmlPath('summary.html')
  fs.writeFileSync(out, html)
  console.log('summary: wrote summary.html')
  console.log(`open it in a browser:  file://${out}`)
  db.close()
}
