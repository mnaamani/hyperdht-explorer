import { DatabaseSync } from 'bare-sqlite'
import { dbPath, ensureDirs } from './paths.js'

// Shared database access for the hyperdht-explorer tools (crawler, geo, map).
//
// Two tables:
//   nodes - one row per discovered host:port (see index.js for tracking logic)
//   geo   - one row per /24 subnet (255.255.255.0). We assume any two IPs that
//           share the first three octets sit in the same network and therefore
//           the same geo-location, so we only ever hit the geoip API once per
//           /24. This caps API usage hard and respects ip-api.com rate limits.

export function openDb(path = dbPath()) {
  ensureDirs() // make sure the app-data dir exists before SQLite touches it
  const db = new DatabaseSync(path, { timeout: 5000 })
  db.exec('PRAGMA journal_mode = WAL;')
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

    -- Peers observed CONNECTING to us while seeding a public topic (observe.js).
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
      observed    INTEGER               -- distinct participants seen via observe.js
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
  `)

  // Migrate older databases that predate the ping-probe columns.
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(nodes)')
      .all()
      .map((c) => c.name)
  )
  if (!cols.has('alive')) db.exec('ALTER TABLE nodes ADD COLUMN alive INTEGER')
  if (!cols.has('rtt_ms')) db.exec('ALTER TABLE nodes ADD COLUMN rtt_ms INTEGER')
  if (!cols.has('last_ping')) db.exec('ALTER TABLE nodes ADD COLUMN last_ping INTEGER')
  if (!cols.has('app_seeder')) db.exec('ALTER TABLE nodes ADD COLUMN app_seeder TEXT')
  const spCols = new Set(
    db
      .prepare('PRAGMA table_info(store_probes)')
      .all()
      .map((c) => c.name)
  )
  if (spCols.size && !spCols.has('decay')) db.exec('ALTER TABLE store_probes ADD COLUMN decay TEXT')
  const geoCols = new Set(
    db
      .prepare('PRAGMA table_info(geo)')
      .all()
      .map((c) => c.name)
  )
  for (const col of ['mobile', 'proxy', 'hosting']) {
    if (geoCols.size && !geoCols.has(col)) db.exec(`ALTER TABLE geo ADD COLUMN ${col} INTEGER`)
  }
  if (
    !new Set(
      db
        .prepare('PRAGMA table_info(snapshots)')
        .all()
        .map((c) => c.name)
    ).has('observed')
  ) {
    db.exec('ALTER TABLE snapshots ADD COLUMN observed INTEGER')
  }

  return db
}

// True for private / reserved / non-routable IPv4 (RFC1918, loopback, link-local,
// CGNAT, multicast, reserved). Non-IPv4 strings are treated as not-private.
export function isPrivateIp(host) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(host))
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 0 || a === 10 || a === 127) return true // this-net, 10/8, loopback
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // link-local
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a >= 224) return true // multicast / reserved / broadcast
  return false
}

// Classify a network by ip-api flags: datacenter / mobile / proxy / residential.
// "residential" = located but flagged as none of the above (eyeball/business ISP),
// a useful proxy for "likely an end-user's machine rather than infrastructure".
export function hostKind(g) {
  if (!g) return 'unknown'
  if (g.hosting) return 'datacenter'
  if (g.mobile) return 'mobile'
  if (g.proxy) return 'proxy'
  if (g.country) return 'residential'
  return 'unknown'
}

// IPv4 /24 network key. Non-IPv4 hosts fall back to the host itself so they
// still get looked up individually rather than being silently merged.
export function prefixOf(host) {
  const parts = String(host).split('.')
  if (parts.length === 4 && parts.every((p) => p !== '' && Number.isInteger(+p))) {
    return parts.slice(0, 3).join('.')
  }
  return host
}

// Registry holder/AS names sometimes carry stray double quotes (e.g.
// `JSC "ER-Telecom Holding"`) which are just noise — strip them and tidy spacing
// so display names render cleanly everywhere.
export function cleanName(s) {
  return s ? s.replace(/"/g, '').replace(/\s+/g, ' ').trim() : s
}

// ip-api's `as` field looks like "AS24940 Hetzner Online GmbH" — split the AS
// number from the operator name. Falls back to org/isp when there's no AS string.
export function parseAs(asInfo, org, isp) {
  if (asInfo) {
    const m = /^AS(\d+)\s*(.*)$/i.exec(asInfo.trim())
    if (m) {
      return {
        asn: 'AS' + m[1],
        asnNum: Number(m[1]),
        name: cleanName(m[2] || org || isp || '') || 'AS' + m[1]
      }
    }
    return { asn: null, asnNum: null, name: cleanName(asInfo) }
  }
  return { asn: null, asnNum: null, name: cleanName(org || isp || null) }
}
