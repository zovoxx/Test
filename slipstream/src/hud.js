// In-race HUD built from HTML/CSS (crisp on retina) plus a small canvas
// minimap. DOM writes are cached so unchanged values cost nothing.

import { clamp, formatTime, formatDelta, ordinal, formatNumber } from './utils.js';

const ARC_LEN = 251.3; // length of the 270° gauge arc path (r=53.3)

export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-top-left">
        <button class="hud-btn" data-hud="pause" aria-label="Pause"><svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></button>
        <div class="hud-block pos-block"><div class="hud-label">POS</div><div class="hud-big"><span class="pos-num">1</span><span class="pos-suf">st</span><span class="pos-of">/6</span></div></div>
        <div class="hud-block lap-block"><div class="hud-label">LAP</div><div class="hud-big"><span class="lap-num">1</span><span class="lap-of">/3</span></div></div>
        <div class="hud-block coin-block"><div class="hud-label">COINS</div><div class="hud-big"><span class="coin-num">0</span><span class="coin-of">/45</span></div></div>
        <div class="hud-fps" data-hud="fps"></div>
      </div>
      <div class="hud-top-center">
        <div class="timer-main">0:00.000</div>
        <div class="timer-sub"><span class="t-best-label">BEST</span> <span class="t-best">--:--.---</span><span class="t-last-wrap"> · LAST <span class="t-last">--:--.---</span></span></div>
        <div class="split"></div>
      </div>
      <div class="hud-top-right">
        <canvas class="minimap" width="160" height="160"></canvas>
        <button class="hud-btn" data-hud="reset" aria-label="Reset car"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4.5h4.5"/></svg></button>
      </div>
      <div class="hud-center">
        <div class="countdown"></div>
        <div class="message"><div class="msg-main"></div><div class="msg-sub"></div></div>
        <div class="wrongway"><div class="ww-icon">⟲</div>WRONG WAY</div>
        <div class="drift"><div class="drift-mult"></div><div class="drift-score"></div><div class="drift-label">DRIFT</div></div>
        <div class="popups"></div>
      </div>
      <div class="hud-bottom-center">
        <div class="speedo">
          <svg viewBox="0 0 120 120" class="gauge">
            <path class="gauge-bg" d="M22.3 97.7 A53.3 53.3 0 1 1 97.7 97.7" />
            <path class="gauge-fg" d="M22.3 97.7 A53.3 53.3 0 1 1 97.7 97.7" />
          </svg>
          <div class="speed-val">0</div>
          <div class="speed-unit">KM/H</div>
          <div class="gear">N</div>
        </div>
        <div class="bars">
          <div class="bar rpm"><div class="bar-fill"></div><span>RPM</span></div>
          <div class="bar nitro"><div class="bar-fill"></div><span>NITRO</span></div>
        </div>
      </div>
      <div class="debug-panel"></div>`;
    const $ = (s) => root.querySelector(s);
    this.el = {
      posBlock: $('.pos-block'),
      lapBlock: $('.lap-block'),
      coinBlock: $('.coin-block'),
      posNum: $('.pos-num'),
      posSuf: $('.pos-suf'),
      posOf: $('.pos-of'),
      lapNum: $('.lap-num'),
      lapOf: $('.lap-of'),
      coinNum: $('.coin-num'),
      coinOf: $('.coin-of'),
      timer: $('.timer-main'),
      best: $('.t-best'),
      bestLabel: $('.t-best-label'),
      last: $('.t-last'),
      lastWrap: $('.t-last-wrap'),
      split: $('.split'),
      minimap: $('.minimap'),
      countdown: $('.countdown'),
      message: $('.message'),
      msgMain: $('.msg-main'),
      msgSub: $('.msg-sub'),
      wrong: $('.wrongway'),
      drift: $('.drift'),
      driftMult: $('.drift-mult'),
      driftScore: $('.drift-score'),
      popups: $('.popups'),
      gauge: $('.gauge-fg'),
      speed: $('.speed-val'),
      unit: $('.speed-unit'),
      gear: $('.gear'),
      rpm: $('.rpm .bar-fill'),
      rpmBar: $('.rpm'),
      nitro: $('.nitro .bar-fill'),
      nitroBar: $('.nitro'),
      fps: $('.hud-fps'),
      debug: $('.debug-panel'),
      center: $('.hud-top-center'),
    };
    this.el.gauge.style.strokeDasharray = `${ARC_LEN} ${ARC_LEN}`;
    this.cache = {};
    this.units = 'kmh';
    this.mapCtx = this.el.minimap.getContext('2d');
    this.mapBg = null;
    this.mapXform = null;
    this._msgTimer = 0;
    this._splitTimer = 0;
    this._cdTimer = 0;
    this.onPause = null;
    this.onReset = null;
    this.onFpsTap = null;
    root.querySelector('[data-hud="pause"]').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onPause && this.onPause();
    });
    root.querySelector('[data-hud="reset"]').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onReset && this.onReset();
    });
    this.el.fps.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onFpsTap && this.onFpsTap();
    });
    this._setupMinimapCanvas();
  }

  _setupMinimapCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = 150;
    this.mapSize = Math.round(css * dpr);
    this.el.minimap.width = this.mapSize;
    this.el.minimap.height = this.mapSize;
    this.mapDpr = dpr;
  }

  _set(key, el, text) {
    if (this.cache[key] !== text) {
      this.cache[key] = text;
      el.textContent = text;
    }
  }

  show(on) {
    this.root.classList.toggle('visible', on);
  }

  /** mode: 'race' | 'timetrial' | 'freeroam' */
  setMode(mode, { laps = 3, cars = 6, coins = 0 } = {}) {
    this.mode = mode;
    this.root.dataset.mode = mode;
    this._set('lapOf', this.el.lapOf, laps > 0 ? `/${laps}` : '');
    this._set('posOf', this.el.posOf, `/${cars}`);
    this._set('coinOf', this.el.coinOf, `/${coins}`);
    this.el.split.className = 'split';
    this.el.wrong.classList.remove('on');
    this.el.drift.classList.remove('on');
    this.el.countdown.className = 'countdown';
    this.el.message.className = 'message';
    this.el.popups.innerHTML = '';
    this.cache = {};
  }

  setUnits(u) {
    this.units = u;
    this._set('unit', this.el.unit, u === 'mph' ? 'MPH' : 'KM/H');
  }

  setFpsVisible(v) {
    this.el.fps.classList.toggle('on', v);
  }

  setFps(fps) {
    this._set('fps', this.el.fps, `${fps} FPS`);
  }

  setDebug(text) {
    if (text == null) {
      this.el.debug.classList.remove('on');
      return;
    }
    this.el.debug.classList.add('on');
    this.el.debug.textContent = text;
  }

  /** Per-frame update of driving gauges. */
  updateCar(ph) {
    const mph = this.units === 'mph';
    const sp = ph.speed * (mph ? 2.23694 : 3.6);
    const max = mph ? 220 : 340;
    this._set('speed', this.el.speed, String(Math.round(sp)));
    const frac = clamp(sp / max, 0, 1);
    const off = Math.round(ARC_LEN * (1 - frac) * 10) / 10;
    if (this.cache.gauge !== off) {
      this.cache.gauge = off;
      this.el.gauge.style.strokeDashoffset = String(off);
    }
    const gear = ph.gear === -1 ? 'R' : ph.speed < 0.5 && ph.throttleApplied < 0.05 ? 'N' : String(ph.gear);
    this._set('gear', this.el.gear, gear);
    const rpm = clamp(ph.rpm / ph.cfg.redline, 0, 1);
    const r = Math.round(rpm * 100) / 100;
    if (this.cache.rpm !== r) {
      this.cache.rpm = r;
      this.el.rpm.style.transform = `scaleX(${r})`;
      const red = rpm > 0.92;
      if (this.cache.rpmRed !== red) {
        this.cache.rpmRed = red;
        this.el.rpmBar.classList.toggle('red', red);
      }
    }
    const n = Math.round(ph.boost * 100) / 100;
    if (this.cache.nitro !== n) {
      this.cache.nitro = n;
      this.el.nitro.style.transform = `scaleX(${n})`;
    }
    const boosting = ph.boosting;
    if (this.cache.boosting !== boosting) {
      this.cache.boosting = boosting;
      this.el.nitroBar.classList.toggle('active', boosting);
    }
  }

  updateRace({ position, cars, lap, laps, lapTime, bestLap, lastLap, coins }) {
    if (position != null) {
      this._set('pos', this.el.posNum, String(position));
      this._set('posSuf', this.el.posSuf, ordinal(position).replace(/^\d+/, ''));
      this._set('posOf', this.el.posOf, `/${cars}`);
    }
    if (lap != null) this._set('lap', this.el.lapNum, String(lap));
    if (laps != null) this._set('lapOf', this.el.lapOf, laps > 0 ? `/${laps}` : '');
    if (coins != null) this._set('coins', this.el.coinNum, String(coins));
    if (lapTime !== undefined) this._set('timer', this.el.timer, lapTime > 0 ? formatTime(lapTime) : '0:00.000');
    if (bestLap !== undefined) this._set('best', this.el.best, formatTime(bestLap));
    if (lastLap !== undefined) this._set('last', this.el.last, formatTime(lastLap));
  }

  setFreeRoamInfo(driftTotal) {
    this._set('timer', this.el.timer, `${formatNumber(driftTotal)} pts`);
    this._set('bestLabel', this.el.bestLabel, 'DRIFT SCORE');
    this._set('best', this.el.best, '');
  }

  setBestLabel(text) {
    this._set('bestLabel', this.el.bestLabel, text);
  }

  showSplit(deltaMs) {
    const el = this.el.split;
    el.textContent = formatDelta(deltaMs);
    el.className = 'split on ' + (deltaMs <= 0 ? 'good' : 'bad');
    clearTimeout(this._splitTimer);
    this._splitTimer = setTimeout(() => (el.className = 'split'), 2200);
  }

  countdown(text, go = false) {
    const el = this.el.countdown;
    el.textContent = text;
    el.className = 'countdown';
    void el.offsetWidth; // restart animation
    el.className = 'countdown on' + (go ? ' go' : '');
    clearTimeout(this._cdTimer);
    this._cdTimer = setTimeout(() => (el.className = 'countdown'), go ? 900 : 950);
  }

  message(main, sub = '', duration = 1800, cls = '') {
    const el = this.el.message;
    this.el.msgMain.textContent = main;
    this.el.msgSub.textContent = sub;
    el.className = 'message';
    void el.offsetWidth;
    el.className = 'message on ' + cls;
    clearTimeout(this._msgTimer);
    if (duration > 0) this._msgTimer = setTimeout(() => (el.className = 'message'), duration);
  }

  hideMessage() {
    this.el.message.className = 'message';
  }

  wrongWay(on) {
    if (this.cache.wrong !== on) {
      this.cache.wrong = on;
      this.el.wrong.classList.toggle('on', on);
    }
  }

  drift(active, score, mult) {
    if (this.cache.driftOn !== active) {
      this.cache.driftOn = active;
      this.el.drift.classList.toggle('on', active);
    }
    if (active) {
      this._set('driftScore', this.el.driftScore, formatNumber(score));
      this._set('driftMult', this.el.driftMult, `x${mult}`);
    }
  }

  popup(text, cls = '') {
    const p = document.createElement('div');
    p.className = 'popup ' + cls;
    p.textContent = text;
    this.el.popups.appendChild(p);
    setTimeout(() => p.remove(), 1600);
    while (this.el.popups.childElementCount > 4) this.el.popups.firstChild.remove();
  }

  // -------------------------------------------------------------------------
  // Minimap
  // -------------------------------------------------------------------------
  /**
   * Pre-render the static map. points: array of [x, z] (closed loop) or null,
   * extras: optional draw callback for free roam (ctx, toMap).
   */
  buildMinimap({ path = null, bounds, extras = null }) {
    const S = this.mapSize;
    const pad = 12 * this.mapDpr;
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxZ - bounds.minZ;
    const scale = (S - pad * 2) / Math.max(w, h);
    const ox = pad + (S - pad * 2 - w * scale) / 2;
    const oz = pad + (S - pad * 2 - h * scale) / 2;
    this.mapXform = { scale, ox, oz, minX: bounds.minX, minZ: bounds.minZ };
    const bg = document.createElement('canvas');
    bg.width = S;
    bg.height = S;
    const ctx = bg.getContext('2d');
    ctx.fillStyle = 'rgba(8,10,18,0.55)';
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.fill();
    const toMap = (x, z) => [ox + (x - bounds.minX) * scale, oz + (z - bounds.minZ) * scale];
    if (path) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const trace = () => {
        ctx.beginPath();
        for (let i = 0; i <= path.count; i += 2) {
          const k = i % path.count;
          const [x, y] = toMap(path.px[k], path.pz[k]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      };
      trace();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 7 * this.mapDpr;
      ctx.stroke();
      trace();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.6 * this.mapDpr;
      ctx.stroke();
      // start line
      const [sx, sy] = toMap(path.px[0], path.pz[0]);
      ctx.fillStyle = '#ff5a1f';
      ctx.fillRect(sx - 3 * this.mapDpr, sy - 3 * this.mapDpr, 6 * this.mapDpr, 6 * this.mapDpr);
    }
    if (extras) extras(ctx, toMap, scale);
    this.mapBg = bg;
    this.toMap = toMap;
  }

  /** dots: [{x, z, color, size, heading?}] – the player is drawn as an arrow. */
  drawMinimap(dots, player) {
    if (!this.mapBg) return;
    const ctx = this.mapCtx;
    const S = this.mapSize;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this.mapBg, 0, 0);
    const d = this.mapDpr;
    for (let i = 0; i < dots.length; i++) {
      const o = dots[i];
      const [x, y] = this.toMap(o.x, o.z);
      ctx.fillStyle = o.color;
      ctx.beginPath();
      ctx.arc(x, y, (o.size || 3.2) * d, 0, Math.PI * 2);
      ctx.fill();
    }
    if (player) {
      const [x, y] = this.toMap(player.x, player.z);
      ctx.save();
      ctx.translate(x, y);
      // world heading → map rotation (map x = world x, map y = world z)
      ctx.rotate(Math.PI - player.yaw);
      ctx.fillStyle = '#ff5a1f';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * d;
      ctx.beginPath();
      ctx.moveTo(0, -7 * d);
      ctx.lineTo(5 * d, 5 * d);
      ctx.lineTo(0, 2.5 * d);
      ctx.lineTo(-5 * d, 5 * d);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}
