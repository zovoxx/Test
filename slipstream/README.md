# Slipstream

An arcade 3D racing game built with **Three.js** that runs in **Safari on iPad** (touch-first) and in any desktop browser. Everything – cars, tracks, textures, sky, music and sound effects – is generated in code. There are no image or audio files and no CDN dependencies, so the built game works offline.

- 3 themed circuits (Coastal Loop · Neon City at night · Canyon Ridge at sunset), each with an unlockable **reverse** layout, plus a **Free Roam** sandbox with ramps, hills, knockable cones and 45 coins to collect
- **Race** against 5 AI rivals (1 / 3 / 5 laps, Easy / Normal / Hard), **Time Trial** against your own ghost, **Free Roam**
- 5 procedurally modelled cars with different handling, 13 paint colours, coins and unlocks
- Arcade physics with a 6-speed automatic gearbox, drifting, nitro, jumps and wall/car collisions
- Touch controls (wheel, buttons or tilt), keyboard and gamepad
- Synthesized engine, tyre, wind, nitro and crash sounds plus generative music
- Day/night cycle, fake bloom, tyre smoke, dust, sparks, skid marks, speed lines
- Automatic quality scaling, PWA (Add to Home Screen, fullscreen, offline)

---

## Quick start

Requirements: **Node.js 20.19+ or 22.12+** (for Vite 8).

```bash
cd slipstream
npm install          # installs three.js and Vite
npm run dev          # dev server with --host (LAN URL is printed)
npm run build        # static build -> dist/
npm run preview      # serve the built game on your network (port 4173)
```

`npm run serve` builds and previews in one step. `npm run preview -- --host` also works.

Open the **Network** URL that Vite prints (for example `http://192.168.1.20:5173`) on any device on the same Wi-Fi.

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run dev:https` | Dev server with a self-signed HTTPS certificate (needed on iPad for **tilt steering** and the offline service worker over the LAN). Accept the certificate warning once. |
| `npm test` | Runs the three headless checks below (no browser needed). |
| `npm run check:tracks` | Validates every track: corner radius, section spacing, slope. |
| `npm run test:physics` | Handling tests: 0–100, top speed, braking, cornering, drifting, reverse, jumps, no wall tunnelling. |
| `npm run test:ai` | Headless AI race (6 cars, 2 laps) on every track and direction. |
| `npm run test:e2e` | Optional browser test with an emulated iPad (touch, landscape) – see `tests/e2e.mjs` for setup (needs Playwright). |
| `npm run icons` | Regenerates the app icons (pure Node, no image tools). |

---

## Playing on an iPad

### Option A – same Wi-Fi (quickest)

1. On your computer run `npm run dev` (or `npm run serve` for the optimized build).
2. Note the **Network** URL that is printed, such as `http://192.168.1.20:5173`.
3. Make sure the iPad is on the **same Wi-Fi** and open that URL in **Safari**.
4. Hold the iPad in **landscape** and tap **Tap to start** (this also unlocks the sound).

If the page does not load, allow Node through your computer's firewall, or check that both devices are on the same network (guest networks often block device-to-device traffic).

Over plain `http://` on a LAN, iPadOS blocks motion sensors and service workers. Everything else works. For **tilt steering** use `npm run dev:https` (and accept the certificate warning), or deploy to an HTTPS host as described below.

### Option B – deploy `dist/` to a free static host (HTTPS, works anywhere)

The build uses relative paths, so `dist/` works from any URL or sub-folder.

**Netlify (drag and drop, no account setup beyond sign-in)**
1. `npm run build`
2. Go to <https://app.netlify.com/drop> and drag the `slipstream/dist` folder onto the page.
3. Open the `https://….netlify.app` URL on the iPad.

**Cloudflare Pages**
1. `npm run build`
2. Dashboard → *Workers & Pages* → *Create* → *Pages* → *Upload assets*, then upload `slipstream/dist`.
   Or from Git: set the root directory to `slipstream`, the build command to `npm run build` and the output directory to `dist`.

**GitHub Pages**
1. Push the repository to GitHub.
2. *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
3. *Actions →* **Deploy Slipstream to GitHub Pages** → *Run workflow* (the workflow is in `.github/workflows/deploy-slipstream.yml`).
4. Open `https://<user>.github.io/<repo>/`.

### Add to Home Screen (fullscreen app)

1. Open the game in **Safari** (HTTPS host recommended).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch Slipstream from the new icon. It runs fullscreen without the Safari toolbar. When served over HTTPS it also works **offline** after the first launch.

---

## Controls

| Action | Touch (iPad) | Keyboard | Gamepad |
| --- | --- | --- | --- |
| Steer | Drag left/right anywhere on the left side (wheel) – or arrow buttons / tilt | A / D or ← / → | Left stick |
| Accelerate | **GAS** pedal (bottom right) | W or ↑ | RT (or right stick up) |
| Brake / reverse | **BRAKE** pedal – hold when stopped to reverse | S or ↓ | LT (or right stick down) |
| Handbrake / drift | **DRIFT** button | Space | A or LB |
| Nitro | **N₂O** button (ring shows remaining nitro) | Shift or N | B or RB |
| Change camera | Camera button | C | Y |
| Look behind | Eye button (hold) | Q or B | X (hold) |
| Reset car | ↺ (top right) | R | Back / Select |
| Pause | ❚❚ (top left) | P or Esc | Start |
| Debug overlay | Tap the FPS counter 5× | F3 | – |
| Menus | Tap | Tab / Enter | D-pad / stick + A, B = back |

Steering and pedals use separate fingers at the same time (multi-touch Pointer Events). In **Settings** you can switch to **Buttons** or **Tilt** steering, change the control size and opacity, mirror the layout for left-handed play, tune steering sensitivity, or enable **Auto-accelerate**.

**Drifting:** at speed, steer into a corner and tap **DRIFT**, then hold the gas and steer to balance the slide. Counter-steer to straighten. Drifts score points with up to a ×5 combo, fill the nitro faster, and earn coins.

---

## Game modes and progression

- **Race** – 3-2-1-GO countdown with start lights, 5 AI rivals with rubber-banding, ordered checkpoints (no shortcut cheating), wrong-way warning, position tracking, lap/best/total times, and a results screen with podium, top speed, drift score and collisions.
- **Time Trial** – 3 flying laps. Your best lap per track is saved as a **ghost** (recorded at 20 Hz, interpolated on playback) with checkpoint splits.
- **Free Roam** – open sandbox: drift pad with cone slaloms, 10 ramps, hills, containers and rocks. Each coin is worth 10 coins, and drifting earns more.
- **Coins** come from race positions, clean races, laps, records, drifting and Free Roam. Spend them in the **Garage** on cars (Raptor V8 1500, Nova X 3500) and premium paints, or unlock **reverse** layouts (400 each) on the track-select screen.
- Progress (coins, unlocks, best laps per track and car, ghosts, settings) is saved in `localStorage`. In Safari private mode the game still works but nothing is saved between visits.

---

## Project structure

```
slipstream/
├── index.html              # all screens/overlays + iOS/PWA meta tags
├── public/                 # manifest, service worker, generated icons
├── scripts/                # icon generator, track checker, physics & AI sims
├── tests/e2e.mjs           # optional Playwright end-to-end test (iPad emulation)
└── src/
    ├── main.js             # boot, WebGL check, gesture blocking, tap-to-start, SW
    ├── game.js             # renderer, fixed-timestep loop, modes, laps, effects wiring
    ├── car.js              # TUNING CONFIG, arcade vehicle physics, procedural car models
    ├── track.js            # spline sampling + queries, road/curb/rail/gantry meshes
    ├── tracks-data.js      # track definitions (edit the point arrays here)
    ├── world-physics.js    # ground sampling + wall/car collisions for tracks
    ├── freeroam.js         # free-roam layout, physics world, cones and coins
    ├── environment.js      # sky shader, time of day, terrain, decoration per theme
    ├── camera.js           # chase/close/hood cameras, shake, anti-clipping
    ├── input.js            # keyboard + touch (wheel/buttons/tilt) + gamepad
    ├── ai.js               # AI drivers (racing line, braking, overtaking, rubber band)
    ├── ghost.js            # time-trial ghost recorder / player
    ├── audio.js            # Web Audio synthesis: engine, SFX, music
    ├── hud.js              # HTML HUD + canvas minimap
    ├── ui.js               # menus, garage, settings, results
    ├── particles.js        # pooled particles, glow sprites, skid marks
    ├── quality.js          # automatic quality scaler
    ├── textures.js         # canvas-generated textures
    ├── storage.js          # safe localStorage save data
    ├── utils.js            # math, noise, helpers
    └── styles.css
```

### Adding or editing a track

Edit `src/tracks-data.js`. Each track has a `points` array of `[x, z, elevation]` control points (metres) that form a closed loop smoothed by a centripetal Catmull-Rom spline. Then run `npm run check:tracks`: it fails when a corner is tighter than about 24 m in radius or when two parts of the loop come closer than about 2.6 × the wall offset (the walls would overlap). `roundedPolyline()` turns a list of corners into a city-block layout. Set `theme` to `coastal`, `city` or `canyon` to pick the scenery, and set `timeOfDay` (hours) for the default lighting.

---

## Tunable constants

All car handling lives in **`CAR_DEFAULTS`** at the top of `src/car.js`, with per-car overrides in `CARS[].physics`:

| Constant | Meaning |
| --- | --- |
| `mass` | kg – affects collisions |
| `topSpeedKmh` | top speed; aero drag and final drive are solved from it automatically |
| `torque`, `peakRpm`, `redline` | engine strength and torque curve |
| `gears`, `shiftUpRpm`, `shiftDownRpm`, `shiftTime` | 6-speed automatic gearbox |
| `grip` | tyre friction (cornering limit and traction) – higher is more forgiving |
| `brakeDecel`, `handbrakeDecel` | braking strength (m/s²) |
| `steerMax`, `steerMaxHigh`, `steerFalloffKmh` | speed-sensitive steering lock |
| `steerRate`, `yawResponse` | steering smoothing and rotation responsiveness |
| `overSteer`, `powerOverSteer` | how easily hard cornering / throttle breaks into a slide |
| `driftGrip`, `handbrakeGrip` | lateral grip while drifting / with the handbrake |
| `driftEnterAngle`, `driftExitAngle`, `driftMinKmh` | drift state thresholds |
| `driftYawRate`, `driftAlign`, `maxDriftAngle` | drift control, self-straightening, spin-out limit |
| `scrub`, `driftScrub`, `slideFriction` | speed lost while turning / sliding |
| `boostAccel`, `boostTopSpeedFactor`, `boostDrain`, `boostRecharge`, `boostDriftRecharge` | nitro |
| `airControl` | yaw control while airborne |

Other useful knobs:

| Where | Constant | Meaning |
| --- | --- | --- |
| `src/car.js` | `PHYSICS_DT` | fixed physics step (1/60 s) |
| `src/ai.js` | `DIFFICULTY` | AI skill and rubber-band strength per difficulty |
| `src/game.js` | `POSITION_COINS`, `AI_NAMES` | race rewards, rival names |
| `src/camera.js` | `CAMERA_MODES` | distance, height, FOV of each camera |
| `src/environment.js` | `THEMES`, `TOD_KEYS`, `TIME_PRESETS` | scenery, fog, sky / light colours per hour |
| `src/quality.js` | `MAX_PR`, thresholds in `sample()` | pixel-ratio caps and auto-scaler FPS limits |
| `src/track.js` | `SAMPLE_SPACING`, `halfWidth`, `runoff` (per track) | road width and wall distance |
| `src/freeroam.js` | `BOUND`, `PAD_R`, `makeLayout()` | free-roam size and layout |

---

## Performance notes

- Pixel ratio is capped at 2 (High), 1.5 (Medium) or 1 (Low). The automatic scaler drops pixel ratio first and then the quality tier when the average frame rate falls below ~47 FPS, and it recovers slowly when there is headroom.
- Trees, rocks, lamp posts, rail posts, cones and coins use `InstancedMesh`. Track, buildings, houses and billboards are merged. Measured: a 6-car race draws about 45–65 draw calls (130k–310k triangles) depending on track and quality, and Free Roam about 20–35.
- One directional light casts shadows from a small frustum that follows the player (2048² on High, 1024² on Medium, off on Low, where blob shadows remain). Lights glow through additive sprites (fake bloom); there is no post-processing pass.
- Physics runs at a fixed 60 Hz with an accumulator, and rendering interpolates between steps. Hot paths reuse vectors and typed arrays.

## Known limitations

- **Tilt steering** and the **offline service worker** need HTTPS on iPad (use a static host or `npm run dev:https`). If tilt permission is denied, the game falls back to wheel steering. The tilt axis was derived from the DeviceOrientation spec and could not be tested on a physical iPad here. If steering feels reversed, use **Invert tilt** in Settings.
- Automated testing used headless **Chromium** with an iPad viewport and touch emulation, because WebKit was not available in the build environment. The code avoids APIs Safari lacks and feature-checks the optional ones (audio session, vibration, stereo panner, fullscreen, orientation lock).
- iOS ignores the manifest's landscape lock in Safari, so the game shows a "rotate your device" overlay in portrait instead.
- The iPad ringer switch can mute Web Audio on iPadOS versions before 16.4 (the game sets `navigator.audioSession.type = 'playback'` where supported).
- Cars are low-poly procedural models and the physics is deliberately arcade-style (no real suspension simulation or roll-overs). Free-roam ramps can send you flying, but cars always land on their wheels.
- AI rivals use the same physics as you with a small grip assist and rubber-banding. They overtake and avoid each other but occasionally bump.
- Ghosts are stored per track (one best ghost each). Very long laps (over 4 minutes) are not recorded.
