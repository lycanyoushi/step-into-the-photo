import { dimensions, makeCanvas, maskToAlpha } from './canvas.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const linear = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  linear[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

// sRGB, D65 white and CIE 1976 L*a*b*.
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const inverseF = (t) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
const gamma = (x) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function toLab(r, g, b) {
  r = linear[r];
  g = linear[g];
  b = linear[b];
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function fromLab(l, a, b) {
  const fy = (l + 16) / 116;
  const x = 0.95047 * inverseF(fy + a / 500);
  const y = inverseF(fy);
  const z = 1.08883 * inverseF(fy - b / 200);
  return [
    gamma(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    gamma(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    gamma(0.0556434 * x - 0.2040259 * y + 1.0572252 * z)
  ];
}

export function measureColors(image, region = null) {
  const [width, height] = dimensions(image);
  const scale = Math.min(1, 256 / Math.max(width, height));
  const sample = makeCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, sample.width, sample.height);
  if (region) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskToAlpha(region, sample.width, sample.height), 0, 0);
  }
  const rgb = ctx.getImageData(0, 0, sample.width, sample.height).data;
  const mean = [0, 0, 0, 0];
  const second = [0, 0, 0, 0];
  let neutral = 0,
    count = 0;
  for (let i = 0; i < rgb.length; i += 4) {
    if (rgb[i + 3] < 160) continue;
    const r = rgb[i],
      g = rgb[i + 1],
      b = rgb[i + 2];
    const values = toLab(r, g, b);
    values.push(luma(r, g, b));
    for (let j = 0; j < 4; j++) {
      mean[j] += values[j];
      second[j] += values[j] ** 2;
    }
    neutral += Number(Math.max(r, g, b) - Math.min(r, g, b) <= 7);
    count++;
  }
  if (!count) return null;
  for (let j = 0; j < 4; j++) mean[j] /= count;
  return {
    mean,
    sd: second.map((s, j) => Math.sqrt(Math.max(0, s / count - mean[j] ** 2))),
    monochrome: neutral / count >= 0.96,
    count
  };
}

function gain(sourceDeviation, targetDeviation) {
  return sourceDeviation < 1 ? 1 : clamp(targetDeviation / sourceDeviation, 0.55, 1.7);
}

export function makeSimpleTransfer(source, target) {
  if (target.monochrome) return null;
  const slope = gain(source.sd[3], target.sd[3]);
  const intercept = source.mean[3] * (1 - slope) + clamp(target.mean[3] - source.mean[3], -64, 64);
  return Uint8ClampedArray.from({ length: 256 }, (_, value) => slope * value + intercept);
}

export function applySimple(rgba, transfer) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    if (transfer) {
      rgba[i] = transfer[rgba[i]];
      rgba[i + 1] = transfer[rgba[i + 1]];
      rgba[i + 2] = transfer[rgba[i + 2]];
    } else {
      const gray = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
      rgba[i] = rgba[i + 1] = rgba[i + 2] = gray;
    }
  }
}

// Bound the Reinhard channel transforms, then sample the transform onto a
// 17^3 color cube. Tetrahedral interpolation avoids quantization bands while
// keeping the expensive sRGB/Lab conversions outside the video frame loop.
const grid = 17;
export function makeMatchedTransfer(source, target) {
  const lut = new Uint8ClampedArray(grid ** 3 * 3);
  const slopes = source.sd.map((sd, j) => gain(sd, target.sd[j]));
  const centers = source.mean.map((mean, j) => mean + clamp(target.mean[j] - mean, -25, 25));
  const levels = Array.from({ length: grid }, (_, i) => Math.round((i * 255) / 16));
  let index = 0;
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) {
        const lab = toLab(r, g, b).map((v, j) => centers[j] + slopes[j] * (v - source.mean[j]));
        if (target.monochrome) lab[1] = lab[2] = 0;
        const color = fromLab(...lab);
        for (const channel of color) lut[index++] = channel;
      }
    }
  }
  return lut;
}

const cell = new Uint8Array(256);
const frac = new Float32Array(256);
const colorCaches = new WeakMap();
for (let i = 0; i < 256; i++) {
  const position = (i * 16) / 255;
  cell[i] = Math.min(15, Math.floor(position));
  frac[i] = position - cell[i];
}

export function applyMatched(rgba, lut) {
  // Quantized camera pixels repeat across space and frames. Memoize exact
  // input triples for this frozen LUT; a hash collision just recalculates.
  let cache = colorCaches.get(lut);
  if (!cache) {
    cache = { keys: new Uint32Array(65536), colors: new Uint32Array(65536) };
    colorCaches.set(lut, cache);
  }
  const stepR = grid * grid * 3,
    stepG = grid * 3,
    stepB = 3;
  const diagonal = stepR + stepG + stepB;
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    const r = rgba[i],
      g = rgba[i + 1],
      b = rgba[i + 2];
    const key = 1 + ((r << 16) | (g << 8) | b);
    const slot = Math.imul(key, 0x9e3779b1) >>> 16;
    if (cache.keys[slot] === key) {
      const color = cache.colors[slot];
      rgba[i] = color & 255;
      rgba[i + 1] = (color >>> 8) & 255;
      rgba[i + 2] = color >>> 16;
      continue;
    }
    const base = cell[r] * stepR + cell[g] * stepG + cell[b] * stepB;
    // Descending fractional order selects one of the six tetrahedra.
    let u = frac[r],
      v = frac[g],
      w = frac[b];
    let first = stepR,
      second = stepG,
      third = stepB;
    if (u < v) {
      [u, v] = [v, u];
      [first, second] = [second, first];
    }
    if (v < w) {
      [v, w] = [w, v];
      [second, third] = [third, second];
    }
    if (u < v) {
      [u, v] = [v, u];
      [first, second] = [second, first];
    }
    for (let j = 0; j < 3; j++) {
      const a = base + j;
      rgba[i + j] =
        (1 - u) * lut[a] +
        (u - v) * lut[a + first] +
        (v - w) * lut[a + first + second] +
        w * lut[a + diagonal];
    }
    cache.keys[slot] = key;
    cache.colors[slot] = rgba[i] | (rgba[i + 1] << 8) | (rgba[i + 2] << 16);
  }
}
