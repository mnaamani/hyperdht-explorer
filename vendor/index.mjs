import fs from 'bare-fs';
import path from 'bare-path';
import { publicDir } from '../paths.mjs';

// Third-party browser libraries, served from our own origin instead of a CDN.
//
// This is a data-protection measure, not a packaging preference. A <script src>
// pointing at unpkg.com or cdn.jsdelivr.net makes every visitor's browser
// disclose its IP address (and the page it is loading) to a third party we have
// no relationship with, before the visitor has done anything. Self-hosting
// removes that disclosure entirely; it also means the reports render with no
// internet access at all, which matches what ring.html and summary.html already
// did. See PRIVACY.md.
//
// The files are checked in rather than read from node_modules, because
// node_modules does not exist next to a standalone binary. `import.meta.asset`
// is what makes that work: bare-pack embeds each referenced file into the
// bundle and, at runtime, hands back a path to it (extracted to a temp dir for
// a standalone build, the repo path in dev). The specifiers must stay literal —
// the bundler finds them by static analysis, so they cannot be built up from
// variables.
//
// Versions are pinned by the matching devDependencies in package.json; refresh
// with `npm run vendor:sync` after bumping one.

const ASSETS = {
  'leaflet.js': import.meta.asset('./leaflet.js'),
  'leaflet.css': import.meta.asset('./leaflet.css'),
  'leaflet.markercluster.js': import.meta.asset('./leaflet.markercluster.js'),
  'MarkerCluster.css': import.meta.asset('./MarkerCluster.css'),
  'MarkerCluster.Default.css': import.meta.asset('./MarkerCluster.Default.css'),
  // leaflet.css asks for these by relative path for the layers control; they
  // must land in public/vendor/images/ or the control renders blank.
  'images/layers.png': import.meta.asset('./images/layers.png'),
  'images/layers-2x.png': import.meta.asset('./images/layers-2x.png'),
  'chart.umd.js': import.meta.asset('./chart.umd.js'),
  'd3.min.js': import.meta.asset('./d3.min.js'),
  // Licence texts, served next to the code they cover. MIT and BSD-2 require
  // the notice to accompany copies, and we hand a copy to every visitor:
  // Leaflet, Chart.js and D3 keep a banner through minification, but
  // markercluster's minified build has none and neither does any of the CSS.
  'licenses/leaflet.txt': import.meta.asset('./licenses/leaflet.txt'),
  'licenses/leaflet.markercluster.txt': import.meta.asset(
    './licenses/leaflet.markercluster.txt'
  ),
  'licenses/chart.js.txt': import.meta.asset('./licenses/chart.js.txt'),
  'licenses/d3.txt': import.meta.asset('./licenses/d3.txt')
};

// What each page needs. Named per library so a render command asks for what it
// uses rather than copying all 700 KB every time.
const BUNDLES = {
  leaflet: [
    'leaflet.js',
    'leaflet.css',
    'leaflet.markercluster.js',
    'MarkerCluster.css',
    'MarkerCluster.Default.css',
    'images/layers.png',
    'images/layers-2x.png',
    'licenses/leaflet.txt',
    'licenses/leaflet.markercluster.txt'
  ],
  chart: ['chart.umd.js', 'licenses/chart.js.txt'],
  d3: ['d3.min.js', 'licenses/d3.txt']
};

// Copy one asset into public/vendor/, skipping the write when the destination
// already matches by size — renders run on a cron every 15 minutes and there is
// no reason to rewrite 700 KB each time.
function copyAsset(name) {
  const source = new URL(ASSETS[name]);
  const dest = path.join(publicDir(), 'vendor', name);
  const { size } = fs.statSync(source);
  let existing = null;
  try {
    existing = fs.statSync(dest);
  } catch {
    existing = null;
  }
  if (existing && existing.size === size) {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(source));
}

// Place a bundle's files under public/vendor/. Call before writing a page that
// references them; pages link to them with the relative path `vendor/<name>`.
export function ensureVendor(bundle) {
  const names = BUNDLES[bundle];
  if (!names) {
    throw new Error(`unknown vendor bundle: ${bundle}`);
  }
  for (const name of names) {
    copyAsset(name);
  }
}
