import test from 'brittle';
import fs from 'bare-fs';
import path from 'bare-path';
import os from 'bare-os';
import process from 'bare-process';
import b4a from 'b4a';
import {
  prefixOf,
  isPrivateIp,
  parseAs,
  cleanName,
  hostKind,
  openDb,
  nodesRepo,
  observationsRepo,
  exclusionsRepo,
  pseudonymsRepo,
  pseudonymOf,
  saltPeriodOf,
  publishedNetwork
} from '../db.mjs';
import { dataDir, dbPath, htmlPath } from '../paths.mjs';

// Pure, network-free smoke tests for the shared helpers, path resolution, and the
// SQLite schema. We point HYPERDHT_EXPLORER_HOME at a temp dir so openDb()/ensureDirs()
// never touch the real app-data directory.

test('prefixOf computes the /24 key', (t) => {
  t.is(prefixOf('143.198.58.21'), '143.198.58');
  t.is(prefixOf('not-an-ip'), 'not-an-ip');
});

test('isPrivateIp flags reserved ranges, passes public', (t) => {
  for (const ip of [
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1'
  ]) {
    t.ok(isPrivateIp(ip), `${ip} is private`);
  }
  for (const ip of ['8.8.8.8', '143.198.58.21']) {
    t.absent(isPrivateIp(ip), `${ip} is public`);
  }
});

test('parseAs splits AS number from operator name', (t) => {
  const parsed = parseAs('AS24940 Hetzner Online GmbH');
  t.is(parsed.asn, 'AS24940');
  t.is(parsed.asnNum, 24940);
  t.is(parsed.name, 'Hetzner Online GmbH');
});

test('cleanName strips registry quote noise', (t) => {
  t.is(cleanName('JSC "ER-Telecom Holding"'), 'JSC ER-Telecom Holding');
});

test('hostKind classifies by ip-api flags', (t) => {
  t.is(hostKind({ hosting: 1 }), 'datacenter');
  t.is(hostKind({ mobile: 1 }), 'mobile');
  t.is(hostKind({ proxy: 1 }), 'proxy');
  t.is(hostKind({ country: 'Canada' }), 'residential');
  t.is(hostKind(null), 'unknown');
});

test('paths honour HYPERDHT_EXPLORER_HOME override', (t) => {
  const tmp = path.join(os.tmpdir(), 'hyperdht-explorer-test-paths');
  process.env.HYPERDHT_EXPLORER_HOME = tmp;
  t.is(dataDir(), tmp);
  t.is(dbPath(), path.join(tmp, 'nodes.db'));
  t.is(htmlPath('map.html'), path.join(tmp, 'public', 'map.html'));
  process.env.HYPERDHT_EXPLORER_HOME = ''; // bare-process env Proxy has no delete trap
});

test('openDb creates the schema and ensures dirs', (t) => {
  const tmp = path.join(os.tmpdir(), 'hyperdht-explorer-test-db');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env.HYPERDHT_EXPLORER_HOME = tmp;

  const db = openDb();
  t.ok(fs.existsSync(path.join(tmp, 'public')), 'public/ dir created');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const tbl of [
    'nodes',
    'geo',
    'snapshots',
    'store_probes',
    'observations',
    'rpki',
    'as_neighbours',
    'as_names',
    'pseudonym_salts',
    'exclusions'
  ]) {
    t.ok(tables.includes(tbl), `has table ${tbl}`);
  }

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env.HYPERDHT_EXPLORER_HOME = ''; // bare-process env Proxy has no delete trap
});

// --- data-protection invariants ----------------------------------------------
// These guard promises made in the published privacy notice, so a regression
// here is a compliance problem and not only a bug. See PRIVACY.md.

// Open a throwaway database, run `body(db)`, then delete it.
function withTempDb(name, body) {
  const tmp = path.join(os.tmpdir(), `hyperdht-explorer-test-${name}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env.HYPERDHT_EXPLORER_HOME = tmp;
  const db = openDb();
  try {
    body(db);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.HYPERDHT_EXPLORER_HOME = '';
  }
}

test('pseudonymOf is deterministic per salt and unlinkable across salts', (t) => {
  const key = b4a.alloc(32, 7);
  const saltA = b4a.alloc(32, 1);
  const saltB = b4a.alloc(32, 2);

  t.is(
    pseudonymOf({ publicKey: key, salt: saltA }),
    pseudonymOf({ publicKey: key, salt: saltA }),
    'same key + salt -> same pseudonym (distinct counts work)'
  );
  t.not(
    pseudonymOf({ publicKey: key, salt: saltA }),
    pseudonymOf({ publicKey: key, salt: saltB }),
    'rotating the salt breaks the link across periods'
  );
  t.not(
    pseudonymOf({ publicKey: key, salt: saltA }),
    b4a.toString(key, 'hex'),
    'the pseudonym is not the key'
  );
  // Hex accepted as well as a buffer — observe passes a buffer, the migration
  // passes the stored hex string.
  t.is(
    pseudonymOf({ publicKey: b4a.toString(key, 'hex'), salt: saltA }),
    pseudonymOf({ publicKey: key, salt: saltA })
  );
});

test('saltPeriodOf buckets by UTC month', (t) => {
  const jan = saltPeriodOf(Date.UTC(2026, 0, 15));
  t.is(jan.period, '2026-01');
  t.is(jan.periodEnd, Date.UTC(2026, 1, 1));
  t.is(saltPeriodOf(Date.UTC(2026, 0, 31)).period, jan.period, 'same month');
  t.not(saltPeriodOf(Date.UTC(2026, 1, 1)).period, jan.period, 'next month');
  t.is(saltPeriodOf(Date.UTC(2026, 11, 5)).periodEnd, Date.UTC(2027, 0, 1));
});

test('salts are reused within a period and purged once expired', (t) => {
  withTempDb('salts', (db) => {
    const salts = pseudonymsRepo(db);
    const now = Date.UTC(2026, 5, 10);
    const { period, periodEnd } = saltPeriodOf(now);
    const args = { period, periodEnd, retainMs: 86400000, at: now };

    const first = salts.saltFor(args);
    t.alike(salts.saltFor(args), first, 'same period reuses the salt');
    t.is(salts.count(), 1);

    t.is(salts.purgeExpired(periodEnd), 0, 'not yet expired');
    t.is(salts.purgeExpired(periodEnd + 86400000 + 1), 1, 'destroyed after');
    t.is(salts.count(), 0);
  });
});

test('excluded networks cannot be written by any repo', (t) => {
  withTempDb('exclusions', (db) => {
    const at = Date.now();
    exclusionsRepo(db).add({ prefix24: '203.0.113', reason: 'test', at });
    // Repos read the exclusion set at construction, so build them after.
    const nodes = nodesRepo(db);
    const observations = observationsRepo(db);

    nodes.recordFirstSightingThisRun({
      host: '203.0.113.9',
      port: 49737,
      id: null,
      at
    });
    nodes.recordSeederEndpoint({
      host: '203.0.113.9',
      port: 49737,
      app: 'keet',
      at
    });
    observations.record({ keyHash: 'ab'.repeat(16), host: '203.0.113.9', at });
    t.is(nodes.count(), 0, 'excluded node not recorded');
    t.is(observations.countDistinctParticipants(), 0, 'no observation');

    // Control: an ordinary network is still recorded.
    nodes.recordFirstSightingThisRun({
      host: '198.51.100.9',
      port: 49737,
      id: null,
      at
    });
    observations.record({ keyHash: 'cd'.repeat(16), host: '198.51.100.9', at });
    t.is(nodes.count(), 1);
    t.is(observations.countDistinctParticipants(), 1);
  });
});

test('exclude purges every table that holds the network', (t) => {
  withTempDb('purge', (db) => {
    const at = Date.now();
    const nodes = nodesRepo(db);
    const observations = observationsRepo(db);
    nodes.recordFirstSightingThisRun({
      host: '203.0.113.9',
      port: 49737,
      id: null,
      at
    });
    // A second host in the same /24, and one in a neighbour that must survive
    // (the LIKE pattern must not treat "203.0.11" as a prefix of "203.0.113").
    nodes.recordFirstSightingThisRun({
      host: '203.0.113.10',
      port: 1,
      id: null,
      at
    });
    nodes.recordFirstSightingThisRun({
      host: '203.0.1130.1',
      port: 1,
      id: null,
      at
    });
    observations.record({ keyHash: 'ab'.repeat(16), host: '203.0.113.9', at });

    const purged = exclusionsRepo(db).purge('203.0.113');
    t.is(purged.nodes, 2, 'both hosts in the /24 removed');
    t.is(purged.observations, 1);
    t.is(nodes.count(), 1, 'the look-alike network is untouched');
  });
});

test('publishedNetwork widens only small end-user networks', (t) => {
  const small = { prefix: '203.0.113', count: 1 };
  t.is(
    publishedNetwork({ ...small, kind: 'residential' }),
    '203.0.0.0/16',
    'a lone residential /24 is not named'
  );
  t.is(publishedNetwork({ ...small, kind: 'mobile' }), '203.0.0.0/16');
  t.is(
    publishedNetwork({ ...small, kind: 'datacenter' }),
    '203.0.113.0/24',
    'a datacenter is a rack, not a household'
  );
  t.is(
    publishedNetwork({ prefix: '203.0.113', count: 3, kind: 'residential' }),
    '203.0.113.0/24',
    'at the threshold the /24 is named'
  );
});
