import DHT from 'hyperdht';
import b4a from 'b4a';
import sodium from 'sodium-universal';
import process from 'bare-process';
import { openDb, prefixOf, isPrivateIp } from '../db.mjs';

// ---------------------------------------------------------------------------
// hyperdht-explorer: random-walk crawler for the hyperdht (Kademlia) node network.
//
// Discovered nodes are persisted to a SQLite db (nodes.db) so we can track,
// across runs, how stable each peer is:
//   - first_seen / last_seen : the lifespan we've observed a host:port at
//   - sessions               : distinct crawl runs the node appeared in
//   - seen_count             : total times observed across all runs
// A long lifespan + many sessions => dedicated / stable IP; a node that shows
// up once and never returns => likely dynamic / transient.
//
// On startup we also seed the DHT's routing table with the most recently seen
// known peers from the db, in addition to the well-known bootstrap nodes.
//
// Modes:
//   bare bin.mjs scan                 random-walk crawl (runs until stopped)
//   bare bin.mjs scan --for 60        crawl for ~60 seconds, then stop cleanly
//   bare bin.mjs scan --queries 50    crawl until 50 findNode queries, then stop
//   bare bin.mjs scan --prune-hours N drop nodes not seen in N hours (default 72; 0 disables)
//   bare bin.mjs scan <topic-hex>     lookup announcers for a specific topic hash
//
// Bounded runs (--for / --queries) shut down gracefully and print the summary.
// This is the reliable way to time/schedule a scan: the Bare runtime in use does
// NOT deliver SIGINT/SIGTERM to JS handlers, so `timeout bare ...` would just
// hard-kill the process and skip the summary.
// ---------------------------------------------------------------------------

export async function run(ctx) {
  const argv = ctx.argv;

  // Parse `--flag value` options and collect bare positionals from argv[2:].
  const valueFlags = new Set(['--for', '--queries', '--prune-hours']);
  const flags = {};
  const positionals = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      flags[a] = argv[++i];
    } else if (!a.startsWith('--')) {
      positionals.push(a);
    }
  }

  const runForSeconds = Number(flags['--for']) || 0;
  const maxQueries = Number(flags['--queries']) || 0;
  // Drop nodes not seen within this many hours (0 disables pruning). Default 72h.
  const pruneHours =
    flags['--prune-hours'] !== undefined ? Number(flags['--prune-hours']) : 72;
  const arg = positionals[0]; // optional topic hash

  const hex = (buf) => (buf ? b4a.toString(buf, 'hex') : null);

  function randomTarget() {
    const buf = b4a.alloc(32);
    sodium.randombytes_buf(buf);
    return buf;
  }

  function ago(ms) {
    const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (secs < 60) {
      return `${secs}s`;
    }
    if (secs < 3600) {
      return `${Math.round(secs / 60)}m`;
    }
    if (secs < 86400) {
      return `${Math.round(secs / 3600)}h`;
    }
    return `${Math.round(secs / 86400)}d`;
  }

  // --- database --------------------------------------------------------------

  const db = openDb();

  const stmtExists = db.prepare(
    'SELECT first_seen, sessions FROM nodes WHERE host = ? AND port = ?'
  );
  // First sighting of a node within this run: bump seen_count AND sessions.
  const stmtUpsert = db.prepare(`
  INSERT INTO nodes (host, port, id, first_seen, last_seen, seen_count, sessions)
  VALUES (?, ?, ?, ?, ?, 1, 1)
  ON CONFLICT(host, port) DO UPDATE SET
    last_seen  = excluded.last_seen,
    seen_count = nodes.seen_count + 1,
    sessions   = nodes.sessions + 1,
    id         = COALESCE(excluded.id, nodes.id)
`);
  // Repeat sighting within the same run: bump seen_count only (not sessions).
  const stmtBump = db.prepare(`
  UPDATE nodes SET last_seen = ?, seen_count = seen_count + 1, id = COALESCE(?, id)
  WHERE host = ? AND port = ?
`);
  const stmtKnownPeers = db.prepare(
    'SELECT host, port FROM nodes ORDER BY last_seen DESC, sessions DESC LIMIT ?'
  );
  const stmtPrune = db.prepare('DELETE FROM nodes WHERE last_seen < ?');

  // Drop stale nodes not seen within pruneHours. Returns number removed.
  // (The geo cache is intentionally left intact — it's keyed by /24 and reusable
  // if a network reappears, saving an ip-api lookup.)
  function prune() {
    if (!(pruneHours > 0)) {
      return 0;
    }
    const cutoff = Date.now() - pruneHours * 3600 * 1000;
    const { changes } = stmtPrune.run(cutoff);
    if (changes) {
      console.log(`pruned ${changes} node(s) not seen in ${pruneHours}h`);
    }
    prunedThisRun += changes;
    return changes;
  }

  const seenThisRun = new Set(); // host:port observed during this run
  let queries = 0;
  let newThisRun = 0; // nodes first ever seen during this run
  let prunedThisRun = 0; // lunte-disable-line prefer-const — reassigned inside nested prune()

  function record(node) {
    if (!node || !node.host || !node.port) {
      return;
    }
    if (isPrivateIp(node.host)) {
      return;
    } // skip any node advertising a LAN/reserved address
    const addr = node.host + ':' + node.port;
    const idHex = hex(node.id);
    const now = Date.now();

    if (seenThisRun.has(addr)) {
      stmtBump.run(now, idHex, node.host, node.port);
      return;
    }
    seenThisRun.add(addr);

    const prior = stmtExists.get(node.host, node.port);
    stmtUpsert.run(node.host, node.port, idHex, now, now);

    if (!prior) {
      newThisRun++;
      console.log(`+ NEW    ${addr.padEnd(21)} id=${idHex || '?'}`);
    } else {
      console.log(
        `~ known  ${addr.padEnd(21)} sessions=${prior.sessions + 1}, first seen ${ago(prior.first_seen)} ago`
      );
    }
  }

  // Record a findNode response: the responder itself plus every closer node it
  // volunteered. Extracted from the crawl loop to keep that nesting shallow.
  function recordResponse(msg) {
    record(msg.from);
    if (!msg.closerNodes) {
      return;
    }
    for (const closer of msg.closerNodes) {
      record(closer);
    }
  }

  // --- dht --------------------------------------------------------------------

  // Prune stale nodes up front so we don't seed the routing table with dead ones.
  prune();
  const knownPeers = stmtKnownPeers.all(200);

  const dht = new DHT({ nodes: knownPeers });

  console.log('=== hyperdht-explorer ===');
  console.log('\nbootstrap nodes (configured):');
  for (const node of DHT.BOOTSTRAP) {
    console.log(
      '  -',
      typeof node === 'string' ? node : `${node.host}:${node.port}`
    );
  }
  console.log(
    `\nseeding routing table with ${knownPeers.length} known peer(s) from nodes.db`
  );
  console.log('\nbootstrapping...\n');

  dht.once('ready', () => {
    console.log('ready. our node id:', hex(dht.id) || '<ephemeral>');
    console.log('routing table seeded with', dht.toArray().length, 'node(s)\n');
  });

  async function crawl() {
    await dht.ready();

    if (arg) {
      const target = b4a.from(arg, 'hex');
      console.log('looking up announcers for topic:', arg, '\n');
      for await (const data of dht.lookup(target)) {
        record(data.from);
        for (const peer of data.peers || []) {
          console.log(
            `  announcer: ${hex(peer.publicKey)} via ${data.from.host}:${data.from.port}`
          );
        }
      }
      console.log('\nlookup complete.');
      return shutdown();
    }

    snapshotOnExit = true; // record a metrics snapshot when this crawl ends

    // Self-timed shutdown for bounded/scheduled runs.
    if (runForSeconds > 0) {
      console.log(`(will stop after ~${runForSeconds}s)\n`);
      globalThis.setTimeout(shutdown, runForSeconds * 1000);
    }
    if (maxQueries > 0) {
      console.log(`(will stop after ${maxQueries} queries)\n`);
    }

    while (running) {
      const target = randomTarget();
      queries++;
      try {
        for await (const msg of dht.findNode(target)) {
          recordResponse(msg);
        }
      } catch (err) {
        if (running) {
          console.error('query error:', err.message);
        }
      }
      if (queries % 50 === 0) {
        prune();
      } // periodically drop nodes gone stale mid-run
      if (queries % 10 === 0) {
        const total = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
        console.log(
          `\n-- ${queries} queries | ${seenThisRun.size} nodes this run | ${total} known all-time --\n`
        );
      }
      if (maxQueries > 0 && queries >= maxQueries) {
        return shutdown();
      }
    }
  }

  function summary() {
    const total = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
    console.log(
      `\n=== summary: ${seenThisRun.size} nodes this run, ${total} known all-time, ${queries} queries ===`
    );
    console.log('\nmost stable peers (by sessions seen):');
    const rows = db
      .prepare(
        `
    SELECT host, port, sessions, seen_count, first_seen, last_seen
    FROM nodes ORDER BY sessions DESC, seen_count DESC LIMIT 15
  `
      )
      .all();
    for (const row of rows) {
      const lifespan = ago(row.first_seen);
      console.log(
        `  ${(row.host + ':' + row.port).padEnd(21)} sessions=${String(row.sessions).padStart(3)} hits=${String(row.seen_count).padStart(4)} known for ${lifespan}`
      );
    }
  }

  // Record one metrics snapshot for the time-series view (timeline.mjs).
  function writeSnapshot() {
    const total = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
    const alive = db
      .prepare('SELECT COUNT(*) AS n FROM nodes WHERE alive = 1')
      .get().n;
    const seeders = db
      .prepare('SELECT COUNT(*) AS n FROM nodes WHERE app_seeder IS NOT NULL')
      .get().n;
    const observed = db
      .prepare('SELECT COUNT(DISTINCT public_key) AS n FROM observations')
      .get().n;
    const rtts = db
      .prepare(
        'SELECT rtt_ms FROM nodes WHERE alive = 1 AND rtt_ms IS NOT NULL'
      )
      .all()
      .map((row) => row.rtt_ms)
      .sort((a, b) => a - b);
    const medianRtt = rtts.length ? rtts[rtts.length >> 1] : null;

    // distinct located countries / ASNs among current nodes (join by /24 in JS)
    const geo = new Map(
      db
        .prepare(
          "SELECT prefix, country, as_info FROM geo WHERE status = 'success'"
        )
        .all()
        .map((geoRow) => [geoRow.prefix, geoRow])
    );
    const countries = new Set();
    const asns = new Set();
    for (const { host } of db
      .prepare('SELECT DISTINCT host FROM nodes')
      .all()) {
      const geoRow = geo.get(prefixOf(host));
      if (geoRow) {
        if (geoRow.country) {
          countries.add(geoRow.country);
        }
        if (geoRow.as_info) {
          asns.add(geoRow.as_info);
        }
      }
    }

    db.prepare(
      `
    INSERT OR REPLACE INTO snapshots (ts, total_nodes, alive, new_nodes, pruned, countries, asns, seeders, median_rtt, observed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    ).run(
      Date.now(),
      total,
      alive,
      newThisRun,
      prunedThisRun,
      countries.size,
      asns.size,
      seeders,
      medianRtt,
      observed
    );
    console.log(
      `snapshot: ${total} nodes, ${alive} alive, ${newThisRun} new, ${prunedThisRun} pruned, ${countries.size} countries, ${seeders} seeders, ${observed} observed`
    );
  }

  let running = true;
  let shuttingDown = false;
  let snapshotOnExit = false; // lunte-disable-line prefer-const — reassigned inside nested crawl()
  let resolveRun;
  const done = new Promise((resolve) => {
    resolveRun = resolve;
  });
  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    running = false;
    summary();
    if (snapshotOnExit) {
      try {
        writeSnapshot();
      } catch (err) {
        console.error('snapshot failed:', err.message);
      }
    }
    try {
      await dht.destroy();
    } catch {}
    try {
      db.close();
    } catch {}
    resolveRun();
  }

  // bin.mjs owns signal handling and invokes this via ctx.onShutdown, so SIGINT/
  // SIGTERM print the summary + write a snapshot before exiting. Whether the signal
  // actually reaches JS depends on the runtime forwarding it (standalone/pear build
  // vs plain `bare bin.mjs` — see CLAUDE.md); for a guaranteed clean stop under dev
  // prefer the --for / --queries options above. `teardown` is a safety net for any
  // runtime-driven teardown.
  ctx.onShutdown?.(shutdown);
  globalThis.Bare?.on?.('teardown', shutdown);

  crawl().catch((err) => {
    console.error('fatal:', err);
    shutdown();
  });

  await done;
}
