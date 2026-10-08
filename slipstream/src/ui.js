// Menus and overlay screens (DOM). Touch-first: big buttons, click events
// (no 300 ms delay with the viewport meta), event delegation via data-action.

import { CARS, COLORS, carStats, getCarDef } from './car.js';
import { TRACKS, FREE_ROAM, REVERSE_COST } from './tracks-data.js';
import { CAMERA_MODES } from './camera.js';
import { loadSave, save, getBestLap } from './storage.js';
import { formatTime, formatNumber, ordinal } from './utils.js';

const ICON = {
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4m0 0h11l-2 4 2 4H5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>',
  roam: '<svg viewBox="0 0 24 24"><path d="M3 18c4-8 6-8 9-3s5 5 9-3"/><circle cx="17" cy="6" r="2"/></svg>',
  car: '<svg viewBox="0 0 24 24"><path d="M3 15l2-6h14l2 6v4H3z"/><circle cx="7.5" cy="17" r="1.5"/><circle cx="16.5" cy="17" r="1.5"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.9 4.9 7 7m10 10 2.1 2.1M2 12h3m14 0h3M4.9 19.1 7 17m10-10 2.1-2.1"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  coin: '<svg viewBox="0 0 24 24" class="coin-ico"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-3a1.8 1.8 0 0 0 0 3.5h4"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
};

const TIME_OPTIONS = [
  ['default', 'Track'],
  ['morning', 'Morning'],
  ['noon', 'Noon'],
  ['sunset', 'Sunset'],
  ['night', 'Night'],
  ['cycle', 'Cycle'],
];

const THEME_GRADIENT = {
  coastal: 'linear-gradient(135deg,#2f7de1 0%,#7fc8f8 45%,#5aa04a 46%,#3d7a2e 100%)',
  city: 'linear-gradient(135deg,#0b0f2a 0%,#3a1d5a 50%,#ff2fa0 51%,#26e7ff 100%)',
  canyon: 'linear-gradient(135deg,#ff9a4d 0%,#c8603a 50%,#8a4a2c 51%,#d29a63 100%)',
  freeroam: 'linear-gradient(135deg,#3577d4 0%,#a7d0f0 50%,#93a75a 51%,#55753a 100%)',
};

export class UI {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.current = null;
    this.stack = [];
    this.trackMode = 'race';
    this.garageIndex = 0;
    this.toastTimer = 0;
    root.addEventListener('click', (e) => this._onClick(e));
    root.addEventListener('input', (e) => this._onInput(e));
    root.addEventListener('change', (e) => this._onChange(e));
    this.screens = {};
    root.querySelectorAll('.screen').forEach((s) => (this.screens[s.dataset.screen] = s));
    this.toastEl = document.getElementById('toast');
    this.confirmEl = document.getElementById('confirm');
  }

  // -------------------------------------------------------------------------
  // Screen management
  // -------------------------------------------------------------------------
  show(name, { push = false } = {}) {
    if (push && this.current) this.stack.push(this.current);
    if (!push) this.stack = [];
    for (const [k, el] of Object.entries(this.screens)) el.classList.toggle('active', k === name);
    this.current = name;
    this.root.classList.toggle('has-screen', !!name);
    const fn = this['_render_' + name];
    if (fn) fn.call(this);
    // focus the first button for keyboard / gamepad navigation
    const first = name && this.screens[name] && this.screens[name].querySelector('.btn.primary, .btn, .card');
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus({ preventScroll: true });
  }

  back() {
    const from = this.current;
    const prev = this.stack.pop();
    if (prev) {
      this.show(prev);
      this.h.screenLeft && this.h.screenLeft(from, prev);
    } else this.h.backFrom && this.h.backFrom(from);
  }

  hideAll() {
    this.show(null);
  }

  toast(msg, ms = 2400) {
    const el = this.toastEl;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }

  confirm(title, text, okLabel = 'OK') {
    return new Promise((resolve) => {
      const el = this.confirmEl;
      el.innerHTML = `<div class="panel confirm-panel"><h2>${title}</h2><p>${text}</p>
        <div class="row"><button class="btn" data-c="0">Cancel</button><button class="btn primary" data-c="1">${okLabel}</button></div></div>`;
      el.classList.add('on');
      const onClick = (e) => {
        const b = e.target.closest('[data-c]');
        if (!b) return;
        el.classList.remove('on');
        el.removeEventListener('click', onClick);
        this.h.click && this.h.click();
        resolve(b.dataset.c === '1');
      };
      el.addEventListener('click', onClick);
    });
  }

  _onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el || el.classList.contains('disabled')) return;
    const a = el.dataset.action;
    const d = el.dataset;
    if (a !== 'noop') this.h.click && this.h.click();
    switch (a) {
      case 'back':
        this.back();
        break;
      case 'goto':
        this.show(d.target, { push: true });
        break;
      case 'mode':
        this.trackMode = d.mode;
        if (d.mode === 'freeroam') this.show('freeroam', { push: true });
        else this.show('tracks', { push: true });
        break;
      case 'select-track':
        this._selectTrack(d.id);
        break;
      case 'unlock-reverse':
        this._unlockReverse(d.id);
        break;
      case 'toggle-reverse': {
        const s = loadSave();
        s.reverse = s.reverse || {};
        s.reverse[d.id] = !s.reverse[d.id];
        save();
        this._render_tracks();
        break;
      }
      case 'opt': {
        const s = loadSave().settings;
        const v = d.type === 'num' ? Number(d.value) : d.value;
        s[d.key] = v;
        save();
        this.h.settingChanged && this.h.settingChanged(d.key, v);
        this._refreshOptions(el.closest('.screen'));
        break;
      }
      case 'start': {
        const s = loadSave();
        const id = s.selectedTrack;
        const reverse = !!(s.reverse && s.reverse[id] && (s.unlockedTracks.includes(id + '-rev')));
        if (this.trackMode === 'race') this.h.startRace({ trackId: id, reverse });
        else this.h.startTimeTrial({ trackId: id, reverse });
        break;
      }
      case 'start-freeroam':
        this.h.startFreeRoam();
        break;
      case 'garage':
        this.show('garage', { push: true });
        this.h.openGarage && this.h.openGarage();
        break;
      case 'car-prev':
        this._garageStep(-1);
        break;
      case 'car-next':
        this._garageStep(1);
        break;
      case 'car-buy':
        this._buyCar();
        break;
      case 'car-select':
        this._selectCar();
        break;
      case 'color':
        this._pickColor(d.id);
        break;
      case 'resume':
        this.h.resume();
        break;
      case 'restart':
        this.h.restart();
        break;
      case 'quit':
        this.h.quit();
        break;
      case 'reset-car':
        this.h.resetCar();
        break;
      case 'settings':
        this.show('settings', { push: true });
        break;
      case 'calibrate':
        this.h.calibrateTilt && this.h.calibrateTilt();
        break;
      case 'reset-progress':
        this.confirm('Reset progress?', 'Coins, unlocks, best laps and ghosts will be erased. Settings are kept.', 'Reset').then((ok) => {
          if (ok) this.h.resetProgress();
        });
        break;
      case 'fullscreen':
        this.h.fullscreen && this.h.fullscreen();
        break;
      case 'next-track':
        this.h.nextTrack && this.h.nextTrack();
        break;
      default:
        break;
    }
  }

  _onInput(e) {
    const el = e.target;
    if (el.type !== 'range' || !el.dataset.key) return;
    const v = Number(el.value);
    loadSave().settings[el.dataset.key] = v;
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = el.dataset.pct ? `${Math.round(v * 100)}%` : v.toFixed(2).replace(/0$/, '');
    this.h.settingChanged && this.h.settingChanged(el.dataset.key, v);
  }

  _onChange(e) {
    const el = e.target;
    if (el.type === 'range' && el.dataset.key) save();
    if (el.type === 'checkbox' && el.dataset.key) {
      loadSave().settings[el.dataset.key] = el.checked;
      save();
      this.h.click && this.h.click();
      this.h.settingChanged && this.h.settingChanged(el.dataset.key, el.checked);
    }
  }

  _refreshOptions(screen) {
    if (!screen) return;
    const s = loadSave().settings;
    screen.querySelectorAll('[data-action="opt"]').forEach((b) => {
      const v = b.dataset.type === 'num' ? Number(b.dataset.value) : b.dataset.value;
      b.classList.toggle('on', s[b.dataset.key] === v);
    });
  }

  updateCoins() {
    const c = formatNumber(loadSave().coins);
    this.root.querySelectorAll('.coins-val').forEach((el) => (el.textContent = c));
  }

  // -------------------------------------------------------------------------
  // Main menu
  // -------------------------------------------------------------------------
  _render_main() {
    this.updateCoins();
    const fs = this.screens.main.querySelector('[data-action="fullscreen"]');
    if (fs) fs.style.display = this.h.canFullscreen && this.h.canFullscreen() ? '' : 'none';
  }

  // -------------------------------------------------------------------------
  // Track select
  // -------------------------------------------------------------------------
  _render_tracks() {
    const s = loadSave();
    const el = this.screens.tracks;
    el.querySelector('.track-title').textContent = this.trackMode === 'race' ? 'Race' : 'Time Trial';
    el.querySelector('.laps-row').style.display = this.trackMode === 'race' ? '' : 'none';
    el.querySelector('.diff-row').style.display = this.trackMode === 'race' ? '' : 'none';
    const list = el.querySelector('.track-list');
    list.innerHTML = TRACKS.map((t) => {
      const revUnlocked = s.unlockedTracks.includes(t.id + '-rev');
      const rev = revUnlocked && s.reverse && s.reverse[t.id];
      const key = rev ? t.id + '-rev' : t.id;
      const best = getBestLap(key);
      const sel = s.selectedTrack === t.id;
      return `<div class="card track-card ${sel ? 'selected' : ''}" data-action="select-track" data-id="${t.id}" tabindex="0">
        <div class="card-art" style="background:${THEME_GRADIENT[t.theme]}"><span class="card-tag">${t.theme === 'city' ? 'NIGHT' : t.theme === 'canyon' ? 'SUNSET' : 'DAY'}</span></div>
        <div class="card-body">
          <h3>${t.name}${rev ? ' <em>REV</em>' : ''}</h3>
          <p>${t.description}</p>
          <div class="card-meta">Best lap <b>${formatTime(best)}</b></div>
          ${
            revUnlocked
              ? `<button class="chip ${rev ? 'on' : ''}" data-action="toggle-reverse" data-id="${t.id}">Reverse ${rev ? 'ON' : 'OFF'}</button>`
              : `<button class="chip" data-action="unlock-reverse" data-id="${t.id}">${ICON.lock} Reverse · ${REVERSE_COST} ${ICON.coin}</button>`
          }
        </div></div>`;
    }).join('');
    this._refreshOptions(el);
    this.updateCoins();
  }

  _selectTrack(id) {
    loadSave().selectedTrack = id;
    save();
    this._render_tracks();
  }

  async _unlockReverse(id) {
    const s = loadSave();
    if (s.coins < REVERSE_COST) {
      this.toast(`Need ${REVERSE_COST} coins – race and drift to earn more!`);
      return;
    }
    const ok = await this.confirm('Unlock reverse layout?', `Spend ${REVERSE_COST} coins to unlock the reverse version of this track.`, 'Unlock');
    if (!ok) return;
    s.coins -= REVERSE_COST;
    s.unlockedTracks.push(id + '-rev');
    s.reverse = s.reverse || {};
    s.reverse[id] = true;
    save();
    this.h.unlocked && this.h.unlocked();
    this.toast('Reverse layout unlocked!');
    this._render_tracks();
  }

  _render_freeroam() {
    this._refreshOptions(this.screens.freeroam);
  }

  // -------------------------------------------------------------------------
  // Garage
  // -------------------------------------------------------------------------
  _render_garage() {
    const s = loadSave();
    this.garageIndex = Math.max(0, CARS.findIndex((c) => c.id === s.selectedCar));
    this._renderGarageCar();
  }

  _garageStep(d) {
    this.garageIndex = (this.garageIndex + d + CARS.length) % CARS.length;
    this._renderGarageCar();
    this.h.garagePreview && this.h.garagePreview(CARS[this.garageIndex].id);
  }

  colorFor(carId) {
    const s = loadSave();
    return s.carColors[carId] || getCarDef(carId).defaultColor;
  }

  _renderGarageCar() {
    const s = loadSave();
    const car = CARS[this.garageIndex];
    const el = this.screens.garage;
    const owned = s.unlockedCars.includes(car.id);
    const st = carStats(car);
    el.querySelector('.car-name').textContent = car.name;
    el.querySelector('.car-tag').textContent = car.tagline;
    el.querySelector('.car-index').textContent = `${this.garageIndex + 1} / ${CARS.length}`;
    el.querySelector('.stats').innerHTML = [
      ['Top speed', st.speed, `${car.physics.topSpeedKmh} km/h`],
      ['Acceleration', st.accel, ''],
      ['Handling', st.handling, ''],
      ['Drift', st.drift, ''],
    ]
      .map(
        ([n, v, t]) =>
          `<div class="stat"><span>${n}</span><div class="stat-bar"><div style="transform:scaleX(${v.toFixed(2)})"></div></div><em>${t}</em></div>`,
      )
      .join('');
    const current = this.colorFor(car.id);
    el.querySelector('.swatches').innerHTML = COLORS.map((c) => {
      const locked = c.price > 0 && !s.unlockedColors.includes(c.id);
      return `<button class="swatch ${c.id === current ? 'on' : ''} ${locked ? 'locked' : ''} finish-${c.finish}" data-action="color" data-id="${c.id}"
        style="--sw:#${c.hex.toString(16).padStart(6, '0')}" aria-label="${c.name}" title="${c.name}${locked ? ` – ${c.price} coins` : ''}">
        ${locked ? `<span class="sw-price">${c.price}</span>` : ''}</button>`;
    }).join('');
    const colorDef = COLORS.find((c) => c.id === current);
    el.querySelector('.color-name').textContent = colorDef ? colorDef.name : '';
    const action = el.querySelector('.garage-action');
    if (!owned) action.innerHTML = `<button class="btn primary" data-action="car-buy">${ICON.lock} Unlock · ${formatNumber(car.price)} coins</button>`;
    else if (s.selectedCar === car.id) action.innerHTML = `<button class="btn primary disabled">✓ Selected</button>`;
    else action.innerHTML = `<button class="btn primary" data-action="car-select">Select car</button>`;
    this.updateCoins();
  }

  async _buyCar() {
    const s = loadSave();
    const car = CARS[this.garageIndex];
    if (s.coins < car.price) {
      this.toast(`Need ${formatNumber(car.price)} coins. You have ${formatNumber(s.coins)}.`);
      return;
    }
    const ok = await this.confirm(`Unlock ${car.name}?`, `Spend ${formatNumber(car.price)} coins on the ${car.name}.`, 'Unlock');
    if (!ok) return;
    s.coins -= car.price;
    s.unlockedCars.push(car.id);
    s.selectedCar = car.id;
    save();
    this.h.unlocked && this.h.unlocked();
    this.toast(`${car.name} unlocked!`);
    this._renderGarageCar();
    this.h.garagePreview && this.h.garagePreview(car.id);
  }

  _selectCar() {
    const s = loadSave();
    s.selectedCar = CARS[this.garageIndex].id;
    save();
    this._renderGarageCar();
  }

  async _pickColor(id) {
    const s = loadSave();
    const c = COLORS.find((x) => x.id === id);
    const car = CARS[this.garageIndex];
    if (c.price > 0 && !s.unlockedColors.includes(id)) {
      if (s.coins < c.price) {
        this.toast(`${c.name} costs ${c.price} coins.`);
        return;
      }
      const ok = await this.confirm(`Unlock ${c.name}?`, `Spend ${c.price} coins. The colour becomes available for every car.`, 'Unlock');
      if (!ok) return;
      s.coins -= c.price;
      s.unlockedColors.push(id);
      this.h.unlocked && this.h.unlocked();
    }
    s.carColors[car.id] = id;
    save();
    this._renderGarageCar();
    this.h.garagePreview && this.h.garagePreview(car.id);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  _render_settings() {
    const s = loadSave().settings;
    const el = this.screens.settings;
    const seg = (key, opts, type = 'str') =>
      `<div class="seg">${opts
        .map(([v, label]) => `<button class="${s[key] === v ? 'on' : ''}" data-action="opt" data-key="${key}" data-value="${v}" data-type="${type}">${label}</button>`)
        .join('')}</div>`;
    const range = (key, min, max, step, pct = false) =>
      `<div class="range"><input type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-key="${key}" ${pct ? 'data-pct="1"' : ''}/>
       <output>${pct ? Math.round(s[key] * 100) + '%' : Number(s[key]).toFixed(2).replace(/0$/, '')}</output></div>`;
    const toggle = (key) => `<label class="toggle"><input type="checkbox" data-key="${key}" ${s[key] ? 'checked' : ''}/><span></span></label>`;
    const tiltOk = 'DeviceOrientationEvent' in window;
    el.querySelector('.settings-body').innerHTML = `
      <h3>Graphics</h3>
      <div class="set-row"><span>Quality</span>${seg('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])}</div>
      <div class="set-row"><span>Auto-adjust quality<small>Lowers detail if the frame rate drops</small></span>${toggle('autoQuality')}</div>
      <div class="set-row"><span>Show FPS<small>Tap the counter 5× (or F3) for debug info</small></span>${toggle('showFps')}</div>
      <h3>Controls</h3>
      <div class="set-row"><span>Steering</span>${seg('controlScheme', [['wheel', 'Wheel'], ['buttons', 'Buttons'], ['tilt', 'Tilt']])}</div>
      <div class="set-row"><span>Control size</span>${range('controlSize', 0.85, 1.4, 0.05)}</div>
      <div class="set-row"><span>Control opacity</span>${range('controlOpacity', 0.2, 1, 0.05, true)}</div>
      <div class="set-row"><span>Steering sensitivity</span>${range('steerSensitivity', 0.5, 1.6, 0.05)}</div>
      <div class="set-row"><span>Auto-accelerate<small>Gas is always on – just steer and brake</small></span>${toggle('autoAccelerate')}</div>
      <div class="set-row"><span>Left-handed layout<small>Pedals on the left, steering on the right</small></span>${toggle('swapSides')}</div>
      <div class="set-row ${tiltOk ? '' : 'disabled-row'}"><span>Tilt calibration<small>Hold the iPad in your neutral driving position</small></span>
        <button class="btn small" data-action="calibrate">Calibrate</button></div>
      <div class="set-row ${tiltOk ? '' : 'disabled-row'}"><span>Invert tilt</span>${toggle('tiltInvert')}</div>
      <h3>Camera &amp; HUD</h3>
      <div class="set-row"><span>Camera</span>${seg('cameraMode', CAMERA_MODES.map((m, i) => [i, m.name]), 'num')}</div>
      <div class="set-row"><span>Units</span>${seg('units', [['kmh', 'km/h'], ['mph', 'mph']])}</div>
      <h3>Audio</h3>
      <div class="set-row"><span>Master volume</span>${range('masterVolume', 0, 1, 0.05, true)}</div>
      <div class="set-row"><span>Music volume</span>${range('musicVolume', 0, 1, 0.05, true)}</div>
      <div class="set-row"><span>Effects volume</span>${range('sfxVolume', 0, 1, 0.05, true)}</div>
      <div class="set-row"><span>Mute music</span>${toggle('musicMuted')}</div>
      <h3>Data</h3>
      <div class="set-row"><span>Reset progress<small>Erase coins, unlocks, best laps and ghosts</small></span><button class="btn small danger" data-action="reset-progress">Reset</button></div>
      <p class="fine">Slipstream · all graphics and sound are generated in code.</p>`;
  }

  /** Re-render settings if visible (e.g. after tilt permission fails). */
  refreshSettings() {
    if (this.current === 'settings') this._render_settings();
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------
  showResults(r) {
    const el = this.screens.results;
    const title =
      r.mode === 'timetrial' ? 'Time Trial' : r.position === 1 ? 'Victory!' : r.position <= 3 ? `${ordinal(r.position)} place` : `Finished ${ordinal(r.position)}`;
    el.querySelector('.res-title').textContent = title;
    el.querySelector('.res-sub').textContent = r.trackName + (r.mode === 'race' ? ` · ${r.laps} lap${r.laps > 1 ? 's' : ''}` : '');
    const podium = el.querySelector('.podium');
    if (r.mode === 'race') {
      const top = r.standings.slice(0, 3);
      const order = [1, 0, 2].filter((i) => top[i]);
      podium.innerHTML = order
        .map((i) => {
          const c = top[i];
          return `<div class="pod pod-${i + 1} ${c.isPlayer ? 'me' : ''}"><div class="pod-car" style="--c:#${c.color.toString(16).padStart(6, '0')}"></div>
            <div class="pod-name">${c.name}</div><div class="pod-block">${i + 1}</div></div>`;
        })
        .join('');
      podium.style.display = '';
      el.querySelector('.standings').innerHTML = r.standings
        .map(
          (c, i) =>
            `<div class="st-row ${c.isPlayer ? 'me' : ''}"><b>${i + 1}</b><span>${c.name}</span><em>${c.finished ? formatTime(c.time) : c.gap}</em></div>`,
        )
        .join('');
    } else {
      podium.style.display = 'none';
      el.querySelector('.standings').innerHTML = (r.laps || [])
        .map((t, i) => `<div class="st-row ${t === r.bestLap ? 'me' : ''}"><b>${i + 1}</b><span>Lap ${i + 1}</span><em>${formatTime(t)}</em></div>`)
        .join('');
    }
    const stats = [
      ['Total time', formatTime(r.totalTime)],
      ['Best lap', formatTime(r.bestLap) + (r.newRecord ? ' ★' : '')],
      ['Top speed', r.topSpeed],
      ['Drift score', formatNumber(r.drift)],
      ['Collisions', String(r.collisions)],
    ];
    el.querySelector('.res-stats').innerHTML = stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    el.querySelector('.res-coins').innerHTML = `${ICON.coin} +${formatNumber(r.coins)} coins`;
    el.querySelector('[data-action="next-track"]').style.display = r.mode === 'race' ? '' : 'none';
    this.show('results');
    this.updateCoins();
  }
}

export { TIME_OPTIONS, ICON, FREE_ROAM };
