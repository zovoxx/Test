// Game: owns the renderer, scene and main loop; runs races, time trials and
// free roam; wires input, physics, AI, camera, effects, audio, HUD and menus.

import * as THREE from 'three';
import { Car, CARS, COLORS, PHYSICS_DT, getCarDef, getColor } from './car.js';
import { TrackPath } from './track.js';
import { TRACKS, getTrackDef } from './tracks-data.js';
import { TrackWorld, collideCars } from './world-physics.js';
import { Environment, THEMES, TIME_PRESETS } from './environment.js';
import { FreeRoamWorld, FreeRoamProps, freeRoamDef, FREE_ROAM_SPAWN } from './freeroam.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { HUD } from './hud.js';
import { UI } from './ui.js';
import { Effects } from './particles.js';
import { AIDriver, DIFFICULTY } from './ai.js';
import { GhostRecorder, GhostPlayer } from './ghost.js';
import { QualityManager } from './quality.js';
import * as store from './storage.js';
import * as TEX from './textures.js';
import { clamp, smoothstep, formatNumber, formatTime, nextFrame, isTouchDevice } from './utils.js';

const AI_NAMES = ['Kai Rivera', 'Mira Sato', 'Dex Okafor', 'Luna Berg', 'Rex Moreau', 'Ivy Chen'];
const AI_COLORS = ['race-red', 'electric', 'sunburst', 'arctic', 'teal', 'neon-pink', 'lime', 'midnight'];
const POSITION_COINS = [500, 350, 250, 160, 110, 80];
const STEP = PHYSICS_DT;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _s = new THREE.Vector3(1, 1, 1);
const _proj = {};
const NO_INPUT = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false };
const DUST_COLORS = { coastal: [0.55, 0.48, 0.36], canyon: [0.78, 0.6, 0.42], city: [0.6, 0.6, 0.62], freeroam: [0.58, 0.5, 0.38] };

function comparePositions(a, b) {
  const ra = a.race;
  const rb = b.race;
  if (ra.finished && rb.finished) return ra.finishTime - rb.finishTime;
  if (ra.finished) return -1;
  if (rb.finished) return 1;
  return rb.dist - ra.dist;
}

export class Game {
  constructor(dom) {
    this.dom = dom;
    this.save = store.loadSave();
    this.settings = this.save.settings;
    this.state = 'boot'; // boot | start | menu | garage | loading | countdown | racing | finished
    this.paused = false;
    this.session = null;
    this.acc = 0;
    this.last = 0;
    this.time = 0;
    this.debug = false;
    this.fpsTaps = [];
    this.portrait = false;
    this.hidden = false;
    this.menuCar = null;
    this.previewCar = null;
    this.envKey = null;
  }

  // =========================================================================
  // Boot
  // =========================================================================
  async init(onProgress = () => {}) {
    const dom = this.dom;
    const quality = this.settings.quality;
    // ---- renderer ----
    this.renderer = new THREE.WebGLRenderer({
      canvas: dom.canvas,
      antialias: quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.setClearColor(0x0b0e18, 1);
    TEX.setMaxAnisotropy(r.capabilities.getMaxAnisotropy());
    dom.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.dom.showFatal('The graphics context was lost (usually after the app was in the background for a while).', true);
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3400);
    this.scene.add(this.camera);
    this.rig = new CameraRig(this.camera);
    onProgress(0.08, 'Preparing renderer');
    await nextFrame();

    this.env = new Environment(r, this.scene);
    this.effects = new Effects(this.scene);
    this.audio = new AudioEngine();
    this.input = new Input(dom.touchRoot, this.settings);
    this.hud = new HUD(dom.hudRoot);
    this.quality = new QualityManager({
      renderer: r,
      apply: (level, pr) => this._applyQuality(level, pr),
    });
    this.ui = new UI(dom.uiRoot, this._uiHandlers());
    this._buildCarHelpers();

    this.hud.onPause = () => this.pause();
    this.hud.onReset = () => this.requestRespawn(true);
    this.hud.onFpsTap = () => this._fpsTap();
    this.input.onGamepadChange = (on, name) => {
      this.ui.toast(on ? `Controller connected` : 'Controller disconnected');
      if (!on && this._inSession() && !this.paused) this.pause();
      void name;
    };
    this.input.onTiltFail = (reason) => {
      const msg = {
        denied: 'Tilt permission was denied – switched back to wheel steering.',
        insecure: 'Tilt needs HTTPS on iPad – switched back to wheel steering.',
        unsupported: 'Tilt is not supported on this device.',
        nodata: 'No tilt data received – switched back to wheel steering.',
      }[reason];
      this.ui.toast(msg || 'Tilt unavailable.', 3500);
      this.settings.controlScheme = 'wheel';
      store.save();
      this.input.applyLayout();
      this.ui.refreshSettings();
    };
    this.input.onMenuNav = (dir) => this._menuNav(dir);

    this.quality.setUserLevel(this.settings.quality, this.settings.autoQuality);
    this.hud.setUnits(this.settings.units);
    this.hud.setFpsVisible(this.settings.showFps);
    this.rig.setMode(this.settings.cameraMode);
    onProgress(0.15, 'Building world');

    // ---- initial world (menu background) ----
    const trackId = this.save.selectedTrack || 'coastal';
    await this._loadEnvironment(getTrackDef(trackId), false, (p) => onProgress(0.15 + p * 0.75, 'Building world'));
    this._setupMenuScene();
    onProgress(0.95, 'Compiling shaders');
    await nextFrame();
    try {
      r.compile(this.scene, this.camera);
    } catch {
      /* compile is an optimisation only */
    }
    this._bindWindow();
    this._resize();
    onProgress(1, 'Ready');
    this.state = 'start';
    this.last = performance.now();
    r.setAnimationLoop((t) => this._frame(t));
  }

  _uiHandlers() {
    return {
      click: () => this.audio.click(),
      startRace: (o) => this.startSession('race', o),
      startTimeTrial: (o) => this.startSession('timetrial', o),
      startFreeRoam: () => this.startSession('freeroam', {}),
      openGarage: () => this._enterGarage(),
      garagePreview: (id) => this._garagePreview(id),
      backFrom: (screen) => this._backFrom(screen),
      screenLeft: (from) => {
        if (from === 'garage' && this.state === 'garage') this._leaveGarage();
      },
      settingChanged: (k, v) => this._settingChanged(k, v),
      calibrateTilt: () => {
        if (!this.input.tilt.enabled) {
          this.input.requestTiltPermission().then((ok) => {
            if (ok) setTimeout(() => this.ui.toast(`Tilt calibrated (${this.input.calibrateTilt().toFixed(1)}°)`), 400);
          });
        } else this.ui.toast(`Tilt calibrated (${this.input.calibrateTilt().toFixed(1)}°)`);
        store.save();
      },
      resume: () => this.resume(),
      restart: () => this.restart(),
      quit: () => this.quitToMenu(),
      resetCar: () => {
        this.resume();
        this.requestRespawn(true);
      },
      resetProgress: () => {
        this.save = store.resetProgress();
        this.settings = this.save.settings;
        this.ui.toast('Progress reset');
        this.ui.updateCoins();
      },
      unlocked: () => {
        this.audio.unlockSound();
        this.ui.updateCoins();
      },
      fullscreen: () => this._toggleFullscreen(),
      canFullscreen: () => this._canFullscreen(),
      nextTrack: () => {
        const s = this.session;
        const i = TRACKS.findIndex((t) => t.id === s.def.id);
        const next = TRACKS[(i + 1) % TRACKS.length];
        this.save.selectedTrack = next.id;
        store.save();
        this.startSession('race', { trackId: next.id, reverse: false });
      },
    };
  }

  // =========================================================================
  // Settings & quality
  // =========================================================================
  _applyQuality(level, pr) {
    this.renderer.setPixelRatio(pr);
    this._resize();
    this.env.setQuality(level);
    this.effects.setQuality(level);
    this.qualityLevel = level;
    if (this.blobs) this.blobs.material.opacity = level === 'low' ? 0.7 : 0.45;
  }

  _settingChanged(key, v) {
    const s = this.settings;
    switch (key) {
      case 'quality':
      case 'autoQuality':
        this.quality.setUserLevel(s.quality, s.autoQuality);
        break;
      case 'controlScheme':
        if (v === 'tilt') {
          // iOS: the permission prompt must come from this user gesture
          this.input.requestTiltPermission().then((ok) => {
            if (ok) {
              this.input.applyLayout();
              setTimeout(() => {
                this.input.calibrateTilt();
                store.save();
              }, 600);
            }
          });
        } else this.input.applyLayout();
        break;
      case 'controlSize':
      case 'controlOpacity':
      case 'swapSides':
        this.input.applyLayout();
        break;
      case 'cameraMode':
        this.rig.setMode(v);
        break;
      case 'units':
        this.hud.setUnits(v);
        break;
      case 'showFps':
        this.hud.setFpsVisible(v);
        break;
      case 'masterVolume':
      case 'musicVolume':
      case 'sfxVolume':
      case 'musicMuted':
        this._applyVolumes();
        break;
      default:
        break;
    }
  }

  _applyVolumes() {
    const s = this.settings;
    this.audio.setVolumes({ master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume, musicMuted: s.musicMuted });
  }

  // =========================================================================
  // Window / lifecycle
  // =========================================================================
  _bindWindow() {
    const onResize = () => {
      this._resize();
      clearTimeout(this._resizeTimer);
      // iOS reports stale sizes right after rotation; check again shortly after
      this._resizeTimer = setTimeout(() => this._resize(), 350);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.hidden = true;
        if (this._inSession() && !this.paused) this.pause();
        this.audio.suspend();
      } else {
        this.hidden = false;
        this.last = performance.now();
        if (this.state !== 'boot' && this.state !== 'start') this.audio.resume();
      }
    });
    window.addEventListener('blur', () => {
      if (this._inSession() && !this.paused && !this.hidden) this.pause();
    });
    window.addEventListener('pagehide', () => store.save(true));
    // resume audio on any interaction (iOS may interrupt the context)
    const wake = () => {
      if (this.audio.ctx && this.audio.ctx.state !== 'running') this.audio.unlock();
    };
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('keydown', wake);
    // canvas drag rotates the garage turntable
    let dragX = null;
    this.dom.canvas.addEventListener('pointerdown', (e) => {
      if (this.state === 'garage') dragX = e.clientX;
    });
    window.addEventListener('pointermove', (e) => {
      if (dragX == null || this.state !== 'garage') return;
      this.rig.orbit.angle -= (e.clientX - dragX) * 0.008;
      dragX = e.clientX;
    });
    window.addEventListener('pointerup', () => (dragX = null));
    window.addEventListener('pointercancel', () => (dragX = null));
  }

  _resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const portrait = isTouchDevice() && h > w * 1.05;
    if (portrait !== this.portrait) {
      this.portrait = portrait;
      this.dom.rotateOverlay.classList.toggle('on', portrait);
      if (portrait && this._inSession() && !this.paused) this.pause();
    }
  }

  _inSession() {
    return !!this.session && (this.state === 'countdown' || this.state === 'racing' || this.state === 'finished');
  }

  _canFullscreen() {
    const el = document.documentElement;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    return !standalone && !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }

  _toggleFullscreen() {
    const d = document;
    const el = d.documentElement;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    } catch {
      this.ui.toast('Fullscreen is not available here. Add to Home Screen instead.');
    }
  }

  /** Called from the "Tap to start" screen inside the user gesture. */
  start() {
    this.audio.unlock();
    this._applyVolumes();
    this.audio.playMusic('menu');
    this.state = 'menu';
    this.ui.show('main');
  }

  // =========================================================================
  // Environment / menu scene
  // =========================================================================
  async _loadEnvironment(def, freeroam, onProgress) {
    const key = freeroam ? 'freeroam' : def.id + (def.reverse ? '-rev' : '');
    if (this.envKey === key && !freeroam) return;
    this._clearCars();
    this.effects.clear();
    this.path = freeroam ? null : new TrackPath(def);
    this.envDef = freeroam ? freeRoamDef() : def;
    await this.env.build(this.envDef, this.path, onProgress);
    this.world = freeroam ? new FreeRoamWorld() : new TrackWorld(this.path, THEMES[def.theme].runoff);
    this.rig.path = this.path;
    this.rig.groundHeight = (x, z) => this.env.heightAt(x, z);
    this.envKey = freeroam ? 'freeroam' : key;
    this.props = null;
    if (freeroam) this.props = new FreeRoamProps(this.env.group);
    this._buildMinimap();
    const tod = this.settings.timeOfDay;
    this._applyTimeOfDay(tod, this.envDef);
  }

  _applyTimeOfDay(tod, def) {
    this.env.cycle = tod === 'cycle';
    this.env.setTimeOfDay(TIME_PRESETS[tod] ?? def.timeOfDay ?? 13);
  }

  _buildMinimap() {
    if (this.path) this.hud.buildMinimap({ path: this.path, bounds: this.path.bounds });
    else {
      const B = 520;
      this.hud.buildMinimap({
        bounds: { minX: -B, maxX: B, minZ: -B, maxZ: B },
        extras: (ctx, toMap, scale) => {
          const [x0, y0] = toMap(-B, -B);
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x0, y0, B * 2 * scale, B * 2 * scale);
          const [cx, cy] = toMap(0, 0);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.beginPath();
          ctx.arc(cx, cy, 95 * scale, 0, Math.PI * 2);
          ctx.fill();
        },
      });
    }
  }

  _clearCars() {
    if (this.session) {
      for (const c of this.session.cars) c.dispose();
      if (this.session.ghostCar) this.session.ghostCar.dispose();
      this.session = null;
    }
    if (this.menuCar) {
      this.menuCar.dispose();
      this.menuCar = null;
    }
    if (this.previewCar) {
      this.previewCar.dispose();
      this.previewCar = null;
    }
  }

  _playerCarDef() {
    const s = this.save;
    const def = getCarDef(s.unlockedCars.includes(s.selectedCar) ? s.selectedCar : 'vector');
    const color = getColor(s.carColors[def.id] || def.defaultColor);
    return { def, color };
  }

  _spawnPoint() {
    const p = new THREE.Vector3();
    let yaw = 0;
    if (this.path) {
      const g = this.path.gridSlot(0, p);
      yaw = g.heading;
    } else {
      p.set(FREE_ROAM_SPAWN.x, 0, FREE_ROAM_SPAWN.z);
      yaw = FREE_ROAM_SPAWN.yaw;
    }
    p.y = this.world.sampleGround(p.x, p.z, null, {}).height;
    return { p, yaw };
  }

  _setupMenuScene() {
    if (this.menuCar) this.menuCar.dispose();
    const { def, color } = this._playerCarDef();
    const car = new Car(def, color, { isPlayer: true });
    const { p, yaw } = this._spawnPoint();
    car.physics.reset(p, yaw);
    car.physics.trackHint = -1;
    this.scene.add(car.root);
    car.updateVisual(1, 0);
    this.menuCar = car;
    this.rig.setOrbit(p, 9.5, 2.6, 0.12, 0.8);
    this.rig.viewShift = -0.16; // car to the right of the menu buttons
    this.hud.show(false);
    this.input.setEnabled(false);
    this.audio.setDriving(false);
    this.quality.active = false;
  }

  _enterGarage() {
    this.state = 'garage';
    this._garagePreview(this.save.selectedCar);
  }

  _garagePreview(carId) {
    const def = getCarDef(carId);
    const color = getColor(this.save.carColors[def.id] || def.defaultColor);
    if (this.menuCar) this.menuCar.root.visible = false;
    if (this.previewCar) this.previewCar.dispose();
    const car = new Car(def, color);
    const { p, yaw } = this._spawnPoint();
    car.physics.reset(p, yaw);
    this.scene.add(car.root);
    car.updateVisual(1, 0);
    this.previewCar = car;
    const keepAngle = this.state === 'garage' && this.rig.state === 'orbit' ? this.rig.orbit.angle : yaw + 2.2;
    this.rig.setOrbit(p, 6.8, 1.5, 0.18, 0.55);
    this.rig.orbit.angle = keepAngle;
    this.rig.viewShift = 0.2; // car to the left of the garage panel
    // shift the car to the left of the garage panel
    this._garageCenter = p.clone();
  }

  _backFrom(screen) {
    if (screen === 'garage') this._leaveGarage();
    if (screen === 'settings' && this.paused) {
      this.ui.show('pause');
      return;
    }
    if (this.paused) this.ui.show('pause');
    else this.ui.show('main');
  }

  _leaveGarage() {
    if (this.previewCar) {
      this.previewCar.dispose();
      this.previewCar = null;
    }
    this.state = 'menu';
    this._setupMenuScene();
  }

  // =========================================================================
  // Sessions
  // =========================================================================
  /**
   * @param {'race'|'timetrial'|'freeroam'} mode
   * @param {{trackId?:string, reverse?:boolean}} opts
   */
  async startSession(mode, opts) {
    if (this.state === 'loading') return;
    const prevState = this.state;
    this.state = 'loading';
    this.paused = false;
    this.ui.hideAll();
    this.dom.showLoading(true, 'Loading track');
    this.audio.stopMusic();
    await nextFrame();
    const freeroam = mode === 'freeroam';
    let def = null;
    if (!freeroam) {
      def = { ...getTrackDef(opts.trackId), reverse: !!opts.reverse };
    }
    try {
      await this._loadEnvironment(freeroam ? null : def, freeroam, (p) => this.dom.setLoading(p, 'Loading track'));
      if (!freeroam) this._applyTimeOfDay(this.settings.timeOfDay, this.envDef);
    } catch (err) {
      console.error(err);
      this.dom.showLoading(false);
      this.state = prevState;
      this.ui.toast('Could not load the track.');
      this.ui.show('main');
      return;
    }
    this._clearCars();
    const s = this._createSession(mode, freeroam ? this.envDef : def);
    this.session = s;
    this.dom.setLoading(1, 'Ready');
    try {
      this.renderer.compile(this.scene, this.camera);
    } catch {
      /* optional */
    }
    await nextFrame();
    this.dom.showLoading(false);
    this._beginSession();
  }

  _createSession(mode, def) {
    const s = {
      mode,
      def,
      trackKey: def.id + (def.reverse ? '-rev' : ''),
      laps: mode === 'race' ? this.settings.laps : mode === 'timetrial' ? 3 : 0,
      diff: DIFFICULTY[this.settings.difficulty] || DIFFICULTY.normal,
      cars: [],
      ais: [],
      raceTime: 0,
      countdown: 0,
      finished: false,
      finishTimer: 0,
      drift: { active: false, score: 0, mult: 1, time: 0, idle: 0, total: 0 },
      stats: { topSpeed: 0, collisions: 0, lastCollision: -10 },
      ghostCar: null,
      ghostPlayer: null,
      recorder: null,
      bestGhost: null,
      cpSplits: [],
      safePos: null,
      safeTimer: 0,
      coinsEarned: 0,
    };
    const { def: carDef, color } = this._playerCarDef();
    const player = new Car(carDef, color, { isPlayer: true, name: 'You' });
    s.player = player;
    s.cars.push(player);
    this.audio.setPlayerCar(carDef);
    if (mode === 'race') {
      const used = new Set([color.id]);
      const aiCount = 5;
      for (let i = 0; i < aiCount; i++) {
        const cdef = CARS[(i + 1) % CARS.length];
        let cid = AI_COLORS[i % AI_COLORS.length];
        if (used.has(cid)) cid = AI_COLORS[(i + 3) % AI_COLORS.length];
        used.add(cid);
        const car = new Car(cdef, getColor(cid), { name: AI_NAMES[i] });
        s.cars.push(car);
        const offsets = [0.02, 0.0, -0.012, -0.028, -0.045];
        s.ais.push(new AIDriver(car, this.path, { skill: s.diff.skill + offsets[i], lane: [-2, 2, -1, 1, 0][i], seed: i + 1 }));
      }
    }
    for (const c of s.cars) this.scene.add(c.root);
    if (mode === 'timetrial') {
      s.recorder = new GhostRecorder();
      const g = this.save.ghosts[s.trackKey];
      if (g) {
        const data = store.decodeFloats(g.data);
        if (data) {
          s.bestGhost = { lapMs: g.lapMs, cpSplits: g.cpSplits || [] };
          this._setGhost(s, data, g.carId);
        }
      }
    }
    return s;
  }

  _setGhost(s, data, carId) {
    if (!s.ghostCar || s.ghostCar.def.id !== carId) {
      if (s.ghostCar) s.ghostCar.dispose();
      s.ghostCar = new Car(getCarDef(carId), COLORS[0], { ghost: true });
      this.scene.add(s.ghostCar.root);
    }
    s.ghostCar.root.visible = false;
    s.ghostPlayer = new GhostPlayer(data, s.ghostCar);
  }

  _beginSession() {
    const s = this.session;
    const path = this.path;
    // place cars
    const p = new THREE.Vector3();
    const playerSlot = Math.min(s.cars.length - 1, s.diff.gridSlot ?? s.cars.length - 1);
    s.cars.forEach((car, i) => {
      let yaw;
      if (s.mode === 'race') {
        // player slot depends on difficulty; AI fill the remaining slots in order
        const slot = i === 0 ? playerSlot : i - 1 < playerSlot ? i - 1 : i;
        yaw = path.gridSlot(slot, p).heading;
      } else if (s.mode === 'timetrial') {
        path.pointAt(path.length - 60, 0, p);
        yaw = path.headingAt(path.length - 60);
      } else {
        p.set(FREE_ROAM_SPAWN.x, 0, FREE_ROAM_SPAWN.z);
        yaw = FREE_ROAM_SPAWN.yaw;
      }
      p.y = this.world.sampleGround(p.x, p.z, null, {}).height;
      car.physics.reset(p, yaw);
      car.physics.trackHint = -1;
      car.race = this._newRaceState(car);
      car.updateVisual(1, 0);
    });
    if (this.props) this.props.reset();
    this.effects.clear();
    this._skidState = new Map();
    this.acc = 0;
    s.raceTime = 0;
    this.hud.setMode(s.mode, { laps: s.laps, cars: s.cars.length, coins: this.props ? this.props.totalCoins : 0 });
    this.hud.show(true);
    this.hud.setBestLabel('BEST');
    this.input.setEnabled(true);
    this.input.boostLevel = 1;
    this.audio.setDriving(true);
    this.audio.ensureAIVoices(s.ais.length);
    this.audio.playMusic(this.envDef.music ?? 0);
    this.quality.active = true;
    this.rig.viewShift = 0;
    this.rig.lookBehind = false;
    this.rig.setMode(this.settings.cameraMode);
    if (s.mode === 'freeroam') {
      this.state = 'racing';
      this.rig.follow();
      s.player.physics.locked = false;
      this.hud.message('FREE ROAM', 'Drift, jump and collect the coins', 2600);
      s.safePos = { x: s.player.physics.pos.x, y: s.player.physics.pos.y, z: s.player.physics.pos.z, yaw: s.player.physics.yaw };
    } else {
      this.state = 'countdown';
      s.countdown = 0;
      s.lastCount = 99;
      for (const c of s.cars) c.physics.locked = true;
      this.rig.startIntro(3.4);
      this.env.setStartLights(0);
    }
  }

  _newRaceState(car) {
    const path = this.path;
    const st = {
      lap: 1,
      nextCp: 1,
      dist: 0,
      s: 0,
      lapStart: 0,
      lapTimes: [],
      bestLap: null,
      finished: false,
      finishTime: 0,
      wrongTimer: 0,
      stuckTimer: 0,
      lastCpIndex: 0,
      cpTimes: [],
      started: false,
      position: 1,
    };
    if (path) {
      const q = path.project(car.physics.pos.x, car.physics.pos.z, -1, _proj);
      st.s = q.s;
      st.dist = path.deltaS(0, q.s); // negative behind the start line
      if (this.session && this.session.mode === 'timetrial') {
        st.lap = 0;
        st.nextCp = 0;
      }
      car.physics.trackHint = q.index;
    }
    return st;
  }

  restart() {
    const s = this.session;
    if (!s) return;
    this.paused = false;
    this.ui.hideAll();
    const mode = s.mode;
    // rebuild cars to reset all per-car state
    for (const c of s.cars) c.dispose();
    if (s.ghostCar) s.ghostCar.dispose();
    this.session = this._createSession(mode, s.def);
    this._beginSession();
  }

  quitToMenu() {
    this.paused = false;
    this.audio.resume();
    this.audio.silenceAI();
    const s = this.session;
    if (s && s.mode === 'freeroam' && s.coinsEarned > 0) this.ui.toast(`+${s.coinsEarned} coins earned in Free Roam`);
    if (s && s.mode === 'freeroam') {
      // the free-roam world is not a menu backdrop: go back to the last track
      this._clearCars();
      this.state = 'loading';
      this.dom.showLoading(true, 'Loading');
      this._loadEnvironment(getTrackDef(this.save.selectedTrack || 'coastal'), false, (p) => this.dom.setLoading(p, 'Loading')).then(() => {
        this.dom.showLoading(false);
        this._toMenu();
      });
      return;
    }
    this._clearCars();
    this._toMenu();
  }

  _toMenu() {
    this.state = 'menu';
    this.effects.clear();
    this._applyTimeOfDay(this.settings.timeOfDay, this.envDef);
    this._setupMenuScene();
    this.audio.playMusic('menu');
    this.ui.show('main');
  }

  pause() {
    if (!this._inSession() || this.paused || this.session.resultsShown) return;
    this.paused = true;
    this.input.setEnabled(false);
    this.audio.setDriving(false);
    this.ui.show('pause');
    const fr = this.session.mode === 'freeroam';
    this.ui.screens.pause.querySelector('[data-action="restart"]').style.display = fr ? 'none' : '';
    this.ui.screens.pause.querySelector('[data-action="reset-car"]').style.display = fr ? '' : '';
  }

  resume() {
    if (!this.paused) return;
    if (this.portrait) return;
    this.paused = false;
    this.audio.unlock();
    this.ui.hideAll();
    this.input.setEnabled(true);
    this.audio.setDriving(true);
    this.last = performance.now();
  }

  // =========================================================================
  // Main loop
  // =========================================================================
  _frame(now) {
    let raw = (now - this.last) / 1000;
    this.last = now;
    if (!(raw > 0)) raw = 0.016;
    const dt = Math.min(raw, 0.1);
    this.time += dt;
    try {
      this.quality.sample(raw);
      this._update(dt);
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      if (!this._errLogged) {
        this._errLogged = true;
        console.error(err);
      }
    }
  }

  _update(dt) {
    const inp = this.input.update(dt);
    this._handleActions();
    const s = this.session;
    let alpha = 1;
    const active = s && !this.paused && (this.state === 'countdown' || this.state === 'racing' || this.state === 'finished');
    if (active) {
      const turbo = this.testTurbo || 1; // automated tests can fast-forward
      this.acc += dt * turbo;
      const maxSteps = 5 * turbo;
      let steps = 0;
      while (this.acc >= STEP && steps < maxSteps) {
        this._fixedStep(STEP, inp);
        this.acc -= STEP;
        steps++;
      }
      if (steps === maxSteps) this.acc = 0;
      alpha = this.acc / STEP;
    }
    // visuals
    if (s && s.player.race) {
      for (const c of s.cars) c.updateVisual(active ? alpha : 1, active ? dt : 0);
      if (s.ghostPlayer && s.player.race.started) s.ghostPlayer.update(s.raceTime - s.player.race.lapStart);
      this.rig.lookBehind = inp.lookBehind && this.state !== 'finished';
      this.rig.update(dt, s.player);
      if (active) {
        this._updateEffects(dt);
        this._updateAudio(dt);
      }
      this._updateCarHelpers(s.cars);
      this._updateHud(dt);
      const pp = s.player.root.position;
      this.env.update(dt, pp, this.camera);
    } else {
      const focus = this.previewCar || this.menuCar;
      if (focus) {
        focus.updateVisual(1, dt);
        this._updateCarHelpers([focus]);
      }
      this.rig.update(dt, null);
      this.env.update(dt, focus ? focus.root.position : this.rig.orbit.center, this.camera);
    }
    this.effects.update(dt);
    const view = this.renderer.getDrawingBufferSize(_v1).y / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.effects.setView(view, this.scene.fog.near, this.scene.fog.far);
    if (this.env.lampGlows) this.env.lampGlows.setView(view, this.scene.fog.near * 1.5, this.scene.fog.far * 1.3);
    if (this.env.signGlows) this.env.signGlows.setView(view, this.scene.fog.near * 1.5, this.scene.fog.far * 1.3);
    if (this.settings.showFps) this.hud.setFps(this.quality.fps);
    if (this.debug) this._updateDebug();
  }

  _handleActions() {
    const inp = this.input;
    if (inp.consume('debug')) this._toggleDebug();
    if (!this._inSession()) {
      inp.clearActions();
      return;
    }
    if (inp.consume('pause')) {
      if (this.paused) this.resume();
      else this.pause();
    }
    if (this.paused) {
      inp.clearActions();
      return;
    }
    while (inp.consume('camera')) {
      const m = this.rig.cycleMode();
      this.settings.cameraMode = m;
      store.save();
    }
    if (inp.consume('reset')) this.requestRespawn(true);
  }

  // =========================================================================
  // Fixed-step simulation
  // =========================================================================
  _fixedStep(dt, inp) {
    const s = this.session;
    const player = s.player;

    if (this.state === 'countdown') this._updateCountdown(dt);
    else s.raceTime += dt;

    // AI + player inputs
    const racing = this.state === 'racing' || this.state === 'finished';
    for (let i = 0; i < s.ais.length; i++) {
      const ai = s.ais[i];
      const gap = ai.car.race.dist - player.race.dist;
      ai.update(dt, { cars: s.cars, rubberGap: s.mode === 'race' ? gap : 0, racing, diff: s.diff });
    }
    let pInput = inp;
    if (this.state === 'countdown') {
      // engine can be revved on the grid, but the car is held
      this._cdInput = this._cdInput || { ...NO_INPUT };
      this._cdInput.throttle = inp.throttle;
      pInput = this._cdInput;
    }
    if (this._respawning) pInput = NO_INPUT;
    if (s.autopilot) pInput = s.autopilot.update(dt, { cars: s.cars, rubberGap: 0, racing: true, diff: s.diff });
    player.physics.step(dt, pInput, this.world);
    for (const ai of s.ais) ai.car.physics.step(dt, ai.input, this.world);

    // car vs car
    const cars = s.cars;
    for (let i = 0; i < cars.length; i++)
      for (let j = i + 1; j < cars.length; j++) collideCars(cars[i].physics, cars[j].physics);

    if (this.path) for (const c of cars) this._updateProgress(c, dt);
    else this._updateFreeRoam(dt);

    this._updateDrift(dt);
    this._checkStuck(dt);
    if (s.recorder && player.race.started) s.recorder.record(s.raceTime - player.race.lapStart, player.physics);
    const kmh = player.physics.speedKmh;
    if (kmh > s.stats.topSpeed && this.state !== 'countdown') s.stats.topSpeed = kmh;
    if (this.state === 'finished') {
      s.finishTimer += dt;
      if (s.finishTimer > 3.2 && !s.resultsShown) this._showResults();
    }
  }

  _updateCountdown(dt) {
    const s = this.session;
    s.countdown += dt;
    const t = s.countdown;
    const startAt = 0.6;
    const n = 3 - Math.floor(t - startAt);
    if (t >= startAt && n !== s.lastCount) {
      s.lastCount = n;
      if (n > 0) {
        this.hud.countdown(String(n));
        this.audio.countdownBeep(false);
        this.env.setStartLights((4 - n) * 2 - (n === 1 ? 1 : 0));
      } else if (n === 0) {
        this.hud.countdown('GO!', true);
        this.audio.countdownBeep(true);
        this.env.setStartLights(5, true);
        this.state = 'racing';
        for (const c of s.cars) c.physics.locked = false;
        for (const c of s.cars) c.race.lapStart = 0;
        if (s.mode === 'race') for (const c of s.cars) c.race.started = true;
        this.rig.follow();
        s.raceTime = 0;
      }
    }
  }

  _updateProgress(car, dt) {
    const s = this.session;
    const path = this.path;
    const ph = car.physics;
    const r = car.race;
    const q = path.project(ph.pos.x, ph.pos.z, ph.trackHint, _proj);
    const prevS = r.s;
    const ds = path.deltaS(prevS, q.s);
    r.s = q.s;
    if (r.finished) {
      r.dist += Math.max(0, ds);
      return;
    }
    r.dist += ds;
    // checkpoints in order (index 0 = start/finish line)
    const cps = path.checkpoints;
    const cpS = cps[r.nextCp] * path.spacing;
    if (Math.abs(ds) < 40 && path.deltaS(prevS, cpS) > 0 && path.deltaS(cpS, q.s) >= 0) {
      this._passCheckpoint(car, r.nextCp);
    }
    // wrong way (player only)
    if (car === s.player && this.state === 'racing') {
      const dot = Math.sin(ph.yaw) * q.tx + Math.cos(ph.yaw) * q.tz;
      const wrong = dot < -0.3 && ph.speed > 4 && ph.forwardSpeed > 0;
      r.wrongTimer = wrong ? r.wrongTimer + dt : Math.max(0, r.wrongTimer - dt * 3);
      const show = r.wrongTimer > 1.1;
      if (show && !this._wrongShown) this.audio.wrongWay();
      this._wrongShown = show;
    }
  }

  _passCheckpoint(car, idx) {
    const s = this.session;
    const r = car.race;
    const path = this.path;
    const isPlayer = car === s.player;
    r.lastCpIndex = idx;
    if (idx === 0) {
      // crossed the start/finish line
      if (s.mode === 'timetrial' && !r.started) {
        r.started = true;
        r.lap = 1;
        r.lapStart = s.raceTime;
        r.cpTimes = [];
        if (s.recorder) s.recorder.start();
        r.nextCp = 1;
        this.hud.message('GO!', 'Lap timing started', 1000);
        return;
      }
      const lapTime = s.raceTime - r.lapStart;
      r.lapTimes.push(lapTime);
      const newBest = r.bestLap == null || lapTime < r.bestLap;
      if (newBest) r.bestLap = lapTime;
      r.lapStart = s.raceTime;
      r.nextCp = 1;
      if (isPlayer) this._playerLap(lapTime, newBest);
      if (r.lap >= s.laps && s.mode !== 'freeroam') {
        r.finished = true;
        r.finishTime = s.raceTime;
        if (isPlayer) this._playerFinished();
      } else {
        r.lap++;
        r.cpTimes = [];
        if (isPlayer && r.lap === s.laps && s.laps > 1) this.hud.message('FINAL LAP', '', 1600, 'final');
      }
    } else {
      r.cpTimes[idx] = s.raceTime - r.lapStart;
      r.nextCp = (idx + 1) % path.checkpoints.length;
      if (isPlayer) {
        this.audio.checkpoint();
        // split vs best lap (time trial) or own best lap
        const ref = s.mode === 'timetrial' && s.bestGhost ? s.bestGhost.cpSplits : s.bestCpTimes;
        if (ref && ref[idx] != null) this.hud.showSplit((r.cpTimes[idx] - ref[idx]) * 1000);
      }
    }
  }

  _playerLap(lapTime, newBestSession) {
    const s = this.session;
    const r = s.player.race;
    const ms = Math.round(lapTime * 1000);
    const carId = s.player.def.id;
    const prevAll = store.getBestLap(s.trackKey);
    const record = store.submitLap(s.trackKey, carId, ms);
    const allTimeBest = prevAll == null || ms < prevAll;
    if (newBestSession) s.bestCpTimes = r.cpTimes.slice();
    if (allTimeBest) {
      this.audio.lap(true);
      this.hud.message('NEW RECORD', formatTime(ms), 2200, 'best');
      s.newRecord = true;
    } else if (record) {
      this.audio.lap(true);
      this.hud.message('PERSONAL BEST', formatTime(ms), 2000, 'best');
    } else {
      this.audio.lap(false);
      if (r.lap < s.laps) this.hud.message(`LAP ${r.lap + 1}`, formatTime(ms), 1500);
    }
    // ghost
    if (s.mode === 'timetrial' && s.recorder) {
      const data = s.recorder.finish();
      const best = s.bestGhost ? s.bestGhost.lapMs : Infinity;
      if (data && ms < best) {
        this.save.ghosts[s.trackKey] = { carId, lapMs: ms, cpSplits: r.cpTimes.slice(), data: store.encodeFloats(data) };
        store.save();
        s.bestGhost = { lapMs: ms, cpSplits: r.cpTimes.slice() };
        this._setGhost(s, data, carId);
      }
      if (r.lap < s.laps) s.recorder.start();
    }
  }

  _playerFinished() {
    const s = this.session;
    this.state = 'finished';
    s.finishTimer = 0;
    const pos = this._positions().indexOf(s.player) + 1;
    s.finalPosition = pos;
    if (s.mode === 'race') this.hud.message(pos === 1 ? 'YOU WIN!' : `FINISHED ${pos}${['st', 'nd', 'rd'][pos - 1] || 'th'}`, '', 3000, pos === 1 ? 'best' : '');
    else this.hud.message('FINISHED', '', 3000);
    this._bankDrift(true);
    // autopilot drives the cool-down lap
    s.autopilot = new AIDriver(s.player, this.path, { skill: 0.85 });
    s.player.physics.gripScale = 1;
    this.input.setEnabled(false);
  }

  /** Cars ordered by race position (reuses one array; no per-frame garbage). */
  _positions() {
    const s = this.session;
    const order = this._order || (this._order = []);
    order.length = 0;
    for (const c of s.cars) order.push(c);
    order.sort(comparePositions);
    return order;
  }

  _showResults() {
    const s = this.session;
    s.resultsShown = true;
    const p = s.player;
    const pr = p.race;
    const L = this.path.length;
    const order = this._positions();
    const standings = order.map((c) => {
      const r = c.race;
      let time = r.finishTime;
      let finished = r.finished;
      let gap = '';
      if (!finished) {
        const remaining = s.laps * L - r.dist;
        const avg = Math.max(10, r.dist / Math.max(1, s.raceTime));
        time = s.raceTime + remaining / avg;
        finished = true; // estimated
      }
      return { name: c.name, color: c.colorDef.hex, isPlayer: c === p, finished, time: time * 1000, gap };
    });
    const pos = order.indexOf(p) + 1;
    const drift = Math.round(s.drift.total);
    let coins = 0;
    if (s.mode === 'race') {
      coins = Math.round(POSITION_COINS[pos - 1] * Math.pow(s.laps / 3, 0.7)) + Math.floor(drift / 100);
      if (s.stats.collisions === 0) coins += 100;
      this.save.stats.races++;
      if (pos === 1) this.save.stats.wins++;
    } else {
      coins = pr.lapTimes.length * 40 + (s.newRecord ? 150 : 0) + Math.floor(drift / 100);
    }
    this.save.stats.driftTotal += drift;
    store.addCoins(coins);
    store.save();
    this.ui.showResults({
      mode: s.mode,
      trackName: s.def.name + (s.def.reverse ? ' (Reverse)' : ''),
      laps: s.mode === 'race' ? s.laps : pr.lapTimes.map((t) => t * 1000),
      position: pos,
      standings,
      totalTime: (pr.finishTime || s.raceTime) * 1000,
      bestLap: pr.bestLap != null ? pr.bestLap * 1000 : null,
      newRecord: !!s.newRecord,
      topSpeed: this.settings.units === 'mph' ? `${Math.round(s.stats.topSpeed / 1.609)} mph` : `${Math.round(s.stats.topSpeed)} km/h`,
      drift,
      collisions: s.stats.collisions,
      coins,
    });
    if (s.mode === 'timetrial') this.ui.screens.results.querySelector('.standings').querySelectorAll('.st-row').forEach((el, i) => {
      if (pr.lapTimes[i] === pr.bestLap) el.classList.add('me');
    });
    this.rig.setOrbit(p.root.position, 8, 2.2, 0.2, 0.8);
    this.rig.viewShift = 0;
    this.audio.playMusic('menu');
    this.hud.show(false);
  }

  _updateFreeRoam(dt) {
    const s = this.session;
    const ph = s.player.physics;
    // remember safe respawn spots
    s.safeTimer += dt;
    if (s.safeTimer > 1.5 && ph.grounded && ph.speed > 3 && ph.impact === 0) {
      s.safeTimer = 0;
      s.safePos = { x: ph.pos.x - Math.sin(ph.yaw) * 4, y: ph.pos.y, z: ph.pos.z - Math.cos(ph.yaw) * 4, yaw: ph.yaw };
    }
    const ev = this.props.update(dt, [ph]);
    if (ev.coins) {
      this.audio.coin();
      store.addCoins(10 * ev.coins);
      s.coinsEarned += 10 * ev.coins;
      this.hud.popup('+10 coins', 'coin');
      for (let i = 0; i < 16; i++)
        this.effects.sparks.emit(ev.coinX, ev.coinY, ev.coinZ, (Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8, 0.6, 0.5, 0.1, 1, 0.8, 0.2, 1, 6, 1);
      if (this.props.collected === this.props.totalCoins) this.hud.message('ALL COINS!', 'You found every coin', 3000, 'best');
    }
    if (ev.cones) this.audio.noiseBurst(0.08, 900, 1.5, 0.15, 'bandpass');
  }

  // =========================================================================
  // Drift scoring
  // =========================================================================
  _updateDrift(dt) {
    const s = this.session;
    const d = s.drift;
    const ph = s.player.physics;
    if (this.state !== 'racing') return;
    // on tracks only drifts on tarmac count; free roam is a sandbox
    const drifting = ph.drifting && ph.grounded && ph.speed > 9 && Math.abs(ph.slipAngle) > 0.15 && (!this.path || !ph.ground.offroad);
    if (ph.impact > 6 && d.active) {
      d.active = false;
      d.score = 0;
      d.time = 0;
      this.hud.popup('DRIFT LOST', 'lost');
      this.audio.driftLost();
      return;
    }
    if (drifting) {
      if (!d.active) {
        d.active = true;
        d.score = 0;
        d.time = 0;
      }
      d.idle = 0;
      d.time += dt;
      d.mult = Math.min(5, 1 + Math.floor(d.time / 1.8));
      d.score += dt * ph.speed * Math.min(1.1, Math.abs(ph.slipAngle)) * 9 * d.mult;
    } else if (d.active) {
      d.idle += dt;
      if (d.idle > 1.0) this._bankDrift(false);
    }
  }

  _bankDrift(silent) {
    const s = this.session;
    const d = s.drift;
    if (!d.active) return;
    const pts = Math.round(d.score);
    d.active = false;
    d.score = 0;
    d.time = 0;
    if (pts < 50) return;
    d.total += pts;
    if (!silent) {
      this.hud.popup(`+${formatNumber(pts)}`, 'drift');
      this.audio.driftBank(pts);
    }
    if (s.mode === 'freeroam') {
      const c = Math.floor(pts / 200);
      if (c > 0) {
        store.addCoins(c);
        s.coinsEarned += c;
      }
    }
  }

  // =========================================================================
  // Stuck / respawn
  // =========================================================================
  _checkStuck(dt) {
    const s = this.session;
    if (this.state !== 'racing') return;
    for (const car of s.cars) {
      const ph = car.physics;
      const r = car.race;
      const tryingToMove = car === s.player ? this.input.state.throttle > 0.3 || this.input.state.brake > 0.3 : true;
      if (ph.speed < 1.2 && tryingToMove) r.stuckTimer += dt;
      else r.stuckTimer = Math.max(0, r.stuckTimer - dt);
      const lost = ph.pos.y < -60 || !isFinite(ph.pos.x);
      const flipped = Math.abs(ph.roll) > 1.2 || Math.abs(ph.pitch) > 1.2;
      if (r.stuckTimer > (car === s.player ? 3 : 4) || lost || (flipped && ph.grounded)) {
        r.stuckTimer = 0;
        if (car === s.player) this.requestRespawn(false);
        else this._respawnCar(car);
      }
    }
  }

  requestRespawn(manual) {
    if (!this._inSession() || this._respawning || this.state === 'countdown') return;
    if (this.state === 'finished') return;
    this._respawning = true;
    const fade = this.dom.fade;
    fade.classList.add('on');
    setTimeout(() => {
      if (this.session) {
        this._respawnCar(this.session.player);
        this.rig.snap();
        if (manual) this.hud.message('RESET', '', 700);
      }
      fade.classList.remove('on');
      setTimeout(() => (this._respawning = false), 200);
    }, 260);
  }

  _respawnCar(car) {
    const s = this.session;
    const ph = car.physics;
    const p = _v2;
    let yaw;
    if (this.path) {
      const r = car.race;
      const idx = this.path.checkpoints[r.lastCpIndex] ?? 0;
      let sPos = idx * this.path.spacing;
      // never respawn ahead of where the car actually was
      if (this.path.deltaS(r.s, sPos) > 0) sPos = r.s - 2;
      const lane = car === s.player ? 0 : (s.cars.indexOf(car) % 3) - 1;
      this.path.pointAt(sPos, lane * 3, p);
      yaw = this.path.headingAt(sPos);
      p.y = this.world.sampleGround(p.x, p.z, null, {}).height;
      const keep = { ...car.race };
      ph.reset(p, yaw);
      car.race = keep;
      const q = this.path.project(p.x, p.z, -1, _proj);
      ph.trackHint = q.index;
      // keep the progress bookkeeping consistent with the new position
      car.race.dist += this.path.deltaS(car.race.s, q.s);
      car.race.s = q.s;
    } else {
      const sp = s.safePos || { x: FREE_ROAM_SPAWN.x, z: FREE_ROAM_SPAWN.z, yaw: FREE_ROAM_SPAWN.yaw };
      p.set(sp.x, 0, sp.z);
      p.y = this.world.sampleGround(p.x, p.z, null, {}).height;
      ph.reset(p, sp.yaw);
    }
    ph.boost = Math.max(ph.boost, 0.3);
    const sk = this._skidState && this._skidState.get(car);
    if (sk) sk.valid = false;
  }

  // =========================================================================
  // Effects (particles, skids, lights, shadows)
  // =========================================================================
  _buildCarHelpers() {
    const max = 10;
    const blobGeo = new THREE.PlaneGeometry(2.6, 5.0).rotateX(-Math.PI / 2);
    this.blobs = new THREE.InstancedMesh(
      blobGeo,
      new THREE.MeshBasicMaterial({ map: TEX.blobShadowTexture(), transparent: true, depthWrite: false, opacity: 0.45, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }),
      max,
    );
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 1;
    this.blobs.count = 0;
    this.scene.add(this.blobs);
    const poolGeo = new THREE.PlaneGeometry(9, 16).rotateX(-Math.PI / 2).translate(0, 0, 10.5);
    this.pools = new THREE.InstancedMesh(
      poolGeo,
      new THREE.MeshBasicMaterial({
        map: TEX.lightPoolTexture(),
        color: 0xfff1d6,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        opacity: 0,
        polygonOffset: true,
        polygonOffsetFactor: -7,
        polygonOffsetUnits: -7,
      }),
      max,
    );
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 2;
    this.pools.count = 0;
    this.scene.add(this.pools);
  }

  _updateCarHelpers(cars) {
    const night = this.env.night;
    let n = 0;
    let g = 0;
    const glows = this.effects.glows;
    const lightK = smoothstep(0.15, 0.7, night);
    for (const car of cars) {
      if (car.isGhost || !car.root.visible) continue;
      const root = car.root;
      // faint self-illumination at night so cars read against dark scenery
      const glow = Math.round(lightK * 20) / 100;
      if (car._nightGlow !== glow) {
        car._nightGlow = glow;
        car.view.paintMat.emissive.setHex(car.colorDef.hex).multiplyScalar(glow);
      }
      // blob shadow follows the ground under the car
      _e.set(root.rotation.x, root.rotation.y, root.rotation.z, 'YXZ');
      _q.setFromEuler(_e);
      _v1.copy(root.position);
      _v1.y += 0.04;
      _m4.compose(_v1, _q, _s);
      this.blobs.setMatrixAt(n, _m4);
      if (lightK > 0.01) this.pools.setMatrixAt(n, _m4);
      n++;
      // light glows
      root.updateMatrixWorld();
      const lp = car.view.lightPoints;
      const braking = car.physics.braking;
      for (const h of lp.head) {
        _v1.copy(h).applyMatrix4(root.matrixWorld);
        glows.set(g++, _v1.x, _v1.y, _v1.z, 0.5 + lightK * 2.6, 1, 0.95, 0.85, 0.25 + lightK * 0.75);
      }
      for (const t of lp.tail) {
        _v1.copy(t).applyMatrix4(root.matrixWorld);
        const k = braking ? 1 : 0.35 + lightK * 0.3;
        glows.set(g++, _v1.x, _v1.y, _v1.z, (braking ? 1.6 : 0.9) * (0.6 + lightK * 0.6), 1, 0.12, 0.08, k);
      }
      if (car.physics.boosting) {
        for (const ex of lp.exhaust) {
          _v1.copy(ex).applyMatrix4(root.matrixWorld);
          glows.set(g++, _v1.x, _v1.y, _v1.z, 1.6, 0.4, 0.65, 1, 0.9);
        }
      }
    }
    for (let i = g; i < glows.count; i++) glows.alpha[i] = 0;
    glows.count = Math.max(g, 0);
    glows.commit();
    this.blobs.count = n;
    this.blobs.instanceMatrix.needsUpdate = true;
    this.pools.count = lightK > 0.01 ? n : 0;
    this.pools.material.opacity = lightK * 0.55;
    if (lightK > 0.01) this.pools.instanceMatrix.needsUpdate = true;
  }

  _updateEffects(dt) {
    const s = this.session;
    const fx = this.effects;
    for (const car of s.cars) {
      const ph = car.physics;
      const root = car.root;
      const m = car.view.model;
      const yaw = root.rotation.y;
      const fwx = Math.sin(yaw);
      const fwz = Math.cos(yaw);
      const rx = -fwz;
      const rz = fwx;
      const isPlayer = car === s.player;
      const nearCam = isPlayer || root.position.distanceToSquared(this.camera.position) < 90 * 90;
      if (!nearCam) continue;
      // rear wheel contact points
      const hb = m.wheelbase / 2;
      const ht = m.track / 2;
      const y = root.position.y;
      const rlx = root.position.x - fwx * hb + rx * -ht;
      const rlz = root.position.z - fwz * hb + rz * -ht;
      const rrx = root.position.x - fwx * hb + rx * ht;
      const rrz = root.position.z - fwz * hb + rz * ht;
      const slip = ph.slip;
      const off = ph.ground.offroad;
      const rate = dt * 60;
      if (ph.grounded && slip > 0.28 && !off) {
        const amt = (slip - 0.2) * 1.4 * rate;
        fx.tyreSmoke(rlx, y, rlz, ph.vel.x, ph.vel.z, amt);
        fx.tyreSmoke(rrx, y, rrz, ph.vel.x, ph.vel.z, amt);
      }
      if (ph.grounded && off && ph.speed > 4) {
        const amt = clamp(ph.speed / 30, 0.15, 1) * 0.7 * rate;
        const col = DUST_COLORS[this.envDef.theme] || DUST_COLORS.coastal;
        fx.dust(rlx, y, rlz, ph.vel.x, ph.vel.z, amt, col[0], col[1], col[2]);
        fx.dust(rrx, y, rrz, ph.vel.x, ph.vel.z, amt, col[0], col[1], col[2]);
      }
      // skid marks
      let sk = this._skidState.get(car);
      if (!sk) this._skidState.set(car, (sk = { lx: 0, lz: 0, rx: 0, rz: 0, y: 0, valid: false }));
      const skidding = ph.grounded && slip > 0.35 && !off;
      if (skidding) {
        if (sk.valid) {
          const st = clamp((slip - 0.3) * 1.6, 0.25, 1);
          fx.skids.add(sk.lx, sk.y + 0.03, sk.lz, rlx, y + 0.03, rlz, 0.13, st);
          fx.skids.add(sk.rx, sk.y + 0.03, sk.rz, rrx, y + 0.03, rrz, 0.13, st);
        }
        sk.lx = rlx;
        sk.lz = rlz;
        sk.rx = rrx;
        sk.rz = rrz;
        sk.y = y;
        sk.valid = true;
      } else sk.valid = false;
      // boost flames
      if (ph.boosting) {
        root.updateMatrixWorld();
        for (const ex of car.view.lightPoints.exhaust) {
          _v1.copy(ex).applyMatrix4(root.matrixWorld);
          for (let k = 0; k < 2; k++) fx.flame(_v1.x, _v1.y, _v1.z, ph.vel.x * 0.9 - fwx * 6, 0.3, ph.vel.z * 0.9 - fwz * 6, k === 0);
        }
      }
      // collisions
      if (ph.impact > 2.5) {
        const n = Math.min(30, ph.impact);
        const nx = root.position.x - ph.impactX;
        const nz = root.position.z - ph.impactZ;
        const l = Math.hypot(nx, nz) || 1;
        fx.sparksBurst(ph.impactX, y, ph.impactZ, nx / l, nz / l, n);
        const dist = Math.sqrt(root.position.distanceToSquared(this.camera.position));
        if (isPlayer) {
          this.audio.crash(ph.impact);
          this.rig.addTrauma(clamp(ph.impact / 28, 0.1, 0.8));
          if (ph.impact > 5 && s.raceTime - s.stats.lastCollision > 0.6) {
            s.stats.collisions++;
            s.stats.lastCollision = s.raceTime;
          }
        } else if (dist < 40) this.audio.crash(ph.impact * (1 - dist / 40));
        ph.impact = 0;
      } else if (ph.impact > 0) {
        if (isPlayer && ph.impact > 1) this.audio.scrape(ph.impact);
        ph.impact = 0;
      }
      if (ph.landImpact > 3.5 && isPlayer) {
        this.audio.landing(ph.landImpact);
        this.rig.addTrauma(clamp(ph.landImpact / 25, 0.1, 0.5));
        for (let k = 0; k < 6; k++) fx.dust(root.position.x, y, root.position.z, ph.vel.x, ph.vel.z, 1, 0.6, 0.55, 0.45);
      }
    }
    // impacts accumulate (max) across physics sub-steps until consumed here
    for (const car of s.cars) {
      car.physics.impact = 0;
      car.physics.landImpact = 0;
    }
  }

  _updateAudio(dt) {
    const s = this.session;
    const ph = s.player.physics;
    this.audio.updatePlayer(ph, dt);
    if (ph.boosting && !this._wasBoosting) this.audio.whoosh();
    this._wasBoosting = ph.boosting;
    if (ph.gear !== this._lastGear && ph.gear > 1 && this._lastGear > 0 && ph.gear > this._lastGear) this.audio.shift();
    this._lastGear = ph.gear;
    // AI voices: distance attenuation + stereo pan from the camera's view
    const cam = this.camera;
    cam.getWorldDirection(_v1);
    const rightX = -_v1.z;
    const rightZ = _v1.x;
    const rl = Math.hypot(rightX, rightZ) || 1;
    s.ais.forEach((ai, i) => {
      const p = ai.car.root.position;
      const dx = p.x - cam.position.x;
      const dz = p.z - cam.position.z;
      const d = Math.hypot(dx, dz);
      const pan = d > 0.1 ? (dx * rightX + dz * rightZ) / (rl * d) : 0;
      this.audio.updateAI(i, ai.car.physics, d, pan);
    });
  }

  // =========================================================================
  // HUD
  // =========================================================================
  _updateHud(dt) {
    const s = this.session;
    if (!s || s.resultsShown) return;
    const p = s.player;
    const ph = p.physics;
    this.hud.updateCar(ph);
    this.input.boostLevel = ph.boost;
    const r = p.race;
    if (s.mode === 'freeroam') {
      this.hud.updateRace({ coins: this.props.collected });
      this.hud.setFreeRoamInfo(s.drift.total + (s.drift.active ? s.drift.score : 0));
    } else {
      const order = this.state === 'countdown' ? null : this._positions();
      const lapTime = r.started || s.mode === 'race' ? (r.finished ? r.lapTimes[r.lapTimes.length - 1] : s.raceTime - r.lapStart) : 0;
      const best = s.mode === 'timetrial' ? (s.bestGhost ? s.bestGhost.lapMs / 1000 : null) : r.bestLap;
      const info = this._hudInfo || (this._hudInfo = {});
      info.position = order ? order.indexOf(p) + 1 : s.cars.length;
      info.cars = s.cars.length;
      info.lap = Math.max(1, Math.min(r.lap, s.laps));
      info.laps = s.laps;
      info.lapTime = (lapTime || 0) * 1000;
      info.bestLap = best != null ? best * 1000 : null;
      info.lastLap = r.lapTimes.length ? r.lapTimes[r.lapTimes.length - 1] * 1000 : null;
      this.hud.updateRace(info);
      this.hud.wrongWay(this._wrongShown && this.state === 'racing');
    }
    this.hud.drift(s.drift.active && s.drift.score > 30, Math.round(s.drift.score), s.drift.mult);
    // minimap at ~30 Hz
    this._mapTimer = (this._mapTimer || 0) + dt;
    if (this._mapTimer > 0.033) {
      this._mapTimer = 0;
      // pooled dot objects so the minimap creates no garbage
      const pool = this._dotPool || (this._dotPool = []);
      const dots = this._mapDots || (this._mapDots = []);
      dots.length = 0;
      const add = (x, z, color, size) => {
        const d = pool[dots.length] || (pool[dots.length] = { x: 0, z: 0, color: '', size: 3 });
        d.x = x;
        d.z = z;
        d.color = color;
        d.size = size;
        dots.push(d);
      };
      for (const c of s.cars) {
        if (c === p) continue;
        if (!c.colorCss) c.colorCss = '#' + c.colorDef.hex.toString(16).padStart(6, '0');
        add(c.root.position.x, c.root.position.z, c.colorCss, 3.4);
      }
      if (s.ghostCar && s.ghostCar.root.visible) add(s.ghostCar.root.position.x, s.ghostCar.root.position.z, 'rgba(111,227,255,0.8)', 3);
      if (this.props) for (const c of this.props.coins) if (!c.taken) add(c.x, c.z, '#ffc533', 2);
      const me = this._mapPlayer || (this._mapPlayer = { x: 0, z: 0, yaw: 0 });
      me.x = p.root.position.x;
      me.z = p.root.position.z;
      me.yaw = p.root.rotation.y;
      this.hud.drawMinimap(dots, me);
    }
    // speed lines & vignette
    const k = smoothstep(42, 85, ph.speed) * 0.55 + (ph.boosting ? 0.45 : 0);
    const kk = Math.round(clamp(k, 0, 1) * 50) / 50;
    if (kk !== this._speedK) {
      this._speedK = kk;
      this.dom.speedLines.style.opacity = String(kk);
      this.dom.vignette.classList.toggle('boost', ph.boosting);
    }
  }

  // =========================================================================
  // Debug overlay
  // =========================================================================
  _fpsTap() {
    const now = performance.now();
    this.fpsTaps = this.fpsTaps.filter((t) => now - t < 2000);
    this.fpsTaps.push(now);
    if (this.fpsTaps.length >= 5) {
      this.fpsTaps = [];
      this._toggleDebug();
    }
  }

  _toggleDebug() {
    this.debug = !this.debug;
    if (!this.debug) this.hud.setDebug(null);
  }

  _updateDebug() {
    const info = this.renderer.info;
    const s = this.session;
    const ph = s ? s.player.physics : null;
    const lines = [
      `FPS ${this.quality.fps}  quality ${this.qualityLevel} (${this.settings.quality}${this.settings.autoQuality ? ', auto' : ''})`,
      `pixel ratio ${this.renderer.getPixelRatio().toFixed(2)}  ${this.renderer.domElement.width}x${this.renderer.domElement.height}`,
      `draw calls ${info.render.calls}  triangles ${formatNumber(info.render.triangles)}`,
      `geometries ${info.memory.geometries}  textures ${info.memory.textures}  programs ${info.programs ? info.programs.length : '-'}`,
      `particles ${this.effects.smoke.count + this.effects.sparks.count}`,
    ];
    if (ph) {
      lines.push(
        `speed ${ph.speedKmh.toFixed(1)} km/h  rpm ${Math.round(ph.rpm)}  gear ${ph.gear}`,
        `slip ${((ph.slipAngle * 180) / Math.PI).toFixed(1)}°  slip fx ${ph.slip.toFixed(2)}  drift ${ph.drifting ? 'yes' : 'no'}`,
        `grounded ${ph.grounded}  surface ${ph.ground.surface}  boost ${(ph.boost * 100).toFixed(0)}%`,
        `pos ${ph.pos.x.toFixed(1)}, ${ph.pos.y.toFixed(1)}, ${ph.pos.z.toFixed(1)}`,
      );
    }
    this.hud.setDebug(lines.join('\n'));
  }

  // =========================================================================
  // Menu navigation with a gamepad (d-pad / stick + A / B)
  // =========================================================================
  _menuNav(dir) {
    const screen = this.ui.current && this.ui.screens[this.ui.current];
    if (this.state === 'start' && dir === 'confirm') {
      this.dom.startButton.click();
      return;
    }
    if (!screen) return;
    if (dir === 'back') {
      if (this.ui.current === 'pause') this.resume();
      else this.ui.back();
      return;
    }
    const items = Array.from(screen.querySelectorAll('button:not(.disabled), .card, [data-action]')).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    let cur = document.activeElement;
    if (!items.includes(cur)) {
      items[0].focus();
      return;
    }
    if (dir === 'confirm') {
      cur.click();
      return;
    }
    const r0 = cur.getBoundingClientRect();
    const cx = r0.left + r0.width / 2;
    const cy = r0.top + r0.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - cx;
      const dy = r.top + r.height / 2 - cy;
      const ok = (dir === 'up' && dy < -4) || (dir === 'down' && dy > 4) || (dir === 'left' && dx < -4) || (dir === 'right' && dx > 4);
      if (!ok) continue;
      const main = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
      const cross = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      const score = main + cross * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: 'nearest' });
      this.audio.click();
    }
  }

  // ---- hooks for automated tests (only reachable via window.__slip with ?test) ----
  setTestTurbo(n) {
    this.testTurbo = Math.max(1, Math.min(40, n | 0));
  }

  testAutopilot(on = true) {
    const s = this.session;
    if (!s || !this.path) return false;
    s.autopilot = on ? new AIDriver(s.player, this.path, { skill: 1 }) : null;
    return true;
  }

  testState() {
    const s = this.session;
    const ready = !!(s && s.player && s.player.race);
    return {
      state: this.state,
      paused: this.paused,
      mode: s ? s.mode : null,
      lap: ready ? s.player.race.lap : 0,
      dist: ready ? s.player.race.dist : 0,
      position: ready && this.path ? this._positions().indexOf(s.player) + 1 : 0,
      speedKmh: ready ? s.player.physics.speedKmh : 0,
      raceTime: ready ? s.raceTime : 0,
      aiDist: ready ? s.ais.map((a) => Math.round(a.car.race.dist)) : [],
      finished: ready ? !!s.resultsShown : false,
      ghostVisible: !!(s && s.ghostCar && s.ghostCar.root.visible),
      savedGhosts: Object.keys(this.save.ghosts || {}),
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      fps: this.quality.fps,
      quality: this.qualityLevel,
      audio: this.audio.ctx ? this.audio.ctx.state : 'none',
      coins: this.save.coins,
    };
  }
}

