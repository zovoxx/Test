// Procedural textures drawn on 2D canvases. No image files are used anywhere.
// Textures are cached by key and flagged as shared so track disposal keeps them.

import * as THREE from 'three';
import { makeRng, clamp } from './utils.js';

const cache = new Map();
let maxAnisotropy = 4;

export function setMaxAnisotropy(n) {
  maxAnisotropy = Math.max(1, Math.min(8, n | 0));
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(canvas, { repeat = true, srgb = true, mipmaps = true, aniso = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.generateMipmaps = mipmaps;
  tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.anisotropy = aniso ? maxAnisotropy : 1;
  tex.userData.shared = true;
  tex.needsUpdate = true;
  return tex;
}

function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

// Tileable value noise used for seamless ground textures.
function tileHash(ix, iy, p, seed) {
  ix = ((ix % p) + p) % p;
  iy = ((iy % p) + p) % p;
  let h = (ix * 374761393 + iy * 668265263 + seed * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function tileNoise(x, y, p, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = tileHash(ix, iy, p, seed);
  const b = tileHash(ix + 1, iy, p, seed);
  const c = tileHash(ix, iy + 1, p, seed);
  const d = tileHash(ix + 1, iy + 1, p, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function tileFbm(x, y, basePeriod, octaves, seed) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(x * p, y * p, p, seed + o * 7) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

function hexToRgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r * 255, c.g * 255, c.b * 255];
}

/**
 * Seamless noisy ground texture (grass / sand / gravel / concrete).
 * colors: [dark, light] hex strings, plus optional speckle colour.
 */
export function groundTexture(key, { dark, light, speck = null, size = 256, period = 8, seed = 1, contrast = 1 }) {
  return cached('ground:' + key, () => {
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d0 = hexToRgb(dark);
    const d1 = hexToRgb(light);
    const sp = speck ? hexToRgb(speck) : null;
    const rng = makeRng(seed);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        let n = tileFbm(u, v, period, 5, seed);
        n = clamp((n - 0.5) * contrast + 0.5, 0, 1);
        const grain = (rng() - 0.5) * 0.12;
        const t = clamp(n + grain, 0, 1);
        let r = d0[0] + (d1[0] - d0[0]) * t;
        let g = d0[1] + (d1[1] - d0[1]) * t;
        let b = d0[2] + (d1[2] - d0[2]) * t;
        if (sp && rng() < 0.012) {
          r = sp[0];
          g = sp[1];
          b = sp[2];
        }
        const i = (y * size + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c);
  });
}

/**
 * Road surface: asphalt grain, tyre-worn lanes, edge lines and a dashed centre line.
 * U runs across the road (0..1 = full width), V runs along (1 tile = 12 m).
 */
export function roadTexture(key, { base = '#3b3e44', edge = '#f0f0f0', center = '#f3f3f3', wet = false, seed = 3 } = {}) {
  return cached('road:' + key, () => {
    const W = 256;
    const H = 512;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    const b = hexToRgb(base);
    const rng = makeRng(seed);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const v = y / H;
        let n = tileFbm(u, v * 2, 6, 4, seed) - 0.5;
        // darker tyre lanes
        const lane = Math.exp(-Math.pow((Math.abs(u - 0.5) - 0.22) / 0.05, 2)) * 0.07 +
          Math.exp(-Math.pow((Math.abs(u - 0.5) - 0.08) / 0.04, 2)) * 0.05;
        let k = 1 + n * 0.35 - lane + (rng() - 0.5) * 0.16;
        if (wet) {
          // puddles: darker, slightly blue patches
          const p = tileFbm(u * 0.5, v * 0.5, 4, 3, seed + 9);
          if (p > 0.56) k *= 0.62;
        }
        const i = (y * W + x) * 4;
        img.data[i] = clamp(b[0] * k, 0, 255);
        img.data[i + 1] = clamp(b[1] * k, 0, 255);
        img.data[i + 2] = clamp(b[2] * k * (wet ? 1.12 : 1), 0, 255);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // edge lines (solid)
    ctx.fillStyle = edge;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(W * 0.035, 0, W * 0.022, H);
    ctx.fillRect(W * (1 - 0.057), 0, W * 0.022, H);
    // centre dashes (3 m dash every 12 m tile -> 1/4 of the tile)
    ctx.fillStyle = center;
    ctx.fillRect(W * 0.494, H * 0.1, W * 0.014, H * 0.3);
    ctx.fillRect(W * 0.494, H * 0.6, W * 0.014, H * 0.3);
    // subtle lane dividers
    ctx.globalAlpha = 0.35;
    ctx.fillRect(W * 0.247, H * 0.2, W * 0.008, H * 0.15);
    ctx.fillRect(W * 0.745, H * 0.2, W * 0.008, H * 0.15);
    ctx.fillRect(W * 0.247, H * 0.7, W * 0.008, H * 0.15);
    ctx.fillRect(W * 0.745, H * 0.7, W * 0.008, H * 0.15);
    ctx.globalAlpha = 1;
    // grain over paint so lines look worn
    const g = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < g.data.length; i += 4) {
      if (g.data[i] > 150 && rng() < 0.18) {
        g.data[i] *= 0.7;
        g.data[i + 1] *= 0.7;
        g.data[i + 2] *= 0.7;
      }
    }
    ctx.putImageData(g, 0, 0);
    return toTexture(c);
  });
}

/** Red/white curb stripes. V repeats every 2 m (one red + one white block). */
export function curbTexture(a = '#d42a22', b = '#f4f4f4') {
  return cached('curb:' + a + b, () => {
    const c = makeCanvas(32, 128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = a;
    ctx.fillRect(0, 0, 32, 64);
    ctx.fillStyle = b;
    ctx.fillRect(0, 64, 32, 64);
    // bevel shading across U
    const grd = ctx.createLinearGradient(0, 0, 32, 0);
    grd.addColorStop(0, 'rgba(0,0,0,0.35)');
    grd.addColorStop(0.3, 'rgba(0,0,0,0)');
    grd.addColorStop(0.8, 'rgba(255,255,255,0.12)');
    grd.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 32, 128);
    return toTexture(c, { aniso: true });
  });
}

/** Guard rail (W-beam) / barrier texture. V along length, U up the rail. */
export function railTexture(kind = 'steel') {
  return cached('rail:' + kind, () => {
    const c = makeCanvas(16, 64);
    const ctx = c.getContext('2d');
    if (kind === 'steel') {
      const grd = ctx.createLinearGradient(0, 0, 0, 64);
      grd.addColorStop(0, '#6b7178');
      grd.addColorStop(0.18, '#e2e6ea');
      grd.addColorStop(0.32, '#8a9096');
      grd.addColorStop(0.5, '#5d6268');
      grd.addColorStop(0.68, '#d6dade');
      grd.addColorStop(0.84, '#8d9399');
      grd.addColorStop(1, '#53585e');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, 16, 64);
    } else if (kind === 'neon') {
      ctx.fillStyle = '#20232b';
      ctx.fillRect(0, 0, 16, 64);
      ctx.fillStyle = '#ff2fa0';
      ctx.fillRect(0, 8, 16, 6);
      ctx.fillStyle = '#26e7ff';
      ctx.fillRect(0, 48, 16, 4);
    } else {
      // concrete barrier with a yellow/black band
      ctx.fillStyle = '#b9b2a6';
      ctx.fillRect(0, 0, 16, 64);
      ctx.fillStyle = '#d9a520';
      ctx.fillRect(0, 6, 16, 10);
      ctx.fillStyle = '#9f988d';
      ctx.fillRect(0, 56, 16, 8);
    }
    return toTexture(c, { srgb: true });
  });
}

/** Black/white checker for the start line and gantry banner. */
export function checkerTexture(cols = 16, rows = 2) {
  return cached(`checker:${cols}x${rows}`, () => {
    const s = 16;
    const c = makeCanvas(cols * s, rows * s);
    const ctx = c.getContext('2d');
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
        ctx.fillRect(x * s, y * s, s, s);
      }
    const t = toTexture(c, { mipmaps: true });
    t.magFilter = THREE.NearestFilter;
    return t;
  });
}

/** Soft radial glow used for fake bloom, sparks and lamp halos. */
export function glowTexture() {
  return cached('glow', () => {
    const s = 64;
    const c = makeCanvas(s, s);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return toTexture(c, { repeat: false, srgb: false });
  });
}

/** Puffy smoke particle (alpha falls to zero well inside the edges). */
export function smokeTexture() {
  return cached('smoke', () => {
    const s = 64;
    const c = makeCanvas(s, s);
    const ctx = c.getContext('2d');
    const rng = makeRng(77);
    for (let i = 0; i < 14; i++) {
      const x = s / 2 + (rng() - 0.5) * s * 0.22;
      const y = s / 2 + (rng() - 0.5) * s * 0.22;
      const r = s * (0.14 + rng() * 0.12);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.4)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // radial mask guarantees soft round edges
    ctx.globalCompositeOperation = 'destination-in';
    const m = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(0.3, 'rgba(0,0,0,0.8)');
    m.addColorStop(0.55, 'rgba(0,0,0,0.38)');
    m.addColorStop(0.8, 'rgba(0,0,0,0.1)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = m;
    ctx.fillRect(0, 0, s, s);
    ctx.globalCompositeOperation = 'source-over';
    return toTexture(c, { repeat: false, srgb: false });
  });
}

/** Headlight pool projected on the road (fake light). */
export function lightPoolTexture() {
  return cached('lightpool', () => {
    const w = 128;
    const h = 128;
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    // cone widening away from the car (car at v=0 bottom)
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const along = 1 - y / h; // 0 near car .. 1 far
      const spread = 0.12 + along * 0.38;
      for (let x = 0; x < w; x++) {
        const u = Math.abs(x / w - 0.5);
        const side = clamp(1 - u / spread, 0, 1);
        const fall = Math.sin(clamp(along, 0, 1) * Math.PI) * (1 - along * 0.5);
        const a = side * side * fall;
        const i = (y * w + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 245;
        img.data[i + 2] = 220;
        img.data[i + 3] = clamp(a * 255, 0, 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { repeat: false, srgb: false });
  });
}

/** Vertical streak used to fake wet-road reflections of lights. */
export function streakTexture() {
  return cached('streak', () => {
    const w = 32;
    const h = 128;
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x / (w - 1)) * 2 - 1;
        const v = (y / (h - 1)) * 2 - 1;
        const a = Math.max(0, 1 - u * u) ** 2 * Math.max(0, 1 - v * v) ** 1.5;
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { repeat: false, srgb: false });
  });
}

/**
 * Building facade with a window grid. Lit windows are bright, so the same
 * texture doubles as the emissive map at night.
 */
export function windowsTexture(seed = 5) {
  return cached('windows:' + seed, () => {
    const W = 256;
    const H = 256;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const rng = makeRng(seed);
    ctx.fillStyle = '#23262e';
    ctx.fillRect(0, 0, W, H);
    const cols = 8;
    const rows = 8;
    const cw = W / cols;
    const rh = H / rows;
    const lit = ['#ffd98a', '#fff1c9', '#bfe3ff', '#ffc070', '#e8f4ff'];
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const on = rng() < 0.42;
        ctx.fillStyle = on ? rng.pick(lit) : rng() < 0.5 ? '#0f1116' : '#151a22';
        ctx.fillRect(x * cw + 4, y * rh + 5, cw - 8, rh - 10);
        if (on && rng() < 0.4) {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(x * cw + 4, y * rh + 5, (cw - 8) * rng(), rh - 10);
        }
      }
    return toTexture(c);
  });
}

/** Daytime facade (concrete / glass) for non-night lighting. */
export function facadeTexture(seed = 6) {
  return cached('facade:' + seed, () => {
    const W = 256;
    const H = 256;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const rng = makeRng(seed);
    ctx.fillStyle = '#8d939c';
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const s = 40 + rng() * 40;
        ctx.fillStyle = `rgb(${s},${s + 12},${s + 26})`;
        ctx.fillRect(x * 32 + 4, y * 32 + 5, 24, 22);
      }
    return toTexture(c);
  });
}

const NEON_SIGNS = [
  ['NEON', '#ff2fa0'],
  ['DRIFT', '#26e7ff'],
  ['HOTEL', '#ffd23a'],
  ['24/7', '#54ff8a'],
  ['RAMEN', '#ff5a3c'],
  ['ARCADE', '#b26bff'],
  ['CLUB', '#ff2fa0'],
  ['TURBO', '#26e7ff'],
];

/** Atlas of glowing neon signs (8 rows). */
export function neonAtlas() {
  return cached('neon', () => {
    const W = 512;
    const RH = 128;
    const c = makeCanvas(W, RH * NEON_SIGNS.length);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    NEON_SIGNS.forEach(([text, color], i) => {
      const cy = i * RH + RH / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.strokeRect(14, i * RH + 12, W - 28, RH - 24);
      ctx.font = 'bold 76px -apple-system, system-ui, Helvetica, Arial, sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(text, W / 2, cy + 4);
      ctx.shadowBlur = 4;
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.55;
      ctx.fillText(text, W / 2, cy + 4);
      ctx.globalAlpha = 1;
    });
    ctx.shadowBlur = 0;
    return toTexture(c, { repeat: false });
  });
}
export const NEON_SIGN_COUNT = NEON_SIGNS.length;
export const NEON_SIGN_COLORS = NEON_SIGNS.map((s) => s[1]);

const BILLBOARDS = [
  ['SLIPSTREAM', '#ff5a1f', '#121621'],
  ['APEX TYRES', '#ffffff', '#1d4fd8'],
  ['TURBO COLA', '#ffe14d', '#c8102e'],
  ['NITRO+', '#121621', '#39e0b0'],
];

/** Atlas of trackside advertising boards (4 rows, 512x128 each). */
export function billboardAtlas() {
  return cached('billboards', () => {
    const W = 512;
    const RH = 128;
    const c = makeCanvas(W, RH * BILLBOARDS.length);
    const ctx = c.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    BILLBOARDS.forEach(([text, fg, bg], i) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, i * RH, W, RH);
      ctx.fillStyle = fg;
      ctx.globalAlpha = 0.18;
      for (let s = 0; s < 6; s++) ctx.fillRect(s * 96 - 20, i * RH, 30, RH);
      ctx.globalAlpha = 1;
      ctx.font = 'italic 900 70px -apple-system, system-ui, Helvetica, Arial, sans-serif';
      ctx.fillText(text, W / 2, i * RH + RH / 2 + 3);
    });
    return toTexture(c, { repeat: false });
  });
}
export const BILLBOARD_COUNT = BILLBOARDS.length;

/** Banner for the start/finish gantry. */
export function bannerTexture() {
  return cached('banner', () => {
    const W = 1024;
    const H = 128;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#10131c';
    ctx.fillRect(0, 0, W, H);
    const s = 16;
    for (let y = 0; y < H / s; y++)
      for (let x = 0; x < 12; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#eee';
        ctx.fillRect(x * s, y * s, s, s);
        ctx.fillRect(W - (x + 1) * s, y * s, s, s);
      }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'italic 900 78px -apple-system, system-ui, Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#ff5a1f';
    ctx.fillText('SLIPSTREAM', W / 2, H / 2 + 4);
    return toTexture(c, { repeat: false });
  });
}

/** Tiny soft-edged strip for skid marks (alpha across the width). */
export function skidTexture() {
  return cached('skid', () => {
    const c = makeCanvas(32, 4);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 32, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.25, 'rgba(255,255,255,1)');
    g.addColorStop(0.75, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 4);
    return toTexture(c, { repeat: false, srgb: false, mipmaps: false, aniso: false });
  });
}

/** Round blob shadow for cheap contact shadows under cars / props. */
export function blobShadowTexture() {
  return cached('blob', () => {
    const s = 64;
    const c = makeCanvas(s, s);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.75)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return toTexture(c, { repeat: false, srgb: false });
  });
}

/** Rubber grid-slot markings on the start straight. */
export function gridSlotTexture() {
  return cached('gridslot', () => {
    const c = makeCanvas(64, 64);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(4, 4, 56, 6);
    ctx.fillRect(4, 4, 6, 30);
    ctx.fillRect(54, 4, 6, 30);
    return toTexture(c, { repeat: false, srgb: true });
  });
}
