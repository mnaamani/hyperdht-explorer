import DHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';
import Corestore from 'corestore';
import Hyperdrive from 'hyperdrive';
import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import idEnc from 'hypercore-id-encoding';
import process from 'bare-process';
import fs from 'bare-fs';
import path from 'bare-path';
import {
  openDb,
  observationsRepo,
  geoRepo,
  prefixOf,
  hostKind,
  isPrivateIp,
  APP_PRESETS,
  resolvePreset
} from '../db.mjs';
import { dataDir, ensureDirs } from '../paths.mjs';

// Seed-and-listen: announce ourselves under a PUBLIC topic (e.g. a Pear app's
// update feed) and record the peers that connect to us. This surfaces real,
// often NAT'd/ephemeral participants that a findNode crawl can never see —
// because we observe who *connects*, not who is merely in the routing table.
//
//   bare bin.mjs observe <pear://link | hypercore-key | preset> [app-name] [--minutes N] [--seed]
//
// A bare preset name (e.g. `observe keet`, see APP_PRESETS in db.mjs) expands to
// its link and supplies the default app tag.
//
// Two modes:
//   * default (lurker) — announce, record connecting peers, then close politely.
//     Ephemeral identity, serves nothing. Mildly extractive but zero footprint.
//   * --seed — actually REPLICATE AND SERVE the app's public update drive: join its
//     discovery key as server+client over a Corestore, serve blocks to peers, and
//     best-effort prefetch the latest version so we serve current content. Uses a
//     STABLE, persisted identity (a real seeder has a steady footprint). Observation
//     recording is unchanged — it just becomes a byproduct of genuinely participating.
//
// THE BRIGHT LINE (--seed): seed ONLY public app-update feeds — the `pear://` link's
// drive, which is designed to be reseeded by every install. Hypercore is signed by
// the app key, so we only ever store/serve authentic data. NEVER private/room data
// (Keet chat rooms etc.); those aren't discoverable and are out of scope.
//
// HEALTH MONITORING ONLY. We record aggregate participation (addresses, counts,
// residential-vs-datacenter mix) to gauge network health — never to track or
// deanonymize individuals.

export async function run(ctx) {
  // Parse flags and positionals together so a flag's VALUE (e.g. the number after
  // --minutes) is consumed, not mistaken for a positional like the app-name.
  const positional = [];
  let MINUTES = 10;
  let SEED = false;
  const rest = ctx.argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--seed') {
      SEED = true;
    } else if (a === '--minutes') {
      MINUTES = Number(rest[++i]);
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  const { link: arg, name: presetName } = resolvePreset(positional[0]);
  const appName = positional[1] || presetName || 'observed';

  if (!arg) {
    console.error(
      'usage: bare bin.mjs observe <pear://link | hypercore-key | preset> [app-name] [--minutes N] [--seed]'
    );
    console.error(`presets: ${Object.keys(APP_PRESETS).join(', ')}`);
    process.exit(1);
  }

  let publicKey;
  try {
    publicKey = idEnc.decode(arg);
  } catch (err) {
    console.error('bad key:', err.message);
    process.exit(1);
  }
  const topic = crypto.discoveryKey(publicKey);

  const db = openDb();
  const observations = observationsRepo(db);
  const geo = geoRepo(db);

  const seen = new Set(); // host:port connections seen this session

  // participants (public keys) observed in PRIOR sessions for this app — lets us
  // tell "returning" peers from brand-new ones. Re-observation is the meaningful
  // liveness signal for NAT'd peers (pinging their transient address would not be).
  const priorKeys = new Set(observations.distinctKeysForApp(appName));
  const sessionKeys = new Set();
  let returning = 0;
  let fresh = 0;

  // Record a connecting peer as aggregate health. Shared by both modes: a peer is a
  // peer whether it reached us as a passive lurker or as a real seeding swarm member.
  function recordConn(conn) {
    const read = () => {
      const host = conn.rawStream && conn.rawStream.remoteHost;
      const port = conn.rawStream && conn.rawStream.remotePort;
      if (!host || !port) {
        return;
      }
      if (isPrivateIp(host)) {
        return;
      } // skip LAN/loopback/reserved addresses
      const pk = b4a.toString(conn.remotePublicKey, 'hex');
      observations.record({
        publicKey: pk,
        host,
        port,
        app: appName,
        at: Date.now()
      });
      const key = host + ':' + port;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      let tag = '';
      if (!sessionKeys.has(pk)) {
        sessionKeys.add(pk);
        if (priorKeys.has(pk)) {
          returning++;
          tag = 'returning';
        } else {
          fresh++;
          tag = 'new';
        }
      }
      console.log(
        `+ peer ${(host + ':' + port).padEnd(21)} ${pk.slice(0, 12)}… ${tag}`
      );
    };
    // address is ready once the encrypted stream opens
    if (conn.rawStream && conn.rawStream.remoteHost) {
      read();
    } else {
      conn.once('open', read);
    }
  }

  function report() {
    const allTimeKeys = observations.countDistinctForApp(appName);
    const hosts = observations.distinctHostsForApp(appName);
    const prefixes = new Set(hosts.map(prefixOf));
    // classify the /24s we already have geo for
    const networks = geo.locatedNetworks();
    const kinds = {};
    let classified = 0;
    for (const prefix of prefixes) {
      const geoRow = networks.get(prefix);
      if (!geoRow) {
        continue;
      }
      classified++;
      const k = hostKind(geoRow);
      kinds[k] = (kinds[k] || 0) + 1;
    }
    console.log(
      `\n=== this session: ${sessionKeys.size} distinct participant(s) — ${returning} returning, ${fresh} new (${seen.size} connection(s)) ===`
    );
    console.log(
      `all-time distinct participants for '${appName}': ${allTimeKeys}`
    );
    console.log(
      `${prefixes.size} distinct /24(s); ${classified} already geo-classified:`
    );
    for (const [k, count] of Object.entries(kinds).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${k.padEnd(12)} ${count}`);
    }
    if (classified < prefixes.size) {
      console.log(
        `run 'bare bin.mjs geo' then 'bare bin.mjs summary' to classify the rest (residential vs datacenter).`
      );
    }
  }

  let resolveRun;
  const done = new Promise((resolve) => {
    resolveRun = resolve;
  });

  const shutdown = SEED ? await runSeed() : await runLurk();
  globalThis.setTimeout(shutdown, MINUTES * 60 * 1000);
  await done;

  // --- lurker mode: announce + record + close, ephemeral identity --------------
  async function runLurk() {
    const dht = new DHT();
    const keyPair = crypto.keyPair(); // ephemeral identity for this observer session
    const server = dht.createServer((conn) => {
      conn.on('error', () => {});
      recordConn(conn);
      conn.end(); // we don't serve the feed — just observe, then close politely
    });

    await dht.ready();
    await server.listen(keyPair);
    console.log('=== observe (lurker) ===');
    console.log('app          :', appName);
    console.log('topic key    :', b4a.toString(publicKey, 'hex'));
    console.log('discovery key:', b4a.toString(topic, 'hex'));
    console.log(`announcing as a peer and listening for ~${MINUTES} min…\n`);

    async function announce() {
      try {
        await dht.announce(topic, keyPair).finished();
      } catch {}
    }
    await announce();
    const reAnnounce = globalThis.setInterval(announce, 9 * 60 * 1000); // refresh before the ~20-min TTL

    return async () => {
      globalThis.clearInterval(reAnnounce);
      report();
      try {
        await dht.unannounce(topic, keyPair);
      } catch {}
      try {
        await server.close();
      } catch {}
      try {
        await dht.destroy();
      } catch {}
      try {
        db.close();
      } catch {}
      resolveRun();
    };
  }

  // --- seed mode: replicate + serve the public drive, stable identity ----------
  async function runSeed() {
    ensureDirs();
    const keyPair = loadSeederKeyPair(); // stable, persisted — a real seeder's identity
    const store = new Corestore(path.join(dataDir(), 'seed-store'));
    await store.ready();

    const swarm = new Hyperswarm({ keyPair });
    swarm.on('connection', (conn) => {
      conn.on('error', () => {});
      store.replicate(conn); // serve whatever blocks we hold; fetch what we want
      recordConn(conn);
    });

    const drive = new Hyperdrive(store, publicKey);
    await drive.ready();

    // join as BOTH server (announce: peers find us to replicate from) and client
    // (lookup: we connect out to other seeders to fetch the latest content).
    const discovery = swarm.join(drive.discoveryKey, {
      server: true,
      client: true
    });
    await discovery.flushed();

    console.log('=== observe (seeding) ===');
    console.log('app          :', appName);
    console.log('drive key    :', b4a.toString(publicKey, 'hex'));
    console.log('discovery key:', b4a.toString(topic, 'hex'));
    console.log('seeder pubkey:', b4a.toString(keyPair.publicKey, 'hex'));
    console.log('corestore    :', path.join(dataDir(), 'seed-store'));
    console.log(`serving + recording for ~${MINUTES} min…\n`);

    // Replication accounting: blocks + bytes we SERVE (upload) and FETCH (download),
    // plus how many distinct peers on each side. Hypercore emits upload/download
    // `(index, byteLength, from)` per block; tally across both of the drive's cores
    // (metadata + content blobs). Downloads come from the prefetch and ongoing sync.
    const up = { blocks: 0, bytes: 0, peers: new Set() };
    const down = { blocks: 0, bytes: 0, peers: new Set() };
    const tally = (acc) => (index, byteLength, from) => {
      acc.blocks++;
      acc.bytes += byteLength;
      if (from && from.remotePublicKey) {
        acc.peers.add(b4a.toString(from.remotePublicKey, 'hex'));
      }
    };
    const attach = (core) => {
      core.on('upload', tally(up));
      core.on('download', tally(down));
    };
    attach(drive.core);
    let blobsCore = null;
    try {
      const blobs = await drive.getBlobs();
      if (blobs) {
        blobsCore = blobs.core;
        attach(blobsCore);
      }
    } catch {}

    let lastUp = 0;
    let lastDown = 0;
    function logServed(tick) {
      const dUp = up.blocks - lastUp;
      const dDown = down.blocks - lastDown;
      lastUp = up.blocks;
      lastDown = down.blocks;
      // replicating = connections actually exchanging our drive's cores, vs total
      // swarm connections. 0 replicating while >0 connected => the peers reaching us
      // aren't interested in this drive (they joined the topic for something else).
      const repl = Math.max(
        drive.core.peers.length,
        blobsCore ? blobsCore.peers.length : 0
      );
      console.log(
        `seed: ↑ ${up.blocks} blk / ${fmtBytes(up.bytes)} to ${up.peers.size} peer(s) · ` +
          `↓ ${down.blocks} blk / ${fmtBytes(down.bytes)} from ${down.peers.size} peer(s) · ` +
          `${repl}/${swarm.connections.size} replicating` +
          (tick ? ` · +${dUp}↑/+${dDown}↓ blk this min` : '')
      );
    }
    const servedTimer = globalThis.setInterval(
      () => logServed(true),
      60 * 1000
    );

    // Sparse by default; best-effort prefetch of the LATEST version so we hold and
    // serve current content (not the full history). Background, non-blocking — a
    // time-bounded session may not finish it, which is fine.
    (async () => {
      try {
        await drive.update();
        const dl = drive.download('/');
        await dl.done();
        console.log(
          `seed: prefetched latest version (v${drive.version}) · fetched ` +
            `${down.blocks} blk / ${fmtBytes(down.bytes)} so far`
        );
      } catch {}
    })();

    return async () => {
      globalThis.clearInterval(servedTimer);
      logServed(false); // final served tally
      report();
      try {
        await swarm.destroy();
      } catch {}
      try {
        await drive.close();
      } catch {}
      try {
        await store.close();
      } catch {}
      try {
        db.close();
      } catch {}
      resolveRun();
    };
  }

  // One stable ed25519 identity for the seeder, persisted as a 32-byte seed under
  // the data dir so reconnecting peers recognize us across runs.
  function loadSeederKeyPair() {
    const file = path.join(dataDir(), 'seeder.seed');
    let seed;
    try {
      const buf = fs.readFileSync(file);
      if (buf.length === 32) {
        seed = buf;
      }
    } catch {}
    if (!seed) {
      seed = crypto.randomBytes(32);
      fs.writeFileSync(file, seed);
    }
    return crypto.keyPair(seed);
  }

  function fmtBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return `${i ? bytes.toFixed(1) : bytes} ${units[i]}`;
  }
}
