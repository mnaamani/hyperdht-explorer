import path from 'bare-path'
import fs from 'bare-fs'
import process from 'bare-process'
import { persistent } from 'bare-storage'

// Resolve where hyperdht-explorer keeps its runtime state — OUTSIDE the repo. The DB
// and the generated HTML pages all live here, alongside the pear-runtime updater
// store, under one per-user app-data directory.
//
// Resolution order:
//   1. HYPERDHT_EXPLORER_HOME            explicit override (used by tests / CI / cron)
//   2. bare-storage `persistent()` (the OS-conventional app-data root — macOS
//      ~/Library/Application Support, Linux $XDG_DATA_HOME|~/.local/share, win32
//      %APPDATA%) + an app subdir. The subdir DIFFERS by runtime so a standalone
//      production build and local `bare bin.mjs` dev runs never share state:
//        production binary   ->  <persistent>/hyperdht-explorer
//        dev (`bare bin.mjs`) ->  <persistent>/hyperdht-explorer-dev
//      Both are durable (NOT temp/ephemeral) — dev is just a distinct directory.
//
// bin.mjs may also pass a base dir down (via --storage); when it does, callers
// should use that instead. These helpers are the default/fallback resolution and
// the single source of truth for the on-disk layout.

const APP = 'hyperdht-explorer'

// Same dev/prod discriminator bin.mjs uses: dev runs go through the `bare` runtime
// (argv[0] === 'bare'); a standalone build's argv[0] is the binary itself.
function isDev() {
  return path.basename(Bare.argv[0]) === 'bare'
}

export function dataDir() {
  const override = process.env?.HYPERDHT_EXPLORER_HOME
  if (override) return override
  return path.join(persistent(), isDev() ? `${APP}-dev` : APP)
}

export function dbPath() {
  return path.join(dataDir(), 'nodes.db')
}

export function publicDir() {
  return path.join(dataDir(), 'public')
}

// Absolute path for a generated page, e.g. htmlPath('map.html').
export function htmlPath(file) {
  return path.join(publicDir(), file)
}

// Create the data + public directories if they don't exist yet. Cheap and
// idempotent — call before writing the DB or any HTML.
export function ensureDirs() {
  fs.mkdirSync(publicDir(), { recursive: true }) // recursive also creates dataDir()
}
