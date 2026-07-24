import fs from 'bare-fs';
import { openDb } from '../db.mjs';
import { dbPath } from '../paths.mjs';

// Print a quick health/size report for nodes.db: on-disk size, per-table row
// counts, and the freshness of the last scan / probe / storeprobe. Read-only —
// handy for cron monitoring and for sanity-checking that the schedulers are
// actually writing.

function fmtBytes(bytes) {
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

function fileSize(path) {
  try {
    return fs.statSync(path).size;
  } catch {
    return null;
  }
}

// epoch ms -> "2026-06-29T12:00:00Z (3h ago)", or "never" for null/missing.
function fmtTime(ts) {
  if (!ts) {
    return 'never';
  }
  const date = new Date(ts);
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const seconds = Math.round(abs / 1000);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  let rel;
  if (seconds < 60) {
    rel = `${seconds}s`;
  } else if (minutes < 60) {
    rel = `${minutes}m`;
  } else if (hours < 48) {
    rel = `${hours}h`;
  } else {
    rel = `${days}d`;
  }
  return `${date.toISOString().replace('.000', '')} (${diff < 0 ? 'in ' : ''}${rel}${diff < 0 ? '' : ' ago'})`;
}

const TABLES = [
  'nodes',
  'geo',
  'observations',
  'snapshots',
  'store_probes',
  'as_neighbours',
  'as_names',
  'rpki'
];

export function run() {
  const path = dbPath();
  const db = openDb();

  // --- on-disk size (main file + WAL + shared-memory index) -------------------
  const main = fileSize(path);
  const wal = fileSize(`${path}-wal`);
  const shm = fileSize(`${path}-shm`);
  const total = (main ?? 0) + (wal ?? 0) + (shm ?? 0);

  console.log(`database: ${path}`);
  console.log(
    `size:     ${fmtBytes(total)}  (db ${fmtBytes(main)}, wal ${fmtBytes(wal)})`
  );

  // --- row counts -------------------------------------------------------------
  console.log('\nrows:');
  for (const t of TABLES) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
    console.log(`  ${t.padEnd(14)} ${n}`);
  }

  // --- node breakdown ---------------------------------------------------------
  const nodes = db
    .prepare(
      `SELECT
         SUM(CASE WHEN alive = 1 THEN 1 ELSE 0 END) AS alive,
         SUM(CASE WHEN alive = 0 THEN 1 ELSE 0 END) AS dead,
         SUM(CASE WHEN alive IS NULL THEN 1 ELSE 0 END) AS unprobed,
         SUM(CASE WHEN app_seeder IS NOT NULL THEN 1 ELSE 0 END) AS seeders,
         MAX(last_seen) AS last_seen,
         MAX(last_ping) AS last_ping
       FROM nodes`
    )
    .get();
  console.log('\nnodes:');
  console.log(
    `  alive ${nodes.alive ?? 0} · dead ${nodes.dead ?? 0} · unprobed ${nodes.unprobed ?? 0} · seeders ${nodes.seeders ?? 0}`
  );
  console.log(`  last seen:  ${fmtTime(nodes.last_seen)}`);
  console.log(`  last probe: ${fmtTime(nodes.last_ping)}`);

  // --- last scan snapshot -----------------------------------------------------
  const snap = db
    .prepare('SELECT * FROM snapshots ORDER BY ts DESC LIMIT 1')
    .get();
  console.log('\nlast scan snapshot:');
  if (snap) {
    console.log(`  ${fmtTime(snap.ts)}`);
    console.log(
      `  total ${snap.total_nodes} · alive ${snap.alive} · new ${snap.new_nodes} · pruned ${snap.pruned} · countries ${snap.countries} · asns ${snap.asns} · median rtt ${snap.median_rtt ?? '—'}ms`
    );
  } else {
    console.log('  none recorded');
  }

  // --- last storeprobe --------------------------------------------------------
  const sp = db
    .prepare('SELECT * FROM store_probes ORDER BY ts DESC LIMIT 1')
    .get();
  console.log('\nlast storeprobe:');
  if (sp) {
    console.log(`  ${fmtTime(sp.ts)}`);
    console.log(
      `  canaries ${sp.canaries} · put ${sp.put_ok} · get ${sp.get_ok} · persistence ${sp.persistence !== null && sp.persistence !== undefined ? (sp.persistence * 100).toFixed(0) + '%' : '—'}`
    );
  } else {
    console.log('  none recorded');
  }

  db.close();
}
