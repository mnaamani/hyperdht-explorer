import process from 'bare-process'
import fetch from 'bare-fetch'
import { openDb, prefixOf } from './db.js'

// Enrich the networks hosting DHT nodes with RPKI route-origin validity, from
// RIPEstat. For each /24 we find its real announced (covering) prefix + origin
// ASN via network-info, then check rpki-validation -> valid | invalid | unknown.
// Results cached in the `rpki` table.
//
//   npx bare rpki.js [--refresh]
//
// Rate-limit compliance (per RIPEstat docs):
//   - every request carries  sourceapp=dht-explorer  (app identification)
//   - strictly sequential (concurrency 1; the cap is 8/IP) with spacing between calls
//   - covering prefixes are reused across the /24s they contain to minimise calls
//   - results cached and only refetched weekly (well under the 1000/day soft limit)

const SOURCEAPP = 'dht-explorer'
const RIPE = 'https://stat.ripe.net/data'
const SPACING = 300 // ms between requests
const MAX_AGE = 7 * 24 * 3600 * 1000

const argv = globalThis.Bare?.argv ?? process.argv
const REFRESH = argv.includes('--refresh')
const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms))

async function ripe(path) {
  const sep = path.includes('?') ? '&' : '?'
  const url = `${RIPE}/${path}${sep}sourceapp=${SOURCEAPP}`
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url)
    if (res.status === 429) {
      // rate limited — back off and retry
      const wait = Number(res.headers.get('retry-after') || '5') * 1000
      console.log(`  rate limited, waiting ${wait / 1000}s…`)
      await sleep(wait)
      continue
    }
    await sleep(SPACING)
    return res.json()
  }
  throw new Error('rate limited repeatedly')
}

// IPv4 helpers for "is this /24 inside a covering prefix" reuse
const ipToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) >>> 0) + +o, 0) >>> 0
function inCidr(prefix24, cidr) {
  const [base, bitsStr] = cidr.split('/')
  const bits = Number(bitsStr)
  if (bits > 24) return false // covering prefix more specific than /24 can't contain it
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipToInt(prefix24 + '.0') & mask) >>> 0 === (ipToInt(base) & mask) >>> 0
}

const db = openDb()
const upsert = db.prepare(`
  INSERT OR REPLACE INTO rpki (prefix24, covering, origin_asn, status, fetched_at)
  VALUES (?, ?, ?, ?, ?)
`)

// /24 -> a representative real IP (an actual node host in that subnet)
const reps = new Map()
for (const { host } of db.prepare('SELECT host FROM nodes').all()) {
  const p = prefixOf(host)
  if (!reps.has(p)) reps.set(p, host)
}

// skip /24s already cached fresh
const fresh = new Set()
if (!REFRESH) {
  for (const r of db.prepare('SELECT prefix24, fetched_at FROM rpki').all()) {
    if (Date.now() - r.fetched_at < MAX_AGE) fresh.add(r.prefix24)
  }
}

const todo = [...reps.keys()].filter((p) => !fresh.has(p)).sort()
console.log(`rpki: ${todo.length} /24(s) to check (${fresh.size} cached)\n`)

// known covering prefixes from this run, so /24s in the same announced block
// reuse one network-info + rpki-validation lookup
const covers = [] // { cidr, asn, status }
const counts = { valid: 0, invalid: 0, unknown: 0, unannounced: 0 }

for (const p24 of todo) {
  try {
    const hit = covers.find((c) => inCidr(p24, c.cidr))
    if (hit) {
      upsert.run(p24, hit.cidr, hit.asn, hit.status, Date.now())
      counts[hit.status]++
      continue
    }

    const ni = await ripe(`network-info/data.json?resource=${reps.get(p24)}`)
    const cidr = ni?.data?.prefix || null
    const asn = Number((ni?.data?.asns || [])[0])
    if (!cidr || !asn) {
      upsert.run(p24, null, null, 'unannounced', Date.now())
      counts.unannounced++
      console.log(`  ${p24.padEnd(16)} unannounced`)
      continue
    }

    const rv = await ripe(`rpki-validation/data.json?resource=AS${asn}&prefix=${encodeURIComponent(cidr)}`)
    const status = rv?.data?.status || 'unknown'
    covers.push({ cidr, asn, status })
    upsert.run(p24, cidr, asn, status, Date.now())
    counts[status] = (counts[status] || 0) + 1
    console.log(`  ${p24.padEnd(16)} ${cidr.padEnd(20)} AS${asn} → ${status}`)
  } catch (err) {
    console.error(`  ${p24}: ${err.message}`)
  }
}

console.log(
  `\nrpki: done. valid ${counts.valid}, invalid ${counts.invalid}, unknown ${counts.unknown}, unannounced ${counts.unannounced}`
)
db.close()
process.exit(0)
