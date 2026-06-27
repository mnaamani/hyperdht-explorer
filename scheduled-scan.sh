#!/usr/bin/env bash
#
# One dht-explorer cycle, intended to be run from cron (see SCHEDULING.md).
# Runs a bounded scan (which writes a snapshot + prunes stale nodes), then
# refreshes geo-location and liveness so the snapshot metrics stay meaningful.
#
# Safe to schedule frequently: an mkdir-based lock prevents overlapping cycles,
# and every step appends to scan.log with timestamps.

set -u

# Resolve the project directory from this script's own location, so cron can
# invoke it by absolute path and everything (nodes.db, *.js) still lines up.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || exit 1

# cron starts with a minimal environment — make node/npx (managed by Volta) and
# common tool paths available. Adjust if your toolchain lives elsewhere.
export VOLTA_HOME="${VOLTA_HOME:-$HOME/.volta}"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCAN_SECONDS="${SCAN_SECONDS:-120}"   # bounded crawl length; override via env
LOG="$DIR/scan.log"
LOCK="$DIR/.scan.lock"

log () { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

# --- single-instance lock (atomic mkdir, with stale-lock reclaim) -----------
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    log "stale lock found (pid $(cat "$LOCK/pid" 2>/dev/null)) — reclaiming"
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { log "could not acquire lock — skipping"; exit 0; }
  else
    log "previous cycle still running — skipping this run"
    exit 0
  fi
fi
echo "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# --- cycle ------------------------------------------------------------------
log "cycle start (scan ${SCAN_SECONDS}s + geo + probe + rpki)"

npx bare index.js --for "$SCAN_SECONDS" >>"$LOG" 2>&1 || log "scan exited non-zero"
npx bare geo.js                          >>"$LOG" 2>&1 || log "geo exited non-zero"
npx bare probe.js                        >>"$LOG" 2>&1 || log "probe exited non-zero"
# RPKI: cheap no-op once cached (only fetches genuinely new /24s; refetched weekly).
# RIPEstat-rate-limit-safe (sourceapp + sequential + cached).
npx bare rpki.js                         >>"$LOG" 2>&1 || log "rpki exited non-zero"

# NOTE: storeprobe is intentionally NOT here — it spans hyperdht's ~20-min record
# TTL (~22 min/run) and would overlap this 15-min cycle. Schedule it separately on
# a longer interval (see SCHEDULING.md).

# Regenerate the visualizations so the pages stay current.
npx bare timeline.js >>"$LOG" 2>&1
npx bare map.js      >>"$LOG" 2>&1
npx bare ring.js     >>"$LOG" 2>&1
npx bare summary.js  >>"$LOG" 2>&1
npx bare topo.js     >>"$LOG" 2>&1

log "cycle done"
