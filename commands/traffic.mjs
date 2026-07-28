import DHT from 'hyperdht';
import constants from 'hyperdht/lib/constants.js';
import sodium from 'sodium-universal';
import {
  openDb,
  trafficRepo,
  exclusionsRepo,
  prefixOf,
  fingerprintOf,
  newFingerprintSecret,
  TRAFFIC_COMMAND_COLUMNS,
  TRAFFIC_COMMAND_CLASS
} from '../db.mjs';

// Measure how much RPC load an ordinary DHT node actually carries — the one
// health dimension that crawling can't reach.
//
//   bare bin.mjs traffic [--minutes N] [--report-every N] [--force-persistent]
//
// A crawl only ever counts how many nodes EXIST. It cannot tell whether anyone
// is using them. That answer only arrives from the other direction: once a node
// has been stable long enough to be considered routable, other peers start
// routing their work through it, and every request they send lands in
// `onrequest`. Counting those requests measures demand, not just supply.
//
// ---------------------------------------------------------------------------
// COUNT-ONLY — the boundary this command exists to hold
// ---------------------------------------------------------------------------
// Each inbound request carries two separable things:
//
//   the envelope  — which command it was, and when.
//   the contents  — `req.target` (WHICH topic/record is being looked up or
//                   announced), and for ANNOUNCE the announcer's public key
//                   and addresses.
//
// The contents are a deanonymisation primitive: a node in the right region of
// the keyspace, recording targets, builds a topic -> announcer-set index. The
// targets are hashes, so it only works against topics you already hold a
// candidate key for — but that is precisely enough to answer "is this person
// running that app", which is the question this project exists NOT to answer.
// See the health-not-deanonymisation posture in CLAUDE.md and PRIVACY.md.
//
// Everything here is therefore a TALLY. Three of them are cardinalities, which
// is the only place this gets subtle:
//
//   requests   — per command. Nothing but `req.command`.
//   sources    — how many distinct /24s sent us work. A Set of prefixes, in
//                memory, reported as `.size` and dropped at the end.
//   targets    — how many distinct things were asked for. Also a Set — but of
//                `fingerprintOf(req.target)` under a secret that is random per
//                run and never leaves memory, NOT of the targets. See the long
//                comment on fingerprintOf in db.mjs: a set of real targets is
//                precisely the index we refuse to build, and would sit in RAM
//                for the whole run waiting for a core dump or a stray
//                `console.log(req)`. A set of fingerprints answers "how many
//                different" and nothing else — it cannot be tested against a
//                candidate topic without the secret, and the secret is zeroed
//                when the run ends.
//
// `req.value` (record payloads, announce signatures) is never read at all.
// Nothing per-peer and nothing per-target is written to the database: only
// counts. Networks on the exclusion list are skipped entirely rather than
// counted anonymously.
//
// Only APPLICATION targets are counted. `find_node` carries a target too, but
// those are random-walk probe points — near enough all distinct by
// construction, so including them would swamp the signal with a number that
// just tracks how many find_nodes arrived. What "target diversity" is for is
// the application layer: a few popular topics hammered looks very different
// from a long tail, and requests-per-target is what tells them apart.
// ---------------------------------------------------------------------------
//
// Becoming routable takes ~20 minutes of stability (dht-rpc's STABLE_TICKS) plus
// a NAT check, so a useful run is long: default 60 minutes, of which the first
// ~20 are warm-up. Counters RESET at the moment the node goes persistent, so the
// recorded window is the routable window and the rate is not diluted by the
// warm-up. `--force-persistent` runs the NAT check at bootstrap instead of
// waiting; it cannot make a firewalled node routable (dht-rpc probes for real
// and bails), it only skips the wait on a host that would have passed anyway.
//
// `--minutes 0` runs until a signal instead (real on Linux, inert on macOS —
// see the signal note in CLAUDE.md), writing the row from the shutdown hook.
//
// Run it on its own schedule — ops/scheduled-traffic.sh — never inside the
// 15-min scan cycle.

// dht-rpc's internal routing vocabulary, indexed by command number
// (dht-rpc/lib/commands.js: PING=0, PING_NAT=1, FIND_NODE=2, DOWN_HINT=3,
// DELAYED_PING=4). Not exported by hyperdht, and dht-rpc is a transitive
// dependency we don't import from, so the names are mirrored here; anything
// outside the list falls through to the `unknown` tally rather than being
// silently dropped.
const INTERNAL_BY_NUMBER = [
  'ping',
  'ping_nat',
  'find_node',
  'down_hint',
  'delayed_ping'
];

// hyperdht's application vocabulary, derived from the library's own constants
// so it cannot drift as hyperdht evolves.
const EXTERNAL_BY_NUMBER = [];
for (const [name, num] of Object.entries(constants.COMMANDS)) {
  EXTERNAL_BY_NUMBER[num] = name.toLowerCase();
}

const DEFAULT_MINUTES = 60;
const DEFAULT_REPORT_EVERY = 5;
// dht-rpc: STABLE_TICKS (240) * TICK_INTERVAL (5s). Reported, not enforced.
const WARMUP_MINUTES = 20;

function zeroedCounts() {
  return Object.fromEntries(TRAFFIC_COMMAND_COLUMNS.map((name) => [name, 0]));
}

function flagNum(argv, name, fallback) {
  const at = argv.indexOf(name);
  if (at === -1) {
    return fallback;
  }
  const value = Number(argv[at + 1]);
  return Number.isFinite(value) ? value : fallback;
}

export async function run(ctx) {
  const argv = ctx.argv;
  const minutes = flagNum(argv, '--minutes', DEFAULT_MINUTES);
  const reportEvery = flagNum(argv, '--report-every', DEFAULT_REPORT_EVERY);
  const forcePersistent = argv.includes('--force-persistent');

  const db = openDb();
  const excluded = exclusionsRepo(db).prefixes();
  const traffic = trafficRepo(db);

  // --- the counters (all of them) ---------------------------------------------
  // `secret` keys the target fingerprints. Random, process-only, zeroed at the
  // end — see fingerprintOf in db.mjs. It is deliberately NOT regenerated by
  // resetWindow: fingerprints only need to be comparable with each other, and
  // rotating mid-run would double-count a target seen on both sides of the
  // reset. One secret per process is the whole lifetime it needs.
  const secret = newFingerprintSecret();
  let counts = zeroedCounts();
  let requests = 0;
  let unknown = 0;
  let sources = new Set();
  let targets = new Set();
  let targetRequests = 0;
  let windowStart = Date.now();
  let persistent = false;
  let wasEphemeralAgain = false;
  let reportTimer = null;
  let finished = false;

  function resetWindow(at) {
    counts = zeroedCounts();
    requests = 0;
    unknown = 0;
    sources = new Set();
    targets = new Set();
    targetRequests = 0;
    windowStart = at;
  }

  // Tallies only. `req.value` is never referenced; `req.target` is read solely
  // to fingerprint it (one-way, run-scoped secret) so distinctness can be
  // counted — the target itself is not kept, here or anywhere downstream.
  function countRequest(req) {
    const prefix = prefixOf(req.from.host);
    if (excluded.has(prefix)) {
      return;
    }
    sources.add(prefix);
    requests++;
    const byNumber = req.internal ? INTERNAL_BY_NUMBER : EXTERNAL_BY_NUMBER;
    const name = byNumber[req.command];
    if (name === undefined || !(name in counts)) {
      unknown++;
      return;
    }
    counts[name]++;
    // Application targets only — find_node's are random-walk probe points and
    // would drown the signal (see the header comment).
    if (!req.internal && req.target) {
      targets.add(fingerprintOf({ value: req.target, secret }));
      targetRequests++;
    }
  }

  // --- the node ----------------------------------------------------------------
  // `ephemeral: false` sets dht-rpc's _forcePersistent, which runs the firewall /
  // NAT check during bootstrap rather than after the stability timer. It does not
  // override the result: _updateNetworkState still probes and bails if we are
  // firewalled, so this can't push an unreachable node into other routing tables.
  const dht = new DHT(forcePersistent ? { ephemeral: false } : {});

  // Wrap the IO layer's request callback rather than dht.onrequest: hyperdht's
  // onrequest only sees the application commands, because dht-rpc answers PING /
  // FIND_NODE / DOWN_HINT internally before delegating. io.onrequest is the one
  // point every inbound request passes through, and it is a plain instance
  // property (assigned in the IO constructor from an already-bound
  // dht._onrequest), so wrapping it here is safe — replacing dht._onrequest
  // instead would not work, since IO captured the bound original.
  const inner = dht.io.onrequest;
  dht.io.onrequest = (req, external) => {
    countRequest(req);
    inner(req, external);
  };

  dht.on('persistent', () => {
    if (persistent) {
      return;
    }
    persistent = true;
    // Drop the warm-up tallies: until now we weren't routable, so the handful of
    // requests that arrived say nothing about the load a real node carries.
    resetWindow(Date.now());
    console.log(
      `traffic: now routable (non-ephemeral) — measurement window starts here`
    );
  });
  dht.on('ephemeral', () => {
    // A suspend/wake (laptop lid, VM pause) drops us back to ephemeral. Keep
    // counting rather than discarding the window, but record that the window is
    // no longer wholly routable so the row isn't read as a clean measurement.
    wasEphemeralAgain = true;
    console.log('traffic: dropped back to ephemeral (network change?)');
  });

  console.log(
    `traffic: counting inbound requests for ${minutes || '∞'} minute(s)` +
      ` — count-only; targets are counted for distinctness, never stored.`
  );
  console.log(
    forcePersistent
      ? 'traffic: --force-persistent — NAT check runs at bootstrap.'
      : `traffic: expect ~${WARMUP_MINUTES}m of warm-up before we become routable.`
  );

  await dht.ready();
  if (!persistent && dht.ephemeral === false) {
    persistent = true;
    resetWindow(Date.now());
  }
  console.log(
    `traffic: ready · firewalled: ${dht.firewalled ? 'yes' : 'no'}` +
      ` · routable: ${persistent ? 'yes' : 'not yet'}\n`
  );

  // --- periodic progress -------------------------------------------------------
  // Self-rescheduling timeout (never setInterval): a tick can't stack on itself
  // and re-arms only while the run is still going.
  function tick() {
    if (finished) {
      return;
    }
    const elapsedMin = (Date.now() - windowStart) / 60_000;
    const rate = elapsedMin > 0 ? requests / elapsedMin : 0;
    const top = Object.entries(counts)
      .filter(([, value]) => value > 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([name, value]) => `${name} ${value}`)
      .join(' · ');
    console.log(
      `  +${elapsedMin.toFixed(0).padStart(2)}m ` +
        `${persistent ? 'routable ' : 'warming  '}` +
        `${requests} req (${rate.toFixed(1)}/min) · ` +
        `${sources.size} network(s) · ${targets.size} target(s)` +
        `${top ? ' · ' + top : ''}`
    );
    reportTimer = globalThis.setTimeout(tick, reportEvery * 60_000);
  }
  if (reportEvery > 0) {
    reportTimer = globalThis.setTimeout(tick, reportEvery * 60_000);
  }

  // --- finish ------------------------------------------------------------------
  function writeRow() {
    if (finished) {
      return;
    }
    finished = true;
    if (reportTimer) {
      globalThis.clearTimeout(reportTimer);
      reportTimer = null;
    }
    const durationS = Math.round((Date.now() - windowStart) / 1000);
    const perMin = durationS > 0 ? (requests / durationS) * 60 : 0;

    console.log('\n=== inbound request load ===');
    console.log(
      `window     : ${(durationS / 60).toFixed(1)} min` +
        `${persistent ? '' : ' (never became routable)'}` +
        `${wasEphemeralAgain ? ' (dropped to ephemeral part-way)' : ''}`
    );
    console.log(`requests   : ${requests}  (${perMin.toFixed(1)}/min)`);
    console.log(`networks   : ${sources.size} distinct /24s`);
    // Requests-per-target is the diversity read: ~1 means every application
    // request was for something different (a long tail), high means a handful
    // of popular topics being asked for over and over.
    const perTarget = targets.size ? targetRequests / targets.size : 0;
    console.log(
      `targets    : ${targets.size} distinct, from ${targetRequests} request(s)` +
        `${targets.size ? ` — ${perTarget.toFixed(1)} req/target` : ''}`
    );
    for (const [name, value] of Object.entries(counts)) {
      if (value > 0) {
        const cls = TRAFFIC_COMMAND_CLASS.get(name);
        console.log(
          `  ${name.padEnd(16)} ${String(value).padStart(7)}  ${cls}`
        );
      }
    }
    if (unknown > 0) {
      console.log(`  ${'(unknown)'.padEnd(16)} ${String(unknown).padStart(7)}`);
    }
    if (!persistent) {
      console.log(
        '\nnote: this node never became routable, so ~zero inbound work is\n' +
          '      expected. That is a property of this host (firewall / NAT),\n' +
          '      not of the DHT. Pages plot only routable runs.'
      );
    }

    traffic.insert({
      ts: windowStart,
      durationS,
      persistent: persistent && !wasEphemeralAgain,
      firewalled: dht.firewalled,
      requests,
      sources: sources.size,
      targets: targets.size,
      targetRequests,
      unknown,
      counts
    });
    db.close();

    // Only the sizes were ever wanted. Drop the fingerprints and destroy the
    // secret that made them, so what is left in the process is the same as what
    // is left on disk: numbers.
    targets = new Set();
    sources = new Set();
    sodium.sodium_memzero(secret);
  }

  await new Promise((resolve) => {
    ctx.onShutdown(async () => {
      writeRow();
      await dht.destroy();
      resolve();
    });
    if (minutes > 0) {
      globalThis.setTimeout(resolve, minutes * 60_000);
    }
  });

  if (!finished) {
    writeRow();
    await dht.destroy();
  }
}
