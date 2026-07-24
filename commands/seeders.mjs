import DHT from 'hyperdht';
import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import idEnc from 'hypercore-id-encoding';
import process from 'bare-process';
import { openDb, nodesRepo, APP_PRESETS, resolvePreset } from '../db.mjs';

// Find peers seeding a specific Pear application (or any Hypercore), given its
// pear:// link or public key. This works because app distribution is public by
// design: every install replicates the app's update feed, announcing under its
// discovery key. We derive that discovery key and look up its announcers.
//
//   bare bin.mjs seeders pear://<keet-app-key> [app-name]
//   bare bin.mjs seeders <64-hex-or-z32-hypercore-key> [app-name]
//
// Each seeder's relay endpoints (host:port) are recorded into nodes.db and
// tagged in the `app_seeder` column with [app-name] (default 'app'), so they
// flow into the geo/probe/map pipeline and can be filtered as stable seeders.
//
// NOTE: this finds seeders of the APPLICATION feed (a census of online installs)
// — NOT private chat rooms, which are keyed by per-room invite keys and are not
// enumerable from the DHT.
//
// Well-known public Pear apps can be referenced by name instead of a key, e.g.
//   bare bin.mjs seeders keet
// The name also becomes the default app_seeder tag. Presets live in db.mjs
// (APP_PRESETS) so `observe` shares them; only add one with a verified link.

export async function run(ctx) {
  const argv = ctx.argv;
  // A bare preset name (e.g. `seeders keet`) expands to its link and supplies the
  // default tag; a pear:// link or raw key passes through unchanged.
  const { link: arg, name: presetName } = resolvePreset(argv[2]);
  const appName = argv[3] || presetName || 'app';
  if (!arg) {
    console.error(
      'usage: bare bin.mjs seeders <pear://link | hypercore-key | preset> [app-name]'
    );
    console.error(`presets: ${Object.keys(APP_PRESETS).join(', ')}`);
    process.exit(1);
  }

  let publicKey;
  try {
    publicKey = idEnc.decode(arg); // handles pear://, z-base-32 (52), and hex (64)
  } catch (err) {
    console.error('could not decode key:', err.message);
    process.exit(1);
  }

  const discoveryKey = crypto.discoveryKey(publicKey);

  console.log('app public key :', b4a.toString(publicKey, 'hex'));
  console.log('discovery key  :', b4a.toString(discoveryKey, 'hex'));
  console.log('\nlooking up seeders...\n');

  const db = openDb();
  const nodes = nodesRepo(db);

  const dht = new DHT();
  await dht.ready();

  const seeders = new Map(); // announcer publicKey hex -> { relays:Set }
  const relayAddrs = new Set(); // unique host:port across all seeders
  let respondingNodes = 0;

  for await (const data of dht.lookup(discoveryKey)) {
    respondingNodes++;
    for (const peer of data.peers || []) {
      const pk = b4a.toString(peer.publicKey, 'hex');
      let entry = seeders.get(pk);
      if (!entry) {
        entry = { relays: new Set() };
        seeders.set(pk, entry);
        console.log(`+ seeder ${pk}`);
      }
      for (const relay of peer.relayAddresses || []) {
        entry.relays.add(`${relay.host}:${relay.port}`);
        relayAddrs.add(`${relay.host}:${relay.port}`);
      }
    }
  }

  // Persist the relay endpoints, tagged with the app name.
  const now = Date.now();
  for (const addr of relayAddrs) {
    const idx = addr.lastIndexOf(':');
    nodes.recordSeederEndpoint({
      host: addr.slice(0, idx),
      port: Number(addr.slice(idx + 1)),
      app: appName,
      at: now
    });
  }

  console.log(
    `\n=== ${seeders.size} seeder(s) found across ${respondingNodes} responding node(s) ===`
  );
  for (const [pk, { relays }] of seeders) {
    console.log(
      `  ${pk}${relays.size ? '  relays: ' + [...relays].join(', ') : ''}`
    );
  }
  console.log(
    `\nrecorded ${relayAddrs.size} relay endpoint(s) into nodes.db tagged app_seeder='${appName}'`
  );

  db.close();
  await dht.destroy();
}
