// Automatic quality scaler. Measures the average frame time over short windows
// and lowers pixel ratio first, then the quality tier (shadows, particles), if
// the game can't hold ~60 FPS. Recovers slowly when there is headroom.

const LEVELS = ['low', 'medium', 'high'];
const MAX_PR = { low: 1, medium: 1.5, high: 2 };

export class QualityManager {
  /**
   * @param {object} opts { renderer, apply(level, pixelRatio) }
   */
  constructor({ renderer, apply }) {
    this.renderer = renderer;
    this.applyFn = apply;
    this.userLevel = 'high';
    this.level = 'high';
    this.auto = true;
    this.prScale = 1;
    this.frames = 0;
    this.time = 0;
    this.goodWindows = 0;
    this.active = false; // only measure while driving
    this.fps = 60;
    this._fpsFrames = 0;
    this._fpsTime = 0;
  }

  get deviceDpr() {
    return Math.max(1, window.devicePixelRatio || 1);
  }

  pixelRatio() {
    const maxPr = Math.min(this.deviceDpr, MAX_PR[this.level]);
    return Math.max(0.75, maxPr * this.prScale);
  }

  setUserLevel(level, auto) {
    this.userLevel = LEVELS.includes(level) ? level : 'high';
    this.auto = auto;
    this.level = this.userLevel;
    this.prScale = 1;
    this.goodWindows = 0;
    this.apply();
  }

  apply() {
    this.applyFn(this.level, this.pixelRatio());
  }

  /** Call once per rendered frame. */
  sample(dt) {
    // FPS counter (always)
    this._fpsFrames++;
    this._fpsTime += dt;
    if (this._fpsTime >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsTime);
      this._fpsFrames = 0;
      this._fpsTime = 0;
    }
    if (!this.auto || !this.active) return;
    if (dt > 0.25) return; // ignore hitches / tab switches
    this.frames++;
    this.time += dt;
    if (this.time < 2) return;
    const avg = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    if (avg < 47) {
      this.goodWindows = 0;
      this._degrade();
    } else if (avg > 57.5) {
      this.goodWindows++;
      if (this.goodWindows >= 4) {
        this.goodWindows = 0;
        this._improve();
      }
    } else this.goodWindows = 0;
  }

  _degrade() {
    if (this.prScale > 0.7) {
      this.prScale = Math.max(0.7, this.prScale - 0.15);
    } else {
      const i = LEVELS.indexOf(this.level);
      if (i > 0) {
        this.level = LEVELS[i - 1];
        this.prScale = 0.9;
      } else return;
    }
    this.apply();
  }

  _improve() {
    const cap = LEVELS.indexOf(this.userLevel);
    if (this.prScale < 1) {
      this.prScale = Math.min(1, this.prScale + 0.1);
      this.apply();
    } else if (LEVELS.indexOf(this.level) < cap) {
      this.level = LEVELS[LEVELS.indexOf(this.level) + 1];
      this.prScale = 0.8;
      this.apply();
    }
  }
}
