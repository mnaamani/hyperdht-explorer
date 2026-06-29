# Proposal: hyperdht-explorer as a long-running daemon — benevolent seeding & federation

**Status:** proposed / not started
**Depends on:** a long-running **daemon** (worker-backed) substrate; for federation,
additionally a hypercore-based observation feed + merge strategy (Hyperbee, likely
Autobase)

## Summary

Today hyperdht-explorer crawls from a single vantage point and stores everything in one
local `nodes.db`. A single node behind one NAT/region sees a biased slice of the
DHT. This proposal uses hyperdht's own put/get + announce primitives to let many
independent hyperdht-explorer instances **discover each other and pool their findings**,
producing a far more complete and less geographically biased census than any one
machine can — with the DHT itself as the coordination layer.

This is the "Angle 2" from the put/get discussion. "Angle 1" (the storage-
reliability probe, `storeprobe.mjs`) is already implemented; this document is the
larger architectural follow-on, deliberately deferred.

Two complementary directions, both enabled by the same shift from a one-shot CLI to
a **long-running daemon**:

1. **Benevolent seeding** — stop being a passive observer and actually seed/serve
   the public app-update feeds we watch, so we _add_ availability to the network
   instead of just extracting observations from it.
2. **Federation** — pool observations across many explorers (the original body of
   this doc).

The daemon section below is the foundation; seeding and federation build on it.

## From one-shot CLI to a long-running daemon

Every command today is a one-shot process: run, do work, exit. Both benevolent
seeding and federation need the opposite — a node that **stays online**, holds swarm
membership, and replicates over time. So the enabling shift is a long-running
**daemon** mode.

This is also where the Pear **worker** model finally fits — it did _not_ for the
one-shot CLI (see CLAUDE.md / the workers discussion: no UI to isolate, no foreground
loop to protect). The daemon splits cleanly:

- **Backend (worker):** owns the `corestore`, persistent `hyperswarm`/`hyperdht`
  membership, replication, and observation recording. Long-lived — the "local
  backend" in Pear's mental model.
- **CLI (client):** a thin IPC client to the daemon — `daemon start/stop`,
  `seed add/ls/rm`, `stats`, `render`. The existing render commands
  (map/ring/summary/…) become client-side reads of the shared `nodes.db`/feeds.

The one-shot commands keep working standalone; the daemon just hosts the long-lived
subset (observe, seeding, federation sync). `bin.mjs` already boots one worker (the
OTA updater) over a framed IPC pipe — the daemon generalizes exactly that pattern.

## Benevolent seeding — give back, don't just observe

`observe` today is a **passive lurker**: it announces under a public topic's
discovery key and records who connects, but serves nothing. That's mildly
extractive — peers connect to us expecting to replicate, and we don't fulfil it. The
fix is to **actually seed and serve the public app-update feed** we're observing,
turning us into a real, useful replica. Observations then become a _byproduct_ of
legitimately participating rather than the whole point, and a real seeder earns
richer, longer-lived connections → a better, less biased health signal.

**The bright line (non-negotiable):** seed **only the public app-update feed** — the
`pear://` link's Hyperdrive, which is _designed_ to be reseeded by every install.
**Never** private/room data (Keet chat rooms, per-room keys); those aren't
discoverable and are off-limits (see the health-not-deanon intent in CLAUDE.md). The
feature is precisely "replicate + serve the public update drive of apps we opt into."

Mechanics — we already have the pieces (`corestore`, `hyperswarm`, `hyperdht`, and
`seeders.mjs`'s `pear://` → discovery-key resolution; `workers/main.cjs` already
replicates _our own_ upgrade feed):

1. Resolve `pear://` → the app's update drive.
2. Join its discovery key as **server + client** (not just client, as `observe` is).
3. Replicate into the local corestore and serve blocks. Hypercore is signed by the
   app key, so we only ever store/serve authentic data — no risk of relaying forged
   content.
4. Record connecting peers as **aggregate** health, exactly as today.

Seeding and observing the same app share one swarm, so the health data falls out for
free.

### What this costs (the hard part is resources, not replication)

- **Resource governance.** Seeding popular apps means real disk + upload bandwidth.
  Needs an explicit **allowlist** (opt-in per app — never auto-seed everything we
  observe), per-app + global disk/bandwidth caps, and an eviction policy. This is the
  bulk of the work.
- **Redistribution.** We'd be re-serving third-party software feeds. For open P2P
  update drives that is the intended model (every install reseeds), but keep it
  opt-in and don't seed anything whose distribution looks restricted.
- **Privacy intent unchanged.** A seeder sees many replication peers; the
  health-only/aggregate rule still governs — counts + `/24` geo, never per-identity
  logs. Note the identity shift: `observe` uses an _ephemeral_ keypair; a seeder has
  a stable, steady-footprint identity. More honest, but a deliberate change in the
  project's character (explorer → explorer + benevolent seeder).

## Why the DHT is the right substrate

- We're already _on_ the network — no extra servers, accounts, or central registry.
- The pieces map cleanly onto primitives we already use:
  - **`announce` / `lookup`** (see `seeders.mjs`) → rendezvous: find other explorers.
  - **mutable records** (hyperdht's signed BEP44-style put/get) → each explorer's signed pointer.
  - **hypercore replication** → move the actual (large) datasets peer-to-peer.

## Architecture

### 1. Rendezvous

All explorers `announce` under a shared, well-known topic:

```
topic = hash("hyperdht-explorer/federation/v1")
```

A `lookup` on that topic yields the set of currently-online explorer instances
(their connectable public keys) — exactly the mechanism `seeders.mjs` uses for Keet.

### 2. Per-explorer pointer record

Each explorer owns an ed25519 keypair (persisted locally). It publishes a **mutable
record** under `hash(publicKey)` whose ~1 KB value is a compact manifest:

```jsonc
{
  "feed": "<hypercore-key>", // the explorer's observation feed
  "nodes": 1234, // summary stats (cheap to show without syncing)
  "alive": 1180,
  "countries": 31,
  "updated": 1719300000000,
  "v": 1
}
```

The record is re-published on a timer (records are soft state, ~20 min TTL). The
big data is **not** in the DHT — only the pointer is.

### 3. Observation feed (the data)

Each explorer appends its observations to a **hypercore** (append-only, signed,
replicable). Two modeling options:

- **Event log** — append immutable observation events (`{node, ts, rtt, …}`). Plays
  to hypercore's append-only strength; consumers fold events into their own view.
- **Hyperbee snapshot** — periodically publish a Hyperbee keyed by `host:port`.
  Easier to query, but updates append (log growth) — needs compaction.

### 4. Merge

A consuming explorer:

1. `lookup`s the federation topic → peer keys.
2. `mget`s each peer's manifest → feed keys + summaries.
3. Replicates feeds of interest and **merges** them into a unified view.

Merging independent writers deterministically is the **Autobase** use case (each
explorer = one writer; Autobase linearizes them into one materialized view, e.g. a
Hyperbee). The merged view can still be projected into the local SQLite for the
existing map/ring/timeline pages — keeping SQLite as the query/serving layer while
hypercore/Autobase handle distribution.

## Trust & abuse

The hard part is not transport, it's trust — anyone can join the topic and publish
anything under their own key.

- **Signed provenance** — every observation carries its origin explorer key; merges
  keep attribution, so a bad source can be down-weighted or dropped.
- **Allowlist / web-of-trust** — start with an explicit allowlist of explorer keys
  you accept; relax later toward reputation (corroboration across independent
  vantage points raises confidence).
- **Corroboration** — a node seen by many unrelated explorers is trustworthy; one
  only ever reported by a single key is suspect.
- **Sybil resistance** — open federation invites fake explorers; an allowlist or
  proof-of-work/stake gate is needed before going fully open.

## Open questions

Daemon + seeding:

- **Seeding scope / discovery.** Which apps to seed by default (none → explicit
  allowlist is the safe answer), and how a user finds/chooses apps worth supporting.
- **Resource budgets.** Sane default disk/bandwidth caps, and behavior on cap-hit
  (stop accepting new blocks vs. evict least-recently-useful).
- **Daemon lifecycle.** Always-on vs. cron-supervised; how it coexists with the
  bounded one-shot commands; restart/supervision; where it stores its PID/socket.
- **Identity vs. health-only.** Does a stable seeder identity weaken the
  aggregate-only posture, and what keeps recording strictly aggregate?

Federation:

- Autobase vs. simpler "pull + reconcile in SQLite" — is full multi-writer
  linearization worth the complexity, or is periodic pull + last-writer-wins per
  `host:port` enough for a census?
- Feed retention / compaction strategy (append-only growth).
- How much to share — raw sightings vs. only derived summaries (privacy of _who is
  crawling from where_).
- Schema/version negotiation across explorer versions.

## Phasing

Two tracks; the daemon substrate (D0) underpins both. Seeding (D-track) is the
nearer-term, higher-value-to-the-network work; federation (F-track) is the larger
follow-on.

**Daemon + benevolent seeding**

- **D0 — Daemon skeleton.** Long-running mode + worker backend + CLI-as-IPC-client;
  move `observe` into it. No seeding yet — just prove the daemon/IPC shape.
- **D1 — Opt-in seeding, capped.** `seed add <pear://>` replicates + serves one
  allowlisted app's **public** feed, with hard disk/bandwidth caps and explicit
  public-feed-only enforcement. Fold observation recording into the seeding swarm.
- **D2 — Multi-app + governance.** Several seeded apps, eviction policy, per-app +
  global budgets, a `seed ls` / `stats` view.

**Federation** (builds on the daemon)

1. **Manifest only** — explorers publish summary manifests + announce; build a
   "who else is exploring, and their headline stats" view. No feed sync yet. Small,
   high-signal first step that exercises announce + mutable records end-to-end.
2. **Feed replication, allowlisted** — add hypercore feeds + pull-merge from an
   allowlist into local SQLite. Last-writer-wins per `host:port`.
3. **Autobase view** — if warranted, replace pull-merge with a proper multi-writer
   linearized view and corroboration-based trust.

## Relationship to existing code

- `seeders.mjs` already demonstrates the announce/lookup rendezvous against a real
  topic and the `pear://` → discovery-key resolution that seeding needs — reuse both.
- `observe.mjs`'s announce-and-record loop is the seed of the seeding swarm: extend
  it from client-only to **server + client** and add replication into a corestore.
- `workers/main.cjs` already replicates _our own_ upgrade feed via pear-runtime over
  a framed IPC pipe; the daemon backend generalizes this to N app drives, and
  `bin.mjs` already has the worker-boot + IPC wiring to reuse.
- hyperdht's signed mutable put/get is the manifest record mechanism (`storeprobe.mjs`
  exercises the immutable variant of the same DHT storage path).
- The geo/probe/map/ring/timeline pipeline is unchanged; it just reads a richer,
  merged `nodes.db` (and, under the daemon, reads it as an IPC client).
