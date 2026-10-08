// Validates every track in src/tracks-data.js:
//  - minimum corner radius (tight corners break the wall model and feel bad)
//  - minimum separation between non-adjacent parts of the loop (walls overlap)
//  - maximum slope
// Usage: npm run check:tracks  [--svg out.svg]  (writes an overview plot)

import { writeFileSync } from 'node:fs';
import { TRACKS } from '../src/tracks-data.js';
import { TrackPath } from '../src/track.js';

const MIN_RADIUS = 24;
const MIN_SEPARATION_FACTOR = 2.6; // x wallOffset
const MAX_SLOPE = 14; // percent

let ok = true;
const svgParts = [];
let ox = 0;
for (const def of TRACKS) {
  for (const reverse of [false, true]) {
    const path = new TrackPath({ ...def, reverse });
    const st = path.stats();
    const minSep = path.wallOffset * MIN_SEPARATION_FACTOR;
    const problems = [];
    if (st.minRadius < MIN_RADIUS) problems.push(`tight corner r=${st.minRadius.toFixed(1)}m`);
    if (st.minSeparation < minSep) problems.push(`sections too close ${st.minSeparation.toFixed(1)}m < ${minSep.toFixed(1)}m`);
    if (st.maxSlopePct > MAX_SLOPE) problems.push(`slope ${st.maxSlopePct.toFixed(1)}%`);
    if (problems.length) ok = false;
    console.log(
      `${def.id.padEnd(8)} ${reverse ? 'rev' : 'fwd'}  length ${st.length.toFixed(0)}m  minR ${st.minRadius.toFixed(1)}m  ` +
        `minSep ${st.minSeparation.toFixed(1)}m  maxSlope ${st.maxSlopePct.toFixed(1)}%  ` +
        `elev ${st.bounds.minY.toFixed(1)}..${st.bounds.maxY.toFixed(1)}  ${problems.length ? 'FAIL: ' + problems.join(', ') : 'ok'}`,
    );
    if (!reverse) {
      const b = st.bounds;
      const w = b.maxX - b.minX + 80;
      let d = '';
      for (let i = 0; i <= path.count; i++) {
        const k = i % path.count;
        d += `${i ? 'L' : 'M'}${(path.px[k] - b.minX + 40 + ox).toFixed(1)},${(path.pz[k] - b.minZ + 40).toFixed(1)}`;
      }
      // colour by curvature: mark tight spots
      let marks = '';
      for (let i = 0; i < path.count; i += 3) {
        const r = 1 / Math.max(1e-6, Math.abs(path.curvSmooth[i]));
        if (r < 45)
          marks += `<circle cx="${(path.px[i] - b.minX + 40 + ox).toFixed(1)}" cy="${(path.pz[i] - b.minZ + 40).toFixed(1)}" r="3" fill="red"/>`;
      }
      const sx = path.px[0] - b.minX + 40 + ox;
      const sz = path.pz[0] - b.minZ + 40;
      svgParts.push(
        `<path d="${d}" fill="none" stroke="#999" stroke-width="${path.wallOffset * 2}" stroke-linejoin="round"/>` +
          `<path d="${d}" fill="none" stroke="#333" stroke-width="2"/>${marks}` +
          `<circle cx="${sx}" cy="${sz}" r="8" fill="lime"/>` +
          `<line x1="${sx}" y1="${sz}" x2="${sx + path.tx[0] * 40}" y2="${sz + path.tz[0] * 40}" stroke="lime" stroke-width="4"/>` +
          `<text x="${ox + 40}" y="20" font-size="22">${def.name}</text>`,
      );
      ox += w + 40;
    }
  }
}

const svgIdx = process.argv.indexOf('--svg');
if (svgIdx > 0) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ox} 700" width="${ox}" height="700" style="background:white">${svgParts.join('')}</svg>`;
  writeFileSync(process.argv[svgIdx + 1], svg);
}

if (!ok) {
  console.error('\nTrack check failed.');
  process.exit(1);
}
console.log('\nAll tracks OK.');
