# Record of Processing Activities (GDPR Art. 30)

**Controller:** the operator of this deployment. (The published notice does not
name one — see the note in `commands/privacy.mjs`.)
**Established in:** Iceland (EEA). No Art. 27 representative needed.
**DPO:** none appointed — Art. 37 does not require one here (no large-scale
systematic monitoring in the Art. 37(1)(b) sense, no special-category data).
**Last reviewed:** 2026-07-27.

> The under-250-employee exemption in Art. 30(5) does **not** apply: it lapses
> when processing is other than occasional, and this runs on a cron schedule
> every 15 minutes. Hence this record.

---

## Activity 1 — DHT routing-node measurement

| Field                     | Entry                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**               | Counting nodes; measuring liveness, latency, churn and geographic/operator distribution of a public P2P network.                                              |
| **Legal basis**           | Art. 6(1)(f) legitimate interests — see [`lia.md`](lia.md).                                                                                                   |
| **Categories of subject** | Operators of hyperdht routing nodes (mostly hosting providers; some individuals).                                                                             |
| **Categories of data**    | IPv4 address and port; first/last seen; sighting and session counts; ping result and RTT; app-seeder tag.                                                     |
| **Source**                | The public DHT routing table (`commands/scan.mjs`, `probe.mjs`, `seeders.mjs`).                                                                               |
| **Recipients**            | None. ip-api.com receives a /24 prefix for geolocation; RIPEstat receives a prefix/ASN for BGP and RPKI data. Neither receives anything else.                 |
| **Transfers outside EEA** | ip-api.com lookups only, and only a network prefix — no data about an identified person is transferred.                                                       |
| **Retention**             | 72 hours since last sighting (`scan --prune-hours`, default 72); stale rows deleted each crawl.                                                               |
| **Security measures**     | Single-host SQLite in an OS app-data directory, no network service exposing it; individual addresses never published; write path gated by the exclusion list. |

## Activity 2 — Observation of connecting peers

| Field                     | Entry                                                                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**               | Counting distinct real participants of public Pear applications, including NAT'd home and mobile peers invisible to a routing crawl, and their datacenter/residential mix.                                                                                                                |
| **Legal basis**           | Art. 6(1)(f) legitimate interests — see [`lia.md`](lia.md).                                                                                                                                                                                                                               |
| **Categories of subject** | Users of public Pear applications whose peers connect to our seeding node.                                                                                                                                                                                                                |
| **Categories of data**    | /24 network (never the full address, never the port); a pseudonym of the peer's public key (never the key); application tag; first/last seen; connection count.                                                                                                                           |
| **Source**                | Inbound connections to our node while it seeds a public application update feed (`commands/observe.mjs`). We do not initiate them.                                                                                                                                                        |
| **Recipients**            | None. ip-api.com receives the /24 for geolocation.                                                                                                                                                                                                                                        |
| **Transfers outside EEA** | As above — a network prefix only.                                                                                                                                                                                                                                                         |
| **Retention**             | 14 days since last sighting (`observe --prune-days`, default 14). The salt that makes a pseudonym linkable is destroyed once every row that could use it has been pruned; surviving data is then effectively anonymous.                                                                   |
| **Security measures**     | Pseudonymisation (keyed BLAKE2b, monthly rotating secret salt) and /24 reduction applied **before** the first write, inside `db.mjs`'s repository layer; log output reduced to /24 as well; exclusion list enforced at the write path; small end-user networks suppressed at publication. |

## Activity 3 — Publication of aggregate reports

| Field                  | Entry                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**            | Publishing network-health findings.                                                                                                                                                |
| **Legal basis**        | Art. 6(1)(f) — same interest; publication is the point of the measurement.                                                                                                         |
| **Categories of data** | Counts grouped by network, operator, ASN and country. No individual addresses. Residential/mobile networks with fewer than 3 participants widened to a /16 with the city withheld. |
| **Recipients**         | The public.                                                                                                                                                                        |
| **Retention**          | Pages are regenerated each cycle from current data; they inherit its retention.                                                                                                    |

## Activity 4 — Website visitors

| Field                      | Entry                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                | Serving static pages.                                                                                                                                                                                                             |
| **Categories of data**     | Standard web-server request logs. **No cookies, no analytics, no trackers** — hence no consent requirement under the ePrivacy rules.                                                                                              |
| **Third-party disclosure** | Basemap tiles on `map.html` are fetched by the visitor's browser from CARTO, disclosing the visitor's IP to that provider. Disclosed in the notice; `referrer: no-referrer` is set. All other scripts and styles are self-hosted. |
| **Retention**              | Per the hosting provider's log configuration — set this to the shortest period that still supports abuse handling.                                                                                                                |

---

## Data subject rights — how each is met

| Right                       | How                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Information (Art. 14)       | Published notice (`privacy.html`), relying on Art. 14(5)(b) for individual notification, whose condition — publishing the information instead — is met by that page. |
| Access (Art. 15)            | Answered for a network the requester names; nothing stored links to a person otherwise.                                                                              |
| Erasure (Art. 17)           | `hyperdht-explorer exclude add <network>` purges every table.                                                                                                        |
| Object (Art. 21)            | Same mechanism, and it also prevents re-collection.                                                                                                                  |
| Rectification / portability | Not meaningfully engaged — no asserted facts about a person, no data provided by one.                                                                                |
| Complaint                   | Persónuvernd, https://www.personuvernd.is                                                                                                                            |

## Breach readiness

The realistic breach is disclosure of `nodes.db`. Its worst case is a list of
DHT node addresses (already public by design) plus counts against /24 networks
and unlinkable pseudonyms — no keys, no full peer addresses, nothing from more
than 14 days ago. A notifiable risk to rights and freedoms is unlikely, but
Art. 33's 72-hour clock is assessed case by case, not assumed away.
