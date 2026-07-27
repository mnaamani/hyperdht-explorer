# Data Protection Impact Assessment — screening

**Processing:** continuous measurement of the public hyperdht network.
**Status:** screening assessment; conclusion is that a full DPIA is not required
after mitigation, and this document records why.
**Last reviewed:** 2026-07-27.

Art. 35 requires a DPIA where processing is "likely to result in a high risk to
the rights and freedoms of natural persons". This screening exists because one
Art. 35(3) trigger arguably applies and being able to show the question was
asked is worth far more than the hour it takes.

## Do the Art. 35(3) triggers apply?

| Trigger                                                        | Applies?   | Reasoning                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Systematic and extensive evaluation / automated decisions  | **No**     | No profiling, scoring, or decisions of any kind about individuals. Data is counted, never evaluated.                                                                                                            |
| (b) Special categories or criminal-offence data at large scale | **No**     | None processed. Application tags identify a public app, not a person's characteristics.                                                                                                                         |
| (c) Systematic monitoring of a publicly accessible area        | **Partly** | The DHT is a publicly accessible space and the monitoring is systematic and continuous. It is not the physical-space CCTV case the provision was written for, but the analogy is close enough not to wave away. |

Against the EDPB's nine criteria, the processing scores on **systematic
monitoring** and, marginally, **large scale** and **data concerning vulnerable
subjects** (users of privacy tools may include people who need them). It does
not score on evaluation/scoring, automated decisions with legal effect, matching
datasets, special-category data, innovative technology used against individuals,
or preventing access to a service. Two to three criteria is the EDPB's usual
threshold for "consider a DPIA" rather than "high risk" — hence this screening.

## Risks and mitigations

**R1 — A pseudonymous identity becomes a persistent tracker.**
_Untreated:_ storing peer public keys would create a stable, network-wide,
cross-application identifier for a device, held indefinitely — materially worse
than an IP address, because it survives address changes.
_Mitigation:_ the key is never stored. It is replaced by a keyed BLAKE2b
pseudonym under a secret salt that rotates monthly and is destroyed once the
rows using it are pruned. Cross-period correlation is then impossible for
anyone, including the operator. A bare (unkeyed) hash was rejected: the input
space is enumerable if you already suspect a specific key, so it would be
reversible in practice.
_Residual:_ within a single month, repeat connections from one peer are
linkable. Necessary for a distinct-participant count, and 14-day retention
bounds it further. **Low.**

**R2 — A published page identifies a household.**
_Untreated:_ "203.0.113.0/24 · Selfoss · residential · 1 participant" plus the
ISP's subscriber records is close to naming a person.
_Mitigation:_ residential and mobile networks with fewer than 3 participants are
published as their covering /16 with the city withheld. Full peer addresses are
never stored at all, so they cannot leak into a page by accident.
_Residual:_ a /16 in a small country is still a coarse locator. It does not
narrow to a household. **Low.**

**R3 — Re-identification via the network operator.**
_Untreated:_ an ISP holding subscriber logs can link an address to a customer;
that capability exists regardless of what we do (_Breyer_).
_Mitigation:_ we hold no full addresses for connecting peers, and routing-node
addresses expire in 72 hours. Anyone who could re-identify a peer from our data
would need the address, which we do not have, and the timestamp window, which is
short.
_Residual:_ **Low.** Note the data being processed is data the peer itself
broadcasts to every participant on the network.

**R4 — Function creep.**
_Untreated:_ the same collection points could be turned into a surveillance tool
by a small code change — recording the raw key "temporarily", or logging full
addresses for debugging.
_Mitigation:_ the protections are structural rather than advisory.
Pseudonymisation happens before the value reaches the repository; the exclusion
check lives inside the repository's write methods, so a new collector inherits
it by construction rather than by remembering; log output is reduced to /24
because cron persists logs. The code is public, so a regression is visible.
_Residual:_ **Low**, and observable.

**R5 — Compelled disclosure or breach.**
_Mitigation:_ data minimisation is the defence — there is very little to
disclose, and what survives retention is unlinkable. See the breach note in
[`ropa.md`](ropa.md).
_Residual:_ **Low.**

**R6 — Visitor tracking via third-party subresources.**
_Untreated:_ CDN-hosted scripts disclose every visitor's IP to third parties
before the visitor does anything — the fact pattern behind the European
"Google Fonts" decisions.
_Mitigation:_ all scripts and styles are self-hosted from `vendor/`. Basemap
tiles remain third-party (they cannot practically be self-hosted); this is
disclosed prominently and `referrer: no-referrer` limits it to an IP address.
No cookies, analytics or trackers exist, so no consent mechanism is required.
_Residual:_ **Low**, and avoidable entirely by dropping the tile layer.

## Necessity and proportionality

Covered in [`lia.md`](lia.md): the purpose cannot be met without observing
participants, each retained field is used by a published output, and the fields
that were not needed (full addresses, real public keys, long history) are not
collected rather than collected-and-protected.

## Conclusion

After the mitigations above, no residual risk is assessed as high, and a full
DPIA under Art. 35 is not required. The judgement rests on the mitigations
themselves — **it does not survive their removal.** Re-run this screening if:

- raw public keys or full connecting-peer addresses are ever stored;
- retention is extended materially beyond 14 days / 72 hours;
- the exclusion mechanism stops being enforced at the write path;
- publication starts naming small end-user networks;
- collection expands to non-public topics, or to anything beyond public
  application update feeds.

Prior consultation with Persónuvernd under Art. 36 is not required, since no
high residual risk remains.
