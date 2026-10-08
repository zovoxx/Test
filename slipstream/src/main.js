// Entry point: browser guards, gesture blocking, loading screen, WebGL check,
// "Tap to start" (unlocks audio on iOS), service worker registration.

import './styles.css';
import { ICON } from './ui.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Block unwanted browser gestures (pinch / double-tap zoom, rubber-banding,
// pull-to-refresh, long-press callouts). Scrollable panels are exempt.
// ---------------------------------------------------------------------------
const opts = { passive: false };
const prevent = (e) => {
  if (e.cancelable) e.preventDefault();
};
document.addEventListener('gesturestart', prevent, opts);
document.addEventListener('gesturechange', prevent, opts);
document.addEventListener('gestureend', prevent, opts);
document.addEventListener('dblclick', prevent, opts);
document.addEventListener('contextmenu', prevent, opts);
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches && e.touches.length > 1) return prevent(e); // pinch
    const t = e.target;
    if (t && t.closest && (t.closest('.scrollable, .scrollable-x') || (t.tagName === 'INPUT' && t.type === 'range'))) return;
    prevent(e);
  },
  opts,
);
// iOS double-tap zoom fallback: swallow a second touchend within 300 ms
let lastTouchEnd = 0;
document.addEventListener(
  'touchend',
  (e) => {
    const now = Date.now();
    const t = e.target;
    const interactive = t && t.closest && t.closest('button, input, [data-action], .tbtn, .steer-zone');
    if (!interactive && now - lastTouchEnd < 300) prevent(e);
    lastTouchEnd = now;
  },
  opts,
);

// desktop without a touch screen: never show the on-screen controls
if (!(navigator.maxTouchPoints > 0 || 'ontouchstart' in window)) document.documentElement.classList.add('no-touch');

// inline SVG icons
document.querySelectorAll('i.ico[data-ico]').forEach((el) => {
  el.innerHTML = ICON[el.dataset.ico] || '';
});

// ---------------------------------------------------------------------------
// DOM helpers handed to the game
// ---------------------------------------------------------------------------
const loading = $('loading');
const loadFill = loading.querySelector('.load-fill');
const loadText = loading.querySelector('.load-text');
const fatal = $('fatal');

const dom = {
  canvas: $('game-canvas'),
  hudRoot: $('hud'),
  touchRoot: $('touch-layer'),
  uiRoot: $('ui'),
  fade: $('fade'),
  speedLines: $('speedlines'),
  vignette: $('vignette'),
  rotateOverlay: $('rotate'),
  startButton: $('start-btn'),
  showLoading(on, text = 'Loading…') {
    loading.classList.toggle('on', on);
    if (on) {
      loadFill.style.transform = 'scaleX(0)';
      loadText.textContent = text;
    }
  },
  setLoading(p, text) {
    loadFill.style.transform = `scaleX(${Math.max(0, Math.min(1, p)).toFixed(3)})`;
    if (text) loadText.textContent = text;
  },
  showFatal(msg, reload = true) {
    fatal.querySelector('.fatal-msg').textContent = msg;
    $('fatal-reload').style.display = reload ? '' : 'none';
    fatal.classList.add('on');
    loading.classList.remove('on');
  },
};
$('fatal-reload').addEventListener('click', () => window.location.reload());

function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    return !!gl;
  } catch {
    return false;
  }
}

async function boot() {
  if (!hasWebGL2()) {
    dom.showFatal(
      'Your browser or device does not support WebGL 2, which Slipstream needs for 3D graphics. ' +
        'Please update iPadOS / your browser, or enable hardware acceleration.',
      false,
    );
    return;
  }
  let game;
  try {
    const { Game } = await import('./game.js');
    dom.setLoading(0.05, 'Loading engine');
    game = new Game(dom);
    await game.init((p, text) => dom.setLoading(p, text));
  } catch (err) {
    console.error(err);
    dom.showFatal('Something went wrong while starting the game: ' + (err && err.message ? err.message : String(err)));
    return;
  }
  if (new URLSearchParams(location.search).has('test')) window.__slip = game;
  dom.showLoading(false);
  const startScreen = $('start-screen');
  startScreen.classList.add('on');
  // iOS only unlocks audio inside touchend/click, so use click on the button
  // and the whole overlay.
  let started = false;
  const go = (e) => {
    if (started) return;
    if (e) e.preventDefault();
    started = true;
    startScreen.classList.remove('on');
    game.start();
  };
  startScreen.addEventListener('click', go);
  window.addEventListener('keydown', function onKey(e) {
    if (started) return window.removeEventListener('keydown', onKey);
    if (e.code === 'Enter' || e.code === 'Space') go(e);
  });
}

boot();

// ---------------------------------------------------------------------------
// Offline support: register the service worker in production builds only
// (needs HTTPS or localhost; skipped on plain-HTTP LAN URLs).
// ---------------------------------------------------------------------------
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
