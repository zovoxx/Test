// Input abstraction. Keyboard, multi-touch controls (wheel / buttons / tilt),
// and the Gamepad API all feed one normalized state:
//   steer [-1..1], throttle [0..1], brake [0..1], handbrake, boost, lookBehind
// plus edge-triggered actions: camera, reset, pause, debug.

import { clamp, damp } from './utils.js';

const KEYMAP = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'hand',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  KeyN: 'boost',
  KeyQ: 'look',
  KeyB: 'look',
};
const ACTION_KEYS = { KeyC: 'camera', KeyR: 'reset', KeyP: 'pause', Escape: 'pause', F3: 'debug' };

const GP_DEADZONE = 0.14;

function shapeSteer(v, sensitivity) {
  const a = Math.abs(v);
  if (a < 0.05) return 0;
  const n = (a - 0.05) / 0.95;
  return Math.sign(v) * clamp(Math.pow(n, 1.2) * sensitivity, 0, 1);
}

export class Input {
  /**
   * @param {HTMLElement} container element that receives the touch controls
   * @param {object} settings live settings object (storage.js)
   */
  constructor(container, settings) {
    this.settings = settings;
    this.container = container;
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false, lookBehind: false };
    this.keys = new Set();
    this.actions = new Set();
    this.keySteer = 0;
    this.touch = { steer: 0, gas: false, brake: false, hand: false, boost: false, look: false, left: false, right: false };
    this.touchSteerTarget = 0;
    this.buttonSteer = 0;
    this.gamepad = { connected: false, index: -1, steer: 0, throttle: 0, brake: 0, hand: false, boost: false, look: false, prev: [] };
    this.tilt = { enabled: false, raw: 0, steer: 0, received: false, available: typeof window !== 'undefined' && 'DeviceOrientationEvent' in window };
    this.enabled = false; // driving controls active
    this.boostLevel = 1; // for the nitro button ring
    this.onGamepadChange = null; // (connected:boolean, name) => void
    this.onMenuNav = null; // (dir: 'up'|'down'|'left'|'right'|'confirm'|'back') => void
    this.onTiltFail = null; // (reason) => void
    this._bindKeyboard();
    this._buildTouch();
    this._bindGamepad();
    this._onOrient = this._onOrient.bind(this);
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const k = KEYMAP[e.code];
      const a = ACTION_KEYS[e.code];
      if (k || a) {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'range') return;
        if (k && this.enabled) e.preventDefault();
        if (e.code === 'F3') e.preventDefault();
      }
      if (k) this.keys.add(k);
      if (a && !e.repeat) this.actions.add(a);
    });
    window.addEventListener('keyup', (e) => {
      const k = KEYMAP[e.code];
      if (k) this.keys.delete(k);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.releaseAllTouches();
    });
  }

  // -------------------------------------------------------------------------
  // Touch controls (DOM)
  // -------------------------------------------------------------------------
  _buildTouch() {
    const c = document.createElement('div');
    c.id = 'touch-controls';
    c.innerHTML = `
      <div class="steer-zone" data-zone="steer">
        <div class="wheel"><div class="wheel-rim"></div><div class="wheel-spokes"></div><div class="wheel-hub"></div><div class="wheel-mark"></div></div>
        <div class="steer-buttons">
          <div class="tbtn steer-btn" data-steer="-1" aria-label="Steer left"><svg viewBox="0 0 24 24"><path d="M15 4 7 12l8 8" /></svg></div>
          <div class="tbtn steer-btn" data-steer="1" aria-label="Steer right"><svg viewBox="0 0 24 24"><path d="m9 4 8 8-8 8" /></svg></div>
        </div>
        <div class="tilt-indicator"><div class="tilt-bar"><div class="tilt-dot"></div></div><span>TILT</span></div>
      </div>
      <div class="pedal-cluster">
        <div class="tbtn small" data-btn="look" aria-label="Look behind"><svg viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.6"/></svg></div>
        <div class="tbtn small" data-btn="camera" aria-label="Change camera"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/></svg></div>
        <div class="tbtn round nitro" data-btn="boost" aria-label="Nitro"><svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" /></svg><span>N₂O</span></div>
        <div class="tbtn round hand" data-btn="hand" aria-label="Handbrake / drift"><span>DRIFT</span></div>
        <div class="tbtn pedal brake" data-btn="brake" aria-label="Brake / reverse"><span>BRAKE</span></div>
        <div class="tbtn pedal gas" data-btn="gas" aria-label="Gas"><span>GAS</span></div>
      </div>`;
    this.container.appendChild(c);
    this.touchRoot = c;
    this.wheelEl = c.querySelector('.wheel');
    this.tiltDot = c.querySelector('.tilt-dot');
    this.nitroRing = c.querySelector('.nitro .ring circle');

    const stop = (e) => {
      if (e.cancelable) e.preventDefault();
    };
    // Block scrolling / zooming / callouts on the control layer.
    c.addEventListener('touchstart', stop, { passive: false });
    c.addEventListener('touchmove', stop, { passive: false });
    c.addEventListener('touchend', stop, { passive: false });
    c.addEventListener('contextmenu', stop);

    // --- steering zone (wheel): horizontal drag from the touch point ---
    const zone = c.querySelector('.steer-zone');
    this.steerPointer = null;
    this.steerAnchorX = 0;
    zone.addEventListener('pointerdown', (e) => {
      if (this.settings.controlScheme !== 'wheel' || this.steerPointer !== null) return;
      e.preventDefault();
      this.steerPointer = e.pointerId;
      this.steerAnchorX = e.clientX;
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      zone.classList.add('active');
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steerPointer) return;
      e.preventDefault();
      const range = 95 * (this.settings.controlSize || 1);
      let dx = (e.clientX - this.steerAnchorX) / range;
      // let the anchor follow a little when the finger goes past full lock
      if (dx > 1.15) this.steerAnchorX = e.clientX - range * 1.15;
      if (dx < -1.15) this.steerAnchorX = e.clientX + range * 1.15;
      this.touchSteerTarget = clamp(dx, -1, 1);
    });
    const endSteer = (e) => {
      if (e.pointerId !== this.steerPointer) return;
      this.steerPointer = null;
      this.touchSteerTarget = 0;
      zone.classList.remove('active');
    };
    zone.addEventListener('pointerup', endSteer);
    zone.addEventListener('pointercancel', endSteer);
    zone.addEventListener('lostpointercapture', endSteer);

    // --- generic press buttons (multi-touch: each tracks its own pointers) ---
    const bindButton = (el, onChange) => {
      const ids = new Set();
      const set = (on) => {
        el.classList.toggle('pressed', on);
        onChange(on);
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ids.add(e.pointerId);
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (ids.size === 1) {
          set(true);
          if (navigator.vibrate) {
            try {
              navigator.vibrate(8);
            } catch {
              /* ignore */
            }
          }
        }
      });
      const up = (e) => {
        if (!ids.delete(e.pointerId)) return;
        if (ids.size === 0) set(false);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el._release = () => {
        ids.clear();
        set(false);
      };
    };
    this._buttons = [];
    c.querySelectorAll('[data-btn]').forEach((el) => {
      const name = el.dataset.btn;
      this._buttons.push(el);
      bindButton(el, (on) => {
        if (name === 'camera') {
          if (on) this.actions.add('camera');
        } else this.touch[name] = on;
      });
    });
    c.querySelectorAll('[data-steer]').forEach((el) => {
      this._buttons.push(el);
      const dir = Number(el.dataset.steer);
      bindButton(el, (on) => {
        if (dir < 0) this.touch.left = on;
        else this.touch.right = on;
      });
    });
    this.applyLayout();
  }

  releaseAllTouches() {
    if (this._buttons) for (const b of this._buttons) b._release && b._release();
    this.steerPointer = null;
    this.touchSteerTarget = 0;
    this.touch.left = this.touch.right = false;
  }

  /** Apply control scheme / size / opacity / side settings to the DOM. */
  applyLayout() {
    const s = this.settings;
    const root = this.touchRoot;
    root.dataset.scheme = s.controlScheme;
    root.classList.toggle('swapped', !!s.swapSides);
    root.style.setProperty('--ctrl-scale', String(clamp(s.controlSize || 1, 0.85, 1.4)));
    root.style.setProperty('--ctrl-opacity', String(s.controlOpacity ?? 0.55));
    if (s.controlScheme === 'tilt') this.enableTilt(false);
    else this.disableTilt();
  }

  /** Show / hide driving controls. */
  setEnabled(on) {
    this.enabled = on;
    this.touchRoot.classList.toggle('visible', on && this.touchVisible !== false);
    if (!on) {
      this.releaseAllTouches();
      this.keys.clear();
    }
  }

  setTouchVisible(v) {
    this.touchVisible = v;
    this.touchRoot.classList.toggle('visible', this.enabled && v);
  }

  // -------------------------------------------------------------------------
  // Tilt (DeviceOrientation)
  // -------------------------------------------------------------------------
  /**
   * Must be called from a user gesture on iOS (permission prompt).
   * @returns {Promise<boolean>}
   */
  async requestTiltPermission() {
    if (!this.tilt.available) {
      this.onTiltFail && this.onTiltFail('unsupported');
      return false;
    }
    const DOE = window.DeviceOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') {
          this.onTiltFail && this.onTiltFail('denied');
          return false;
        }
      } catch {
        this.onTiltFail && this.onTiltFail(window.isSecureContext ? 'denied' : 'insecure');
        return false;
      }
    }
    this.enableTilt(true);
    return true;
  }

  enableTilt(checkEvents = true) {
    if (!this.tilt.available) return;
    if (!this.tilt.enabled) {
      window.addEventListener('deviceorientation', this._onOrient);
      this.tilt.enabled = true;
    }
    if (checkEvents) {
      this.tilt.received = false;
      clearTimeout(this._tiltTimer);
      this._tiltTimer = setTimeout(() => {
        if (!this.tilt.received && this.tilt.enabled) this.onTiltFail && this.onTiltFail(window.isSecureContext ? 'nodata' : 'insecure');
      }, 1800);
    }
  }

  disableTilt() {
    if (this.tilt.enabled) window.removeEventListener('deviceorientation', this._onOrient);
    this.tilt.enabled = false;
    this.tilt.steer = 0;
  }

  _onOrient(e) {
    if (e.beta == null) return;
    this.tilt.received = true;
    const angle =
      (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number'
        ? window.screen.orientation.angle
        : typeof window.orientation === 'number'
          ? window.orientation
          : 90) % 360;
    // In landscape the device's long (y) axis is horizontal; turning it like a
    // wheel changes beta. Sign depends on which way the device is rotated.
    let v;
    if (angle === 90) v = e.beta;
    else if (angle === 270 || angle === -90) v = -e.beta;
    else v = e.gamma; // portrait fallback
    if (this.settings.tiltInvert) v = -v;
    this.tilt.raw = v;
  }

  /** Store the current tilt as the neutral position. */
  calibrateTilt() {
    this.settings.tiltNeutral = this.tilt.raw || 0;
    return this.settings.tiltNeutral;
  }

  // -------------------------------------------------------------------------
  // Gamepad
  // -------------------------------------------------------------------------
  _bindGamepad() {
    if (!('getGamepads' in navigator)) return;
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepad.connected = true;
      this.gamepad.index = e.gamepad.index;
      this.onGamepadChange && this.onGamepadChange(true, e.gamepad.id);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index !== this.gamepad.index) return;
      this.gamepad.connected = false;
      this.gamepad.index = -1;
      this.gamepad.steer = this.gamepad.throttle = this.gamepad.brake = 0;
      this.gamepad.hand = this.gamepad.boost = this.gamepad.look = false;
      this.onGamepadChange && this.onGamepadChange(false, e.gamepad.id);
    });
  }

  _pollGamepad() {
    const gp = this.gamepad;
    if (!gp.connected) return;
    let pad = null;
    try {
      const pads = navigator.getGamepads();
      pad = pads && pads[gp.index];
    } catch {
      pad = null;
    }
    if (!pad) return;
    const b = (i) => (pad.buttons[i] ? pad.buttons[i].value || (pad.buttons[i].pressed ? 1 : 0) : 0);
    const pressed = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    let ax = pad.axes[0] || 0;
    ax = Math.abs(ax) < GP_DEADZONE ? 0 : (ax - Math.sign(ax) * GP_DEADZONE) / (1 - GP_DEADZONE);
    gp.steer = clamp(ax, -1, 1);
    gp.throttle = b(7);
    gp.brake = b(6);
    // right stick Y as an alternative throttle/brake
    const ry = pad.axes[3] || 0;
    if (ry < -0.3) gp.throttle = Math.max(gp.throttle, -ry);
    if (ry > 0.3) gp.brake = Math.max(gp.brake, ry);
    gp.hand = pressed(0) || pressed(4);
    gp.boost = pressed(1) || pressed(5);
    gp.look = pressed(2);
    // edge-triggered buttons
    const edges = [
      [3, 'camera'],
      [9, 'pause'],
      [8, 'reset'],
    ];
    for (const [i, act] of edges) {
      if (pressed(i) && !gp.prev[i]) this.actions.add(act);
    }
    // menu navigation (d-pad / stick / A / B)
    if (this.onMenuNav && !this.enabled) {
      const nav = [
        [12, 'up'],
        [13, 'down'],
        [14, 'left'],
        [15, 'right'],
        [0, 'confirm'],
        [1, 'back'],
      ];
      for (const [i, dir] of nav) if (pressed(i) && !gp.prev[i]) this.onMenuNav(dir);
      const ay = pad.axes[1] || 0;
      const axx = pad.axes[0] || 0;
      const stickDir = ay < -0.6 ? 'up' : ay > 0.6 ? 'down' : axx < -0.6 ? 'left' : axx > 0.6 ? 'right' : null;
      if (stickDir && stickDir !== gp.prevStick) this.onMenuNav(stickDir);
      gp.prevStick = stickDir;
    }
    for (let i = 0; i < pad.buttons.length; i++) gp.prev[i] = pressed(i);
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------
  consume(action) {
    if (this.actions.has(action)) {
      this.actions.delete(action);
      return true;
    }
    return false;
  }

  clearActions() {
    this.actions.clear();
  }

  update(dt) {
    this._pollGamepad();
    const s = this.settings;
    const k = this.keys;
    const st = this.state;

    // keyboard steering ramps toward full lock (digital -> analog)
    const kTarget = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
    const kRate = kTarget === 0 ? 9 : Math.sign(kTarget) !== Math.sign(this.keySteer) ? 12 : 5;
    this.keySteer += (kTarget - this.keySteer) * damp(kRate, dt);

    // touch steering
    let touchSteer = 0;
    if (s.controlScheme === 'wheel') {
      this.touch.steer += (this.touchSteerTarget - this.touch.steer) * damp(18, dt);
      touchSteer = this.touch.steer;
    } else if (s.controlScheme === 'buttons') {
      const bt = (this.touch.right ? 1 : 0) - (this.touch.left ? 1 : 0);
      this.buttonSteer += (bt - this.buttonSteer) * damp(bt === 0 ? 10 : 6, dt);
      touchSteer = this.buttonSteer;
    } else if (s.controlScheme === 'tilt' && this.tilt.enabled) {
      const v = (this.tilt.raw - (s.tiltNeutral || 0)) / 24;
      this.tilt.steer += (clamp(v, -1, 1) - this.tilt.steer) * damp(14, dt);
      touchSteer = this.tilt.steer;
    }
    // dead zone + response curve + sensitivity; the strongest source wins
    const sens = s.steerSensitivity || 1;
    let steer = shapeSteer(touchSteer, sens);
    if (Math.abs(this.keySteer) > Math.abs(steer)) steer = this.keySteer;
    const gps = shapeSteer(this.gamepad.steer, sens);
    if (Math.abs(gps) > Math.abs(steer)) steer = gps;
    st.steer = clamp(steer, -1, 1);

    const kb = k.has('down') ? 1 : 0;
    st.brake = Math.max(kb, this.touch.brake ? 1 : 0, this.gamepad.brake);
    let thr = Math.max(k.has('up') ? 1 : 0, this.touch.gas ? 1 : 0, this.gamepad.throttle);
    if (s.autoAccelerate && st.brake < 0.1) thr = Math.max(thr, 1);
    st.throttle = thr;
    st.handbrake = k.has('hand') || this.touch.hand || this.gamepad.hand;
    st.boost = k.has('boost') || this.touch.boost || this.gamepad.boost;
    st.lookBehind = k.has('look') || this.touch.look || this.gamepad.look;

    // visuals
    if (this.wheelEl && s.controlScheme === 'wheel') this.wheelEl.style.transform = `rotate(${(this.touch.steer * 120).toFixed(1)}deg)`;
    if (this.tiltDot && s.controlScheme === 'tilt') this.tiltDot.style.transform = `translateX(${(this.tilt.steer * 60).toFixed(1)}px)`;
    if (this.nitroRing) {
      const lvl = Math.round(this.boostLevel * 100);
      if (lvl !== this._lastLvl) {
        this._lastLvl = lvl;
        this.nitroRing.style.strokeDashoffset = String(283 * (1 - this.boostLevel));
      }
    }
    return st;
  }
}
