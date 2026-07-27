import process from 'bare-process';
import { openDb, exclusionsRepo, prefixOf, isPrivateIp } from '../db.mjs';

// Exclude a network from collection — the operational half of the GDPR Art. 21
// right to object, and the mechanism behind the opt-out promised in PRIVACY.md.
//
//   bare bin.mjs exclude add <ip | /24> [reason…]
//   bare bin.mjs exclude remove <ip | /24>
//   bare bin.mjs exclude list
//
// `add` does two things, and both matter: it purges everything already stored
// about the network, and it records the exclusion so future runs skip it. The
// skip is enforced inside nodesRepo/observationsRepo (see db.mjs), not in the
// individual collectors, so a command added later cannot forget to honour it.
//
// The unit is the /24, because that is the finest granularity anything here
// stores. Excluding a single address is not possible for observations (which
// only ever knew the /24) and would be false comfort for nodes, so an address
// argument is widened to its network and we say so.

const USAGE = `usage:
  exclude add <ip | /24> [reason…]   stop collecting a network, purge what's stored
  exclude remove <ip | /24>          lift an exclusion (does not restore data)
  exclude list                       show current exclusions`;

// Accept "1.2.3.4", "1.2.3", or "1.2.3.0/24" and reduce to the /24 key.
// Returns null for anything that isn't one of those.
function toPrefix(arg) {
  if (!arg) {
    return null;
  }
  const bare = String(arg).replace(/\/24$/, '');
  const parts = bare.split('.');
  const valid = (part) => /^\d{1,3}$/.test(part) && Number(part) <= 255;
  if (parts.length === 3 && parts.every(valid)) {
    return parts.join('.');
  }
  if (parts.length === 4 && parts.every(valid)) {
    return prefixOf(bare);
  }
  return null;
}

function listExclusions(exclusions) {
  const rows = exclusions.list();
  if (!rows.length) {
    console.log('no exclusions');
    return;
  }
  console.log(`${rows.length} excluded network(s):\n`);
  for (const row of rows) {
    const when = new Date(row.created_at).toISOString().slice(0, 10);
    const why = row.reason ? `  ${row.reason}` : '';
    console.log(`  ${(row.prefix24 + '.0/24').padEnd(20)} ${when}${why}`);
  }
}

function addExclusion({ exclusions, prefix, reason }) {
  exclusions.add({ prefix24: prefix, reason, at: Date.now() });
  const purged = exclusions.purge(prefix);
  const total = Object.values(purged).reduce((sum, num) => sum + num, 0);
  console.log(`excluded ${prefix}.0/24`);
  console.log(
    `purged ${total} existing row(s): ` +
      `nodes ${purged.nodes}, observations ${purged.observations}, ` +
      `geo ${purged.geo}, rpki ${purged.rpki}`
  );
  console.log(
    'takes effect immediately for new runs; a collector already running\n' +
      'reads the list at startup and will honour it on its next run.'
  );
}

export async function run(ctx) {
  const [, , action, target, ...reasonParts] = ctx.argv;
  if (!action) {
    console.error(USAGE);
    process.exit(1);
  }

  const db = openDb();
  const exclusions = exclusionsRepo(db);

  if (action === 'list') {
    listExclusions(exclusions);
    return;
  }
  if (action !== 'add' && action !== 'remove') {
    console.error(`unknown action '${action}'\n\n${USAGE}`);
    process.exit(1);
  }

  const prefix = toPrefix(target);
  if (!prefix) {
    console.error(`not an IPv4 address or /24: ${target ?? '(missing)'}\n`);
    console.error(USAGE);
    process.exit(1);
  }
  if (isPrivateIp(`${prefix}.1`)) {
    console.error(`${prefix}.0/24 is private/reserved and is never collected`);
    process.exit(1);
  }
  // Say plainly that we widened a host address, rather than letting someone
  // believe they excluded one machine.
  if (target.split('.').length === 4 && !target.endsWith('/24')) {
    console.log(`note: widened ${target} to its network ${prefix}.0/24`);
  }

  if (action === 'remove') {
    const gone = exclusions.remove(prefix);
    console.log(
      gone
        ? `removed exclusion for ${prefix}.0/24 (purged data is not restored)`
        : `${prefix}.0/24 was not excluded`
    );
    return;
  }
  addExclusion({ exclusions, prefix, reason: reasonParts.join(' ') || null });
}
