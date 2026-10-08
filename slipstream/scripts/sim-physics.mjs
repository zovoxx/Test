// Headless handling tests for the arcade car model (no browser needed).
// Usage: npm run test:physics
// Prints acceleration, braking, cornering and drift behaviour for every car and
// fails (exit 1) if a car is outside sane arcade limits.

import { CARS, CarPhysics, PHYSICS_DT } from '../src/car.js';
import { TrackPath } from '../src/track.js';
import { TRACKS } from '../src/tracks-data.js';
import { TrackWorld } from '../src/world-physics.js';

const dt = PHYSICS_DT;
const flat = {
  sampleGround(x, z, car, out) {
    out.height = 0;
    out.grip = 1;
    out.rolling = 1;
    out.surface = 0;
    out.offroad = false;
    return out;
  },
  collide() {},
};

function input(o = {}) {
  return { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false, ...o };
}

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

for (const def of CARS) {
  const car = new CarPhysics(def.physics);
  const c = car.cfg;
  const out = [];
  // --- acceleration --------------------------------------------------------
  car.reset({ x: 0, y: 0, z: 0 }, 0);
  let t = 0;
  let t100 = null;
  let t200 = null;
  while (t < 60) {
    car.step(dt, input({ throttle: 1 }), flat);
    t += dt;
    if (t100 == null && car.speedKmh >= 100) t100 = t;
    if (t200 == null && car.speedKmh >= 200) t200 = t;
  }
  const top = car.speedKmh;
  out.push(`0-100 ${t100?.toFixed(2)}s  0-200 ${t200?.toFixed(2)}s  top(60s) ${top.toFixed(0)} km/h (target ${c.topSpeedKmh}) gear ${car.gear}`);
  check(t100 > 2.4 && t100 < 6, `${def.id}: 0-100 ${t100}`);
  check(Math.abs(top - c.topSpeedKmh) < 15, `${def.id}: top speed ${top}`);

  // --- boost top speed ------------------------------------------------------
  for (let i = 0; i < 60 * 8; i++) {
    car.boost = 1;
    car.step(dt, input({ throttle: 1, boost: true }), flat);
  }
  out.push(`boost top ${car.speedKmh.toFixed(0)} km/h`);
  check(car.speedKmh < c.topSpeedKmh * 1.25, `${def.id}: boost too fast`);

  // --- braking 100 -> 0 ----------------------------------------------------
  car.reset({ x: 0, y: 0, z: 0 }, 0);
  car.vel.set(0, 0, 100 / 3.6);
  let z0 = car.pos.z;
  t = 0;
  car.speed = car.vel.length();
  while (car.speed > 0.1 && t < 10) {
    car.step(dt, input({ brake: 1 }), flat);
    t += dt;
  }
  out.push(`brake 100-0: ${(car.pos.z - z0).toFixed(1)} m in ${t.toFixed(2)} s`);
  check(car.pos.z - z0 < 45, `${def.id}: braking distance`);

  // --- reverse ----------------------------------------------------------------
  car.reset({ x: 0, y: 0, z: 0 }, 0);
  for (let i = 0; i < 60 * 5; i++) car.step(dt, input({ brake: 1 }), flat);
  out.push(`reverse after 5s: ${car.forwardSpeed.toFixed(1)} m/s (${(car.forwardSpeed * 3.6).toFixed(0)} km/h) gear ${car.gear}`);
  check(car.forwardSpeed < -5, `${def.id}: reverse`);

  // --- steady cornering at various speeds (partial + full steer) --------------
  for (const kmh of [50, 100, 150]) {
    for (const steer of [0.4, 1]) {
      car.reset({ x: 0, y: 0, z: 0 }, 0);
      car.vel.set(0, 0, kmh / 3.6);
      let maxBeta = 0;
      let driftT = 0;
      const yaw0 = car.yaw;
      let turned = 0;
      let prevYaw = car.yaw;
      for (let i = 0; i < 60 * 3; i++) {
        // hold speed roughly constant with throttle
        const thr = car.speedKmh < kmh ? 0.9 : 0.25;
        car.step(dt, input({ steer, throttle: thr }), flat);
        maxBeta = Math.max(maxBeta, Math.abs(car.slipAngle));
        if (car.drifting) driftT += dt;
        let dy = car.yaw - prevYaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        turned += dy;
        prevYaw = car.yaw;
      }
      const latG = (car.speed * Math.abs(car.yawRate)) / 9.81;
      out.push(
        `turn ${kmh}km/h steer ${steer}: end ${car.speedKmh.toFixed(0)}km/h, turned ${((turned * 180) / Math.PI).toFixed(0)}°/3s, ` +
          `latG ${latG.toFixed(2)}, maxSlip ${((maxBeta * 180) / Math.PI).toFixed(1)}°, drift ${driftT.toFixed(2)}s, R≈${(car.speed / Math.max(1e-3, Math.abs(car.yawRate))).toFixed(0)}m`,
      );
      if (steer === 0.4 && kmh >= 100) check(driftT === 0, `${def.id}: partial steer at ${kmh} drifted`);
      check(turned < 0, `${def.id}: steering right must turn right (yaw decreases)`);
      void yaw0;
    }
  }

  // --- power oversteer: full steer + full throttle at speed ----------------------
  {
    car.reset({ x: 0, y: 0, z: 0 }, 0);
    car.vel.set(0, 0, 120 / 3.6);
    let dT = 0;
    let firstDrift = null;
    for (let i = 0; i < 60 * 3; i++) {
      car.step(dt, input({ steer: 1, throttle: 1 }), flat);
      if (car.drifting) {
        dT += dt;
        if (firstDrift == null) firstDrift = i * dt;
      }
    }
    out.push(`full steer+throttle @120: drift starts ${firstDrift == null ? 'never' : firstDrift.toFixed(2) + 's'}, drift ${dT.toFixed(2)}s, end ${car.speedKmh.toFixed(0)}km/h`);
  }

  // --- handbrake drift ---------------------------------------------------------
  car.reset({ x: 0, y: 0, z: 0 }, 0);
  car.vel.set(0, 0, 110 / 3.6);
  const log = [];
  let driftTime = 0;
  for (let i = 0; i < 60 * 6; i++) {
    const tt = i * dt;
    let inp;
    if (tt < 0.45) inp = input({ steer: -1, throttle: 0.6, handbrake: true });
    else if (tt < 3.5) inp = input({ steer: -0.8, throttle: 1 });
    else if (tt < 3.9) inp = input({ steer: 0.5, throttle: 0.8 }); // counter-steer...
    else inp = input({ steer: 0, throttle: 0.8 }); // ...then straighten up
    car.step(dt, inp, flat);
    if (car.drifting) driftTime += dt;
    if (i % 30 === 0) log.push(`${tt.toFixed(1)}s:${((car.slipAngle * 180) / Math.PI).toFixed(0)}°/${car.speedKmh.toFixed(0)}${car.drifting ? 'D' : ''}`);
  }
  out.push(`handbrake drift: ${log.join(' ')}`);
  out.push(`  drift time ${driftTime.toFixed(2)}s, final drifting=${car.drifting}, speed ${car.speedKmh.toFixed(0)}km/h`);
  check(driftTime > 1.5, `${def.id}: handbrake drift too short`);
  check(!car.drifting, `${def.id}: drift did not end after counter-steer`);

  console.log(`\n== ${def.name} (${def.tagline}) finalDrive ${c.finalDrive.toFixed(2)} dragK ${c.dragK.toFixed(3)}`);
  for (const l of out) console.log('  ' + l);
}

// --- jump: ramp lip launches the car --------------------------------------------
{
  const car = new CarPhysics(CARS[0].physics);
  const ramp = {
    sampleGround(x, z, c, out) {
      // 20 m ramp rising to 3 m, then a sudden drop
      out.height = z > 10 && z < 30 ? ((z - 10) / 20) * 3 : 0;
      out.grip = 1;
      out.rolling = 1;
      out.surface = 0;
      out.offroad = false;
      return out;
    },
    collide() {},
  };
  car.reset({ x: 0, y: 0, z: 0 }, 0);
  car.vel.set(0, 0, 25);
  let maxY = 0;
  let airborne = 0;
  let landed = 0;
  for (let i = 0; i < 60 * 4; i++) {
    car.step(dt, input({ throttle: 0.5 }), ramp);
    maxY = Math.max(maxY, car.pos.y);
    if (!car.grounded) airborne += dt;
    if (car.landImpact > 0) landed = car.landImpact;
  }
  console.log(`\njump: airtime ${airborne.toFixed(2)}s, apex ${maxY.toFixed(2)}m, landing impact ${landed.toFixed(1)} m/s`);
  check(airborne > 0.5, 'ramp did not launch the car');
}

// --- walls: no tunnelling at very high speed on a real track ----------------------
{
  const def = TRACKS[0];
  const path = new TrackPath(def);
  const world = new TrackWorld(path);
  const car = new CarPhysics(CARS[1].physics);
  const p = { x: 0, y: 0, z: 0 };
  const v = { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } };
  void v;
  path.pointAt(200, 0, { set(x, y, z) { p.x = x; p.y = y; p.z = z; } });
  const heading = path.headingAt(200);
  car.reset({ x: p.x, y: p.y, z: p.z }, heading + 0.9); // aim at the wall
  car.vel.set(Math.sin(heading + 0.9) * 90, 0, Math.cos(heading + 0.9) * 90);
  let maxLat = 0;
  let impacts = 0;
  for (let i = 0; i < 60 * 3; i++) {
    car.step(dt, input({ throttle: 1 }), world);
    const q = path.project(car.pos.x, car.pos.z, car.trackHint);
    maxLat = Math.max(maxLat, Math.abs(q.lateral));
    if (car.impact > 0) impacts++;
    car.impact = 0;
  }
  console.log(`walls: max |lateral| ${maxLat.toFixed(2)} (wall at ${path.wallOffset}), impacts ${impacts}`);
  check(maxLat < path.wallOffset, 'car tunnelled through the wall');
  check(impacts > 0, 'no wall impact registered');
}

if (failures.length) {
  console.error('\nFAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('\nAll physics checks passed.');
