import process from 'bare-process'
import fs from 'bare-fs'
import { openDb, prefixOf } from '../db.js'
import { htmlPath, ensureDirs } from '../paths.js'

// Render how the DHT network evolves over time -> timeline.html.
// Four views:
//   1. Discovery & churn  - new nodes/hour, cumulative set, departures/hour
//   2. Presence + survival - approx concurrent presence, and a retention curve
//   3. Snapshot metrics    - per-scan series (total/alive/seeders/rtt/geo)
//   4. Diurnal             - activity by hour-of-day (datacenter vs dynamic signature)
//
// Views 1, 2, 4 are derived from each node's first_seen/last_seen (available now,
// improve as the observed span grows). View 3 reads the `snapshots` table that the
// crawler writes at the end of each run, so it fills in going forward.

export function run(ctx) {
  const db = openDb()
  const HOUR = 3600 * 1000
  const now = Date.now()

  const nodes = db.prepare('SELECT first_seen, last_seen FROM nodes').all()
  const snapshots = db.prepare('SELECT * FROM snapshots ORDER BY ts').all()
  const storeProbes = db.prepare('SELECT * FROM store_probes ORDER BY ts').all()

  function fmt(ts) {
    const d = new Date(ts)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:00`
  }

  // --- hourly buckets across the observed span --------------------------------
  const labels = []
  const newPerHour = []
  const departuresPerHour = []
  const cumulative = []
  const presence = []
  const diurnal = new Array(24).fill(0).map(() => ({ sum: 0, n: 0 }))

  if (nodes.length) {
    const minT = nodes.reduce((m, r) => Math.min(m, r.first_seen), Infinity)
    const start = Math.floor(minT / HOUR) * HOUR
    const activeCutoff = now - HOUR // nodes seen within the last hour count as still present

    let cum = 0
    for (let t = start; t <= now; t += HOUR) {
      const mid = t + HOUR / 2
      let nu = 0
      let dep = 0
      let pres = 0
      for (const r of nodes) {
        if (r.first_seen >= t && r.first_seen < t + HOUR) nu++
        if (r.last_seen < activeCutoff && r.last_seen >= t && r.last_seen < t + HOUR) dep++
        if (r.first_seen <= mid && r.last_seen >= mid) pres++
      }
      cum += nu
      labels.push(fmt(t))
      newPerHour.push(nu)
      departuresPerHour.push(-dep) // negative so births/deaths mirror around zero
      cumulative.push(cum)
      presence.push(pres)
      const hod = new Date(t).getHours()
      diurnal[hod].sum += pres
      diurnal[hod].n++
    }
  }
  const diurnalAvg = diurnal.map((d) => (d.n ? Math.round(d.sum / d.n) : 0))

  // --- survival / retention curve ---------------------------------------------
  const ages = nodes.map((r) => (r.last_seen - r.first_seen) / HOUR).sort((a, b) => a - b)
  const survival = []
  if (ages.length) {
    const maxAge = ages[ages.length - 1] || 1
    const steps = 40
    for (let i = 0; i <= steps; i++) {
      const x = (maxAge * i) / steps
      const surviving = ages.length - lowerBound(ages, x)
      survival.push({
        x: Math.round(x * 10) / 10,
        y: Math.round((surviving / ages.length) * 1000) / 10
      })
    }
  }
  function lowerBound(arr, v) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (arr[m] < v) lo = m + 1
      else hi = m
    }
    return lo
  }

  // --- snapshot series --------------------------------------------------------
  const snap = {
    labels: snapshots.map((s) => fmt(s.ts)),
    total: snapshots.map((s) => s.total_nodes),
    alive: snapshots.map((s) => s.alive),
    seeders: snapshots.map((s) => s.seeders),
    countries: snapshots.map((s) => s.countries),
    medianRtt: snapshots.map((s) => s.median_rtt),
    observed: snapshots.map((s) => s.observed)
  }

  // --- storage-health series (storeprobe.js) ----------------------------------
  const store = {
    labels: storeProbes.map((s) => fmt(s.ts)),
    putPct: storeProbes.map((s) => (s.canaries ? Math.round((s.put_ok / s.canaries) * 100) : 0)),
    getPct: storeProbes.map((s) => (s.put_ok ? Math.round((s.get_ok / s.put_ok) * 100) : 0)),
    persistPct: storeProbes.map((s) => Math.round((s.persistence || 0) * 100)),
    repInitial: storeProbes.map((s) => Math.round((s.replicas_initial || 0) * 10) / 10),
    repAfter: storeProbes.map((s) => Math.round((s.replicas_after || 0) * 10) / 10)
  }
  // decay curve (replicas vs minutes-since-put) from the most recent probe
  let decay = []
  for (let i = storeProbes.length - 1; i >= 0; i--) {
    if (storeProbes[i].decay) {
      try {
        decay = JSON.parse(storeProbes[i].decay)
      } catch {}
      break
    }
  }
  store.decay = decay.map((d) => ({ x: d.m, y: d.replicas }))
  store.ttl = 20 // hyperdht record TTL (minutes), for the marker line

  console.log(
    `timeline: ${nodes.length} nodes over ${labels.length} hourly buckets, ${snapshots.length} snapshot(s), ${storeProbes.length} store-probe(s)`
  )

  const DATA = {
    labels,
    newPerHour,
    departuresPerHour,
    cumulative,
    presence,
    survival,
    diurnalAvg,
    snap,
    store
  }

  // --- Pear-inspired theme ----------------------------------------------------
  const BG = '#060a08'
  const PANEL = '#0b1410'
  const TEXT = '#eafff2'
  const MUTED = '#5f7d6e'
  const GREEN = '#b6ff3c'
  const GREEN2 = '#5bd06a'
  const CYAN = '#4cd9ff'
  const SEEDER = '#ff2bd6'
  const RED = '#e67e22'

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>hyperdht-explorer · timeline</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    html, body { margin: 0; background: ${BG}; color: ${TEXT};
      font-family: Inter, system-ui, -apple-system, sans-serif; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 2px; }
    h1 .accent { color: ${GREEN}; }
    .sub { color: ${MUTED}; font-size: 13px; margin-bottom: 20px; }
    .card { background: ${PANEL}; border: 1px solid rgba(120,200,150,0.12);
      border-radius: 12px; padding: 16px 18px; margin-bottom: 18px; }
    .card h2 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
    .card .note { color: ${MUTED}; font-size: 12px; margin: 0 0 12px; }
    .empty { color: ${MUTED}; font-size: 13px; padding: 20px 0; text-align: center; }
    .diurnal { display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px; }
    .diurnal .cell { aspect-ratio: 1; border-radius: 4px; display: flex; align-items: center;
      justify-content: center; font-size: 10px; color: #06140c; font-weight: 600; }
    .diurnal .axis { font-size: 10px; color: ${MUTED}; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>hyperdht-explorer · <span class="accent">timeline</span></h1>
    <div class="sub">how the DHT population evolves over time &middot; ${nodes.length} nodes, ${snapshots.length} snapshot(s)</div>

    <div class="card">
      <h2>Discovery &amp; churn</h2>
      <p class="note">New nodes discovered per hour (up) vs nodes last seen / departed per hour (down), with the cumulative known set.</p>
      <canvas id="churn" height="110"></canvas>
    </div>

    <div class="card">
      <h2>Concurrent presence</h2>
      <p class="note">Approx nodes present per hour (first_seen ≤ t ≤ last_seen). Assumes continuous presence between first and last sighting.</p>
      <canvas id="presence" height="90"></canvas>
    </div>

    <div class="card">
      <h2>Survival / retention</h2>
      <p class="note">Of all nodes, the % whose observed lifespan (last − first seen) is at least X hours. Steeper = more transient population.</p>
      <canvas id="survival" height="90"></canvas>
    </div>

    <div class="card">
      <h2>Snapshot metrics</h2>
      <p class="note">Measured at the end of each scan run. Fills in as you run more scans over time.</p>
      <div id="snapWrap"><canvas id="snap" height="100"></canvas></div>
    </div>

    <div class="card">
      <h2>DHT storage health</h2>
      <p class="note">From <code>storeprobe</code>: canary records put into the DHT, then re-polled. % retrievable and % of replicas surviving past the ~20-min record TTL measure how reliably the network stores data.</p>
      <div id="storeWrap"><canvas id="store" height="100"></canvas></div>
    </div>

    <div class="card">
      <h2>Replica decay — latest probe</h2>
      <p class="note">Average # of closest nodes still serving a record vs minutes since it was put. The drop-off near the dashed line is hyperdht's ~20-min record expiry (records vanish unless republished).</p>
      <div id="decayWrap"><canvas id="decay" height="90"></canvas></div>
    </div>

    <div class="card">
      <h2>Diurnal activity</h2>
      <p class="note">Average concurrent presence by hour-of-day (local). Datacenter nodes stay flat; home/dynamic nodes show a day-night cycle. Fills out as the observed span lengthens.</p>
      <div class="diurnal" id="diurnal"></div>
    </div>
  </div>

  <script>
    const D = ${JSON.stringify(DATA)};
    Chart.defaults.color = '${MUTED}';
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.borderColor = 'rgba(120,200,150,0.10)';
    const noPoint = { pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, tension: 0.25 };

    new Chart(churn, {
      data: {
        labels: D.labels,
        datasets: [
          { type: 'bar', label: 'new/hour', data: D.newPerHour, backgroundColor: '${GREEN}', yAxisID: 'y' },
          { type: 'bar', label: 'departed/hour', data: D.departuresPerHour, backgroundColor: '${RED}', yAxisID: 'y' },
          { type: 'line', label: 'cumulative', data: D.cumulative, borderColor: '${CYAN}', backgroundColor: 'transparent', yAxisID: 'y1', ...noPoint }
        ]
      },
      options: { responsive: true, interaction: { mode: 'index', intersect: false },
        scales: { x: { ticks: { maxTicksLimit: 12 } },
          y: { stacked: true, title: { display: true, text: 'nodes/hour' } },
          y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'cumulative' } } } }
    });

    new Chart(presence, {
      type: 'line',
      data: { labels: D.labels, datasets: [
        { label: 'present', data: D.presence, borderColor: '${GREEN}', backgroundColor: 'rgba(182,255,60,0.15)', fill: true, ...noPoint } ] },
      options: { responsive: true, scales: { x: { ticks: { maxTicksLimit: 12 } }, y: { beginAtZero: true } },
        plugins: { legend: { display: false } } }
    });

    new Chart(survival, {
      type: 'line',
      data: { datasets: [
        { label: '% surviving', data: D.survival, borderColor: '${GREEN2}', backgroundColor: 'rgba(91,208,106,0.15)', fill: true, ...noPoint } ] },
      options: { responsive: true, parsing: false,
        scales: { x: { type: 'linear', title: { display: true, text: 'lifespan ≥ hours' } },
          y: { beginAtZero: true, max: 100, title: { display: true, text: '% of nodes' } } },
        plugins: { legend: { display: false } } }
    });

    if (D.snap.labels.length) {
      new Chart(snap, {
        data: { labels: D.snap.labels, datasets: [
          { type: 'line', label: 'total', data: D.snap.total, borderColor: '${CYAN}', backgroundColor: 'transparent', ...noPoint },
          { type: 'line', label: 'alive', data: D.snap.alive, borderColor: '${GREEN}', backgroundColor: 'transparent', ...noPoint },
          { type: 'line', label: 'seeders', data: D.snap.seeders, borderColor: '${SEEDER}', backgroundColor: 'transparent', ...noPoint },
          { type: 'line', label: 'observed participants', data: D.snap.observed, borderColor: '#ff9f1c', backgroundColor: 'transparent', ...noPoint },
          { type: 'line', label: 'countries', data: D.snap.countries, borderColor: '${GREEN2}', backgroundColor: 'transparent', ...noPoint },
          { type: 'line', label: 'median RTT (ms)', data: D.snap.medianRtt, borderColor: '${RED}', backgroundColor: 'transparent', yAxisID: 'y1', ...noPoint }
        ] },
        options: { responsive: true, interaction: { mode: 'index', intersect: false },
          scales: { x: { ticks: { maxTicksLimit: 12 } }, y: { beginAtZero: true },
            y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'ms' } } } }
      });
    } else {
      document.getElementById('snapWrap').innerHTML =
        '<div class="empty">No snapshots yet — run <code>npm run scan</code> (it writes one per run) and regenerate.</div>';
    }

    if (D.store.labels.length) {
      new Chart(store, {
        data: { labels: D.store.labels, datasets: [
          { type: 'line', label: '% retrievable', data: D.store.getPct, borderColor: '${GREEN}', backgroundColor: 'transparent', yAxisID: 'y', ...noPoint },
          { type: 'line', label: '% replicas persisted', data: D.store.persistPct, borderColor: '${SEEDER}', backgroundColor: 'transparent', yAxisID: 'y', ...noPoint },
          { type: 'line', label: 'replicas (t=0)', data: D.store.repInitial, borderColor: '${CYAN}', backgroundColor: 'transparent', yAxisID: 'y1', ...noPoint },
          { type: 'line', label: 'replicas (after)', data: D.store.repAfter, borderColor: '${GREEN2}', borderDash: [4, 3], backgroundColor: 'transparent', yAxisID: 'y1', ...noPoint }
        ] },
        options: { responsive: true, interaction: { mode: 'index', intersect: false },
          scales: { x: { ticks: { maxTicksLimit: 12 } },
            y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } },
            y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'replicas' } } } }
      });
    } else {
      document.getElementById('storeWrap').innerHTML =
        '<div class="empty">No store probes yet — run <code>npm run storeprobe</code> and regenerate.</div>';
    }

    if (D.store.decay.length) {
      const ttlMarker = {
        id: 'ttlMarker',
        afterDraw(c) {
          const x = c.scales.x.getPixelForValue(D.store.ttl);
          if (x < c.chartArea.left || x > c.chartArea.right) return;
          const ctx = c.ctx; ctx.save();
          ctx.strokeStyle = '${SEEDER}'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x, c.chartArea.top); ctx.lineTo(x, c.chartArea.bottom); ctx.stroke();
          ctx.fillStyle = '${SEEDER}'; ctx.font = '11px Inter, sans-serif';
          ctx.fillText('~20m TTL', x + 4, c.chartArea.top + 12); ctx.restore();
        }
      };
      new Chart(decay, {
        type: 'line',
        data: { datasets: [
          { label: 'replicas serving', data: D.store.decay, borderColor: '${GREEN}', backgroundColor: 'rgba(182,255,60,0.15)', fill: true, tension: 0.25, pointRadius: 3 }
        ] },
        options: { responsive: true, parsing: false,
          scales: { x: { type: 'linear', title: { display: true, text: 'minutes since put' } },
            y: { beginAtZero: true, title: { display: true, text: 'replicas' } } },
          plugins: { legend: { display: false } } },
        plugins: [ttlMarker]
      });
    } else {
      document.getElementById('decayWrap').innerHTML =
        '<div class="empty">No decay curve yet — run <code>npm run storeprobe</code> (≈22 min) and regenerate.</div>';
    }

    // diurnal heatmap
    const max = Math.max(1, ...D.diurnalAvg);
    const grid = document.getElementById('diurnal');
    let cells = '', axis = '';
    for (let h = 0; h < 24; h++) {
      const v = D.diurnalAvg[h];
      const a = v / max;                    // 0..1 intensity
      const bg = 'rgba(182,255,60,' + (0.08 + a * 0.92).toFixed(2) + ')';
      cells += '<div class="cell" style="background:' + bg + '" title="' + h + ':00 — avg ' + v + ' present">' + (a > 0.35 ? v : '') + '</div>';
      axis += '<div class="axis">' + (h % 3 === 0 ? h : '') + '</div>';
    }
    grid.innerHTML = cells + axis;
  </script>
</body>
</html>
`

  ensureDirs()
  const out = htmlPath('timeline.html')
  fs.writeFileSync(out, html)
  console.log('timeline: wrote timeline.html')
  console.log(`open it in a browser:  file://${out}`)
  db.close()
}
