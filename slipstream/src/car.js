// Car physics (arcade vehicle model) and procedural car models.
//
// Conventions
//   - Y is up. A car with yaw ψ faces f = (sin ψ, 0, cos ψ); its right-hand
//     side is r = (-cos ψ, 0, sin ψ). Positive yaw rate turns LEFT.
//   - Steering input: -1 = full left, +1 = full right.
//   - Physics runs at a fixed 60 Hz (PHYSICS_DT) and is fully decoupled from
//     rendering; Car.updateVisual() interpolates between the last two steps.
//
// All handling values live in CAR_DEFAULTS (shared) and per-car overrides in
// CARS[].physics. Values are intentionally arcade-friendly rather than real.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, damp, smoothstep, TAU } from './utils.js';

export const PHYSICS_DT = 1 / 60;
const G = 9.81;

// ============================================================================
// TUNING CONFIG – shared defaults (every car can override any value)
// ============================================================================
export const CAR_DEFAULTS = {
  // --- mass & engine ---------------------------------------------------------
  mass: 1300, //               kg
  topSpeedKmh: 250, //         top speed; aero drag is solved so the car tops out here
  torque: 430, //              peak engine torque, Nm
  idleRpm: 900,
  peakRpm: 4800, //            rpm with the most torque
  redline: 7200, //            rev limiter
  shiftUpRpm: 6850, //         automatic gearbox: shift up above this
  shiftDownRpm: 3100, //       ...and down below this
  gears: [3.3, 2.15, 1.6, 1.25, 1.0, 0.8], // 6-speed ratios (final drive is derived)
  reverseRatio: 3.1,
  shiftTime: 0.16, //          s of torque cut while shifting
  wheelRadius: 0.34, //        m
  drivetrainEff: 0.9,
  // --- tyres & brakes ----------------------------------------------------------
  grip: 1.55, //               friction coefficient (arcade-high = forgiving cornering)
  brakeDecel: 15, //           m/s² at full brake on tarmac
  handbrakeDecel: 4.5, //      m/s² while the handbrake is held
  rollingResistance: 0.015,
  engineBrake: 1.8, //         m/s² of coasting decel at redline
  reverseMaxKmh: 42,
  // --- steering ------------------------------------------------------------------
  wheelbase: 2.65, //          m
  steerMax: 0.6, //            wheel angle (rad) at standstill
  steerMaxHigh: 0.14, //       wheel angle (rad) at steerFalloffKmh and above (speed-sensitive)
  steerFalloffKmh: 180,
  steerRate: 7, //             steering smoothing (1/s)
  yawResponse: 10, //          how quickly the car's rotation follows the steering
  overSteer: 1.06, //          >1: nose can rotate slightly faster than grip at full lock...
  powerOverSteer: 0.3, //      ...plus this much more with full throttle (power slides)
  scrub: 0.05, //              speed lost per radian of direction change while gripping
  // --- drifting ------------------------------------------------------------------
  driftGrip: 0.6, //           lateral grip multiplier while drifting (lower = longer slides)
  handbrakeGrip: 0.3, //       rear grip multiplier with the handbrake held
  driftEnterAngle: 0.2, //     rad of slip angle that turns a slide into a drift
  driftExitAngle: 0.08, //     drift ends below this angle...
  driftMinKmh: 30, //          ...or below this speed
  driftYawRate: 1.9, //        rad/s of rotation authority while drifting
  driftAlign: 2.1, //          self-straightening while drifting (higher = easier, shorter drifts)
  driftScrub: 0.035, //        speed lost per radian while drifting (low = keeps speed)
  maxDriftAngle: 1.05, //      rad; beyond this the car is pulled back (no spin-outs)
  slideFriction: 0.32, //      sideways sliding scrubs speed: decel = this * g * |sin(slip angle)|
  // --- nitro -----------------------------------------------------------------------
  boostAccel: 4.2, //          m/s² extra acceleration while boosting
  boostTopSpeedFactor: 1.2, // boost can exceed top speed by up to 20%
  boostDrain: 0.3, //          energy per second (meter is 0..1)
  boostRecharge: 0.03, //      passive recharge per second
  boostDriftRecharge: 0.14, // recharge per second while drifting
  // --- misc ----------------------------------------------------------------------------
  airControl: 1.2, //          rad/s² of yaw control while airborne
  offroadDragFactor: 1, //     multiplier on surface rolling resistance
};

// ============================================================================
// CARS – stats, physics overrides and model description
// ============================================================================
export const CARS = [
  {
    id: 'vector',
    name: 'Vector GT',
    tagline: 'Balanced all-rounder',
    price: 0,
    defaultColor: 'flame',
    physics: { mass: 1300, topSpeedKmh: 250, torque: 430, grip: 1.55 },
    model: {
      length: 4.45, width: 1.92, wheelbase: 2.65, track: 1.62, wheelR: 0.34, wheelW: 0.27,
      bottom: 0.2, deckH: 0.86, beltH: 0.9, hoodH: 0.78, noseH: 0.62,
      cabinRear: -1.35, cabinFront: 0.6, roofH: 1.3, rearSlope: 0.5, frontSlope: 0.65, cabinW: 0.8,
      rim: 0xc9ced6, spoiler: { type: 'lip' },
    },
  },
  {
    id: 'comet',
    name: 'Comet RS',
    tagline: 'Fast but slippery',
    price: 0,
    defaultColor: 'electric',
    physics: {
      mass: 1240, topSpeedKmh: 282, torque: 470, grip: 1.36, driftGrip: 0.5, driftAlign: 1.7,
      powerOverSteer: 0.45, steerMaxHigh: 0.13, scrub: 0.06,
    },
    model: {
      length: 4.6, width: 1.96, wheelbase: 2.72, track: 1.68, wheelR: 0.35, wheelW: 0.3,
      bottom: 0.16, deckH: 0.82, beltH: 0.84, hoodH: 0.66, noseH: 0.5,
      cabinRear: -1.4, cabinFront: 0.55, roofH: 1.17, rearSlope: 0.6, frontSlope: 0.8, cabinW: 0.76,
      rim: 0x23262b, spoiler: { type: 'wing', z: -2.05, y: 1.2, width: 1.8, chord: 0.38 },
    },
  },
  {
    id: 'badger',
    name: 'Badger S',
    tagline: 'Grippy but slower',
    price: 0,
    defaultColor: 'lime',
    physics: {
      mass: 1120, topSpeedKmh: 226, torque: 360, grip: 1.78, driftGrip: 0.68, driftAlign: 2.6,
      steerMax: 0.62, steerMaxHigh: 0.16, powerOverSteer: 0.18, wheelbase: 2.5,
    },
    model: {
      length: 4.05, width: 1.84, wheelbase: 2.5, track: 1.58, wheelR: 0.33, wheelW: 0.26,
      bottom: 0.24, deckH: 1.0, beltH: 0.98, hoodH: 0.86, noseH: 0.7,
      cabinRear: -1.6, cabinFront: 0.4, roofH: 1.48, rearSlope: 0.18, frontSlope: 0.65, cabinW: 0.84,
      rim: 0xe7e9ec, spoiler: { type: 'roof' },
    },
  },
  {
    id: 'raptor',
    name: 'Raptor V8',
    tagline: 'Muscle car, loves to slide',
    price: 1500,
    defaultColor: 'race-red',
    physics: {
      mass: 1480, topSpeedKmh: 268, torque: 600, grip: 1.42, driftGrip: 0.48, driftAlign: 1.6,
      powerOverSteer: 0.55, driftYawRate: 2.1, peakRpm: 4200, redline: 6800, shiftUpRpm: 6500,
      wheelbase: 2.8,
    },
    model: {
      length: 4.75, width: 1.98, wheelbase: 2.8, track: 1.66, wheelR: 0.35, wheelW: 0.3,
      bottom: 0.2, deckH: 0.92, beltH: 0.94, hoodH: 0.9, noseH: 0.8,
      cabinRear: -1.45, cabinFront: 0.3, roofH: 1.32, rearSlope: 0.55, frontSlope: 0.6, cabinW: 0.8,
      rim: 0x9aa1aa, spoiler: { type: 'ducktail' }, stripes: true,
    },
  },
  {
    id: 'nova',
    name: 'Nova X',
    tagline: 'Hypercar. Unfair.',
    price: 3500,
    defaultColor: 'arctic',
    physics: {
      mass: 1250, topSpeedKmh: 305, torque: 540, grip: 1.68, driftGrip: 0.58, steerMaxHigh: 0.135,
      redline: 8200, shiftUpRpm: 7900, peakRpm: 5600, boostAccel: 4.8,
    },
    model: {
      length: 4.6, width: 2.02, wheelbase: 2.72, track: 1.72, wheelR: 0.35, wheelW: 0.32,
      bottom: 0.14, deckH: 0.86, beltH: 0.8, hoodH: 0.6, noseH: 0.44,
      cabinRear: -1.2, cabinFront: 0.8, roofH: 1.12, rearSlope: 0.75, frontSlope: 0.85, cabinW: 0.72,
      rim: 0xd4a72c, spoiler: { type: 'wing', z: -1.98, y: 1.18, width: 1.95, chord: 0.42 },
    },
  },
];

export const COLORS = [
  { id: 'flame', name: 'Flame Orange', hex: 0xff5a1f, finish: 'gloss', price: 0 },
  { id: 'race-red', name: 'Race Red', hex: 0xd0182a, finish: 'gloss', price: 0 },
  { id: 'arctic', name: 'Arctic White', hex: 0xf1f3f6, finish: 'gloss', price: 0 },
  { id: 'electric', name: 'Electric Blue', hex: 0x1d5cff, finish: 'gloss', price: 0 },
  { id: 'lime', name: 'Acid Lime', hex: 0x86d42a, finish: 'gloss', price: 0 },
  { id: 'midnight', name: 'Midnight', hex: 0x1d2742, finish: 'metallic', price: 0 },
  { id: 'sunburst', name: 'Sunburst', hex: 0xffc21a, finish: 'gloss', price: 150 },
  { id: 'neon-pink', name: 'Neon Pink', hex: 0xff2f9a, finish: 'gloss', price: 200 },
  { id: 'teal', name: 'Teal Pearl', hex: 0x12b5a2, finish: 'metallic', price: 250 },
  { id: 'matte', name: 'Matte Black', hex: 0x1b1c20, finish: 'matte', price: 300 },
  { id: 'violet', name: 'Violet Flake', hex: 0x7a3cf0, finish: 'metallic', price: 350 },
  { id: 'gold', name: 'Liquid Gold', hex: 0xd6a42a, finish: 'metallic', price: 500 },
  { id: 'chrome', name: 'Chrome', hex: 0xd8dee6, finish: 'chrome', price: 800 },
];

const FINISH = {
  gloss: { metalness: 0.15, roughness: 0.26 },
  metallic: { metalness: 0.65, roughness: 0.3 },
  matte: { metalness: 0.0, roughness: 0.82 },
  chrome: { metalness: 1.0, roughness: 0.07 },
};

export const getCarDef = (id) => CARS.find((c) => c.id === id) || CARS[0];
export const getColor = (id) => COLORS.find((c) => c.id === id) || COLORS[0];

/** Normalized torque curve 0..1 over the rev range. */
function torqueCurve(c, rpm) {
  if (rpm < c.peakRpm) {
    const t = clamp((rpm - c.idleRpm) / (c.peakRpm - c.idleRpm), 0, 1);
    return 0.58 + 0.42 * (t * (2 - t));
  }
  const t = clamp((rpm - c.peakRpm) / (c.redline - c.peakRpm), 0, 1);
  return 1 - 0.2 * Math.pow(t, 1.5);
}

/** Merge defaults + overrides and solve derived constants (final drive, drag). */
export function resolveConfig(overrides = {}) {
  const c = { ...CAR_DEFAULTS, ...overrides };
  c.topSpeed = c.topSpeedKmh / 3.6;
  const topGear = c.gears[c.gears.length - 1];
  c.finalDrive = (0.97 * c.redline * (TAU / 60) * c.wheelRadius) / (c.topSpeed * topGear);
  const fTop =
    ((c.torque * torqueCurve(c, 0.97 * c.redline) * topGear * c.finalDrive) / c.wheelRadius) * c.drivetrainEff;
  c.dragK = Math.max(0.05, (fTop - c.rollingResistance * c.mass * G) / (c.topSpeed * c.topSpeed));
  c.reverseMax = c.reverseMaxKmh / 3.6;
  c.steerFalloff = c.steerFalloffKmh / 3.6;
  c.driftMin = c.driftMinKmh / 3.6;
  return c;
}

/** Display stats (0..1) derived from physics for the garage. */
export function carStats(def) {
  const c = resolveConfig(def.physics);
  return {
    speed: clamp((c.topSpeedKmh - 200) / 120, 0.1, 1),
    accel: clamp(((c.torque / c.mass) * 1000 - 260) / 200, 0.1, 1),
    handling: clamp((c.grip - 1.2) / 0.65, 0.1, 1),
    drift: clamp((0.8 - c.driftGrip) / 0.38 + (c.powerOverSteer - 0.15) * 0.6, 0.1, 1),
  };
}

// ============================================================================
// PHYSICS
// ============================================================================
export class CarPhysics {
  constructor(overrides) {
    this.cfg = resolveConfig(overrides);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.ground = { height: 0, grip: 1, rolling: 1, surface: 0, offroad: false };
    this._g = { height: 0, grip: 1, rolling: 1, surface: 0, offroad: false };
    this.trackHint = -1; // used by the track world for fast projection
    this.gripScale = 1; // AI assist / rubber-band
    this.powerScale = 1;
    this.reset(new THREE.Vector3(), 0);
  }

  reset(pos, yaw) {
    this.pos.copy(pos);
    this.prevPos.copy(pos);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.prevYaw = yaw;
    this.yawRate = 0;
    this.pitch = 0;
    this.roll = 0;
    this.prevPitch = 0;
    this.prevRoll = 0;
    this.steer = 0; // smoothed steering input (-1..1)
    this.wheelAngle = 0; // visual front wheel angle (rad)
    this.rpm = this.cfg.idleRpm;
    this.gear = 1;
    this.shiftTimer = 0;
    this.throttleApplied = 0;
    this.braking = false;
    this.reversing = false;
    this.boost = 1;
    this.boosting = false;
    this.grounded = true;
    this.airTime = 0;
    this.drifting = false;
    this.driftExitTimer = 0;
    this.slipAngle = 0;
    this.slip = 0; // 0..1 tyre slip intensity (smoke / screech / skids)
    this.wheelspin = 0;
    this.speed = 0;
    this.forwardSpeed = 0;
    this.accelLong = 0;
    this.accelLat = 0;
    this.wheelRot = 0;
    this.landImpact = 0;
    this.impact = 0; // collision impact speed this step (set by world)
    this.impactX = 0;
    this.impactZ = 0;
    this.locked = false; // countdown: engine revs but car is held
    this.trackHint = -1;
  }

  get speedKmh() {
    return this.speed * 3.6;
  }

  /**
   * Advance one fixed step.
   * @param {number} dt
   * @param {{steer:number, throttle:number, brake:number, handbrake:boolean, boost:boolean}} input
   * @param {object} world must implement sampleGround(x, z, car, out) and collide(car, dt)
   */
  step(dt, input, world) {
    const c = this.cfg;
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.prevRoll = this.roll;
    // note: impact / landImpact are consumed (reset) by the game after effects

    let fx = Math.sin(this.yaw);
    let fz = Math.cos(this.yaw);
    let vx = this.vel.x;
    let vz = this.vel.z;
    const vx0 = vx;
    const vz0 = vz;
    let vLong = vx * fx + vz * fz;
    const speed0 = Math.hypot(vx, vz);
    const gnd = this.ground;
    const surfGrip = gnd.grip;
    const grounded = this.grounded;

    const throttleIn = clamp(input.throttle || 0, 0, 1);
    const brakeIn = clamp(input.brake || 0, 0, 1);
    const hand = !!input.handbrake && !this.locked;

    // ---- forward / reverse interpretation ------------------------------------
    let drive = 0;
    let brake = 0;
    if (vLong > 0.6) {
      drive = throttleIn;
      brake = brakeIn;
    } else if (vLong < -0.6) {
      drive = -brakeIn;
      brake = throttleIn;
    } else if (throttleIn > 0.05) drive = throttleIn;
    else if (brakeIn > 0.05) drive = -brakeIn;
    if (this.locked) {
      drive = 0;
      brake = 1;
    }
    if (drive < -0.01) this.gear = -1;
    else if (this.gear === -1 && (drive > 0.01 || vLong > 1)) this.gear = 1;
    this.reversing = this.gear === -1 && vLong < -0.3;
    this.braking = brake > 0.1 || hand;

    // ---- gearbox ----------------------------------------------------------------------
    const rpmFactor = ((c.finalDrive / c.wheelRadius) * 60) / TAU;
    let ratio = this.gear === -1 ? c.reverseRatio : c.gears[this.gear - 1];
    let rpmWheels = Math.abs(vLong) * ratio * rpmFactor;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.gear > 0 && this.shiftTimer <= 0 && grounded) {
      if (rpmWheels > c.shiftUpRpm && this.gear < c.gears.length && drive > 0.05) {
        this.gear++;
        this.shiftTimer = c.shiftTime;
      } else if (this.gear > 1) {
        const downAt = c.shiftDownRpm * (drive > 0.05 ? 1 : 0.75);
        const lowerRpm = Math.abs(vLong) * c.gears[this.gear - 2] * rpmFactor;
        if (rpmWheels < downAt && lowerRpm < c.shiftUpRpm * 0.92) {
          this.gear--;
          this.shiftTimer = c.shiftTime * 0.6;
        }
      }
      ratio = c.gears[this.gear - 1];
      rpmWheels = Math.abs(vLong) * ratio * rpmFactor;
    }

    // ---- engine rpm (for audio / HUD) --------------------------------------------------
    const absDrive = Math.abs(drive);
    let rpmTarget;
    if (this.locked) rpmTarget = lerp(c.idleRpm, c.redline * 0.92, throttleIn);
    else if (!grounded) rpmTarget = lerp(c.idleRpm + 600, c.redline * 0.96, absDrive);
    else {
      rpmTarget = Math.max(c.idleRpm, rpmWheels);
      if ((this.gear === 1 || this.gear === -1) && absDrive > 0.05)
        rpmTarget = Math.max(rpmTarget, lerp(c.idleRpm, 4300, absDrive)); // clutch slip at launch
      if (this.wheelspin > 0.02) rpmTarget += 1800 * this.wheelspin;
      if (this.drifting && absDrive > 0.3) rpmTarget += 600;
    }
    this.rpm += (rpmTarget - this.rpm) * damp(this.shiftTimer > 0 ? 7 : 16, dt);
    if (this.rpm > c.redline) this.rpm = c.redline - Math.random() * 180; // limiter bounce
    this.throttleApplied = this.locked ? throttleIn : absDrive;

    // ---- longitudinal forces -------------------------------------------------------------
    let fDrive = 0;
    this.wheelspin = 0;
    if (!this.locked && grounded && absDrive > 0) {
      const rpmEval = clamp(rpmWheels, c.idleRpm, c.redline);
      const tq = c.torque * torqueCurve(c, rpmEval) * absDrive * this.powerScale;
      fDrive = ((tq * ratio * c.finalDrive) / c.wheelRadius) * c.drivetrainEff * Math.sign(drive);
      if (this.shiftTimer > 0) fDrive *= 0.25;
      if (this.gear > 0 && rpmWheels >= c.redline) fDrive = 0; // rev limiter
      if (this.gear === -1 && vLong < -c.reverseMax) fDrive = 0;
      const tracMax = c.grip * surfGrip * G * c.mass * 0.92;
      if (Math.abs(fDrive) > tracMax) {
        this.wheelspin = Math.min(1, (Math.abs(fDrive) - tracMax) / tracMax);
        fDrive = Math.sign(fDrive) * tracMax;
      }
    }

    // nitro
    const wantBoost = !!input.boost && !this.locked && this.gear > 0;
    if (wantBoost && this.boost > 0.01) {
      this.boosting = true;
      this.boost = Math.max(0, this.boost - c.boostDrain * dt);
      const fade = 1 - smoothstep(c.topSpeed * 1.02, c.topSpeed * c.boostTopSpeedFactor, speed0);
      if (grounded) fDrive += c.boostAccel * c.mass * fade * this.powerScale;
    } else {
      this.boosting = false;
      const rate = this.drifting ? c.boostDriftRecharge : c.boostRecharge;
      this.boost = Math.min(1, this.boost + rate * dt);
    }

    let brakeDecel = brake * c.brakeDecel * Math.min(1, surfGrip + 0.25);
    if (hand) brakeDecel += c.handbrakeDecel;
    let resist = c.rollingResistance * G * gnd.rolling * c.offroadDragFactor;
    if (absDrive < 0.05 && this.gear > 0) resist += c.engineBrake * (this.rpm / c.redline);

    if (grounded) {
      let aLong = fDrive / c.mass - G * Math.sin(this.pitch);
      vx += fx * aLong * dt;
      vz += fz * aLong * dt;
      vLong = vx * fx + vz * fz;
      const dec = (brakeDecel + resist) * dt;
      const nl = Math.abs(vLong) <= dec ? 0 : vLong - Math.sign(vLong) * dec;
      vx += fx * (nl - vLong);
      vz += fz * (nl - vLong);
      vLong = nl;
    }
    // aerodynamic drag
    {
      const sp = Math.hypot(vx, vz);
      if (sp > 0) {
        const k = Math.max(0, sp - ((c.dragK * sp * sp) / c.mass) * dt) / sp;
        vx *= k;
        vz *= k;
      }
    }

    // ---- steering ------------------------------------------------------------------------------
    const speed = Math.hypot(vx, vz);
    const steerIn = clamp(input.steer || 0, -1, 1);
    this.steer += (steerIn - this.steer) * damp(c.steerRate, dt);
    const steerLimit = lerp(c.steerMax, c.steerMaxHigh, smoothstep(0, c.steerFalloff, speed));
    const latMax = c.grip * surfGrip * G * this.gripScale;

    // ---- drift state ---------------------------------------------------------------------------------
    vLong = vx * fx + vz * fz;
    const vLat = vx * -fz + vz * fx;
    const beta = speed > 1.5 ? Math.atan2(vLat, Math.abs(vLong)) : 0;
    this.slipAngle = beta;
    if (grounded) {
      if (!this.drifting) {
        if (
          speed > c.driftMin &&
          vLong > 0 &&
          ((hand && Math.abs(steerIn) > 0.2) || Math.abs(beta) > c.driftEnterAngle)
        ) {
          this.drifting = true;
          this.driftExitTimer = 0;
        }
      } else {
        this.driftExitTimer = Math.abs(beta) < c.driftExitAngle ? this.driftExitTimer + dt : 0;
        if (this.driftExitTimer > 0.22 || speed < c.driftMin * 0.6 || vLong < 0) this.drifting = false;
      }
    } else if (this.drifting && this.airTime > 0.5) this.drifting = false;

    let gripMul = 1;
    if (hand && speed > 3) gripMul = c.handbrakeGrip;
    else if (this.drifting) gripMul = c.driftGrip * (absDrive > 0.3 ? 1 : 1.35);

    // ---- yaw ---------------------------------------------------------------------------------------------
    const dirSign = vLong >= -0.2 ? 1 : -1;
    // kinematic limit (low speed) and grip limit (high speed); input scales between 0 and max
    const omegaKin = (Math.abs(vLong) * Math.tan(steerLimit)) / c.wheelbase;
    const over = c.overSteer + c.powerOverSteer * absDrive * smoothstep(12, 30, speed);
    const omegaGrip = (latMax * over) / Math.max(speed, 3);
    const omegaMax = Math.min(omegaKin, omegaGrip);
    let omegaT;
    if (!this.drifting) {
      omegaT = -this.steer * omegaMax * dirSign;
      if (hand && speed > 4) omegaT += -this.steer * 1.1;
    } else {
      const sf = clamp(speed / 22, 0.5, 1);
      omegaT = -this.steer * c.driftYawRate * sf - beta * c.driftAlign + -this.steer * omegaMax * 0.35;
      const excess = Math.abs(beta) - c.maxDriftAngle;
      if (excess > 0) omegaT -= Math.sign(beta) * excess * 9;
    }
    if (grounded) {
      this.yawRate += (omegaT - this.yawRate) * damp(this.drifting ? 6.5 : c.yawResponse, dt);
      this.airTime = 0;
    } else {
      this.yawRate *= 1 - 0.8 * dt;
      this.yawRate += -steerIn * c.airControl * dt;
      this.airTime += dt;
    }
    this.yaw += this.yawRate * dt;
    if (this.yaw > Math.PI) this.yaw -= TAU;
    else if (this.yaw < -Math.PI) this.yaw += TAU;
    // keep interpolation continuous across the wrap
    if (this.yaw - this.prevYaw > Math.PI) this.prevYaw += TAU;
    else if (this.yaw - this.prevYaw < -Math.PI) this.prevYaw -= TAU;
    fx = Math.sin(this.yaw);
    fz = Math.cos(this.yaw);

    // visual front wheel yaw (rotation.y; positive = pointing left). In a drift
    // the front wheels point along the direction of travel (counter-steer look).
    const waTarget = this.drifting
      ? clamp(-beta * 0.75 - this.steer * 0.15, -0.6, 0.6)
      : -this.steer * Math.max(steerLimit, 0.2);
    this.wheelAngle += (waTarget - this.wheelAngle) * damp(14, dt);

    // ---- tyre grip: rotate velocity toward the heading -------------------------------------------------------
    if (grounded) {
      const sp = Math.hypot(vx, vz);
      if (sp < 0.4) {
        const vl = vx * fx + vz * fz;
        vx = fx * vl;
        vz = fz * vl;
      } else {
        const ds = vx * fx + vz * fz >= 0 ? 1 : -1;
        const hx = fx * ds;
        const hz = fz * ds;
        const ang = Math.atan2(vx * hz - vz * hx, vx * hx + vz * hz);
        const maxRot = ((latMax * gripMul) / sp) * dt;
        const rot = clamp(ang, -maxRot, maxRot);
        const cs = Math.cos(rot);
        const sn = Math.sin(rot);
        const k = Math.max(0, 1 - Math.abs(rot) * (this.drifting ? c.driftScrub : c.scrub));
        const nvx = (vx * cs - vz * sn) * k;
        const nvz = (vx * sn + vz * cs) * k;
        vx = nvx;
        vz = nvz;
      }
    }

    // sliding sideways costs speed (tyres scrubbing), so drifts don't gain speed
    if (grounded) {
      const sp = Math.hypot(vx, vz);
      if (sp > 1) {
        const sb = Math.abs(vx * -fz + vz * fx) / sp; // |sin(slip angle)|
        const k = Math.max(0, sp - c.slideFriction * G * sb * dt) / sp;
        vx *= k;
        vz *= k;
      }
    }

    // ---- integrate horizontal motion -------------------------------------------------------------------------------
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;
    this.vel.x = vx;
    this.vel.z = vz;

    // ---- collisions (walls, obstacles) -------------------------------------------------------------------------------
    world.collide(this, dt);
    vx = this.vel.x;
    vz = this.vel.z;

    // ---- vertical: follow ground or fly -----------------------------------------------------------------------------
    const g = world.sampleGround(this.pos.x, this.pos.z, this, this._g);
    if (this.grounded) {
      const vyGround = (g.height - this.pos.y) / dt;
      // Leave the ground when it falls away faster than gravity can follow:
      // either a big sudden drop (ramp lip) or a sustained one (fast crest).
      // One-step spikes (curbs, sample seams) are ignored.
      const ballistic = this.pos.y + this.vel.y * dt - 0.5 * G * dt * dt;
      const separation = ballistic - g.height;
      this.liftSteps = vyGround < this.vel.y - G * dt * 1.15 ? (this.liftSteps || 0) + 1 : 0;
      if (speed > 6 && (separation > 0.12 || (this.liftSteps >= 3 && separation > 0.004))) {
        this.grounded = false;
        this.liftSteps = 0;
        this.vel.y -= G * dt;
        this.pos.y = ballistic;
      } else {
        this.vel.y = clamp(vyGround, -30, 30);
        this.pos.y = g.height;
      }
    } else {
      this.vel.y -= G * dt;
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= g.height) {
        this.landImpact = Math.max(0, -this.vel.y);
        this.pos.y = g.height;
        this.vel.y = 0;
        this.grounded = true;
        if (this.landImpact > 6) {
          vx *= 0.97;
          vz *= 0.97;
          this.vel.x = vx;
          this.vel.z = vz;
        }
      }
    }
    // copy ground info for next step
    const gg = this.ground;
    gg.height = g.height;
    gg.grip = g.grip;
    gg.rolling = g.rolling;
    gg.surface = g.surface;
    gg.offroad = g.offroad;

    // ---- chassis orientation from the ground under the wheels ------------------------------------------------------------
    if (this.grounded) {
      const hb = c.wheelbase * 0.5;
      const ht = 0.8;
      const rx = -fz;
      const rz = fx;
      const hF = world.sampleGround(this.pos.x + fx * hb, this.pos.z + fz * hb, this, this._g).height;
      const hR = world.sampleGround(this.pos.x - fx * hb, this.pos.z - fz * hb, this, this._g).height;
      const hL = world.sampleGround(this.pos.x - rx * ht, this.pos.z - rz * ht, this, this._g).height;
      const hRt = world.sampleGround(this.pos.x + rx * ht, this.pos.z + rz * ht, this, this._g).height;
      const pt = Math.atan2(hF - hR, hb * 2);
      const rl = Math.atan2(hL - hRt, ht * 2);
      this.pitch += (pt - this.pitch) * damp(18, dt);
      this.roll += (rl - this.roll) * damp(18, dt);
    } else {
      const pt = clamp(Math.atan2(this.vel.y, Math.max(speed, 1)) * 0.6, -0.5, 0.5);
      this.pitch += (pt - this.pitch) * damp(1.5, dt);
      this.roll *= 1 - 1.5 * dt;
    }

    // ---- derived values for effects / HUD ---------------------------------------------------------------------------------------
    this.speed = Math.hypot(vx, vz);
    this.forwardSpeed = vx * fx + vz * fz;
    const dvx = (vx - vx0) / dt;
    const dvz = (vz - vz0) / dt;
    this.accelLong += (dvx * fx + dvz * fz - this.accelLong) * damp(8, dt);
    this.accelLat += (dvx * -fz + dvz * fx - this.accelLat) * damp(8, dt);
    const slipFromAngle = clamp((Math.abs(beta) - 0.1) / 0.35, 0, 1) * smoothstep(4, 12, this.speed);
    const slipHand = hand && this.speed > 3 ? 0.75 : 0;
    const slipBrake = brake > 0.8 && this.speed > 18 && surfGrip > 0.8 ? 0.25 : 0;
    const target = this.grounded ? Math.max(slipFromAngle, this.wheelspin, slipHand, slipBrake) : 0;
    this.slip += (target - this.slip) * damp(12, dt);
    const wheelOmega = (this.forwardSpeed / c.wheelRadius) * (1 + this.wheelspin * 1.5) * (hand ? 0.2 : 1);
    this.wheelRot = (this.wheelRot + wheelOmega * dt) % TAU;
  }
}

// ============================================================================
// MODELS (procedural: extruded side profiles + primitives)
// ============================================================================

const _shared = {};
function sharedMaterials() {
  if (_shared.lights) return _shared;
  _shared.lights = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  _shared.lights.userData.shared = true;
  // Glass + trim in one draw call: vertex colour alpha carries roughness.
  const details = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.5 });
  details.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n#ifdef USE_COLOR_ALPHA\n\troughnessFactor = vColor.a;\n#endif',
    );
  };
  details.customProgramCacheKey = () => 'car-details-v1';
  details.userData.shared = true;
  _shared.details = details;
  _shared.ghost = new THREE.MeshBasicMaterial({
    color: 0x6fe3ff,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  _shared.ghost.userData.shared = true;
  return _shared;
}

function colorize(geo, r, g, b, a = 1) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    arr[i * 4] = r;
    arr[i * 4 + 1] = g;
    arr[i * 4 + 2] = b;
    arr[i * 4 + 3] = a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 4));
  return geo;
}

function hexRGB(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Ensure all geometries have the same attribute set (position, normal, uv, color) for merging. */
function prep(geo, rgba) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  colorize(g, rgba[0], rgba[1], rgba[2], rgba[3] ?? 1);
  return g;
}

function extrudeProfile(points, width, bevel = 0.08) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const depth = Math.max(0.05, width - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.9,
    bevelSegments: 2,
    curveSegments: 4,
  });
  // shape X → car Z (forward), shape Y → up, extrusion → car X (width)
  geo.rotateY(-Math.PI / 2);
  geo.translate(depth / 2, 0, 0);
  return geo;
}

/** Narrow the upper part of a body (tumblehome) and round the corners in plan view. */
function shapeBody(geo, beltY, topY, halfLen, taperTop = 0.86) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const t = clamp((y - beltY) / Math.max(0.01, topY - beltY), 0, 1);
    x *= lerp(1, taperTop, t);
    const e = Math.pow(clamp(Math.abs(z) / halfLen, 0, 1), 5);
    x *= 1 - 0.12 * e;
    p.setX(i, x);
  }
  geo.computeVertexNormals();
}

function bodyProfile(m) {
  const L = m.length;
  const zr = -L / 2;
  const zf = L / 2;
  const b = m.bottom;
  const wf = m.wheelbase / 2;
  const ra = m.wheelR + 0.07;
  const pts = [];
  pts.push([zr + 0.04, b + 0.14]);
  pts.push([zr, m.deckH - 0.14]);
  pts.push([zr + 0.12, m.deckH - 0.02]);
  pts.push([zr + 0.4, m.deckH]);
  pts.push([m.cabinRear, m.beltH]);
  pts.push([m.cabinFront, m.beltH - 0.02]);
  pts.push([zf - 0.7, lerp(m.hoodH, m.beltH, 0.25)]);
  pts.push([zf - 0.25, m.noseH + 0.04]);
  pts.push([zf - 0.04, m.noseH - 0.06]);
  pts.push([zf, m.noseH - 0.22]);
  pts.push([zf - 0.06, b + 0.1]);
  // bottom edge with wheel arches, front to rear
  const arch = (zc) => {
    const th0 = Math.asin(clamp((b - m.wheelR) / ra, -1, 1));
    const steps = 9;
    for (let s = 0; s <= steps; s++) {
      const th = th0 + ((Math.PI - 2 * th0) * s) / steps;
      pts.push([zc + ra * Math.cos(th), m.wheelR + ra * Math.sin(th)]);
    }
  };
  pts.push([wf + ra + 0.05, b]);
  arch(wf);
  pts.push([-wf + ra + 0.02, b]);
  arch(-wf);
  pts.push([zr + 0.2, b]);
  return pts;
}

function cabinProfile(m) {
  const by = m.beltH - 0.06;
  return [
    [m.cabinRear - 0.02, by],
    [m.cabinRear + m.rearSlope, m.roofH],
    [m.cabinFront - m.frontSlope, m.roofH],
    [m.cabinFront + 0.05, by],
  ];
}

const wheelGeoCache = new Map();
function wheelGeometry(m) {
  const key = `${m.wheelR}|${m.wheelW}|${m.rim}`;
  if (wheelGeoCache.has(key)) return wheelGeoCache.get(key);
  const r = m.wheelR;
  const w = m.wheelW;
  const tire = new THREE.CylinderGeometry(r, r, w, 22, 1);
  tire.rotateZ(Math.PI / 2);
  const rimC = hexRGB(m.rim);
  const parts = [prep(tire, [0.06, 0.06, 0.065, 0.85])];
  const rim = new THREE.CylinderGeometry(r * 0.64, r * 0.64, w + 0.02, 18, 1);
  rim.rotateZ(Math.PI / 2);
  parts.push(prep(rim, [rimC[0] * 0.5, rimC[1] * 0.5, rimC[2] * 0.5, 0.4]));
  for (const side of [-1, 1]) {
    for (let k = 0; k < 5; k++) {
      const sp = new THREE.BoxGeometry(0.03, r * 1.15, 0.07);
      sp.rotateX((k / 5) * TAU);
      sp.translate(side * (w / 2 + 0.012), 0, 0);
      parts.push(prep(sp, [...rimC, 0.3]));
    }
    const hub = new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.03, 10);
    hub.rotateZ(Math.PI / 2);
    hub.translate(side * (w / 2 + 0.02), 0, 0);
    parts.push(prep(hub, [...rimC, 0.25]));
  }
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  // wheels use the details material, so they need the same attribute layout
  wheelGeoCache.set(key, geo);
  return geo;
}

/**
 * Build the visual model for a car definition.
 * Returns { root, body, paint, details, lights, wheels, paintMat, tailIdx, revIdx, lightPoints }
 */
export function buildCarModel(def, colorDef, { ghost = false } = {}) {
  const mats = sharedMaterials();
  const m = def.model;
  const halfLen = m.length / 2;

  // ---- paint (body + roof + mirrors + spoiler) ----
  const paintParts = [];
  const body = extrudeProfile(bodyProfile(m), m.width, 0.09);
  shapeBody(body, m.beltH - 0.25, m.beltH + 0.02, halfLen, 0.9);
  paintParts.push(prep(body, [1, 1, 1, 1]));
  {
    const rz0 = m.cabinRear + m.rearSlope + 0.06;
    const rz1 = m.cabinFront - m.frontSlope - 0.04;
    const roof = new THREE.BoxGeometry(m.width * m.cabinW * 0.84, 0.05, Math.max(0.3, rz1 - rz0));
    roof.translate(0, m.roofH + 0.005, (rz0 + rz1) / 2);
    paintParts.push(prep(roof, [1, 1, 1, 1]));
  }
  for (const s of [-1, 1]) {
    const mirror = new THREE.BoxGeometry(0.18, 0.11, 0.2);
    mirror.translate(s * (m.width / 2 + 0.02), m.beltH + 0.1, m.cabinFront - 0.15);
    paintParts.push(prep(mirror, [1, 1, 1, 1]));
  }
  const trim = [];
  const sp = m.spoiler || {};
  if (sp.type === 'wing') {
    const wing = new THREE.BoxGeometry(sp.width, 0.05, sp.chord);
    wing.rotateX(-0.12);
    wing.translate(0, sp.y, sp.z);
    paintParts.push(prep(wing, [1, 1, 1, 1]));
    for (const s of [-1, 1]) {
      const plate = new THREE.BoxGeometry(0.04, 0.22, sp.chord + 0.08);
      plate.translate(s * sp.width / 2, sp.y - 0.04, sp.z);
      trim.push(prep(plate, [0.05, 0.05, 0.06, 0.6]));
      const strut = new THREE.BoxGeometry(0.06, sp.y - m.deckH + 0.05, 0.12);
      strut.translate(s * sp.width * 0.3, (sp.y + m.deckH) / 2 - 0.02, sp.z + 0.05);
      trim.push(prep(strut, [0.05, 0.05, 0.06, 0.6]));
    }
  } else if (sp.type === 'ducktail') {
    const duck = new THREE.BoxGeometry(m.width * 0.86, 0.08, 0.32);
    duck.rotateX(0.25);
    duck.translate(0, m.deckH + 0.05, -halfLen + 0.3);
    paintParts.push(prep(duck, [1, 1, 1, 1]));
  } else if (sp.type === 'lip') {
    const lip = new THREE.BoxGeometry(m.width * 0.82, 0.04, 0.16);
    lip.rotateX(0.2);
    lip.translate(0, m.deckH + 0.03, -halfLen + 0.42);
    paintParts.push(prep(lip, [1, 1, 1, 1]));
  } else if (sp.type === 'roof') {
    const rs = new THREE.BoxGeometry(m.width * m.cabinW * 0.84, 0.05, 0.24);
    rs.rotateX(0.18);
    rs.translate(0, m.roofH + 0.03, m.cabinRear + m.rearSlope - 0.08);
    paintParts.push(prep(rs, [1, 1, 1, 1]));
  }
  if (m.stripes) {
    // twin racing stripes over hood and roof (white, inside the paint mesh)
    for (const s of [-1, 1]) {
      const hood = new THREE.BoxGeometry(0.16, 0.012, halfLen - m.cabinFront - 0.15);
      const hz0 = m.cabinFront + 0.05;
      hood.rotateX(-Math.atan2(m.beltH - m.hoodH, halfLen - m.cabinFront) * 0.5);
      hood.translate(s * 0.16, lerp(m.beltH, m.hoodH, 0.45) + 0.03, (hz0 + halfLen - 0.25) / 2);
      paintParts.push(prep(hood, [0.08, 0.08, 0.09, 1]));
    }
  }
  const paintGeo = mergeGeometries(paintParts);
  paintParts.forEach((p) => p.dispose());

  // ---- details: glass (smooth) + trim (rough) ----
  const cabin = extrudeProfile(cabinProfile(m), m.width * m.cabinW, 0.07);
  shapeBody(cabin, m.beltH - 0.06, m.roofH, halfLen, 0.84);
  const detailParts = [prep(cabin, [0.03, 0.045, 0.065, 0.06])];
  {
    const grille = new THREE.BoxGeometry(m.width * 0.56, 0.16, 0.06);
    grille.translate(0, m.bottom + 0.2, halfLen - 0.05);
    detailParts.push(prep(grille, [0.03, 0.03, 0.035, 0.7]));
    const diffuser = new THREE.BoxGeometry(m.width * 0.8, 0.14, 0.12);
    diffuser.translate(0, m.bottom + 0.06, -halfLen + 0.08);
    detailParts.push(prep(diffuser, [0.04, 0.04, 0.045, 0.75]));
    for (const s of [-1, 1]) {
      const skirt = new THREE.BoxGeometry(0.06, 0.1, m.wheelbase - m.wheelR * 2 - 0.25);
      skirt.translate(s * (m.width / 2 - 0.02), m.bottom + 0.04, 0);
      detailParts.push(prep(skirt, [0.04, 0.04, 0.045, 0.75]));
      const pipe = new THREE.CylinderGeometry(0.05, 0.05, 0.16, 10);
      pipe.rotateX(Math.PI / 2);
      pipe.translate(s * m.width * 0.28, m.bottom + 0.12, -halfLen - 0.02);
      detailParts.push(prep(pipe, [0.55, 0.56, 0.58, 0.2]));
    }
  }
  detailParts.push(...trim);
  const detailGeo = mergeGeometries(detailParts);
  detailParts.forEach((p) => p.dispose());

  // ---- lights (unlit, vertex coloured; tail colours change when braking) ----
  const lightParts = [];
  const headY = m.noseH - 0.02;
  const headZ = halfLen - 0.12;
  const headX = m.width / 2 - 0.3;
  for (const s of [-1, 1]) {
    const hl = new THREE.BoxGeometry(0.42, 0.09, 0.22);
    hl.rotateX(0.35);
    hl.translate(s * headX, headY, headZ);
    lightParts.push(prep(hl, [1, 0.96, 0.86, 1]));
  }
  const tailY = m.deckH - 0.16;
  const tailZ = -halfLen - 0.005;
  const tailX = m.width / 2 - 0.32;
  const tailStart = lightParts.reduce((a, g) => a + g.attributes.position.count, 0);
  for (const s of [-1, 1]) {
    const tl = new THREE.BoxGeometry(0.46, 0.1, 0.06);
    tl.translate(s * tailX, tailY, tailZ);
    lightParts.push(prep(tl, [0.5, 0.02, 0.02, 1]));
  }
  const bar = new THREE.BoxGeometry(m.width * 0.38, 0.035, 0.05);
  bar.translate(0, tailY, tailZ);
  lightParts.push(prep(bar, [0.5, 0.02, 0.02, 1]));
  const tailEnd = lightParts.reduce((a, g) => a + g.attributes.position.count, 0);
  for (const s of [-1, 1]) {
    const rv = new THREE.BoxGeometry(0.12, 0.06, 0.05);
    rv.translate(s * (tailX - 0.32), tailY - 0.1, tailZ);
    lightParts.push(prep(rv, [0.25, 0.25, 0.25, 1]));
  }
  const revEnd = lightParts.reduce((a, g) => a + g.attributes.position.count, 0);
  const lightGeo = mergeGeometries(lightParts);
  lightParts.forEach((p) => p.dispose());

  // ---- assemble ----
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const fin = FINISH[colorDef.finish] || FINISH.gloss;
  const paintMat = ghost
    ? mats.ghost
    : new THREE.MeshStandardMaterial({ color: colorDef.hex, vertexColors: true, ...fin });
  const paint = new THREE.Mesh(paintGeo, paintMat);
  const details = new THREE.Mesh(detailGeo, ghost ? mats.ghost : mats.details);
  const lights = new THREE.Mesh(lightGeo, ghost ? mats.ghost : mats.lights);
  for (const mesh of [paint, details]) {
    mesh.castShadow = !ghost;
    mesh.receiveShadow = false;
  }
  bodyGroup.add(paint, details, lights);

  const wheelGeo = wheelGeometry(m);
  const wheels = new THREE.InstancedMesh(wheelGeo, ghost ? mats.ghost : mats.details, 4);
  wheels.castShadow = !ghost;
  wheels.frustumCulled = false; // instance matrices move every frame; the car root is culled instead
  root.add(wheels);

  const wheelPos = [
    new THREE.Vector3(m.track / 2, m.wheelR, m.wheelbase / 2), // front left (+X is left)
    new THREE.Vector3(-m.track / 2, m.wheelR, m.wheelbase / 2), // front right
    new THREE.Vector3(m.track / 2, m.wheelR, -m.wheelbase / 2), // rear left
    new THREE.Vector3(-m.track / 2, m.wheelR, -m.wheelbase / 2), // rear right
  ];

  const lightPoints = {
    head: [new THREE.Vector3(headX, headY, headZ + 0.12), new THREE.Vector3(-headX, headY, headZ + 0.12)],
    tail: [new THREE.Vector3(tailX, tailY, tailZ - 0.06), new THREE.Vector3(-tailX, tailY, tailZ - 0.06)],
    exhaust: [
      new THREE.Vector3(m.width * 0.28, m.bottom + 0.12, -halfLen - 0.12),
      new THREE.Vector3(-m.width * 0.28, m.bottom + 0.12, -halfLen - 0.12),
    ],
  };

  return {
    root,
    body: bodyGroup,
    paint,
    details,
    lights,
    wheels,
    wheelPos,
    paintMat,
    tailRange: [tailStart, tailEnd],
    revRange: [tailEnd, revEnd],
    lightPoints,
    model: m,
    ghost,
  };
}

// ============================================================================
// CAR = physics + model + visual state
// ============================================================================
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

export class Car {
  /**
   * @param {object} def entry from CARS
   * @param {object} colorDef entry from COLORS
   * @param {object} opts { ghost, isPlayer, name }
   */
  constructor(def, colorDef, opts = {}) {
    this.def = def;
    this.colorDef = colorDef;
    this.isPlayer = !!opts.isPlayer;
    this.isGhost = !!opts.ghost;
    this.name = opts.name || def.name;
    this.physics = new CarPhysics(def.physics);
    this.view = buildCarModel(def, colorDef, { ghost: this.isGhost });
    this.root = this.view.root;
    this.bodyPitch = 0;
    this.bodyPitchVel = 0;
    this.bodyRoll = 0;
    this.bodyRollVel = 0;
    this.heave = 0;
    this.heaveVel = 0;
    this._brakeShown = -1;
    this._revShown = -1;
    // race bookkeeping (managed by game.js)
    this.race = null;
  }

  setColor(colorDef) {
    this.colorDef = colorDef;
    this._nightGlow = -1;
    if (this.isGhost) return;
    const fin = FINISH[colorDef.finish] || FINISH.gloss;
    this.view.paintMat.color.setHex(colorDef.hex);
    this.view.paintMat.metalness = fin.metalness;
    this.view.paintMat.roughness = fin.roughness;
  }

  /** Interpolate physics state for rendering and animate body/wheels/lights. */
  updateVisual(alpha, dt) {
    const ph = this.physics;
    const v = this.view;
    const root = this.root;
    root.position.lerpVectors(ph.prevPos, ph.pos, alpha);
    root.rotation.set(-lerp(ph.prevPitch, ph.pitch, alpha), lerp(ph.prevYaw, ph.yaw, alpha), lerp(ph.prevRoll, ph.roll, alpha));

    // body motion from weight transfer (spring-damper)
    const k = 90;
    const cd = 11;
    const pitchT = clamp(-ph.accelLong * 0.0065, -0.06, 0.06); // nose dives when braking
    const rollT = clamp(-ph.accelLat * 0.0055, -0.07, 0.07);
    this.bodyPitchVel += ((pitchT - this.bodyPitch) * k - this.bodyPitchVel * cd) * dt;
    this.bodyPitch += this.bodyPitchVel * dt;
    this.bodyRollVel += ((rollT - this.bodyRoll) * k - this.bodyRollVel * cd) * dt;
    this.bodyRoll += this.bodyRollVel * dt;
    if (ph.landImpact > 1) this.heaveVel -= ph.landImpact * 0.12;
    this.heaveVel += (-this.heave * 160 - this.heaveVel * 14) * dt;
    this.heave += this.heaveVel * dt;
    this.heave = clamp(this.heave, -0.12, 0.08);
    v.body.rotation.set(this.bodyPitch, 0, this.bodyRoll);
    v.body.position.y = this.heave;

    // wheels
    const steer = ph.wheelAngle;
    for (let i = 0; i < 4; i++) {
      const wp = v.wheelPos[i];
      _e.set(ph.wheelRot, i < 2 ? steer : 0, 0, 'YXZ');
      _q.setFromEuler(_e);
      _p.copy(wp);
      if (!ph.grounded) _p.y -= 0.08; // suspension droop in the air
      _m4.compose(_p, _q, _s);
      v.wheels.setMatrixAt(i, _m4);
    }
    v.wheels.instanceMatrix.needsUpdate = true;

    // brake / reverse lights via vertex colours (only when the state changes)
    if (!this.isGhost) {
      const braking = ph.braking ? 1 : 0;
      if (braking !== this._brakeShown) {
        this._brakeShown = braking;
        const col = v.lights.geometry.attributes.color;
        const [a, b] = v.tailRange;
        for (let i = a; i < b; i++) col.setXYZ(i, braking ? 1.6 : 0.55, braking ? 0.08 : 0.02, braking ? 0.06 : 0.02);
        col.needsUpdate = true;
      }
      const rev = ph.reversing ? 1 : 0;
      if (rev !== this._revShown) {
        this._revShown = rev;
        const col = v.lights.geometry.attributes.color;
        const [a, b] = v.revRange;
        for (let i = a; i < b; i++) col.setXYZ(i, rev ? 1.4 : 0.25, rev ? 1.4 : 0.25, rev ? 1.35 : 0.25);
        col.needsUpdate = true;
      }
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.view.paint.geometry.dispose();
    this.view.details.geometry.dispose();
    this.view.lights.geometry.dispose();
    this.view.wheels.dispose();
    if (!this.isGhost) this.view.paintMat.dispose();
  }
}
