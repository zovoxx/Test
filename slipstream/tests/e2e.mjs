// End-to-end smoke test with an emulated iPad (touch, landscape).
//
// Optional – Playwright is not a project dependency. To run:
//   npm i --no-save playwright
//   npx playwright install webkit chromium
//   npm run build && npm run preview            (in another terminal)
//   node tests/e2e.mjs                          (WebKit by default)
//   BROWSER=chromium node tests/e2e.mjs
//
// It boots the game, taps through the menus with touch, starts a 1-lap race,
// drives with simultaneous multi-touch (gas + wheel), pauses / resumes, lets an
// autopilot finish the race, checks the results screen, visits the garage,
// settings and Free Roam, takes screenshots into tests/screenshots/ and fails
// on any console error or page error.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { chromium, webkit, devices } = await import('playwright');
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(OUT, { recursive: true });
const URL = process.env.URL || 'http://localhost:4173/?test';
const engine = (process.env.BROWSER || 'webkit') === 'chromium' ? chromium : webkit;

const browser = await engine.launch({ executablePath: process.env.BROWSER_PATH || undefined });
const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'], deviceScaleFactor: Number(process.env.DPR || 1) });
await ctx.addInitScript(() => {
  try {
    if (!localStorage.getItem('slipstream.save.v1'))
      localStorage.setItem('slipstream.save.v1', JSON.stringify({ settings: { quality: 'low', autoQuality: false, showFps: true, laps: 1 } }));
  } catch {
    /* private mode */
  }
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const state = () => page.evaluate(() => window.__slip.testState());
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const tap = (sel) => page.locator(sel).first().tap({ force: true });
const waitFor = (fn, timeout = 180000) => page.waitForFunction(fn, null, { timeout, polling: 500 });
const check = (cond, msg) => {
  if (!cond) {
    errors.push('[check] ' + msg);
    console.error('FAIL', msg);
  } else console.log('ok  ', msg);
};

// Multi-touch via CDP (Chromium) – WebKit falls back to sequential taps.
let touchStart = null;
let touchEnd = null;
if (engine === chromium) {
  const cdp = await ctx.newCDPSession(page);
  touchStart = (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts });
  touchEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

await page.goto(URL);
await page.waitForSelector('#start-screen.on', { timeout: 180000 });
await shot('01-start');
await tap('#start-btn');
await waitFor(() => window.__slip.testState().state === 'menu');
check((await state()).audio !== 'none', 'audio context created on first tap');
await shot('02-menu');

// --- race ---------------------------------------------------------------
await tap('[data-action="mode"][data-mode="race"]');
await page.waitForTimeout(500);
await shot('03-tracks');
await tap('.screen.active [data-action="start"]');
await waitFor(() => window.__slip.testState().state === 'countdown');
await shot('04-countdown');
await waitFor(() => window.__slip.testState().state === 'racing');
if (touchStart) {
  const box = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const gas = await box('.tbtn.gas');
  const wheel = await box('.wheel');
  await touchStart([{ x: gas.x, y: gas.y, id: 1 }, { x: wheel.x, y: wheel.y, id: 2 }]);
  await page.waitForTimeout(3000);
  await shot('05-driving');
  await touchEnd();
} else {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
}
check((await state()).speedKmh > 10, 'car accelerates with the gas pedal');
await tap('[data-hud="pause"]');
await page.waitForTimeout(400);
check((await state()).paused, 'pause button pauses');
await shot('06-pause');
await tap('.screen.active [data-action="resume"]');
await page.waitForTimeout(300);
check(!(await state()).paused, 'resume works');
await page.evaluate(() => {
  window.__slip.testAutopilot();
  window.__slip.setTestTurbo(12);
});
await waitFor(() => window.__slip.testState().finished, 600000);
const fin = await state();
check(fin.lap >= 1 && fin.position >= 1, `race finished in position ${fin.position}`);
await page.waitForTimeout(600);
await shot('07-results');
await tap('.screen.active [data-action="quit"]');
await waitFor(() => window.__slip.testState().state === 'menu');

// --- garage / settings ----------------------------------------------------
await tap('[data-action="garage"]');
await page.waitForTimeout(1200);
await shot('08-garage');
await tap('.screen.active [data-action="car-next"]');
await page.waitForTimeout(800);
await tap('.screen.active [data-action="back"]');
await page.waitForTimeout(500);
check((await state()).state === 'menu', 'garage back returns to menu');
await tap('.screen.active [data-action="settings"]');
await page.waitForTimeout(500);
await shot('09-settings');
await tap('.screen.active [data-action="back"]');

// --- free roam -----------------------------------------------------------
await tap('[data-action="mode"][data-mode="freeroam"]');
await page.waitForTimeout(400);
await tap('.screen.active [data-action="start-freeroam"]');
await waitFor(() => window.__slip.testState().state === 'racing');
await page.keyboard.down('KeyW');
await page.waitForTimeout(4000);
await page.keyboard.up('KeyW');
await shot('10-freeroam');
check((await state()).mode === 'freeroam', 'free roam starts');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await tap('.screen.active [data-action="quit"]');
await waitFor(() => window.__slip.testState().state === 'menu');

await browser.close();
if (errors.length) {
  console.error('\nErrors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nE2E passed. Screenshots in tests/screenshots/');
