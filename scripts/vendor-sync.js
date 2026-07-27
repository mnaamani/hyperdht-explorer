// Refresh vendor/ from the pinned devDependencies. CommonJS, run under Node
// (`npm run vendor:sync`) — this is build tooling, not app code.
//
// The browser libraries are checked in rather than pulled from a CDN at page
// load (a CDN would disclose every visitor's IP to a third party) and rather
// than read from node_modules at runtime (which does not exist next to a
// standalone binary). This script is the seam between those two facts: bump the
// devDependency, run it, commit the result.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');

// [source in node_modules, destination in vendor/]
const FILES = [
  ['leaflet/dist/leaflet.js', 'leaflet.js'],
  ['leaflet/dist/leaflet.css', 'leaflet.css'],
  ['leaflet/dist/images/layers.png', 'images/layers.png'],
  ['leaflet/dist/images/layers-2x.png', 'images/layers-2x.png'],
  [
    'leaflet.markercluster/dist/leaflet.markercluster.js',
    'leaflet.markercluster.js'
  ],
  ['leaflet.markercluster/dist/MarkerCluster.css', 'MarkerCluster.css'],
  [
    'leaflet.markercluster/dist/MarkerCluster.Default.css',
    'MarkerCluster.Default.css'
  ],
  ['chart.js/dist/chart.umd.js', 'chart.umd.js'],
  ['d3/dist/d3.min.js', 'd3.min.js']
];

// The npm packages the files above come from, deduped. scripts/licenses.js
// reads this so the attribution file can't drift from what is actually
// vendored — these are devDependencies, so they do not appear in the
// production dependency tree even though they ARE redistributed.
const PACKAGES = [...new Set(FILES.map(([from]) => from.split('/')[0]))];

module.exports = { FILES, PACKAGES };

// Filenames these four projects use for their licence text.
const LICENSE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'MIT-LICENCE.txt',
  'MIT-LICENSE.txt'
];

// Copy each vendored package's licence text to vendor/licenses/<pkg>.txt.
//
// This is not belt-and-braces. MIT and BSD-2 require the notice to accompany
// copies of the software, and we hand copies to every visitor. Leaflet,
// Chart.js and D3 keep a banner through minification, but markercluster's
// minified build has none and neither does any of the CSS — so without these
// files, the copies we serve carry no notice at all.
function syncLicenses() {
  const dir = path.join(VENDOR, 'licenses');
  fs.mkdirSync(dir, { recursive: true });
  for (const pkg of PACKAGES) {
    const base = path.join(ROOT, 'node_modules', pkg);
    const found = LICENSE_FILES.find((name) =>
      fs.existsSync(path.join(base, name))
    );
    if (!found) {
      console.log(`${pkg.padEnd(28)} !! no licence file found`);
      continue;
    }
    fs.copyFileSync(path.join(base, found), path.join(dir, `${pkg}.txt`));
    console.log(`licenses/${pkg}.txt`.padEnd(28) + `      <- ${pkg}/${found}`);
  }
}

// Only copy when run directly (`npm run vendor:sync`), not when required.
if (require.main === module) {
  for (const [from, to] of FILES) {
    const source = path.join(ROOT, 'node_modules', from);
    const dest = path.join(VENDOR, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    const { size } = fs.statSync(dest);
    console.log(`${to.padEnd(28)} ${(size / 1024).toFixed(0)} KB  <- ${from}`);
  }
  syncLicenses();
  console.log(`\n${FILES.length} file(s) + licences refreshed in vendor/`);
}
