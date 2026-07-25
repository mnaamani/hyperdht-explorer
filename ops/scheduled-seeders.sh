#!/usr/bin/env bash
#
# One seeder census for a public Pear app (Keet by default), for cron. Derives
# the app feed's discovery key, looks up its announcers, and records their relay
# endpoints into nodes.db tagged `app_seeder`, then geo-classifies any newly
# recorded /24s. The render:* pages pick the new data up on the next scan cycle.
#
# A lookup finishes on its own (no fixed window), typically well under a minute,
# so this is cheap enough for a frequent schedule — but it is kept SEPARATE from
# the 15-min scan cycle so a slow lookup can never delay a snapshot.
#
# Seeders are announcers of the PUBLIC app-update feed — a census of online
# installs, aggregate only. Private rooms are not enumerable and are never
# touched here.
#
# Configure via env (defaults shown):
#   SEEDERS_TARGET=keet     # preset name, pear:// link, or raw hypercore key
#   SEEDERS_APP=            # app_seeder tag; empty => preset name (e.g. 'keet')

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

SEEDERS_TARGET="${SEEDERS_TARGET:-keet}"
SEEDERS_APP="${SEEDERS_APP:-}"

LOG="$DIR/scan.log"
LOCK="$DIR/.seeders.lock"

log () { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    log "stale seeders lock — reclaiming"; rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    log "seeders still running — skipping"; exit 0
  fi
fi
echo "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

log "seeders start ($SEEDERS_TARGET${SEEDERS_APP:+ as $SEEDERS_APP})"
# shellcheck disable=SC2086 # unquoted so an empty SEEDERS_APP drops the arg
hyperdht-explorer seeders "$SEEDERS_TARGET" $SEEDERS_APP >>"$LOG" 2>&1 || log "seeders exited non-zero"
hyperdht-explorer geo >>"$LOG" 2>&1 || log "geo exited non-zero"   # classify any new seeder /24s
log "seeders done"
