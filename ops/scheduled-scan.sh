#!/usr/bin/env bash
#
# One hyperdht-explorer cycle, intended to be run from cron (see SCHEDULING.md).
# Runs a bounded scan (which writes a snapshot + prunes stale nodes), then
# refreshes geo-location and liveness so the snapshot metrics stay meaningful.
#
# Safe to schedule frequently: an mkdir-based lock prevents overlapping cycles,
# and every step appends to scan.log with timestamps.

set -u

# Resolve the project root (this script lives in ops/, so go up one) so scan.log
# and the lock dir land at the repo root regardless of cron's working directory.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

# This assumes the `hyperdht-explorer` CLI is INSTALLED on the system (a standalone
# binary from `npm run make`, or `npm i -g .`) and on PATH. cron starts with a
# minimal environment, so put the usual install locations on PATH — adjust if the
# binary lives elsewhere (`command -v hyperdht-explorer` shows where it is).
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

hyperdht-explorer scan --for "$SCAN_SECONDS" >>"$LOG" 2>&1 || log "scan exited non-zero"
hyperdht-explorer geo                          >>"$LOG" 2>&1 || log "geo exited non-zero"
hyperdht-explorer probe                        >>"$LOG" 2>&1 || log "probe exited non-zero"
# RPKI: cheap no-op once cached (only fetches genuinely new /24s; refetched weekly).
# RIPEstat-rate-limit-safe (sourceapp + sequential + cached).
hyperdht-explorer rpki                         >>"$LOG" 2>&1 || log "rpki exited non-zero"

# NOTE: storeprobe is intentionally NOT here — it spans hyperdht's ~20-min record
# TTL (~22 min/run) and would overlap this 15-min cycle. Schedule it separately on
# a longer interval (see SCHEDULING.md).

# Regenerate the visualizations so the pages stay current.
hyperdht-explorer timeline >>"$LOG" 2>&1
hyperdht-explorer map      >>"$LOG" 2>&1
hyperdht-explorer ring     >>"$LOG" 2>&1
hyperdht-explorer summary  >>"$LOG" 2>&1
hyperdht-explorer topo     >>"$LOG" 2>&1

log "cycle done"
