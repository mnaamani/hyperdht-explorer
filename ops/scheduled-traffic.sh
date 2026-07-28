#!/usr/bin/env bash
#
# One inbound-request-load measurement, for cron. Runs `traffic`, which has to
# stay up long enough for the node to become routable (~20 min of stability plus
# a NAT check) before it measures anything — so a run is long by nature and is
# scheduled SEPARATELY from the 15-min scan cycle (see SCHEDULING.md).
#
# It is count-only: the command of each inbound request is tallied, and the
# target (which topic or record was being asked for) is never read. Nothing
# per-peer is written, so unlike the other collectors there is nothing here to
# prune or pseudonymise.
#
# Env:
#   TRAFFIC_MINUTES        measurement run length, minutes  (default 60)
#   TRAFFIC_FORCE          set to 1 on a host with an open firewall to run the
#                          NAT check at bootstrap and skip the ~20-min warm-up

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

LOG="$DIR/scan.log"
LOCK="$DIR/.traffic.lock"
MINUTES="${TRAFFIC_MINUTES:-60}"
FORCE="${TRAFFIC_FORCE:-0}"

log () { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    log "stale traffic lock — reclaiming"; rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    log "traffic still running — skipping"; exit 0
  fi
fi
echo "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

ARGS=(traffic --minutes "$MINUTES")
if [ "$FORCE" = "1" ]; then
  ARGS+=(--force-persistent)
fi

log "traffic start (${MINUTES}m)"
hyperdht-explorer "${ARGS[@]}" >>"$LOG" 2>&1 || log "traffic exited non-zero"
hyperdht-explorer render:stats >>"$LOG" 2>&1 || log "render:stats exited non-zero"
hyperdht-explorer render:timeline >>"$LOG" 2>&1 || log "render:timeline exited non-zero"
log "traffic done"
