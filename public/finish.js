import { dimensions, makeCanvas, resize } from './canvas.js';

// Chromium and Firefox apply CSS filters to canvas drawing. Elsewhere these
// finishing passes are skipped and the composite stays a plain cutout.
const filters =
  typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;
const px = (value) => 'blur(' + Math.max(0, value).toFixed(2) + 'px)';
let band, shade;

// In a photograph, bright surroundings spill a little light over the rim of
// whatever stands in front of them. The band is the cutout's own matte minus
// a blurred copy, so it peaks at the silhouette and vanishes inside the body.
export function lightWrap(layer, background, [x, y, w, h], radius, strength) {
  if (!filters || w < 6 || h < 6 || strength <= 0) return;
  band ??= makeCanvas();
  const scale = Math.min(1, 420 / Math.max(w, h));
  const bw = Math.max(2, Math.round(w * scale)),
    bh = Math.max(2, Math.round(h * scale));
  resize(band, bw, bh);
  const ctx = band.getContext('2d');
  const source = layer.canvas;
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(source, x, y, w, h, 0, 0, bw, bh);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.filter = px(radius * scale);
  ctx.drawImage(source, x, y, w, h, 0, 0, bw, bh);
  ctx.globalCompositeOperation = 'source-in';
  ctx.filter = px(2.4 * radius * scale);
  const [sw, sh] = dimensions(background);
  const fx = sw / source.width,
    fy = sh / source.height;
  ctx.drawImage(background, x * fx, y * fy, w * fx, h * fy, 0, 0, bw, bh);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  layer.save();
  layer.globalAlpha = strength;
  layer.globalCompositeOperation = 'source-atop';
  layer.drawImage(band, 0, 0, bw, bh, x, y, w, h);
  layer.restore();
}

// Lay the visitor's own silhouette on the ground: pinned at the feet, leaning
// with the light, and softer than a contact shadow.
export function castShadow(ctx, visitor, mapping, light) {
  const contact = visitor.floorContact;
  if (!filters || !contact || !light || light.strength <= 0) return;
  const [vw, vh] = dimensions(visitor);
  shade ??= makeCanvas();
  const scale = Math.min(1, 200 / Math.max(vw, vh));
  resize(shade, Math.max(2, Math.round(vw * scale)), Math.max(2, Math.round(vh * scale)));
  const tone = shade.getContext('2d');
  tone.globalCompositeOperation = 'copy';
  tone.drawImage(visitor, 0, 0, shade.width, shade.height);
  tone.globalCompositeOperation = 'source-in';
  tone.fillStyle = '#000';
  tone.fillRect(0, 0, shade.width, shade.height);
  // Fade toward the head: the far end of a shadow is its most diffuse part.
  const top = (contact.y - contact.bodyHeight) * scale,
    feet = contact.y * scale;
  const fade = tone.createLinearGradient(0, top, 0, feet);
  fade.addColorStop(0, 'rgba(0,0,0,0.2)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  tone.globalCompositeOperation = 'destination-in';
  tone.fillStyle = fade;
  tone.fillRect(0, 0, shade.width, shade.height);
  tone.globalCompositeOperation = 'source-over';

  const origin = mapping.point(0, 0),
    floor = mapping.point(contact.x, contact.y).y;
  const size = mapping.scale;
  ctx.save();
  ctx.globalAlpha = light.strength;
  ctx.filter = px(Math.max(1.2, light.softness * contact.bodyHeight * size));
  // x' = x + dx (floor - y), y' = floor + dy (floor - y) in scene pixels.
  ctx.transform(1, 0, -light.dx, -light.dy, light.dx * floor, floor * (1 + light.dy));
  ctx.drawImage(shade, origin.x, origin.y, mapping.flip * vw * size, vh * size);
  ctx.restore();
}

// Estimate how wide the sharpest edges are. A defocused or enlarged region has
// no narrow edges at all, which makes this robust to how much texture exists.
// Returns the blur sigma in pixels of the given image data, or null.
export function edgeWidth(image, include = null, opaqueOnly = false) {
  const { width: w, height: h, data } = image;
  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; p < luma.length; i += 4, p++)
    luma[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const widths = [];
  const reach = 4;
  for (let y = reach; y < h - reach; y += 2) {
    for (let x = reach; x < w - reach; x += 2) {
      const p = y * w + x;
      if (opaqueOnly && data[4 * p + 3] < 250) continue;
      if (include && !include(p, x, y)) continue;
      const gx = (luma[p + 1] - luma[p - 1]) / 2,
        gy = (luma[p + w] - luma[p - w]) / 2;
      const gradient = Math.hypot(gx, gy);
      if (gradient < 6) continue;
      // Contrast across the edge, sampled along the gradient direction.
      const ux = gx / gradient,
        uy = gy / gradient;
      const ax = Math.round(x + reach * ux),
        ay = Math.round(y + reach * uy);
      const bx = Math.round(x - reach * ux),
        by = Math.round(y - reach * uy);
      // The matte boundary is not a photographic edge of the visitor.
      if (opaqueOnly && (data[4 * (ay * w + ax) + 3] < 250 || data[4 * (by * w + bx) + 3] < 250)) continue;
      const contrast = luma[ay * w + ax] - luma[by * w + bx];
      if (contrast < 24) continue;
      // A Gaussian-blurred step of height c has slope c / (sigma sqrt(2 pi)).
      widths.push(contrast / (2.5066 * gradient));
    }
  }
  if (widths.length < 40) return null;
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length * 0.12)];
}

// Read the photograph's own shadows. Beside each standing subject, the darker
// strip of ground shows which way shadows fall and how deep they are.
export function estimateLight(scene, people) {
  const fallback = { dx: 0.16, dy: 0.1, strength: 0.3, softness: 0.05 };
  const [sw, sh] = dimensions(scene);
  const w = 256,
    h = Math.max(8, Math.round((256 * sh) / sw));
  const probe = makeCanvas(w, h);
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(scene, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const mean = (x0, y0, x1, y1) => {
    const l = Math.max(0, Math.floor(x0 * w)),
      r = Math.min(w, Math.ceil(x1 * w));
    const t = Math.max(0, Math.floor(y0 * h)),
      b = Math.min(h, Math.ceil(y1 * h));
    let sum = 0,
      count = 0;
    for (let y = t; y < b; y++)
      for (let x = l; x < r; x++) {
        const i = 4 * (y * w + x);
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        count++;
      }
    return count >= 6 ? sum / count : null;
  };
  let left = 0,
    right = 0,
    depthSum = 0,
    weight = 0;
  for (const { box, grounded } of people) {
    const [l, t, r, b] = box;
    const bw = r - l,
      bh = b - t;
    if (!grounded || bh < 0.12 || b > 0.93) continue;
    const top = b - 0.03 * bh,
      bottom = b + 0.09 * bh;
    const leftSide = mean(l - 0.75 * bw, top, l + 0.05 * bw, bottom),
      rightSide = mean(r - 0.05 * bw, top, r + 0.75 * bw, bottom);
    const around = mean(l - 1.8 * bw, b + 0.1 * bh, r + 1.8 * bw, b + 0.2 * bh);
    if (leftSide === null || rightSide === null || !around) continue;
    const area = bw * bh;
    const darker = Math.min(leftSide, rightSide) / around;
    if (darker < 0.88) {
      if (leftSide < rightSide * 0.92) left += area;
      else if (rightSide < leftSide * 0.92) right += area;
      depthSum += area * (1 - darker);
      weight += area;
    }
  }
  if (!weight) return fallback;
  const depth = depthSum / weight;
  const strength = Math.max(0.22, Math.min(0.55, 1.15 * depth));
  const side = left > 2 * right ? -1 : right > 2 * left ? 1 : 0;
  return {
    dx: side ? 0.3 * side : fallback.dx,
    dy: 0.12,
    strength,
    // Hard sunlight draws a crisp shadow. Overcast light barely draws one.
    softness: 0.055 - 0.07 * (strength - 0.22)
  };
}

const toLinear = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
function toneQuantile(values, fraction, minimum) {
  if (values.length < minimum) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * fraction)];
}

// A dark silhouette against a bright background is evidence of backlighting.
// Different clothing or skin tones alone do not establish an exposure mismatch.
export function peopleTone(scene, people, depthAt) {
  const { w, h, data } = thumbnail(scene, 240);
  const backlit = [];
  let measured = 0;
  for (const { box, depth } of people) {
    const [left, top, right, bottom] = box;
    const bw = right - left, bh = bottom - top;
    if (bw * w < 8 || bh * h < 14) continue;
    const head = [], body = [], surroundings = [];
    const x0 = Math.max(0, Math.floor((left - 0.3 * bw) * w));
    const x1 = Math.min(w, Math.ceil((right + 0.3 * bw) * w));
    const y0 = Math.max(0, Math.floor((top - 0.1 * bh) * h));
    const y1 = Math.min(h, Math.ceil((top + 0.8 * bh) * h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const nx = (x + 0.5) / w, ny = (y + 0.5) / h;
        const u = (nx - left) / bw, v = (ny - top) / bh;
        let region;
        if (v < 0 || u < 0 || u > 1) {
          if (v > 0.47 || people.some(({ box: b }) => nx >= b[0] && nx <= b[2] && ny >= b[1] && ny <= b[3])) continue;
          region = surroundings;
        } else {
          if (depthAt && Number.isFinite(depth) && Math.abs(depthAt(nx, ny) - depth) > 0.05) continue;
          if (v >= 0.04 && v < 0.22 && u >= 0.38 && u <= 0.62) region = head;
          else if (v >= 0.22 && u >= 0.28 && u <= 0.72) region = body;
          else continue;
        }
        const i = 4 * (y * w + x);
        region.push(0.2126 * toLinear(data[i]) + 0.7152 * toLinear(data[i + 1]) + 0.0722 * toLinear(data[i + 2]));
      }
    }
    const face = toneQuantile(head, 0.7, 8);
    const torso = toneQuantile(body, 0.7, 30);
    const backdrop = toneQuantile(surroundings, 0.5, 24);
    if (face == null || torso == null || backdrop == null) continue;
    measured++;
    // Require both regions to be below middle gray and at least two stops
    // below the nearby backdrop. One dark outfit cannot trigger the correction.
    const lighter = Math.max(face, torso, 0.003);
    if (lighter < 0.18 && backdrop >= 4 * lighter) backlit.push(lighter);
  }
  return backlit.length > measured / 2 ? toneQuantile(backlit, 0.5, 1) : null;
}

// The same measure on the visitor's own pixels.
export function visitorTone(rgba) {
  const values = [];
  const stride = 4 * Math.max(1, Math.floor(rgba.length / 4 / 6000));
  for (let i = 0; i < rgba.length; i += stride) {
    if (rgba[i + 3] < 250) continue;
    values.push(0.2126 * toLinear(rgba[i]) + 0.7152 * toLinear(rgba[i + 1]) + 0.0722 * toLinear(rgba[i + 2]));
  }
  return toneQuantile(values, 0.7, 30);
}

function thumbnail(scene, limit) {
  const [sw, sh] = dimensions(scene);
  const scale = Math.min(1, limit / Math.max(sw, sh));
  const w = Math.max(4, Math.round(sw * scale)),
    h = Math.max(4, Math.round(sh * scale));
  const probe = makeCanvas(w, h);
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(scene, 0, 0, w, h);
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

// The picture area of a scan, as [left, top, right, bottom] fractions. Old
// prints and negatives arrive with a blank mount or film edge around them,
// and a visitor must not stand on the mount.
export function pictureFrame(scene) {
  const { w, h, data } = thumbnail(scene, 240);
  const blank = (start, step, count) => {
    let sum = 0,
      squares = 0;
    for (let k = 0, i = start; k < count; k++, i += step) {
      const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += y;
      squares += y * y;
    }
    const mean = sum / count,
      spread = Math.sqrt(Math.max(0, squares / count - mean * mean));
    return spread < 2.5 || (spread < 9 && (mean > 232 || mean < 24));
  };
  const row = (y) => blank(4 * y * w, 4, w),
    column = (x) => blank(4 * x, 4 * w, h);
  const inset = (test, size) => {
    let n = 0;
    while (n < 0.14 * size && test(n)) n++;
    return n;
  };
  const left = inset(column, w),
    right = inset((n) => column(w - 1 - n), w);
  const top = inset(row, h),
    bottom = inset((n) => row(h - 1 - n), h);
  return [left / w, top / h, 1 - right / w, 1 - bottom / h];
}

// A black-and-white or toned print has one colour for each brightness. Return
// that colour ramp, or null for a colour photograph.
export function printTone(scene) {
  const { data } = thumbnail(scene, 160);
  const bins = 32;
  const sum = new Float64Array(bins * 3),
    count = new Float64Array(bins);
  const luma = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  for (let i = 0; i < data.length; i += 4) {
    const bin = Math.min(bins - 1, Math.floor((luma(i) / 256) * bins));
    count[bin]++;
    for (let k = 0; k < 3; k++) sum[bin * 3 + k] += data[i + k];
  }
  // How far each pixel strays from the colour its brightness predicts.
  const strays = [];
  for (let i = 0; i < data.length; i += 16) {
    const bin = Math.min(bins - 1, Math.floor((luma(i) / 256) * bins));
    let stray = 0;
    for (let k = 0; k < 3; k++) stray = Math.max(stray, Math.abs(data[i + k] - sum[bin * 3 + k] / count[bin]));
    strays.push(stray);
  }
  strays.sort((a, b) => a - b);
  if (strays[Math.floor(strays.length * 0.9)] > 11) return null;
  const ramp = new Uint8ClampedArray(256 * 3);
  const centre = (bin) => ((bin + 0.5) * 256) / bins;
  const filled = [...count.keys()].filter((bin) => count[bin] >= 8);
  if (filled.length < 2) return null;
  for (let y = 0; y < 256; y++) {
    let lower = filled[0],
      upper = filled[filled.length - 1];
    for (const bin of filled) {
      if (centre(bin) <= y) lower = bin;
      if (centre(bin) >= y) {
        upper = bin;
        break;
      }
    }
    const span = centre(upper) - centre(lower);
    const t = span > 0 ? Math.min(1, Math.max(0, (y - centre(lower)) / span)) : 0;
    for (let k = 0; k < 3; k++) {
      const a = sum[lower * 3 + k] / count[lower],
        b = sum[upper * 3 + k] / count[upper];
      // Outside the photographed range, keep the tint and follow brightness.
      const offset = y < centre(filled[0]) ? y - centre(filled[0]) : y > centre(upper) ? y - centre(upper) : 0;
      ramp[y * 3 + k] = a + t * (b - a) + offset;
    }
  }
  return ramp;
}

export const canFilter = filters;
export const blurFilter = px;
