import { toBlob } from './ui.js';

const GRID = 17;
const STEPS = 4;
const FADE_MS = 360;

// The local harmonisation model looks at the untreated visitor inside the
// photograph and answers with a colour table. The table is indexed by colour,
// so it stays valid while a live visitor moves, and is refreshed occasionally.
export class Harmony {
  constructor(changed) {
    this.changed = changed;
    this.available = true;
    this.serial = 0;
    this.reset();
  }

  reset() {
    this.serial++;
    this.from = null;
    this.to = null;
    this.key = null;
    this.pending = false;
    this.measuredAt = -Infinity;
    this.retryAt = 0;
    this.cache = null;
    for (const timer of this.timers || []) clearTimeout(timer);
    this.timers = [];
  }

  get ready() {
    return !!this.to;
  }

  // The visitor's pixels changed in place. A request already in flight shows
  // the earlier pixels, so its answer must not count as current.
  invalidate() {
    this.key = null;
    this.edits = (this.edits || 0) + 1;
  }

  // Skip requests while one is in flight. A moved visitor is measured promptly;
  // a live visitor in the same place is measured again at a relaxed interval.
  wants(key, live, now) {
    if (!this.available || this.pending || now < this.retryAt) return false;
    if (!this.to) return true;
    if (key !== this.key) return now - this.measuredAt > (live ? 320 : 90);
    return live && now - this.measuredAt > 1700;
  }

  async measure(key, composite, coverage) {
    const serial = this.serial,
      edits = this.edits;
    this.pending = true;
    this.measuredAt = performance.now();
    try {
      const form = new FormData();
      const [image, mask] = await Promise.all([toBlob(composite, 'image/png'), toBlob(coverage, 'image/png')]);
      form.set('image', image, 'composite.png');
      form.set('mask', mask, 'visitor.png');
      const response = await fetch('/api/harmonize', { method: 'POST', body: form });
      if (serial !== this.serial) return;
      if (response.status === 503 || response.status === 404) {
        this.available = false;
        return;
      }
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.grid !== GRID) {
        this.retryAt = performance.now() + 1500;
        return;
      }
      const bytes = Uint8Array.from(atob(result.table), (c) => c.charCodeAt(0));
      if (serial !== this.serial || bytes.length !== GRID ** 3 * 3) return;
      // Clear the flag first: accepting repaints, and that repaint is final.
      this.pending = false;
      this.accept(edits === this.edits ? key : null, bytes);
    } catch {
      // A stopped or restarted local service should not interrupt the camera.
      this.retryAt = performance.now() + 4000;
    } finally {
      if (serial === this.serial) this.pending = false;
    }
  }

  accept(key, bytes) {
    const now = performance.now();
    const current = this.blend(now);
    let target = bytes;
    if (current && key !== null && key === this.key) {
      // Repeated measurements of one placement differ with pose and matte
      // noise. Average them so the visitor's tone does not breathe.
      target = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) target[i] = (this.to[i] + bytes[i] + 1) >> 1;
    }
    this.from = current;
    this.to = target;
    this.key = key;
    this.start = now;
    this.cache = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.from) {
      for (let step = 1; step <= STEPS; step++)
        this.timers.push(setTimeout(() => this.changed?.(), (step * FADE_MS) / STEPS + 4));
    }
    this.changed?.();
  }

  blend(now) {
    if (!this.to) return null;
    if (!this.from) return this.to;
    const step = Math.min(STEPS, Math.floor(((now - this.start) / FADE_MS) * STEPS));
    if (step >= STEPS) {
      this.from = null;
      return this.to;
    }
    if (this.mix?.step === step && this.mix.to === this.to) return this.mix.table;
    const t = step / STEPS,
      table = new Uint8Array(this.to.length);
    for (let i = 0; i < table.length; i++) table[i] = this.from[i] + t * (this.to[i] - this.from[i]);
    this.mix = { step, to: this.to, table };
    return table;
  }

  // A complete lookup table for this frame: the measured colours at the given
  // strength, followed by the presenter's optional exposure trim.
  table(strength = 1, exposure = 0, ramp = null) {
    const measured = this.blend(performance.now());
    if (!measured) return null;
    const c = this.cache;
    if (
      c &&
      c.measured === measured &&
      c.strength === strength &&
      c.exposure === exposure &&
      c.ramp === ramp
    )
      return c.table;
    const table = new Uint8ClampedArray(measured.length);
    const gain = 2 ** Math.max(-1.5, Math.min(1.5, exposure));
    const tone = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
      const s = v / 255;
      const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      // Scale linear light and roll off toward white; black and white stay fixed.
      const lifted = (gain * linear) / (1 + (gain - 1) * linear);
      tone[v] = 255 * (lifted <= 0.0031308 ? 12.92 * lifted : 1.055 * lifted ** (1 / 2.4) - 0.055);
    }
    const levels = Array.from({ length: GRID }, (_, i) => (i * 255) / (GRID - 1));
    let i = 0;
    for (const r of levels)
      for (const g of levels)
        for (const b of levels) {
          const identity = [r, g, b];
          let gray = 0;
          for (let k = 0; k < 3; k++) {
            const value = identity[k] + strength * (measured[i + k] - identity[k]);
            const toned = exposure ? tone[Math.max(0, Math.min(255, Math.round(value)))] : value;
            table[i + k] = toned;
            gray += [0.2126, 0.7152, 0.0722][k] * toned;
          }
          if (ramp) {
            // A black-and-white or toned print: one colour per brightness.
            const level = 3 * Math.max(0, Math.min(255, Math.round(gray)));
            for (let k = 0; k < 3; k++) table[i + k] = ramp[level + k];
          }
          i += 3;
        }
    this.cache = { measured, strength, exposure, ramp, table };
    return table;
  }
}
