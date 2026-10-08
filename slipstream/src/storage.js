// Persistent save data in localStorage.
// Safari private mode (and some locked-down browsers) throws on any storage
// access, so every call is wrapped and falls back to an in-memory copy.

const KEY = 'slipstream.save.v1';

export const DEFAULT_SETTINGS = {
  quality: 'high', // 'low' | 'medium' | 'high'
  autoQuality: true, // automatic quality scaler
  controlScheme: 'wheel', // 'wheel' | 'buttons' | 'tilt'
  controlSize: 1, // 0.85 .. 1.4
  controlOpacity: 0.55,
  swapSides: false, // left-handed layout
  steerSensitivity: 1, // 0.5 .. 1.6
  autoAccelerate: false,
  cameraMode: 0, // 0 chase far, 1 chase close, 2 hood
  units: 'kmh', // 'kmh' | 'mph'
  masterVolume: 0.8,
  musicVolume: 0.45,
  sfxVolume: 0.85,
  musicMuted: false,
  tiltNeutral: 0,
  showFps: false,
  timeOfDay: 'default', // default | morning | noon | sunset | night | cycle
  laps: 3,
  difficulty: 'normal', // easy | normal | hard
};

const DEFAULT_SAVE = () => ({
  version: 1,
  coins: 250,
  selectedCar: 'vector',
  selectedTrack: 'coastal',
  unlockedCars: ['vector', 'comet', 'badger'],
  unlockedColors: [],
  unlockedTracks: ['coastal', 'neon', 'canyon'],
  carColors: {},
  bestLaps: {}, // { [trackId]: { [carId]: ms } }
  bestRaces: {}, // { [trackId-laps]: ms }
  ghosts: {}, // { [trackId]: { carId, color, lapMs, data: base64 Float32Array } }
  stats: { races: 0, wins: 0, driftTotal: 0, distanceKm: 0, coinsEarned: 0 },
  settings: { ...DEFAULT_SETTINGS },
});

let memory = null;
let storageOk = true;

function readRaw() {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    storageOk = false;
    return null;
  }
}

function writeRaw(str) {
  try {
    window.localStorage.setItem(KEY, str);
    return true;
  } catch {
    storageOk = false;
    return false;
  }
}

/** Load save data (merging in defaults for anything new). */
export function loadSave() {
  if (memory) return memory;
  const base = DEFAULT_SAVE();
  let data = null;
  const raw = readRaw();
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (data && typeof data === 'object') {
    memory = {
      ...base,
      ...data,
      stats: { ...base.stats, ...(data.stats || {}) },
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    };
    // Always keep starter content available, even for older saves.
    for (const id of base.unlockedCars) if (!memory.unlockedCars.includes(id)) memory.unlockedCars.push(id);
    for (const id of base.unlockedTracks) if (!memory.unlockedTracks.includes(id)) memory.unlockedTracks.push(id);
  } else {
    memory = base;
  }
  return memory;
}

let saveTimer = 0;
/** Persist (debounced so a burst of settings changes writes once). */
export function save(immediate = false) {
  if (!memory) return;
  const doWrite = () => {
    saveTimer = 0;
    let str;
    try {
      str = JSON.stringify(memory);
    } catch {
      return;
    }
    if (!writeRaw(str)) {
      // Quota exceeded: drop ghosts (largest entries) and try again.
      if (memory.ghosts && Object.keys(memory.ghosts).length) {
        memory.ghosts = {};
        try {
          writeRaw(JSON.stringify(memory));
        } catch {
          /* ignore */
        }
      }
    }
  };
  if (immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    doWrite();
  } else if (!saveTimer) {
    saveTimer = setTimeout(doWrite, 250);
  }
}

export function getSettings() {
  return loadSave().settings;
}

export function setSetting(key, value) {
  loadSave().settings[key] = value;
  save();
}

export function resetProgress() {
  // keep the very same settings object: other modules hold references to it
  const settings = loadSave().settings;
  memory = DEFAULT_SAVE();
  memory.settings = settings;
  save(true);
  return memory;
}

export const isStorageAvailable = () => storageOk;

// --- best laps --------------------------------------------------------------
export function getBestLap(trackId, carId) {
  const t = loadSave().bestLaps[trackId];
  if (!t) return null;
  if (carId) return t[carId] ?? null;
  let best = null;
  for (const k in t) if (best == null || t[k] < best) best = t[k];
  return best;
}

export function submitLap(trackId, carId, ms) {
  const s = loadSave();
  s.bestLaps[trackId] = s.bestLaps[trackId] || {};
  const prev = s.bestLaps[trackId][carId];
  if (prev == null || ms < prev) {
    s.bestLaps[trackId][carId] = ms;
    save();
    return true;
  }
  return false;
}

export function addCoins(n) {
  const s = loadSave();
  s.coins = Math.max(0, Math.round(s.coins + n));
  if (n > 0) s.stats.coinsEarned += Math.round(n);
  save();
  return s.coins;
}

// --- ghosts (Float32Array <-> base64) ----------------------------------------
export function encodeFloats(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

export function decodeFloats(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
  } catch {
    return null;
  }
}
