import DHT from 'hyperdht'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import idEnc from 'hypercore-id-encoding'
import process from 'bare-process'
import { openDb, prefixOf, hostKind, isPrivateIp } from './db.js'

// Seed-and-listen: announce ourselves under a PUBLIC topic (e.g. a Pear app's
// update feed) and record the peers that connect to us. This surfaces real,
// often NAT'd/ephemeral participants that a findNode crawl can never see —
// because we observe who *connects*, not who is merely in the routing table.
//
//   npx bare observe.js <pear://link | hypercore-key> [app-name] [--minutes N]
//
// HEALTH MONITORING ONLY. We record aggregate participation (addresses, counts,
// residential-vs-datacenter mix) to gauge network health — never to track or
// deanonymize individuals. Use only on public topics/feeds you may legitimately
// peer with; private rooms are not discoverable and out of scope.

const argv = globalThis.Bare?.argv ?? process.argv
const positional = argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = positional[0]
const appName = positional[1] || 'observed'
const mi = argv.indexOf('--minutes')
const MINUTES = mi !== -1 ? Number(argv[mi + 1]) : 10

if (!arg) {
  console.error('usage: npx bare observe.js <pear://link | hypercore-key> [app-name] [--minutes N]')
  process.exit(1)
}

let publicKey
try {
  publicKey = idEnc.decode(arg)
} catch (err) {
  console.error('bad key:', err.message)
  process.exit(1)
}
const topic = crypto.discoveryKey(publicKey)

const db = openDb()
const upsert = db.prepare(`
  INSERT INTO observations (public_key, host, port, app, first_seen, last_seen, count)
  VALUES (?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(public_key, host, port) DO UPDATE SET last_seen = excluded.last_seen, count = count + 1
`)

const dht = new DHT()
const keyPair = crypto.keyPair() // ephemeral identity for this observer session
const seen = new Set() // host:port connections seen this session

// participants (public keys) observed in PRIOR sessions for this app — lets us
// tell "returning" peers from brand-new ones. Re-observation is the meaningful
// liveness signal for NAT'd peers (pinging their transient address would not be).
const priorKeys = new Set(
  db
    .prepare('SELECT DISTINCT public_key FROM observations WHERE app = ?')
    .all(appName)
    .map((r) => r.public_key)
)
const sessionKeys = new Set()
let returning = 0
let fresh = 0

const server = dht.createServer((conn) => {
  conn.on('error', () => {})
  const record = () => {
    const host = conn.rawStream && conn.rawStream.remoteHost
    const port = conn.rawStream && conn.rawStream.remotePort
    if (!host || !port) return
    if (isPrivateIp(host)) return // skip LAN/loopback/reserved addresses
    const pk = b4a.toString(conn.remotePublicKey, 'hex')
    upsert.run(pk, host, port, appName, Date.now(), Date.now())
    const key = host + ':' + port
    if (seen.has(key)) return
    seen.add(key)
    let tag = ''
    if (!sessionKeys.has(pk)) {
      sessionKeys.add(pk)
      if (priorKeys.has(pk)) {
        returning++
        tag = 'returning'
      } else {
        fresh++
        tag = 'new'
      }
    }
    console.log(`+ peer ${(host + ':' + port).padEnd(21)} ${pk.slice(0, 12)}… ${tag}`)
  }
  // address is ready once the encrypted stream opens
  if (conn.rawStream && conn.rawStream.remoteHost) record()
  else conn.once('open', record)
  conn.end() // we don't serve the feed — just observe, then close politely
})

await dht.ready()
await server.listen(keyPair)
console.log('=== observe ===')
console.log('app          :', appName)
console.log('topic key    :', b4a.toString(publicKey, 'hex'))
console.log('discovery key:', b4a.toString(topic, 'hex'))
console.log(`announcing as a peer and listening for ~${MINUTES} min…\n`)

async function announce() {
  try {
    await dht.announce(topic, keyPair).finished()
  } catch {}
}
await announce()
const reAnnounce = globalThis.setInterval(announce, 9 * 60 * 1000) // refresh before the ~20-min TTL

function report() {
  const allTimeKeys = db
    .prepare('SELECT COUNT(DISTINCT public_key) AS n FROM observations WHERE app = ?')
    .get(appName).n
  const hosts = db
    .prepare('SELECT DISTINCT host FROM observations WHERE app = ?')
    .all(appName)
    .map((r) => r.host)
  const prefixes = new Set(hosts.map(prefixOf))
  // classify the /24s we already have geo for
  const geo = new Map(
    db
      .prepare("SELECT prefix, country, mobile, proxy, hosting FROM geo WHERE status = 'success'")
      .all()
      .map((g) => [g.prefix, g])
  )
  const kinds = {}
  let classified = 0
  for (const p of prefixes) {
    const g = geo.get(p)
    if (!g) continue
    classified++
    const k = hostKind(g)
    kinds[k] = (kinds[k] || 0) + 1
  }
  console.log(
    `\n=== this session: ${sessionKeys.size} distinct participant(s) — ${returning} returning, ${fresh} new (${seen.size} connection(s)) ===`
  )
  console.log(`all-time distinct participants for '${appName}': ${allTimeKeys}`)
  console.log(`${prefixes.size} distinct /24(s); ${classified} already geo-classified:`)
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${n}`)
  if (classified < prefixes.size)
    console.log(`run 'npm run geo' then 'npm run summary' to classify the rest (residential vs datacenter).`)
}

async function shutdown() {
  globalThis.clearInterval(reAnnounce)
  report()
  try {
    await dht.unannounce(topic, keyPair)
  } catch {}
  try {
    await server.close()
  } catch {}
  try {
    await dht.destroy()
  } catch {}
  try {
    db.close()
  } catch {}
  ;(globalThis.Bare?.exit ?? process.exit)(0)
}
globalThis.setTimeout(shutdown, MINUTES * 60 * 1000)
