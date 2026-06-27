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
- `package.json` has `"type": "module"`; all `.js`/`.mjs` files are ESM. The OTA
  updater files (`app.cjs`, `workers/main.cjs`) are deliberately **CJS** (`.cjs`)
  because pear-runtime's worker uses `require`. Bare infers module type from the
  extension + nearest `package.json`, so scratch test files must live in this
  directory (not `/tmp`) to be treated as modules.
- `Date.now()`, timers (`globalThis.setTimeout`), and `b4a` work normally in the
  app. `bin.mjs` reads `Bare.argv` and owns process exit (`Bare.exit`); commands
  receive a synthetic `ctx.argv` (= `[arg0, cmdName, ...rest]`, so their existing
  `argv[2..]` parsing is unchanged) and must **return** instead of calling
  `process.exit` — exiting from inside a command would skip the updater teardown.
- **Signals don't reach JS in this Bare build.** Neither `process.on('SIGINT'/
'SIGTERM')` (bare-process) nor `new Signal('SIGTERM').start()` (bare-signals)
  fires — the process dies by default disposition. So `timeout bare …`
  hard-kills and skips cleanup. For bounded/scheduled runs use in-code limits
  instead: `scan` supports `--for <seconds>` and `--queries <n>`, which resolve
  the command's `run()` promise themselves (summary + clean exit). Don't rely on
  signal handlers.

## Architecture

`bin.mjs` is the CLI entry: it strips global flags (`--storage <dir>`,
`--updates`/`--no-updates`), resolves the data dir once, optionally boots the OTA
updater (`app.cjs` → `workers/main.cjs`, best-effort, off by default), then
dynamically imports `commands/<name>.js` and awaits its exported `run(ctx)`. Each
command is otherwise a small single-purpose unit sharing one SQLite database.
`db.js` is the only place the schema lives.

**Storage lives OUTSIDE the repo.** `paths.js` resolves a per-user OS app-data dir
(`dataDir()`): macOS `~/Library/Application Support/hyperdht-explorer`, Linux
`$XDG_DATA_HOME/.../hyperdht-explorer`, Windows `%APPDATA%/hyperdht-explorer` — overridable
via `HYPERDHT_EXPLORER_HOME` or `--storage`. It holds `nodes.db`, `public/*.html`, and
the pear-runtime updater store. `openDb()` defaults to `paths.dbPath()` and calls
`ensureDirs()`; render commands write to `paths.htmlPath('<name>.html')`. Never
write outputs into the repo cwd.

**Building/releasing:** `npm run make` (host) / `make:<target>` (cross) wrap
`bare-build --standalone bin.mjs` → `out/<target>/`. OTA needs a real `upgrade`
`pear://` link in `package.json` (mint with `pear touch`); until then keep updates
off. Native-addon (`bare-sqlite`/`bare-fetch`) bundling in standalone builds is the
one thing to verify when first cutting a binary.

- `commands/scan.js` (`scan`) — random-walk crawler. `HyperDHT extends dht-rpc`, so
  `findNode`/`query`/`ping`/`toArray` are on the `dht` instance directly.
- `commands/geo.js` (`geo`) — ip-api.com batch geo lookup, one query per `/24`.
- `commands/probe.js` (`probe`) — `dht.ping` for liveness + RTT.
- `commands/seeders.js` (`seeders`) — `pear://`/key → discovery key → `dht.lookup` →
  tag announcer relay endpoints in `app_seeder`.
- `commands/map.js` (`map`) — emits self-contained `map.html` (Leaflet, data inlined).
- `commands/ring.js` (`ring`) — emits `ring.html`, an offline inline-SVG circular
  projection of the keyspace (no CDN).
- `commands/timeline.js` (`timeline`) — emits `timeline.html` (Chart.js via CDN). Views 1/2/4
  are derived from `first_seen`/`last_seen`; the snapshot view reads `snapshots`;
  the storage-health view reads `store_probes`. The crawler writes one `snapshots`
  row per run in `writeSnapshot()` (crawl mode only, gated by `snapshotOnExit`).
- `commands/store.js` (`store`) — demo of hyperdht BEP44-style put/get (immutable + mutable).
- `commands/storeprobe.js` (`storeprobe`) — puts canary records and re-polls the closest
  nodes (direct `dht.request` with `COMMANDS.IMMUTABLE_GET` from
  `hyperdht/lib/constants.js`) at checkpoints spanning hyperdht's **~20-min record
  TTL** (`defaultMaxAge`) → a decay curve in `store_probes`. A run is ≈22 min, so it
  is scheduled separately (`ops/scheduled-storeprobe.sh`), NOT in the 15-min scan cycle.
- `commands/summary.js` (`summary`) — emits `summary.html`, sortable tables by ASN/operator
  and /24 (no CDN; server-rendered rows + vanilla sort/filter JS).
- `commands/topo.js` (`topo`) — emits `topology.html`, a D3 (CDN) force graph of the BGP/AS
  interconnection. Fetches AS adjacencies + holder names from **RIPEstat**
  (`stat.ripe.net/data/asn-neighbours` and `as-overview`) via `bare-fetch`, cached
  in `as_neighbours` / `as_names` (refetch weekly or `--refresh`). It's the underlay
  (BGP), NOT DHT overlay links — keep that distinction in any copy.
- `parseAs(as_info, org, isp)` lives in `db.js` (shared by summary + topo); splits
  ip-api's `"AS#### Name"` into `{asn, asnNum, name}`. `cleanName()` (also in db.js)
  strips registry-noise quotes from operator names.
- `commands/rpki.js` (`rpki`) — RIPEstat RPKI route-origin validity per /24 → `rpki` table.
  `network-info(IP)` → covering prefix + origin ASN, then `rpki-validation` →
  valid/invalid/unknown. `commands/topo.js` aggregates this per ASN for a "colour by RPKI"
  toggle on the topology page.
- **RIPEstat rate limits** (used by `commands/topo.js` + `commands/rpki.js`): always add
  `sourceapp=hyperdht-explorer`; max 8 concurrent/IP (we go sequential + spaced); cache
  and refetch weekly; reuse one covering prefix across the /24s it contains.
- `commands/observe.js` (`observe`) — seed-and-listen: announces an ephemeral keypair under a
  public topic's discovery key, records connecting peers (incl. NAT'd) into the
  `observations` table via `conn.rawStream.remoteHost/remotePort`. Self-timed
  (`--minutes`); HEALTH-ONLY (aggregate, public topics, never deanonymize — see the
  `project-intent-health-not-deanon` memory). `ops/scheduled-observe.sh` runs it on a
  separate cron schedule (env: OBSERVE_LINK/OBSERVE_APP/OBSERVE_MINUTES).
- `hostKind(geoRow)` (db.js) classifies a network datacenter/mobile/proxy/residential
  from ip-api's `hosting`/`mobile`/`proxy` flags (geo.js fetches them; backfills older
  rows; `--refresh` forces all). Surfaced as the summary "Type" column + map colours.
- Distributed/federated explorer is deferred — see `PROPOSAL-federation.md`.

### `nodes.db` schema (see `db.js`)

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
  `commands/observe.js`: `app`, `first_seen`, `last_seen`, `count`. `snapshots.observed` =
  `COUNT(DISTINCT public_key)`, trended on the timeline.

Schema changes go in `db.js`: add the column to `CREATE TABLE` **and** add a
`PRAGMA table_info`-guarded `ALTER TABLE` for existing databases. `nodes.db`
persists between runs, so always migrate rather than assuming a fresh DB.

`prefixOf(host)` computes the `/24` key and is the join between `nodes` and
`geo`. The join is done in JS (read both, group by prefix), not in SQL.

## Domain facts that constrain the design

- The DHT is **deliberately non-enumerable**: you can discover routing nodes,
  but you cannot list announced services from random keys. Lookups require a
  known 32-byte target. Don't add features that assume otherwise.
- DHT node `id` is `hash(ip:port)` for ordinary nodes — **not** a connectable
  public key. Only announcer `publicKey`s (from `commands/seeders.js`) are connectable.
- The full node RPC vocabulary (PING, FIND_NODE, LOOKUP, ANNOUNCE, MUTABLE/
  IMMUTABLE GET/PUT, PEER_HANDSHAKE…) has **no** "what are you running/seeding"
  command. Probing is limited to liveness.
- Keet (and Pear apps generally): the `pear://` link is the public app-update
  feed and IS discoverable. Private chat rooms are NOT — never imply they are,
  and never fabricate topic hashes/keys.

## Scheduling

`ops/scheduled-scan.sh` runs one cron-driven cycle (scan `--for 120` → geo → probe),
appending to `scan.log`. It self-resolves the project root (it lives in `ops/`),
sets `PATH`/`VOLTA_HOME` (cron has a minimal env; the global `bare` binary —
`npm i -g bare-runtime` — must be on PATH), and holds an mkdir lock
(`.scan.lock`) to prevent overlap. Setup + the macOS Full-Disk-Access gotcha are
in `SCHEDULING.md`. Bounded `--for` (not signals/`timeout`) is what makes the
cycle exit cleanly and write its snapshot.

## Conventions

- Keep each script standalone and runnable via its `npm run` alias; share only
  through `db.js`.
- ip-api.com is HTTP-only on the free tier and rate-limited — preserve the
  `/24` dedupe + header backoff in `commands/geo.js`.
- `commands/map.js` pulls Leaflet from a CDN; the map needs internet to render tiles.
- Be honest in output about limitations (relay vs. client addresses, wall-clock
  RTT including local latency, seeders ≠ all installs). Existing code says so;
  keep that tone.
