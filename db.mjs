import { DatabaseSync } from 'bare-sqlite';
import sodium from 'sodium-universal';
import b4a from 'b4a';
import { dbPath, ensureDirs } from './paths.mjs';

// Shared database access for the hyperdht-explorer tools (crawler, geo, map).
//
// Two tables:
//   nodes - one row per discovered host:port (see scan.mjs for tracking logic)
//   geo   - one row per /24 subnet (255.255.255.0). We assume any two IPs that
//           share the first three octets sit in the same network and therefore
//           the same geo-location, so we only ever hit the geoip API once per
//           /24. This caps API usage hard and respects ip-api.com rate limits.
//
// Data-protection note: everything the DB learns about a peer is either an
// address (nodes) or a pseudonym (observations). See PRIVACY.md and docs/lia.md
// for why each field exists; the short version is that `observations` never
// stores a peer's real public key (see pseudonymOf) and no table is allowed to
// hold a network an operator has excluded (see exclusionsRepo).

// Pseudonym length in bytes. 16 bytes of keyed BLAKE2b is far beyond collision
// range for the number of peers we will ever see, while being short enough that
// nobody mistakes it for a real 32-byte hypercore key.
const PSEUDONYM_BYTES = 16;
const SALT_BYTES = 32;

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
    -- Keyed by /24, not by host:port. Source ports are ephemeral and full host
    -- addresses were never read by anything (every consumer collapsed them to
    -- prefixOf() immediately), so keying on the network both stops reconnect
    -- churn from inserting near-duplicate rows and keeps peer addresses out of
    -- the database entirely. Rows are pruned by last_seen — see observe.mjs.
    --
    -- key_hash is a PSEUDONYM, not the peer's public key: keyed BLAKE2b of the
    -- real key under a salt that rotates monthly and is then destroyed (see
    -- pseudonymsRepo). We only ever need "how many distinct peers", which a
    -- pseudonym answers as well as an identifier does — but once the salt for a
    -- period is gone, nobody (us included) can work back from a stored row to
    -- the peer, or link that peer's rows across periods.
    CREATE TABLE IF NOT EXISTS observations (
      key_hash   TEXT NOT NULL,   -- pseudonym, scoped to the salt period
      prefix24   TEXT NOT NULL,   -- the /24, e.g. "143.198.58"
      app        TEXT,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (key_hash, prefix24)
    );

    -- The rotating salts behind observations.key_hash. One row per period; the
    -- salt is generated on first use in that period and deleted once every
    -- observation that could have used it has been pruned (period_end + the
    -- retention window). Deleting the salt is what turns the surviving rows from
    -- pseudonymous into effectively anonymous data.
    CREATE TABLE IF NOT EXISTS pseudonym_salts (
      period     TEXT PRIMARY KEY,  -- 'YYYY-MM'
      salt       TEXT NOT NULL,     -- hex, ${SALT_BYTES} bytes
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL   -- period end + retention; purge after this
    );

    -- Networks that have asked not to be recorded (GDPR Art. 21 objection), or
    -- that the operator excludes for any other reason. Enforced at the point of
    -- WRITE inside nodesRepo/observationsRepo, so no command can bypass it by
    -- forgetting to check. Adding an entry also purges what is already stored.
    CREATE TABLE IF NOT EXISTS exclusions (
      prefix24   TEXT PRIMARY KEY,  -- the /24, e.g. "143.198.58"
      reason     TEXT,
      created_at INTEGER NOT NULL
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
  migrateObservationsToPrefix(db);
  migrateObservationsToPseudonyms(db);

  return db;
}

// Current salt period for a timestamp: month-granular, plus the instant the
// period closes. Monthly is the trade-off point — short enough that a peer's
// pseudonym stops following it around within a couple of months, long enough
// that "distinct participants" and returning-vs-new stay meaningful inside a
// reporting period.
export function saltPeriodOf(at) {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const pad = String(month + 1).padStart(2, '0');
  return { period: `${year}-${pad}`, periodEnd: Date.UTC(year, month + 1, 1) };
}

// Pseudonymise a peer's public key under a period salt: keyed BLAKE2b, i.e. a
// MAC rather than a bare hash. A bare hash of a 32-byte public key would be
// trivially reversible for anyone holding a list of candidate keys (the input
// space is enumerable if you know who you are looking for) — the secret salt is
// what makes the mapping one-way in practice, and destroying the salt is what
// makes it one-way permanently.
export function pseudonymOf({ publicKey, salt }) {
  const input = b4a.isBuffer(publicKey)
    ? publicKey
    : b4a.from(publicKey, 'hex');
  const out = b4a.alloc(PSEUDONYM_BYTES);
  sodium.crypto_generichash(out, input, salt);
  return b4a.toString(out, 'hex');
}

// Rebuild an observations table that still stores raw peer public keys.
//
// The old rows can't be re-keyed under a period salt — we don't know which
// period each sighting belongs to, and back-dating them would be a lie. Instead
// every surviving row is hashed under ONE throwaway salt that exists only for
// the duration of this function and is never written to disk. That keeps the
// table's only real use (counting distinct peers) intact while making the
// pre-migration keys unrecoverable, which is the whole point of the change.
//
// Rows can collide after hashing only if they already shared a public key and
// prefix, which the old PK made impossible — the ON CONFLICT merge is belt and
// braces for a hand-edited database.
function migrateObservationsToPseudonyms(db) {
  const obsCols = new Set(
    db
      .prepare('PRAGMA table_info(observations)')
      .all()
      .map((col) => col.name)
  );
  if (!obsCols.has('public_key')) {
    return;
  }
  const salt = b4a.alloc(SALT_BYTES);
  sodium.randombytes_buf(salt);
  const rows = db
    .prepare(
      `SELECT public_key, prefix24, app, first_seen, last_seen, count
       FROM observations`
    )
    .all();
  db.exec(`
    CREATE TABLE observations_hashed (
      key_hash   TEXT NOT NULL,
      prefix24   TEXT NOT NULL,
      app        TEXT,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (key_hash, prefix24)
    );
  `);
  const insert = db.prepare(`
    INSERT INTO observations_hashed
      (key_hash, prefix24, app, first_seen, last_seen, count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key_hash, prefix24) DO UPDATE SET
      first_seen = MIN(observations_hashed.first_seen, excluded.first_seen),
      last_seen  = MAX(observations_hashed.last_seen, excluded.last_seen),
      count      = observations_hashed.count + excluded.count
  `);
  db.exec('BEGIN;');
  for (const row of rows) {
    insert.run(
      pseudonymOf({ publicKey: row.public_key, salt }),
      row.prefix24,
      row.app,
      row.first_seen,
      row.last_seen,
      row.count
    );
  }
  db.exec(`
    DROP TABLE observations;
    ALTER TABLE observations_hashed RENAME TO observations;
    COMMIT;
  `);
  sodium.sodium_memzero(salt);
}

// Rebuild a pre-/24 observations table: PK (public_key, host, port) ->
// (public_key, prefix24), dropping host and port. A primary key can't be
// ALTERed in SQLite, so this is a create/copy/swap, guarded on the old `host`
// column still being present and wrapped in a transaction (an interrupted run
// leaves the original table untouched).
//
// Collapsing duplicates: rows for the same peer across ports — and across
// hosts inside one /24 — merge into one, summing `count` and taking the
// earliest first_seen / latest last_seen. `app` is taken from the most recent
// contributing row; a peer seen under two app tags previously kept whichever
// row was inserted first, so neither shape carries per-app history.
//
// rtrim(rtrim(host,'0123456789'),'.') is prefixOf() in SQL: strip the trailing
// octet's digits, then the dot. Safe here because every host is a validated
// IPv4 literal (the DHT is IPv4-only).
function migrateObservationsToPrefix(db) {
  const obsCols = new Set(
    db
      .prepare('PRAGMA table_info(observations)')
      .all()
      .map((col) => col.name)
  );
  if (!obsCols.has('host')) {
    return;
  }
  db.exec(`
    BEGIN;
    CREATE TABLE observations_new (
      public_key TEXT NOT NULL,
      prefix24   TEXT NOT NULL,
      app        TEXT,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (public_key, prefix24)
    );
    INSERT INTO observations_new
      (public_key, prefix24, app, first_seen, last_seen, count)
    WITH expanded AS (
      SELECT
        public_key,
        rtrim(rtrim(host, '0123456789'), '.') AS prefix24,
        app,
        first_seen,
        last_seen,
        count
      FROM observations
    )
    SELECT
      grouped.public_key,
      grouped.prefix24,
      (SELECT pick.app FROM expanded AS pick
        WHERE pick.public_key = grouped.public_key
          AND pick.prefix24 = grouped.prefix24
        ORDER BY pick.last_seen DESC LIMIT 1),
      MIN(grouped.first_seen),
      MAX(grouped.last_seen),
      SUM(grouped.count)
    FROM expanded AS grouped
    GROUP BY grouped.public_key, grouped.prefix24;
    DROP TABLE observations;
    ALTER TABLE observations_new RENAME TO observations;
    COMMIT;
  `);
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
  const excluded = excludedPrefixes(db);
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

  // Whether a host belongs to a network that has opted out of collection. All
  // three write paths check it, so an excluded address can never enter `nodes`
  // regardless of which command discovered it.
  function isExcluded(host) {
    return excluded.has(prefixOf(host));
  }

  return {
    // Prior state of a node before this run's sighting (undefined if brand new).
    priorSighting: ({ host, port }) => stmts.priorSighting.get(host, port),
    // Record the first time we've seen a node during the current run.
    recordFirstSightingThisRun: ({ host, port, id, at }) => {
      if (isExcluded(host)) {
        return;
      }
      stmts.firstSightingThisRun.run(host, port, id, at, at);
    },
    // Record a repeat sighting of a node already seen earlier this run.
    recordRepeatSighting: ({ host, port, id, at }) => {
      if (isExcluded(host)) {
        return;
      }
      stmts.repeatSighting.run(at, id, host, port);
    },
    // Record/refresh an app-seeder relay endpoint (seeders.mjs).
    recordSeederEndpoint: ({ host, port, app, at }) => {
      if (isExcluded(host)) {
        return;
      }
      stmts.seederEndpoint.run(host, port, at, at, app);
    },
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
      if (!rtts.length) {
        return null;
      }
      const mid = rtts.length >> 1;
      // true median: average the two middle values for an even-length set
      return rtts.length % 2 ? rtts[mid] : (rtts[mid - 1] + rtts[mid]) / 2;
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
  const excluded = excludedPrefixes(db);
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO observations
        (key_hash, prefix24, app, first_seen, last_seen, count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(key_hash, prefix24) DO UPDATE SET
        last_seen = excluded.last_seen, count = count + 1
    `),
    countParticipants: db.prepare(
      'SELECT COUNT(DISTINCT key_hash) AS n FROM observations'
    ),
    countParticipantsForApp: db.prepare(
      'SELECT COUNT(DISTINCT key_hash) AS n FROM observations WHERE app = ?'
    ),
    distinctKeysForApp: db.prepare(
      'SELECT DISTINCT key_hash FROM observations WHERE app = ?'
    ),
    distinctPrefixesForApp: db.prepare(
      'SELECT DISTINCT prefix24 FROM observations WHERE app = ?'
    ),
    distinctPrefixes: db.prepare('SELECT DISTINCT prefix24 FROM observations'),
    all: db.prepare('SELECT prefix24, app, key_hash FROM observations'),
    allDetailed: db.prepare(
      `SELECT key_hash, prefix24, app, first_seen, last_seen, count
       FROM observations`
    ),
    keyCounts: db.prepare('SELECT key_hash, count FROM observations'),
    pruneStale: db.prepare('DELETE FROM observations WHERE last_seen < ?')
  };
  return {
    // Record a connecting peer as aggregate health (observe.mjs). Takes the
    // host but stores only its /24 — the full address is never persisted — and
    // a pseudonym rather than the peer's public key. Silently does nothing for
    // an excluded network; the caller does not get to decide.
    record: ({ keyHash, host, app, at }) => {
      const prefix = prefixOf(host);
      if (excluded.has(prefix)) {
        return;
      }
      stmts.upsert.run(keyHash, prefix, app, at, at);
    },
    countDistinctParticipants: () => stmts.countParticipants.get().n,
    countDistinctForApp: (app) => stmts.countParticipantsForApp.get(app).n,
    distinctKeysForApp: (app) =>
      stmts.distinctKeysForApp.all(app).map((row) => row.key_hash),
    distinctPrefixesForApp: (app) =>
      stmts.distinctPrefixesForApp.all(app).map((row) => row.prefix24),
    distinctPrefixes: () =>
      stmts.distinctPrefixes.all().map((row) => row.prefix24),
    all: () => stmts.all.all(),
    // Full observation rows for the summary tables (per-app + app×country).
    allDetailed: () => stmts.allDetailed.all(),
    keyCounts: () => stmts.keyCounts.all(),
    // Retention: drop observations whose last sighting predates `cutoff`.
    pruneStaleBefore: (cutoff) => stmts.pruneStale.run(cutoff).changes
  };
}

// The rotating salts behind observations.key_hash.
export function pseudonymsRepo(db) {
  const stmts = {
    get: db.prepare('SELECT salt FROM pseudonym_salts WHERE period = ?'),
    insert: db.prepare(`
      INSERT INTO pseudonym_salts (period, salt, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `),
    purge: db.prepare('DELETE FROM pseudonym_salts WHERE expires_at < ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM pseudonym_salts')
  };
  return {
    // Get (or mint) the salt for a period. `retainMs` is the observation
    // retention window: the salt must outlive the last row that could have
    // used it, which is period end plus one retention window.
    saltFor: ({ period, periodEnd, retainMs, at }) => {
      const existing = stmts.get.get(period);
      if (existing) {
        return b4a.from(existing.salt, 'hex');
      }
      const salt = b4a.alloc(SALT_BYTES);
      sodium.randombytes_buf(salt);
      stmts.insert.run(
        period,
        b4a.toString(salt, 'hex'),
        at,
        periodEnd + retainMs
      );
      return salt;
    },
    // Destroy salts whose observations have all been pruned. Returns how many
    // went; after this the matching rows can no longer be traced to a peer.
    purgeExpired: (now) => stmts.purge.run(now).changes,
    count: () => stmts.count.get().n
  };
}

// Networks excluded from collection. Kept as a plain Set read at repo
// construction: writes happen thousands of times per run and the list is tiny
// and changes rarely. The trade-off is that a long-running `observe` will not
// notice an exclusion added mid-run — it takes effect on the next run, and
// `exclude add` purges anything already stored, so nothing lingers.
function excludedPrefixes(db) {
  const rows = db.prepare('SELECT prefix24 FROM exclusions').all();
  return new Set(rows.map((row) => row.prefix24));
}

export function exclusionsRepo(db) {
  const stmts = {
    add: db.prepare(`
      INSERT INTO exclusions (prefix24, reason, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(prefix24) DO UPDATE SET reason = excluded.reason
    `),
    remove: db.prepare('DELETE FROM exclusions WHERE prefix24 = ?'),
    list: db.prepare('SELECT * FROM exclusions ORDER BY created_at'),
    purgeNodes: db.prepare('DELETE FROM nodes WHERE host LIKE ?'),
    purgeObservations: db.prepare(
      'DELETE FROM observations WHERE prefix24 = ?'
    ),
    purgeGeo: db.prepare('DELETE FROM geo WHERE prefix = ?'),
    purgeRpki: db.prepare('DELETE FROM rpki WHERE prefix24 = ?')
  };
  return {
    add: ({ prefix24, reason, at }) => stmts.add.run(prefix24, reason, at),
    remove: (prefix24) => stmts.remove.run(prefix24).changes,
    list: () => stmts.list.all(),
    prefixes: () => excludedPrefixes(db),
    // Delete everything already stored about a /24. `nodes` is keyed by full
    // host so it needs a prefix match; the LIKE pattern is anchored with the
    // trailing dot so "1.2.3" can't also match "1.2.30".
    purge: (prefix24) => ({
      nodes: stmts.purgeNodes.run(`${prefix24}.%`).changes,
      observations: stmts.purgeObservations.run(prefix24).changes,
      geo: stmts.purgeGeo.run(prefix24).changes,
      rpki: stmts.purgeRpki.run(prefix24).changes
    })
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

// Below this many participants, a /24 is not named on a published page — see
// publishedPrefix. Three is the smallest threshold that still means "more than
// a pair", and the rows it hides are a tiny fraction of any real crawl.
export const MIN_PUBLISHED_GROUP = 3;

// Whether naming a network on a public page would effectively name a person.
// Only end-user networks qualify: a datacenter /24 with one node is a machine
// in a rack, but a residential or mobile /24 with one participant is close
// enough to one household that the operator's subscriber records would finish
// the job. Aggregate counts are unaffected — this governs display only.
export function isSmallEndUserNetwork({ kind, count }) {
  const endUser = kind === 'residential' || kind === 'mobile';
  return endUser && count < MIN_PUBLISHED_GROUP;
}

// The network label to publish for a /24: the /24 itself, or the covering /16
// when naming it would single someone out. Widening (rather than dropping the
// row) keeps the country/operator breakdowns honest — the participant is still
// counted, just not located to a subnet. Returns a complete CIDR string so no
// caller has to remember which suffix now applies.
export function publishedNetwork({ prefix, kind, count }) {
  const parts = String(prefix).split('.');
  if (parts.length < 3) {
    return String(prefix);
  }
  if (!isSmallEndUserNetwork({ kind, count })) {
    return `${prefix}.0/24`;
  }
  return `${parts[0]}.${parts[1]}.0.0/16`;
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
