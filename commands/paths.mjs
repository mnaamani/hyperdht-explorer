import { dataDir, dbPath, publicDir } from '../paths.mjs';

// Print the on-disk paths hyperdht-explorer will use. Handy for cron wrappers,
// debugging dev-vs-prod storage, and finding the generated HTML pages. bin.mjs
// has already resolved the data dir and exported it as HYPERDHT_EXPLORER_HOME,
// so paths.mjs (which reads that env) agrees with what every other command uses.

export function run(ctx) {
  console.log(`data:   ${ctx.dir ?? dataDir()}`);
  console.log(`db:     ${dbPath()}`);
  console.log(`public: ${publicDir()}`);
}
