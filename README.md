# dht-explorer

A crawler and visualizer for the [hyperdht](https://github.com/holepunchto/hyperdht)
network — the Kademlia DHT that powers Holepunch / Pear apps (Keet, etc.).

Instead of connecting to one known server, it explores the DHT by random-walking
the keyspace, recording every node it meets into SQLite, geo-locating them,
probing them for liveness, and plotting them on an interactive world map. It can
also look up the peers seeding a specific Pear application by its `pear://` link.

## Requirements

This project runs on the **[Bare](https://github.com/holepunchto/bare) runtime**,
not Node.js. Every command is invoked with `npx bare`. (Running under `node` will
fail — the native modules use Bare addons.)

```sh
npm install
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run scan` | Crawl the DHT (random-walk) and record discovered nodes. Runs until stopped. |
| `npm run geo` | Geo-locate newly discovered networks via ip-api.com (cached, rate-limited). |
| `npm run probe` | Ping every known node to record liveness + round-trip time. |
| `npm run seeders -- <pear://link> [name]` | Find peers seeding a Pear app and tag their endpoints. |
| `npm run observe -- <pear://link> [name] [--minutes N]` | Seed a public topic and record connecting (incl. NAT'd) peers. |
| `npm run map` | Render `map.html` — an interactive world map of everything collected. |
| `npm run ring` | Render `ring.html` — a circular projection of the Kademlia keyspace. |
| `npm run timeline` | Render `timeline.html` — how the network evolves over time. |
| `npm run store -- put/get/mput/mget …` | Put/get small records in the DHT (BEP44-style demo). |
| `npm run storeprobe` | Measure DHT storage reliability (canary put/get persistence). |
| `npm run summary` | Render `summary.html` — sortable tables of nodes by ASN/operator and /24. |
| `npm run topo -- [--refresh]` | Render `topology.html` — BGP/AS interconnection of the hosting networks. |
| `npm run rpki -- [--refresh]` | Fetch RPKI route-origin validity for the hosting prefixes (RIPEstat). |

A typical session:

```sh
npm run scan          # let it run a while, then Ctrl-C
npm run geo
npm run probe
npm run seeders -- pear://17pwkcszz18deaccarhrrixhzf1f5ko1b1dz6j3pxhexebutjwzy keet
npm run map           # open the printed file:// URL in a browser
```

### Bounded / scheduled scans

`scan` runs indefinitely by default. For a timed or scripted run, use the
built-in limits — both shut down gracefully and print the end-of-run summary:

```sh
npm run scan -- --for 60        # crawl ~60 seconds, then stop
npm run scan -- --queries 50    # crawl until 50 findNode queries, then stop
```

> Don't wrap `scan` in `timeout` — the Bare runtime in use does not deliver
> SIGINT/SIGTERM to JS, so an external `timeout` would hard-kill the process and
> skip the summary (the data is still saved either way). Use `--for` / `--queries`.

All state lives in `nodes.db` (SQLite) and the generated HTML pages, created in
the working directory. Re-running `scan` accumulates more sightings over time,
which is what makes the stability tracking meaningful.

To run scans automatically on a schedule (recommended, since the time-series
views get richer as snapshots accrue), see [SCHEDULING.md](./SCHEDULING.md) —
it ships a cron-ready `scheduled-scan.sh` wrapper.

## How it works

### Crawling (`index.js`)

hyperdht's `HyperDHT` extends `dht-rpc`, so the lower-level Kademlia primitives
(`findNode`, `query`, `ping`, `toArray`) are available directly on the DHT
instance — no separate modules needed.

The crawler generates random 32-byte targets and calls `dht.findNode(target)`.
Each reply carries the responding node plus the closest nodes it knows about, so
sweeping random targets progressively reveals nodes across the entire ring. On
startup it also seeds the routing table with the most recently seen peers from
`nodes.db`, alongside the well-known bootstrap nodes.

> **Note:** the crawler discovers DHT **nodes** (the IP\:port routing
> participants). You cannot enumerate *announced services* from random keys — the
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

To keep the database reflecting the *live* network rather than growing forever
with long-dead endpoints, `scan` prunes stale nodes — any whose `last_seen` is
older than a cutoff (default **72 hours**):

- **At startup**, *before* the routing table is seeded — so dead nodes from a
  previous run aren't fed back in as bootstrap peers.
- **Periodically mid-crawl** (every 50 queries) — so long-running scans stay
  trimmed. Nodes seen during the current run have their `last_seen` refreshed, so
  they're never at risk.

Control it with `--prune-hours`:

```sh
npm run scan -- --prune-hours 168   # keep a week instead of 72h
npm run scan -- --prune-hours 0     # disable pruning entirely
```

The number pruned each run is recorded in the scan summary and in the `snapshots`
table. The `geo` cache is **not** pruned — it's keyed by `/24` and reused if a
network reappears, saving an ip-api lookup. Tagged seeders (`app_seeder`) follow
the same 72h rule as any other node.

### Geo-location (`geo.js`)

Resolves IPs to lat/lon/city/ISP using **ip-api.com**'s batch endpoint. To
respect rate limits it:

- looks up at most **one IP per `/24` subnet** (assuming networks ≥ 256 hosts
  share a location), caching results in the `geo` table keyed by prefix;
- skips any `/24` already cached, so each address is queried at most once;
- batches 100 lookups per request and honours the `X-Rl` / `X-Ttl` headers.

### Probing (`probe.js`)

The only "interrogation" the DHT protocol permits is `PING` — DHT nodes expose
nothing about what software they run or what they seed (by design). Probing
records `alive`, `rtt_ms`, and `last_ping`, which sharpens the stability signal:
a node seen across many sessions *and* still answering is clearly dedicated.

### Seeders (`seeders.js`)

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

### Map (`map.js`)

Generates a self-contained `map.html` (Leaflet + markercluster from CDN, data
embedded inline). Networks are grouped by `/24`, one marker each:

- **radius** scales with node count
- **colour** encodes stability (sessions seen): green = stable, red = transient,
  grey = probed but unreachable
- **magenta ring** marks app seeders; a layer toggle filters to seeders only

### Ring (`ring.js`)

A self-contained SVG that projects each node onto a circle by the high bits of its
id (dot size = sightings, colour = sessions, magenta = seeders). Shows keyspace
coverage and popularity. Note: Kademlia uses an XOR metric and is really a binary
trie — the circle is a projection, so ring adjacency ≠ routing distance.

### Topology (`topo.js`)

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

`npm run rpki` adds a **security overlay**: for each hosting prefix it finds the
real announced (covering) prefix + origin ASN via RIPEstat `network-info`, then
checks `rpki-validation` → `valid` / `invalid` / `unknown`, cached per /24 in the
`rpki` table. The topology page then offers a **colour-by RPKI** toggle: each
DHT-hosting AS is coloured by its prefixes' route-origin validity (green = valid,
red = invalid, amber = mixed, grey = unknown/no-ROA) — i.e. how route-secure the
underlay each part of the DHT runs on actually is.

RIPEstat rate-limit compliance is built in: every request carries
`sourceapp=dht-explorer`, calls are strictly sequential (the limit is 8
concurrent/IP) and spaced, one covering prefix is reused across all the /24s it
contains, and results are cached (refetched weekly, or with `--refresh`).

### Store (`store.js`)

A demo of hyperdht's BEP44-style record storage — put/get small signed values
into the DHT (stored on the nodes closest to the key):

```sh
npm run store -- put  "hello"                 # immutable -> prints hash
npm run store -- get  <hash-hex>
npm run store -- mput "status: online" <seed-hex> <seq>   # mutable, signed, updatable
npm run store -- mget <publicKey-hex>
```

Records are **soft state**: ~1 KB max, stored on the ~20 closest nodes, and they
expire in ~20 min unless republished. Mutable records are ed25519-signed with a
`seq` for compare-and-swap. Useful as a pointer/rendezvous layer (e.g. publish a
hypercore key), not as storage.

### Storage probe (`storeprobe.js`)

Uses the put/get primitives to measure the **DHT's storage reliability** — a
dimension node-pinging can't reveal. It puts N immutable canary records, records
which closest nodes accepted each, then re-polls those nodes at checkpoints up to
just past hyperdht's record TTL to build a **decay curve**:

```sh
npm run storeprobe -- --canaries 5 --checkpoints 0,5,10,15,20,22
```

hyperdht holds records for only **~20 minutes** (`defaultMaxAge`) before they
expire unless refreshed, so a meaningful run must span that window — the default
checkpoints do, making each run ≈22 min. (Use small fractional checkpoints like
`0,0.25,0.5` for a quick smoke test.)

Results — put success, retrievability, the replica decay curve, and persistence %
across the TTL — go to the `store_probes` table and are charted on the **timeline**
page (storage-health trend + a "replica decay" chart with the ~20-min expiry
marked). Because a run spans the TTL, schedule it **separately** from the 15-min
scan cycle (see [SCHEDULING.md](./SCHEDULING.md)). A future
[federation proposal](./PROPOSAL-federation.md) covers using these same primitives
to make dht-explorer itself distributed.

### Reading the charts

How to interpret what the **timeline** page shows once data has accrued.

**What to expect from a real storage-probe run.** With the default checkpoints
(spanning the ~20-min TTL), the *Replica decay* chart should hold roughly flat near
the initial replica count (≈20) through ~15 minutes, then fall toward zero around
the dashed **~20-min TTL** marker — empirically reproducing hyperdht's record
expiry. **That cliff is the meaningful result:** *where* it sits and *whether it
shifts* over time is what the storage view tracks.

- A **clean flat-then-cliff at ~20m** = healthy storage; records are held for the
  full TTL by the responsible nodes.
- **Partial decay before the cliff** (replicas sliding down before 20m) = the
  closest nodes are dropping records early, usually LRU cache eviction under load —
  a sign those nodes are busy/overloaded.
- **Low initial replica count** (well under ~20) = the put didn't reach the full
  set of closest nodes (network reachability / churn at that point in the keyspace).
- In the *Storage health* trend, watch **% retrievable** and **% replicas
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

### Timeline (`timeline.js`)

Shows how the population evolves over time: discovery & churn (new vs departed
nodes/hour, cumulative set), approximate concurrent presence, a survival/retention
curve, and a diurnal activity heatmap — all derived from each node's
`first_seen`/`last_seen`. It also plots a **snapshot metrics** series (total /
alive / seeders / countries / median RTT) from the `snapshots` table, which the
crawler appends to at the end of every run, so it fills in as you scan more.

## Files

| File | Role |
| --- | --- |
| `index.js` | DHT crawler (`scan`) |
| `geo.js` | ip-api.com geo enrichment |
| `probe.js` | liveness / RTT ping probe |
| `seeders.js` | Pear app seeder lookup + tagging |
| `map.js` | `map.html` generator |
| `db.js` | shared SQLite schema + `/24` prefix helper |
| `nodes.db` | SQLite database (generated) |
| `map.html` | rendered map (generated) |
