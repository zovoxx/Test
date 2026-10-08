// All sound is synthesized with the Web Audio API – no audio files.
//
// iOS notes: the AudioContext is created and resumed inside the first user
// gesture (the "Tap to start" screen). navigator.audioSession (Safari 17+) is
// set to 'playback' so sound plays even with the ringer switch on silent.

import { clamp, makeRng } from './utils.js';

const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volumes = { master: 0.8, music: 0.45, sfx: 0.85, musicMuted: false };
    this.music = null;
    this.aiVoices = [];
    this.player = null;
    this._lastCrash = 0;
  }

  get available() {
    return !!AC;
  }

  /** Must be called from a user gesture (touchend / click / keydown). */
  unlock() {
    if (!AC) return false;
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
    } catch {
      /* not supported */
    }
    if (!this.ctx) {
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        try {
          this.ctx = new AC();
        } catch {
          return false;
        }
      }
      this._build();
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    // classic iOS unlock: play a 1-sample silent buffer inside the gesture
    try {
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
    } catch {
      /* ignore */
    }
    this.ready = true;
    return true;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') this.ctx.resume().catch(() => {});
  }

  _build() {
    const ctx = this.ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    // shared noise buffer
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    const rng = makeRng(99);
    for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
    // engine-like periodic waves
    this.engineWave = this._wave([0, 1, 0.75, 0.5, 0.42, 0.3, 0.26, 0.18, 0.15, 0.1, 0.08, 0.06]);
    this.engineWave2 = this._wave([0, 0.6, 1, 0.3, 0.55, 0.2, 0.3, 0.1, 0.12]);
    this.applyVolumes();
    this._buildPlayerVoices();
  }

  _wave(harm) {
    const real = new Float32Array(harm.length);
    const imag = new Float32Array(harm.length);
    for (let i = 1; i < harm.length; i++) imag[i] = harm[i];
    return this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  _noiseSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = Math.random();
    return s;
  }

  setVolumes(v) {
    Object.assign(this.volumes, v);
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = this.volumes;
    this.master.gain.setTargetAtTime(v.master, t, 0.03);
    this.sfx.gain.setTargetAtTime(v.sfx, t, 0.03);
    this.musicBus.gain.setTargetAtTime(v.musicMuted ? 0 : v.music * 0.55, t, 0.05);
  }

  // -------------------------------------------------------------------------
  // Continuous player voices: engine, screech, wind, boost, off-road rumble
  // -------------------------------------------------------------------------
  _buildPlayerVoices() {
    const ctx = this.ctx;
    const p = {};
    p.bus = ctx.createGain();
    p.bus.gain.value = 0;
    p.bus.connect(this.sfx);
    // engine
    p.engGain = ctx.createGain();
    p.engGain.gain.value = 0;
    p.engFilter = ctx.createBiquadFilter();
    p.engFilter.type = 'lowpass';
    p.engFilter.frequency.value = 800;
    p.engFilter.Q.value = 1.4;
    p.shaper = ctx.createWaveShaper();
    p.shaper.curve = distortionCurve(5);
    p.osc1 = ctx.createOscillator();
    p.osc1.setPeriodicWave(this.engineWave);
    p.osc2 = ctx.createOscillator();
    p.osc2.setPeriodicWave(this.engineWave2);
    p.osc3 = ctx.createOscillator();
    p.osc3.type = 'sawtooth';
    const g1 = ctx.createGain();
    g1.gain.value = 0.5;
    const g2 = ctx.createGain();
    g2.gain.value = 0.32;
    p.g3 = ctx.createGain();
    p.g3.gain.value = 0.12;
    p.osc1.connect(g1).connect(p.shaper);
    p.osc2.connect(g2).connect(p.shaper);
    p.osc3.connect(p.g3).connect(p.shaper);
    // rasp: band-passed noise following rpm
    p.rasp = this._noiseSource();
    p.raspFilter = ctx.createBiquadFilter();
    p.raspFilter.type = 'bandpass';
    p.raspFilter.Q.value = 2.5;
    p.raspGain = ctx.createGain();
    p.raspGain.gain.value = 0;
    p.rasp.connect(p.raspFilter).connect(p.raspGain).connect(p.shaper);
    p.shaper.connect(p.engFilter).connect(p.engGain).connect(p.bus);
    // screech
    p.scr = this._noiseSource();
    p.scrF1 = ctx.createBiquadFilter();
    p.scrF1.type = 'bandpass';
    p.scrF1.frequency.value = 1150;
    p.scrF1.Q.value = 9;
    p.scrF2 = ctx.createBiquadFilter();
    p.scrF2.type = 'bandpass';
    p.scrF2.frequency.value = 2300;
    p.scrF2.Q.value = 5;
    p.scrGain = ctx.createGain();
    p.scrGain.gain.value = 0;
    const scrMix = ctx.createGain();
    scrMix.gain.value = 3.2;
    p.scr.connect(p.scrF1).connect(scrMix);
    p.scr.connect(p.scrF2).connect(scrMix);
    scrMix.connect(p.scrGain).connect(p.bus);
    // wind
    p.wind = this._noiseSource();
    p.windF = ctx.createBiquadFilter();
    p.windF.type = 'lowpass';
    p.windF.frequency.value = 500;
    p.windGain = ctx.createGain();
    p.windGain.gain.value = 0;
    p.wind.connect(p.windF).connect(p.windGain).connect(p.bus);
    // boost roar
    p.boost = this._noiseSource();
    p.boostF = ctx.createBiquadFilter();
    p.boostF.type = 'bandpass';
    p.boostF.frequency.value = 700;
    p.boostF.Q.value = 0.8;
    p.boostGain = ctx.createGain();
    p.boostGain.gain.value = 0;
    p.boost.connect(p.boostF).connect(p.boostGain).connect(p.bus);
    // off-road rumble
    p.rumble = this._noiseSource();
    p.rumbleF = ctx.createBiquadFilter();
    p.rumbleF.type = 'lowpass';
    p.rumbleF.frequency.value = 180;
    p.rumbleGain = ctx.createGain();
    p.rumbleGain.gain.value = 0;
    p.rumble.connect(p.rumbleF).connect(p.rumbleGain).connect(p.bus);
    for (const s of [p.osc1, p.osc2, p.osc3, p.rasp, p.scr, p.wind, p.boost, p.rumble]) s.start();
    p.cylinders = 4;
    this.player = p;
  }

  /** Enable / mute the continuous player sounds (menus vs driving). */
  setDriving(on) {
    if (!this.ctx) return;
    this.player.bus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, on ? 0.15 : 0.08);
    if (!on) for (const v of this.aiVoices) v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  setPlayerCar(def) {
    if (!this.player) return;
    this.player.cylinders = def.id === 'raptor' ? 8 : def.id === 'nova' ? 10 : def.id === 'badger' ? 4 : 6;
  }

  /**
   * @param {import('./car.js').CarPhysics} ph
   * @param {number} dt
   */
  updatePlayer(ph, dt) {
    if (!this.ctx || !this.player) return;
    const p = this.player;
    const t = this.ctx.currentTime;
    const tc = 0.04;
    const rpm = ph.rpm;
    const thr = ph.throttleApplied;
    const fire = (rpm / 60) * (p.cylinders / 2);
    const base = clamp(fire, 20, 900);
    p.osc1.frequency.setTargetAtTime(base, t, tc);
    p.osc2.frequency.setTargetAtTime(base * 0.5, t, tc);
    p.osc3.frequency.setTargetAtTime(base * 2.01, t, tc);
    p.raspFilter.frequency.setTargetAtTime(base * 4, t, tc);
    p.raspGain.gain.setTargetAtTime(0.08 + thr * 0.25, t, tc);
    const shifting = ph.shiftTimer > 0 ? 0.55 : 1;
    p.engFilter.frequency.setTargetAtTime(380 + thr * 2600 + rpm * 0.25, t, 0.06);
    p.engGain.gain.setTargetAtTime((0.16 + thr * 0.2 + (rpm / ph.cfg.redline) * 0.12) * shifting, t, 0.05);
    p.g3.gain.setTargetAtTime(0.05 + thr * 0.12, t, tc);
    // tyres
    const slip = ph.grounded ? ph.slip : 0;
    const scr = slip > 0.12 ? clamp((slip - 0.12) * 1.3, 0, 1) * clamp(ph.speed / 12, 0.3, 1) : 0;
    const offroad = ph.ground.offroad;
    p.scrGain.gain.setTargetAtTime(offroad ? scr * 0.12 : scr * 0.5, t, 0.05);
    p.scrF1.frequency.setTargetAtTime(1000 + slip * 400 + Math.sin(t * 13) * 60, t, 0.05);
    // wind & rumble
    const sp = ph.speed;
    p.windGain.gain.setTargetAtTime(clamp((sp * sp) / 9000, 0, 0.45), t, 0.1);
    p.windF.frequency.setTargetAtTime(300 + sp * 14, t, 0.1);
    p.rumbleGain.gain.setTargetAtTime(offroad && ph.grounded ? clamp(sp / 25, 0, 0.7) : 0, t, 0.08);
    // boost
    p.boostGain.gain.setTargetAtTime(ph.boosting ? 0.32 : 0, t, ph.boosting ? 0.05 : 0.2);
    p.boostF.frequency.setTargetAtTime(ph.boosting ? 900 + sp * 8 : 500, t, 0.2);
    void dt;
  }

  // -------------------------------------------------------------------------
  // AI engine voices (distance attenuated + stereo panned)
  // -------------------------------------------------------------------------
  ensureAIVoices(n) {
    if (!this.ctx) return;
    while (this.aiVoices.length < n) {
      const ctx = this.ctx;
      const v = {};
      v.osc = ctx.createOscillator();
      v.osc.setPeriodicWave(this.engineWave);
      v.filter = ctx.createBiquadFilter();
      v.filter.type = 'lowpass';
      v.filter.frequency.value = 900;
      v.gain = ctx.createGain();
      v.gain.gain.value = 0;
      v.osc.connect(v.filter).connect(v.gain);
      if (ctx.createStereoPanner) {
        v.pan = ctx.createStereoPanner();
        v.gain.connect(v.pan).connect(this.sfx);
      } else v.gain.connect(this.sfx);
      v.osc.start();
      this.aiVoices.push(v);
    }
  }

  /** dist in metres, pan -1..1 */
  updateAI(i, ph, dist, pan) {
    const v = this.aiVoices[i];
    if (!v) return;
    const t = this.ctx.currentTime;
    const att = clamp(1 - dist / 110, 0, 1);
    v.gain.gain.setTargetAtTime(att * att * (0.14 + ph.throttleApplied * 0.1), t, 0.08);
    v.osc.frequency.setTargetAtTime(clamp((ph.rpm / 60) * 3, 20, 700), t, 0.05);
    v.filter.frequency.setTargetAtTime(500 + ph.throttleApplied * 1400, t, 0.08);
    if (v.pan) v.pan.pan.setTargetAtTime(clamp(pan, -0.9, 0.9), t, 0.05);
  }

  silenceAI() {
    if (!this.ctx) return;
    for (const v of this.aiVoices) v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  // -------------------------------------------------------------------------
  // One-shot effects
  // -------------------------------------------------------------------------
  _env(gainNode, t, attack, peak, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  tone(freq, dur = 0.15, type = 'sine', vol = 0.3, when = 0, slideTo = null, bus = null) {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    this._env(g, t, 0.005, vol, dur);
    o.connect(g).connect(bus || this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noiseBurst(dur, freq, q = 1, vol = 0.4, type = 'lowpass', when = 0) {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loopStart = 0;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this._env(g, t, 0.004, vol, dur);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
  }

  /** Collision sound scaled by impact speed (m/s). */
  crash(impact, metal = true) {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    if (now - this._lastCrash < 0.08) return;
    this._lastCrash = now;
    const k = clamp(impact / 25, 0.08, 1);
    this.noiseBurst(0.18 + k * 0.45, 500 + k * 2600, 0.7, 0.25 + k * 0.6);
    this.tone(95, 0.2 + k * 0.25, 'sine', 0.3 + k * 0.5, 0, 38);
    if (metal && k > 0.25) {
      for (const [f, d] of [
        [523, 0.5],
        [1247, 0.35],
        [2171, 0.25],
        [3320, 0.18],
      ])
        this.tone(f * (0.96 + Math.random() * 0.08), d * (0.5 + k), 'triangle', 0.045 * k);
    }
  }

  scrape(impact) {
    if (!this.running) return;
    this.noiseBurst(0.12, 2600, 2, clamp(impact / 30, 0.04, 0.2), 'bandpass');
  }

  landing(impact) {
    const k = clamp(impact / 12, 0.1, 1);
    this.tone(70, 0.25, 'sine', 0.35 * k, 0, 32);
    this.noiseBurst(0.18, 260, 0.8, 0.3 * k);
  }

  shift() {
    this.noiseBurst(0.05, 900, 2, 0.06, 'bandpass');
  }

  whoosh() {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(3200, t + 0.45);
    const g = ctx.createGain();
    this._env(g, t, 0.05, 0.45, 0.6);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t);
    s.stop(t + 0.75);
    this.tone(120, 0.5, 'sawtooth', 0.08, 0, 260);
  }

  countdownBeep(final = false) {
    if (final) {
      this.tone(1046, 0.7, 'triangle', 0.35);
      this.tone(523, 0.7, 'sine', 0.2);
    } else this.tone(523, 0.22, 'triangle', 0.32);
  }

  checkpoint() {
    this.tone(1318, 0.12, 'triangle', 0.18);
    this.tone(1760, 0.2, 'triangle', 0.18, 0.08);
  }

  lap(best = false) {
    const notes = best ? [784, 988, 1175, 1568, 1976] : [659, 831, 988, 1318];
    notes.forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.2, i * 0.08));
  }

  coin() {
    this.tone(988, 0.08, 'square', 0.12);
    this.tone(1318, 0.3, 'square', 0.12, 0.07);
  }

  driftBank(points) {
    const k = clamp(points / 3000, 0, 1);
    this.tone(660 + k * 300, 0.12, 'triangle', 0.15);
    this.tone(990 + k * 400, 0.25, 'triangle', 0.15, 0.07);
  }

  driftLost() {
    this.tone(330, 0.3, 'sawtooth', 0.08, 0, 160);
  }

  wrongWay() {
    this.tone(220, 0.18, 'square', 0.08);
    this.tone(196, 0.25, 'square', 0.08, 0.2);
  }

  click() {
    this.tone(1900, 0.035, 'sine', 0.12);
  }

  back() {
    this.tone(1300, 0.04, 'sine', 0.1);
  }

  unlockSound() {
    [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.16, i * 0.06));
  }

  // -------------------------------------------------------------------------
  // Procedural music
  // -------------------------------------------------------------------------
  playMusic(style = 'menu') {
    if (!this.ctx) return;
    if (this.music && this.music.style === style) return;
    this.stopMusic();
    this.music = new MusicSequencer(this, style);
    this.music.start();
  }

  stopMusic() {
    if (this.music) {
      this.music.stop();
      this.music = null;
    }
  }
}

function distortionCurve(k) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

// ---------------------------------------------------------------------------
// Generative music
// ---------------------------------------------------------------------------
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);
// chord = [root midi, quality] where quality 'M' | 'm'
const STYLES = {
  menu: { bpm: 92, prog: [[57, 'm'], [53, 'M'], [48, 'M'], [55, 'M']], drums: 0.4, arp: 'up', lead: 'triangle', pad: true, swing: 0 },
  0: { bpm: 114, prog: [[48, 'M'], [55, 'M'], [57, 'm'], [53, 'M']], drums: 1, arp: 'updown', lead: 'square', pad: true, swing: 0 },
  1: { bpm: 102, prog: [[57, 'm'], [53, 'M'], [48, 'M'], [55, 'M']], drums: 1, arp: 'up', lead: 'sawtooth', pad: true, swing: 0 },
  2: { bpm: 128, prog: [[52, 'm'], [48, 'M'], [55, 'M'], [50, 'M']], drums: 1.2, arp: 'down', lead: 'square', pad: false, swing: 0 },
  3: { bpm: 96, prog: [[50, 'm'], [46, 'M'], [53, 'M'], [48, 'M']], drums: 0.8, arp: 'random', lead: 'triangle', pad: true, swing: 0.1 },
};

class MusicSequencer {
  constructor(audio, style) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.style = style;
    this.cfg = STYLES[style] || STYLES.menu;
    this.step = 0;
    this.nextTime = 0;
    this.timer = 0;
    this.rng = makeRng(typeof style === 'number' ? style * 7 + 3 : 11);
    this.out = this.ctx.createGain();
    this.out.gain.value = 0;
    // simple feedback delay for space
    this.delay = this.ctx.createDelay(1);
    this.delay.delayTime.value = (60 / this.cfg.bpm) * 0.75;
    this.fb = this.ctx.createGain();
    this.fb.gain.value = 0.28;
    this.delayFilter = this.ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 2400;
    this.delay.connect(this.delayFilter).connect(this.fb).connect(this.delay);
    this.delayFilter.connect(this.out);
    this.out.connect(audio.musicBus);
  }

  start() {
    this.nextTime = this.ctx.currentTime + 0.1;
    this.out.gain.setTargetAtTime(1, this.ctx.currentTime, 0.6);
    this.timer = setInterval(() => this._schedule(), 30);
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.15);
    const out = this.out;
    setTimeout(() => {
      try {
        out.disconnect();
        this.delay.disconnect();
        this.fb.disconnect();
        this.delayFilter.disconnect();
      } catch {
        /* ignore */
      }
    }, 900);
  }

  _schedule() {
    if (this.ctx.state !== 'running') {
      this.nextTime = this.ctx.currentTime + 0.1;
      return;
    }
    const spb = 60 / this.cfg.bpm / 4; // seconds per 16th
    while (this.nextTime < this.ctx.currentTime + 0.15) {
      this._playStep(this.step, this.nextTime, spb);
      this.step++;
      this.nextTime += spb * (this.cfg.swing && this.step % 2 ? 1 + this.cfg.swing : 1 - (this.cfg.swing || 0));
    }
  }

  _voice(freq, t, dur, type, vol, cutoff = 2000, toDelay = false) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.out);
    if (toDelay) g.connect(this.delay);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _drum(kind, t) {
    const ctx = this.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.7, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(this.out);
      o.start(t);
      o.stop(t + 0.32);
      return;
    }
    const s = ctx.createBufferSource();
    s.buffer = this.audio.noise;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    if (kind === 'hat') {
      f.type = 'highpass';
      f.frequency.value = 7500;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    } else {
      f.type = 'bandpass';
      f.frequency.value = 1800;
      f.Q.value = 0.7;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.32, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      this._voice(190, t, 0.12, 'triangle', 0.15, 1200);
    }
    s.connect(f).connect(g).connect(this.out);
    s.start(t, Math.random() * 1.5);
    s.stop(t + 0.25);
  }

  _playStep(step, t, spb) {
    const c = this.cfg;
    const bar = Math.floor(step / 16);
    const s16 = step % 16;
    const [root, qual] = c.prog[bar % c.prog.length];
    const third = qual === 'm' ? 3 : 4;
    const chord = [0, third, 7, 12, 12 + third, 19];
    const section = Math.floor(bar / 4) % 4; // variation every 4 bars
    const dr = c.drums;
    // drums
    if (dr > 0 && section !== 3) {
      if (s16 % 4 === 0) this._drum('kick', t);
      if (dr >= 1 && (s16 === 4 || s16 === 12)) this._drum('snare', t);
      if (s16 % 2 === 0 || (dr > 1 && s16 % 2)) this._drum('hat', t);
      if (dr < 1 && s16 === 10 && section % 2) this._drum('kick', t);
    } else if (s16 === 0) this._drum('kick', t);
    // bass: root on 8ths with octave jumps
    if (s16 % 2 === 0) {
      const oct = s16 % 8 === 6 ? 12 : 0;
      this._voice(NOTE(root - 12 + oct), t, spb * 1.8, 'sawtooth', 0.16, 420);
    }
    // arpeggio on 16ths
    if (section !== 0 || bar > 1) {
      let idx;
      if (c.arp === 'up') idx = s16 % chord.length;
      else if (c.arp === 'down') idx = chord.length - 1 - (s16 % chord.length);
      else if (c.arp === 'updown') {
        const p = s16 % 10;
        idx = p < 6 ? p : 10 - p;
      } else idx = Math.floor(this.rng() * chord.length);
      if (s16 % 2 === 0 || this.rng() < 0.5) this._voice(NOTE(root + 12 + chord[idx % chord.length]), t, spb * 1.6, c.lead, 0.05, 2600, true);
    }
    // pad chord at bar start
    if (c.pad && s16 === 0) {
      for (const n of [0, third, 7]) this._voice(NOTE(root + n), t, spb * 15, 'sawtooth', 0.035, 900);
    }
    // occasional melody note
    if (s16 % 4 === 2 && this.rng() < 0.3 && section >= 1) {
      this._voice(NOTE(root + 24 + chord[Math.floor(this.rng() * 3)]), t, spb * 3, 'triangle', 0.06, 3000, true);
    }
  }
}

