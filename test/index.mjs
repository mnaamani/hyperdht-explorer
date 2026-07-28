import test from 'brittle';
import DHT from 'hyperdht';
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
  publishedNetwork,
  trafficRepo,
  fingerprintOf,
  newFingerprintSecret,
  TRAFFIC_COMMAND_COLUMNS,
  TRAFFIC_COMMAND_CLASS
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
    'traffic',
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

// --- traffic (inbound request load) ------------------------------------------

test('trafficRepo round-trips a run, defaulting uncounted commands to 0', (t) => {
  withTempDb('traffic', (db) => {
    const traffic = trafficRepo(db);
    t.absent(traffic.latest(), 'no runs to begin with');

    traffic.insert({
      ts: 1000,
      durationS: 600,
      persistent: true,
      firewalled: false,
      requests: 42,
      sources: 7,
      targets: 5,
      targetRequests: 31,
      unknown: 1,
      counts: { lookup: 30, find_node: 12 }
    });

    const row = traffic.latest();
    t.is(row.ts, 1000);
    t.is(row.persistent, 1, 'booleans are stored as 0/1');
    t.is(row.firewalled, 0);
    t.is(row.requests, 42);
    t.is(row.sources, 7, 'sources is a count, never a list of networks');
    t.is(row.targets, 5, 'targets is a count, never a list of targets');
    t.is(row.target_requests, 31);
    t.is(row.lookup, 30);
    t.is(row.find_node, 12);
    t.is(row.announce, 0, 'a command absent from counts reads 0, not NULL');

    // The row must carry counters and nothing else — no target, key or address
    // column can exist here. This is the promise the privacy notice makes about
    // this table, so guard it rather than trusting review.
    const columns = db
      .prepare('PRAGMA table_info(traffic)')
      .all()
      .map((col) => col.name);
    const allowed = new Set([
      'ts',
      'duration_s',
      'persistent',
      'firewalled',
      'requests',
      'sources',
      'targets',
      'target_requests',
      'unknown',
      ...TRAFFIC_COMMAND_COLUMNS
    ]);
    for (const name of columns) {
      t.ok(allowed.has(name), `traffic.${name} is a counter column`);
    }
  });
});

test('every traffic command column is classified', (t) => {
  for (const name of TRAFFIC_COMMAND_COLUMNS) {
    const kind = TRAFFIC_COMMAND_CLASS.get(name);
    t.ok(
      kind === 'internal' || kind === 'external',
      `${name} is internal or external`
    );
  }
});

// The counting hook, against two real nodes on loopback. This is the one thing
// in traffic.mjs that can silently stop working: dht.onrequest would miss
// dht-rpc's internal commands entirely, and io.onrequest holds an already-bound
// dht._onrequest, so the wrap has to happen on the property. If hyperdht or
// dht-rpc ever restructures that dispatch, this test fails instead of the
// production command quietly recording zeroes forever.
test('wrapping io.onrequest sees inbound requests and still serves them', async (t) => {
  const seen = [];
  // A standalone one-node network: no bootstrap, not firewalled, so it accepts
  // and answers requests immediately. Nothing leaves loopback.
  const server = new DHT({
    bootstrap: [],
    firewalled: false,
    ephemeral: false
  });
  await server.ready();

  const inner = server.io.onrequest;
  server.io.onrequest = (req, external) => {
    seen.push({ internal: req.internal, command: req.command });
    inner(req, external);
  };

  const port = server.address().port;
  const client = new DHT({ bootstrap: [`127.0.0.1:${port}`] });
  await client.ready();

  t.ok(seen.length > 0, 'the wrapper saw the client bootstrap');
  t.ok(
    seen.some((req) => req.internal),
    'internal routing commands reach io.onrequest (dht.onrequest would not see these)'
  );

  // A full round-trip through the wrapped dispatch: the reply only arrives if
  // the wrapper passed the request on to the original handler.
  const before = seen.length;
  const reply = await client.ping({ host: '127.0.0.1', port });
  t.ok(
    reply,
    'the request was still answered — wrapping did not break dispatch'
  );
  t.ok(seen.length > before, 'and the ping itself was counted');

  await client.destroy();
  await server.destroy();
});

test('fingerprintOf counts distinctness without retaining the value', (t) => {
  const target = b4a.alloc(32, 3);
  const other = b4a.alloc(32, 4);
  const secret = newFingerprintSecret();
  const otherSecret = newFingerprintSecret();

  t.is(
    fingerprintOf({ value: target, secret }),
    fingerprintOf({ value: target, secret }),
    'same value + secret -> same fingerprint (a Set can count distinctness)'
  );
  t.not(
    fingerprintOf({ value: target, secret }),
    fingerprintOf({ value: other, secret }),
    'different targets stay distinct'
  );
  t.not(
    fingerprintOf({ value: target, secret }),
    fingerprintOf({ value: target, secret: otherSecret }),
    'a fresh per-run secret makes counts incomparable across runs — by design'
  );
  t.not(
    fingerprintOf({ value: target, secret }),
    b4a.toString(target, 'hex'),
    'the fingerprint is not the target'
  );
  t.absent(
    b4a
      .toString(target, 'hex')
      .includes(fingerprintOf({ value: target, secret })),
    'and is not a prefix of it either'
  );
  // Secrets are random, so two of them must not collide.
  t.not(b4a.toString(secret, 'hex'), b4a.toString(otherSecret, 'hex'));
});

// Target counting against real application traffic. Two lookups of different
// topics are two distinct targets; looking one of them up again must not add a
// third. That is the whole claim the "distinct targets" number makes, so prove
// it against hyperdht rather than a hand-built request object.
//
// Lookups (not puts) because a put needs a commit quorum that a one-node test
// network cannot give — and LOOKUP is the command this measurement is really
// about anyway.
test('distinct application targets are counted, repeats are not', async (t) => {
  const targets = new Set();
  const secret = newFingerprintSecret();
  const server = new DHT({
    bootstrap: [],
    firewalled: false,
    ephemeral: false
  });
  await server.ready();

  const inner = server.io.onrequest;
  server.io.onrequest = (req, external) => {
    // Exactly what commands/traffic.mjs does: application targets only, and
    // fingerprinted rather than kept.
    if (!req.internal && req.target) {
      targets.add(fingerprintOf({ value: req.target, secret }));
    }
    inner(req, external);
  };

  const port = server.address().port;
  const client = new DHT({ bootstrap: [`127.0.0.1:${port}`] });
  await client.ready();

  const topicA = b4a.alloc(32, 1);
  const topicB = b4a.alloc(32, 2);
  await client.lookup(topicA).finished();
  t.is(targets.size, 1, 'one topic looked up -> one distinct target');
  await client.lookup(topicB).finished();
  t.is(targets.size, 2, 'a different topic -> a second');
  await client.lookup(topicA).finished();
  t.is(targets.size, 2, 'looking up a known topic again adds nothing');

  // The set holds fingerprints, not targets — the invariant the privacy notice
  // rests on.
  t.absent(
    targets.has(b4a.toString(topicA, 'hex')),
    'the real target is not in the set'
  );

  await client.destroy();
  await server.destroy();
});
