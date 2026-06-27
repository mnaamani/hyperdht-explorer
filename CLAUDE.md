# CLAUDE.md

Guidance for working in this repo. Read this before making changes.

## Runtime: Bare, not Node

This project runs on the **Bare runtime**, NOT Node.js. It is a single
pear-runtime CLI app: one entry `bin.mjs` dispatches subcommands. Run a command
with `bare bin.mjs <command> [args]` (or its `npm run <command>` alias).

- Run/test everything with `bare bin.mjs <command>`. `node` will throw
  `TypeError: require.addon is not a function` because the dependencies
  (`bare-process`, `bare-sqlite`, `bare-fs`, `bare-fetch`) are Bare-native.
- To inspect a Bare module's source, **Read** the file — don't execute it under
  Node.
- Module type is by **file extension** (no `"type"` in `package.json`, matching the
  hello-pear-bare boilerplate): ESM source is `.mjs` (`bin.mjs`, `db.mjs`,
  `paths.mjs`, every `commands/*.mjs`), the OTA updater files (`app.cjs`,
  `workers/main.cjs`) are **CJS** `.cjs` because pear-runtime's worker uses
  `require`, and plain `.js` (e.g. `scripts/make.js`) is CJS — run under Node, not
  Bare. Bare infers module type from the extension + nearest `package.json`, so a
  scratch ESM test file must be named `.mjs` (and live in this directory, not
  `/tmp`).
- `Date.now()`, timers (`globalThis.setTimeout`), and `b4a` work normally in the
  app. `bin.mjs` reads `Bare.argv` and owns process exit (`Bare.exit`); commands
  receive a synthetic `ctx.argv` (= `[arg0, cmdName, ...rest]`, so their existing
  `argv[2..]` parsing is unchanged) and must **return** instead of calling
  `process.exit` — exiting from inside a command would skip the updater teardown.
- **Signals don't reach JS on this toolchain — and it's the latest** (bare-runtime
  1.29.5, bare-build 1.0.2, bare-signals 4.2.0, bare-process 4.5.0, all current as of
  2026-06; a fresh hello-pear-bare clone gets the same, so it isn't version skew).
  Empirically verified across every API — `Bare.on('SIG…')` (the hello-pear-bare
  approach), `process.on('SIGINT'/'SIGTERM')` (bare-process, what `graceful-goodbye`
  uses), and `new Signal('SIG…').start()` (bare-signals, refs stored so no GC) — in
  **both** dev (`bare bin.mjs`) and a **standalone** bare-build binary, with and
  without the pear-runtime worker (it's a `bare-thread`, doesn't change the parent's
  signal disposition). With no worker, signals hit the OS default disposition
  (SIGTERM→143, SIGINT→130); with the worker running, **SIGINT is swallowed** (the
  process neither dies nor calls back — Ctrl-C hangs `--updates` runs). Net: no JS
  callback ever fires. (Even hello-pear-bare itself: build it standalone, run it in a
  terminal, press Ctrl-C — it exits **0**, a clean loop-drain. Its
  `Bare.on('SIGINT', () => app.exit(130))` would force exit 130 if it ran, so exit 0
  proves the handler didn't fire there either; "it exited on Ctrl-C" is the idle loop
  draining, not the handler.) So `timeout bare …` hard-kills and skips cleanup.
  `bin.mjs`
  still registers best-effort `Bare.on('SIGHUP'/'SIGINT'/'SIGQUIT'/'SIGTERM')`
  handlers driving a graceful shutdown (`ctx.onShutdown` hooks → e.g. `scan`'s
  summary + snapshot → close updater → exit 128+sig) — harmless and forward-
  compatible, but **inert here**. For a guaranteed clean stop use in-code limits:
  `scan` supports `--for <seconds>` and `--queries <n>`, which resolve the command's
  `run()` promise themselves. Don't _rely_ on signal handlers.

## Architecture

`bin.mjs` is the CLI entry: it strips global flags (`--storage <dir>`,
`--updates`/`--no-updates`), resolves the data dir once, optionally boots the OTA
updater (`app.cjs` → `workers/main.cjs`, best-effort, off by default), then
dynamically imports `commands/<name>.mjs` and awaits its exported `run(ctx)`. Each
command is otherwise a small single-purpose unit sharing one SQLite database.
`db.mjs` is the only place the schema lives.

**Storage lives OUTSIDE the repo.** `paths.mjs` `dataDir()` resolves to bare-storage's
`persistent()` root (macOS `~/Library/Application Support`, Linux
`$XDG_DATA_HOME|~/.local/share`, win32 `%APPDATA%`) + an app subdir that DIFFERS by
runtime: a standalone production binary uses `…/hyperdht-explorer`, while dev runs
(`bare bin.mjs`, detected by `basename(Bare.argv[0]) === 'bare'`) use
`…/hyperdht-explorer-dev` — both durable, never temp, so dev and installed/scheduled
data never mix. Precedence: `--storage` > `HYPERDHT_EXPLORER_HOME` > dev/prod default.
`bin.mjs` resolves the dir once (`storage || dataDir()`) and exports it as
`HYPERDHT_EXPLORER_HOME` so every command's `paths.mjs` agrees. It holds `nodes.db`,
`public/*.html`, and the pear-runtime updater store. `openDb()` defaults to
`paths.dbPath()` and calls `ensureDirs()`; render commands write to
`paths.htmlPath('<name>.html')`. Never write outputs into the repo cwd. The `ops/`
cron wrappers therefore require the **standalone** binary — running under `bare`
(dev) would use the `-dev` dir instead.

**Building/releasing:** `npm run make` (host) / `make:<target>` (cross) wrap
`bare-build --standalone bin.mjs` → `out/<target>/`. OTA needs a real `upgrade`
`pear://` link in `package.json` (mint with `pear touch`); until then keep updates
off. Native-addon (`bare-sqlite`/`bare-fetch`) bundling in standalone builds is the
one thing to verify when first cutting a binary.

- `commands/scan.mjs` (`scan`) — random-walk crawler. `HyperDHT extends dht-rpc`, so
  `findNode`/`query`/`ping`/`toArray` are on the `dht` instance directly.
- `commands/geo.mjs` (`geo`) — ip-api.com batch geo lookup, one query per `/24`.
- `commands/probe.mjs` (`probe`) — `dht.ping` for liveness + RTT.
- `commands/seeders.mjs` (`seeders`) — `pear://`/key → discovery key → `dht.lookup` →
  tag announcer relay endpoints in `app_seeder`.
- `commands/map.mjs` (`map`) — emits self-contained `map.html` (Leaflet, data inlined).
- `commands/ring.mjs` (`ring`) — emits `ring.html`, an offline inline-SVG circular
  projection of the keyspace (no CDN).
- `commands/timeline.mjs` (`timeline`) — emits `timeline.html` (Chart.js via CDN). Views 1/2/4
  are derived from `first_seen`/`last_seen`; the snapshot view reads `snapshots`;
  the storage-health view reads `store_probes`. The crawler writes one `snapshots`
  row per run in `writeSnapshot()` (crawl mode only, gated by `snapshotOnExit`).
- `commands/storeprobe.mjs` (`storeprobe`) — puts canary records and re-polls the closest
  nodes (direct `dht.request` with `COMMANDS.IMMUTABLE_GET` from
  `hyperdht/lib/constants.js`) at checkpoints spanning hyperdht's **~20-min record
  TTL** (`defaultMaxAge`) → a decay curve in `store_probes`. A run is ≈22 min, so it
  is scheduled separately (`ops/scheduled-storeprobe.sh`), NOT in the 15-min scan cycle.
- `commands/summary.mjs` (`summary`) — emits `summary.html`, sortable tables by ASN/operator
  and /24 (no CDN; server-rendered rows + vanilla sort/filter JS).
- `commands/topo.mjs` (`topo`) — emits `topology.html`, a D3 (CDN) force graph of the BGP/AS
  interconnection. Fetches AS adjacencies + holder names from **RIPEstat**
  (`stat.ripe.net/data/asn-neighbours` and `as-overview`) via `bare-fetch`, cached
  in `as_neighbours` / `as_names` (refetch weekly or `--refresh`). It's the underlay
  (BGP), NOT DHT overlay links — keep that distinction in any copy.
- `parseAs(as_info, org, isp)` lives in `db.mjs` (shared by summary + topo); splits
  ip-api's `"AS#### Name"` into `{asn, asnNum, name}`. `cleanName()` (also in db.mjs)
  strips registry-noise quotes from operator names.
- `commands/rpki.mjs` (`rpki`) — RIPEstat RPKI route-origin validity per /24 → `rpki` table.
  `network-info(IP)` → covering prefix + origin ASN, then `rpki-validation` →
  valid/invalid/unknown. `commands/topo.mjs` aggregates this per ASN for a "colour by RPKI"
  toggle on the topology page.
- **RIPEstat rate limits** (used by `commands/topo.mjs` + `commands/rpki.mjs`): always add
  `sourceapp=hyperdht-explorer`; max 8 concurrent/IP (we go sequential + spaced); cache
  and refetch weekly; reuse one covering prefix across the /24s it contains.
- `commands/observe.mjs` (`observe`) — seed-and-listen: announces an ephemeral keypair under a
  public topic's discovery key, records connecting peers (incl. NAT'd) into the
  `observations` table via `conn.rawStream.remoteHost/remotePort`. Self-timed
  (`--minutes`); HEALTH-ONLY (aggregate, public topics, never deanonymize — see the
  `project-intent-health-not-deanon` memory). `ops/scheduled-observe.sh` runs it on a
  separate cron schedule (env: OBSERVE_LINK/OBSERVE_APP/OBSERVE_MINUTES).
- `hostKind(geoRow)` (db.mjs) classifies a network datacenter/mobile/proxy/residential
  from ip-api's `hosting`/`mobile`/`proxy` flags (geo.mjs fetches them; backfills older
  rows; `--refresh` forces all). Surfaced as the summary "Type" column + map colours.
- Distributed/federated explorer is deferred — see `PROPOSAL-federation.md`.

### `nodes.db` schema (see `db.mjs`)

- `nodes` — PK `(host, port)`. Tracking: `first_seen`, `last_seen`,
  `seen_count`, `sessions`. Probe: `alive`, `rtt_ms`, `last_ping`. Seeders:
  `app_seeder` (app name tag, else NULL).
- `geo` — PK `prefix` (the `/24`, e.g. `"143.198.58"`). Cached ip-api result.
- `snapshots` — PK `ts`. One row per scan run: `total_nodes`, `alive`,
  `new_nodes`, `pruned`, `countries`, `asns`, `seeders`, `median_rtt`. Time series.
- `store_probes` — PK `ts`. One row per `storeprobe` run: `canaries`, `put_ok`,
  `get_ok`, `replicas_initial`, `replicas_after`, `persistence`, `delay_s`, and
  `decay` (JSON `[{m,replicas}]` curve across the TTL).
- `as_neighbours` — PK `(asn, neighbour)`. Cached RIPEstat BGP adjacencies for our
  ASNs. `as_names` — PK `asn`, cached AS holder names. Both refetched weekly.
- `rpki` — PK `prefix24`. RIPEstat RPKI validity: `covering`, `origin_asn`,
  `status` (valid/invalid/unknown/unannounced), `fetched_at`.
- `observations` — PK `(public_key, host, port)`. Peers seen connecting via
  `commands/observe.mjs`: `app`, `first_seen`, `last_seen`, `count`. `snapshots.observed` =
  `COUNT(DISTINCT public_key)`, trended on the timeline.

Schema changes go in `db.mjs`: add the column to `CREATE TABLE` **and** add a
`PRAGMA table_info`-guarded `ALTER TABLE` for existing databases. `nodes.db`
persists between runs, so always migrate rather than assuming a fresh DB.

`prefixOf(host)` computes the `/24` key and is the join between `nodes` and
`geo`. The join is done in JS (read both, group by prefix), not in SQL.

## Domain facts that constrain the design

- The DHT is **deliberately non-enumerable**: you can discover routing nodes,
  but you cannot list announced services from random keys. Lookups require a
  known 32-byte target. Don't add features that assume otherwise.
- DHT node `id` is `hash(ip:port)` for ordinary nodes — **not** a connectable
  public key. Only announcer `publicKey`s (from `commands/seeders.mjs`) are connectable.
- The full node RPC vocabulary (PING, FIND_NODE, LOOKUP, ANNOUNCE, MUTABLE/
  IMMUTABLE GET/PUT, PEER_HANDSHAKE…) has **no** "what are you running/seeding"
  command. Probing is limited to liveness.
- Keet (and Pear apps generally): the `pear://` link is the public app-update
  feed and IS discoverable. Private chat rooms are NOT — never imply they are,
  and never fabricate topic hashes/keys.

## Scheduling

`ops/scheduled-scan.sh` runs one cron-driven cycle (scan `--for 120` → geo → probe),
appending to `scan.log`. It self-resolves the project root (it lives in `ops/`),
expects the standalone `hyperdht-explorer` binary on PATH (cron has a minimal env —
set `PATH` in the crontab if needed), and holds an mkdir lock
(`.scan.lock`) to prevent overlap. Setup + the macOS Full-Disk-Access gotcha are
in `SCHEDULING.md`. Bounded `--for` (not signals/`timeout`) is what makes the
cycle exit cleanly and write its snapshot.

## Conventions

- Keep each script standalone and runnable via its `npm run` alias; share only
  through `db.mjs`.
- ip-api.com is HTTP-only on the free tier and rate-limited — preserve the
  `/24` dedupe + header backoff in `commands/geo.mjs`.
- `commands/map.mjs` pulls Leaflet from a CDN; the map needs internet to render tiles.
- Be honest in output about limitations (relay vs. client addresses, wall-clock
  RTT including local latency, seeders ≠ all installs). Existing code says so;
  keep that tone.
