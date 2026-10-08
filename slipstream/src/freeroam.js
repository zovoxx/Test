// Free Roam: an open sandbox with hills, ramps, obstacles, knockable cones and
// collectible coin rings, plus its physics world (ground + collisions).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, smoothstep, fbm2, makeRng, TAU } from './utils.js';
import { FREE_ROAM } from './tracks-data.js';
import { SURFACE } from './world-physics.js';
import * as TEX from './textures.js';

const BOUND = 520; // playable half-size (walls)
const PAD_R = 95; // central asphalt drift pad radius

/** Layout is deterministic so coins / ramps are always in the same place. */
function makeLayout() {
  const rng = makeRng(424242);
  const hills = [
    { x: 260, z: -180, r: 110, h: 26 },
    { x: -280, z: 240, r: 130, h: 32 },
    { x: 300, z: 300, r: 90, h: 18 },
    { x: -300, z: -300, r: 100, h: 22 },
    { x: 20, z: 380, r: 80, h: 14 },
  ];
  const ramps = [
    { x: 0, z: 150, yaw: 0, len: 22, w: 10, h: 4.5 },
    { x: 150, z: 0, yaw: Math.PI / 2, len: 22, w: 10, h: 4.5 },
    { x: 0, z: -150, yaw: Math.PI, len: 22, w: 10, h: 4.5 },
    { x: -150, z: 0, yaw: -Math.PI / 2, len: 22, w: 10, h: 4.5 },
    { x: 120, z: 250, yaw: 0.6, len: 28, w: 12, h: 7 },
    { x: -200, z: -120, yaw: 2.5, len: 26, w: 10, h: 6 },
    { x: 380, z: 60, yaw: -1.2, len: 20, w: 9, h: 3.5 },
    { x: -400, z: 40, yaw: 1.4, len: 24, w: 10, h: 5 },
    { x: 60, z: -330, yaw: -2.8, len: 30, w: 12, h: 8 },
    { x: -120, z: 420, yaw: 3.0, len: 22, w: 10, h: 4 },
  ];
  // boxes (shipping containers) and circles (rocks / pillars)
  const boxes = [];
  const circles = [];
  const containerColors = [0xc0392b, 0x2471a3, 0xd4ac0d, 0x229954, 0xe67e22, 0x7d3c98];
  const clearOf = (x, z, r) => {
    if (Math.hypot(x, z) < PAD_R + 30 + r) return false;
    for (const rp of ramps) if (Math.hypot(rp.x - x, rp.z - z) < rp.len + 22 + r) return false;
    for (const b of boxes) if (Math.hypot(b.x - x, b.z - z) < 14 + r) return false;
    for (const c of circles) if (Math.hypot(c.x - x, c.z - z) < c.r + 10 + r) return false;
    return Math.abs(x) < BOUND - 25 && Math.abs(z) < BOUND - 25;
  };
  let tries = 0;
  while (boxes.length < 26 && tries++ < 2000) {
    const x = (rng() * 2 - 1) * BOUND;
    const z = (rng() * 2 - 1) * BOUND;
    if (!clearOf(x, z, 8)) continue;
    const stack = rng() < 0.3 ? 2 : 1;
    boxes.push({ x, z, yaw: rng() * Math.PI, hx: 3.05, hz: 1.22, h: 2.6 * stack, color: rng.pick(containerColors), stack });
  }
  tries = 0;
  while (circles.length < 40 && tries++ < 2000) {
    const x = (rng() * 2 - 1) * BOUND;
    const z = (rng() * 2 - 1) * BOUND;
    const r = 1.4 + rng() * 2.6;
    if (!clearOf(x, z, r)) continue;
    circles.push({ x, z, r, kind: rng() < 0.75 ? 'rock' : 'pillar' });
  }
  // cones: slalom lines on the pad + a ring
  const cones = [];
  for (let i = 0; i < 9; i++) cones.push({ x: -50 + i * 12.5, z: -40 });
  for (let i = 0; i < 9; i++) cones.push({ x: -50 + i * 12.5, z: 40 });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    cones.push({ x: Math.cos(a) * 24, z: Math.sin(a) * 24 });
  }
  for (let i = 0; i < 10; i++) cones.push({ x: 70, z: -45 + i * 10 });
  // coin rings: around the map, on hill tops and above ramp landings
  const coins = [];
  for (const rp of ramps) {
    const fx = Math.sin(rp.yaw);
    const fz = Math.cos(rp.yaw);
    const d = rp.len / 2 + 12 + rp.h * 2.2;
    coins.push({ x: rp.x + fx * d, z: rp.z + fz * d, air: 2.2 + rp.h * 0.55 });
  }
  for (const hl of hills) coins.push({ x: hl.x, z: hl.z, air: 1.6 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    coins.push({ x: Math.cos(a) * 62, z: Math.sin(a) * 62, air: 1.5 });
  }
  tries = 0;
  while (coins.length < 45 && tries++ < 2000) {
    const x = (rng() * 2 - 1) * (BOUND - 40);
    const z = (rng() * 2 - 1) * (BOUND - 40);
    if (!clearOf(x, z, 4)) continue;
    coins.push({ x, z, air: 1.5 });
  }
  return { hills, ramps, boxes, circles, cones, coins };
}

export const LAYOUT = makeLayout();

/** Terrain height without ramps (used for the terrain mesh). */
function terrainHeight(x, z) {
  let h = fbm2(x / 220, z / 220, 4, 13) * 7 + fbm2(x / 60, z / 60, 2, 17) * 0.9;
  for (const hl of LAYOUT.hills) {
    const d2 = ((x - hl.x) ** 2 + (z - hl.z) ** 2) / (hl.r * hl.r);
    h += hl.h * Math.exp(-d2 * 2.2);
  }
  // flatten the central pad and around every ramp
  const pd = Math.hypot(x, z);
  h = lerp(0, h, smoothstep(PAD_R, PAD_R + 45, pd));
  for (const rp of LAYOUT.ramps) {
    const d = Math.hypot(x - rp.x, z - rp.z);
    h = lerp(rp.base ?? 0, h, smoothstep(rp.len * 0.7, rp.len * 0.7 + 30, d));
  }
  // raise the ground at the borders so the walls sit on a berm
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h += smoothstep(BOUND - 10, BOUND + 60, edge) * 25;
  return h;
}

// ramp base heights (ground under each ramp, before flattening)
for (const rp of LAYOUT.ramps) rp.base = 0;

function rampHeight(x, z) {
  let best = -Infinity;
  for (const rp of LAYOUT.ramps) {
    const dx = x - rp.x;
    const dz = z - rp.z;
    const fx = Math.sin(rp.yaw);
    const fz = Math.cos(rp.yaw);
    const u = dx * fx + dz * fz + rp.len / 2; // 0 at the foot, len at the lip
    const v = dx * -fz + dz * fx;
    if (u >= 0 && u <= rp.len && Math.abs(v) <= rp.w / 2) best = Math.max(best, rp.base + (u / rp.len) * rp.h);
  }
  return best;
}

function fullHeight(x, z) {
  const t = terrainHeight(x, z);
  const r = rampHeight(x, z);
  return r > t ? r : t;
}

// ---------------------------------------------------------------------------
// Physics world
// ---------------------------------------------------------------------------
export class FreeRoamWorld {
  constructor() {
    this.layout = LAYOUT;
  }

  sampleGround(x, z, car, out) {
    out.height = fullHeight(x, z);
    if (Math.hypot(x, z) < PAD_R || rampHeight(x, z) > -Infinity) {
      out.surface = SURFACE.ROAD;
      out.grip = 1;
      out.rolling = 1;
      out.offroad = false;
    } else {
      out.surface = SURFACE.DIRT;
      out.grip = 0.86;
      out.rolling = 2.2;
      out.offroad = true;
    }
    return out;
  }

  collide(car) {
    // swept test: subdivide long moves so thin obstacles can't be skipped
    const dx = car.pos.x - car.prevPos.x;
    const dz = car.pos.z - car.prevPos.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / 0.9));
    const ex = car.pos.x;
    const ez = car.pos.z;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      car.pos.x = car.prevPos.x + dx * t;
      car.pos.z = car.prevPos.z + dz * t;
      if (this._resolve(car)) return; // stop at the first contact
    }
    car.pos.x = ex;
    car.pos.z = ez;
    this._resolve(car);
  }

  _resolve(car) {
    let hit = false;
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    // two circles per car
    for (let k = -1; k <= 1; k += 2) {
      const cx = car.pos.x + fx * 1.1 * k;
      const cz = car.pos.z + fz * 1.1 * k;
      const r = 1.05;
      // world bounds
      if (cx > BOUND - r) hit = this._push(car, -1, 0, cx - (BOUND - r), cx, cz) || hit;
      if (cx < -BOUND + r) hit = this._push(car, 1, 0, -BOUND + r - cx, cx, cz) || hit;
      if (cz > BOUND - r) hit = this._push(car, 0, -1, cz - (BOUND - r), cx, cz) || hit;
      if (cz < -BOUND + r) hit = this._push(car, 0, 1, -BOUND + r - cz, cx, cz) || hit;
      for (const c of LAYOUT.circles) {
        const ox = cx - c.x;
        const oz = cz - c.z;
        const d = Math.hypot(ox, oz);
        const min = c.r + r;
        if (d < min && d > 1e-4) hit = this._push(car, ox / d, oz / d, min - d, cx, cz) || hit;
      }
      for (const b of LAYOUT.boxes) {
        const ox = cx - b.x;
        const oz = cz - b.z;
        if (ox * ox + oz * oz > 64) continue;
        const bc = Math.cos(b.yaw);
        const bs = Math.sin(b.yaw);
        // into box local space
        const lx = ox * bc - oz * bs;
        const lz = ox * bs + oz * bc;
        const qx = clamp(lx, -b.hx, b.hx);
        const qz = clamp(lz, -b.hz, b.hz);
        let nx = lx - qx;
        let nz = lz - qz;
        let d = Math.hypot(nx, nz);
        if (d < r) {
          if (d < 1e-4) {
            // centre inside the box: push out along the shallowest axis
            const px = b.hx - Math.abs(lx);
            const pz = b.hz - Math.abs(lz);
            if (px < pz) {
              nx = Math.sign(lx);
              nz = 0;
              d = -px;
            } else {
              nx = 0;
              nz = Math.sign(lz);
              d = -pz;
            }
          } else {
            nx /= d;
            nz /= d;
          }
          // back to world space
          const wx = nx * bc + nz * bs;
          const wz = -nx * bs + nz * bc;
          hit = this._push(car, wx, wz, r - d, cx, cz) || hit;
        }
      }
    }
    // steep steps (ramp sides): block instead of teleporting up
    const h = fullHeight(car.pos.x, car.pos.z);
    if (h - car.pos.y > 0.8) {
      const e = 0.6;
      const gx = fullHeight(car.pos.x + e, car.pos.z) - fullHeight(car.pos.x - e, car.pos.z);
      const gz = fullHeight(car.pos.x, car.pos.z + e) - fullHeight(car.pos.x, car.pos.z - e);
      const gl = Math.hypot(gx, gz) || 1;
      car.pos.x = car.prevPos.x;
      car.pos.z = car.prevPos.z;
      hit = this._push(car, -gx / gl, -gz / gl, 0, car.pos.x, car.pos.z) || hit;
    }
    return hit;
  }

  _push(car, nx, nz, pen, px, pz) {
    car.pos.x += nx * pen;
    car.pos.z += nz * pen;
    const v = car.vel;
    const vn = v.x * nx + v.z * nz;
    if (vn < 0) {
      const imp = -vn;
      v.x -= (1 + (imp > 8 ? 0.3 : 0.1)) * vn * nx;
      v.z -= (1 + (imp > 8 ? 0.3 : 0.1)) * vn * nz;
      const loss = clamp(imp * 0.025, 0.01, 0.35);
      v.x *= 1 - loss;
      v.z *= 1 - loss;
      car.yawRate *= 0.6;
      if (imp > car.impact) {
        car.impact = imp;
        car.impactX = px - nx * 1.0;
        car.impactZ = pz - nz * 1.0;
      }
      if (imp > 7) car.drifting = false;
      return true;
    }
    return pen > 0;
  }
}

// ---------------------------------------------------------------------------
// Dynamic props: knockable cones and collectible coins
// ---------------------------------------------------------------------------
export class FreeRoamProps {
  constructor(group) {
    const coneGeo = mergeGeometries([
      colorGeo(new THREE.ConeGeometry(0.32, 0.8, 10).translate(0, 0.47, 0), 0xff6a13),
      colorGeo(new THREE.CylinderGeometry(0.205, 0.235, 0.12, 10).translate(0, 0.5, 0), 0xf5f5f5),
      colorGeo(new THREE.BoxGeometry(0.62, 0.07, 0.62).translate(0, 0.035, 0), 0x222222),
    ]);
    this.cones = LAYOUT.cones.map((c) => ({
      x: c.x,
      y: fullHeight(c.x, c.z),
      z: c.z,
      x0: c.x,
      z0: c.z,
      vx: 0,
      vy: 0,
      vz: 0,
      rx: 0,
      rz: 0,
      wx: 0,
      wz: 0,
      yaw: 0,
      active: false,
      hit: false,
    }));
    this.coneMesh = new THREE.InstancedMesh(coneGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), this.cones.length);
    this.coneMesh.castShadow = true;
    this.coneMesh.frustumCulled = false;
    group.add(this.coneMesh);

    const ringGeo = new THREE.TorusGeometry(1.1, 0.22, 10, 24);
    this.coins = LAYOUT.coins.map((c) => ({ x: c.x, z: c.z, y: fullHeight(c.x, c.z) + c.air, taken: false }));
    this.coinMesh = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshStandardMaterial({ color: 0xffc533, emissive: 0xff9a00, emissiveIntensity: 0.45, metalness: 0.9, roughness: 0.25 }),
      this.coins.length,
    );
    this.coinMesh.frustumCulled = false;
    group.add(this.coinMesh);
    this.collected = 0;
    this.time = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._dirtyCones = true;
    this.update(0, []);
  }

  reset() {
    for (const c of this.cones) {
      c.x = c.x0;
      c.z = c.z0;
      c.y = fullHeight(c.x, c.z);
      c.vx = c.vy = c.vz = c.rx = c.rz = c.wx = c.wz = 0;
      c.active = false;
      c.hit = false;
    }
    for (const c of this.coins) c.taken = false;
    this.collected = 0;
    this._dirtyCones = true;
  }

  get totalCoins() {
    return this.coins.length;
  }

  /**
   * @param {number} dt
   * @param {import('./car.js').CarPhysics[]} cars
   * @returns {{coins:number, cones:number}} events this frame
   */
  update(dt, cars) {
    this.time += dt;
    const ev = { coins: 0, cones: 0, coneX: 0, coneZ: 0 };
    // cones
    for (const c of this.cones) {
      for (const car of cars) {
        if (Math.abs(car.pos.y - c.y) > 2) continue;
        let dx = c.x - car.pos.x;
        let dz = c.z - car.pos.z;
        if (dx * dx + dz * dz > 16) continue;
        // distance to the car's centre line segment (front/back circles)
        const fx = Math.sin(car.yaw);
        const fz = Math.cos(car.yaw);
        const along = clamp(dx * fx + dz * fz, -1.1, 1.1);
        dx -= fx * along;
        dz -= fz * along;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1.4 * 1.4 && car.speed > 1.5) {
          const d = Math.sqrt(d2) || 1;
          const sp = car.speed;
          c.vx = car.vel.x * 1.15 + (dx / d) * sp * 0.35;
          c.vz = car.vel.z * 1.15 + (dz / d) * sp * 0.35;
          c.vy = 2.5 + sp * 0.18 + Math.random() * 2;
          c.wx = (Math.random() - 0.5) * 18;
          c.wz = (Math.random() - 0.5) * 18;
          car.vel.x *= 0.995;
          car.vel.z *= 0.995;
          if (!c.hit) {
            ev.cones++;
            ev.coneX = c.x;
            ev.coneZ = c.z;
          }
          c.hit = true;
          c.active = true;
        }
      }
      if (c.active) {
        this._dirtyCones = true;
        c.vy -= 9.81 * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.z += c.vz * dt;
        c.rx += c.wx * dt;
        c.rz += c.wz * dt;
        const g = fullHeight(c.x, c.z);
        if (c.y < g) {
          c.y = g;
          c.vy = Math.abs(c.vy) < 1.5 ? 0 : -c.vy * 0.3;
          c.vx *= 0.7;
          c.vz *= 0.7;
          c.wx *= 0.6;
          c.wz *= 0.6;
          // lie down on the side once slow
          if (Math.hypot(c.vx, c.vz) < 0.5 && c.vy === 0) {
            c.active = false;
            c.rx = Math.PI / 2;
            c.rz = 0;
          }
        }
      }
    }
    if (this._dirtyCones) {
      this._dirtyCones = false;
      this.cones.forEach((c, i) => {
        this._e.set(c.rx, c.yaw, c.rz);
        this._q.setFromEuler(this._e);
        this._p.set(c.x, c.y + (c.rx === Math.PI / 2 ? 0.3 : 0), c.z);
        this._m.compose(this._p, this._q, this._s);
        this.coneMesh.setMatrixAt(i, this._m);
      });
      this.coneMesh.instanceMatrix.needsUpdate = true;
    }
    // coins
    const spin = this.time * 2.2;
    this.coins.forEach((c, i) => {
      if (!c.taken) {
        for (const car of cars) {
          const dx = c.x - car.pos.x;
          const dz = c.z - car.pos.z;
          const dy = c.y - (car.pos.y + 0.8);
          if (dx * dx + dz * dz + dy * dy < 3.4 * 3.4) {
            c.taken = true;
            this.collected++;
            ev.coins++;
            ev.coinX = c.x;
            ev.coinY = c.y;
            ev.coinZ = c.z;
            break;
          }
        }
      }
      const s = c.taken ? 0 : 1;
      this._e.set(0, spin + i, 0);
      this._q.setFromEuler(this._e);
      this._p.set(c.x, c.y + Math.sin(this.time * 2 + i) * 0.25, c.z);
      this._s.set(s, s, s);
      this._m.compose(this._p, this._q, this._s);
      this.coinMesh.setMatrixAt(i, this._m);
    });
    this._s.set(1, 1, 1);
    this.coinMesh.instanceMatrix.needsUpdate = true;
    return ev;
  }
}

function colorGeo(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const c = new THREE.Color(hex);
  const arr = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) arr.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

// ---------------------------------------------------------------------------
// Static decoration (called from Environment.build via def.decorate)
// ---------------------------------------------------------------------------
function decorate(ctx) {
  const { group, rng, quality } = ctx;
  const d = quality === 'low' ? 0.45 : quality === 'medium' ? 0.7 : 1;
  // asphalt pad with painted circles
  const padTex = TEX.groundTexture('pad', { dark: '#3a3d42', light: '#50535a', speck: '#5e6168', period: 12, seed: 5 });
  const padGeo = new THREE.CircleGeometry(PAD_R, 64).rotateX(-Math.PI / 2);
  const uv = padGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 12, uv.getY(i) * 12);
  const pad = new THREE.Mesh(
    padGeo,
    new THREE.MeshStandardMaterial({ map: padTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  pad.position.y = 0.02;
  pad.receiveShadow = true;
  group.add(pad);
  const lines = [];
  for (const r of [24, 62, PAD_R - 3]) lines.push(new THREE.RingGeometry(r - 0.25, r + 0.25, 96).rotateX(-Math.PI / 2));
  const lineMesh = new THREE.Mesh(
    mergeGeometries(lines),
    new THREE.MeshLambertMaterial({ color: 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  );
  lines.forEach((g) => g.dispose());
  lineMesh.position.y = 0.04;
  group.add(lineMesh);

  // ramps (wedges with hazard stripes on the lip)
  const rampParts = [];
  for (const rp of LAYOUT.ramps) {
    const L = rp.len;
    const W = rp.w;
    const H = rp.h;
    const shape = new THREE.Shape();
    shape.moveTo(-L / 2, 0);
    shape.lineTo(L / 2, H);
    shape.lineTo(L / 2, 0);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: false });
    g.translate(0, 0, -W / 2);
    g.rotateY(-Math.PI / 2); // shape x -> +z (ramp forward)
    const uvA = g.attributes.uv;
    const pos = g.attributes.position;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, pos.getX(i) / 4, (pos.getZ(i) + L / 2) / 4);
    g.rotateY(rp.yaw);
    g.translate(rp.x, rp.base, rp.z);
    rampParts.push(g);
  }
  const rampGeo = mergeGeometries(rampParts);
  rampParts.forEach((g) => g.dispose());
  const rampTex = TEX.groundTexture('ramp', { dark: '#8a6a45', light: '#b08a5c', speck: '#6a5035', period: 6, seed: 8 });
  const ramps = new THREE.Mesh(rampGeo, new THREE.MeshLambertMaterial({ map: rampTex }));
  ramps.castShadow = true;
  ramps.receiveShadow = true;
  group.add(ramps);

  // containers
  const cGeo = new THREE.BoxGeometry(6.1, 2.6, 2.44);
  cGeo.translate(0, 1.3, 0);
  let nBoxes = 0;
  for (const b of LAYOUT.boxes) nBoxes += b.stack;
  const containers = new THREE.InstancedMesh(cGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.3 }), nBoxes);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const col = new THREE.Color();
  let k = 0;
  for (const b of LAYOUT.boxes) {
    for (let st = 0; st < b.stack; st++) {
      q.setFromAxisAngle(up, b.yaw + st * 0.05);
      p.set(b.x, terrainHeight(b.x, b.z) - 0.1 + st * 2.6, b.z);
      m.compose(p, q, s);
      containers.setMatrixAt(k, m);
      containers.setColorAt(k, col.setHex(st ? b.color ^ 0x202020 : b.color));
      k++;
    }
  }
  containers.castShadow = true;
  containers.receiveShadow = true;
  containers.computeBoundingSphere();
  group.add(containers);

  // rocks and pillars
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: 0x8f8b84 }), LAYOUT.circles.length);
  LAYOUT.circles.forEach((c, i) => {
    q.setFromAxisAngle(up, i * 1.7);
    p.set(c.x, terrainHeight(c.x, c.z) + (c.kind === 'pillar' ? c.r * 1.5 : c.r * 0.4), c.z);
    s.set(c.r * 1.05, c.kind === 'pillar' ? c.r * 2.4 : c.r * 0.9, c.r * 1.05);
    m.compose(p, q, s);
    rocks.setMatrixAt(i, m);
  });
  rocks.castShadow = true;
  rocks.computeBoundingSphere();
  group.add(rocks);

  // boundary walls: short segments that follow the terrain
  const wallParts = [];
  const seg = 8;
  for (let side = 0; side < 4; side++) {
    for (let t = -BOUND; t < BOUND; t += seg) {
      const c = t + seg / 2;
      const x = side === 0 ? BOUND + 1 : side === 1 ? -BOUND - 1 : c;
      const z = side === 2 ? BOUND + 1 : side === 3 ? -BOUND - 1 : c;
      const alongX = side >= 2;
      const g = new THREE.BoxGeometry(alongX ? seg + 0.05 : 2, 3.6, alongX ? 2 : seg + 0.05);
      const uvW = g.attributes.uv;
      for (let i = 0; i < uvW.count; i++) uvW.setX(i, uvW.getX(i) * 2);
      g.translate(x, terrainHeight(x, z) + 0.3, z);
      wallParts.push(g);
    }
  }
  const walls = new THREE.Mesh(mergeGeometries(wallParts), new THREE.MeshLambertMaterial({ map: TEX.railTexture('concrete') }));
  wallParts.forEach((g) => g.dispose());
  walls.receiveShadow = true;
  group.add(walls);

  // trees around the edges
  const treeGeo = mergeGeometries([
    colorGeo(new THREE.CylinderGeometry(0.16, 0.26, 2, 5).translate(0, 1, 0), 0x5a3d26),
    colorGeo(new THREE.ConeGeometry(1.9, 3.2, 7).translate(0, 3.2, 0), 0x2f5d2a),
    colorGeo(new THREE.ConeGeometry(1.3, 2.6, 7).translate(0, 4.8, 0), 0x386b30),
  ]);
  const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), Math.floor(420 * d));
  let n = 0;
  let tries = 0;
  while (n < trees.count && tries++ < 8000) {
    const x = (rng() * 2 - 1) * (BOUND + 120);
    const z = (rng() * 2 - 1) * (BOUND + 120);
    const inner = Math.max(Math.abs(x), Math.abs(z)) < BOUND - 20;
    if (inner) {
      if (Math.hypot(x, z) < PAD_R + 25) continue;
      if (rng() < 0.55) continue; // sparser inside the arena
      let ok = true;
      for (const rp of LAYOUT.ramps) if (Math.hypot(rp.x - x, rp.z - z) < rp.len + 30) ok = false;
      for (const b of LAYOUT.boxes) if (Math.hypot(b.x - x, b.z - z) < 10) ok = false;
      for (const c of LAYOUT.circles) if (Math.hypot(c.x - x, c.z - z) < c.r + 6) ok = false;
      for (const cn of LAYOUT.coins) if (Math.hypot(cn.x - x, cn.z - z) < 12) ok = false;
      if (!ok) continue;
    } else if (Math.max(Math.abs(x), Math.abs(z)) < BOUND + 6) continue;
    const sc = 0.8 + rng() * 0.8;
    q.setFromAxisAngle(up, rng() * TAU);
    p.set(x, terrainHeight(x, z) - 0.1, z);
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    trees.setMatrixAt(n, m);
    trees.setColorAt(n, col.setHSL(0.28 + rng() * 0.06, 0.4, 0.85 + rng() * 0.15));
    n++;
  }
  trees.count = n;
  trees.castShadow = quality === 'high';
  trees.computeBoundingSphere();
  group.add(trees);
  ctx.env.treeMesh = trees;
}

/** Lamp heads around the pad for night driving. */
function lampPositions() {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    out.push(new THREE.Vector3(Math.cos(a) * (PAD_R + 4), 7.2, Math.sin(a) * (PAD_R + 4)));
  }
  return out;
}

/** Lamp post meshes for the free-roam pad. */
export function buildFreeRoamLamps(group) {
  const pole = new THREE.CylinderGeometry(0.1, 0.15, 7.5, 6).translate(0, 3.75, 0);
  const head = new THREE.BoxGeometry(0.5, 0.18, 1.4).translate(0, 7.35, -0.6);
  const geo = mergeGeometries([pole, head]);
  pole.dispose();
  head.dispose();
  const lamps = lampPositions();
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0x3a3f48 }), lamps.length);
  const m = new THREE.Matrix4();
  lamps.forEach((l, i) => {
    const a = Math.atan2(l.x, l.z);
    m.makeRotationY(a);
    m.setPosition(l.x * 1.012, 0, l.z * 1.012);
    mesh.setMatrixAt(i, m);
  });
  mesh.computeBoundingSphere();
  group.add(mesh);
}

/** Track-like definition consumed by Environment.build(). */
export function freeRoamDef() {
  return {
    ...FREE_ROAM,
    extent: BOUND + 260,
    baseHeight: terrainHeight,
    terrainHeight,
    heightAt: fullHeight,
    lampPositions: lampPositions(),
    decorate: (ctx) => {
      decorate(ctx);
      buildFreeRoamLamps(ctx.group);
    },
  };
}

export const FREE_ROAM_SPAWN = { x: 0, z: -70, yaw: 0 };
export { fullHeight as freeRoamHeight, BOUND as FREE_ROAM_BOUND };
