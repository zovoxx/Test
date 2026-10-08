// Physics worlds: ground sampling + collision for the car model.
//
// Each world implements:
//   sampleGround(x, z, car, out) -> out { height, grip, rolling, surface, offroad }
//   collide(car, dt)             -> resolves walls / obstacles, sets car.impact
//
// TrackWorld uses the track spline: the road is a smooth ribbon and the walls
// are lateral offsets from the centre line, so collisions are analytic and the
// car can never tunnel through a wall regardless of speed.

import { clamp, wrapAngle } from './utils.js';
import { cornerMask } from './track.js';

export const SURFACE = { ROAD: 0, CURB: 1, GRASS: 2, SAND: 3, CONCRETE: 4, DIRT: 5 };

const RUNOFF_SURFACES = {
  grass: { surface: SURFACE.GRASS, grip: 0.62, rolling: 7, offroad: true },
  sand: { surface: SURFACE.SAND, grip: 0.58, rolling: 9, offroad: true },
  concrete: { surface: SURFACE.CONCRETE, grip: 0.92, rolling: 1.6, offroad: false },
};

export const CAR_HALF_WIDTH = 0.95;
export const CAR_HALF_LENGTH = 2.2;

export class TrackWorld {
  /**
   * @param {import('./track.js').TrackPath} path
   * @param {string} runoff 'grass' | 'sand' | 'concrete'
   */
  constructor(path, runoff = 'grass') {
    this.path = path;
    this.runoff = RUNOFF_SURFACES[runoff] || RUNOFF_SURFACES.grass;
    this.curbMask = cornerMask(path);
    this._q = {};
  }

  /** Road height with C1 (Hermite) interpolation so crests feel smooth. */
  heightAt(q) {
    const p = this.path;
    const n = p.count;
    const i0 = q.index;
    const i1 = (i0 + 1) % n;
    const t = q.t;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * p.py[i0] + h10 * p.slope[i0] * p.spacing + h01 * p.py[i1] + h11 * p.slope[i1] * p.spacing;
  }

  sampleGround(x, z, car, out) {
    const p = this.path;
    const q = p.project(x, z, car ? car.trackHint : -1, this._q);
    out.height = this.heightAt(q);
    const d = Math.abs(q.lateral);
    if (d <= p.halfWidth) {
      out.surface = SURFACE.ROAD;
      out.grip = 1;
      out.rolling = 1;
      out.offroad = false;
    } else if (d <= p.halfWidth + p.curbWidth && this.curbMask[q.index]) {
      out.surface = SURFACE.CURB;
      out.grip = 0.97;
      out.rolling = 1.4;
      out.offroad = false;
      out.height += 0.04;
    } else {
      const r = this.runoff;
      out.surface = r.surface;
      out.grip = r.grip;
      out.rolling = r.rolling;
      out.offroad = r.offroad;
    }
    return out;
  }

  collide(car) {
    const p = this.path;
    const pos = car.pos;
    const q = p.project(pos.x, pos.z, car.trackHint, this._q);
    car.trackHint = q.index;
    const tangentYaw = Math.atan2(q.tx, q.tz);
    const rel = wrapAngle(car.yaw - tangentYaw);
    const ext = Math.abs(CAR_HALF_WIDTH * Math.cos(rel)) + Math.abs(CAR_HALF_LENGTH * Math.sin(rel)) * 0.9;
    const limit = p.wallOffset - ext;
    const lat = q.lateral;
    if (Math.abs(lat) <= limit) return;

    const side = lat > 0 ? 1 : -1;
    const pen = Math.abs(lat) - limit;
    // inward normal (from the wall towards the track centre) = -side * right
    const nx = -side * -q.tz;
    const nz = -side * q.tx;
    pos.x += nx * pen;
    pos.z += nz * pen;
    const v = car.vel;
    const vn = v.x * nx + v.z * nz;
    if (vn < 0) {
      const imp = -vn;
      const e = imp > 8 ? 0.25 : 0.1;
      v.x -= (1 + e) * vn * nx;
      v.z -= (1 + e) * vn * nz;
      const loss = clamp(imp * 0.022, 0.01, 0.3);
      v.x *= 1 - loss;
      v.z *= 1 - loss;
      if (imp > car.impact) {
        car.impact = imp;
        car.impactX = pos.x - nx * ext;
        car.impactZ = pos.z - nz * ext;
      }
      // glance off: rotate the nose toward the wall direction
      const along = Math.abs(rel) < Math.PI / 2 ? tangentYaw : tangentYaw + Math.PI;
      const dy = wrapAngle(along - car.yaw);
      car.yaw += dy * clamp(imp * 0.012, 0.02, 0.25);
      car.yawRate *= 0.5;
      if (imp > 7) car.drifting = false;
    }
  }
}

const _ca = [0, 0, 0, 0];
const _cb = [0, 0, 0, 0];

/**
 * Car-vs-car collision using two circles per car. Mutates both cars.
 * Returns impact speed (0 if no contact).
 */
export function collideCars(a, b) {
  const pa = a.pos;
  const pb = b.pos;
  const dx0 = pb.x - pa.x;
  const dz0 = pb.z - pa.z;
  if (dx0 * dx0 + dz0 * dz0 > 36) return 0;
  if (Math.abs(pa.y - pb.y) > 1.6) return 0;
  const r = 1.05;
  const off = 1.05;
  const fax = Math.sin(a.yaw);
  const faz = Math.cos(a.yaw);
  const fbx = Math.sin(b.yaw);
  const fbz = Math.cos(b.yaw);
  _ca[0] = pa.x + fax * off;
  _ca[1] = pa.z + faz * off;
  _ca[2] = pa.x - fax * off;
  _ca[3] = pa.z - faz * off;
  _cb[0] = pb.x + fbx * off;
  _cb[1] = pb.z + fbz * off;
  _cb[2] = pb.x - fbx * off;
  _cb[3] = pb.z - fbz * off;
  let best = Infinity;
  let bi = 0;
  let bj = 0;
  for (let i = 0; i < 4; i += 2)
    for (let j = 0; j < 4; j += 2) {
      const dx = _cb[j] - _ca[i];
      const dz = _cb[j + 1] - _ca[i + 1];
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  const d = Math.sqrt(best);
  if (d >= r * 2) return 0;
  let nx = (_cb[bj] - _ca[bi]) / (d || 1);
  let nz = (_cb[bj + 1] - _ca[bi + 1]) / (d || 1);
  if (d < 1e-4) {
    nx = dx0 || 1;
    nz = dz0;
    const l = Math.hypot(nx, nz);
    nx /= l;
    nz /= l;
  }
  const ma = a.cfg.mass;
  const mb = b.cfg.mass;
  const pen = r * 2 - d;
  const wa = mb / (ma + mb);
  const wb = ma / (ma + mb);
  pa.x -= nx * pen * wa;
  pa.z -= nz * pen * wa;
  pb.x += nx * pen * wb;
  pb.z += nz * pen * wb;
  const rvx = b.vel.x - a.vel.x;
  const rvz = b.vel.z - a.vel.z;
  const vn = rvx * nx + rvz * nz;
  if (vn >= 0) return 0;
  const e = 0.3;
  const j = (-(1 + e) * vn) / (1 / ma + 1 / mb);
  a.vel.x -= (nx * j) / ma;
  a.vel.z -= (nz * j) / ma;
  b.vel.x += (nx * j) / mb;
  b.vel.z += (nz * j) / mb;
  // a little spin from off-centre hits
  const sa = bi === 0 ? 1 : -1;
  const sb = bj === 0 ? 1 : -1;
  const crossA = fax * nz - faz * nx;
  const crossB = fbx * nz - fbz * nx;
  a.yawRate += sa * crossA * (j / ma) * 0.25;
  b.yawRate -= sb * crossB * (j / mb) * 0.25;
  const imp = -vn;
  if (imp > a.impact) {
    a.impact = imp;
    a.impactX = (_ca[bi] + _cb[bj]) / 2;
    a.impactZ = (_ca[bi + 1] + _cb[bj + 1]) / 2;
  }
  if (imp > b.impact) {
    b.impact = imp;
    b.impactX = (_ca[bi] + _cb[bj]) / 2;
    b.impactZ = (_ca[bi + 1] + _cb[bj + 1]) / 2;
  }
  return imp;
}
