import { dimensions, makeCanvas } from './canvas.js';

// Read small patches at the photograph's working resolution. Resizing the
// whole photo to estimate noise would erase the very detail we want to match.
const PATCH = 16;
const GRID = 9;
const TILE = 128;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const median = (a) => a.sort((u, v) => u - v)[Math.floor(a.length / 2)];

function patchStats(rgba, stride, start) {
  const values = new Float32Array(PATCH * PATCH);
  const centre = (PATCH - 1) / 2;
  let sum = 0,
    sx = 0,
    sy = 0;
  for (let y = 0, p = 0; y < PATCH; y++) {
    for (let x = 0; x < PATCH; x++, p++) {
      const i = 4 * (start + y * stride + x);
      if (rgba[i + 3] < 247) return null;
      const value = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      values[p] = value;
      sum += value;
      sx += value * (x - centre);
      sy += value * (y - centre);
    }
  }
  const n = values.length,
    mean = sum / n;
  if (mean < 20 || mean > 235) return null;
  // Remove a local brightness ramp, such as light falling across a cheek.
  const denom = (n * (PATCH * PATCH - 1)) / 12;
  const blocks = new Float32Array(16),
    deviations = [],
    fineDetail = [];
  let energy = 0,
    horizontal = 0,
    vertical = 0;
  for (let y = 0, p = 0; y < PATCH; y++) {
    for (let x = 0; x < PATCH; x++, p++) {
      const r = values[p] - mean - ((x - centre) * sx + (y - centre) * sy) / denom;
      values[p] = r;
      deviations.push(Math.abs(r));
      blocks[(y >> 2) * 4 + (x >> 2)] += r / 16;
      energy += r * r;
      if (x) horizontal += r * values[p - 1];
      if (y) vertical += r * values[p - PATCH];
      // Diagonal Haar detail cancels a brightness ramp and a horizontal or
      // vertical edge. Compare the photo and visitor in this same frequency band.
      if (x && y)
        fineDetail.push(Math.abs(r - values[p - 1] - values[p - PATCH] + values[p - PATCH - 1]) / 2);
    }
  }
  const sigma = median(deviations) * 1.4826;
  const scale = PATCH / ((PATCH - 1) * Math.max(0.01, energy));
  const cx = horizontal * scale,
    cy = vertical * scale;
  // Fabric weave, JPEG block boundaries and grass typically have a coherent
  // direction or persistent structure over the 4-by-4 block averages.
  const low = Math.sqrt(blocks.reduce((s, v) => s + v * v, 0) / blocks.length);
  const flat =
    Math.max(Math.abs(cx), Math.abs(cy)) <= 0.8 &&
    Math.abs(cx - cy) <= 0.45 &&
    low <= 0.6 * sigma + 0.45 &&
    energy / n <= 3.2 * sigma * sigma + 1.0;
  fineDetail.sort((a, b) => a - b);
  // Limit occasional sharp diagonals (eyelashes, fine seams) before averaging.
  const limit = fineDetail[Math.floor(fineDetail.length * 0.95)];
  const fine =
    Math.sqrt(fineDetail.reduce((s, v) => s + Math.min(v, limit) ** 2, 0) / fineDetail.length) / 0.955;
  const midtone = Math.max(0.36, Math.min(mean, 255 - mean) / 127.5);
  return { fine: fine / midtone, flat, correlation: clamp((cx + cy) / 2, 0, 0.65) };
}

function measure(image, [left, top, width, height], donor = false) {
  if (width < PATCH || height < PATCH) return null;
  const nx = Math.min(GRID, Math.floor(width / PATCH)),
    ny = Math.min(GRID, Math.floor(height / PATCH));
  const atlas = makeCanvas(nx * PATCH, ny * PATCH);
  const ctx = atlas.getContext('2d', { willReadFrequently: true });
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const sx = left + Math.round(((x + 0.5) * width) / nx - PATCH / 2);
      const sy = top + Math.round(((y + 0.5) * height) / ny - PATCH / 2);
      ctx.drawImage(image, sx, sy, PATCH, PATCH, x * PATCH, y * PATCH, PATCH, PATCH);
    }
  }
  const { data } = ctx.getImageData(0, 0, atlas.width, atlas.height);
  const patches = [];
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const patch = patchStats(data, atlas.width, PATCH * (y * atlas.width + x));
      if (patch) patches.push(patch);
    }
  let candidates = patches.filter((p) => p.flat);
  // An entire small person can be strongly shaded or textured. In that case
  // their quieter opaque patches still give a conservative donor detail floor.
  if (donor && candidates.length < 2) candidates = patches;
  if (candidates.length < 2) return null;
  candidates.sort((a, b) => a.fine - b.fine);
  // The quieter half resists small patches of hair, seams and foliage.
  const flat = candidates.slice(0, Math.ceil(0.6 * candidates.length));
  return { fine: median(flat.map((p) => p.fine)), correlation: median(flat.map((p) => p.correlation)) };
}

function grainTile(sigma, correlation) {
  const tile = makeCanvas(TILE, TILE);
  const ctx = tile.getContext('2d'),
    pixels = ctx.createImageData(TILE, TILE);
  const white = new Float32Array(TILE * TILE);
  let seed = 11473;
  function random() {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return (seed + 0.5) / 4294967296;
  }
  for (let i = 0; i < white.length; i += 2) {
    const magnitude = Math.sqrt(-2 * Math.log(random())),
      angle = 2 * Math.PI * random();
    white[i] = magnitude * Math.cos(angle);
    white[i + 1] = magnitude * Math.sin(angle);
  }
  // Filter a periodic Gaussian field to match the measured one-pixel
  // correlation. The same texture remains fixed in photograph coordinates.
  const c = clamp(correlation, 0, 0.65);
  const a = c / (1 + Math.sqrt(1 - 2 * c * c));
  const norm = 1 + 2 * a * a;
  const at = (x, y) => white[(y & (TILE - 1)) * TILE + (x & (TILE - 1))];
  for (let y = 0, p = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++, p++) {
      const axis = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1);
      const corners = at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1);
      const v = 127.5 + (sigma * (at(x, y) + a * axis + a * a * corners)) / norm;
      pixels.data[4 * p] = pixels.data[4 * p + 1] = pixels.data[4 * p + 2] = v;
      pixels.data[4 * p + 3] = 255;
    }
  ctx.putImageData(pixels, 0, 0);
  return tile;
}

export class PrintTexture {
  constructor(scene, frame) {
    const [l, t, r, b] = frame || [0, 0, 1, 1];
    const [w, h] = dimensions(scene);
    this.photo = measure(scene, [
      Math.ceil(l * w),
      Math.ceil(t * h),
      Math.floor((r - l) * w),
      Math.floor((b - t) * h)
    ]);
    this.patch = makeCanvas();
    this.ctx = this.patch.getContext('2d');
  }

  apply(output, visitorLayer, rect, scale, live, treatment = '') {
    if (!this.photo || this.photo.fine < 0.65) return;
    const [x, y, w, h] = rect;
    if (w < PATCH || h < PATCH) return;
    const key = `${Math.round(24 * Math.log2(scale))}/${treatment}`;
    const now = performance.now();
    const moved = !live && (x !== this.sample?.x || y !== this.sample?.y);
    if (!this.sample || key !== this.sample.key || moved || (live && now - this.sample.at > 1800)) {
      // Measure the rendered donor after scaling, tone correction and focus.
      const donor = measure(visitorLayer, rect, true);
      const variance =
        donor && donor.fine < 0.94 * this.photo.fine ? this.photo.fine ** 2 - donor.fine ** 2 : 0;
      // A separably correlated field has diagonal-detail SD = sigma * (1-c).
      let sigma = clamp(Math.sqrt(variance) / (1 - this.photo.correlation), 0, 14);
      if (live && this.sample?.key === key && donor && this.sample.valid)
        sigma = this.sample.sigma * 0.65 + sigma * 0.35;
      this.sample = { at: now, key, x, y, sigma, valid: !!donor };
    }
    const sigma = Math.round(this.sample.sigma * 2) / 2;
    if (sigma < 1) return;
    if (!this.pattern || this.strength !== sigma) {
      this.pattern = this.ctx.createPattern(grainTile(sigma, this.photo.correlation), 'repeat');
      this.strength = sigma;
    }
    // A masked overlay varies luminance most in the midtones. Keep the
    // original alpha at anti-aliased edges and leave every uncovered pixel alone.
    if (w > this.patch.width) this.patch.width = w;
    if (h > this.patch.height) this.patch.height = h;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(output.canvas, x, y, w, h, 0, 0, w, h);
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = this.pattern;
    ctx.translate(-x, -y);
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(visitorLayer, x, y, w, h, x, y, w, h);
    ctx.restore();
    output.save();
    output.globalCompositeOperation = 'source-atop';
    output.drawImage(this.patch, 0, 0, w, h, x, y, w, h);
    output.restore();
  }
}
