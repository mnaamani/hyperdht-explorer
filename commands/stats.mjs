import { collect, fmtBytes, fmtTime, fmtPct } from './dbreport.mjs';

// Print a quick health/size report for nodes.db: on-disk size, per-table row
// counts, and the freshness of the last scan / probe / storeprobe / traffic run.
// Read-only — handy for cron monitoring and for sanity-checking that the
// schedulers are actually writing.
//
// The numbers come from dbreport.collect(), shared with `render:stats` so the
// terminal and the published page can't disagree.

export function run() {
  const report = collect();

  console.log(`database: ${report.path}`);
  console.log(
    `size:     ${fmtBytes(report.size.total)}` +
      `  (db ${fmtBytes(report.size.main)}, wal ${fmtBytes(report.size.wal)})`
  );

  console.log('\nrows:');
  for (const row of report.rows) {
    console.log(`  ${row.table.padEnd(14)} ${row.count}`);
  }

  const breakdown = report.breakdown;
  console.log('\nnodes:');
  console.log(
    `  ${report.nodesHosts} host(s) · ${report.nodesTotal} endpoint(s)`
  );
  console.log(
    `  alive ${breakdown.alive ?? 0} · dead ${breakdown.dead ?? 0}` +
      ` · unprobed ${breakdown.unprobed ?? 0} · seeders ${breakdown.seeders ?? 0}`
  );
  console.log(`  last seen:  ${fmtTime(breakdown.last_seen)}`);
  console.log(`  last probe: ${fmtTime(breakdown.last_ping)}`);

  const snap = report.snapshot;
  console.log('\nlast scan snapshot:');
  if (snap) {
    console.log(`  ${fmtTime(snap.ts)}`);
    console.log(
      `  total ${snap.total_nodes} · alive ${snap.alive} · new ${snap.new_nodes}` +
        ` · pruned ${snap.pruned} · countries ${snap.countries}` +
        ` · asns ${snap.asns} · median rtt ${snap.median_rtt ?? '—'}ms`
    );
  } else {
    console.log('  none recorded');
  }

  const probe = report.storeProbe;
  console.log('\nlast storeprobe:');
  if (probe) {
    console.log(`  ${fmtTime(probe.ts)}`);
    console.log(
      `  canaries ${probe.canaries} · put ${probe.put_ok} · get ${probe.get_ok}` +
        ` · persistence ${fmtPct(probe.persistence)}`
    );
  } else {
    console.log('  none recorded');
  }

  const traffic = report.traffic;
  console.log('\nlast traffic measurement:');
  if (traffic) {
    console.log(`  ${fmtTime(traffic.ts)}`);
    console.log(
      `  window ${(traffic.duration_s / 60).toFixed(0)}m` +
        `${traffic.persistent ? '' : ' (never routable)'}` +
        ` · ${traffic.requests} inbound req` +
        ` (${report.trafficPerMin.toFixed(1)}/min)` +
        ` · ${traffic.sources} network(s)`
    );
    if (traffic.targets !== null && traffic.targets !== undefined) {
      console.log(
        `  targets ${traffic.targets} distinct` +
          ` from ${traffic.target_requests} app request(s)` +
          (report.trafficPerTarget
            ? ` (${report.trafficPerTarget.toFixed(1)} req/target)`
            : '')
      );
    }
    for (const entry of report.trafficMix.slice(0, 5)) {
      console.log(
        `    ${entry.name.padEnd(16)} ${String(entry.count).padStart(7)}` +
          `  ${fmtPct(entry.share).padStart(4)}  ${entry.kind}`
      );
    }
  } else {
    console.log('  none recorded');
  }
}
