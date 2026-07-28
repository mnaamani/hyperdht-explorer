import process from 'bare-process';
import fs from 'bare-fs';
import {
  openDb,
  nodesRepo,
  observationsRepo,
  snapshotsRepo,
  storeProbesRepo,
  trafficRepo,
  prefixOf,
  TRAFFIC_COMMAND_COLUMNS,
  TRAFFIC_COMMAND_CLASS
} from '../db.mjs';
import { htmlPath, ensureDirs } from '../paths.mjs';
import { ensureVendor } from '../vendor/index.mjs';

// Render how the DHT network evolves over time -> timeline.html.
// Views:
//   1. Node stability      - histogram of seen_count (one-shot fly-bys vs durable core)
//   2. Identity stability  - same, but per public key (observations), deduped across IPs
//   3. Presence + survival - approx concurrent presence, and a retention curve
//   4. Snapshot metrics    - per-scan series (total/alive/seeders/rtt/geo)
//   5. Diurnal             - activity by hour-of-day (datacenter vs dynamic signature)
//   6. Request load        - inbound RPC per minute + command mix (`traffic`)
//
// Views 1, 3, 5 are derived from each node's first_seen/last_seen/seen_count
// (available now, improve as the observed span grows). View 2 reads the `observations`
// table (populated by `observe`); view 4 reads `snapshots` (one row per scan run).

export function run(ctx) {
  const db = openDb();
  const HOUR = 3600 * 1000;
  const now = Date.now();

  const nodes = nodesRepo(db).lifespans();
  const snapshots = snapshotsRepo(db).chronological();
  const storeProbes = storeProbesRepo(db).chronological();
  const trafficRuns = trafficRepo(db).chronological();

  function fmt(ts) {
    const date = new Date(ts);
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:00`;
  }

  // --- hourly buckets across the observed span --------------------------------
  const labels = [];
  const newPerHour = [];
  const departuresPerHour = [];
  const presence = [];
  const diurnal = new Array(24).fill(0).map(() => ({ sum: 0, n: 0 }));

  if (nodes.length) {
    const minT = nodes.reduce(
      (acc, row) => Math.min(acc, row.first_seen),
      Infinity
    );
    const maxT = nodes.reduce((acc, row) => Math.max(acc, row.last_seen), 0);
    const start = Math.floor(minT / HOUR) * HOUR;
    const activeCutoff = now - HOUR; // nodes not seen within the last hour count as departed

    // Bound the timeline by the data (last sighting), not wall-clock now, so the
    // gap between the last scan and now doesn't trail off into empty zero buckets.
    for (let t = start; t <= maxT; t += HOUR) {
      let nu = 0;
      let dep = 0;
      let pres = 0;
      for (const row of nodes) {
        if (row.first_seen >= t && row.first_seen < t + HOUR) {
          nu++;
        }
        if (
          row.last_seen < activeCutoff &&
          row.last_seen >= t &&
          row.last_seen < t + HOUR
        ) {
          dep++;
        }
        // present = observed interval overlaps this hour. Robust at sub-hour spans,
        // where sampling a single mid-hour instant would miss the data entirely.
        if (row.first_seen < t + HOUR && row.last_seen >= t) {
          pres++;
        }
      }
      labels.push(fmt(t));
      newPerHour.push(nu);
      departuresPerHour.push(-dep); // negative so births/deaths mirror around zero
      presence.push(pres);
      const hod = new Date(t).getHours();
      diurnal[hod].sum += pres;
      diurnal[hod].n++;
    }
  }
  const diurnalAvg = diurnal.map((bucket) =>
    bucket.n ? Math.round(bucket.sum / bucket.n) : 0
  );

  // --- survival / retention curve ---------------------------------------------
  const ages = nodes
    .map((row) => (row.last_seen - row.first_seen) / HOUR)
    .sort((a, b) => a - b);
  const survival = [];
  if (ages.length) {
    const maxAge = ages[ages.length - 1] || 1;
    const steps = 40;
    // Stop before the exact maximum: x = maxAge isolates the single longest-lived
    // node (~1/N), a degenerate tail that nosedives the curve to zero on the right.
    for (let i = 0; i < steps; i++) {
      const x = (maxAge * i) / steps;
      const surviving = ages.length - lowerBound(ages, x);
      survival.push({
        x: Math.round(x * 10) / 10,
        y: Math.round((surviving / ages.length) * 1000) / 10
      });
    }
  }
  function lowerBound(arr, value) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  // --- stability distributions ------------------------------------------------
  // How many times something is seen measures its staying power: 1 = a one-shot
  // fly-by, high = durable, seen over and over. Bins keep resolution at the low
  // end and group the long tail. Two flavours:
  //   * by ip:port  — the `nodes` table's seen_count (one ++ per scan).
  //   * by public key — the `observations` table, deduped by cryptographic
  //     identity so a peer that roams across IPs (NAT/mobile) still counts once.
  const stabilityBins = [
    { label: '1', lo: 1, hi: 1 },
    { label: '2', lo: 2, hi: 2 },
    { label: '3', lo: 3, hi: 3 },
    { label: '4', lo: 4, hi: 4 },
    { label: '5', lo: 5, hi: 5 },
    { label: '6–10', lo: 6, hi: 10 },
    { label: '11–20', lo: 11, hi: 20 },
    { label: '21–50', lo: 21, hi: 50 },
    { label: '51–100', lo: 51, hi: 100 },
    { label: '100+', lo: 101, hi: Infinity }
  ];
  function binStability(values) {
    const counts = stabilityBins.map(() => 0);
    for (const value of values) {
      const i = stabilityBins.findIndex((b) => value >= b.lo && value <= b.hi);
      if (i >= 0) {
        counts[i]++;
      }
    }
    return {
      labels: stabilityBins.map((b) => b.label),
      counts,
      total: values.length
    };
  }
  const stability = binStability(nodes.map((row) => row.seen_count || 1));

  // identity stability: aggregate observation count per peer pseudonym across
  // all the networks it was seen from, then bin the same way. Pseudonyms are
  // scoped to a salt period (a month), so a peer active across a boundary
  // contributes to two bins rather than one — this reads as slightly less
  // stability than there really is, which is the safe direction to be wrong in.
  const obsRows = observationsRepo(db).keyCounts();
  const obsByKey = new Map();
  for (const obs of obsRows) {
    obsByKey.set(obs.key_hash, (obsByKey.get(obs.key_hash) || 0) + obs.count);
  }
  const identity = binStability([...obsByKey.values()]);

  // --- snapshot series --------------------------------------------------------
  const snap = {
    labels: snapshots.map((row) => fmt(row.ts)),
    total: snapshots.map((row) => row.total_nodes),
    alive: snapshots.map((row) => row.alive),
    seeders: snapshots.map((row) => row.seeders),
    countries: snapshots.map((row) => row.countries),
    medianRtt: snapshots.map((row) => row.median_rtt),
    observed: snapshots.map((row) => row.observed)
  };

  // --- storage-health series (storeprobe.mjs) ----------------------------------
  const store = {
    labels: storeProbes.map((row) => fmt(row.ts)),
    putPct: storeProbes.map((row) =>
      row.canaries ? Math.round((row.put_ok / row.canaries) * 100) : 0
    ),
    getPct: storeProbes.map((row) =>
      row.put_ok ? Math.round((row.get_ok / row.put_ok) * 100) : 0
    ),
    persistPct: storeProbes.map((row) =>
      Math.round((row.persistence || 0) * 100)
    ),
    repInitial: storeProbes.map(
      (row) => Math.round((row.replicas_initial || 0) * 10) / 10
    ),
    repAfter: storeProbes.map(
      (row) => Math.round((row.replicas_after || 0) * 10) / 10
    )
  };
  // decay curve (replicas vs minutes-since-put) from the most recent probe
  let decay = [];
  for (let i = storeProbes.length - 1; i >= 0; i--) {
    if (storeProbes[i].decay) {
      try {
        decay = JSON.parse(storeProbes[i].decay);
      } catch {}
      break;
    }
  }
  store.decay = decay.map((point) => ({ x: point.m, y: point.replicas }));
  store.ttl = 20; // hyperdht record TTL (minutes), for the marker line

  // --- inbound request load (traffic.mjs) --------------------------------------
  // Only runs where we actually became routable are plotted. A run from a
  // firewalled host measures ~zero inbound work, which is true of that host and
  // says nothing about the network — averaging it in would understate real load.
  // The skipped count is surfaced on the page rather than quietly dropped.
  const routableRuns = trafficRuns.filter((row) => row.persistent);
  const perMinute = (row, columns) => {
    if (!row.duration_s) {
      return 0;
    }
    const total = columns.reduce((sum, name) => sum + (row[name] || 0), 0);
    return Math.round((total / row.duration_s) * 60 * 10) / 10;
  };
  const internalColumns = TRAFFIC_COMMAND_COLUMNS.filter(
    (name) => TRAFFIC_COMMAND_CLASS.get(name) === 'internal'
  );
  const externalColumns = TRAFFIC_COMMAND_COLUMNS.filter(
    (name) => TRAFFIC_COMMAND_CLASS.get(name) === 'external'
  );

  const load = {
    labels: routableRuns.map((row) => fmt(row.ts)),
    perMin: routableRuns.map((row) =>
      row.duration_s
        ? Math.round((row.requests / row.duration_s) * 60 * 10) / 10
        : 0
    ),
    routingPerMin: routableRuns.map((row) => perMinute(row, internalColumns)),
    appPerMin: routableRuns.map((row) => perMinute(row, externalColumns)),
    sources: routableRuns.map((row) => row.sources),
    skipped: trafficRuns.length - routableRuns.length,
    mix: [],
    // Target diversity. `targets` is NULL for runs recorded before this was
    // measured — that is "unmeasured", not zero, so it maps to null and Chart.js
    // leaves a gap rather than drawing a dive to the axis.
    targets: routableRuns.map((row) => row.targets ?? null),
    perTarget: routableRuns.map((row) =>
      row.targets
        ? Math.round((row.target_requests / row.targets) * 10) / 10
        : null
    ),
    hasTargets: routableRuns.some((row) => row.targets !== null)
  };

  // Command mix from the most recent routable run. NULL columns (a command this
  // build never counted) are dropped rather than shown as zero.
  const latestRun = routableRuns[routableRuns.length - 1];
  if (latestRun) {
    for (const name of TRAFFIC_COMMAND_COLUMNS) {
      if (latestRun[name]) {
        load.mix.push({
          name,
          count: latestRun[name],
          kind: TRAFFIC_COMMAND_CLASS.get(name)
        });
      }
    }
    load.mix.sort((left, right) => right.count - left.count);
  }

  console.log(
    `timeline: ${nodes.length} nodes over ${labels.length} hourly buckets, ${snapshots.length} snapshot(s), ${storeProbes.length} store-probe(s), ${routableRuns.length} traffic run(s)`
  );

  const DATA = {
    labels,
    newPerHour,
    departuresPerHour,
    presence,
    survival,
    stability,
    identity,
    diurnalAvg,
    snap,
    store,
    load
  };

  // --- Pear-inspired theme ----------------------------------------------------
  const BG = '#060a08';
  const PANEL = '#0b1410';
  const TEXT = '#eafff2';
  const MUTED = '#5f7d6e';
  const GREEN = '#b6ff3c';
  const GREEN2 = '#5bd06a';
  const CYAN = '#4cd9ff';
  const SEEDER = '#ff2bd6';
  const RED = '#e67e22';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>hyperdht-explorer · timeline</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="vendor/chart.umd.js"></script>
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
      <h2>Node stability</h2>
      <p class="note">How many scans each node has appeared in (its <code>seen_count</code>). A tall left bar = lots of one-shot fly-bys; weight on the right = a durable core seen scan after scan.</p>
      <canvas id="stability" height="90"></canvas>
    </div>

    <div class="card">
      <h2>Identity stability</h2>
      <p class="note">Like node stability, but keyed by <strong>public key</strong> instead of ip:port — from peers seen connecting via <code>observe</code>. Deduped by cryptographic identity, so a peer that roams across IPs (NAT / mobile) counts once. Weight on the right = recurring, persistent identities.</p>
      <div id="identityWrap"><canvas id="identity" height="90"></canvas></div>
    </div>

    <div class="card">
      <h2>Discovery &amp; churn</h2>
      <p class="note">New nodes discovered per hour (up) vs nodes last seen / departed per hour (down). The first hour (cold-start backlog) is omitted so the ongoing churn stays readable.</p>
      <canvas id="churn" height="100"></canvas>
    </div>

    <div class="card">
      <h2>Concurrent presence</h2>
      <p class="note">Approx distinct nodes active in each hour (their first–last sighting interval overlaps the hour). The timeline ends at the last observation, not the current clock.</p>
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
      <h2>Inbound request load</h2>
      <p class="note">From <code>traffic</code>: requests other peers sent <em>us</em> per minute while we were acting as an ordinary routing node, split into DHT routing chatter (<code>ping</code>, <code>find_node</code>…) and application traffic (<code>lookup</code>, <code>announce</code>, record get/put). Every other series on this page counts how many nodes <em>exist</em>; this one is the only measure of whether anyone is <strong>using</strong> them.</p>
      <div id="loadWrap"><canvas id="load" height="100"></canvas></div>
    </div>

    <div class="card">
      <h2>Target diversity</h2>
      <p class="note">How many <em>different</em> topics or records were asked for in each run, and how many requests each one drew on average. A ratio near 1 is a long tail of one-off lookups; a high ratio means a smaller set of popular topics being asked for over and over. Only the count is measured — targets are passed through a one-way fingerprint keyed by a secret that is random per run and never stored, so this says how many, never which. Counts cover application requests only (<code>find_node</code>'s targets are random-walk probe points and would swamp the signal).</p>
      <div id="targetsWrap"><canvas id="targets" height="100"></canvas></div>
    </div>

    <div class="card">
      <h2>Request mix — latest run</h2>
      <p class="note">Which commands made up that load. A network dominated by <code>lookup</code> is one where peers are mostly joining swarms; weight on <code>announce</code> means they are mostly advertising. Counts are of the command only — which topic or record each request was for is never read, so this cannot say <em>what</em> anyone was looking up.</p>
      <div id="mixWrap"><canvas id="mix" height="90"></canvas></div>
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

    new Chart(stability, {
      type: 'bar',
      data: { labels: D.stability.labels, datasets: [
        { label: 'nodes', data: D.stability.counts, backgroundColor: '${GREEN}' } ] },
      options: { responsive: true,
        scales: { x: { title: { display: true, text: 'scans seen in (seen_count)' }, grid: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: 'nodes' } } },
        plugins: { legend: { display: false } } }
    });

    if (D.identity.total) {
      new Chart(identity, {
        type: 'bar',
        data: { labels: D.identity.labels, datasets: [
          { label: 'identities', data: D.identity.counts, backgroundColor: '#ff9f1c' } ] },
        options: { responsive: true,
          scales: { x: { title: { display: true, text: 'times observed (by public key)' }, grid: { display: false } },
            y: { beginAtZero: true, title: { display: true, text: 'identities' } } },
          plugins: { legend: { display: false } } }
      });
    } else {
      document.getElementById('identityWrap').innerHTML =
        '<div class="empty">No observations yet — run <code>bare bin.mjs observe</code> (announces under a public topic and records connecting peers by public key) and regenerate.</div>';
    }

    // Drop the first hourly bucket: the initial scan dumps its whole backlog
    // there as "new", a cold-start spike that dwarfs the real hour-to-hour churn.
    const cStart = D.labels.length > 1 ? 1 : 0;
    new Chart(churn, {
      type: 'bar',
      data: { labels: D.labels.slice(cStart), datasets: [
        { label: 'new/hour', data: D.newPerHour.slice(cStart), backgroundColor: '${GREEN}' },
        { label: 'departed/hour', data: D.departuresPerHour.slice(cStart), backgroundColor: '${RED}' } ] },
      options: { responsive: true, interaction: { mode: 'index', intersect: false },
        scales: { x: { ticks: { maxTicksLimit: 12 } },
          y: { stacked: true, title: { display: true, text: 'nodes/hour' } } } }
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

    const skippedNote = D.load.skipped
      ? ' <br>(' + D.load.skipped + ' run(s) omitted: the node never became routable, so they measured this host\\'s firewall, not the network.)'
      : '';

    if (D.load.labels.length) {
      new Chart(load, {
        data: { labels: D.load.labels, datasets: [
          { type: 'line', label: 'requests/min', data: D.load.perMin, borderColor: '${GREEN}', backgroundColor: 'transparent', ...noPoint },
          { type: 'line', label: 'routing chatter/min', data: D.load.routingPerMin, borderColor: '${CYAN}', backgroundColor: 'transparent', borderDash: [4, 3], ...noPoint },
          { type: 'line', label: 'application/min', data: D.load.appPerMin, borderColor: '${SEEDER}', backgroundColor: 'transparent', borderDash: [4, 3], ...noPoint },
          { type: 'line', label: 'distinct networks', data: D.load.sources, borderColor: '${GREEN2}', backgroundColor: 'transparent', yAxisID: 'y1', ...noPoint }
        ] },
        options: { responsive: true, interaction: { mode: 'index', intersect: false },
          scales: { x: { ticks: { maxTicksLimit: 12 } },
            y: { beginAtZero: true, title: { display: true, text: 'requests/min' } },
            y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: '/24s' } } } }
      });
      if (skippedNote) {
        document.getElementById('loadWrap').insertAdjacentHTML('beforeend',
          '<div class="empty" style="text-align:left">' + skippedNote + '</div>');
      }
    } else {
      document.getElementById('loadWrap').innerHTML =
        '<div class="empty">No routable traffic runs yet — run <code>hyperdht-explorer traffic</code> (≈60 min, of which ~20 is warm-up before the node becomes routable) and regenerate.' + skippedNote + '</div>';
    }

    if (D.load.hasTargets) {
      new Chart(targets, {
        data: { labels: D.load.labels, datasets: [
          { type: 'line', label: 'distinct targets', data: D.load.targets, borderColor: '${GREEN}', backgroundColor: 'rgba(182,255,60,0.12)', fill: true, spanGaps: false, ...noPoint },
          { type: 'line', label: 'requests per target', data: D.load.perTarget, borderColor: '${SEEDER}', backgroundColor: 'transparent', yAxisID: 'y1', spanGaps: false, ...noPoint }
        ] },
        options: { responsive: true, interaction: { mode: 'index', intersect: false },
          scales: { x: { ticks: { maxTicksLimit: 12 } },
            y: { beginAtZero: true, title: { display: true, text: 'distinct targets' } },
            y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'req/target' } } } }
      });
    } else {
      document.getElementById('targetsWrap').innerHTML =
        '<div class="empty">No target counts yet — recorded from the first <code>traffic</code> run on a build that measures them.</div>';
    }

    if (D.load.mix.length) {
      new Chart(mix, {
        type: 'bar',
        data: { labels: D.load.mix.map(m => m.name), datasets: [
          { label: 'requests', data: D.load.mix.map(m => m.count),
            backgroundColor: D.load.mix.map(m => m.kind === 'internal' ? '${CYAN}' : '${GREEN}') } ] },
        options: { indexAxis: 'y', responsive: true,
          scales: { x: { beginAtZero: true, title: { display: true, text: 'requests in the window' } },
            y: { grid: { display: false } } },
          plugins: { legend: { display: false } } }
      });
    } else {
      document.getElementById('mixWrap').innerHTML =
        '<div class="empty">No request mix yet — needs a completed <code>traffic</code> run that became routable.</div>';
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
`;

  ensureDirs();
  ensureVendor('chart');
  const out = htmlPath('timeline.html');
  fs.writeFileSync(out, html);
  console.log('timeline: wrote timeline.html');
  console.log(`open it in a browser:  file://${out}`);
  db.close();
}
