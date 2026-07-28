#!/usr/bin/env bare
import os from 'bare-os';
import path from 'bare-path';
import process from 'bare-process';
import pkg from './package.json';
import { dataDir } from './paths.mjs';
import App from './app.cjs';

// hyperdht-explorer CLI entrypoint — a pear-runtime standalone Bare app.
//
//   bare bin.mjs <command> [options]
//
// Each subcommand lives in commands/<name>.mjs and exports `async run(ctx)`.
// We resolve the on-disk data dir ONCE here (so the DB, generated HTML, and the
// updater store all share one app-data root), then dispatch. The pear-runtime OTA
// self-updater is an optional background subsystem, off by default — enable with
// `--updates` once a real `upgrade` pear:// link is set in package.json.

const COMMANDS = {
  // collect: crawl / probe / fetch — active network I/O that writes to nodes.db
  scan: () => import('./commands/scan.mjs'),
  geo: () => import('./commands/geo.mjs'),
  probe: () => import('./commands/probe.mjs'),
  seeders: () => import('./commands/seeders.mjs'),
  observe: () => import('./commands/observe.mjs'),
  rpki: () => import('./commands/rpki.mjs'),
  storeprobe: () => import('./commands/storeprobe.mjs'),
  traffic: () => import('./commands/traffic.mjs'),
  // render: emit a self-contained .html report from already-collected data
  'render:index': () => import('./commands/index.mjs'),
  'render:map': () => import('./commands/map.mjs'),
  'render:ring': () => import('./commands/ring.mjs'),
  'render:timeline': () => import('./commands/timeline.mjs'),
  'render:summary': () => import('./commands/summary.mjs'),
  'render:topo': () => import('./commands/topo.mjs'),
  'render:privacy': () => import('./commands/privacy.mjs'),
  'render:stats': () => import('./commands/statspage.mjs'),
  // inspect: read-only local state, no network
  paths: () => import('./commands/paths.mjs'),
  stats: () => import('./commands/stats.mjs'),
  // govern: data-protection controls over what is collected and kept
  exclude: () => import('./commands/exclude.mjs')
};

const HELP = `hyperdht-explorer v${pkg.version} — hyperdht network-health explorer

usage: hyperdht-explorer <command> [options]

commands:

  collect — crawl / probe / fetch (active network I/O → nodes.db):
    scan             random-walk crawl the DHT        (--for N | --queries N | --prune-hours N | <topic-hex>)
    geo              ip-api geo-enrich discovered /24s (--refresh)
    probe            DHT ping nodes for liveness + RTT
    seeders          tag an app's relay endpoints     <pear://link | key | keet | pearpass> [app-name]
    observe          seed-and-listen for participants <pear://link | key | keet | pearpass> [app-name] [--minutes N]
    rpki             RIPEstat RPKI validity per /24    (--refresh)
    storeprobe       storage-reliability decay probe   (--canaries N --checkpoints …)
    traffic          count inbound RPC load as a node  (--minutes N --report-every N --force-persistent)

  render — emit a self-contained .html report from collected data:
    render:index     index.html (landing page linking the reports)
    render:map       map.html (Leaflet world map)
    render:ring      ring.html (keyspace projection)
    render:timeline  timeline.html (time series)
    render:summary   summary.html (network tables)
    render:topo      topology.html (BGP/AS graph)     (--refresh)
    render:privacy   privacy.html + scanner.html + .well-known/security.txt
    render:stats     stats.html (deployment + collector status)

  inspect — read-only local state (no network):
    paths            print the data/db/public storage paths
    stats            print nodes.db size, row counts, last scan/probe

  govern — data-protection controls:
    exclude          stop collecting a network + purge it  add|remove|list <ip | /24>

global flags:
  --storage <dir>   override the data directory (default: OS app-data dir)
  --updates         enable the pear-runtime OTA self-updater (default: off)
  --no-updates      explicitly disable the updater

data directory: ${dataDir()}`;

// Dev runs as `bare bin.mjs <cmd>` (argv = [bare, script, ...args]); a standalone
// build runs as `<binary> <cmd>` (argv = [binary, ...args]) with no script slot.
// Strip the runtime + (dev-only) script path so `raw` starts at the user's args.
const isDev = path.basename(Bare.argv[0]) === 'bare';

// --- parse: strip global flags from anywhere; first remaining token = command --
const raw = Bare.argv.slice(isDev ? 2 : 1);
let updates = false;
let storage = null;
const rest = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a === '--no-updates') {
    updates = false;
  } else if (a === '--updates') {
    updates = true;
  } else if (a === '--storage') {
    storage = raw[++i];
    // Reject a missing value or a following flag — otherwise `--storage` alone
    // silently falls back to the default dir, and `--storage --updates` would
    // resolve to a relative `./--updates/` in cwd (never write into the repo).
    if (!storage || storage.startsWith('--')) {
      console.error('--storage requires a directory path');
      Bare.exit(1);
    }
  } else {
    rest.push(a);
  }
}

const cmdName = rest[0];
if (
  !cmdName ||
  cmdName === 'help' ||
  cmdName === '--help' ||
  cmdName === '-h'
) {
  console.log(HELP);
  Bare.exit(cmdName ? 0 : 1);
}
if (!COMMANDS[cmdName]) {
  console.error(`unknown command: ${cmdName}\n`);
  console.log(HELP);
  Bare.exit(1);
}

// Resolve the data dir once and expose it to commands (paths.mjs reads this env).
const dir = storage || dataDir();
process.env.HYPERDHT_EXPLORER_HOME = dir;

console.log(
  `hyperdht-explorer v${pkg.version}  ·  data: ${dir}  ·  updates: ${updates ? 'on' : 'off'}\n`
);

// --- optional OTA updater (best-effort; never blocks the command) -------------
let app = null;
if (updates) {
  try {
    app = new App({
      dir,
      app: isDev ? null : os.execPath(),
      updates,
      version: pkg.version,
      upgrade: pkg.upgrade,
      name: 'hyperdht-explorer'
    });
    app.on('error', (err) => console.error('[updater]', err?.message || err));
    app.on('updating', () => console.log('[updater] downloading update…'));
    app.on('updated', () =>
      console.log('[updater] update ready; applies on next start')
    );
    await app.ready();
  } catch (err) {
    console.error('[updater] disabled (failed to start):', err?.message || err);
    app = null;
  }
}

// --- graceful shutdown on signals ---------------------------------------------
// Use bare-process `process.on(...)` (backed by bare-signals' uv_signal handles) —
// NOT `Bare.on('SIG…')`, which never fires because Bare core doesn't emit signal
// events (verified across platforms). `process.on` receives external SIGINT/SIGTERM
// on Linux, so cron / `timeout` / Ctrl-C all drive this path there. macOS currently
// drops EXTERNAL signals (a darwin-only bare bug: a started handle catches
// self-raised signals but not process-directed ones), so --for/--queries stay the
// cross-platform fallback. See the signal note in CLAUDE.md. On a signal: ask the
// running command to wind down (commands register a callback via ctx.onShutdown —
// e.g. scan prints its summary + writes a snapshot), tear down the updater, then
// exit with the conventional 128+signal code.
const shutdownHooks = [];
let signalled = 0;
async function onSignal(code) {
  if (signalled) {
    return;
  } // ignore repeats once we're already winding down
  signalled = code;
  try {
    for (const fn of shutdownHooks) {
      await fn();
    }
  } catch {}
  if (app) {
    try {
      await app.close();
    } catch {}
  }
  Bare.exit(code);
}
process.on('SIGHUP', () => onSignal(129));
process.on('SIGINT', () => onSignal(130));
process.on('SIGQUIT', () => onSignal(131));
process.on('SIGTERM', () => onSignal(143));

// --- dispatch -----------------------------------------------------------------
let code = 0;
try {
  const mod = await COMMANDS[cmdName]();
  // Synthetic argv preserves each command's existing argv[2..] parsing verbatim.
  // ctx.onShutdown lets a command register a graceful-stop callback for signals.
  const ctx = {
    argv: [Bare.argv[0], cmdName, ...rest.slice(1)],
    dir,
    onShutdown: (fn) => shutdownHooks.push(fn)
  };
  await mod.run(ctx);
} catch (err) {
  console.error('error:', err?.stack || err);
  code = 1;
} finally {
  if (app) {
    try {
      await app.close();
    } catch {}
  }
}

Bare.exit(signalled || code);
