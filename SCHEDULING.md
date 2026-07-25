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
/ `render:summary` / `render:topo` at the end of every cycle (into the app-data
`public/` dir). To rebuild them on demand instead:

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
