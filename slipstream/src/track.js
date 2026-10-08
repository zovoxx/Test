// Track system.
//
// TrackPath  – pure math: samples a closed CatmullRomCurve3 at even arc-length
//              spacing and answers queries (nearest point, lateral offset, road
//              height, progress). Usable from Node for tests.
// buildTrackMeshes – turns a TrackPath + theme into road, curbs, run-off,
//              walls, start/finish gantry, grid markings and lamp posts.
//
// Track coordinates: X/Z ground plane, Y up. The car's "right" vector for a
// heading vector f=(fx,fz) is r=(-fz,fx) (see car.js for the convention).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp } from './utils.js';

export const SAMPLE_SPACING = 2; // metres between path samples

export class TrackPath {
  /**
   * @param {object} def track definition (see tracks-data.js)
   */
  constructor(def) {
    this.def = def;
    this.halfWidth = def.halfWidth ?? 7; // asphalt half width
    this.curbWidth = def.curbWidth ?? 0.9;
    this.runoff = def.runoff ?? 5.5; // distance from asphalt edge to wall
    this.wallOffset = this.halfWidth + this.runoff; // lateral position of walls

    const pts = def.points.map(([x, z, y = 0]) => new THREE.Vector3(x, y, z));
    if (def.reverse) pts.reverse();
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    curve.arcLengthDivisions = Math.max(400, pts.length * 60);
    this.length = curve.getLength();
    const n = Math.max(32, Math.round(this.length / SAMPLE_SPACING));
    this.count = n;
    this.spacing = this.length / n;

    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n); // horizontal unit tangent
    this.tz = new Float32Array(n);
    this.slope = new Float32Array(n); // dy/ds
    this.curv = new Float32Array(n); // signed curvature (1/m), + = turning left
    this.heading = new Float32Array(n);

    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      curve.getPointAt(i / n, tmp);
      this.px[i] = tmp.x;
      this.py[i] = tmp.y;
      this.pz[i] = tmp.z;
    }
    // Lightly smooth heights so elevation changes are gentle and drivable.
    for (let pass = 0; pass < 3; pass++) {
      const copy = Float32Array.from(this.py);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -3; k <= 3; k++) s += copy[(i + k + n) % n];
        this.py[i] = s / 7;
      }
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      let dx = this.px[b] - this.px[a];
      let dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      this.tx[i] = dx;
      this.tz[i] = dz;
      this.heading[i] = Math.atan2(dx, dz);
      this.slope[i] = (this.py[b] - this.py[a]) / (2 * this.spacing);
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      let dh = this.heading[b] - this.heading[a];
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      this.curv[i] = dh / (2 * this.spacing);
    }
    // smoothed curvature for AI speed planning
    this.curvSmooth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -4; k <= 4; k++) s += this.curv[(i + k + n) % n];
      this.curvSmooth[i] = s / 9;
    }

    // bounds
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.px[i]);
      maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]);
      maxZ = Math.max(maxZ, this.pz[i]);
      minY = Math.min(minY, this.py[i]);
      maxY = Math.max(maxY, this.py[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ, minY, maxY };

    // checkpoints evenly spaced (index 0 is the start/finish line)
    const cpCount = def.checkpoints ?? 10;
    this.checkpoints = [];
    for (let k = 0; k < cpCount; k++) this.checkpoints.push(Math.floor((k * n) / cpCount));

    this._buildGrid();
    this._q = { index: 0, t: 0, lateral: 0, height: 0, s: 0, tx: 0, tz: 1, dist: 0 };
  }

  // Spatial hash of samples for global nearest queries.
  _buildGrid() {
    const cell = 24;
    this.gridCell = cell;
    const map = new Map();
    for (let i = 0; i < this.count; i++) {
      const key = this._key(Math.floor(this.px[i] / cell), Math.floor(this.pz[i] / cell));
      let arr = map.get(key);
      if (!arr) map.set(key, (arr = []));
      arr.push(i);
    }
    this.grid = map;
  }

  _key(cx, cz) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /** Global nearest sample index (or -1 if nothing within maxDist). */
  nearestIndex(x, z, maxDist = 1e9) {
    const cell = this.gridCell;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let best = -1;
    let bestD = maxDist * maxDist;
    const maxRing = Math.min(64, Math.ceil(maxDist / cell) + 1);
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const arr = this.grid.get(this._key(cx + dx, cz + dz));
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const i = arr[k];
            const ex = this.px[i] - x;
            const ez = this.pz[i] - z;
            const d = ex * ex + ez * ez;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // once found, one more ring guarantees the true nearest
      if (best >= 0 && (ring - 1) * cell > Math.sqrt(bestD)) break;
    }
    return best;
  }

  /**
   * Project a world point onto the track.
   * hint: last known index (local search) or -1 for a global search.
   * Returns a shared result object (copy values you need to keep).
   */
  project(x, z, hint = -1, out = this._q) {
    const n = this.count;
    let best = -1;
    if (hint < 0) {
      best = this.nearestIndex(x, z);
      if (best < 0) best = 0;
    } else {
      let bestD = Infinity;
      for (let k = -8; k <= 8; k++) {
        const i = (hint + k + n) % n;
        const ex = this.px[i] - x;
        const ez = this.pz[i] - z;
        const d = ex * ex + ez * ez;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    // refine on the segment best->next or prev->best
    let i0 = best;
    let i1 = (best + 1) % n;
    let t = this._segT(i0, i1, x, z);
    if (t < 0) {
      i1 = best;
      i0 = (best - 1 + n) % n;
      t = this._segT(i0, i1, x, z);
    }
    t = clamp(t, 0, 1);
    const qx = lerp(this.px[i0], this.px[i1], t);
    const qz = lerp(this.pz[i0], this.pz[i1], t);
    let tx = lerp(this.tx[i0], this.tx[i1], t);
    let tz = lerp(this.tz[i0], this.tz[i1], t);
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // right = (-tz, tx)
    const lateral = (x - qx) * -tz + (z - qz) * tx;
    out.index = i0;
    out.t = t;
    out.tx = tx;
    out.tz = tz;
    out.lateral = lateral;
    out.height = lerp(this.py[i0], this.py[i1], t);
    out.slope = lerp(this.slope[i0], this.slope[i1], t);
    out.s = (i0 + t) * this.spacing;
    out.dist = Math.abs(lateral);
    return out;
  }

  _segT(i0, i1, x, z) {
    const ax = this.px[i0];
    const az = this.pz[i0];
    const dx = this.px[i1] - ax;
    const dz = this.pz[i1] - az;
    const l2 = dx * dx + dz * dz || 1;
    return ((x - ax) * dx + (z - az) * dz) / l2;
  }

  /** World position at arc length s and lateral offset (written into out Vector3). */
  pointAt(s, lateral, out) {
    const n = this.count;
    let f = s / this.spacing;
    f = ((f % n) + n) % n;
    const i0 = Math.floor(f);
    const i1 = (i0 + 1) % n;
    const t = f - i0;
    let tx = lerp(this.tx[i0], this.tx[i1], t);
    let tz = lerp(this.tz[i0], this.tz[i1], t);
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    out.set(
      lerp(this.px[i0], this.px[i1], t) - tz * lateral,
      lerp(this.py[i0], this.py[i1], t),
      lerp(this.pz[i0], this.pz[i1], t) + tx * lateral,
    );
    return out;
  }

  /** Heading angle (car yaw convention) at arc length s. */
  headingAt(s) {
    const n = this.count;
    let f = s / this.spacing;
    f = ((f % n) + n) % n;
    const i0 = Math.floor(f);
    const i1 = (i0 + 1) % n;
    const t = f - i0;
    return Math.atan2(lerp(this.tx[i0], this.tx[i1], t), lerp(this.tz[i0], this.tz[i1], t));
  }

  indexAt(s) {
    const n = this.count;
    return ((Math.floor(s / this.spacing) % n) + n) % n;
  }

  /** Wrap a signed arc-length difference into (-L/2, L/2]. */
  deltaS(a, b) {
    let d = b - a;
    const L = this.length;
    d = ((d % L) + L) % L;
    if (d > L / 2) d -= L;
    return d;
  }

  /**
   * Start grid slot transform. slot 0 = pole position.
   * Grid is behind the start line, two staggered columns.
   */
  gridSlot(slot, out) {
    const s = this.length - (10 + slot * 8);
    const lateral = slot % 2 === 0 ? -3.2 : 3.2;
    this.pointAt(s, lateral, out);
    return { s, heading: this.headingAt(s) };
  }

  /** Minimum turning radius and other stats (used by scripts/check-tracks.mjs). */
  stats() {
    let maxK = 0;
    let maxSlope = 0;
    for (let i = 0; i < this.count; i++) {
      maxK = Math.max(maxK, Math.abs(this.curvSmooth[i]));
      maxSlope = Math.max(maxSlope, Math.abs(this.slope[i]));
    }
    // minimum distance between samples that are far apart along the track
    let minSep = Infinity;
    const skip = Math.ceil((this.wallOffset * 4) / this.spacing);
    for (let i = 0; i < this.count; i += 2) {
      for (let j = 0; j < this.count; j += 2) {
        let di = Math.abs(i - j);
        di = Math.min(di, this.count - di);
        if (di < skip) continue;
        const d = Math.hypot(this.px[i] - this.px[j], this.pz[i] - this.pz[j]);
        if (d < minSep) minSep = d;
      }
    }
    return {
      length: this.length,
      minRadius: maxK > 0 ? 1 / maxK : Infinity,
      maxSlopePct: maxSlope * 100,
      minSeparation: minSep,
      bounds: this.bounds,
    };
  }
}

// ---------------------------------------------------------------------------
// Mesh building
// ---------------------------------------------------------------------------

/**
 * Generic ribbon along the track between two lateral offsets.
 * opts: { from, to, yFrom, yTo, vScale, uFrom, uTo, include(i)->bool, lift }
 */
function ribbon(path, opts) {
  const n = path.count;
  const {
    from,
    to,
    yFrom = 0,
    yTo = 0,
    vScale = 0.1,
    uFrom = 0,
    uTo = 1,
    include = null,
    lift = 0,
  } = opts;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    const rx = -path.tz[i];
    const rz = path.tx[i];
    const y = path.py[i] + lift;
    const s = k * path.spacing;
    const o = k * 6;
    pos[o] = path.px[i] + rx * from;
    pos[o + 1] = y + yFrom;
    pos[o + 2] = path.pz[i] + rz * from;
    pos[o + 3] = path.px[i] + rx * to;
    pos[o + 4] = y + yTo;
    pos[o + 5] = path.pz[i] + rz * to;
    const u = k * 4;
    uv[u] = uFrom;
    uv[u + 1] = s * vScale;
    uv[u + 2] = uTo;
    uv[u + 3] = s * vScale;
  }
  const idx = [];
  for (let k = 0; k < n; k++) {
    if (include && !include(k)) continue;
    const a = k * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    // counter-clockwise when seen from above (normal up) when from < to
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Curvature mask: true where the track is cornering (for curbs). */
export function cornerMask(path, threshold = 1 / 140, grow = 8) {
  const n = path.count;
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = Math.abs(path.curvSmooth[i]) > threshold ? 1 : 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!raw[i]) continue;
    for (let k = -grow; k <= grow; k++) out[(i + k + n) % n] = 1;
  }
  // always curb the start straight for a racing look
  for (let k = -20; k <= 6; k++) out[(k + n) % n] = 1;
  return out;
}

/**
 * Build all static track meshes.
 * @returns {{ group: THREE.Group, startLights: THREE.Mesh[], lampPositions: THREE.Vector3[] }}
 */
export function buildTrackMeshes(path, style, tex) {
  const group = new THREE.Group();
  group.name = 'track';
  const hw = path.halfWidth;
  const wall = path.wallOffset;

  // --- road -----------------------------------------------------------------
  const roadGeo = ribbon(path, { from: -hw, to: hw, vScale: 1 / 12, lift: 0 });
  const roadMat = new THREE.MeshStandardMaterial({
    map: tex.road,
    roughness: style.roadRoughness ?? 0.92,
    metalness: style.roadMetalness ?? 0.0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.receiveShadow = true;
  road.name = 'road';
  group.add(road);

  // --- curbs (corners only), slightly raised ----------------------------------
  const mask = cornerMask(path);
  const include = (k) => mask[k % path.count] === 1;
  const curbL = ribbon(path, { from: -hw - path.curbWidth, to: -hw + 0.05, yFrom: 0.07, yTo: 0.01, vScale: 0.5, uFrom: 1, uTo: 0, include });
  const curbR = ribbon(path, { from: hw - 0.05, to: hw + path.curbWidth, yFrom: 0.01, yTo: 0.07, vScale: 0.5, include });
  const curbGeo = mergeGeometries([curbL, curbR]);
  curbL.dispose();
  curbR.dispose();
  const curb = new THREE.Mesh(
    curbGeo,
    new THREE.MeshLambertMaterial({ map: tex.curb, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
  );
  curb.receiveShadow = true;
  group.add(curb);

  // --- run-off strips (to the walls) with a skirt hiding terrain seams --------
  const roL = ribbon(path, { from: -wall - 1.2, to: -hw, yFrom: -0.03, yTo: -0.03, vScale: 1 / 8, uFrom: 0, uTo: (wall - hw) / 8 });
  const roR = ribbon(path, { from: hw, to: wall + 1.2, yFrom: -0.03, yTo: -0.03, vScale: 1 / 8, uFrom: 0, uTo: (wall - hw) / 8 });
  const skL = ribbon(path, { from: -wall - 1.2, to: -wall - 1.2, yFrom: -2.5, yTo: -0.03, vScale: 1 / 8 });
  const skR = ribbon(path, { from: wall + 1.2, to: wall + 1.2, yFrom: -0.03, yTo: -2.5, vScale: 1 / 8 });
  const roGeo = mergeGeometries([roL, roR, skL, skR]);
  [roL, roR, skL, skR].forEach((g) => g.dispose());
  const runoff = new THREE.Mesh(roGeo, new THREE.MeshLambertMaterial({ map: tex.runoff, side: THREE.DoubleSide }));
  runoff.receiveShadow = true;
  group.add(runoff);

  // --- walls / guard rails --------------------------------------------------
  const railH0 = style.rail === 'concrete' ? 0 : 0.32;
  const railH1 = style.rail === 'concrete' ? 1.05 : 0.88;
  const wL = ribbon(path, { from: -wall, to: -wall, yFrom: railH0, yTo: railH1, vScale: 1 / 4, uFrom: 0, uTo: 1 });
  const wR = ribbon(path, { from: wall, to: wall, yFrom: railH1, yTo: railH0, vScale: 1 / 4, uFrom: 1, uTo: 0 });
  const geos = [wL, wR];
  if (style.rail === 'concrete') {
    // concrete barriers get a top and an outer face so they read as solid blocks
    geos.push(ribbon(path, { from: -wall - 0.45, to: -wall, yFrom: railH1, yTo: railH1, vScale: 1 / 4, uFrom: 0, uTo: 0.1 }));
    geos.push(ribbon(path, { from: wall, to: wall + 0.45, yFrom: railH1, yTo: railH1, vScale: 1 / 4, uFrom: 0, uTo: 0.1 }));
  }
  const wallGeo = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  const wallMesh = new THREE.Mesh(
    wallGeo,
    new THREE.MeshStandardMaterial({
      map: tex.rail,
      roughness: style.rail === 'steel' ? 0.35 : 0.85,
      metalness: style.rail === 'steel' ? 0.75 : 0,
      side: THREE.DoubleSide,
    }),
  );
  wallMesh.castShadow = false;
  wallMesh.receiveShadow = true;
  group.add(wallMesh);

  // rail posts (instanced) for steel rails
  if (style.rail !== 'concrete') {
    const postGeo = new THREE.BoxGeometry(0.12, 0.95, 0.12);
    postGeo.translate(0, 0.475, 0);
    const step = Math.max(1, Math.round(4 / path.spacing));
    const count = Math.ceil(path.count / step) * 2;
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshLambertMaterial({ color: 0x6d737a }), count);
    const m = new THREE.Matrix4();
    let c = 0;
    for (let i = 0; i < path.count; i += step) {
      for (const side of [-1, 1]) {
        const off = side * (wall + 0.12);
        m.makeTranslation(path.px[i] - path.tz[i] * off, path.py[i] - 0.05, path.pz[i] + path.tx[i] * off);
        posts.setMatrixAt(c++, m);
      }
    }
    posts.count = c;
    posts.instanceMatrix.needsUpdate = true;
    posts.computeBoundingSphere();
    group.add(posts);
  }

  // --- start line + grid slots ------------------------------------------------
  const markGeos = [];
  {
    const g = ribbon(path, {
      from: -hw,
      to: hw,
      vScale: 1 / 1.6,
      lift: 0.012,
      include: (k) => k === 0,
    });
    markGeos.push(g);
  }
  const startLine = new THREE.Mesh(
    mergeGeometries(markGeos),
    new THREE.MeshLambertMaterial({ map: tex.checker, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  );
  markGeos.forEach((g) => g.dispose());
  startLine.receiveShadow = true;
  group.add(startLine);

  {
    const slots = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      const { heading } = path.gridSlot(i, v);
      const q = new THREE.PlaneGeometry(2.6, 2.6);
      q.rotateX(-Math.PI / 2);
      q.rotateY(heading + Math.PI);
      q.translate(v.x, v.y + 0.015, v.z);
      // shift so the bracket sits just ahead of the car's nose
      slots.push(q);
    }
    const slotMesh = new THREE.Mesh(
      mergeGeometries(slots),
      new THREE.MeshLambertMaterial({
        map: tex.gridSlot,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    slots.forEach((g) => g.dispose());
    group.add(slotMesh);
  }

  // --- start/finish gantry ----------------------------------------------------
  const startLights = [];
  {
    const parts = [];
    const span = wall + 0.8;
    const pillar = new THREE.BoxGeometry(0.8, 7.2, 0.8);
    pillar.translate(0, 3.6, 0);
    const pl = pillar.clone().translate(-span, 0, 0);
    const pr = pillar.clone().translate(span, 0, 0);
    const beam = new THREE.BoxGeometry(span * 2 + 0.8, 1.6, 0.9);
    beam.translate(0, 7.0, 0);
    parts.push(pl, pr, beam);
    const frame = mergeGeometries(parts);
    parts.forEach((g) => g.dispose());
    pillar.dispose();
    const gantry = new THREE.Group();
    const frameMesh = new THREE.Mesh(frame, new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.6, metalness: 0.5 }));
    frameMesh.castShadow = true;
    gantry.add(frameMesh);
    const bannerGeo = new THREE.PlaneGeometry(span * 2 - 1, 1.3);
    const bannerMat = new THREE.MeshBasicMaterial({ map: tex.banner, side: THREE.DoubleSide, toneMapped: false });
    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.position.set(0, 7.0, 0.47);
    gantry.add(banner);
    const banner2 = new THREE.Mesh(bannerGeo, bannerMat);
    banner2.position.set(0, 7.0, -0.47);
    banner2.rotation.y = Math.PI;
    gantry.add(banner2);
    // five start lights facing the grid (behind the line = -Z local)
    const lightGeo = new THREE.CircleGeometry(0.32, 16);
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x220000, toneMapped: false });
      const l = new THREE.Mesh(lightGeo, mat);
      l.position.set((i - 2) * 0.9, 5.75, -0.47);
      l.rotation.y = Math.PI;
      gantry.add(l);
      startLights.push(l);
    }
    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(4.9, 0.95, 0.5),
      new THREE.MeshLambertMaterial({ color: 0x111318 }),
    );
    housing.position.set(0, 5.75, -0.2);
    gantry.add(housing);
    gantry.position.set(path.px[0], path.py[0], path.pz[0]);
    gantry.rotation.y = path.heading[0];
    group.add(gantry);
  }

  // --- lamp posts (lit at night) --------------------------------------------------
  const lampPositions = [];
  const lampEvery = style.lampSpacing ?? 46;
  {
    const step = Math.max(4, Math.round(lampEvery / path.spacing));
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.14, 7.5, 6);
    poleGeo.translate(0, 3.75, 0);
    const armGeo = new THREE.BoxGeometry(0.12, 0.12, 2.6);
    armGeo.translate(0, 7.4, 1.25);
    const headGeo = new THREE.BoxGeometry(0.45, 0.16, 0.9);
    headGeo.translate(0, 7.32, 2.45);
    const lampGeo = mergeGeometries([poleGeo, armGeo, headGeo]);
    [poleGeo, armGeo, headGeo].forEach((g) => g.dispose());
    const list = [];
    let side = 1;
    for (let i = Math.floor(step / 2); i < path.count - 6; i += step) {
      side = -side;
      if (Math.abs(i) < 8) continue;
      list.push([i, side]);
    }
    const lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshLambertMaterial({ color: style.lampColor ?? 0x3a3f48 }), list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s1 = new THREE.Vector3(1, 1, 1);
    list.forEach(([i, sd], k) => {
      const off = sd * (wall + 1.6);
      p.set(path.px[i] - path.tz[i] * off, path.py[i], path.pz[i] + path.tx[i] * off);
      // arm points toward the road (towards -side * right)
      const ang = Math.atan2(path.tz[i] * sd, -path.tx[i] * sd);
      q.setFromAxisAngle(up, ang);
      m.compose(p, q, s1);
      lamps.setMatrixAt(k, m);
      // head position in world space
      const hx = p.x + Math.sin(ang) * 2.45;
      const hz = p.z + Math.cos(ang) * 2.45;
      lampPositions.push(new THREE.Vector3(hx, p.y + 7.2, hz));
    });
    lamps.instanceMatrix.needsUpdate = true;
    lamps.computeBoundingSphere();
    group.add(lamps);
  }

  return { group, startLights, lampPositions, road, roadMat };
}

/**
 * Helper for city-style layouts: turn a list of corner points into a
 * Catmull-Rom-friendly point list with rounded corners of roughly `r` metres.
 */
export function roundedPolyline(corners, r = 32) {
  const out = [];
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const p = corners[i];
    const a = corners[(i - 1 + n) % n];
    const b = corners[(i + 1) % n];
    const y = p[2] ?? 0;
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ra = Math.min(r, da * 0.45);
    const rb = Math.min(r, db * 0.45);
    out.push([p[0] + ((a[0] - p[0]) / da) * ra, p[1] + ((a[1] - p[1]) / da) * ra, lerp(y, a[2] ?? 0, ra / da)]);
    out.push([p[0] + ((b[0] - p[0]) / db) * rb, p[1] + ((b[1] - p[1]) / db) * rb, lerp(y, b[2] ?? 0, rb / db)]);
  }
  return out;
}
