// Camera rig: chase (far / close) and hood views with spring-damped follow,
// speed-based FOV, look-behind, trauma-based shake, ground / wall anti-clipping,
// plus orbit and intro-sweep modes used by menus and the countdown.

import * as THREE from 'three';
import { clamp, damp, lerp, lerpAngle, smoothstep, valueNoise2, wrapAngle } from './utils.js';

export const CAMERA_MODES = [
  { name: 'Chase', dist: 7.4, height: 2.55, lookAhead: 3.5, lookHeight: 1.05, fov: 62 },
  { name: 'Close', dist: 5.2, height: 1.75, lookAhead: 3, lookHeight: 0.95, fov: 66 },
  { name: 'Hood', fov: 74 },
];

const _v = new THREE.Vector3();
const _look = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _q = {};

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 0;
    this.lookBehind = false;
    this.trauma = 0;
    this.time = 0;
    this.yaw = 0;
    this.pos = new THREE.Vector3(0, 5, -10);
    this.lookAt = new THREE.Vector3();
    this.fov = 62;
    this.boostFov = 0;
    this.state = 'chase'; // chase | orbit | intro
    this.orbit = { center: new THREE.Vector3(), radius: 8, height: 2.5, speed: 0.15, angle: 0, lookHeight: 0.8 };
    this.introT = 0;
    this.introDur = 3;
    this.groundHeight = null; // (x, z) => y
    this.path = null; // TrackPath for wall clamping
    this._snap = true;
    this.viewShift = 0; // horizontal framing offset (fraction of width) for menus
    this._appliedShift = 0;
    this._appliedAspect = 0;
  }

  /** Shift the projection so the subject sits left (+) or right (-) of centre. */
  _applyViewShift() {
    const cam = this.camera;
    if (this.viewShift === this._appliedShift && (this.viewShift === 0 || cam.aspect === this._appliedAspect)) return;
    this._appliedShift = this.viewShift;
    this._appliedAspect = cam.aspect;
    if (this.viewShift === 0) cam.clearViewOffset();
    else {
      const h = 1000;
      const w = h * cam.aspect;
      cam.setViewOffset(w, h, w * this.viewShift, 0, w, h);
    }
  }

  setMode(m) {
    this.mode = ((m % CAMERA_MODES.length) + CAMERA_MODES.length) % CAMERA_MODES.length;
    this._snap = true;
  }

  cycleMode() {
    this.setMode(this.mode + 1);
    return this.mode;
  }

  addTrauma(t) {
    this.trauma = Math.min(1, this.trauma + t);
  }

  /** Snap behind the car on the next update (after respawn / start). */
  snap() {
    this._snap = true;
  }

  setOrbit(center, radius = 8, height = 2.5, speed = 0.15, lookHeight = 0.8) {
    this.state = 'orbit';
    this.orbit.center.copy(center);
    this.orbit.radius = radius;
    this.orbit.height = height;
    this.orbit.speed = speed;
    this.orbit.lookHeight = lookHeight;
  }

  startIntro(duration = 3) {
    this.state = 'intro';
    this.introT = 0;
    this.introDur = duration;
  }

  follow() {
    this.state = 'chase';
    this._snap = true;
  }

  /**
   * @param {number} dt
   * @param {import('./car.js').Car} car player car (may be null in orbit mode)
   */
  update(dt, car) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const cam = this.camera;
    this._applyViewShift();

    if (this.state === 'orbit' || !car) {
      const o = this.orbit;
      o.angle += dt * o.speed;
      cam.position.set(
        o.center.x + Math.sin(o.angle) * o.radius,
        o.center.y + o.height,
        o.center.z + Math.cos(o.angle) * o.radius,
      );
      this._clampGround(cam.position, 0.6);
      _look.set(o.center.x, o.center.y + o.lookHeight, o.center.z);
      cam.lookAt(_look);
      this._setFov(58, dt, true);
      return;
    }

    const ph = car.physics;
    const root = car.root;
    const speed = ph.speed;
    const fx = Math.sin(root.rotation.y);
    const fz = Math.cos(root.rotation.y);
    this.boostFov += ((ph.boosting ? 1 : 0) - this.boostFov) * damp(4, dt);
    if (ph.boosting) this.trauma = Math.max(this.trauma, 0.12);

    if (this.state === 'intro') {
      // sweep from a low front-quarter view to the chase position
      this.introT += dt;
      const t = smoothstep(0, 1, this.introT / this.introDur);
      const a = root.rotation.y + lerp(2.4, Math.PI, t);
      const d = lerp(9, CAMERA_MODES[0].dist, t);
      const h = lerp(1.4, CAMERA_MODES[0].height, t);
      cam.position.set(root.position.x + Math.sin(a) * -d, root.position.y + h, root.position.z + Math.cos(a) * -d);
      this._clampGround(cam.position, 0.5);
      _look.set(root.position.x, root.position.y + 0.9, root.position.z);
      cam.lookAt(_look);
      this.yaw = root.rotation.y;
      this.pos.copy(cam.position);
      this._setFov(CAMERA_MODES[0].fov, dt, true);
      if (this.introT >= this.introDur) this.state = 'chase';
      return;
    }

    const mode = CAMERA_MODES[this.mode];
    if (this.mode === 2 && !this.lookBehind) {
      // hood camera: rigidly attached, looks along the car
      _v.set(0, 1.08, 0.25);
      root.localToWorld(_v);
      cam.position.copy(_v);
      _look.set(0, 0.95, 20);
      root.localToWorld(_look);
      cam.up.set(0, 1, 0);
      cam.lookAt(_look);
      this.pos.copy(cam.position);
      this.yaw = root.rotation.y;
      this._applyShake(0.4);
      this._setFov(mode.fov + smoothstep(10, 80, speed) * 12 + this.boostFov * 10, dt, this._snap);
      this._snap = false;
      return;
    }

    const m = this.mode === 2 ? CAMERA_MODES[0] : mode;
    // camera yaw lags the car; in a drift it shows some of the slide
    const drift = ph.drifting ? clamp(-ph.slipAngle * 0.45, -0.5, 0.5) : 0;
    let targetYaw = root.rotation.y + drift;
    if (ph.forwardSpeed < -3) targetYaw = root.rotation.y; // reversing: stay behind
    if (this._snap) this.yaw = targetYaw;
    else this.yaw = lerpAngle(this.yaw, targetYaw, damp(ph.grounded ? 4.2 : 1.8, dt));
    this.yaw = wrapAngle(this.yaw);
    const dir = this.lookBehind ? -1 : 1;
    const dist = m.dist + speed * 0.025;
    const cy = Math.sin(this.yaw);
    const cz = Math.cos(this.yaw);
    _desired.set(
      root.position.x - cy * dist * dir,
      root.position.y + m.height + speed * 0.006,
      root.position.z - cz * dist * dir,
    );
    if (this._snap || this.lookBehind !== this._lastBehind) this.pos.copy(_desired);
    else {
      const kh = damp(12, dt);
      const kv = damp(6, dt);
      this.pos.x += (_desired.x - this.pos.x) * kh;
      this.pos.z += (_desired.z - this.pos.z) * kh;
      this.pos.y += (_desired.y - this.pos.y) * kv;
    }
    this._lastBehind = this.lookBehind;
    this._clampWalls(this.pos);
    this._clampGround(this.pos, 0.7);
    cam.position.copy(this.pos);
    _look.set(
      root.position.x + fx * m.lookAhead * dir,
      root.position.y + m.lookHeight,
      root.position.z + fz * m.lookAhead * dir,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);
    this._applyShake(1);
    this._setFov(m.fov + smoothstep(8, 85, speed) * 14 + this.boostFov * 9, dt, this._snap);
    this._snap = false;
    void fz;
  }

  _applyShake(scale) {
    if (this.trauma <= 0.001) return;
    const t = this.trauma * this.trauma * scale;
    const s = this.time * 28;
    const cam = this.camera;
    cam.position.x += valueNoise2(s, 1.3) * 0.32 * t;
    cam.position.y += valueNoise2(s, 7.1) * 0.22 * t;
    cam.position.z += valueNoise2(s, 13.7) * 0.32 * t;
    cam.rotateZ(valueNoise2(s, 21.1) * 0.035 * t);
  }

  _setFov(target, dt, snap) {
    this.fov = snap ? target : this.fov + (target - this.fov) * damp(5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _clampGround(p, margin) {
    if (!this.groundHeight) return;
    const h = this.groundHeight(p.x, p.z);
    if (p.y < h + margin) p.y = h + margin;
  }

  _clampWalls(p) {
    const path = this.path;
    if (!path) return;
    const q = path.project(p.x, p.z, -1, _q);
    const lim = path.wallOffset - 0.7;
    if (Math.abs(q.lateral) > lim && Math.abs(q.lateral) < path.wallOffset + 6) {
      const over = Math.abs(q.lateral) - lim;
      const side = Math.sign(q.lateral);
      // move back toward the centre line (right vector = (-tz, tx))
      p.x -= -q.tz * over * side;
      p.z -= q.tx * over * side;
      const roadY = q.height + 0.9;
      if (p.y < roadY) p.y = roadY;
    }
  }
}
