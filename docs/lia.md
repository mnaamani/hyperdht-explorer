# Legitimate Interests Assessment

**Processing:** measuring the health of the public hyperdht network by taking
part in it — crawling routing nodes, probing liveness, and seeding public
application update feeds.
**Legal basis relied on:** GDPR Art. 6(1)(f), legitimate interests.
**Controller:** the operator of this deployment. (The published notice does not
name one — see the note in `commands/privacy.mjs`.)
**Last reviewed:** 2026-07-27.

An LIA is the three-part test the GDPR requires before Art. 6(1)(f) can be
relied on: a real interest, necessity, and a balance that does not override the
rights of the people involved. It is not a formality — if the third part fails,
the basis fails.

## 1. Purpose test — is the interest legitimate?

Decentralised networks are asserted to be decentralised. Whether a given one
actually is — how many independent operators, how concentrated in a handful of
hosting companies, how much runs on real end-user machines rather than rented
servers, how reliable its storage layer is over time — is an empirical question
that nobody can answer from outside the network.

The interest is producing that answer publicly and continuously:

- **For users of Pear/Holepunch applications**, whose privacy and censorship
  properties depend on the network being genuinely distributed rather than
  quietly consolidated into three datacenters.
- **For the wider public and researchers**, as an independent measurement of a
  live P2P network, published rather than kept private.
- **For the network's own operators**, as outside observability they do not
  otherwise have.

This is a recognised category of interest: network and information security and
the operation of a service are cited in Recital 49, and public-interest research
in Recital 157. Nothing about it is commercial — there is no advertising,
profiling, sale or onward disclosure.

## 2. Necessity test — is the processing needed?

**Can the purpose be achieved without processing personal data at all?** No.
Node counts, liveness and geographic distribution are _derived from_ the
addresses of participants; there is no aggregate feed to consult instead. The
DHT is deliberately non-enumerable, so the only way to count it is to
participate and observe.

**Is each field necessary?**

| Field                    | Necessary because                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Node IP + port           | The unit being counted; also required to send the ping that measures liveness.      |
| /24 of a connecting peer | Geo/operator classification (datacenter vs. end-user) is the core finding.          |
| Peer pseudonym           | Distinguishing "50 peers" from "one peer reconnecting 50 times".                    |
| First/last seen, counts  | Churn and stability — the difference between a healthy network and a shrinking one. |

**What is deliberately not collected**, having been considered and rejected:

- The full address or port of a connecting peer — the /24 answers every question
  the reports ask, so the rest is data held for no purpose.
- The peer's real public key — a pseudonym answers "distinct peers" equally
  well, and a rotating pseudonym answers it while making long-term tracking
  impossible. This is the single largest reduction in scope available and it
  costs the analysis almost nothing.
- Any private or non-public content. Only public, publisher-signed application
  update feeds are seeded.

**Is consent workable instead?** No. There is no channel on which to ask a
routing table entry for consent, no contact details are held, and a
consent-gated measurement would be biased by exactly the self-selection it is
trying to measure. This is not a case of avoiding an inconvenient consent
mechanism; there is no mechanism to avoid.

## 3. Balancing test

### Reasonable expectations

Participants have published an address to a public DHT whose entire operation
consists of other peers reading that address and contacting them. Being seen,
pinged and connected to by strangers is not an unexpected consequence — it is
the protocol working as designed, and every other peer does the same thing. Our
node's traffic is indistinguishable in kind from ordinary participation.

What a participant would _not_ expect is being tracked as an individual over
time, or having their household's subnet named on a public web page. Both are
specifically prevented (below).

### Nature of the data

No special categories (Art. 9), no criminal-offence data, no children's data
knowingly involved, no data revealing content, behaviour or communications. The
data is a network address and a count. Its sensitivity comes entirely from the
fact that an IP address can, _by a party holding subscriber records_, be linked
to a person — which is why the mitigations attack precisely that linkage.

### Possible impact on individuals

The realistic harms, and what stands between them and the data:

| Harm                                                   | Mitigation                                                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Being tracked across time as a persistent identity     | Public keys never stored; pseudonyms rotate monthly and the linking salt is destroyed. Cross-period linkage becomes impossible for everyone, us included.                                |
| Someone learning that a specific household uses an app | Full addresses of connecting peers never stored; small residential/mobile networks published only as a /16, city withheld.                                                               |
| Data leaking or being demanded from us                 | Very little exists to leak: 14-day and 72-hour retention, and old rows are unlinkable once their salt is gone.                                                                           |
| Function creep into surveillance                       | Enforced in the storage layer rather than promised in a comment — pseudonymisation and exclusion sit inside `db.mjs`'s repositories, so a future command cannot bypass them by omission. |
| Unwanted contact from our node                         | Exclusion list, honoured at the point of writing, purging what is already stored.                                                                                                        |

The residual impact on an individual is close to nil: what remains after
retention is a count attached to a network, with no stored means of connecting
it to a person.

### Interests on the other side

Suppressing the measurement entirely would mean the public claim of
decentralisation goes unchecked. The data that makes the measurement work is
data the participants themselves broadcast to every peer on the network.

### Conclusion

The interest is legitimate, the processing is necessary to it, and after the
mitigations the impact on individuals does not override it. **Art. 6(1)(f) is
available.** The conclusion depends on the mitigations, so it should be revisited
if any of them is weakened — in particular if raw public keys or full peer
addresses were ever stored, retention were extended materially, or the exclusion
mechanism stopped being enforced at the write path.

## Review

Reviewed on material change to what is collected, and otherwise annually.
Related: [`ropa.md`](ropa.md), [`dpia.md`](dpia.md),
[`../PRIVACY.md`](../PRIVACY.md).
