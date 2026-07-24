import process from 'bare-process';
import fetch from 'bare-fetch';
import {
  openDb,
  nodesRepo,
  observationsRepo,
  geoRepo,
  prefixOf
} from '../db.mjs';

// Enrich discovered nodes with geo-location via ip-api.com's batch endpoint.
//
// We look up at most ONE representative IP per /24 subnet, skip any /24 already
// in the geo table, and batch up to 100 lookups per HTTP request. ip-api's free
// tier allows 15 batch requests/minute; we honour the X-Rl / X-Ttl headers and
// back off when the window is exhausted, so we stay within limits automatically.

// `mobile`, `proxy`, `hosting` classify networks (datacenter vs residential etc.)
const FIELDS =
  'status,message,country,countryCode,regionName,city,lat,lon,isp,org,as,mobile,proxy,hosting,query';
const ENDPOINT = `http://ip-api.com/batch?fields=${FIELDS}`;
const BATCH_SIZE = 100;

export async function run(ctx) {
  const argv = ctx.argv;
  const REFRESH = argv.includes('--refresh');

  const sleep = (ms) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, ms));

  const db = openDb();
  const nodes = nodesRepo(db);
  const observations = observationsRepo(db);
  const geo = geoRepo(db);

  // Skip /24s already fully enriched: successes that already have the classification
  // flags, plus cached failures. (Older success rows missing the flags get refetched
  // once to backfill them; --refresh forces everything.)
  const done = new Set();
  if (!REFRESH) {
    for (const row of geo.statusFlags()) {
      if (row.status !== 'success' || row.hosting !== null) {
        done.add(row.prefix);
      }
    }
  }
  const need = new Map(); // prefix -> representative IP to query
  // classify both crawled nodes AND observed (seed-and-listen) peers
  const hosts = new Set();
  for (const host of nodes.distinctHosts()) {
    hosts.add(host);
  }
  for (const host of observations.distinctHosts()) {
    hosts.add(host);
  }
  for (const host of hosts) {
    const prefix = prefixOf(host);
    if (done.has(prefix) || need.has(prefix)) {
      continue;
    }
    need.set(prefix, host);
  }

  const work = [...need.entries()]; // [prefix, ip][]
  console.log(
    `geo: ${work.length} /24 subnet(s) to look up (${done.size} already enriched)\n`
  );

  if (work.length === 0) {
    db.close();
    return;
  }

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < work.length; i += BATCH_SIZE) {
    const chunk = work.slice(i, i + BATCH_SIZE);
    const ips = chunk.map(([, ip]) => ip);

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ips)
      });
    } catch (err) {
      console.error(
        `batch ${i / BATCH_SIZE + 1} request failed: ${err.message}`
      );
      break;
    }

    if (res.status === 429) {
      const ttl = Number(res.headers.get('x-ttl') || '5');
      console.log(`rate limited, waiting ${ttl + 1}s...`);
      await sleep((ttl + 1) * 1000);
      i -= BATCH_SIZE; // retry this chunk
      continue;
    }

    // ip-api's free HTTP tier can answer 5xx / an HTML error page under load;
    // guard both the status and the parse so one bad batch doesn't throw out of
    // run() (skipping db.close()). Break keeps already-upserted batches.
    if (!res.ok) {
      console.error(`batch ${i / BATCH_SIZE + 1} failed: HTTP ${res.status}`);
      break;
    }
    let results;
    try {
      results = await res.json();
    } catch (err) {
      console.error(`batch ${i / BATCH_SIZE + 1} bad response: ${err.message}`);
      break;
    }
    const now = Date.now();
    for (let j = 0; j < chunk.length; j++) {
      const [prefix] = chunk[j];
      const result = results[j] || { status: 'fail', message: 'no result' };
      geo.upsert({
        prefix,
        status: result.status,
        country: result.country ?? null,
        countryCode: result.countryCode ?? null,
        region: result.regionName ?? null,
        city: result.city ?? null,
        lat: result.lat ?? null,
        lon: result.lon ?? null,
        isp: result.isp ?? null,
        org: result.org ?? null,
        asInfo: result.as ?? null,
        mobile: result.mobile ? 1 : 0,
        proxy: result.proxy ? 1 : 0,
        hosting: result.hosting ? 1 : 0,
        queriedAt: now
      });
      if (result.status === 'success') {
        ok++;
        let kind = 'residential';
        if (result.hosting) {
          kind = 'datacenter';
        } else if (result.mobile) {
          kind = 'mobile';
        } else if (result.proxy) {
          kind = 'proxy';
        }
        console.log(
          `  ${prefix.padEnd(16)} ${(result.city || '?') + ', ' + (result.country || '?')}  [${kind}] (${result.isp || ''})`
        );
      } else {
        fail++;
        console.log(
          `  ${prefix.padEnd(16)} FAILED: ${result.message || 'unknown'}`
        );
      }
    }

    // Respect the rate-limit window: pause if we've exhausted it.
    const remaining = Number(res.headers.get('x-rl') ?? '15');
    const ttl = Number(res.headers.get('x-ttl') ?? '0');
    if (remaining <= 0 && i + BATCH_SIZE < work.length) {
      console.log(`  (rate window used up, waiting ${ttl + 1}s)`);
      await sleep((ttl + 1) * 1000);
    }
  }

  console.log(`\ngeo: done. ${ok} located, ${fail} failed.`);
  db.close();
}
