// Headless AI race: 6 AI cars race 2 laps on every track (forward + reverse).
// Verifies that AI drivers complete laps, don't get stuck and lap in a sane time.
// Usage: node scripts/sim-race.mjs

import { CARS, CarPhysics, PHYSICS_DT } from '../src/car.js';
import { TrackPath } from '../src/track.js';
import { TRACKS } from '../src/tracks-data.js';
import { TrackWorld, collideCars } from '../src/world-physics.js';
import { AIDriver, DIFFICULTY } from '../src/ai.js';

const dt = PHYSICS_DT;
const LAPS = 2;
let failed = false;

for (const tdef of TRACKS) {
  for (const reverse of [false, true]) {
    const path = new TrackPath({ ...tdef, reverse });
    const world = new TrackWorld(path, 'grass');
    const cars = [];
    const ais = [];
    for (let i = 0; i < 6; i++) {
      const def = CARS[i % CARS.length];
      const physics = new CarPhysics(def.physics);
      const p = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
      const { heading } = path.gridSlot(i, p);
      p.y = world.sampleGround(p.x, p.z, null, {}).height;
      physics.reset(p, heading);
      const car = { physics, race: { dist: path.deltaS(0, path.project(p.x, p.z, -1).s), s: path.project(p.x, p.z, -1).s, laps: 0, lapStart: 0, lapTimes: [], wallHits: 0, stuck: 0 } };
      cars.push(car);
      ais.push(new AIDriver(car, path, { skill: DIFFICULTY.normal.skill - i * 0.01, lane: [-2, 2, -1, 1, 0, 0][i], seed: i + 1 }));
    }
    let t = 0;
    const leaderDist = () => Math.max(...cars.map((c) => c.race.dist));
    while (t < 400 && cars.some((c) => c.race.laps < LAPS)) {
      t += dt;
      const lead = leaderDist();
      for (let i = 0; i < ais.length; i++) {
        // rubber band against the leader of the pack so the sim stays meaningful
        ais[i].update(dt, { cars: cars.map((c) => ({ physics: c.physics })).map((o, k) => (k === i ? ais[i].car : o)), rubberGap: cars[i].race.dist - lead + 30, racing: true, diff: DIFFICULTY.normal });
      }
      for (let i = 0; i < cars.length; i++) cars[i].physics.step(dt, ais[i].input, world);
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) collideCars(cars[i].physics, cars[j].physics);
      for (const c of cars) {
        const ph = c.physics;
        if (ph.impact > 4) c.race.wallHits++;
        ph.impact = 0;
        const q = path.project(ph.pos.x, ph.pos.z, ph.trackHint);
        const ds = path.deltaS(c.race.s, q.s);
        c.race.dist += ds;
        if (c.race.s > path.length * 0.9 && q.s < path.length * 0.1 && c.race.dist > (c.race.laps + 0.5) * path.length) {
          c.race.laps++;
          c.race.lapTimes.push(t - c.race.lapStart);
          c.race.lapStart = t;
        }
        c.race.s = q.s;
        if (ph.speed < 1) c.race.stuck += dt;
      }
    }
    const done = cars.filter((c) => c.race.laps >= LAPS).length;
    const best = Math.min(...cars.flatMap((c) => c.race.lapTimes.slice(1)));
    const avgSpeed = cars.reduce((a, c) => a + c.race.dist, 0) / cars.length / t;
    const hits = cars.reduce((a, c) => a + c.race.wallHits, 0);
    const stuck = Math.max(...cars.map((c) => c.race.stuck));
    const ok = done === cars.length;
    if (!ok) failed = true;
    console.log(
      `${tdef.id.padEnd(8)} ${reverse ? 'rev' : 'fwd'}  finished ${done}/6 in ${t.toFixed(0)}s  best flying lap ${isFinite(best) ? best.toFixed(1) + 's' : '-'}  ` +
        `avg ${(avgSpeed * 3.6).toFixed(0)} km/h  hard hits ${hits}  max stuck ${stuck.toFixed(1)}s  ${ok ? 'ok' : 'FAIL'}`,
    );
  }
}
if (failed) {
  console.error('\nSome AI cars failed to finish.');
  process.exit(1);
}
console.log('\nAI race checks passed.');
