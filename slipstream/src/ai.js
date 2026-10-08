// AI racers. Each AI drives a normal Car through the same physics as the
// player, producing steer / throttle / brake inputs:
//   - follows the spline with pure-pursuit steering toward a racing line
//   - plans speed from upcoming curvature (brakes before corners)
//   - avoids / overtakes cars ahead by picking the free side
//   - rubber-banding keeps races close to the player

import { clamp, smoothstep, lerp } from './utils.js';

const G = 9.81;

// skill scales cornering speed; rubber bands scale speed when far ahead/behind
// the player; gridSlot is where the player starts (0 = pole).
export const DIFFICULTY = {
  easy: { skill: 0.8, rubberUp: 1.04, rubberDown: 0.8, gridSlot: 2 },
  normal: { skill: 0.885, rubberUp: 1.08, rubberDown: 0.86, gridSlot: 3 },
  hard: { skill: 0.97, rubberUp: 1.13, rubberDown: 0.94, gridSlot: 5 },
};

const _p = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };

export class AIDriver {
  /**
   * @param {import('./car.js').Car} car
   * @param {import('./track.js').TrackPath} path
   * @param {object} opts { skill, lane, seed }
   */
  constructor(car, path, opts = {}) {
    this.car = car;
    this.path = path;
    this.skill = opts.skill ?? 0.92;
    this.lane = opts.lane ?? 0; // preferred lateral bias
    this.input = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false };
    this.avoid = 0;
    this.rubber = 1;
    this.stuckTime = 0;
    this.reverseTime = 0;
    this.wobble = (opts.seed ?? 1) * 1.7;
    this.time = 0;
    this._q = {};
    car.physics.gripScale = 1.06; // mild assist so AI rarely spins
  }

  /**
   * @param {number} dt
   * @param {object} ctx { cars: Car[], rubberGap: metres ahead of player (+) or behind (-), racing: bool, diff }
   */
  update(dt, ctx) {
    const car = this.car;
    const ph = car.physics;
    const path = this.path;
    const inp = this.input;
    this.time += dt;
    if (!ctx.racing) {
      inp.steer = 0;
      inp.throttle = 0;
      inp.brake = 1;
      inp.boost = false;
      return inp;
    }
    const q = path.project(ph.pos.x, ph.pos.z, ph.trackHint, this._q);
    const s = q.s;
    const lat = q.lateral;
    const v = ph.speed;
    const hw = path.halfWidth;
    const diff = ctx.diff || DIFFICULTY.normal;

    // --- rubber band -------------------------------------------------------------
    const gap = ctx.rubberGap; // + ahead of player
    let rubber = 1;
    if (gap > 25) rubber = lerp(1, diff.rubberDown, smoothstep(25, 260, gap));
    else if (gap < -20) rubber = lerp(1, diff.rubberUp, smoothstep(20, 260, -gap));
    this.rubber += (rubber - this.rubber) * Math.min(1, dt * 0.8);
    ph.powerScale = clamp(this.rubber * (0.94 + this.skill * 0.06), 0.8, 1.2);

    // --- racing line: move to the inside of upcoming corners ----------------------------------
    const ahead = 22 + v * 0.6;
    const ki = path.indexAt(s + ahead);
    const k = path.curvSmooth[ki];
    let target = this.lane - Math.sign(k) * smoothstep(1 / 400, 1 / 60, Math.abs(k)) * (hw - 1.8);
    target += Math.sin(this.time * 0.3 + this.wobble) * 0.6;

    // --- avoidance: look for cars just ahead in our lane ----------------------------------------
    let avoidTarget = 0;
    let blockSpeed = Infinity;
    for (const other of ctx.cars) {
      if (other === car) continue;
      const op = other.physics;
      const oq = path.project(op.pos.x, op.pos.z, op.trackHint, _oq);
      const ds = path.deltaS(s, oq.s);
      if (ds < -3 || ds > 28) continue;
      const dl = oq.lateral - lat;
      if (Math.abs(dl) < 3.2) {
        // choose the side with more room
        const goLeft = oq.lateral > -hw + 4.5 && (oq.lateral > lat || oq.lateral > hw - 4.5);
        const side = goLeft ? -1 : 1;
        avoidTarget = clamp(oq.lateral + side * 3.8, -hw + 1.3, hw - 1.3);
        if (ds > 0 && ds < 10 && Math.abs(dl) < 2.4) blockSpeed = Math.min(blockSpeed, op.speed * 0.97);
      }
    }
    if (avoidTarget !== 0) this.avoid = lerp(this.avoid, avoidTarget, Math.min(1, dt * 3));
    else this.avoid = lerp(this.avoid, target, Math.min(1, dt * 1.2));
    target = clamp(avoidTarget !== 0 ? this.avoid : lerp(target, this.avoid, 0.3), -hw + 1.2, hw - 1.2);

    // --- steering: pure pursuit ----------------------------------------------------------------------
    const L = 8 + v * 0.42;
    path.pointAt(s + L, target, _p);
    const dx = _p.x - ph.pos.x;
    const dz = _p.z - ph.pos.z;
    const fx = Math.sin(ph.yaw);
    const fz = Math.cos(ph.yaw);
    const alpha = Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz); // + = target to the right (yaw convention)
    const c = ph.cfg;
    const steerLimit = lerp(c.steerMax, c.steerMaxHigh, smoothstep(0, c.steerFalloff, v));
    const omegaMax = Math.min((Math.max(v, 1) * Math.tan(steerLimit)) / c.wheelbase, (c.grip * G * c.overSteer * ph.gripScale) / Math.max(v, 3));
    const omegaWanted = (2 * Math.max(v, 4) * Math.sin(alpha)) / L;
    inp.steer = clamp(omegaWanted / Math.max(0.05, omegaMax), -1, 1);

    // --- speed planning ------------------------------------------------------------------------------------
    const mu = c.grip * ph.gripScale * 0.9 * this.skill;
    const brakeA = c.brakeDecel * 0.75;
    let vTarget = c.topSpeed * 1.1;
    const look = 40 + v * 2.2;
    for (let d = 0; d <= look; d += 6) {
      const kk = Math.abs(path.curvSmooth[path.indexAt(s + d)]);
      if (kk < 1e-4) continue;
      const vc = Math.sqrt((mu * G) / kk);
      const allowed = Math.sqrt(vc * vc + 2 * brakeA * d);
      if (allowed < vTarget) vTarget = allowed;
    }
    vTarget *= this.rubber;
    vTarget = Math.min(vTarget, blockSpeed);
    // recover toward the road if we're on the run-off
    if (Math.abs(lat) > hw + 0.5) vTarget = Math.min(vTarget, 30);

    if (v > vTarget + 1.2) {
      inp.throttle = 0;
      inp.brake = clamp((v - vTarget) / 7, 0.15, 1);
    } else {
      inp.brake = 0;
      inp.throttle = clamp((vTarget - v) / 3 + 0.35, 0, 1);
    }
    // boost on straights when behind the player
    inp.boost = ph.boost > 0.45 && gap < -40 && Math.abs(k) < 1 / 300 && v > 25 && inp.throttle > 0.9;

    // --- unstick: reverse out when pinned against something --------------------------------------------
    if (v < 1.5 && inp.throttle > 0.5) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    if (this.stuckTime > 1.6) {
      this.reverseTime = 1.1;
      this.stuckTime = 0;
    }
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      inp.throttle = 0;
      inp.brake = 1;
      inp.steer = -inp.steer;
    }
    inp.handbrake = false;
    return inp;
  }
}

const _oq = {};
