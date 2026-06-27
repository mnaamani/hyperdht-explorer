# Scheduling recurring scans

To watch the DHT evolve over time, run the crawler on a schedule. Each cycle
writes a **snapshot** row (powering the `timeline` page's metric series),
discovers new nodes, prunes stale ones, and refreshes geo + liveness.

The wrapper script [`scheduled-scan.sh`](./scheduled-scan.sh) runs one cycle:

```
scan (--for 120, writes a snapshot + prunes)  →  geo  →  probe
```

It is designed to be driven by **cron**. It:

- resolves the project directory from its own location and `cd`s there (so
  `nodes.db` is found regardless of where cron runs it);
- sets `PATH` / `VOLTA_HOME` itself, because cron starts with a minimal
  environment and `node`/`npx` are managed by Volta;
- holds a single-instance lock (`.scan.lock`) so a slow cycle never overlaps the
  next one;
- appends everything to `scan.log` with timestamps.

## 1. Make sure it's executable

```sh
chmod +x scheduled-scan.sh
```

## 2. Test it once by hand

```sh
./scheduled-scan.sh
tail -n 40 scan.log
```

You should see `cycle start … snapshot: … cycle done`. Run a couple more times
and confirm new `snapshots` rows appear:

```sh
sqlite3 nodes.db "SELECT datetime(ts/1000,'unixepoch'), total_nodes, alive, seeders FROM snapshots ORDER BY ts DESC LIMIT 5;"
```

## 3. Add the cron entry

Open your crontab:

```sh
crontab -e
```

Add this line to run every 15 minutes (use the **absolute path**):

```cron
*/15 * * * * /Users/mokhtar/dht-explorer/client-app/scheduled-scan.sh
```

Save and exit. Check it's registered with `crontab -l`.

### Storage probe (separate, longer schedule)

`storeprobe` measures DHT storage reliability by putting canary records and
re-polling them **across hyperdht's ~20-min record TTL**, so one run takes ≈22
minutes. That's why it is **not** part of the 15-min scan cycle — it would
overlap. Schedule [`scheduled-storeprobe.sh`](./scheduled-storeprobe.sh)
separately, on a longer interval (it has its own lock and refreshes the timeline):

```cron
*/30 * * * * /Users/mokhtar/dht-explorer/client-app/scheduled-storeprobe.sh
```

(Hourly — `0 * * * *` — is also fine and lighter.)

### Observe (seed-and-listen, separate schedule)

`observe` announces under a public topic and records connecting participants for a
fixed window — a long listener, so it runs on its own schedule via
[`scheduled-observe.sh`](./scheduled-observe.sh) (own lock; refreshes geo + map +
timeline afterward). Configure via env (defaults shown):

```cron
# hourly 20-min Keet observation
0 * * * * OBSERVE_MINUTES=20 /Users/mokhtar/dht-explorer/client-app/scheduled-observe.sh
```

```sh
OBSERVE_LINK=pear://<app-key>   # default: the Keet app feed
OBSERVE_APP=keet                # tag for observations
OBSERVE_MINUTES=20              # listen window (keep < the cron interval)
```

Health monitoring only — aggregate participation, never individual tracking; use
only on public topics/feeds you may legitimately peer with.

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
why. Running `./scheduled-scan.sh` by hand still works without it.

## Watching it

```sh
tail -f scan.log                 # live cycle output
sqlite3 nodes.db "SELECT COUNT(*) FROM snapshots;"   # snapshots accumulating
```

## Refreshing the visualizations

The scheduled cycle does **not** regenerate the HTML pages by default. Either
run them on demand:

```sh
npm run timeline && npm run map && npm run ring
```

…or uncomment the `timeline.js` / `map.js` / `ring.js` lines at the bottom of
`scheduled-scan.sh` to rebuild them every cycle.

## Tuning

- **Scan length** — override per run: `SCAN_SECONDS=60 ./scheduled-scan.sh`.
- **Skip probe/geo** — comment those lines out in `scheduled-scan.sh` for a
  lighter cycle (snapshots' `alive`/`rtt`/geo counts will then go stale between
  manual refreshes).

## Stopping

```sh
crontab -e        # delete the line, save
# or remove ALL cron jobs:
crontab -r
```
