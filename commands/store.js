import DHT from 'hyperdht'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import process from 'bare-process'

// Demo of hyperdht's BEP44-style record storage (put/get small signed values
// into the DHT). Two modes:
//
//   immutable (content-addressed):
//     bare bin.mjs store put  "<text>"        -> prints the hash
//     bare bin.mjs store get  <hash-hex>      -> fetches by hash
//
//   mutable (key-addressed, signed, updatable):
//     bare bin.mjs store mput "<text>" [seed-hex] [seq]  -> prints public key
//     bare bin.mjs store mget <publicKey-hex>            -> fetches latest
//
// Reminder: records are SOFT STATE — stored on the nodes closest to the key and
// expire in ~20 min unless republished. Values must fit in a UDP packet (~1KB).

export async function run(ctx) {
  const argv = ctx.argv
  const mode = argv[2]
  const a = argv[3]
  const b = argv[4]
  const c = argv[5]

  function usage() {
    console.error('usage:')
    console.error('  store.js put  "<text>"                 immutable put -> hash')
    console.error('  store.js get  <hash-hex>               immutable get')
    console.error('  store.js mput "<text>" [seed-hex] [seq]  mutable put -> public key')
    console.error('  store.js mget <publicKey-hex>          mutable get')
    process.exit(1)
  }

  if (!mode) usage()

  const dht = new DHT()
  await dht.ready()

  try {
    if (mode === 'put') {
      if (!a) usage()
      const value = b4a.from(a)
      const { hash, closestNodes } = await dht.immutablePut(value)
      console.log('stored immutable value (%d bytes)', value.byteLength)
      console.log('hash   :', b4a.toString(hash, 'hex'))
      console.log('stored on', closestNodes.length, 'closest node(s)')
      console.log('\nread back with:  bare bin.mjs store get', b4a.toString(hash, 'hex'))
    } else if (mode === 'get') {
      if (!a) usage()
      const node = await dht.immutableGet(b4a.from(a, 'hex'))
      if (!node) console.log('not found (may have expired, or never stored)')
      else {
        console.log(
          'value  :',
          b4a.toString(node.value),
          '\nfrom   :',
          node.from.host + ':' + node.from.port
        )
      }
    } else if (mode === 'mput') {
      if (!a) usage()
      const seed = b ? b4a.from(b, 'hex') : crypto.randomBytes(32)
      const keyPair = crypto.keyPair(seed)
      const value = b4a.from(a)
      const seq = c ? Number(c) : Date.now() // monotonically increasing by default
      await dht.mutablePut(keyPair, value, { seq })
      console.log('stored mutable value (%d bytes) at seq %d', value.byteLength, seq)
      console.log('publicKey :', b4a.toString(keyPair.publicKey, 'hex'))
      console.log('seed      :', b4a.toString(seed, 'hex'), '(reuse to update this record)')
      console.log(
        '\nread back with:  bare bin.mjs store mget',
        b4a.toString(keyPair.publicKey, 'hex')
      )
    } else if (mode === 'mget') {
      if (!a) usage()
      const res = await dht.mutableGet(b4a.from(a, 'hex'), { latest: true })
      if (!res) console.log('not found (may have expired, or never stored)')
      else console.log('value :', b4a.toString(res.value), '\nseq   :', res.seq)
    } else {
      usage()
    }
  } catch (err) {
    console.error('error:', err.message)
  }

  await dht.destroy()
}
