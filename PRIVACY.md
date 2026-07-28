# Privacy and data protection

This document is for whoever **runs** hyperdht-explorer. The notice shown to the
public is a generated page — `hyperdht-explorer render:privacy` writes
`privacy.html`, `scanner.html` and `.well-known/security.txt` into the public
directory alongside the reports.

If you only want the short version: the software measures a public network in
aggregate, stores no peer public keys and no full addresses of connecting peers,
keeps little and not for long, publishes nothing that identifies a subnet-sized
group of end users, and honours exclusion requests in code.

## Does this apply to you?

Yes, if you run an instance in the EEA or UK, or your instance observes peers
there — which any instance does, because the network is global. GDPR applies to
the reference deployment through Iceland's EEA membership, implemented as **Act
No. 90/2018**; the supervisory authority is **Persónuvernd**.

**Each operator is their own controller.** Running your own copy makes you
responsible for your own instance's data. The published notice covers only the
deployment that publishes it.

## What the software collects

| Table             | Contents                                                             | Personal data?                                     | Retention                              |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `nodes`           | IPv4 address + port of DHT routing nodes, liveness, RTT              | Yes — an IP address can be personal                | `--prune-hours`, default 72h           |
| `observations`    | /24 + peer **pseudonym** + app tag + counts                          | Pseudonymous while the salt lives                  | `--prune-days`, default 14d            |
| `pseudonym_salts` | The rotating salts behind those pseudonyms                           | The linking key itself                             | Period end + retention, then destroyed |
| `traffic`         | Counts of inbound RPC per run, by command; how many distinct targets | No — counters only, nothing per-peer or per-target | — (nothing to prune)                   |
| `geo`             | Country/city/ASN per /24, from ip-api                                | No — describes a network                           | Cache, refreshed on demand             |
| `exclusions`      | /24s that asked not to be recorded                                   | Minimal, and kept deliberately                     | Until removed                          |
| everything else   | Aggregate counts, BGP/RPKI facts about prefixes and ASNs             | No                                                 | —                                      |

### The three design decisions that matter

**Connecting peers are never stored identifiably.** `observe` sees a full
address and a real Ed25519 public key on every connection. Neither is written
down. The address is reduced to its /24 (and the log line too — cron appends
those to a file). The key is passed through a keyed BLAKE2b under a salt that
rotates monthly and is then deleted, so a pseudonym is comparable within a month
and meaningless across months. Once a salt is destroyed the surviving rows can
no longer be traced back to a peer by anyone, including the operator.

**Request targets are counted, never kept.** `traffic` acts as an ordinary
routing node and counts the requests other peers send it. Every one of those
requests also carries a target — _which_ topic or record is being looked up or
announced. Recording targets would build a topic → announcer-set index: a node
in the right region of the keyspace could then answer "who is running this app"
for any topic whose key is already known. That is the capability this project
deliberately does not have.

But how _many_ different targets were asked for is a real health signal (a long
tail of one-off lookups is a different network from a handful of hot topics),
and cardinality needs equality, which normally means keeping the values. So each
target is reduced to a short one-way fingerprint under a secret that is **random
per run and never written to disk**, and only the size of that set is stored.
Two consequences worth being precise about: a set of fingerprints does sit in
memory for the length of a run, but it cannot be tested against a candidate
topic without the secret, and the secret is zeroed when the run ends. And the
counts are only meaningful within one run — the same topic in two runs has two
unrelated fingerprints, by design.

`req.value` (record payloads, announce signatures) is never read at all. What
reaches the database is counters, nothing per peer and nothing per target, which
is why `traffic` is the only table with no retention rule: there is no row to
expire.

**Small end-user networks are not named in public.** A residential or mobile
/24 with fewer than `MIN_PUBLISHED_GROUP` (3) participants is published as its
covering /16 with the city withheld. Counts are unaffected — this is a display
rule, so no number on any page is a lie.

## Operator checklist

Before publishing an instance:

1. **Set `CONTACT_EMAIL` in `commands/privacy.mjs`** — one email address, the
   abuse/exclusion contact, and the only site-specific value in the pages.
   `render:privacy` prints a loud warning while it is the placeholder: an
   exclusion offer addressed to `[CONTACT EMAIL]` is not an offer, and RFC 9116
   makes `security.txt`'s `Contact` field mandatory.

   The pages carry no site URL and link to each other relatively, so they work
   from any host without further configuration. `security.txt` therefore omits
   the optional `Canonical` and `Policy` fields, which would have to be absolute
   URIs.

   Note that the published notice does **not** identify an operator. GDPR
   Art. 14(1)(a) does expect the controller to be identifiable, so if you want
   the notice to satisfy that, add the identity back — the page is a plain
   template, so it is a small edit.

2. **Run `render:privacy`** and confirm `privacy.html`, `scanner.html` and
   `.well-known/security.txt` are served. `ops/scheduled-scan.sh` does this on
   every cycle.
3. **Point the crawler IP's reverse DNS (PTR) at `scanner.html`**, and put the
   same contact in the WHOIS/abuse record for the address. This is the single
   highest-value item: a sysadmin who sees your node in their logs gets an
   answer before they file a complaint.
4. **Review the assessments** in `docs/` and adjust them to your deployment:
   [`docs/lia.md`](docs/lia.md) (legitimate interests),
   [`docs/ropa.md`](docs/ropa.md) (Art. 30 record),
   [`docs/dpia.md`](docs/dpia.md) (Art. 35 screening).
5. **Do not add analytics.** The no-cookie, no-tracker property is what lets the
   site skip a consent banner entirely; one script tag ends that.

## Handling requests

**Objection / erasure (Art. 21, Art. 17).** Someone asks for a network to be
left alone:

```sh
hyperdht-explorer exclude add 203.0.113.7 "objection received 2026-07-27"
```

That purges every stored row for the /24 — nodes, observations, geo, rpki — and
blocks future recording. The block is enforced inside the repository layer in
`db.mjs`, at the point of writing, so no collector can bypass it by forgetting
to check. A collector already running reads the list at startup and will honour
it from its next run.

```sh
hyperdht-explorer exclude list             # current exclusions
hyperdht-explorer exclude remove 203.0.113 # lift one (does not restore data)
```

**Access (Art. 15).** Because nothing stored links to a person, an access
request is answered for a network the requester names. The honest answer is
usually short: the /24's geo row, its node rows if any, and observation counts.

**What you cannot do, and should say so.** Exclusion works at /24 granularity —
finer is not possible, because finer is not stored. And excluding a network
stops _your_ records and _your_ node's contact; it cannot stop other DHT
participants from reaching theirs.

## Third parties

Nothing is sold, shared or transferred. Three external services are involved,
all disclosed in the notice:

- **ip-api.com** — one geo lookup per /24. A database query, not a probe.
- **RIPEstat** (RIPE NCC, NL) — public BGP/RPKI data about prefixes and ASNs.
- **CARTO** — basemap tiles for `map.html`, fetched by the _visitor's_ browser.
  This is the only third-party request any page makes. All scripts and styles
  are self-hosted from `vendor/` precisely to keep it the only one; the page
  sends `referrer: no-referrer` so the provider learns an IP and nothing else.

If you want zero third-party requests, drop the tile layer in `commands/map.mjs`
— the markers render fine without a basemap, just harder to read.
