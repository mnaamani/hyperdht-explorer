# hyperdht-explorer

A crawler and visualizer for the [hyperdht](https://github.com/holepunchto/hyperdht)
network — the Kademlia DHT that powers Holepunch / Pear apps (Keet, etc.).

Instead of connecting to one known server, it explores the DHT by random-walking
the keyspace, recording every node it meets into SQLite, geo-locating them,
probing them for liveness, and plotting them on an interactive world map. It can
also look up the peers seeding a specific Pear application by its `pear://` link.

**Live reports: [hyperdht-explorer.com](https://www.hyperdht-explorer.com)** — the
generated pages (summary, world map, keyspace ring, timeline, AS topology) from a
scheduled crawl.

## Requirements

This project runs on the **[Bare](https://github.com/holepunchto/bare) runtime**,
not Node.js. (Running under `node` will fail — the native modules use Bare
addons.) Install the `bare` runtime globally once, then install deps:

```sh
npm install -g bare-runtime   # provides the `bare` binary on PATH
npm install                   # project dependencies
```

It is structured as a single **pear-runtime standalone CLI app** (modeled on
[hello-pear-bare](https://github.com/holepunchto/hello-pear-bare)): one entry,
`bin.mjs`, dispatches subcommands that live in `commands/`. Run a command with
`bare bin.mjs <command>`:

```sh
bare bin.mjs scan --for 60     # crawl for ~60 seconds
bare bin.mjs help              # list all commands
```

### Where data goes

All runtime state lives **outside the repo**, in a per-user OS app-data directory
(resolved via [`bare-storage`](https://github.com/holepunchto/bare-storage)'s
`persistent()`):

| OS      | Location                                                                          |
| ------- | --------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/hyperdht-explorer/`                                |
| Linux   | `$XDG_DATA_HOME/hyperdht-explorer/` (default `~/.local/share/hyperdht-explorer/`) |
| Windows | `%APPDATA%/hyperdht-explorer/`                                                    |

It holds `nodes.db` (SQLite), the generated `public/*.html` pages, and the
pear-runtime updater store. Each render command prints the absolute `file://`
path of the page it wrote.

**Dev vs production storage.** The standalone binary (production) uses the
`hyperdht-explorer` dir above; running via `bare bin.mjs` (dev) uses a
distinct **`hyperdht-explorer-dev`** sibling dir, so local hacking never mixes with
installed/scheduled data. Both are durable (not temp). Override either with
`--storage <dir>` or the `HYPERDHT_EXPLORER_HOME` env var (both take precedence over
the dev/prod default).

### Installing it as a system command

Once `hyperdht-explorer` is on your PATH you can drop the `bare bin.mjs` prefix and
just run `hyperdht-explorer scan --for 60`. Two ways to get there, proper P2P first:

**Build a self-contained binary.** `npm run make` (host) or `npm run make:<target>`
(cross) produces `out/<host>/hyperdht-explorer`; copy it somewhere on PATH. No
`bare` needed at runtime. This standalone binary is what the cron wrappers in `ops/`
expect — see [SCHEDULING.md](./SCHEDULING.md).

## Commands

| Command                                                           | What it does                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `bare bin.mjs scan`                                               | Crawl the DHT (random-walk) and record discovered nodes. Runs until stopped.                                   |
| `bare bin.mjs geo`                                                | Geo-locate newly discovered networks via ip-api.com (cached, rate-limited).                                    |
| `bare bin.mjs probe`                                              | Ping every known node to record liveness + round-trip time.                                                    |
| `bare bin.mjs seeders <pear://link\|preset> [name]`               | Find peers seeding a Pear app and tag their endpoints.                                                         |
| `bare bin.mjs observe <pear://link\|preset> [name] [--minutes N]` | Seed a public app feed (default) and record connecting (incl. NAT'd) peers; `--disable-seed` for passive lurk. |
| `bare bin.mjs render:map`                                         | Render `map.html` — an interactive world map of everything collected.                                          |
| `bare bin.mjs render:ring`                                        | Render `ring.html` — a circular projection of the Kademlia keyspace.                                           |
| `bare bin.mjs render:timeline`                                    | Render `timeline.html` — how the network evolves over time.                                                    |
| `bare bin.mjs storeprobe`                                         | Measure DHT storage reliability (canary put/get persistence).                                                  |
| `bare bin.mjs render:summary`                                     | Render `summary.html` — sortable tables of nodes by ASN/operator and /24.                                      |
| `bare bin.mjs render:topo [--refresh]`                            | Render `topology.html` — BGP/AS interconnection of the hosting networks.                                       |
| `bare bin.mjs rpki [--refresh]`                                   | Fetch RPKI route-origin validity for the hosting prefixes (RIPEstat).                                          |
| `bare bin.mjs stats`                                              | Print a read-only health report: db size, per-table row counts, freshness.                                     |
| `bare bin.mjs render:privacy`                                     | Render `privacy.html`, `scanner.html` and `.well-known/security.txt`.                                          |
| `bare bin.mjs exclude add\|remove\|list <ip\|/24>`                | Stop collecting a network and purge what's already stored (see [PRIVACY.md](PRIVACY.md)).                      |

`seeders` and `observe` accept a **preset** in place of a `pear://` link — a
short name for a well-known public app, which also becomes the default tag.
Available presets: `keet`, `pearpass`. Examples:

```sh
bare bin.mjs seeders keet       # same as passing Keet's pear:// link, tag 'keet'
bare bin.mjs observe pearpass   # observe PearPass, tag 'pearpass'
```

A typical session:

```sh
bare bin.mjs scan     # let it run a while, then Ctrl-C
bare bin.mjs geo
bare bin.mjs probe
bare bin.mjs seeders pear://17pwkcszz18deaccarhrrixhzf1f5ko1b1dz6j3pxhexebutjwzy keet
bare bin.mjs render:map   # open the printed file:// URL in a browser
```

### Bounded / scheduled scans

`scan` runs indefinitely by default. For a timed or scripted run, use the
built-in limits — both shut down gracefully and print the end-of-run summary:

```sh
bare bin.mjs scan --for 60      # crawl ~60 seconds, then stop
bare bin.mjs scan --queries 50  # crawl until 50 findNode queries, then stop
```

> Don't wrap `scan` in `timeout` — the Bare runtime in use does not deliver
> SIGINT/SIGTERM to JS, so an external `timeout` would hard-kill the process and
> skip the summary (the data is still saved either way). Use `--for` / `--queries`.

All state lives in `nodes.db` (SQLite) and the generated HTML pages, under the
app-data directory described above. Re-running `scan` accumulates more sightings
over time, which is what makes the stability tracking meaningful.

To run scans automatically on a schedule (recommended, since the time-series
views get richer as snapshots accrue), see [SCHEDULING.md](./SCHEDULING.md) —
it ships a cron-ready `ops/scheduled-scan.sh` wrapper.

## How it works

### Crawling (`commands/scan.mjs`)

hyperdht's `HyperDHT` extends `dht-rpc`, so the lower-level Kademlia primitives
(`findNode`, `query`, `ping`, `toArray`) are available directly on the DHT
instance — no separate modules needed.

The crawler generates random 32-byte targets and calls `dht.findNode(target)`.
Each reply carries the responding node plus the closest nodes it knows about, so
sweeping random targets progressively reveals nodes across the entire ring. On
startup it also seeds the routing table with the most recently seen peers from
`nodes.db`, alongside the well-known bootstrap nodes.

> **Note:** the crawler discovers DHT **nodes** (the IP\:port routing
> participants). You cannot enumerate _announced services_ from random keys — the
> DHT is deliberately non-enumerable. To find announcers you must already know
> the target hash (see Seeders below).

### Stability tracking

Each node is one row in `nodes`, keyed by `host:port`:

- `first_seen` / `last_seen` — the window we've observed the endpoint
- `seen_count` — total observations across all runs
- `sessions` — distinct crawl runs it appeared in

A long lifespan + many sessions ⇒ dedicated / stable infrastructure; a node seen
once and never again ⇒ transient / dynamic.

### Pruning (during a scan)

To keep the database reflecting the _live_ network rather than growing forever
with long-dead endpoints, `scan` prunes stale nodes — any whose `last_seen` is
older than a cutoff (default **72 hours**):

- **At startup**, _before_ the routing table is seeded — so dead nodes from a
  previous run aren't fed back in as bootstrap peers.
- **Periodically mid-crawl** (every 50 queries) — so long-running scans stay
  trimmed. Nodes seen during the current run have their `last_seen` refreshed, so
  they're never at risk.

Control it with `--prune-hours`:

```sh
bare bin.mjs scan --prune-hours 168   # keep a week instead of 72h
bare bin.mjs scan --prune-hours 0     # disable pruning entirely
```

The number pruned each run is recorded in the scan summary and in the `snapshots`
table. The `geo` cache is **not** pruned — it's keyed by `/24` and reused if a
network reappears, saving an ip-api lookup. Tagged seeders (`app_seeder`) follow
the same 72h rule as any other node.

### Geo-location (`commands/geo.mjs`)

Resolves IPs to lat/lon/city/ISP using **ip-api.com**'s batch endpoint. To
respect rate limits it:

- looks up at most **one IP per `/24` subnet** (assuming networks ≥ 256 hosts
  share a location), caching results in the `geo` table keyed by prefix;
- skips any `/24` already cached, so each address is queried at most once;
- batches 100 lookups per request and honours the `X-Rl` / `X-Ttl` headers.

### Probing (`commands/probe.mjs`)

The only "interrogation" the DHT protocol permits is `PING` — DHT nodes expose
nothing about what software they run or what they seed (by design). Probing
records `alive`, `rtt_ms`, and `last_ping`, which sharpens the stability signal:
a node seen across many sessions _and_ still answering is clearly dedicated.

### Seeders (`commands/seeders.mjs`)

Pear apps are distributed over the same DHT: every install replicates the app's
update feed, announcing under its **discovery key**. Given a `pear://` link (or
raw Hypercore key) this:

1. decodes it to the app's public key (`hypercore-id-encoding`),
2. derives the discovery key (`hypercore-crypto.discoveryKey`),
3. `dht.lookup`s that topic to find announcers (seeders),
4. records each seeder's relay endpoints into `nodes.db`, tagged in the
   `app_seeder` column with `[name]`.

This finds seeders of the **application feed** — effectively a census of online,
announcing installs — **not** private chat rooms, which are keyed by per-room
invite keys and are not discoverable.

### Map (`commands/map.mjs`)

Generates `map.html` with the data embedded inline. Leaflet and markercluster
are served from `public/vendor/` rather than a CDN, so viewing the page
discloses nothing to a third party except the basemap tile request. Networks are
grouped by `/24`, one marker each:

- **radius** scales with node count
- **colour** encodes stability (sessions seen): green = stable, red = transient,
  grey = probed but unreachable
- **magenta ring** marks app seeders; a layer toggle filters to seeders only

### Ring (`commands/ring.mjs`)

A self-contained SVG that projects each node onto a circle by the high bits of its
id (dot size = sightings, colour = sessions, magenta = seeders). Shows keyspace
coverage and popularity. Note: Kademlia uses an XOR metric and is really a binary
trie — the circle is a projection, so ring adjacency ≠ routing distance.

### Topology (`commands/topo.mjs`)

Renders the **underlay** view (`topology.html`): not DHT overlay links (any node
can talk to any node), but how the ASNs hosting the nodes interconnect in the
global BGP routing fabric. For each DHT-hosting ASN it fetches BGP adjacencies from
**RIPEstat** (free, no key, OSINT — inferred from observed AS paths) and caches
them in `as_neighbours`. The D3 force graph shows:

- **green nodes** — our DHT-hosting ASNs, sized by node count
- **cyan nodes** — shared transit/IXP ASNs that link several of our ASNs (e.g.
  Hurricane Electric, RETN), revealing the carriers that interconnect the providers
- **edges** — BGP adjacencies

Tune with `--min-share N` (how many of our ASNs a transit AS must link to appear)
and `--max-connectors N`. Use `--refresh` to refetch (cache is reused for a week).

> Caveat: BGP relationships are **inferred and approximate**, and differ between
> data sources — this is a useful sketch of the underlay, not authoritative routing.

`bare bin.mjs rpki` adds a **security overlay**: for each hosting prefix it finds the
real announced (covering) prefix + origin ASN via RIPEstat `network-info`, then
checks `rpki-validation` → `valid` / `invalid` / `unknown`, cached per /24 in the
`rpki` table. The topology page then offers a **colour-by RPKI** toggle: each
DHT-hosting AS is coloured by its prefixes' route-origin validity (green = valid,
red = invalid, amber = mixed, grey = unknown/no-ROA) — i.e. how route-secure the
underlay each part of the DHT runs on actually is.

RIPEstat rate-limit compliance is built in: every request carries
`sourceapp=hyperdht-explorer`, calls are strictly sequential (the limit is 8
concurrent/IP) and spaced, one covering prefix is reused across all the /24s it
contains, and results are cached (refetched weekly, or with `--refresh`).

### Storage probe (`commands/storeprobe.mjs`)

Uses hyperdht's BEP44-style put/get primitives to measure the **DHT's storage
reliability** — a
dimension node-pinging can't reveal. It puts N immutable canary records, records
which closest nodes accepted each, then re-polls those nodes at checkpoints up to
just past hyperdht's record TTL to build a **decay curve**:

```sh
bare bin.mjs storeprobe --canaries 5 --checkpoints 0,5,10,15,20,22
```

hyperdht holds records for only **~20 minutes** (`defaultMaxAge`) before they
expire unless refreshed, so a meaningful run must span that window — the default
checkpoints do, making each run ≈22 min. (Use small fractional checkpoints like
`0,0.25,0.5` for a quick smoke test.)

Results — put success, retrievability, the replica decay curve, and persistence %
across the TTL — go to the `store_probes` table and are charted on the **timeline**
page (storage-health trend + a "replica decay" chart with the ~20-min expiry
marked). Because a run spans the TTL, schedule it **separately** from the 15-min
scan cycle (see [SCHEDULING.md](./SCHEDULING.md)). The
[roadmap](./ROADMAP.md) covers using these same primitives to make
hyperdht-explorer itself distributed.

### Reading the charts

How to interpret what the **timeline** page shows once data has accrued.

**What to expect from a real storage-probe run.** With the default checkpoints
(spanning the ~20-min TTL), the _Replica decay_ chart should hold roughly flat near
the initial replica count (≈20) through ~15 minutes, then fall toward zero around
the dashed **~20-min TTL** marker — empirically reproducing hyperdht's record
expiry. **That cliff is the meaningful result:** _where_ it sits and _whether it
shifts_ over time is what the storage view tracks.

- A **clean flat-then-cliff at ~20m** = healthy storage; records are held for the
  full TTL by the responsible nodes.
- **Partial decay before the cliff** (replicas sliding down before 20m) = the
  closest nodes are dropping records early, usually LRU cache eviction under load —
  a sign those nodes are busy/overloaded.
- **Low initial replica count** (well under ~20) = the put didn't reach the full
  set of closest nodes (network reachability / churn at that point in the keyspace).
- In the _Storage health_ trend, watch **% retrievable** and **% replicas
  persisted** over days — dips indicate the network got worse at holding data
  (load, churn, or instability), independent of how many nodes are simply alive.

**Node-evolution charts.**

- **Discovery & churn** — once the known set stabilises, new/hour and departed/hour
  should roughly balance; a sustained imbalance means the population is growing or
  shrinking. The cumulative line flattening = your crawl has mostly saturated the
  reachable set.
- **Concurrent presence** — the height is the live population estimate; big dips/
  spikes that recur at the same time of day are diurnal (see below), one-offs are
  usually crawl gaps or network events.
- **Survival / retention** — a steep early drop = most nodes are transient (seen
  once); a long flat tail = a durable core of dedicated infrastructure. The shape is
  the dedicated-vs-dynamic split for the whole population.
- **Diurnal activity** — flat across all 24 hours = datacenter-dominated (the norm
  for this DHT); a visible day-night bulge = a meaningful share of home/dynamic
  nodes. Needs several days of snapshots to be trustworthy.

All time-series views sharpen as the observed span grows, so they're most
meaningful after the scheduled scans have been running for a few days.

### Timeline (`commands/timeline.mjs`)

Shows how the population evolves over time: discovery & churn (new vs departed
nodes/hour, cumulative set), approximate concurrent presence, a survival/retention
curve, and a diurnal activity heatmap — all derived from each node's
`first_seen`/`last_seen`. It also plots a **snapshot metrics** series (total /
alive / seeders / countries / median RTT) from the `snapshots` table, which the
crawler appends to at the end of every run, so it fills in as you scan more.

## Files

| File                          | Role                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bin.mjs`                     | CLI entry — parses flags, resolves the data dir, dispatches subcommands                                |
| `commands/*.mjs`              | one file per subcommand (`scan`, `geo`, `probe`, `render:map`, …), each exporting `run(ctx)`           |
| `db.mjs`                      | shared SQLite schema, per-table repository accessors, + helpers (`prefixOf`, `parseAs`, `hostKind`, …) |
| `paths.mjs`                   | resolves the OS app-data dir + DB / HTML paths                                                         |
| `app.cjs`, `workers/main.cjs` | pear-runtime OTA self-updater (optional, `--updates`)                                                  |
| `scripts/make.js`             | picks the `bare-build` target for the host platform                                                    |
| `vendor/*`                    | checked-in Leaflet / Chart.js / D3, served from our own origin instead of a CDN                        |
| `scripts/vendor-sync.js`      | refreshes `vendor/` from the pinned devDependencies (`npm run vendor:sync`)                            |
| `PRIVACY.md`, `docs/*.md`     | data-protection notes: operator guide, legitimate-interests assessment, Art. 30 record, DPIA screening |
| `<app-data>/nodes.db`         | SQLite database (generated, outside the repo)                                                          |
| `<app-data>/public/*.html`    | rendered map / ring / timeline / summary / topology / privacy (generated)                              |
| `<app-data>/public/vendor/`   | the vendored browser libraries, copied out at render time (generated)                                  |

## Privacy and data protection

This crawler records addresses of participants in a public network, so it
processes personal data and the GDPR applies (the reference deployment runs from
Iceland, an EEA member; the supervisory authority is Persónuvernd). The design
keeps the exposure small:

- **Connecting peers are never stored identifiably.** `observe` reduces the
  address to its `/24` before writing, and replaces the peer's public key with a
  pseudonym — a keyed hash under a secret salt that rotates monthly and is then
  destroyed, so peers cannot be followed across periods by anyone, including the
  operator.
- **Short retention.** Observations 14 days, routing nodes 72 hours, both pruned
  automatically on every run.
- **Nothing identifying is published.** Reports show networks and aggregates;
  residential/mobile `/24`s with fewer than three participants are widened to a
  `/16` with the city withheld.
- **Exclusion is enforced in code.** `exclude add <network>` purges every table
  and blocks re-collection at the point of writing, so no collector can bypass
  it.
- **No CDNs, cookies, analytics or trackers** on the published pages — the only
  third-party request any page makes is for map tiles, which the notice
  discloses.

**If you run your own instance, you are its controller** — this repository's
notice covers only the deployment that publishes it. Read
[PRIVACY.md](PRIVACY.md) before publishing one: it has the operator checklist
(set `CONTACT_EMAIL` in `commands/privacy.mjs`, point the crawler IP's reverse
DNS at `scanner.html`, and so on) and how to handle objection and access
requests. The assessments behind those choices are in
[`docs/lia.md`](docs/lia.md), [`docs/ropa.md`](docs/ropa.md) and
[`docs/dpia.md`](docs/dpia.md).

## License

[Apache License 2.0](./LICENSE) © 2026 Mokhtar Naamani.

This project redistributes third-party software two ways — the browser
libraries checked into [`vendor/`](vendor/) (served to visitors from our own
origin) and the whole production dependency tree, which `bare-build
--standalone` packs into the binary. All of it is permissively licensed
(Apache-2.0, MIT, ISC, BSD); there is no copyleft in the tree. Attributions and
full licence texts are in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md), generated by
`npm run licenses` — regenerate it after changing dependencies or running
`npm run vendor:sync`. The vendored libraries' licences are also served next to
the code itself, at `public/vendor/licenses/`.
