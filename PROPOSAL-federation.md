# Proposal: Federated hyperdht-explorer

**Status:** proposed / not started
**Depends on:** a hypercore-based observation feed, and a merge strategy
(Hyperbee, likely Autobase)

## Summary

Today hyperdht-explorer crawls from a single vantage point and stores everything in one
local `nodes.db`. A single node behind one NAT/region sees a biased slice of the
DHT. This proposal uses hyperdht's own put/get + announce primitives to let many
independent hyperdht-explorer instances **discover each other and pool their findings**,
producing a far more complete and less geographically biased census than any one
machine can — with the DHT itself as the coordination layer.

This is the "Angle 2" from the put/get discussion. "Angle 1" (the storage-
reliability probe, `storeprobe.js`) is already implemented; this document is the
larger architectural follow-on, deliberately deferred.

## Why the DHT is the right substrate

- We're already _on_ the network — no extra servers, accounts, or central registry.
- The pieces map cleanly onto primitives we already use:
  - **`announce` / `lookup`** (see `seeders.js`) → rendezvous: find other explorers.
  - **mutable records** (hyperdht's signed BEP44-style put/get) → each explorer's signed pointer.
  - **hypercore replication** → move the actual (large) datasets peer-to-peer.

## Architecture

### 1. Rendezvous

All explorers `announce` under a shared, well-known topic:

```
topic = hash("hyperdht-explorer/federation/v1")
```

A `lookup` on that topic yields the set of currently-online explorer instances
(their connectable public keys) — exactly the mechanism `seeders.js` uses for Keet.

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

- Autobase vs. simpler "pull + reconcile in SQLite" — is full multi-writer
  linearization worth the complexity, or is periodic pull + last-writer-wins per
  `host:port` enough for a census?
- Feed retention / compaction strategy (append-only growth).
- How much to share — raw sightings vs. only derived summaries (privacy of _who is
  crawling from where_).
- Schema/version negotiation across explorer versions.

## Phasing

1. **Manifest only** — explorers publish summary manifests + announce; build a
   "who else is exploring, and their headline stats" view. No feed sync yet. Small,
   high-signal first step that exercises announce + mutable records end-to-end.
2. **Feed replication, allowlisted** — add hypercore feeds + pull-merge from an
   allowlist into local SQLite. Last-writer-wins per `host:port`.
3. **Autobase view** — if warranted, replace pull-merge with a proper multi-writer
   linearized view and corroboration-based trust.

## Relationship to existing code

- `seeders.js` already demonstrates the announce/lookup rendezvous against a real
  topic — reuse its lookup path.
- hyperdht's signed mutable put/get is the manifest record mechanism (`storeprobe.js`
  exercises the immutable variant of the same DHT storage path).
- The geo/probe/map/ring/timeline pipeline is unchanged; it just reads a richer,
  merged `nodes.db`.
