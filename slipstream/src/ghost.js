// Time-trial ghost: records the player's transform at 20 Hz and replays the
// best lap with interpolation.

import { lerp, lerpAngle } from './utils.js';

export const GHOST_HZ = 20;
const STRIDE = 5; // x, y, z, yaw, pitch
const MAX_SECONDS = 240;

export class GhostRecorder {
  constructor() {
    this.buf = new Float32Array(GHOST_HZ * MAX_SECONDS * STRIDE);
    this.frames = 0;
    this.active = false;
  }

  start() {
    this.frames = 0;
    this.active = true;
  }

  /** Call every physics step with the lap time (seconds). */
  record(t, ph) {
    if (!this.active) return;
    const want = Math.floor(t * GHOST_HZ) + 1;
    while (this.frames < want) {
      if ((this.frames + 1) * STRIDE > this.buf.length) {
        this.active = false; // lap too long to store
        return;
      }
      const o = this.frames * STRIDE;
      this.buf[o] = ph.pos.x;
      this.buf[o + 1] = ph.pos.y;
      this.buf[o + 2] = ph.pos.z;
      this.buf[o + 3] = ph.yaw;
      this.buf[o + 4] = ph.pitch;
      this.frames++;
    }
  }

  /** Copy of the recorded lap, or null if recording overflowed. */
  finish() {
    const ok = this.active && this.frames > 2;
    this.active = false;
    return ok ? this.buf.slice(0, this.frames * STRIDE) : null;
  }
}

export class GhostPlayer {
  /**
   * @param {Float32Array} data
   * @param {import('./car.js').Car} car ghost-styled car (visual only)
   */
  constructor(data, car) {
    this.data = data;
    this.car = car;
    this.frames = Math.floor(data.length / STRIDE);
  }

  get duration() {
    return this.frames / GHOST_HZ;
  }

  /** Position the ghost at lap time t (seconds). */
  update(t) {
    const f = t * GHOST_HZ;
    const root = this.car.root;
    if (f < 0 || f >= this.frames - 1) {
      root.visible = false;
      return;
    }
    root.visible = true;
    const i = Math.floor(f);
    const a = f - i;
    const d = this.data;
    const o = i * STRIDE;
    const n = o + STRIDE;
    root.position.set(lerp(d[o], d[n], a), lerp(d[o + 1], d[n + 1], a), lerp(d[o + 2], d[n + 2], a));
    root.rotation.set(-lerp(d[o + 4], d[n + 4], a), lerpAngle(d[o + 3], d[n + 3], a), 0);
  }
}
