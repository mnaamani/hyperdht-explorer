#!/usr/bin/env bash
#
# One seed-and-listen observation session, for cron. Announces under a PUBLIC
# topic and records connecting (incl. NAT'd) participants for OBSERVE_MINUTES,
# then refreshes the map + timeline so the observed-participant markers/trend stay
# current. Scheduled SEPARATELY from the 15-min scan cycle (it's a long listener).
#
# Health monitoring only — aggregate participation, never individual tracking.
# Use only on public topics/feeds you may legitimately peer with.
#
# Configure via env (defaults shown):
#   OBSERVE_LINK=pear://17pwkcszz18deaccarhrrixhzf1f5ko1b1dz6j3pxhexebutjwzy
#   OBSERVE_APP=keet
#   OBSERVE_MINUTES=20

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

OBSERVE_LINK="${OBSERVE_LINK:-pear://17pwkcszz18deaccarhrrixhzf1f5ko1b1dz6j3pxhexebutjwzy}"
OBSERVE_APP="${OBSERVE_APP:-keet}"
OBSERVE_MINUTES="${OBSERVE_MINUTES:-20}"

LOG="$DIR/scan.log"
LOCK="$DIR/.observe.lock"

log () { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    log "stale observe lock — reclaiming"; rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    log "observe still running — skipping"; exit 0
  fi
fi
echo "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

log "observe start ($OBSERVE_APP, ${OBSERVE_MINUTES}m)"
hyperdht-explorer observe "$OBSERVE_LINK" "$OBSERVE_APP" --minutes "$OBSERVE_MINUTES" >>"$LOG" 2>&1 || log "observe exited non-zero"
hyperdht-explorer geo      >>"$LOG" 2>&1 || log "geo exited non-zero"      # classify any new observed /24s
log "observe done"
