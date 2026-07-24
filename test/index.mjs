import test from 'brittle';
import fs from 'bare-fs';
import path from 'bare-path';
import os from 'bare-os';
import process from 'bare-process';
import {
  prefixOf,
  isPrivateIp,
  parseAs,
  cleanName,
  hostKind,
  openDb
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
    'as_names'
  ]) {
    t.ok(tables.includes(tbl), `has table ${tbl}`);
  }

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env.HYPERDHT_EXPLORER_HOME = ''; // bare-process env Proxy has no delete trap
});
