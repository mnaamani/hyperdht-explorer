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

for (const [from, to] of FILES) {
  const source = path.join(ROOT, 'node_modules', from);
  const dest = path.join(VENDOR, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  const { size } = fs.statSync(dest);
  console.log(`${to.padEnd(28)} ${(size / 1024).toFixed(0)} KB  <- ${from}`);
}
console.log(`\n${FILES.length} file(s) refreshed in vendor/`);
