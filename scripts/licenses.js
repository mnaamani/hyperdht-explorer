// Generate THIRD-PARTY-NOTICES.md. CommonJS, run under Node
// (`npm run licenses`) — build tooling, not app code.
//
// Why this file exists: MIT, BSD-2-Clause and ISC all require the copyright
// notice AND the licence text to travel with redistributions, in source or
// binary form. We redistribute other people's code two ways:
//
//   1. vendor/ — Leaflet, markercluster, Chart.js and D3 are checked into the
//      repo and served verbatim from the published site. Some keep a banner
//      through minification (Leaflet, Chart.js, D3); markercluster's minified
//      build and every vendored .css file carry nothing at all.
//   2. The standalone binary — `bare-build` bundles the whole production
//      dependency tree into one executable. That obligation predates the
//      vendored libraries; shipping a binary IS distribution.
//
// Generated rather than hand-written so it cannot rot: re-run after changing
// dependencies. The project's own licence (Apache-2.0, ./LICENSE) is unchanged
// by any of this — this file is about everyone else's.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PACKAGES: VENDORED } = require('./vendor-sync.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');

// Filenames projects actually use, in rough order of likelihood.
const LICENSE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'MIT-LICENSE.txt',
  'MIT-LICENCE.txt',
  'COPYING'
];

// Every package reachable from the production dependency tree — i.e. what ends
// up inside the standalone binary. devDependencies are excluded, which is why
// the vendored libraries are added separately.
function productionPackages() {
  const json = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const names = new Set();
  (function walk(node) {
    for (const [name, child] of Object.entries(node.dependencies || {})) {
      names.add(name);
      walk(child);
    }
  })(JSON.parse(json));
  return names;
}

function readManifest(name) {
  const file = path.join(ROOT, 'node_modules', name, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readLicenseText(name) {
  const dir = path.join(ROOT, 'node_modules', name);
  for (const file of LICENSE_FILES) {
    try {
      return fs.readFileSync(path.join(dir, file), 'utf8').trim();
    } catch {
      continue;
    }
  }
  return null;
}

function spdxOf(manifest) {
  if (!manifest) {
    return 'UNKNOWN';
  }
  if (typeof manifest.license === 'string') {
    return manifest.license;
  }
  return manifest.license?.type || 'UNKNOWN';
}

// `npm ls` reports alternates and optional deps it never installed (a
// react-native shim, a pure-JS sodium fallback). Nothing that is absent from
// disk can be inside the binary, so claiming to redistribute it would be
// wrong in the opposite direction. Skipped, and reported at the end.
const skipped = [];

function collect(names) {
  const entries = [];
  for (const name of [...names].sort()) {
    const manifest = readManifest(name);
    if (!manifest) {
      skipped.push(name);
      continue;
    }
    entries.push({
      name,
      version: manifest.version || '?',
      license: spdxOf(manifest),
      homepage: manifest.homepage || manifest.repository?.url || null,
      text: readLicenseText(name)
    });
  }
  return entries;
}

function packageLine(entry) {
  const where = entry.homepage
    ? ` · ${entry.homepage.replace(/^git\+/, '').replace(/\.git$/, '')}`
    : '';
  return `- **${entry.name}** ${entry.version} — ${entry.license}${where}`;
}

// The Apache-2.0 text is identical across 90-odd packages; printing it 90 times
// would bury the notices it is meant to surface. Each distinct text appears
// once, listing every package it covers, which satisfies the same requirement
// and stays readable.
function renderLicenseTexts(entries) {
  const byText = new Map();
  for (const entry of entries) {
    if (!entry.text) {
      continue;
    }
    const key = entry.text.replace(/\s+/g, ' ').trim();
    if (!byText.has(key)) {
      byText.set(key, { text: entry.text, packages: [] });
    }
    byText.get(key).packages.push(`${entry.name} ${entry.version}`);
  }
  const blocks = [...byText.values()]
    .sort((left, right) => right.packages.length - left.packages.length)
    .map((group, index) => {
      const quoted = group.text
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
      return (
        `### Text ${index + 1} — applies to ${group.packages.length} ` +
        `package(s)\n\n${group.packages.map((pkg) => `- ${pkg}`).join('\n')}\n\n` +
        `${quoted}\n`
      );
    });

  const noText = entries.filter((entry) => !entry.text);
  if (noText.length) {
    blocks.push(
      `### Packages shipping no licence file\n\n` +
        `These declare a licence in \`package.json\` but publish no licence ` +
        `text. The SPDX identifier is the licence; the canonical text is the ` +
        `standard text for that identifier.\n\n` +
        noText.map((entry) => packageLine(entry)).join('\n') +
        '\n'
    );
  }
  return blocks.join('\n');
}

function summarise(entries) {
  const tally = {};
  for (const entry of entries) {
    tally[entry.license] = (tally[entry.license] || 0) + 1;
  }
  return Object.entries(tally)
    .sort((left, right) => right[1] - left[1])
    .map(([license, count]) => `| ${license} | ${count} |`)
    .join('\n');
}

const vendored = collect(VENDORED);
const bundled = collect(
  [...productionPackages()].filter((name) => !VENDORED.includes(name))
);
const all = [...vendored, ...bundled];

const body = `# Third-party notices

hyperdht-explorer is licensed under the Apache License 2.0 — see
[LICENSE](LICENSE). It redistributes the third-party software listed below,
each under its own licence, reproduced here in full as those licences require.

This file is generated by \`npm run licenses\`. Re-run it after changing
dependencies or refreshing \`vendor/\`; do not edit it by hand.

| Licence | Packages |
| ------- | -------- |
${summarise(all)}

## Browser libraries redistributed in \`vendor/\`

These are checked into the repository, copied to \`public/vendor/\` at render
time and served to visitors from our own origin rather than a CDN. They are
also embedded in the standalone binary.

${vendored.map((entry) => packageLine(entry)).join('\n')}

## Bundled into the standalone binary

\`bare-build --standalone\` packs the production dependency tree into a single
executable, so distributing that binary distributes these packages too.

${bundled.map((entry) => packageLine(entry)).join('\n')}

## Licence texts

${renderLicenseTexts(all)}`;

fs.writeFileSync(OUT, body);
console.log(
  `licenses: wrote THIRD-PARTY-NOTICES.md — ` +
    `${vendored.length} vendored + ${bundled.length} bundled package(s)`
);
const missing = all.filter((entry) => !entry.text);
if (missing.length) {
  console.log(
    `licenses: ${missing.length} package(s) ship no licence file (SPDX id ` +
      `used instead): ${missing.map((entry) => entry.name).join(', ')}`
  );
}
if (skipped.length) {
  console.log(
    `licenses: ${skipped.length} package(s) in the tree but not installed, ` +
      `so not redistributed: ${skipped.join(', ')}`
  );
}
