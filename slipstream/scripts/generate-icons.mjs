// Generates the app icons (PNG) procedurally – no image tools needed.
// Usage: npm run icons   (writes public/icons/*.png and icon.svg)
//
// Design: a road vanishing toward a glowing horizon with orange edge stripes.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// ---- tiny PNG encoder -------------------------------------------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- scene ---------------------------------------------------------------------
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const HORIZON = 0.47;

/** Colour of the icon at normalised coords (x, y) in [0, 1]. */
function shade(x, y, rounded) {
  // rounded-square mask (for the regular icons; maskable fills the square)
  if (rounded) {
    const r = 0.22;
    const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
    const qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
    if (Math.hypot(qx, qy) > r) return null;
  }
  // sky gradient
  let c;
  if (y < HORIZON) {
    const t = y / HORIZON;
    c = [mix(18, 70, t ** 1.6), mix(22, 40, t), mix(48, 80, t)];
  } else {
    const t = (y - HORIZON) / (1 - HORIZON);
    c = [mix(28, 12, t), mix(26, 14, t), mix(44, 24, t)];
  }
  // sun glow at the horizon
  const g = Math.exp(-((x - 0.5) ** 2 * 18 + (y - HORIZON) ** 2 * 60));
  c = [c[0] + 255 * g * 0.9, c[1] + 120 * g * 0.9, c[2] + 40 * g * 0.6];
  // sun disc (half above horizon)
  if (y < HORIZON && Math.hypot(x - 0.5, (y - HORIZON) * 1.0) < 0.13) {
    const stripes = y > HORIZON - 0.06 && Math.floor((HORIZON - y) * 90) % 2 === 0;
    if (!stripes) c = [255, mix(150, 90, (HORIZON - y) / 0.13), 60];
  }
  // mountains silhouette
  const m = HORIZON - (0.05 + 0.035 * Math.sin(x * 19) + 0.02 * Math.sin(x * 47 + 1));
  if (y > m && y < HORIZON && Math.abs(x - 0.5) > 0.15) c = [24, 22, 46];
  // road: trapezoid from the horizon to the bottom
  if (y >= HORIZON) {
    const t = (y - HORIZON) / (1 - HORIZON); // 0 at horizon, 1 at bottom
    const half = mix(0.012, 0.46, t);
    const dx = Math.abs(x - 0.5);
    if (dx < half) {
      c = [mix(40, 58, t), mix(42, 60, t), mix(52, 70, t)];
      // orange edge stripes
      if (dx > half * 0.86 && dx < half * 0.95) c = [255, 98, 36];
      // dashed centre line (perspective-spaced)
      const z = 1 / Math.max(0.02, t); // pseudo depth
      if (dx < half * 0.035 && Math.floor(z * 2.2) % 2 === 0) c = [245, 245, 245];
    }
  }
  return c.map((v) => clamp(v, 0, 255));
}

function render(size, rounded) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, rounded);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      const i = (py * size + px) * 4;
      if (a) {
        buf[i] = r / a;
        buf[i + 1] = g / a;
        buf[i + 2] = b / a;
      }
      buf[i + 3] = (a / (SS * SS)) * 255;
    }
  }
  return encodePNG(size, size, buf);
}

const jobs = [
  ['apple-touch-icon.png', 180, false], // iOS adds its own rounded mask
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
  ['icon-maskable-512.png', 512, false],
];
for (const [name, size, rounded] of jobs) {
  writeFileSync(join(OUT, name), render(size, rounded));
  console.log('wrote', name);
}

// simple SVG favicon with the same motif
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121630"/><stop offset="1" stop-color="#46284f"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#s)"/>
<circle cx="32" cy="30" r="9" fill="#ff8a3c"/>
<rect x="0" y="30" width="64" height="34" rx="0" fill="#1c1a2c"/>
<path d="M31 30h2l26 34H5z" fill="#3a3c4a"/>
<path d="M31.2 30h1.6L57 64h-4.5L32 31 11.5 64H7z" fill="#ff6224"/>
<path d="M31.6 36h.8v4h-.8zM31.3 46h1.4v6h-1.4z" fill="#f5f5f5"/>
</svg>`;
writeFileSync(join(OUT, 'icon.svg'), svg);
console.log('wrote icon.svg');
