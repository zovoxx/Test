// World environment: sky, sun/moon lighting, time of day, fog, environment map,
// terrain and theme-specific decoration (trees, lake, buildings, neon, rocks...).
//
// Everything is generated procedurally at load time and merged / instanced so
// the whole world costs only a few dozen draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  clamp,
  lerp,
  smoothstep,
  fbm2,
  ridged2,
  makeRng,
  disposeObject,
  nextFrame,
  TAU,
} from './utils.js';
import * as TEX from './textures.js';
import { buildTrackMeshes } from './track.js';
import { GlowPoints } from './particles.js';

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------
export const THEMES = {
  coastal: {
    ground: { dark: '#3f6b2a', light: '#7fa847', speck: '#9bbf63', period: 6 },
    runoff: 'grass',
    runoffTex: { dark: '#4b7a30', light: '#86ad4f', speck: '#a7c46e', period: 8 },
    road: { base: '#44474d', edge: '#f2f2f2', center: '#f2f2f2' },
    rail: 'steel',
    blend: 48,
    fog: [350, 2600],
    lampSpacing: 70,
    lampColor: [1, 0.85, 0.6],
    mountains: { color0: '#3b5a3e', color1: '#76909a', snow: true, height: 260 },
    clouds: 0.8,
  },
  city: {
    ground: { dark: '#4a4d52', light: '#6b6e73', speck: '#7d8085', period: 10 },
    runoff: 'concrete',
    runoffTex: { dark: '#5c5f64', light: '#7c7f84', speck: '#8c8f94', period: 12 },
    road: { base: '#2f3238', edge: '#e8e8e8', center: '#f5c542', wet: true },
    roadRoughness: 0.42,
    roadMetalness: 0.15,
    rail: 'concrete',
    blend: 18,
    fog: [180, 900],
    lampSpacing: 30,
    lampColor: [1, 0.72, 0.42],
    clouds: 0.25,
  },
  canyon: {
    ground: { dark: '#9a5a32', light: '#d29a63', speck: '#e3b886', period: 6, contrast: 1.3 },
    runoff: 'sand',
    runoffTex: { dark: '#b98552', light: '#dcb07c', speck: '#efd2a5', period: 8 },
    road: { base: '#4a4542', edge: '#f2f2f2', center: '#ffd23a' },
    rail: 'steel',
    blend: 70,
    fog: [350, 2500],
    lampSpacing: 64,
    lampColor: [1, 0.8, 0.55],
    mountains: { color0: '#8a4a2c', color1: '#d0895a', snow: false, height: 200, mesa: true },
    clouds: 0.35,
  },
  freeroam: {
    ground: { dark: '#55753a', light: '#93a75a', speck: '#b4b07a', period: 5 },
    rail: 'concrete',
    fog: [350, 2500],
    lampColor: [1, 0.85, 0.6],
    mountains: { color0: '#566f4c', color1: '#9aa9a8', snow: true, height: 240 },
    clouds: 0.7,
  },
};

// ---------------------------------------------------------------------------
// Time of day keyframes (hour -> colours / intensities). Colours are hex.
// ---------------------------------------------------------------------------
const TOD_KEYS = [
  { h: 0, top: '#03060f', hor: '#141c33', bottom: '#07090f', sun: '#a9bdf0', sunI: 0.7, hemiS: '#45598f', hemiG: '#181a24', hemiI: 0.95, fog: '#141c33', env: 0.25, night: 1, cloud: '#1b2238' },
  { h: 5.2, top: '#0b1430', hor: '#3a3354', bottom: '#0b0c12', sun: '#9fb4e8', sunI: 0.5, hemiS: '#45528a', hemiG: '#18161f', hemiI: 0.8, fog: '#3a3354', env: 0.3, night: 0.9, cloud: '#2e2c45' },
  { h: 6.4, top: '#2c4a8a', hor: '#f0a070', bottom: '#2a2420', sun: '#ffab72', sunI: 1.3, hemiS: '#8aa3d6', hemiG: '#3a2f28', hemiI: 0.8, fog: '#d79b7c', env: 0.6, night: 0.25, cloud: '#f2b394' },
  { h: 8.5, top: '#3577d4', hor: '#bcd6ee', bottom: '#4a4a44', sun: '#ffe7c4', sunI: 2.6, hemiS: '#bcd6ff', hemiG: '#5a4e3c', hemiI: 1.05, fog: '#bfd5ea', env: 0.9, night: 0, cloud: '#ffffff' },
  { h: 13, top: '#2a6fd6', hor: '#b5d4f2', bottom: '#4d4b45', sun: '#fff6e8', sunI: 3.1, hemiS: '#c4dcff', hemiG: '#5d5240', hemiI: 1.15, fog: '#bcd6f0', env: 1, night: 0, cloud: '#ffffff' },
  { h: 16.5, top: '#3570c8', hor: '#d8cfb4', bottom: '#4d473f', sun: '#ffdcaa', sunI: 2.6, hemiS: '#b8cdf0', hemiG: '#5d4c3a', hemiI: 1.0, fog: '#d3cdb8', env: 0.9, night: 0, cloud: '#fff4e6' },
  { h: 18.2, top: '#3a4f96', hor: '#ff9a4d', bottom: '#3a2a22', sun: '#ff9248', sunI: 2.1, hemiS: '#a08cc0', hemiG: '#4a3426', hemiI: 0.85, fog: '#e8915a', env: 0.75, night: 0.08, cloud: '#ffb070' },
  { h: 19.4, top: '#1a1f4f', hor: '#b2486a', bottom: '#1a1418', sun: '#ff6a4a', sunI: 0.8, hemiS: '#5a4a80', hemiG: '#1e1418', hemiI: 0.55, fog: '#6a3550', env: 0.45, night: 0.6, cloud: '#7a3a5a' },
  { h: 20.6, top: '#060a1c', hor: '#202848', bottom: '#08090f', sun: '#a9bdf0', sunI: 0.7, hemiS: '#45598f', hemiG: '#181a24', hemiI: 0.95, fog: '#1c2440', env: 0.25, night: 1, cloud: '#1b2238' },
  { h: 24, top: '#03060f', hor: '#141c33', bottom: '#07090f', sun: '#a9bdf0', sunI: 0.7, hemiS: '#45598f', hemiG: '#181a24', hemiI: 0.95, fog: '#141c33', env: 0.25, night: 1, cloud: '#1b2238' },
];

export const TIME_PRESETS = { morning: 7.2, noon: 13, sunset: 18.3, night: 23 };

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
function lerpHex(a, b, t, out) {
  _c1.set(a);
  _c2.set(b);
  return out.copy(_c1).lerp(_c2, t);
}

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------
const SKY_VS = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = vec4(p.xy, p.w * 0.99999, p.w); // always at the far plane
  }
`;

const SKY_FS = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uBottom;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uMoonDir;
  uniform vec3 uCloudColor;
  uniform float uStars;
  uniform float uClouds;
  uniform float uSunVis;
  uniform float uMoonVis;
  uniform float uTime;
  uniform float uLinear;
  varying vec3 vDir;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.5));
    col = mix(col, uBottom, smoothstep(0.0, -0.18, h));
    // sun disc + halo
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * (smoothstep(0.99962, 0.99985, sd) * 1.8 + pow(sd, 22.0) * 0.4 + pow(sd, 4.0) * 0.12) * uSunVis;
    // moon
    float md = max(dot(d, uMoonDir), 0.0);
    col += vec3(0.85, 0.9, 1.0) * (smoothstep(0.9990, 0.9994, md) * 1.6 + pow(md, 60.0) * 0.12) * uMoonVis;
    // stars
    if (uStars > 0.01 && h > 0.0) {
      vec3 q = floor(d * 380.0);
      float s = hash13(q);
      float tw = 0.65 + 0.35 * sin(uTime * 2.0 + s * 60.0);
      col += vec3(step(0.9972, s) * tw * uStars * smoothstep(0.0, 0.25, h));
    }
    // clouds (cheap value noise projected on a plane)
    if (uClouds > 0.01 && h > 0.015) {
      vec2 uv = d.xz / (h + 0.12) * 1.6 + vec2(uTime * 0.006, uTime * 0.002);
      float n = vnoise(uv) * 0.55 + vnoise(uv * 2.3) * 0.3 + vnoise(uv * 5.1) * 0.15;
      float c = smoothstep(0.52, 0.78, n) * smoothstep(0.015, 0.22, h);
      col = mix(col, uCloudColor, c * uClouds);
    }
    if (uLinear > 0.5) col = pow(max(col, vec3(0.0)), vec3(2.2));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.quality = 'high';
    this.hour = 13;
    this.cycle = false;
    this.cycleSpeed = 24 / 300; // full day in 5 minutes
    this.night = 0;
    this.theme = THEMES.coastal;
    this.time = 0;

    // lights (persistent across tracks)
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -42;
    sc.right = 42;
    sc.top = 42;
    sc.bottom = -42;
    sc.near = 1;
    sc.far = 320;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0x5d5140, 1.1);
    scene.add(this.hemi);
    this.sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    this.lightDir = this.sunDir.clone();

    // sky
    const v3 = () => new THREE.Vector3();
    this.skyUniforms = {
      uTop: { value: v3() },
      uHorizon: { value: v3() },
      uBottom: { value: v3() },
      uSunDir: { value: v3() },
      uSunColor: { value: v3() },
      uMoonDir: { value: v3() },
      uCloudColor: { value: v3() },
      uStars: { value: 0 },
      uClouds: { value: 0.6 },
      uSunVis: { value: 1 },
      uMoonVis: { value: 0 },
      uTime: { value: 0 },
      uLinear: { value: 0 },
    };
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    scene.fog = new THREE.Fog(0xbcd6f0, 250, 1200);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(this.sky.geometry, skyMat);
    this.envScene.add(this.envSky);
    this.envTarget = null;
    this._envTimer = 0;
    this._envDirty = true;

    this.group = null; // track-specific objects
    this.lampGlows = null;
    this.nightMeshes = []; // meshes whose opacity follows the night factor
    this.windowMats = []; // building materials (emissive at night)
    this._tmpColor = new THREE.Color();
  }

  setQuality(q) {
    this.quality = q;
    const size = q === 'high' ? 2048 : 1024;
    const cast = q !== 'low';
    if (this.sun.castShadow !== cast || this.sun.shadow.mapSize.x !== size) {
      this.sun.castShadow = cast;
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    this.sun.shadow.radius = q === 'high' ? 2.5 : 1.5;
    if (this.treeMesh) this.treeMesh.castShadow = q === 'high';
  }

  // -------------------------------------------------------------------------
  // Time of day
  // -------------------------------------------------------------------------
  setTimeOfDay(hour) {
    this.hour = ((hour % 24) + 24) % 24;
    this._applyTime();
    this._envDirty = true;
  }

  _applyTime() {
    const h = this.hour;
    let i = 0;
    while (i < TOD_KEYS.length - 2 && TOD_KEYS[i + 1].h <= h) i++;
    const a = TOD_KEYS[i];
    const b = TOD_KEYS[i + 1];
    const t = smoothstep(0, 1, (h - a.h) / (b.h - a.h));
    const u = this.skyUniforms;
    const c = this._tmpColor;
    const toSRGB = (hexA, hexB, target) => {
      lerpHex(hexA, hexB, t, c);
      c.getRGB(_rgb, THREE.SRGBColorSpace);
      target.set(_rgb.r, _rgb.g, _rgb.b);
    };
    toSRGB(a.top, b.top, u.uTop.value);
    toSRGB(a.hor, b.hor, u.uHorizon.value);
    toSRGB(a.bottom, b.bottom, u.uBottom.value);
    toSRGB(a.cloud, b.cloud, u.uCloudColor.value);
    lerpHex(a.fog, b.fog, t, this.scene.fog.color);
    this.night = lerp(a.night, b.night, t);

    // sun path: rises ~6h in the east, sets ~19h in the west
    const dayT = (h - 6.2) / (19.2 - 6.2);
    const elev = Math.sin(clamp(dayT, -0.2, 1.2) * Math.PI) * 1.05;
    const az = lerp(-1.9, 1.9, dayT) + 0.6;
    this.sunDir.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev)).normalize();
    const moonDir = _v.set(-0.45, 0.62, -0.64).normalize();
    u.uSunDir.value.copy(this.sunDir);
    u.uMoonDir.value.copy(moonDir);
    const sunUp = smoothstep(-0.08, 0.06, this.sunDir.y);
    u.uSunVis.value = sunUp;
    u.uMoonVis.value = this.night;
    u.uStars.value = this.night;
    u.uClouds.value = (this.theme.clouds ?? 0.5) * (1 - this.night * 0.5);
    lerpHex(a.sun, b.sun, t, c);
    c.getRGB(_rgb, THREE.SRGBColorSpace);
    u.uSunColor.value.set(_rgb.r, _rgb.g, _rgb.b);

    // the directional light is the sun by day and the moon by night
    this.lightDir.copy(sunUp > 0.3 ? this.sunDir : moonDir);
    if (sunUp > 0.3 && this.lightDir.y < 0.12) this.lightDir.y = 0.12;
    this.lightDir.normalize();
    lerpHex(a.sun, b.sun, t, this.sun.color);
    this.sun.intensity = lerp(a.sunI, b.sunI, t);
    lerpHex(a.hemiS, b.hemiS, t, this.hemi.color);
    lerpHex(a.hemiG, b.hemiG, t, this.hemi.groundColor);
    this.hemi.intensity = lerp(a.hemiI, b.hemiI, t) * (this.theme === THEMES.city ? 1.15 : 1);
    this.scene.environmentIntensity = lerp(a.env, b.env, t);

    // night-dependent materials
    for (const m of this.windowMats) {
      m.emissiveIntensity = lerp(0.04, 1.25, this.night);
      const dayMap = m.userData.dayMap;
      const nightMap = m.userData.nightMap;
      const want = this.night > 0.45 ? nightMap : dayMap;
      if (want && m.map !== want) {
        m.map = want;
        m.emissiveMap = nightMap;
        m.needsUpdate = true;
      }
    }
    for (const nm of this.nightMeshes) {
      const k = clamp(lerp(nm.userData.dayAlpha ?? 0, 1, this.night), 0, 1);
      nm.material.opacity = k * (nm.userData.alpha ?? 1);
      nm.visible = nm.material.opacity > 0.01;
    }
    if (this.lampGlows) this.lampGlows.material.uniforms.uIntensity.value = smoothstep(0.2, 0.7, this.night);
    if (this.signGlows) this.signGlows.material.uniforms.uIntensity.value = lerp(0.25, 1, this.night);
  }

  _updateEnvMap() {
    this.skyUniforms.uLinear.value = 1;
    const old = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 1, 1200);
    this.skyUniforms.uLinear.value = 0;
    this.scene.environment = this.envTarget.texture;
    if (old) old.dispose();
    this._envDirty = false;
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------
  update(dt, focus, camera) {
    this.time += dt;
    this.skyUniforms.uTime.value = this.time;
    if (this.cycle) {
      this.hour = (this.hour + dt * this.cycleSpeed) % 24;
      this._applyTime();
      this._envTimer += dt;
      if (this._envTimer > 6) {
        this._envTimer = 0;
        this._envDirty = true;
      }
    }
    if (this._envDirty) this._updateEnvMap();
    this.sky.position.copy(camera.position);
    // shadow camera follows the focus point; snap to texels to avoid shimmer
    const texel = (this.sun.shadow.camera.right * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.lightDir.x * 150, focus.y + this.lightDir.y * 150, fz + this.lightDir.z * 150);
    this.sun.target.updateMatrixWorld();
  }

  // -------------------------------------------------------------------------
  // Building a world
  // -------------------------------------------------------------------------
  /**
   * Build all static content for a track (or free roam).
   * @param {object} def track definition
   * @param {import('./track.js').TrackPath|null} path
   * @param {(p:number)=>void} onProgress
   */
  async build(def, path, onProgress = () => {}) {
    this.dispose();
    const theme = THEMES[def.theme] || THEMES.coastal;
    this.theme = theme;
    this.def = def;
    this.path = path;
    const group = new THREE.Group();
    group.name = 'environment';
    this.group = group;
    this.scene.add(group);
    this.nightMeshes = [];
    this.windowMats = [];
    this.scene.fog.near = theme.fog[0];
    this.scene.fog.far = theme.fog[1];
    const rng = makeRng(hashString(def.id));

    onProgress(0.05);
    await nextFrame();

    // ---- height function ----------------------------------------------------
    const base = def.baseHeight || makeBaseHeight(def.theme);
    this.lake = null;
    if (def.theme === 'coastal' && path) this.lake = placeLake(path, theme);
    const lake = this.lake;
    const blend = theme.blend ?? 40;
    const wall = path ? path.wallOffset : 0;
    const q = {};
    this.heightAt = (x, z) => {
      let h = base(x, z);
      if (lake) {
        const d = Math.hypot(x - lake.x, z - lake.z);
        h = lerp(h, lake.level - 4, 1 - smoothstep(lake.r * 0.75, lake.r * 1.2, d));
      }
      if (path) {
        const idx = path.nearestIndex(x, z, wall + blend + 6);
        if (idx >= 0) {
          path.project(x, z, idx, q);
          const t = smoothstep(wall + 8, wall + blend, Math.abs(q.lateral));
          h = lerp(q.height - 0.35, h, t);
        }
      }
      return h;
    };
    this.groundHeight = this.heightAt;

    // ---- textures -------------------------------------------------------------
    const tex = {};
    tex.ground = TEX.groundTexture(def.theme, { ...theme.ground, seed: 11 });
    if (path) {
      tex.road = TEX.roadTexture(def.theme, theme.road);
      tex.curb = TEX.curbTexture();
      tex.runoff = TEX.groundTexture(def.theme + '-runoff', { ...theme.runoffTex, seed: 21 });
      tex.rail = TEX.railTexture(theme.rail);
      tex.checker = TEX.checkerTexture(16, 2);
      tex.banner = TEX.bannerTexture();
      tex.gridSlot = TEX.gridSlotTexture();
    }
    onProgress(0.15);
    await nextFrame();

    // ---- terrain ------------------------------------------------------------------
    let extent;
    let cx = 0;
    let cz = 0;
    if (path) {
      const b = path.bounds;
      cx = (b.minX + b.maxX) / 2;
      cz = (b.minZ + b.maxZ) / 2;
      extent = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 420;
    } else {
      extent = def.extent ?? 700;
    }
    this.center = new THREE.Vector3(cx, 0, cz);
    this.extent = extent;
    const terrain = buildTerrain(def.terrainHeight || this.heightAt, cx, cz, extent, tex.ground, def.theme, this.quality);
    if (def.heightAt) this.heightAt = this.groundHeight = def.heightAt;
    group.add(terrain);
    onProgress(0.4);
    await nextFrame();

    // ---- track ------------------------------------------------------------------------
    if (path) {
      const style = {
        rail: theme.rail,
        roadRoughness: theme.roadRoughness,
        roadMetalness: theme.roadMetalness,
        lampSpacing: theme.lampSpacing,
      };
      const built = buildTrackMeshes(path, style, tex);
      group.add(built.group);
      this.startLights = built.startLights;
      this.lampPositions = built.lampPositions;
      this.roadMesh = built.road;
    } else {
      this.startLights = [];
      this.lampPositions = def.lampPositions || [];
    }
    onProgress(0.55);
    await nextFrame();

    // ---- distant mountains ---------------------------------------------------------------
    if (theme.mountains) group.add(buildMountains(cx, cz, extent, theme.mountains, rng));

    // ---- theme decoration -------------------------------------------------------------------
    const ctx = { group, rng, path, wall, heightAt: this.heightAt, cx, cz, extent, env: this, quality: this.quality, lake };
    if (def.decorate) def.decorate(ctx);
    else if (def.theme === 'coastal') decorateCoastal(ctx);
    else if (def.theme === 'city') decorateCity(ctx);
    else if (def.theme === 'canyon') decorateCanyon(ctx);
    if (path) decorateBillboards(ctx);
    onProgress(0.8);
    await nextFrame();

    // ---- lamp glows / pools ------------------------------------------------------------------------
    this._buildLampFx(theme, def.theme === 'city');
    onProgress(0.92);

    this.setQuality(this.quality);
    this._applyTime();
    this._envDirty = true;
    onProgress(1);
    return group;
  }

  _buildLampFx(theme, wet) {
    const lamps = this.lampPositions || [];
    if (!lamps.length) return;
    const [lr, lg, lb] = theme.lampColor;
    const glows = new GlowPoints(lamps.length);
    lamps.forEach((p, i) => glows.set(i, p.x, p.y - 0.15, p.z, 5.5, lr, lg, lb, 0.9));
    glows.commit();
    this.group.add(glows.points);
    this.lampGlows = glows;

    // light pools on the ground (+ wet reflections in the city)
    const pools = [];
    const streaks = [];
    const path = this.path;
    const q = {};
    for (const p of lamps) {
      const h = path ? (path.project(p.x, p.z, -1, q), q.height) : this.heightAt(p.x, p.z);
      const pool = new THREE.PlaneGeometry(13, 13);
      pool.rotateX(-Math.PI / 2);
      pool.translate(p.x, h + 0.06, p.z);
      pools.push(pool);
      if (wet && path) {
        // streak on the road, stretched along the track direction
        const lat = clamp(q.lateral, -path.halfWidth + 1, path.halfWidth - 1);
        const s = q.s;
        const pt = path.pointAt(s, lat, new THREE.Vector3());
        const st = new THREE.PlaneGeometry(2.4, 16);
        st.rotateX(-Math.PI / 2);
        st.rotateY(path.headingAt(s));
        st.translate(pt.x, pt.y + 0.07, pt.z);
        streaks.push(st);
      }
    }
    const poolMat = new THREE.MeshBasicMaterial({
      map: TEX.glowTexture(),
      color: new THREE.Color(lr, lg, lb).multiplyScalar(0.55),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -8,
    });
    const poolMesh = new THREE.Mesh(mergeGeometries(pools), poolMat);
    pools.forEach((g) => g.dispose());
    poolMesh.renderOrder = 2;
    poolMesh.userData.alpha = 1;
    this.group.add(poolMesh);
    this.nightMeshes.push(poolMesh);
    if (streaks.length) {
      const stMat = new THREE.MeshBasicMaterial({
        map: TEX.streakTexture(),
        color: new THREE.Color(lr, lg, lb).multiplyScalar(0.9),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -9,
        polygonOffsetUnits: -9,
      });
      const stMesh = new THREE.Mesh(mergeGeometries(streaks), stMat);
      streaks.forEach((g) => g.dispose());
      stMesh.renderOrder = 2;
      stMesh.userData.alpha = 1;
      this.group.add(stMesh);
      this.nightMeshes.push(stMesh);
    }
  }

  /** Start light colours during the countdown: n red lights lit, or green. */
  setStartLights(n, green = false) {
    if (!this.startLights) return;
    this.startLights.forEach((l, i) => {
      if (green) l.material.color.setHex(0x22ff55);
      else l.material.color.setHex(i < n ? 0xff1a1a : 0x220000);
    });
  }

  dispose() {
    if (this.group) {
      this.group.removeFromParent();
      disposeObject(this.group);
      this.group = null;
    }
    if (this.lampGlows) {
      this.lampGlows.dispose();
      this.lampGlows = null;
    }
    if (this.signGlows) {
      this.signGlows.dispose();
      this.signGlows = null;
    }
    this.treeMesh = null;
    this.water = null;
    this.nightMeshes = [];
    this.windowMats = [];
  }
}

const _rgb = { r: 0, g: 0, b: 0 };
const _v = new THREE.Vector3();

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Height functions
// ---------------------------------------------------------------------------
export function makeBaseHeight(theme) {
  switch (theme) {
    case 'city':
      return () => 0;
    case 'canyon':
      return (x, z) => {
        const r = ridged2(x / 340, z / 340, 4, 7);
        const m = fbm2(x / 520, z / 520, 2, 3) * 0.5 + 0.5;
        return 4 + Math.pow(r, 1.6) * 120 * m + fbm2(x / 70, z / 70, 2, 5) * 3;
      };
    case 'freeroam':
      return (x, z) => fbm2(x / 220, z / 220, 4, 13) * 10 + fbm2(x / 60, z / 60, 2, 17) * 1.2;
    case 'coastal':
    default:
      return (x, z) => 3 + fbm2(x / 260, z / 260, 4, 1) * 11 + fbm2(x / 80, z / 80, 2, 9) * 1.5;
  }
}

function placeLake(path, theme) {
  // find the largest clearance inside the track bounds for a lake
  const b = path.bounds;
  let best = null;
  for (let x = b.minX; x <= b.maxX; x += 20) {
    for (let z = b.minZ; z <= b.maxZ; z += 20) {
      // distance to the nearest track sample
      let d = Infinity;
      for (let i = 0; i < path.count; i += 3) d = Math.min(d, Math.hypot(path.px[i] - x, path.pz[i] - z));
      const r = d - path.wallOffset - 30;
      if (r > 40 && (!best || r > best.r)) best = { x, z, r: Math.min(r, 110) };
    }
  }
  if (!best) return null;
  best.level = 0.6;
  void theme;
  return best;
}

// ---------------------------------------------------------------------------
// Terrain mesh
// ---------------------------------------------------------------------------
function buildTerrain(heightAt, cx, cz, extent, map, theme, quality) {
  const seg = quality === 'low' ? 150 : quality === 'medium' ? 190 : 230;
  const size = extent * 2;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  geo.translate(cx, 0, cz);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const tint = theme === 'canyon' ? [0.9, 0.95, 1.05] : theme === 'city' ? [1, 1, 1] : [1, 1, 1];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);
    uv.setXY(i, (x - cx) / 14, (z - cz) / 14);
    const n = fbm2(x / 90, z / 90, 2, 77) * 0.5 + 0.5;
    let k = 0.82 + n * 0.3;
    if (theme === 'canyon') {
      const band = 0.9 + 0.1 * Math.sin(h * 0.35);
      k *= band * (h > 40 ? 1.05 : 1);
    }
    c.setRGB(k * tint[0], k * tint[1], k * tint[2]);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ map, vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

// ---------------------------------------------------------------------------
// Distant mountains ring (vertex coloured, fogged into silhouettes)
// ---------------------------------------------------------------------------
function buildMountains(cx, cz, extent, cfg, rng) {
  const segs = 180;
  const rows = 6;
  const r0 = extent * 0.96;
  const r1 = extent + 900;
  const pos = [];
  const col = [];
  const idx = [];
  const c0 = new THREE.Color(cfg.color0);
  const c1 = new THREE.Color(cfg.color1);
  const snow = new THREE.Color(0xf2f5f8);
  const seed = rng.int(1, 999);
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const n = ridged2(Math.cos(a) * 3 + 10, Math.sin(a) * 3 + 10, 4, seed);
    const peak = cfg.height * (0.35 + n * 1.1);
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const r = lerp(r0, r1, t);
      let h;
      if (cfg.mesa) {
        const p = smoothstep(0.15, 0.4, t) * (1 - smoothstep(0.85, 1, t));
        h = (p > 0.5 ? peak * 0.8 : peak * 0.8 * smoothstep(0, 0.5, p) ** 1.5) - 8;
      } else h = Math.sin(t * Math.PI) ** 1.3 * peak - 12 + (j === 0 ? -6 : 0);
      pos.push(cx + ca * r, h, cz + sa * r);
      const hk = clamp(h / (cfg.height * 1.2), 0, 1);
      const cc = c0.clone().lerp(c1, hk);
      if (cfg.snow && hk > 0.62) cc.lerp(snow, smoothstep(0.62, 0.8, hk));
      col.push(cc.r, cc.g, cc.b);
    }
  }
  for (let i = 0; i < segs; i++)
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j;
      const b = (i + 1) * (rows + 1) + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'mountains';
  return mesh;
}

// ---------------------------------------------------------------------------
// Instanced helpers
// ---------------------------------------------------------------------------
function vcolor(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const c = new THREE.Color(hex);
  const arr = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = c.r;
    arr[i + 1] = c.g;
    arr[i + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

function pineGeometry() {
  const trunk = vcolor(new THREE.CylinderGeometry(0.16, 0.26, 2, 5).translate(0, 1, 0), 0x5a3d26);
  const parts = [trunk];
  const tiers = [
    [2.0, 2.6, 1.6],
    [1.55, 2.3, 3.0],
    [1.05, 2.0, 4.3],
  ];
  for (const [r, h, y] of tiers) parts.push(vcolor(new THREE.ConeGeometry(r, h, 7).translate(0, y + h / 2 - 0.3, 0), 0x2f5d2a));
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

function roundTreeGeometry() {
  const trunk = vcolor(new THREE.CylinderGeometry(0.18, 0.28, 2.4, 5).translate(0, 1.2, 0), 0x5e4029);
  const crown = vcolor(new THREE.IcosahedronGeometry(2.1, 0).scale(1, 1.15, 1).translate(0, 3.6, 0), 0x4b7d2c);
  const crown2 = vcolor(new THREE.IcosahedronGeometry(1.4, 0).translate(0.9, 4.6, 0.3), 0x5a8c34);
  const g = mergeGeometries([trunk, crown, crown2]);
  [trunk, crown, crown2].forEach((p) => p.dispose());
  return g;
}

function cactusGeometry() {
  const c = 0x4f7a3a;
  const parts = [
    vcolor(new THREE.CylinderGeometry(0.32, 0.36, 4.2, 7).translate(0, 2.1, 0), c),
    vcolor(new THREE.CylinderGeometry(0.22, 0.22, 1.2, 6).rotateZ(Math.PI / 2).translate(0.7, 1.8, 0), c),
    vcolor(new THREE.CylinderGeometry(0.22, 0.22, 1.5, 6).translate(1.25, 2.5, 0), c),
    vcolor(new THREE.CylinderGeometry(0.2, 0.2, 1.0, 6).rotateZ(Math.PI / 2).translate(-0.6, 2.6, 0), c),
    vcolor(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 6).translate(-1.05, 3.1, 0), c),
  ];
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

function rockGeometry(seed = 3) {
  const g = new THREE.DodecahedronGeometry(1, 1);
  const p = g.attributes.position;
  const rng = makeRng(seed);
  const cache = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let k = cache.get(key);
    if (k == null) {
      k = 0.75 + rng() * 0.5;
      cache.set(key, k);
    }
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.75, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return vcolor(g, 0xffffff);
}

/**
 * Scatter instances: tries random points, rejecting those too close to the
 * track, in the lake or outside the terrain. Returns an InstancedMesh.
 */
function scatter(ctx, geo, mat, count, opts = {}) {
  const { rng, path, wall, heightAt, cx, cz, extent, lake } = ctx;
  const {
    minTrack = wall + 4,
    maxTrack = Infinity,
    scale = [0.8, 1.4],
    yScale = null,
    colors = null,
    sink = 0.1,
    tilt = 0,
    range = extent * 0.92,
    test = null,
  } = opts;
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  let n = 0;
  let tries = 0;
  while (n < count && tries < count * 25) {
    tries++;
    const x = cx + (rng() * 2 - 1) * range;
    const z = cz + (rng() * 2 - 1) * range;
    if (path) {
      const near = path.nearestIndex(x, z, minTrack);
      if (near >= 0) continue;
      if (maxTrack < Infinity && path.nearestIndex(x, z, maxTrack) < 0) continue;
    }
    if (lake && Math.hypot(x - lake.x, z - lake.z) < lake.r * 1.25) continue;
    if (test && !test(x, z)) continue;
    const h = heightAt(x, z);
    const sc = scale[0] + rng() * (scale[1] - scale[0]);
    const sy = yScale ? sc * (yScale[0] + rng() * (yScale[1] - yScale[0])) : sc;
    p.set(x, h - sink * sc, z);
    e.set((rng() - 0.5) * tilt, rng() * TAU, (rng() - 0.5) * tilt);
    q.setFromEuler(e);
    s.set(sc, sy, sc);
    m.compose(p, q, s);
    mesh.setMatrixAt(n, m);
    if (colors) {
      col.set(rng.pick(colors));
      const k = 0.85 + rng() * 0.3;
      col.multiplyScalar(k);
      mesh.setColorAt(n, col);
    }
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

const density = (q) => (q === 'low' ? 0.45 : q === 'medium' ? 0.7 : 1);

// ---------------------------------------------------------------------------
// Theme decorations
// ---------------------------------------------------------------------------
function decorateCoastal(ctx) {
  const { group, env, lake, quality } = ctx;
  const d = density(quality);
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const pines = scatter(ctx, pineGeometry(), treeMat, Math.floor(650 * d), {
    scale: [0.9, 1.7],
    colors: ['#ffffff', '#d8e8c8', '#c0d8b0'],
  });
  pines.castShadow = quality === 'high';
  group.add(pines);
  env.treeMesh = pines;
  const round = scatter(ctx, roundTreeGeometry(), treeMat, Math.floor(380 * d), {
    scale: [0.8, 1.5],
    colors: ['#ffffff', '#e8f0c8', '#f0d8a0'],
  });
  round.castShadow = quality === 'high';
  group.add(round);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x8a8a84 });
  group.add(scatter(ctx, rockGeometry(4), rockMat, Math.floor(120 * d), { scale: [0.6, 2.2], colors: ['#9a9890', '#7f7d77'], sink: 0.3 }));

  if (lake) {
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(lake.r * 1.25, 56).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1d5a78, roughness: 0.22, metalness: 0.0, envMapIntensity: 0.55 }),
    );
    water.position.set(lake.x, lake.level, lake.z);
    water.receiveShadow = true;
    group.add(water);
    env.water = water;
    // a little jetty
    const jetty = new THREE.Mesh(new THREE.BoxGeometry(3, 0.3, 22), new THREE.MeshLambertMaterial({ color: 0x7a5a3a }));
    jetty.position.set(lake.x + lake.r * 0.9, lake.level + 0.5, lake.z);
    jetty.rotation.y = 1.2;
    group.add(jetty);
  }
  group.add(buildHouses(ctx, Math.floor(14 * Math.max(0.6, d))));
}

function buildHouses(ctx, count) {
  const { rng, path, wall, heightAt, cx, cz, extent, lake } = ctx;
  const parts = [];
  let n = 0;
  let tries = 0;
  const walls = ['#f1ece0', '#e6d9c2', '#f4f4f4', '#d9c7a6', '#c9d6e0'];
  const roofs = ['#a5442f', '#7b3b2a', '#4b4f57', '#8a5a3a'];
  while (n < count && tries < 600) {
    tries++;
    const x = cx + (rng() * 2 - 1) * extent * 0.7;
    const z = cz + (rng() * 2 - 1) * extent * 0.7;
    if (path.nearestIndex(x, z, wall + 14) >= 0) continue;
    if (path.nearestIndex(x, z, wall + 90) < 0) continue; // keep them visible from the road
    if (lake && Math.hypot(x - lake.x, z - lake.z) < lake.r * 1.3) continue;
    const w = 6 + rng() * 5;
    const l = 8 + rng() * 6;
    const h = 3 + rng() * 2;
    const y = heightAt(x, z) - 0.3;
    const rot = rng() * TAU;
    const body = vcolor(new THREE.BoxGeometry(w, h, l).translate(0, h / 2, 0), rng.pick(walls));
    const roofGeo = new THREE.CylinderGeometry(0.01, w * 0.72, 2.4, 4, 1);
    roofGeo.rotateY(Math.PI / 4);
    roofGeo.scale(1, 1, l / w);
    roofGeo.translate(0, h + 1.2, 0);
    const roof = vcolor(roofGeo, rng.pick(roofs));
    const chimney = vcolor(new THREE.BoxGeometry(0.7, 1.6, 0.7).translate(w * 0.25, h + 1.6, l * 0.2), '#6b5a4a');
    for (const g of [body, roof, chimney]) {
      g.rotateY(rot);
      g.translate(x, y, z);
      parts.push(g);
    }
    n++;
  }
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function decorateCanyon(ctx) {
  const { group, quality } = ctx;
  const d = density(quality);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const rocks = scatter(ctx, rockGeometry(9), rockMat, Math.floor(420 * d), {
    scale: [0.7, 4.5],
    colors: ['#a35f3a', '#b9774c', '#8c4f30', '#c98d5f'],
    sink: 0.35,
    tilt: 0.5,
  });
  rocks.castShadow = quality === 'high';
  group.add(rocks);
  ctx.env.treeMesh = rocks;
  // big boulders closer to the road
  group.add(
    scatter(ctx, rockGeometry(13), rockMat, Math.floor(70 * d), {
      scale: [4, 9],
      colors: ['#9c5634', '#b0693f'],
      sink: 0.4,
      tilt: 0.3,
      maxTrack: ctx.wall + 60,
      minTrack: ctx.wall + 10,
    }),
  );
  const cactusMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  group.add(scatter(ctx, cactusGeometry(), cactusMat, Math.floor(220 * d), { scale: [0.7, 1.4], colors: ['#ffffff', '#d0e0b0'], sink: 0.05 }));
  const bushMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  group.add(
    scatter(ctx, vcolor(new THREE.IcosahedronGeometry(0.8, 0), 0xffffff), bushMat, Math.floor(300 * d), {
      scale: [0.5, 1.3],
      yScale: [0.5, 0.8],
      colors: ['#8a7a4a', '#a08850', '#6e6a3a'],
      sink: 0.1,
    }),
  );
}

function decorateCity(ctx) {
  const { group, rng, path, wall, cx, cz, extent, env } = ctx;
  const b = path.bounds;
  const parts = [];
  const neon = [];
  const signGlowPts = [];
  const cell = 34;
  const x0 = b.minX - 260;
  const x1 = b.maxX + 260;
  const z0 = b.minZ - 260;
  const z1 = b.maxZ + 260;
  const q = {};
  const addBox = (x, z, w, dpt, h, rot) => {
    const g = new THREE.BoxGeometry(w, h, dpt);
    // UVs: one texture repeat = 16 m wide x 24 m tall (8 columns x 8 floors)
    const uv = g.attributes.uv;
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    for (let i = 0; i < uv.count; i++) {
      const nx = nrm.getX(i);
      const ny = nrm.getY(i);
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      if (Math.abs(ny) > 0.5) uv.setXY(i, 0.003, 0.003);
      else if (Math.abs(nx) > 0.5) uv.setXY(i, (pz + dpt / 2) / 16, (py + h / 2) / 24);
      else uv.setXY(i, (px + w / 2) / 16, (py + h / 2) / 24);
    }
    g.translate(0, h / 2, 0);
    g.rotateY(rot);
    g.translate(x, -0.2, z);
    parts.push(g);
  };
  for (let x = x0; x <= x1; x += cell) {
    for (let z = z0; z <= z1; z += cell) {
      const jx = x + (rng() - 0.5) * 6;
      const jz = z + (rng() - 0.5) * 6;
      const w = 16 + rng() * 12;
      const dpt = 16 + rng() * 12;
      const r = Math.hypot(w, dpt) / 2;
      const near = path.nearestIndex(jx, jz, wall + 8 + r);
      if (near >= 0) continue;
      const nearIdx = path.nearestIndex(jx, jz, 120);
      const dist = nearIdx >= 0 ? Math.hypot(path.px[nearIdx] - jx, path.pz[nearIdx] - jz) : 200;
      const h = 14 + rng() * 26 + smoothstep(30, 200, dist) * rng() * 70;
      addBox(jx, jz, w, dpt, h, 0);
      if (rng() < 0.35) addBox(jx, jz, w * 0.6, dpt * 0.6, h + 8 + rng() * 20, 0);
      // neon sign on the facade facing the road
      if (nearIdx >= 0 && dist < wall + r + 40 && rng() < 0.75) {
        path.project(jx, jz, nearIdx, q);
        // direction from building toward the road
        const tx = path.px[q.index] - jx;
        const tz = path.pz[q.index] - jz;
        const ax = Math.abs(tx) > Math.abs(tz);
        const fx = ax ? Math.sign(tx) : 0;
        const fz = ax ? 0 : Math.sign(tz);
        const half = ax ? w / 2 : dpt / 2;
        const sx = jx + fx * (half + 0.25);
        const sz = jz + fz * (half + 0.25);
        const sy = 7 + rng() * Math.min(14, h - 9);
        const k = rng.int(0, TEX.NEON_SIGN_COUNT - 1);
        const sw = 7 + rng() * 3;
        const sh = sw / 4;
        const sg = new THREE.PlaneGeometry(sw, sh);
        const uv = sg.attributes.uv;
        const v0 = 1 - (k + 1) / TEX.NEON_SIGN_COUNT;
        const v1 = 1 - k / TEX.NEON_SIGN_COUNT;
        for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) > 0.5 ? v1 : v0);
        sg.rotateY(Math.atan2(fx, fz));
        sg.translate(sx, sy, sz);
        neon.push(sg);
        const col = new THREE.Color(TEX.NEON_SIGN_COLORS[k]);
        signGlowPts.push([sx + fx * 1.5, sy, sz + fz * 1.5, col]);
      }
    }
  }
  // distant skyline
  for (let i = 0; i < 70; i++) {
    const a = rng() * TAU;
    const r = extent * (0.75 + rng() * 0.2);
    const w = 20 + rng() * 25;
    addBox(cx + Math.cos(a) * r, cz + Math.sin(a) * r, w, w, 60 + rng() * 120, rng() * TAU);
  }
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  const nightMap = TEX.windowsTexture(5);
  const dayMap = TEX.facadeTexture(6);
  const mat = new THREE.MeshLambertMaterial({ map: nightMap, emissiveMap: nightMap, emissive: 0xffffff, emissiveIntensity: 1 });
  mat.userData.dayMap = dayMap;
  mat.userData.nightMap = nightMap;
  env.windowMats.push(mat);
  const buildings = new THREE.Mesh(geo, mat);
  buildings.castShadow = true;
  buildings.receiveShadow = true;
  group.add(buildings);

  if (neon.length) {
    const nGeo = mergeGeometries(neon);
    neon.forEach((g) => g.dispose());
    const nMat = new THREE.MeshBasicMaterial({
      map: TEX.neonAtlas(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const nMesh = new THREE.Mesh(nGeo, nMat);
    nMesh.userData.dayAlpha = 0.45;
    nMesh.renderOrder = 3;
    group.add(nMesh);
    env.nightMeshes.push(nMesh);
    const glows = new GlowPoints(signGlowPts.length);
    signGlowPts.forEach(([x, y, z, c], i) => glows.set(i, x, y, z, 16, c.r, c.g, c.b, 0.55));
    glows.commit();
    group.add(glows.points);
    env.signGlows = glows;
  }
}

function decorateBillboards(ctx) {
  const { group, rng, path, wall } = ctx;
  const parts = [];
  const n = Math.max(4, Math.floor(path.length / 260));
  const rows = TEX.BILLBOARD_COUNT;
  for (let k = 0; k < n; k++) {
    const i = Math.floor(((k + 0.5) / n) * path.count);
    if (Math.abs(path.curvSmooth[i]) > 1 / 120) continue; // straights only
    const side = k % 2 ? 1 : -1;
    const off = side * (wall + 3.5);
    const x = path.px[i] - path.tz[i] * off;
    const z = path.pz[i] + path.tx[i] * off;
    const y = path.py[i];
    const yaw = Math.atan2(side * path.tz[i], -side * path.tx[i]); // face the track
    const row = rng.int(0, rows - 1);
    const panel = new THREE.BoxGeometry(12, 3, 0.3);
    const uv = panel.attributes.uv;
    const nrm = panel.attributes.normal;
    const v0 = 1 - (row + 1) / rows;
    const v1 = 1 - row / rows;
    for (let j = 0; j < uv.count; j++) {
      if (Math.abs(nrm.getZ(j)) > 0.5) uv.setXY(j, nrm.getZ(j) > 0 ? uv.getX(j) : 1 - uv.getX(j), lerp(v0, v1, uv.getY(j)));
      else uv.setXY(j, 0.01, v0 + 0.01);
    }
    panel.translate(0, 4.6, 0);
    const posts = [new THREE.BoxGeometry(0.3, 3.2, 0.3).translate(-4.5, 1.6, 0), new THREE.BoxGeometry(0.3, 3.2, 0.3).translate(4.5, 1.6, 0)];
    for (const pg of posts) {
      const u2 = pg.attributes.uv;
      for (let j = 0; j < u2.count; j++) u2.setXY(j, 0.01, v0 + 0.01);
    }
    for (const g of [panel, ...posts]) {
      g.rotateY(yaw);
      g.translate(x, y, z);
      parts.push(g);
    }
  }
  if (!parts.length) return;
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: TEX.billboardAtlas() }));
  mesh.castShadow = true;
  group.add(mesh);
}
