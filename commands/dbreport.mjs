import fs from 'bare-fs';
import {
  openDb,
  nodesRepo,
  snapshotsRepo,
  storeProbesRepo,
  trafficRepo,
  TRAFFIC_COMMAND_COLUMNS,
  TRAFFIC_COMMAND_CLASS
} from '../db.mjs';
import { dbPath } from '../paths.mjs';

// The shared read-only view of nodes.db behind two renderers: `stats` prints it
// to a terminal, `render:stats` writes it as stats.html. Collecting once here
// keeps the two from drifting — a number that appears on the page is the same
// number the CLI reports, by construction rather than by discipline.
//
// Read-only and network-free. Nothing here writes.

const TABLES = [
  'nodes',
  'geo',
  'observations',
  'snapshots',
  'store_probes',
  'traffic',
  'as_neighbours',
  'as_names',
  'rpki',
  'pseudonym_salts',
  'exclusions'
];

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

// epoch ms -> "3h ago" / "never". Relative only — used where the exact instant
// doesn't matter more than the freshness does.
export function fmtAgo(ts) {
  if (!ts) {
    return 'never';
  }
  const diff = Date.now() - ts;
  const seconds = Math.round(Math.abs(diff) / 1000);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

// epoch ms -> "2026-06-29T12:00:00Z (3h ago)", or "never" for null/missing.
export function fmtTime(ts) {
  if (!ts) {
    return 'never';
  }
  const iso = new Date(ts).toISOString().replace('.000', '');
  return `${iso} (${fmtAgo(ts)})`;
}

export function fmtPct(fraction) {
  if (fraction === null || fraction === undefined) {
    return '—';
  }
  return `${(fraction * 100).toFixed(0)}%`;
}

function fileSize(path) {
  try {
    return fs.statSync(path).size;
  } catch {
    return null;
  }
}

// Per-command tallies of a traffic row, largest first, zero/NULL columns
// dropped. NULL means "this build never counted that command" (see the
// traffic migration in db.mjs) and is not the same as zero, so it is skipped
// rather than rendered as 0.
function trafficMix(row) {
  if (!row) {
    return [];
  }
  const mix = [];
  for (const name of TRAFFIC_COMMAND_COLUMNS) {
    const count = row[name];
    if (count) {
      mix.push({
        name,
        count,
        kind: TRAFFIC_COMMAND_CLASS.get(name),
        share: row.requests ? count / row.requests : 0
      });
    }
  }
  return mix.sort((left, right) => right.count - left.count);
}

// Gather everything both renderers need. Opens the database, reads, and closes
// it — callers get plain data and never a live handle.
export function collect() {
  const path = dbPath();
  const db = openDb();

  const main = fileSize(path);
  const wal = fileSize(`${path}-wal`);
  const shm = fileSize(`${path}-shm`);

  // Generic COUNT(*) over a fixed, code-controlled table whitelist — the one
  // sanctioned place a table name is interpolated instead of going through a
  // repo. It spans every table by design, so no single repo owns it.
  const rows = TABLES.map((table) => ({
    table,
    count: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  }));

  const nodes = nodesRepo(db);
  const breakdown = nodes.breakdown();
  const nodesHosts = nodes.countHosts();
  const snapshot = snapshotsRepo(db).latest();
  const storeProbe = storeProbesRepo(db).latest();
  const traffic = trafficRepo(db).latest();

  db.close();

  const nodesTotal =
    (breakdown.alive ?? 0) + (breakdown.dead ?? 0) + (breakdown.unprobed ?? 0);

  return {
    path,
    size: { main, wal, shm, total: (main ?? 0) + (wal ?? 0) + (shm ?? 0) },
    rows,
    breakdown,
    // `nodesTotal` counts (host, port) endpoint rows; `nodesHosts` counts the
    // distinct hosts behind them. They differ a lot when a node churns ports.
    nodesTotal,
    nodesHosts,
    snapshot,
    storeProbe,
    traffic,
    trafficMix: trafficMix(traffic),
    // Requests per minute over the measured window — the headline load number.
    trafficPerMin:
      traffic && traffic.duration_s
        ? (traffic.requests / traffic.duration_s) * 60
        : null,
    // Average requests per distinct target: ~1 = a long tail of one-off
    // lookups, high = a few popular topics asked for repeatedly. Null when the
    // run predates target counting (the column reads NULL, not 0) or when no
    // application requests arrived.
    trafficPerTarget:
      traffic && traffic.targets
        ? traffic.target_requests / traffic.targets
        : null
  };
}
