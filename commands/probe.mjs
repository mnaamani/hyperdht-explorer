import DHT from 'hyperdht'
import process from 'bare-process'
import { openDb } from '../db.mjs'

// Probe discovered nodes with a DHT PING to record whether they're currently
// reachable and how fast they respond. This is the only "interrogation" the
// DHT protocol allows (nodes expose no info about what they run or seed), but
// liveness + RTT sharpens the stability signal: a node seen across many
// sessions AND still answering pings is clearly dedicated infrastructure.

const PING_TIMEOUT = 3000
const CONCURRENCY = 40

export async function run(ctx) {
  const db = openDb()
  const stmtAlive = db.prepare(
    'UPDATE nodes SET alive = 1, rtt_ms = ?, last_ping = ? WHERE host = ? AND port = ?'
  )
  const stmtDead = db.prepare(
    'UPDATE nodes SET alive = 0, rtt_ms = NULL, last_ping = ? WHERE host = ? AND port = ?'
  )

  const targets = db.prepare('SELECT host, port FROM nodes ORDER BY last_seen DESC').all()
  console.log(
    `probe: pinging ${targets.length} node(s) (timeout ${PING_TIMEOUT}ms, ${CONCURRENCY} concurrent)\n`
  )

  if (targets.length === 0) {
    db.close()
    return
  }

  const dht = new DHT()
  await dht.ready()

  let alive = 0
  let dead = 0
  let done = 0
  const rtts = []

  async function probe(node) {
    const t0 = Date.now()
    try {
      await Promise.race([
        dht.ping({ host: node.host, port: node.port }),
        new Promise((_, reject) =>
          globalThis.setTimeout(() => reject(new Error('timeout')), PING_TIMEOUT)
        )
      ])
      const rtt = Date.now() - t0
      stmtAlive.run(rtt, Date.now(), node.host, node.port)
      rtts.push(rtt)
      alive++
    } catch {
      stmtDead.run(Date.now(), node.host, node.port)
      dead++
    }
    if (++done % 50 === 0) {
      console.log(`  ${done}/${targets.length}  (${alive} alive, ${dead} dead)`)
    }
  }

  // simple bounded-concurrency worker pool
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) await probe(targets[cursor++])
    })
  )

  rtts.sort((a, b) => a - b)
  const median = rtts.length ? rtts[rtts.length >> 1] : 0
  console.log(
    `\nprobe: done. ${alive} alive, ${dead} dead. median RTT ${median}ms (min ${rtts[0] ?? '-'}, max ${rtts[rtts.length - 1] ?? '-'})`
  )

  await dht.destroy()
  db.close()
}
