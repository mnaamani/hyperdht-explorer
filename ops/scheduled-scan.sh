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

# This assumes the STANDALONE `hyperdht-explorer` binary (`npm run make` →
# `out/<host>/hyperdht-explorer`) is on PATH. It must be the standalone build:
# anything run via `bare bin.mjs` is classified DEV and points at the separate
# `…-dev` data dir, whereas the standalone binary writes to the production data dir.
# cron starts with a minimal environment — if the binary isn't found, set PATH in
# your crontab (`command -v hyperdht-explorer` shows where it lives).

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
hyperdht-explorer render:timeline >>"$LOG" 2>&1
hyperdht-explorer render:map      >>"$LOG" 2>&1
hyperdht-explorer render:ring     >>"$LOG" 2>&1
hyperdht-explorer render:summary  >>"$LOG" 2>&1
hyperdht-explorer render:topo     >>"$LOG" 2>&1
# Every cycle: stats.html carries the collector freshness dots, so it has to be
# re-rendered often enough that "last run" on the page means something.
hyperdht-explorer render:stats    >>"$LOG" 2>&1
# The notice ships with the reports, so a page can never be published without
# it. Re-rendering also rolls security.txt's mandatory Expires date forward.
hyperdht-explorer render:privacy  >>"$LOG" 2>&1
hyperdht-explorer render:index    >>"$LOG" 2>&1

log "cycle done"
