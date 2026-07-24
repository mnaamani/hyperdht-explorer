import DHT from 'hyperdht';
import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import process from 'bare-process';
import constants from 'hyperdht/lib/constants.js';
import { openDb, storeProbesRepo } from '../db.mjs';

// Storage-reliability probe: measure how well the DHT actually STORES data — a
// dimension that pinging nodes can't reveal.
//
// hyperdht holds records for ~20 minutes (defaultMaxAge = 20*60*1000) before they
// expire unless refreshed. So a meaningful test must sample ACROSS that window: we
// put N immutable "canary" records, note which closest nodes accepted each, then
// re-poll those nodes at several checkpoints up to just past the TTL, yielding a
// decay curve that reveals the expiry cliff. Results go to store_probes and the
// timeline page.
//
//   bare bin.mjs storeprobe [--canaries N] [--checkpoints 0,5,10,15,20,22]
//
// Checkpoints are MINUTES since the put. The default spans hyperdht's 20-min TTL,
// so a full run takes ~22 min — schedule it on its own (not inside the 15-min scan
// cycle). Use small fractional checkpoints (e.g. 0,0.25,0.5) for a quick smoke test.

const IMMUTABLE_GET = constants.COMMANDS.IMMUTABLE_GET;
const RECORD_TTL_MIN = 20; // hyperdht defaultMaxAge
const REQ_TIMEOUT = 2000;

export async function run(ctx) {
  const argv = ctx.argv;
  const flagNum = (name, def) => {
    const i = argv.indexOf(name);
    return i !== -1 ? Number(argv[i + 1]) : def;
  };
  const flagStr = (name, def) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : def;
  };

  const CANARIES = flagNum('--canaries', 5);
  const checkpoints = flagStr('--checkpoints', '0,5,10,15,20,22')
    .split(',')
    .map(Number)
    .filter((num) => !Number.isNaN(num))
    .sort((a, b) => a - b);

  const sleep = (ms) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, ms));
  const timeout = (ms) =>
    new Promise((_, rej) =>
      globalThis.setTimeout(() => rej(new Error('timeout')), ms)
    );

  const dht = new DHT();
  await dht.ready();

  // How many of `nodes` currently serve `value` for `target` (direct IMMUTABLE_GET).
  async function countReplicas(nodes, target, value) {
    let count = 0;
    await Promise.all(
      nodes.map(async (node) => {
        try {
          const reply = await Promise.race([
            dht.request({ command: IMMUTABLE_GET, target, value: null }, node),
            timeout(REQ_TIMEOUT)
          ]);
          if (reply && reply.value && b4a.equals(reply.value, value)) {
            count++;
          }
        } catch {}
      })
    );
    return count;
  }

  console.log(
    `storeprobe: ${CANARIES} canaries, checkpoints (min): ${checkpoints.join(', ')} — TTL ~${RECORD_TTL_MIN}m\n`
  );

  // put the canaries
  const canaries = [];
  let putOk = 0;
  for (let i = 0; i < CANARIES; i++) {
    const value = crypto.randomBytes(48);
    try {
      const { hash, closestNodes } = await dht.immutablePut(value);
      putOk++;
      canaries.push({ value, target: hash, nodes: closestNodes });
      console.log(
        `  put ${b4a.toString(hash, 'hex').slice(0, 16)}… on ${closestNodes.length} node(s)`
      );
    } catch (err) {
      canaries.push({ value, target: null, nodes: [] });
      console.log(`  put failed: ${err.message}`);
    }
  }
  const live = canaries.filter((canary) => canary.target);
  const t0 = Date.now();

  // network retrievability right after put
  let getOk = 0;
  for (const canary of live) {
    if (await dht.immutableGet(canary.target).catch(() => null)) {
      getOk++;
    }
  }

  // walk the checkpoints, measuring avg surviving replicas at each
  const decay = [];
  for (const minute of checkpoints) {
    const due = t0 + minute * 60_000;
    const wait = due - Date.now();
    if (wait > 0) {
      console.log(`  …waiting until +${minute}m`);
      await sleep(wait);
    }
    let total = 0;
    for (const canary of live) {
      total += await countReplicas(canary.nodes, canary.target, canary.value);
    }
    const avg = live.length ? total / live.length : 0;
    decay.push({ m: minute, replicas: Math.round(avg * 100) / 100 });
    console.log(
      `  +${String(minute).padStart(2)}m  avg replicas: ${avg.toFixed(2)}`
    );
  }

  const replicasInitial = decay.length ? decay[0].replicas : 0;
  const replicasAfter = decay.length ? decay[decay.length - 1].replicas : 0;
  const persistence = replicasInitial ? replicasAfter / replicasInitial : 0;

  console.log('\n=== storage health ===');
  console.log(`puts ok         : ${putOk}/${CANARIES}`);
  console.log(`get retrievable : ${getOk}/${live.length}`);
  console.log(`replicas t=0    : ${replicasInitial.toFixed(2)}`);
  console.log(
    `replicas +${checkpoints[checkpoints.length - 1]}m : ${replicasAfter.toFixed(2)}`
  );
  console.log(
    `persistence     : ${(persistence * 100).toFixed(0)}% (survived the TTL window)`
  );

  const db = openDb();
  storeProbesRepo(db).insert({
    ts: t0,
    canaries: CANARIES,
    putOk,
    getOk,
    replicasInitial,
    replicasAfter,
    persistence,
    delayS: Math.round(checkpoints[checkpoints.length - 1] * 60),
    decay: JSON.stringify(decay)
  });
  db.close();

  await dht.destroy();
}
