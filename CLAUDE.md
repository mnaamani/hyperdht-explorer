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
- **Signals: use `process.on` (bare-process), not `Bare.on`; works on Linux, not
  macOS.** Two distinct facts, both empirically verified (bare-runtime 1.29.5,
  bare-build 1.0.2, bare-signals 4.2.0, bare-process 4.5.0 — all latest as of 2026-06):
  1. **`Bare.on('SIG…')` is not a signal API** — Bare core emits no signal events, so
     those handlers never fire on _any_ platform (confirmed on Linux, where the real
     APIs _do_ fire, `Bare.on` still didn't). hello-pear-bare's `Bare.on('SIGINT', …)`
     is effectively dead code; its "exits 0 on Ctrl-C" is bare's clean loop-drain, not
     the handler (a fired handler would force exit 130). The real APIs are
     `process.on('SIG…')` (bare-process, what `graceful-goodbye` uses) and
     `new Signal('SIG…').start()` (bare-signals); bare-process just forwards bare-signals.
  2. **macOS drops _external_ signal delivery** (a darwin-only bare bug). With the real
     API: on **Linux**, an external `kill`/`timeout`/Ctrl-C SIGINT/SIGTERM reaches the
     handler (exit 0 via callback); on **macOS standalone**, the same binary lets
     external signals fall through to the OS default disposition (SIGTERM→143,
     SIGINT→130) — yet a _self_-raised `kill(getpid())` _does_ fire the handler. Repro +
     details in `bug.md`. (Watch the dev confound: the PATH `bare` is a Node wrapper
     that forks the real runtime, so `kill $!` hits the wrapper, not bare; interactive
     Ctrl-C works because the TTY signals the whole process group.)
     `bin.mjs` registers `process.on('SIGHUP'/'SIGINT'/'SIGQUIT'/'SIGTERM')` handlers that
     drive a graceful shutdown (`ctx.onShutdown` hooks → e.g. `scan`'s summary + snapshot →
     close updater → exit 128+sig). These are **real on Linux** (so a cron/daemon/`timeout`
     run shuts down cleanly there) but **inert on macOS** until the bare bug is fixed. So
     for a guaranteed cross-platform clean stop, still prefer in-code limits: `scan`
     supports `--for <seconds>` and `--queries <n>`, which resolve the command's `run()`
     promise themselves. Don't _rely_ on signal handlers on macOS.

## Architecture

`bin.mjs` is the CLI entry: it strips global flags (`--storage <dir>`,
`--updates`/`--no-updates`), resolves the data dir once, optionally boots the OTA
updater (`app.cjs` → `workers/main.cjs`, best-effort, off by default), then
dynamically imports `commands/<name>.mjs` and awaits its exported `run(ctx)`. Each
command is otherwise a small single-purpose unit sharing one SQLite database.
`db.mjs` is the only place the schema lives.

**All SQL lives in `db.mjs` behind a repository layer.** Commands do NOT call
`db.prepare(...)` — they instantiate a per-table repo factory
(`nodesRepo`, `observationsRepo`, `geoRepo`, `snapshotsRepo`, `storeProbesRepo`,
`asTopologyRepo`, `rpkiRepo`) and call its named methods (`nodes.recordSeederEndpoint(...)`,
`geo.locatedNetworks()`, …). Each factory prepares its statements once per
instance and reused; the method names read as intent, not SQL. Conventions:
write methods taking more than a host/port pair take a **single destructured
options object** (so interchangeable args can't be transposed); placeholders stay
positional `?` (we don't rely on named-param binding); read helpers feeding a
JS-side `/24` join return a `Map` keyed by prefix, others return rows/arrays. The
one sanctioned exception is `commands/stats.mjs`'s generic `COUNT(*)` over a fixed
table whitelist — documented inline. When adding a query, add a method to the
relevant repo rather than inlining `db.prepare` in a command.

**Storage lives OUTSIDE the repo.** `paths.mjs` `dataDir()` resolves to bare-storage's
`persistent()` root (macOS `~/Library/Application Support`, Linux
`$XDG_DATA_HOME|~/.local/share`, win32 `%APPDATA%`) + an app subdir that DIFFERS by
runtime: a standalone production binary uses `…/hyperdht-explorer`, while dev runs
(`bare bin.mjs`, detected by `basename(Bare.argv[0]) === 'bare'`) use
`…/hyperdht-explorer-dev` — both durable, never temp, so dev and installed/scheduled
data never mix. Precedence: `--storage` > `HYPERDHT_EXPLORER_HOME` > dev/prod default.
`bin.mjs` resolves the dir once (`storage || dataDir()`) and exports it as
`HYPERDHT_EXPLORER_HOME` so every command's `paths.mjs` agrees. It holds `nodes.db`,
`public/*.html`, the pear-runtime updater store, and — once `observe` runs (it seeds
by default) — `seeder.seed` (the stable seeder identity) and `seed-store/` (the
Corestore of seeded drive blocks). `openDb()` defaults to
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
  tag announcer relay endpoints in `app_seeder`. `ops/scheduled-seeders.sh` runs it
  on its own cron schedule (own lock, env: SEEDERS_TARGET/SEEDERS_APP), kept out of
  the 15-min scan cycle so a slow lookup can't delay a snapshot.
- `commands/map.mjs` (`render:map`) — emits self-contained `map.html` (Leaflet, data inlined).
- `commands/ring.mjs` (`render:ring`) — emits `ring.html`, an offline inline-SVG circular
  projection of the keyspace (no CDN).
- `commands/timeline.mjs` (`render:timeline`) — emits `timeline.html` (Chart.js via CDN). Views 1/2/4
  are derived from `first_seen`/`last_seen`; the snapshot view reads `snapshots`;
  the storage-health view reads `store_probes`. The crawler writes one `snapshots`
  row per run in `writeSnapshot()` (crawl mode only, gated by `snapshotOnExit`).
- `commands/storeprobe.mjs` (`storeprobe`) — puts canary records and re-polls the closest
  nodes (direct `dht.request` with `COMMANDS.IMMUTABLE_GET` from
  `hyperdht/lib/constants.js`) at checkpoints spanning hyperdht's **~20-min record
  TTL** (`defaultMaxAge`) → a decay curve in `store_probes`. A run is ≈22 min, so it
  is scheduled separately (`ops/scheduled-storeprobe.sh`), NOT in the 15-min scan cycle.
- `commands/summary.mjs` (`render:summary`) — emits `summary.html`, sortable tables by ASN/operator
  and /24 (no CDN; server-rendered rows + vanilla sort/filter JS).
- `commands/topo.mjs` (`render:topo`) — emits `topology.html`, a D3 (CDN) force graph of the BGP/AS
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
- `commands/observe.mjs` (`observe`) — two modes, both record connecting peers (incl. NAT'd)
  into the `observations` table via `conn.rawStream.remoteHost` (reduced to its /24
  before it is stored — the port and full address are never persisted); self-timed
  (`--minutes`); prunes observations older than `--prune-days` (default 30) on every
  run; HEALTH-ONLY (aggregate, public topics, never deanonymize — see the
  `project-intent-health-not-deanon` memory).
  **`probe` does not and should not touch observed peers** — it pings `nodes` only.
  Observed endpoints are NAT'd/ephemeral connection addresses, not routing nodes, so
  `dht.ping` would time out for everyone behind a NAT and manufacture a "dead" signal
  biased against exactly the residential/mobile peers this layer exists to count.
  Re-observation, not pinging, is the liveness signal for these peers.
  - **default (seed):** actually replicate + serve the app's **public** update drive. Hyperswarm + Corestore +
    Hyperdrive, join `drive.discoveryKey` as **server+client**, `store.replicate(conn)` per
    connection, best-effort background prefetch of the **latest** version (sparse, not full
    history). Uses a **stable** identity persisted as a 32-byte seed (`<dataDir>/seeder.seed`
    → `crypto.keyPair(seed)`); corestore lives at `<dataDir>/seed-store`. BRIGHT LINE:
    seed only public app-update feeds (signed by the app key ⇒ only authentic data),
    never private/room data. `hyperdrive` is a direct dep for this; Corestore's
    rocksdb-native backend has `.bare` prebuilds so it runs under Bare.
  - **`--disable-seed` (lurker):** raw `hyperdht`, **ephemeral** keypair — announce under
    the topic's discovery key, record, `conn.end()`. Serves nothing. (`--seed` is still
    accepted as a redundant no-op for old callers, since seeding is now the default.)

    Flag parsing consumes `--minutes <n>`'s value (don't let it leak into the app-name
    positional); `--disable-seed`/`--seed` are booleans. Because seeding is the default,
    `ops/scheduled-observe.sh` now seeds on its cron schedule (writes `seed-store/` + uses
    replication bandwidth) unless it passes `--disable-seed`.

  - `ops/scheduled-observe.sh` runs it on a separate cron schedule (env:
    OBSERVE_LINK/OBSERVE_APP/OBSERVE_MINUTES).

- `hostKind(geoRow)` (db.mjs) classifies a network datacenter/mobile/proxy/residential
  from ip-api's `hosting`/`mobile`/`proxy` flags (geo.mjs fetches them; backfills older
  rows; `--refresh` forces all). Surfaced as the summary "Type" column + map colours.
- A long-running daemon (worker-backed), resource governance for sustained seeding
  (allowlist, disk/bandwidth caps, eviction), and a federated explorer are all
  deferred — see `ROADMAP.md`.

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
- `observations` — PK `(public_key, prefix24)`. Peers seen connecting via
  `commands/observe.mjs`: `app`, `first_seen`, `last_seen`, `count`. `snapshots.observed` =
  `COUNT(DISTINCT public_key)`, trended on the timeline.
  **Keyed by /24, and the full host address is never stored** — source ports are
  ephemeral, so the old `(public_key, host, port)` PK inserted a near-duplicate row
  on every reconnect (~40% of rows were pure port churn), and no consumer ever read
  the host without collapsing it to `prefixOf()` first. `migrateObservationsToPrefix()`
  in `db.mjs` rebuilds pre-/24 databases (create/copy/swap — SQLite can't ALTER a PK),
  merging duplicates: `SUM(count)`, `MIN(first_seen)`, `MAX(last_seen)`, `app` from the
  most recent row. Because observed rows carry no member IP, `commands/geo.mjs` queries
  `<prefix>.1` as the representative for observation-only networks (ip-api is a database
  lookup, not a probe — nothing is sent to that address).
  **This is the one table that grows without bound**, so `observe` prunes it by
  `last_seen` on every run: `--prune-days N` (default 30, `0` disables), mirroring
  `scan`'s `--prune-hours` for `nodes`.

Schema changes go in `db.mjs`: add the column to `CREATE TABLE` **and** add a
`PRAGMA table_info`-guarded `ALTER TABLE` for existing databases. `nodes.db`
persists between runs, so always migrate rather than assuming a fresh DB. If a
new column feeds a query, update or add the corresponding repo method (above) in
the same edit — don't reach around the repo layer with an inline `db.prepare`.

`prefixOf(host)` computes the `/24` key and is the join between `nodes` and
`geo`. The join is done in JS (read both, group by prefix), not in SQL.

## Domain facts that constrain the design

- The DHT is **deliberately non-enumerable**: you can discover routing nodes,
  but you cannot list announced services from random keys. Lookups require a
  known 32-byte target. Don't add features that assume otherwise.
- DHT node `id` is `hash(ip:port)` for ordinary nodes — **not** a connectable
  public key. Only announcer `publicKey`s (from `commands/seeders.mjs`) are connectable.
  Verified in dht-rpc 6.27.0: `peer.id()` is `BLAKE2b` of the 6-byte ipv4
  host:port (`lib/peer.js`), and `validateId` (`lib/io.js`) recomputes and rejects
  any mismatch, so the id is bound to ip:port and non-spoofable (Sybil/eclipse
  hardening). Connectable identities (announce/`connect`/`lookup`) are separate
  **Ed25519** keypairs — a different layer from the routing-node id.
- **IPv6 is not supported at any DHT layer — scan and observe are IPv4-only.** Not
  a scanner gap; the protocol can't carry v6. Routing (dht-rpc): bind rejects
  non-IPv4 (`index.js` `throw 'Host must be a IPv4 address'`), node addresses are
  the 6-byte ipv4 encoding, host resolution forces `{ family: 4 }`. Connection
  layer (hyperdht): the Noise payload reserves an `addresses6` field + flag
  (`lib/messages.js`) but it's **inert** — always sent empty (`lib/connect.js`,
  `lib/server.js`), connect/holepunch read `addresses4` only and the holepuncher
  considers `family === 4` (`lib/holepuncher.js`); `relayAddresses` is ipv4 too.
  So `prefixOf()`/the `/24` geo-join can safely assume IPv4. If hyperdht ever
  activates `addresses6`, v6 would surface at the connection layer (observe) first;
  the routing layer would need a wire-format + id-scheme change.
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

## Code Style (beyond prettier/lunte — apply to all new and edited code)

Enforcement is wired into `npm run lint` (`prettier . --check && lunte && eslint .`)
and `npm run format` (`prettier . --write && lunte --fix`). Prettier owns
formatting (`.prettierrc.js` overrides holepunch's `semi: false`/`printWidth: 100`
with `semi: true`/`printWidth: 80`); lunte owns correctness; `eslint.config.js`
backs the house-style rules prettier and lunte can't check (no recommended preset).

- **Always brace `if`/`else`/`for`/`while` bodies** — no brace-less single-statement
  bodies, even one-liners. (eslint `curly`)
- **No single-letter / cryptic variable names** (`s`, `f`, `r`, `t`, `pt`, `it`, `k`…).
  Use descriptive names. Acceptable idioms: loop index `i`/`j`, geometry locals
  (`dx`/`dy`/`x`/`y`), `ctx`, `ev`/`evt` (events). (eslint `id-length`, min 2, with
  the sanctioned 1-char exceptions; SQL-column / geo-field property names are exempt)
- **Avoid `switch` statements where possible** — prefer a lookup table (object keyed
  by case → value or handler function).
- **Avoid deeply nested `if`/`else`** — prefer early returns / guard clauses; extract
  a helper when branching gets deep. Same spirit applies to nested ternaries. (eslint
  `no-nested-ternary`, `max-depth` 4)
- **One statement per line** — never `a; b` on one line or comma-operator statement
  chaining. (eslint `no-sequences`)
- **Always use semicolons** — enforced by prettier (`.prettierrc.js` `semi: true`).
- **80-character line limit** — enforced by prettier (`.prettierrc.js` `printWidth: 80`).
- **At most two chained calls per line** — `funcA().funcB()` is fine;
  `funcA().funcB().funcC()` is not. For 3+ calls, each call goes on its own indented
  line under the receiver. Caveat: prettier only breaks a chain that exceeds 80 chars
  and collapses a manually-broken short chain back onto one line, so for a 3+ chain
  that fits in 80 chars, split it with an intermediate variable instead. Not
  prettier-enforceable; apply by convention.
- **Always strict equality** — `===`/`!==`, never `==`/`!=`. (eslint `eqeqeq`)
- **Declare all variables at the top of their scope** — module state/config consts at
  the top of the module, function locals at the top of the function (guard clauses may
  precede them). Function definitions are not "variables" and live in their sections.
- **Never `setInterval`** — use a self-rescheduling `setTimeout`: the callback does its
  work, then re-arms itself (`timer = setTimeout(tick, ms)`) as its **last** step. Ticks
  can never overlap/stack, a slow or async tick delays the next instead of racing it,
  and each tick can decide not to continue. Clear with `clearTimeout`; the handle changes
  every tick, so keep it in a `let` and re-check it after async work before re-arming.
  (eslint `no-restricted-globals` bans `setInterval`/`clearInterval`)
- **Google TypeScript Style Guide** (https://google.github.io/styleguide/tsguide.html)
  is the baseline for anything not covered above, where it applies to plain JS and
  doesn't conflict with this list or the prettier config. Notably: named exports only
  (no `export default` — enforced on `.mjs` via eslint `no-restricted-syntax`),
  `const`/`let` never `var` (eslint `no-var`), `CONSTANT_CASE` for module-level
  constants, `camelCase`/`PascalCase` otherwise, prefer `for…of`.
- **No functions with more than 3 positional parameters** — take a single destructured
  options object instead. The real hazard is adjacent same-typed args (host/port/hex
  strings especially) silently transposed at a call site, so prefer the object form even
  at 2–3 args when the types are interchangeable. Advisory (not eslint-enforced).
  Exemption: geometry draw helpers (`commands/ring.mjs`/`commands/map.mjs`), where
  positional `(x, y, r, …)` is the universal idiom.
- **No pass-through `return func()` unless the return value is meant** — only write
  `return func()` when the caller's contract is to return `func()`'s value/type. If the
  call is done just for its effect, call it on its own line and `return;` separately, so
  the function doesn't leak a return value it never promised.
- **Class private members use `#`, not `_`** — real ES private fields/methods, enforced
  by the language rather than convention. (An `_` prefix remains fine for its other job:
  marking deliberately-unused parameters, e.g. `(_evt, url) =>`.)
