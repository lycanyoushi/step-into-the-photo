import { dimensions, makeCanvas } from './canvas.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const luminance = (r, g, b) => (54 * r + 183 * g + 19 * b + 128) >> 8;

function percentile(histogram, count, fraction) {
  const threshold = Math.max(1, Math.ceil(count * fraction));
  let cumulative = 0;
  for (let i = 0; i < histogram.length; i++) {
    cumulative += histogram[i];
    if (cumulative >= threshold) return i;
  }
  return histogram.length - 1;
}

function sampleLight(image, rect) {
  const scale = Math.min(1, 128 / Math.max(rect.width, rect.height));
  const thumb = makeCanvas(
    Math.max(1, Math.round(rect.width * scale)),
    Math.max(1, Math.round(rect.height * scale))
  );
  const ctx = thumb.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, thumb.width, thumb.height);
  const pixels = ctx.getImageData(0, 0, thumb.width, thumb.height).data;
  const tones = new Uint32Array(256);
  const neutrals = Array.from({ length: 3 }, () => new Uint32Array(97));
  let count = 0,
    neutralCount = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 216) continue;
    const r = pixels[i],
      g = pixels[i + 1],
      b = pixels[i + 2];
    const y = luminance(r, g, b);
    tones[y]++;
    count++;
    // Weakly chromatic, mid-to-bright surfaces provide a white-balance cue.
    // Skin, saturated clothes, clipped whites and near-black pixels are poor illuminant samples.
    if (y < 70 || y > 236 || Math.max(r, g, b) - Math.min(r, g, b) > 4 + 0.13 * y) continue;
    for (let k = 0; k < 3; k++) neutrals[k][48 + clamp(pixels[i + k] - y, -48, 48)]++;
    neutralCount++;
  }
  if (!count) return null;
  return {
    low: percentile(tones, count, 0.08),
    mid: percentile(tones, count, 0.5),
    high: percentile(tones, count, 0.9),
    cast:
      neutralCount >= Math.max(4, count * 0.025)
        ? neutrals.map((hist) => percentile(hist, neutralCount, 0.5) - 48)
        : null
  };
}

// Exposure uses the destination near the actor. Moving or waving inside the
// webcam frame must not re-estimate lighting from a different shirt or pose.
export class PhotographicMatch {
  constructor(source, scene, bounds) {
    const [w, h] = dimensions(source);
    this.bounds = bounds || { x: 0, y: 0, width: w, height: h };
    this.source = sampleLight(source, this.bounds);
    this.scene = scene;
    this.width = w;
    this.height = h;
  }

  transfer(placement, monochrome) {
    if (!this.source) return null;
    const [w, h] = dimensions(this.scene);
    const b = this.bounds;
    const gain = (placement.width * w) / this.width;
    const angle = (placement.rotation * Math.PI) / 180;
    const dx = (b.x + b.width / 2 - this.width / 2) * gain * (placement.flip ? -1 : 1);
    const dy = (b.y + b.height / 2 - this.height / 2) * gain;
    const cx = placement.x * w + dx * Math.cos(angle) - dy * Math.sin(angle);
    const cy = placement.y * h + dx * Math.sin(angle) + dy * Math.cos(angle);
    const rw = clamp(1.7 * b.width * gain, 0.24 * w, w);
    const rh = clamp(1.1 * b.height * gain, 0.27 * h, h);
    // Small drags share a lighting estimate and avoid a new canvas read per pixel of motion.
    const cells = [cx / w, cy / h, rw / w, rh / h].map((value) => Math.round(value * 24));
    const exposure = placement.exposure || 0;
    const key = [...cells, exposure].join(',');
    if (key === this.key) return this.curve;
    this.key = key;
    const target = sampleLight(this.scene, {
      x: clamp(cx - rw / 2, 0, w - rw),
      y: clamp(cy - rh / 2, 0, h - rh),
      width: rw,
      height: rh
    });
    this.curve = target ? makeCurve(this.source, target, monochrome, b.height, exposure) : null;
    return this.curve;
  }
}

function makeCurve(source, target, monochrome, bodyHeight, exposure) {
  // Restrict exposure inferred from unknown reflectance. A dark garment should
  // retain deep blacks even if most local surfaces in the photograph are pale.
  const shadow = clamp((target.low - source.low) * 0.55, -18, 3);
  const highlight = clamp((target.high - source.high) * 0.6, -30, 20);
  const middle = clamp(0.35 * (shadow + highlight) + 0.12 * (target.mid - source.mid), -24, 18);
  const knots = [
    [0, 0],
    [48, shadow],
    [127, middle],
    [205, highlight],
    [255, 0]
  ];
  const offsets = new Float32Array(256);
  const corrections = [0, 1, 2].map((k) =>
    clamp(0.82 * ((target.cast?.[k] ?? 0) - (source.cast?.[k] ?? 0)), -17, 17)
  );
  const grayOffset = (54 * corrections[0] + 183 * corrections[1] + 19 * corrections[2]) / 256;
  const channels = corrections.map(() => new Float32Array(256));
  const multiplier = 2 ** clamp(exposure, -1.5, 1.5);
  let segment = 0;
  for (let y = 0; y <= 255; y++) {
    if (y > knots[segment + 1][0]) segment++;
    const [a, da] = knots[segment],
      [b, db] = knots[segment + 1];
    offsets[y] = da + ((db - da) * (y - a)) / (b - a);
    if (exposure) {
      // Scale linear luminance while rolling off the highlights. The white and black endpoints stay fixed.
      const s = clamp((y + offsets[y]) / 255, 0, 1);
      const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      const adjusted = (multiplier * linear) / (1 + (multiplier - 1) * linear);
      const tone = adjusted <= 0.0031308 ? 12.92 * adjusted : 1.055 * adjusted ** (1 / 2.4) - 0.055;
      offsets[y] = tone * 255 - y;
    }
    const strength = Math.min(1, (y / 150) ** 2, (255 - y) / 42);
    for (let k = 0; k < 3; k++) channels[k][y] = strength * (corrections[k] - grayOffset);
  }
  return {
    offsets,
    channels,
    monochrome,
    radius: clamp(Math.round(bodyHeight / 72), 2, 7),
    detail: clamp(0.8 * ((target.high - target.low) / Math.max(32, source.high - source.low) - 1), 0, 0.32)
  };
}

export function applyPhotographic(pixels, curve) {
  const { data, width: w, height: h } = pixels;
  const { channels, monochrome, radius, detail } = curve;
  // Make a one-byte luminance plane for local contrast. Only sharpen well inside
  // the matte so a transparent neighbour cannot leave a bright silhouette.
  let luma;
  if (detail > 0.04) {
    if (!curve.luma || curve.luma.length < w * h) curve.luma = new Uint8Array(w * h);
    luma = curve.luma;
    for (let i = 0, p = 0; i < data.length; i += 4, p++)
      luma[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }
  for (let y = 0, pos = 0; y < h; y++) {
    for (let x = 0; x < w; x++, pos++) {
      const i = pos * 4;
      if (!data[i + 3]) continue;
      const level = luma ? luma[pos] : luminance(data[i], data[i + 1], data[i + 2]);
      let texture = 0;
      if (luma && x >= radius && x < w - radius && y >= radius && y < h - radius && data[i + 3] > 245) {
        const left = pos - radius,
          right = pos + radius,
          up = pos - radius * w,
          down = pos + radius * w;
        if (
          data[4 * left + 3] > 245 &&
          data[4 * right + 3] > 245 &&
          data[4 * up + 3] > 245 &&
          data[4 * down + 3] > 245
        ) {
          texture = clamp(
            detail * (level - 0.25 * (luma[left] + luma[right] + luma[up] + luma[down])),
            -10,
            10
          );
        }
      }
      if (monochrome) {
        data[i] = data[i + 1] = data[i + 2] = level + curve.offsets[level] + texture;
      } else {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        // A near-neutral fixture can reveal a cast. On a distinctly coloured surface,
        // apply less of that estimate so it cannot erase skin and fabric chroma.
        const spread = Math.max(r, g, b) - Math.min(r, g, b);
        const balance = 1 - 0.75 * clamp((spread - 24) / 40, 0, 1);
        const tone = texture + curve.offsets[level];
        data[i] = r + tone + balance * channels[0][level];
        data[i + 1] = g + tone + balance * channels[1][level];
        data[i + 2] = b + tone + balance * channels[2][level];
      }
    }
  }
}
