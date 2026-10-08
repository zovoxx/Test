// Small math / noise / helper utilities shared by every module.
// Everything here is allocation-free in the hot paths.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const sign = (v) => (v < 0 ? -1 : 1);

/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest-path angle interpolation. */
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

/** Deterministic PRNG (mulberry32) so procedural worlds are identical every load. */
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (a, b) => a + (b - a) * rng();
  rng.int = (a, b) => Math.floor(a + (b - a + 1) * rng());
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return rng;
}

// ---------------------------------------------------------------------------
// 2D value noise + fBm (cheap, smooth enough for terrain and textures)
// ---------------------------------------------------------------------------
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function valueNoise2(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1; // -1..1
}

export function fbm2(x, y, octaves = 4, seed = 0, lacunarity = 2, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, y * freq, seed + i * 31) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise for mountains: 0..1 with sharp crests. */
export function ridged2(x, y, octaves = 4, seed = 0) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq, seed + i * 17));
    sum += n * n * amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum;
}

/** Format milliseconds as m:ss.mmm (or --:--.--- when not set). */
export function formatTime(ms, digits = 3) {
  if (ms == null || !isFinite(ms) || ms <= 0) return digits === 3 ? '--:--.---' : '--:--.--';
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const frac = Math.floor((ms % 1000) / (digits === 3 ? 1 : 10));
  return `${m}:${String(s).padStart(2, '0')}.${String(frac).padStart(digits, '0')}`;
}

export function formatDelta(ms) {
  const s = Math.abs(ms) / 1000;
  return `${ms < 0 ? '-' : '+'}${s.toFixed(2)}`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export const formatNumber = (n) => Math.round(n).toLocaleString('en-US');

/** Resolves on the next animation frame (used to keep the loading bar alive). */
export const nextFrame = () =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

/** Dispose every geometry / material / texture below an Object3D. */
export function disposeObject(root) {
  if (!root) return;
  const seen = new Set();
  root.traverse((obj) => {
    if (obj.geometry && !seen.has(obj.geometry)) {
      seen.add(obj.geometry);
      obj.geometry.dispose();
    }
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      if (seen.has(m) || m.userData.shared) continue;
      seen.add(m);
      for (const key in m) {
        const v = m[key];
        if (v && v.isTexture && !v.userData.shared && !seen.has(v)) {
          seen.add(v);
          v.dispose();
        }
      }
      m.dispose();
    }
  });
}

export const isTouchDevice = () =>
  (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
  (typeof window !== 'undefined' && 'ontouchstart' in window);

/** iPadOS 13+ reports itself as "Macintosh"; detect via touch points. */
export const isIOS = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1));
