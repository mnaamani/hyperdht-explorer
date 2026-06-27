import os from 'bare-os'
import path from 'bare-path'
import fs from 'bare-fs'
import process from 'bare-process'

// Resolve where hyperdht-explorer keeps its runtime state — OUTSIDE the repo. The DB
// and the generated HTML pages all live here, alongside the pear-runtime updater
// store, under one per-user app-data directory.
//
// Resolution order:
//   1. HYPERDHT_EXPLORER_HOME            explicit override (used by tests / CI / cron)
//   2. OS-conventional app-data dir:
//        macOS  ~/Library/Application Support/hyperdht-explorer
//        Linux  $XDG_DATA_HOME/hyperdht-explorer  (default ~/.local/share/hyperdht-explorer)
//        win32  %APPDATA%/hyperdht-explorer
//
// bin.mjs may also pass a base dir down (via --storage); when it does, callers
// should use that instead. These helpers are the default/fallback resolution and
// the single source of truth for the on-disk layout.

const APP = 'hyperdht-explorer'

export function dataDir() {
  const override = process.env?.HYPERDHT_EXPLORER_HOME
  if (override) return override
  const home = os.homedir()
  const platform = os.platform()
  let root
  if (platform === 'win32') {
    root = process.env?.APPDATA || path.join(home, 'AppData', 'Roaming')
  } else if (platform === 'darwin') {
    root = path.join(home, 'Library', 'Application Support')
  } else {
    root = process.env?.XDG_DATA_HOME || path.join(home, '.local', 'share')
  }
  return path.join(root, APP)
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
