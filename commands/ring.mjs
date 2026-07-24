import process from 'bare-process';
import fs from 'bare-fs';
import { openDb } from '../db.mjs';
import { htmlPath, ensureDirs } from '../paths.mjs';

// Render the discovered nodes onto a circular projection of the 256-bit Kademlia
// ID space ("the ring"). Each node is placed by the high bits of its id; dot size
// encodes encounter frequency (sightings / seen_count) and colour encodes how many
// crawl sessions it has appeared in. Seeders get a magenta highlight ring.
//
// IMPORTANT: Kademlia uses an XOR distance metric and is really a binary trie, NOT
// a ring. The circle here is only a projection of the id integer onto an angle, so
// it shows id-space DISTRIBUTION + popularity — adjacency on the circle does NOT
// mean routing closeness. Output is a self-contained ring.html (inline SVG, no CDN).

export function run(ctx) {
  const db = openDb();

  const rows = db
    .prepare(
      'SELECT id, seen_count, sessions, app_seeder FROM nodes WHERE id IS NOT NULL'
    )
    .all();
  const skipped = db
    .prepare('SELECT COUNT(*) AS n FROM nodes WHERE id IS NULL')
    .get().n;

  // --- Pear-inspired theme ----------------------------------------------------
  const BG = '#060a08'; // near-black with a faint green tint
  const PANEL = 'rgba(8,16,12,0.82)';
  const TEXT = '#eafff2';
  const MUTED = '#5f7d6e';
  const GRID = 'rgba(120,200,150,0.10)';
  const SEEDER = '#ff2bd6'; // matches the world map's seeder highlight
  // stability scale: dim → bright pear-green
  function color(sessions) {
    if (sessions >= 10) {
      return '#b6ff3c';
    }
    if (sessions >= 5) {
      return '#8ef94b';
    }
    if (sessions >= 3) {
      return '#5bd06a';
    }
    if (sessions >= 2) {
      return '#3f9d62';
    }
    return '#2f6f4a';
  }

  // --- geometry ---------------------------------------------------------------
  const SIZE = 1000;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const BASE_RADIUS = 420; // base ring radius
  const BAND = 46; // radial jitter band so overlapping ids spread into an annulus
  const TWO_PI = Math.PI * 2;

  function hexToFrac(idHex) {
    // top 32 bits of the id -> fraction of the keyspace [0,1)
    return parseInt(idHex.slice(0, 8), 16) / 0x100000000;
  }
  function jitter(idHex) {
    // next 16 bits -> deterministic radial offset within BAND
    return parseInt(idHex.slice(8, 12), 16) / 0x10000;
  }

  const dots = [];
  for (const node of rows) {
    const frac = hexToFrac(node.id);
    const angle = frac * TWO_PI - Math.PI / 2; // 0x00.. at 12 o'clock
    const radius = BASE_RADIUS - jitter(node.id) * BAND;
    const x = CX + radius * Math.cos(angle);
    const y = CY + radius * Math.sin(angle);
    const size = 1.5 + Math.min(10, Math.log2(node.seen_count + 1) * 1.15);
    const dotColor = color(node.sessions);
    const seeder = !!node.app_seeder;
    dots.push({ x, y, size, c: dotColor, seeder });
  }
  // draw bigger/popular dots last so they sit on top
  dots.sort((a, b) => a.size - b.size);

  const dotSvg = dots
    .map(
      (dot) =>
        `<circle cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="${dot.size.toFixed(1)}" fill="${dot.c}" fill-opacity="0.85"` +
        (dot.seeder ? ` stroke="${SEEDER}" stroke-width="2"` : '') +
        '/>'
    )
    .join('\n');

  // quarter labels around the ring (id-space landmarks)
  const ticks = [
    { f: 0.0, label: '0x00…' },
    { f: 0.25, label: '0x40…' },
    { f: 0.5, label: '0x80…' },
    { f: 0.75, label: '0xC0…' }
  ];
  const tickSvg = ticks
    .map((t) => {
      const a = t.f * TWO_PI - Math.PI / 2;
      const x = CX + (BASE_RADIUS + 28) * Math.cos(a);
      const y = CY + (BASE_RADIUS + 28) * Math.sin(a);
      return `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" fill="${MUTED}" font-size="15" text-anchor="middle" dominant-baseline="middle">${t.label}</text>`;
    })
    .join('\n');

  const seederCount = dots.filter((dot) => dot.seeder).length;

  console.log(
    `ring: plotted ${dots.length} node(s)${skipped ? `, skipped ${skipped} without id` : ''}, ${seederCount} seeder(s)`
  );

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>hyperdht-explorer · keyspace ring</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; height: 100%; background: ${BG};
      color: ${TEXT}; font-family: Inter, system-ui, -apple-system, sans-serif; }
    #wrap { display: flex; align-items: center; justify-content: center; height: 100%; }
    svg { max-width: 96vmin; max-height: 96vmin; }
    .panel { position: fixed; background: ${PANEL}; border: 1px solid ${GRID};
      border-radius: 10px; padding: 12px 14px; font-size: 12px; line-height: 1.5;
      backdrop-filter: blur(4px); }
    #title { top: 18px; left: 18px; }
    #title h1 { margin: 0 0 2px; font-size: 16px; font-weight: 600; letter-spacing: .3px; }
    #title .sub { color: ${MUTED}; }
    #legend { bottom: 18px; right: 18px; }
    #legend i { display: inline-block; width: 11px; height: 11px; border-radius: 50%;
      margin-right: 7px; vertical-align: middle; }
    #legend .seed { background: none; border: 2px solid ${SEEDER}; }
    .accent { color: #b6ff3c; }
  </style>
</head>
<body>
  <div id="title" class="panel">
    <h1>hyperdht-explorer · <span class="accent">keyspace ring</span></h1>
    <div class="sub">${dots.length} nodes across the 256-bit id space</div>
  </div>

  <div id="wrap">
    <svg viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${CX}" cy="${CY}" r="${BASE_RADIUS}" fill="none" stroke="${GRID}" stroke-width="1.5"/>
      <circle cx="${CX}" cy="${CY}" r="${BASE_RADIUS - BAND}" fill="none" stroke="${GRID}" stroke-width="1"/>
      <line x1="${CX}" y1="${CY - BASE_RADIUS - 10}" x2="${CX}" y2="${CY + BASE_RADIUS + 10}" stroke="${GRID}" stroke-width="1"/>
      <line x1="${CX - BASE_RADIUS - 10}" y1="${CY}" x2="${CX + BASE_RADIUS + 10}" y2="${CY}" stroke="${GRID}" stroke-width="1"/>
      ${tickSvg}
      ${dotSvg}
    </svg>
  </div>

  <div id="legend" class="panel">
    <div><b>sessions seen</b> (colour)</div>
    <div><i style="background:#b6ff3c"></i>10+ (stable)</div>
    <div><i style="background:#8ef94b"></i>5–9</div>
    <div><i style="background:#5bd06a"></i>3–4</div>
    <div><i style="background:#3f9d62"></i>2</div>
    <div><i style="background:#2f6f4a"></i>1 (transient)</div>
    <div style="margin-top:6px"><i class="seed"></i>app seeder</div>
    <div style="margin-top:8px; color:${MUTED}; max-width:210px">
      dot size = encounter frequency (sightings).<br>
      circular projection of the id space — XOR metric, so ring adjacency ≠ routing distance.
    </div>
  </div>
</body>
</html>
`;

  ensureDirs();
  const out = htmlPath('ring.html');
  fs.writeFileSync(out, html);
  console.log(`ring: wrote ring.html`);
  console.log(`open it in a browser:  file://${out}`);
  db.close();
}
