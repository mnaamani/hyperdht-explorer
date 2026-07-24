import { DatabaseSync } from 'bare-sqlite';
import { dbPath, ensureDirs } from './paths.mjs';

// Shared database access for the hyperdht-explorer tools (crawler, geo, map).
//
// Two tables:
//   nodes - one row per discovered host:port (see scan.mjs for tracking logic)
//   geo   - one row per /24 subnet (255.255.255.0). We assume any two IPs that
//           share the first three octets sit in the same network and therefore
//           the same geo-location, so we only ever hit the geoip API once per
//           /24. This caps API usage hard and respects ip-api.com rate limits.

export function openDb(path = dbPath()) {
  ensureDirs(); // make sure the app-data dir exists before SQLite touches it
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      host       TEXT    NOT NULL,
      port       INTEGER NOT NULL,
      id         TEXT,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1,
      sessions   INTEGER NOT NULL DEFAULT 1,
      alive      INTEGER,           -- 1 = answered last ping, 0 = didn't, NULL = never probed
      rtt_ms     INTEGER,           -- round-trip time of last successful ping
      last_ping  INTEGER,           -- when we last probed it
      app_seeder TEXT,              -- app name this endpoint relays/seeds (e.g. 'keet'), else NULL
      PRIMARY KEY (host, port)
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes (last_seen DESC);

    CREATE TABLE IF NOT EXISTS geo (
      prefix       TEXT PRIMARY KEY,   -- /24 network, e.g. "143.198.58"
      status       TEXT,               -- 'success' | 'fail'
      country      TEXT,
      country_code TEXT,
      region       TEXT,
      city         TEXT,
      lat          REAL,
      lon          REAL,
      isp          TEXT,
      org          TEXT,
      as_info      TEXT,
      mobile       INTEGER,            -- ip-api flags: 1 = mobile network
      proxy        INTEGER,            -- 1 = proxy/VPN/Tor
      hosting      INTEGER,            -- 1 = datacenter/hosting
      queried_at   INTEGER NOT NULL
    );

    -- Peers observed CONNECTING to us while seeding a public topic (observe.mjs).
    -- Aggregate health data only — never used to track individuals.
    CREATE TABLE IF NOT EXISTS observations (
      public_key TEXT NOT NULL,
      host       TEXT NOT NULL,
      port       INTEGER NOT NULL,
      app        TEXT,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (public_key, host, port)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      ts          INTEGER PRIMARY KEY,  -- end-of-scan time (epoch ms)
      total_nodes INTEGER,
      alive       INTEGER,
      new_nodes   INTEGER,              -- nodes first seen during that run
      pruned      INTEGER,              -- stale nodes removed during that run
      countries   INTEGER,              -- distinct located countries
      asns        INTEGER,              -- distinct located networks (AS)
      seeders     INTEGER,              -- nodes tagged app_seeder
      median_rtt  INTEGER,
      observed    INTEGER               -- distinct participants seen via observe.mjs
    );

    -- AS-level BGP topology (from RIPEstat OSINT), cached so we don't refetch.
    CREATE TABLE IF NOT EXISTS as_neighbours (
      asn        INTEGER NOT NULL,   -- one of our DHT-hosting ASNs
      neighbour  INTEGER NOT NULL,   -- a BGP-adjacent AS
      type       TEXT,               -- 'left' (upstream-ish) | 'right' | 'uncertain'
      power      INTEGER,            -- # of AS paths the adjacency was seen on
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (asn, neighbour)
    );
    CREATE TABLE IF NOT EXISTS as_names (
      asn        INTEGER PRIMARY KEY,
      name       TEXT,
      fetched_at INTEGER NOT NULL
    );

    -- RPKI route-origin validation per /24 (from RIPEstat), cached.
    CREATE TABLE IF NOT EXISTS rpki (
      prefix24   TEXT PRIMARY KEY,  -- "88.198.25"
      covering   TEXT,             -- the actual announced prefix, e.g. "88.198.0.0/16"
      origin_asn INTEGER,
      status     TEXT,             -- 'valid' | 'invalid' | 'unknown' | 'unannounced'
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS store_probes (
      ts               INTEGER PRIMARY KEY,  -- probe time (epoch ms)
      canaries         INTEGER,   -- records put this probe
      put_ok           INTEGER,   -- puts that succeeded
      get_ok           INTEGER,   -- records retrievable via a fresh lookup
      replicas_initial REAL,      -- avg # of closest nodes serving the record right after put
      replicas_after   REAL,      -- avg # still serving it after delay_s
      persistence      REAL,      -- replicas_after / replicas_initial (0..1)
      delay_s          INTEGER,   -- final re-check offset (seconds) — spans the record TTL
      decay            TEXT       -- JSON [{m, replicas}] decay curve across checkpoints
    );
  `);

  // Migrate older databases that predate the ping-probe columns.
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(nodes)')
      .all()
      .map((col) => col.name)
  );
  if (!cols.has('alive')) {
    db.exec('ALTER TABLE nodes ADD COLUMN alive INTEGER');
  }
  if (!cols.has('rtt_ms')) {
    db.exec('ALTER TABLE nodes ADD COLUMN rtt_ms INTEGER');
  }
  if (!cols.has('last_ping')) {
    db.exec('ALTER TABLE nodes ADD COLUMN last_ping INTEGER');
  }
  if (!cols.has('app_seeder')) {
    db.exec('ALTER TABLE nodes ADD COLUMN app_seeder TEXT');
  }
  const spCols = new Set(
    db
      .prepare('PRAGMA table_info(store_probes)')
      .all()
      .map((col) => col.name)
  );
  if (spCols.size && !spCols.has('decay')) {
    db.exec('ALTER TABLE store_probes ADD COLUMN decay TEXT');
  }
  const geoCols = new Set(
    db
      .prepare('PRAGMA table_info(geo)')
      .all()
      .map((col) => col.name)
  );
  for (const col of ['mobile', 'proxy', 'hosting']) {
    if (geoCols.size && !geoCols.has(col)) {
      db.exec(`ALTER TABLE geo ADD COLUMN ${col} INTEGER`);
    }
  }
  if (
    !new Set(
      db
        .prepare('PRAGMA table_info(snapshots)')
        .all()
        .map((col) => col.name)
    ).has('observed')
  ) {
    db.exec('ALTER TABLE snapshots ADD COLUMN observed INTEGER');
  }

  return db;
}

// ---------------------------------------------------------------------------
// Data-access layer (repository pattern)
//
// Instead of each command hand-writing prepared statements, a per-table factory
// prepares them once and exposes named methods. The raw SQL stays here in
// db.mjs (the single schema-owning module); command code reads as intent
// ("record a sighting", "prune stale nodes") rather than SQL. Statements are
// still prepared once per repo instance and reused, so there is no perf cost
// versus the inline `db.prepare(...)` calls this replaces.
//
// Style: methods taking more than a host/port pair take a single destructured
// options object (house rule) so interchangeable args can't be transposed at a
// call site. Placeholders stay positional `?` — we don't lean on the runtime's
// named-parameter binding. Read helpers that feed a JS-side /24 join return a
// Map keyed by prefix; the rest return rows or plain arrays.
// ---------------------------------------------------------------------------

export function nodesRepo(db) {
  const stmts = {
    priorSighting: db.prepare(
      'SELECT first_seen, sessions FROM nodes WHERE host = ? AND port = ?'
    ),
    // First sighting of a node within a run: bump seen_count AND sessions.
    firstSightingThisRun: db.prepare(`
      INSERT INTO nodes
        (host, port, id, first_seen, last_seen, seen_count, sessions)
      VALUES (?, ?, ?, ?, ?, 1, 1)
      ON CONFLICT(host, port) DO UPDATE SET
        last_seen  = excluded.last_seen,
        seen_count = nodes.seen_count + 1,
        sessions   = nodes.sessions + 1,
        id         = COALESCE(excluded.id, nodes.id)
    `),
    // Repeat sighting within the same run: bump seen_count only (not sessions).
    repeatSighting: db.prepare(`
      UPDATE nodes
      SET last_seen = ?, seen_count = seen_count + 1, id = COALESCE(?, id)
      WHERE host = ? AND port = ?
    `),
    // A seeder relay endpoint (seeders.mjs): create/refresh + tag app_seeder.
    seederEndpoint: db.prepare(`
      INSERT INTO nodes
        (host, port, first_seen, last_seen, seen_count, sessions, app_seeder)
      VALUES (?, ?, ?, ?, 1, 1, ?)
      ON CONFLICT(host, port) DO UPDATE SET
        last_seen  = excluded.last_seen,
        seen_count = nodes.seen_count + 1,
        app_seeder = excluded.app_seeder
    `),
    markAlive: db.prepare(
      'UPDATE nodes SET alive = 1, rtt_ms = ?, last_ping = ? WHERE host = ? AND port = ?'
    ),
    markDead: db.prepare(
      'UPDATE nodes SET alive = 0, rtt_ms = NULL, last_ping = ? WHERE host = ? AND port = ?'
    ),
    recentPeers: db.prepare(
      'SELECT host, port FROM nodes ORDER BY last_seen DESC, sessions DESC LIMIT ?'
    ),
    byRecency: db.prepare(
      'SELECT host, port FROM nodes ORDER BY last_seen DESC'
    ),
    pruneStale: db.prepare('DELETE FROM nodes WHERE last_seen < ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM nodes'),
    countAlive: db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE alive = 1'),
    countSeeders: db.prepare(
      'SELECT COUNT(*) AS n FROM nodes WHERE app_seeder IS NOT NULL'
    ),
    countWithoutRoutingId: db.prepare(
      'SELECT COUNT(*) AS n FROM nodes WHERE id IS NULL'
    ),
    aliveRtts: db.prepare(
      'SELECT rtt_ms FROM nodes WHERE alive = 1 AND rtt_ms IS NOT NULL'
    ),
    // Alive/dead/unprobed/seeder tallies + freshness, in one pass (stats.mjs).
    breakdown: db.prepare(`
      SELECT
        SUM(CASE WHEN alive = 1 THEN 1 ELSE 0 END) AS alive,
        SUM(CASE WHEN alive = 0 THEN 1 ELSE 0 END) AS dead,
        SUM(CASE WHEN alive IS NULL THEN 1 ELSE 0 END) AS unprobed,
        SUM(CASE WHEN app_seeder IS NOT NULL THEN 1 ELSE 0 END) AS seeders,
        MAX(last_seen) AS last_seen,
        MAX(last_ping) AS last_ping
      FROM nodes
    `),
    hosts: db.prepare('SELECT host FROM nodes'),
    distinctHosts: db.prepare('SELECT DISTINCT host FROM nodes'),
    seederHosts: db.prepare(
      'SELECT host, app_seeder FROM nodes WHERE app_seeder IS NOT NULL'
    ),
    withRoutingId: db.prepare(
      'SELECT id, seen_count, sessions, app_seeder FROM nodes WHERE id IS NOT NULL'
    ),
    allWithStats: db.prepare(`
      SELECT host, port, sessions, seen_count, first_seen, last_seen,
             alive, rtt_ms, app_seeder
      FROM nodes
    `),
    lifespans: db.prepare(
      'SELECT first_seen, last_seen, seen_count FROM nodes'
    ),
    mostStable: db.prepare(`
      SELECT host, port, sessions, seen_count, first_seen, last_seen
      FROM nodes ORDER BY sessions DESC, seen_count DESC LIMIT ?
    `)
  };

  return {
    // Prior state of a node before this run's sighting (undefined if brand new).
    priorSighting: ({ host, port }) => stmts.priorSighting.get(host, port),
    // Record the first time we've seen a node during the current run.
    recordFirstSightingThisRun: ({ host, port, id, at }) =>
      stmts.firstSightingThisRun.run(host, port, id, at, at),
    // Record a repeat sighting of a node already seen earlier this run.
    recordRepeatSighting: ({ host, port, id, at }) =>
      stmts.repeatSighting.run(at, id, host, port),
    // Record/refresh an app-seeder relay endpoint (seeders.mjs).
    recordSeederEndpoint: ({ host, port, app, at }) =>
      stmts.seederEndpoint.run(host, port, at, at, app),
    // Probe outcome (probe.mjs): reachable with an RTT, or unreachable.
    markAlive: ({ host, port, rttMs, at }) =>
      stmts.markAlive.run(rttMs, at, host, port),
    markDead: ({ host, port, at }) => stmts.markDead.run(at, host, port),
    recentPeers: (limit) => stmts.recentPeers.all(limit),
    byRecency: () => stmts.byRecency.all(),
    // Delete nodes not seen since `cutoff` (epoch ms). Returns rows removed.
    pruneStaleBefore: (cutoff) => stmts.pruneStale.run(cutoff).changes,
    count: () => stmts.count.get().n,
    countAlive: () => stmts.countAlive.get().n,
    countSeeders: () => stmts.countSeeders.get().n,
    countWithoutRoutingId: () => stmts.countWithoutRoutingId.get().n,
    // Median RTT across live nodes, or null when none have an RTT recorded.
    medianAliveRtt: () => {
      const rtts = stmts.aliveRtts
        .all()
        .map((row) => row.rtt_ms)
        .sort((left, right) => left - right);
      return rtts.length ? rtts[rtts.length >> 1] : null;
    },
    breakdown: () => stmts.breakdown.get(),
    hosts: () => stmts.hosts.all().map((row) => row.host),
    distinctHosts: () => stmts.distinctHosts.all().map((row) => row.host),
    seederHosts: () => stmts.seederHosts.all(),
    withRoutingId: () => stmts.withRoutingId.all(),
    allWithStats: () => stmts.allWithStats.all(),
    lifespans: () => stmts.lifespans.all(),
    mostStable: (limit) => stmts.mostStable.all(limit)
  };
}

export function observationsRepo(db) {
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO observations
        (public_key, host, port, app, first_seen, last_seen, count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(public_key, host, port) DO UPDATE SET
        last_seen = excluded.last_seen, count = count + 1
    `),
    countParticipants: db.prepare(
      'SELECT COUNT(DISTINCT public_key) AS n FROM observations'
    ),
    countParticipantsForApp: db.prepare(
      'SELECT COUNT(DISTINCT public_key) AS n FROM observations WHERE app = ?'
    ),
    distinctKeysForApp: db.prepare(
      'SELECT DISTINCT public_key FROM observations WHERE app = ?'
    ),
    distinctHostsForApp: db.prepare(
      'SELECT DISTINCT host FROM observations WHERE app = ?'
    ),
    distinctHosts: db.prepare('SELECT DISTINCT host FROM observations'),
    all: db.prepare('SELECT host, app, public_key FROM observations'),
    allDetailed: db.prepare(
      `SELECT public_key, host, app, first_seen, last_seen, count
       FROM observations`
    ),
    keyCounts: db.prepare('SELECT public_key, count FROM observations')
  };
  return {
    // Record a connecting peer as aggregate health (observe.mjs).
    record: ({ publicKey, host, port, app, at }) =>
      stmts.upsert.run(publicKey, host, port, app, at, at),
    countDistinctParticipants: () => stmts.countParticipants.get().n,
    countDistinctForApp: (app) => stmts.countParticipantsForApp.get(app).n,
    distinctKeysForApp: (app) =>
      stmts.distinctKeysForApp.all(app).map((row) => row.public_key),
    distinctHostsForApp: (app) =>
      stmts.distinctHostsForApp.all(app).map((row) => row.host),
    distinctHosts: () => stmts.distinctHosts.all().map((row) => row.host),
    all: () => stmts.all.all(),
    // Full observation rows for the summary tables (per-app + app×country).
    allDetailed: () => stmts.allDetailed.all(),
    keyCounts: () => stmts.keyCounts.all()
  };
}

export function geoRepo(db) {
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO geo
        (prefix, status, country, country_code, region, city, lat, lon,
         isp, org, as_info, mobile, proxy, hosting, queried_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prefix) DO UPDATE SET
        status = excluded.status, country = excluded.country,
        country_code = excluded.country_code, region = excluded.region,
        city = excluded.city, lat = excluded.lat, lon = excluded.lon,
        isp = excluded.isp, org = excluded.org, as_info = excluded.as_info,
        mobile = excluded.mobile, proxy = excluded.proxy,
        hosting = excluded.hosting, queried_at = excluded.queried_at
    `),
    statusFlags: db.prepare('SELECT prefix, status, hosting FROM geo'),
    located: db.prepare("SELECT * FROM geo WHERE status = 'success'"),
    locatedWithCoords: db.prepare(
      "SELECT * FROM geo WHERE status = 'success' AND lat IS NOT NULL"
    )
  };
  return {
    // Insert/refresh one /24's ip-api result (geo.mjs).
    upsert: ({
      prefix,
      status,
      country,
      countryCode,
      region,
      city,
      lat,
      lon,
      isp,
      org,
      asInfo,
      mobile,
      proxy,
      hosting,
      queriedAt
    }) =>
      stmts.upsert.run(
        prefix,
        status,
        country,
        countryCode,
        region,
        city,
        lat,
        lon,
        isp,
        org,
        asInfo,
        mobile,
        proxy,
        hosting,
        queriedAt
      ),
    // prefix/status/hosting for the "already enriched" skip-set (geo.mjs).
    statusFlags: () => stmts.statusFlags.all(),
    // All successfully-located /24 networks, keyed by prefix for JS-side joins.
    locatedNetworks: () =>
      new Map(stmts.located.all().map((row) => [row.prefix, row])),
    // Same, restricted to rows with plottable coordinates (map.mjs).
    locatedWithCoords: () =>
      new Map(stmts.locatedWithCoords.all().map((row) => [row.prefix, row]))
  };
}

export function snapshotsRepo(db) {
  const stmts = {
    insert: db.prepare(`
      INSERT OR REPLACE INTO snapshots
        (ts, total_nodes, alive, new_nodes, pruned, countries, asns,
         seeders, median_rtt, observed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    latest: db.prepare('SELECT * FROM snapshots ORDER BY ts DESC LIMIT 1'),
    chronological: db.prepare('SELECT * FROM snapshots ORDER BY ts')
  };
  return {
    insert: ({
      ts,
      totalNodes,
      alive,
      newNodes,
      pruned,
      countries,
      asns,
      seeders,
      medianRtt,
      observed
    }) =>
      stmts.insert.run(
        ts,
        totalNodes,
        alive,
        newNodes,
        pruned,
        countries,
        asns,
        seeders,
        medianRtt,
        observed
      ),
    latest: () => stmts.latest.get(),
    chronological: () => stmts.chronological.all()
  };
}

export function storeProbesRepo(db) {
  const stmts = {
    insert: db.prepare(`
      INSERT OR REPLACE INTO store_probes
        (ts, canaries, put_ok, get_ok, replicas_initial, replicas_after,
         persistence, delay_s, decay)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    latest: db.prepare('SELECT * FROM store_probes ORDER BY ts DESC LIMIT 1'),
    chronological: db.prepare('SELECT * FROM store_probes ORDER BY ts')
  };
  return {
    insert: ({
      ts,
      canaries,
      putOk,
      getOk,
      replicasInitial,
      replicasAfter,
      persistence,
      delayS,
      decay
    }) =>
      stmts.insert.run(
        ts,
        canaries,
        putOk,
        getOk,
        replicasInitial,
        replicasAfter,
        persistence,
        delayS,
        decay
      ),
    latest: () => stmts.latest.get(),
    chronological: () => stmts.chronological.all()
  };
}

// as_neighbours + as_names: the cached BGP underlay for topo.mjs.
export function asTopologyRepo(db) {
  const stmts = {
    neighbourFreshness: db.prepare(
      'SELECT asn, MAX(fetched_at) AS f FROM as_neighbours GROUP BY asn'
    ),
    insertNeighbour: db.prepare(`
      INSERT OR REPLACE INTO as_neighbours (asn, neighbour, type, power, fetched_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    deleteNeighbours: db.prepare('DELETE FROM as_neighbours WHERE asn = ?'),
    neighboursOf: db.prepare(
      'SELECT neighbour FROM as_neighbours WHERE asn = ?'
    ),
    names: db.prepare('SELECT asn, name FROM as_names'),
    insertName: db.prepare(
      'INSERT OR REPLACE INTO as_names (asn, name, fetched_at) VALUES (?, ?, ?)'
    )
  };
  return {
    // [{ asn, f }] — most recent fetch time per ASN, for the freshness check.
    neighbourFreshness: () => stmts.neighbourFreshness.all(),
    insertNeighbour: ({ asn, neighbour, type, power, at }) =>
      stmts.insertNeighbour.run(asn, neighbour, type, power, at),
    deleteNeighbours: (asn) => stmts.deleteNeighbours.run(asn),
    neighboursOf: (asn) =>
      stmts.neighboursOf.all(asn).map((row) => row.neighbour),
    names: () => stmts.names.all(),
    insertName: ({ asn, name, at }) => stmts.insertName.run(asn, name, at)
  };
}

export function rpkiRepo(db) {
  const stmts = {
    upsert: db.prepare(`
      INSERT OR REPLACE INTO rpki (prefix24, covering, origin_asn, status, fetched_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    freshness: db.prepare('SELECT prefix24, fetched_at FROM rpki'),
    statuses: db.prepare('SELECT prefix24, status FROM rpki')
  };
  return {
    upsert: ({ prefix24, covering, originAsn, status, fetchedAt }) =>
      stmts.upsert.run(prefix24, covering, originAsn, status, fetchedAt),
    // [{ prefix24, fetched_at }] for the cache-freshness skip-set (rpki.mjs).
    freshness: () => stmts.freshness.all(),
    // [{ prefix24, status }] for per-ASN aggregation (topo.mjs).
    statuses: () => stmts.statuses.all()
  };
}

// Well-known PUBLIC Pear apps, referenceable by name (instead of a full pear://
// link) in `seeders` and `observe`. Only add a preset once its public pear://
// link is VERIFIED — never guess a key. The name doubles as the default app tag.
export const APP_PRESETS = {
  // Keet (keet.io) — also used by ops/scheduled-observe.sh + README.
  keet: 'pear://17pwkcszz18deaccarhrrixhzf1f5ko1b1dz6j3pxhexebutjwzy',
  // PearPass — password manager Pear app.
  pearpass: 'pear://dbkezmhetxwo95ab1kcojfraw1eryzf7kex5cahykf6b9c3amd6o'
};

// Resolve a positional arg to { link, name }: a bare preset name (e.g. 'keet')
// expands to its link and offers the preset name as the default tag; anything
// else (a pear:// link or raw key) passes through with no default tag.
export function resolvePreset(arg) {
  const preset = arg && APP_PRESETS[arg.toLowerCase()];
  if (preset) {
    return { link: preset, name: arg.toLowerCase() };
  }
  return { link: arg, name: null };
}

// True for private / reserved / non-routable IPv4 (RFC1918, loopback, link-local,
// CGNAT, multicast, reserved). Non-IPv4 strings are treated as not-private.
export function isPrivateIp(host) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(host));
  if (!match) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 0 || a === 10 || a === 127) {
    return true;
  } // this-net, 10/8, loopback
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  } // 172.16.0.0/12
  if (a === 192 && b === 168) {
    return true;
  } // 192.168.0.0/16
  if (a === 169 && b === 254) {
    return true;
  } // link-local
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  } // CGNAT 100.64.0.0/10
  if (a >= 224) {
    return true;
  } // multicast / reserved / broadcast
  return false;
}

// Classify a network by ip-api flags: datacenter / mobile / proxy / residential.
// "residential" = located but flagged as none of the above (eyeball/business ISP),
// a useful proxy for "likely an end-user's machine rather than infrastructure".
export function hostKind(geoRow) {
  if (!geoRow) {
    return 'unknown';
  }
  if (geoRow.hosting) {
    return 'datacenter';
  }
  if (geoRow.mobile) {
    return 'mobile';
  }
  if (geoRow.proxy) {
    return 'proxy';
  }
  if (geoRow.country) {
    return 'residential';
  }
  return 'unknown';
}

// IPv4 /24 network key. Non-IPv4 hosts fall back to the host itself so they
// still get looked up individually rather than being silently merged.
export function prefixOf(host) {
  const parts = String(host).split('.');
  if (
    parts.length === 4 &&
    parts.every((part) => part !== '' && Number.isInteger(+part))
  ) {
    return parts.slice(0, 3).join('.');
  }
  return host;
}

// Registry holder/AS names sometimes carry stray double quotes (e.g.
// `JSC "ER-Telecom Holding"`) which are just noise — strip them and tidy spacing
// so display names render cleanly everywhere.
export function cleanName(str) {
  return str ? str.replace(/"/g, '').replace(/\s+/g, ' ').trim() : str;
}

// ip-api's `as` field looks like "AS24940 Hetzner Online GmbH" — split the AS
// number from the operator name. Falls back to org/isp when there's no AS string.
export function parseAs(asInfo, org, isp) {
  if (asInfo) {
    const match = /^AS(\d+)\s*(.*)$/i.exec(asInfo.trim());
    if (match) {
      return {
        asn: 'AS' + match[1],
        asnNum: Number(match[1]),
        name: cleanName(match[2] || org || isp || '') || 'AS' + match[1]
      };
    }
    return { asn: null, asnNum: null, name: cleanName(asInfo) };
  }
  return { asn: null, asnNum: null, name: cleanName(org || isp || null) };
}
