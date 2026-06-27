#!/usr/bin/env bash
#
# One DHT storage-reliability probe, for cron. Runs storeprobe.js, which spans
# hyperdht's ~20-min record TTL (~22 min/run), then refreshes the timeline page so
# the decay/persistence charts stay current. Scheduled SEPARATELY from the 15-min
# scan cycle because of its length (see SCHEDULING.md).

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

export VOLTA_HOME="${VOLTA_HOME:-$HOME/.volta}"
export PATH="$VOLTA_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG="$DIR/scan.log"
LOCK="$DIR/.storeprobe.lock"

log () { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    log "stale storeprobe lock — reclaiming"; rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    log "storeprobe still running — skipping"; exit 0
  fi
fi
echo "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

log "storeprobe start"
hyperdht-explorer storeprobe >>"$LOG" 2>&1 || log "storeprobe exited non-zero"
log "storeprobe done"
