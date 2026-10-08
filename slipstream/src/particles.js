// Pooled GPU point particles (smoke, dust, sparks, boost flames), fake-bloom
// glow sprites and fading skid-mark ribbons. Nothing here allocates per frame.

import * as THREE from 'three';
import { glowTexture, smokeTexture, skidTexture } from './textures.js';

const POINT_VS = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  uniform float uMaxSize;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = max(0.1, -mv.z);
    gl_PointSize = min(uMaxSize, aSize * uScale / d);
    vColor = aColor;
    vAlpha = aAlpha;
    vDepth = d;
  }
`;

const POINT_FS = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uIntensity;
  uniform vec2 uFade; // fog near/far: points fade out with distance
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDepth;
  void main() {
    vec4 t = texture2D(uMap, gl_PointCoord);
    float fade = 1.0 - smoothstep(uFade.x, uFade.y, vDepth);
    float a = t.a * vAlpha * fade * uIntensity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * t.rgb, a);
  }
`;

function pointMaterial(texture, additive) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uScale: { value: 500 },
      uMaxSize: { value: 300 },
      uIntensity: { value: 1 },
      uFade: { value: new THREE.Vector2(400, 900) },
    },
    vertexShader: POINT_VS,
    fragmentShader: POINT_FS,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/** Points-based particle pool. */
export class ParticleSystem {
  constructor(max, { additive = false, texture = null } = {}) {
    this.max = max;
    this.limit = max; // quality scaler can lower this
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.gravity = new Float32Array(max);
    this.drag = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha);
    g.setDrawRange(0, 0);
    this.material = pointMaterial(texture || (additive ? glowTexture() : smokeTexture()), additive);
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a = 1, gravity = 0, drag = 0) {
    if (this.count >= this.limit) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.col[i3] = r;
    this.col[i3 + 1] = g;
    this.col[i3 + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = s0;
    this.size1[i] = s1;
    this.size[i] = s0;
    this.alpha0[i] = a;
    this.alpha[i] = a;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
  }

  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove with the last live particle
        n--;
        if (i !== n) this._copy(n, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= k;
      this.vel[i3 + 1] = this.vel[i3 + 1] * k - this.gravity[i] * dt;
      this.vel[i3 + 2] *= k;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      // quick fade-in then fade-out
      this.alpha[i] = this.alpha0[i] * Math.min(1, t * 8) * (1 - t);
    }
    this.count = n;
    this.points.geometry.setDrawRange(0, n);
    if (n > 0) {
      this.aPos.clearUpdateRanges();
      this.aPos.addUpdateRange(0, n * 3);
      this.aPos.needsUpdate = true;
      this.aCol.clearUpdateRanges();
      this.aCol.addUpdateRange(0, n * 3);
      this.aCol.needsUpdate = true;
      this.aSize.clearUpdateRanges();
      this.aSize.addUpdateRange(0, n);
      this.aSize.needsUpdate = true;
      this.aAlpha.clearUpdateRanges();
      this.aAlpha.addUpdateRange(0, n);
      this.aAlpha.needsUpdate = true;
    }
  }

  _copy(from, to) {
    const f3 = from * 3;
    const t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
      this.col[t3 + k] = this.col[f3 + k];
    }
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.size0[to] = this.size0[from];
    this.size1[to] = this.size1[from];
    this.size[to] = this.size[from];
    this.alpha0[to] = this.alpha0[from];
    this.alpha[to] = this.alpha[from];
    this.gravity[to] = this.gravity[from];
    this.drag[to] = this.drag[from];
  }

  clear() {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  setView(scale, fogNear, fogFar) {
    this.material.uniforms.uScale.value = scale;
    this.material.uniforms.uFade.value.set(fogNear, fogFar);
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Fixed set of glow sprites (fake bloom) – lamps, neon, car lights.
 * Each point has its own position / size / colour / alpha.
 */
export class GlowPoints {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha);
    g.setDrawRange(0, 0);
    this.material = pointMaterial(glowTexture(), true);
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  set(i, x, y, z, size, r, g, b, a = 1) {
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.col[i3] = r;
    this.col[i3 + 1] = g;
    this.col[i3 + 2] = b;
    this.size[i] = size;
    this.alpha[i] = a;
    if (i >= this.count) this.count = i + 1;
  }

  commit() {
    this.points.geometry.setDrawRange(0, this.count);
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
  }

  setView(scale, fogNear, fogFar) {
    this.material.uniforms.uScale.value = scale;
    this.material.uniforms.uFade.value.set(fogNear, fogFar);
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Skid marks: a ring buffer of quads. Each vertex stores its birth time and the
 * shader fades it out, so old marks never need CPU updates.
 */
export class SkidMarks {
  constructor(maxSegments = 1400, lifetime = 14) {
    this.max = maxSegments;
    this.lifetime = lifetime;
    this.head = 0;
    const pos = new Float32Array(maxSegments * 4 * 3);
    const birth = new Float32Array(maxSegments * 4).fill(-1000);
    const strength = new Float32Array(maxSegments * 4);
    const uv = new Float32Array(maxSegments * 4 * 2);
    const idx = new Uint16Array(maxSegments * 6);
    for (let s = 0; s < maxSegments; s++) {
      const v = s * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], s * 6); // counter-clockwise from above
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], s * 8);
    }
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aBirth = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
    this.aStrength = new THREE.BufferAttribute(strength, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aBirth', this.aBirth);
    g.setAttribute('aStrength', this.aStrength);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: lifetime },
        uMap: { value: skidTexture() },
        uColor: { value: new THREE.Color(0x0a0a0a) },
      },
      vertexShader: /* glsl */ `
        attribute float aBirth;
        attribute float aStrength;
        uniform float uTime;
        uniform float uLife;
        varying float vA;
        varying vec2 vUv;
        void main() {
          float age = uTime - aBirth;
          vA = aStrength * clamp(1.0 - age / uLife, 0.0, 1.0);
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uColor;
        varying float vA;
        varying vec2 vUv;
        void main() {
          float a = texture2D(uMap, vUv).a * vA * 0.75;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.time = 0;
    this._dirtyFrom = -1;
    this._dirtyTo = -1;
  }

  /** Add a quad from (x0,z0) to (x1,z1) with half-width w. */
  add(x0, y0, z0, x1, y1, z1, w, strength) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l = Math.hypot(dx, dz);
    if (l < 0.05 || l > 6) return;
    const nx = (-dz / l) * w;
    const nz = (dx / l) * w;
    const s = this.head;
    this.head = (this.head + 1) % this.max;
    const p = this.aPos.array;
    const o = s * 12;
    p[o] = x0 - nx;
    p[o + 1] = y0;
    p[o + 2] = z0 - nz;
    p[o + 3] = x0 + nx;
    p[o + 4] = y0;
    p[o + 5] = z0 + nz;
    p[o + 6] = x1 - nx;
    p[o + 7] = y1;
    p[o + 8] = z1 - nz;
    p[o + 9] = x1 + nx;
    p[o + 10] = y1;
    p[o + 11] = z1 + nz;
    const b = this.aBirth.array;
    const st = this.aStrength.array;
    for (let k = 0; k < 4; k++) {
      b[s * 4 + k] = this.time;
      st[s * 4 + k] = strength;
    }
    if (this._dirtyFrom < 0) {
      this._dirtyFrom = s;
      this._dirtyTo = s;
    } else if (s < this._dirtyFrom) {
      // wrapped around: upload everything this frame
      this._dirtyFrom = 0;
      this._dirtyTo = this.max - 1;
    } else this._dirtyTo = Math.max(this._dirtyTo, s);
  }

  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    if (this._dirtyFrom >= 0) {
      const a = this._dirtyFrom;
      const n = this._dirtyTo - a + 1;
      this.aPos.clearUpdateRanges();
      this.aPos.addUpdateRange(a * 12, n * 12);
      this.aPos.needsUpdate = true;
      this.aBirth.clearUpdateRanges();
      this.aBirth.addUpdateRange(a * 4, n * 4);
      this.aBirth.needsUpdate = true;
      this.aStrength.clearUpdateRanges();
      this.aStrength.addUpdateRange(a * 4, n * 4);
      this.aStrength.needsUpdate = true;
      this._dirtyFrom = -1;
    }
  }

  clear() {
    this.aBirth.array.fill(-1000);
    this.aBirth.clearUpdateRanges();
    this.aBirth.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * High-level effects facade used by the game: smoke, dust, sparks, flames.
 */
export class Effects {
  constructor(scene) {
    this.smoke = new ParticleSystem(700, { additive: false, texture: smokeTexture() });
    this.sparks = new ParticleSystem(500, { additive: true, texture: glowTexture() });
    this.skids = new SkidMarks();
    this.glows = new GlowPoints(256);
    scene.add(this.smoke.points, this.sparks.points, this.skids.mesh, this.glows.points);
    this.scale = 1; // particle budget multiplier (quality)
    this.rand = Math.random;
  }

  setQuality(level) {
    this.scale = level === 'low' ? 0.4 : level === 'medium' ? 0.7 : 1;
    this.smoke.limit = Math.floor(this.smoke.max * this.scale);
    this.sparks.limit = Math.floor(this.sparks.max * this.scale);
  }

  tyreSmoke(x, y, z, vx, vz, amount, r = 0.86, g = 0.86, b = 0.88) {
    if (this.rand() > amount * this.scale) return;
    const s = 1.2 + this.rand() * 0.8;
    this.smoke.emit(
      x + (this.rand() - 0.5) * 0.4,
      y + 0.25,
      z + (this.rand() - 0.5) * 0.4,
      vx * 0.15 + (this.rand() - 0.5) * 1.2,
      0.8 + this.rand() * 0.8,
      vz * 0.15 + (this.rand() - 0.5) * 1.2,
      1.4 + this.rand() * 1.2,
      s,
      s * 4.5,
      r,
      g,
      b,
      0.38,
      -0.25,
      1.2,
    );
  }

  dust(x, y, z, vx, vz, amount, r = 0.62, g = 0.52, b = 0.38) {
    if (this.rand() > amount * this.scale) return;
    const s = 1 + this.rand();
    this.smoke.emit(
      x + (this.rand() - 0.5) * 0.6,
      y + 0.2,
      z + (this.rand() - 0.5) * 0.6,
      vx * 0.25 + (this.rand() - 0.5) * 2,
      1 + this.rand() * 1.5,
      vz * 0.25 + (this.rand() - 0.5) * 2,
      1.1 + this.rand() * 0.8,
      s,
      s * 3.5,
      r,
      g,
      b,
      0.5,
      0.6,
      1.5,
    );
  }

  sparksBurst(x, y, z, nx, nz, strength) {
    const n = Math.min(40, Math.floor(strength * 2.2 * this.scale));
    for (let i = 0; i < n; i++) {
      const sp = 3 + this.rand() * strength * 0.6;
      this.sparks.emit(
        x,
        y + 0.4 + this.rand() * 0.4,
        z,
        nx * sp * 0.6 + (this.rand() - 0.5) * sp,
        this.rand() * sp * 0.6 + 1,
        nz * sp * 0.6 + (this.rand() - 0.5) * sp,
        0.25 + this.rand() * 0.45,
        0.22,
        0.06,
        1,
        0.75 + this.rand() * 0.2,
        0.35,
        1,
        12,
        1.5,
      );
    }
  }

  flame(x, y, z, vx, vy, vz, blue) {
    if (this.rand() > this.scale + 0.2) return;
    this.sparks.emit(
      x,
      y,
      z,
      vx + (this.rand() - 0.5) * 0.6,
      vy + (this.rand() - 0.5) * 0.6,
      vz + (this.rand() - 0.5) * 0.6,
      0.09 + this.rand() * 0.08,
      0.55,
      0.15,
      blue ? 0.35 : 1,
      blue ? 0.6 : 0.55,
      blue ? 1 : 0.15,
      0.9,
      0,
      2,
    );
  }

  setView(scale, near, far) {
    this.smoke.setView(scale, near, far);
    this.sparks.setView(scale, near, far);
    this.glows.setView(scale, near * 1.5, far * 1.3);
  }

  update(dt) {
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.skids.update(dt);
  }

  clear() {
    this.smoke.clear();
    this.sparks.clear();
    this.skids.clear();
  }
}
