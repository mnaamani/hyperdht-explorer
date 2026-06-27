#!/usr/bin/env bare
import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
import pkg from './package.json'
import { dataDir } from './paths.js'
import App from './app.cjs'

// hyperdht-explorer CLI entrypoint — a pear-runtime standalone Bare app.
//
//   bare bin.mjs <command> [options]
//
// Each subcommand lives in commands/<name>.js and exports `async run(ctx)`.
// We resolve the on-disk data dir ONCE here (so the DB, generated HTML, and the
// updater store all share one app-data root), then dispatch. The pear-runtime OTA
// self-updater is an optional background subsystem, off by default — enable with
// `--updates` once a real `upgrade` pear:// link is set in package.json.

const COMMANDS = {
  scan: () => import('./commands/scan.js'),
  geo: () => import('./commands/geo.js'),
  probe: () => import('./commands/probe.js'),
  seeders: () => import('./commands/seeders.js'),
  observe: () => import('./commands/observe.js'),
  map: () => import('./commands/map.js'),
  ring: () => import('./commands/ring.js'),
  timeline: () => import('./commands/timeline.js'),
  summary: () => import('./commands/summary.js'),
  topo: () => import('./commands/topo.js'),
  rpki: () => import('./commands/rpki.js'),
  storeprobe: () => import('./commands/storeprobe.js')
}

const HELP = `hyperdht-explorer v${pkg.version} — hyperdht network-health explorer

usage: hyperdht-explorer <command> [options]

commands:
  scan         random-walk crawl the DHT        (--for N | --queries N | --prune-hours N | <topic-hex>)
  geo          ip-api geo-enrich discovered /24s (--refresh)
  probe        DHT ping nodes for liveness + RTT
  seeders      tag an app's relay endpoints     <pear://link | key> [app-name]
  observe      seed-and-listen for participants  <pear://link | key> [app-name] [--minutes N]
  map          render map.html (Leaflet world map)
  ring         render ring.html (keyspace projection)
  timeline     render timeline.html (time series)
  summary      render summary.html (network tables)
  topo         render topology.html (BGP/AS graph) (--refresh)
  rpki         RIPEstat RPKI validity per /24     (--refresh)
  storeprobe   storage-reliability decay probe    (--canaries N --checkpoints …)

global flags:
  --storage <dir>   override the data directory (default: OS app-data dir)
  --updates         enable the pear-runtime OTA self-updater (default: off)
  --no-updates      explicitly disable the updater

data directory: ${dataDir()}`

// --- parse: strip global flags from anywhere; first remaining token = command --
const raw = Bare.argv.slice(2)
let updates = false
let storage = null
const rest = []
for (let i = 0; i < raw.length; i++) {
  const a = raw[i]
  if (a === '--no-updates') updates = false
  else if (a === '--updates') updates = true
  else if (a === '--storage') storage = raw[++i]
  else rest.push(a)
}

const cmdName = rest[0]
if (!cmdName || cmdName === 'help' || cmdName === '--help' || cmdName === '-h') {
  console.log(HELP)
  Bare.exit(cmdName ? 0 : 1)
}
if (!COMMANDS[cmdName]) {
  console.error(`unknown command: ${cmdName}\n`)
  console.log(HELP)
  Bare.exit(1)
}

// Resolve the data dir once and expose it to commands (paths.js reads this env).
const dir = storage || dataDir()
process.env.HYPERDHT_EXPLORER_HOME = dir

console.log(
  `hyperdht-explorer v${pkg.version}  ·  data: ${dir}  ·  updates: ${updates ? 'on' : 'off'}\n`
)

// --- optional OTA updater (best-effort; never blocks the command) -------------
const isDev = path.basename(Bare.argv[0]) === 'bare'
let app = null
if (updates) {
  try {
    app = new App({
      dir,
      app: isDev ? null : os.execPath(),
      updates,
      version: pkg.version,
      upgrade: pkg.upgrade,
      name: 'hyperdht-explorer'
    })
    app.on('error', (err) => console.error('[updater]', err?.message || err))
    app.on('updating', () => console.log('[updater] downloading update…'))
    app.on('updated', () => console.log('[updater] update ready; applies on next start'))
    await app.ready()
  } catch (err) {
    console.error('[updater] disabled (failed to start):', err?.message || err)
    app = null
  }
}

// --- dispatch -----------------------------------------------------------------
let code = 0
try {
  const mod = await COMMANDS[cmdName]()
  // Synthetic argv preserves each command's existing argv[2..] parsing verbatim.
  const ctx = { argv: [Bare.argv[0], cmdName, ...rest.slice(1)], dir }
  await mod.run(ctx)
} catch (err) {
  console.error('error:', err?.stack || err)
  code = 1
} finally {
  if (app) {
    try {
      await app.close()
    } catch {}
  }
}

Bare.exit(code)
