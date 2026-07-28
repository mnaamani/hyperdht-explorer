# Scheduling recurring scans

To watch the DHT evolve over time, run the crawler on a schedule. Each cycle
writes a **snapshot** row (powering the `timeline` page's metric series),
discovers new nodes, prunes stale ones, and refreshes geo + liveness.

The wrapper script [`ops/scheduled-scan.sh`](./ops/scheduled-scan.sh) runs one cycle:

```
scan (--for 120, writes a snapshot + prunes)  →  geo  →  probe
```

> **Prerequisite.** The wrappers call the **installed standalone** `hyperdht-explorer`
> binary directly (not `bare bin.mjs`). Build it with `npm run make` and copy
> `out/<host>/hyperdht-explorer` onto PATH (see the README's "Installing as a system
> command"). It must be the standalone binary: anything run via `bare bin.mjs` is
> treated as DEV and writes to a separate `…-dev` data dir, so cron would silently
> collect into the wrong place.

> **Where data lives.** Run by the standalone binary, `nodes.db` and the generated
> `public/*.html` pages are written to the per-user app-data dir (macOS
> `~/Library/Application Support/hyperdht-explorer/`, Linux
> `~/.local/share/hyperdht-explorer/`), **not** the repo. (Local `bare bin.mjs` dev
> runs use the `…-hyperdht-explorer-dev` sibling instead, so they don't mix with the
> scheduled production data.) `scan.log` and the lock dirs
> stay at the repo root (the wrapper `cd`s there; the scripts themselves live in
> `ops/`). Find the exact data path any time with
> `hyperdht-explorer help`. The `sqlite3` snippets below assume macOS — adjust the
> DB path for your OS, or set `DB="$(...)/nodes.db"`.

It is designed to be driven by **cron**. It:

- resolves the project directory from its own location and `cd`s there (so the
  wrapper, lock, and `scan.log` line up regardless of where cron runs it);
- relies on the installed `hyperdht-explorer` command being on PATH; cron starts
  with a minimal environment, so if it isn't found, set `PATH` in your crontab
  (`command -v hyperdht-explorer` shows where it lives);
- holds a single-instance lock (`.scan.lock`) so a slow cycle never overlaps the
  next one;
- appends everything to `scan.log` with timestamps.

## 1. Make sure it's executable

```sh
chmod +x ops/scheduled-scan.sh
```

## 2. Test it once by hand

```sh
./ops/scheduled-scan.sh
tail -n 40 scan.log
```

You should see `cycle start … snapshot: … cycle done`. Run a couple more times
and confirm new `snapshots` rows appear:

```sh
sqlite3 ~/Library/Application\ Support/hyperdht-explorer/nodes.db "SELECT datetime(ts/1000,'unixepoch'), total_nodes, alive, seeders FROM snapshots ORDER BY ts DESC LIMIT 5;"
```

## 3. Add the cron entry

Open your crontab:

```sh
crontab -e
```

Add this line to run every 15 minutes (use the **absolute path**):

```cron
*/15 * * * * /Users/mokhtar/dht-explorer/client-app/ops/scheduled-scan.sh
```

Save and exit. Check it's registered with `crontab -l`.

### Storage probe (separate, longer schedule)

`storeprobe` measures DHT storage reliability by putting canary records and
re-polling them **across hyperdht's ~20-min record TTL**, so one run takes ≈22
minutes. That's why it is **not** part of the 15-min scan cycle — it would
overlap. Schedule [`ops/scheduled-storeprobe.sh`](./ops/scheduled-storeprobe.sh)
separately, on a longer interval (it has its own lock and refreshes the timeline):

```cron
*/30 * * * * /Users/mokhtar/dht-explorer/client-app/ops/scheduled-storeprobe.sh
```

(Hourly — `0 * * * *` — is also fine and lighter.)

### Request load (separate, long schedule)

`traffic` counts the inbound RPC other peers send us while we act as an ordinary
routing node. A node only becomes routable after ~20 minutes of stability plus a
NAT check, so a run is long by nature — default 60 minutes, of which the first
~20 measure nothing. Schedule
[`ops/scheduled-traffic.sh`](./ops/scheduled-traffic.sh) well apart from the scan
cycle (own lock; refreshes the stats + timeline pages afterwards):

```cron
# one measurement every 3 hours
0 */3 * * * /Users/mokhtar/dht-explorer/client-app/ops/scheduled-traffic.sh
```

Configure via env (defaults shown):

```sh
TRAFFIC_MINUTES=60   # run length; keep comfortably under the cron interval
TRAFFIC_FORCE=0      # 1 = run the NAT check at bootstrap, skipping the warm-up.
                     # Only useful on a host with an open/consistent firewall;
                     # it cannot make a firewalled node routable.
```

**This only produces data on a reachable host.** Behind a typical home NAT the
node never becomes routable and every run records ~zero inbound work — correctly
marked as such, and left off the charts. A VPS with the DHT port open is where
this measurement is worth scheduling.

Count-only: the command of each request is tallied and its target is never read,
so unlike the other collectors nothing per-peer is written and there is nothing
to prune.

### Observe (seed-and-listen, separate schedule)

`observe` announces under a public topic and records connecting participants for a
fixed window — a long listener, so it runs on its own schedule via
[`ops/scheduled-observe.sh`](./ops/scheduled-observe.sh) (own lock; refreshes geo + map +
timeline afterward). Configure via env (defaults shown):

```cron
# hourly 20-min Keet observation
0 * * * * OBSERVE_MINUTES=20 /Users/mokhtar/dht-explorer/client-app/ops/scheduled-observe.sh
```

```sh
OBSERVE_LINK=pear://<app-key>   # default: the Keet app feed
OBSERVE_APP=keet                # tag for observations
OBSERVE_MINUTES=20              # listen window (keep < the cron interval)
```

Health monitoring only — aggregate participation, never individual tracking; use
only on public topics/feeds you may legitimately peer with.

### Seeder census (Keet, separate schedule)

`seeders` looks up the announcers of a public app-update feed and records their
relay endpoints into `nodes.db` tagged `app_seeder`, so they flow into the
geo/probe/map pipeline. A lookup ends on its own (usually well under a minute),
but [`ops/scheduled-seeders.sh`](./ops/scheduled-seeders.sh) is kept out of the
15-min scan cycle (own lock) so a slow lookup can never delay a snapshot. It
geo-classifies any new seeder /24s afterwards.

```cron
# Keet seeder census every 30 minutes
*/30 * * * * /Users/mokhtar/dht-explorer/client-app/ops/scheduled-seeders.sh
```

Configure via env (defaults shown):

```sh
SEEDERS_TARGET=keet   # preset name, pear://link, or raw hypercore key
SEEDERS_APP=          # app_seeder tag; empty => the preset name ('keet')
```

Seeders are announcers of the **public** app-update feed — a census of online
installs. Private rooms are not enumerable and are never touched; seeders ≠ all
installs (offline or non-announcing peers don't show up).

### Other intervals

```cron
*/30 * * * * …   # every 30 minutes
0 * * * *    …   # hourly, on the hour
0 */6 * * *  …   # every 6 hours
```

## The whole crontab

All five wrappers together, with the offsets staggered so their starts don't
pile onto the same minute. Replace the path with your own:

```cron
PATH=/usr/local/bin:/usr/bin:/bin

# crawl + geo + probe, and re-render every page (incl. stats.html's freshness)
*/15 * * * *  /Users/mokhtar/dht-explorer/client-app/ops/scheduled-scan.sh
# storage-reliability decay probe (~22 min/run, spans the record TTL)
5,35 * * * *  /Users/mokhtar/dht-explorer/client-app/ops/scheduled-storeprobe.sh
# seeder census for the configured app
20,50 * * * * /Users/mokhtar/dht-explorer/client-app/ops/scheduled-seeders.sh
# seed-and-listen for connecting participants
10 * * * *    OBSERVE_MINUTES=20 /Users/mokhtar/dht-explorer/client-app/ops/scheduled-observe.sh
# inbound request load — long run, only useful on a reachable host (see below)
25 */3 * * *  /Users/mokhtar/dht-explorer/client-app/ops/scheduled-traffic.sh
```

(Absolute paths throughout, deliberately. Cron puts a `VAR=value` line into the
job's environment rather than substituting it itself, so whether a `$VAR` in the
command expands depends on the shell cron hands it to — not worth relying on for
the path to the script that has to run.)

Each wrapper holds its own lock, so overlapping schedules skip rather than
collide, and each runs its own DHT instance on its own socket — a `traffic` run
spanning several scan cycles is fine. The staggering is about not starting five
processes at once, not about correctness.

**Two caveats before you paste this in.** `scheduled-traffic.sh` is worth
scheduling only where the DHT port is actually reachable; behind a home NAT the
node never becomes routable and every run records zero (correctly marked, and
left off the charts). And `scheduled-observe.sh` **seeds by default** — it will
use disk under `seed-store/` and replication bandwidth on every run. There is no
env toggle for that one: add `--disable-seed` to the `observe` line inside the
wrapper if you only want the passive listener.

## macOS gotcha: Full Disk Access

On modern macOS, the cron daemon often needs **Full Disk Access** to run jobs:

1. System Settings → Privacy & Security → Full Disk Access
2. Add `/usr/sbin/cron` (in Finder, ⌘⇧G and paste the path, then select `cron`).

If your first scheduled run never appears in `scan.log`, this is almost always
why. Running `./ops/scheduled-scan.sh` by hand still works without it.

## Watching it

```sh
tail -f scan.log                 # live cycle output
sqlite3 ~/Library/Application\ Support/hyperdht-explorer/nodes.db "SELECT COUNT(*) FROM snapshots;"   # snapshots accumulating
```

## Refreshing the visualizations

`ops/scheduled-scan.sh` regenerates `render:timeline` / `render:map` / `render:ring`
/ `render:summary` / `render:topo` / `render:stats` at the end of every cycle (into
the app-data `public/` dir). `render:stats` is in that list because `stats.html`
carries the collector freshness indicators — it has to be re-rendered often for
"last run" on the page to mean anything. To rebuild them on demand instead:

```sh
bare bin.mjs render:timeline && bare bin.mjs render:map && bare bin.mjs render:ring
```

Trim those lines at the bottom of `ops/scheduled-scan.sh` for a lighter cycle if you
don't need every page refreshed each run.

## Tuning

- **Scan length** — override per run: `SCAN_SECONDS=60 ./ops/scheduled-scan.sh`.
- **Skip probe/geo** — comment those lines out in `ops/scheduled-scan.sh` for a
  lighter cycle (snapshots' `alive`/`rtt`/geo counts will then go stale between
  manual refreshes).

## Stopping

```sh
crontab -e        # delete the line, save
# or remove ALL cron jobs:
crontab -r
```
