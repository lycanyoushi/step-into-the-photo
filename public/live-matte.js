// The previous matte is useful at uncertain stationary edges. A large local confidence
// change means a limb arrived or left; that pixel follows the current frame immediately.
export class LiveMatte {
  reset() {
    this.history = null;
    this.time = null;
    this.mirror = null;
  }

  begin(width, height, time, mirror) {
    const elapsed = time - this.time;
    const continuous =
      this.history &&
      width === this.width &&
      height === this.height &&
      mirror === this.mirror &&
      elapsed > 0 &&
      elapsed <= 0.18;
    if (!this.history || this.width !== width || this.height !== height) {
      this.history = new Uint8ClampedArray(width * height);
    }
    this.width = width;
    this.height = height;
    this.time = time;
    this.mirror = mirror;
    // Tab throttling, seeking, looping, changing cameras and explicit masks start a fresh matte.
    this.blend = Boolean(continuous);
    this.offsets ??= new Int8Array(511);
    if (continuous) {
      const memory = Math.min(0.75, Math.exp(-elapsed / 0.08));
      // Differences of 70/255 or more represent motion. The small table also keeps
      // exponentiation and division out of the pixel loop.
      for (let d = -69; d <= 69; d++) {
        this.offsets[d + 255] = Math.round(d * memory * (1 - Math.abs(d) / 70));
      }
    }
  }
}

// A small remote island (often in a corner of the frame) mustn't move the
// visitor's feet or set their apparent height. Keep all substantial runs
// and bridge gaps near a body so detached fingers and shoes are retained.
function occupiedSpan(histogram) {
  const runs = [];
  const bridge = Math.max(2, Math.ceil(histogram.length * 0.07));
  let run;
  for (let i = 0; i < histogram.length; i++) {
    if (!histogram[i]) continue;
    if (!run || i - run.end > bridge) {
      run = { start: i, end: i, mass: 0 };
      runs.push(run);
    }
    run.end = i;
    run.mass += histogram[i];
  }
  if (!runs.length) return [0, histogram.length];
  const required = 0.06 * Math.max(...runs.map((r) => r.mass));
  const kept = runs.filter((r) => r.mass >= required);
  return [Math.max(0, kept[0].start - 2), kept[kept.length - 1].end + 3];
}

export function subjectExtent(backgroundProbability, w, h) {
  const stride = 4;
  const cols = new Uint16Array(Math.ceil(w / stride)),
    rows = new Uint16Array(Math.ceil(h / stride));
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      if (backgroundProbability[y * w + x] > 0.73) continue;
      cols[x / stride]++;
      rows[y / stride]++;
    }
  }
  const [left, right] = occupiedSpan(cols),
    [top, bottom] = occupiedSpan(rows);
  return { left: left * stride, right: right * stride, top: top * stride, bottom: bottom * stride };
}

// One class map avoids transferring six full confidence maps off the GPU.
// A one-pixel tent filter gives RGB-guided refinement a soft transition to
// align with real hair and clothing edges in the higher-resolution frame.
export function featherCategories(labels, w, h, background) {
  for (let y = 0; y < h; y++) {
    const row = y * w,
      above = Math.max(0, y - 1) * w,
      below = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const left = Math.max(0, x - 1),
        right = Math.min(w - 1, x + 1);
      const center = !labels[row + x];
      const adjacent = !labels[row + left] + !labels[row + right] + !labels[above + x] + !labels[below + x];
      const corners =
        !labels[above + left] + !labels[above + right] + !labels[below + left] + !labels[below + right];
      background[row + x] = (4 * center + 2 * adjacent + corners) / 16;
    }
  }
}

// At an uncertain edge, the camera pixel is a mixture of foreground and the
// old room. Sample either side along the matte normal and solve for coverage
// against the actual camera colors. Similar colors retain the model's alpha.
export function refineCameraEdge(image, mask, scale) {
  const { width: w, height: h, data: pixels } = image;
  const step = Math.max(1, Math.round(scale));
  const reach = Math.max(3, 4 * scale);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const prior = mask[i + 3];
      pixels[i + 3] = prior;
      if (prior < 2 || prior > 253) continue;
      const xl = Math.max(0, x - step),
        xr = Math.min(w - 1, x + step);
      const yt = Math.max(0, y - step),
        yb = Math.min(h - 1, y + step);
      const gx = mask[4 * (y * w + xr) + 3] - mask[4 * (y * w + xl) + 3];
      const gy = mask[4 * (yb * w + x) + 3] - mask[4 * (yt * w + x) + 3];
      const length = Math.sqrt(gx * gx + gy * gy);
      if (length < 8) continue;
      const dx = Math.round((reach * gx) / length),
        dy = Math.round((reach * gy) / length);
      const fx = Math.min(w - 1, Math.max(0, x + dx)),
        fy = Math.min(h - 1, Math.max(0, y + dy));
      const bx = Math.min(w - 1, Math.max(0, x - dx)),
        by = Math.min(h - 1, Math.max(0, y - dy));
      const fi = 4 * (fy * w + fx),
        bi = 4 * (by * w + bx);
      if (mask[fi + 3] < 235 || mask[bi + 3] > 20) continue;
      const r = pixels[fi] - pixels[bi],
        g = pixels[fi + 1] - pixels[bi + 1],
        b = pixels[fi + 2] - pixels[bi + 2];
      const rr = pixels[i] - pixels[bi],
        gg = pixels[i + 1] - pixels[bi + 1],
        bb = pixels[i + 2] - pixels[bi + 2];
      const energy = r * r + g * g + b * b;
      if (energy < 225) continue;
      const projection = Math.min(1, Math.max(0, (rr * r + gg * g + bb * b) / energy));
      const er = rr - projection * r,
        eg = gg - projection * g,
        eb = bb - projection * b;
      const residual = er * er + eg * eg + eb * eb;
      // A pixel with its own distinct color, such as a patterned cuff or
      // strand of dyed hair, should not inherit its neighbor's color.
      const trust = (0.92 * energy) / (energy + 550 + 12 * residual);
      const alpha = prior / 255 + trust * (projection - prior / 255);
      pixels[i + 3] = 255 * alpha;
      const decontaminate = (1 - alpha) * trust * 0.82;
      pixels[i] += decontaminate * (pixels[fi] - pixels[i]);
      pixels[i + 1] += decontaminate * (pixels[fi + 1] - pixels[i + 1]);
      pixels[i + 2] += decontaminate * (pixels[fi + 2] - pixels[i + 2]);
    }
  }
}

// Use only the opaque body core to locate support, avoiding low-confidence hair,
// clothing shadows and isolated flecks. Estimates stay in original source pixels.
export function floorSupport(rgba, w, h, rowStart, rowEnd, sourceW, sourceH, edgeIsCrop = true) {
  const minSpan = Math.max(2, Math.round(0.009 * w));
  let top = h,
    bottom = -1,
    bodyLeft = w,
    bodyRight = -1;
  for (let y = 0; y < h; y++) {
    if (rowEnd[y] - rowStart[y] + 1 < minSpan) continue;
    if (y < top) top = y;
    bottom = y;
    bodyLeft = Math.min(bodyLeft, rowStart[y]);
    bodyRight = Math.max(bodyRight, rowEnd[y]);
  }
  const bodyHeight = bottom - top + 1;
  if (bodyHeight < 0.16 * h || (edgeIsCrop && bottom >= h - Math.max(3, 0.025 * h))) return null;
  const yStart = bottom - Math.max(2, Math.round(bodyHeight * 0.026));
  const sx = sourceW / w,
    sy = sourceH / h;
  const supports = [];
  let left = null,
    end = -1,
    lowest = -1;
  const maxGap = Math.max(1, Math.round(bodyHeight * 0.012));
  function finish() {
    if (left === null) return;
    const span = end - left + 1;
    if (span >= minSpan && span <= bodyHeight * 0.45 && (!edgeIsCrop || (left > 0 && end < w - 1))) {
      supports.push({ x: (left + end + 1) * 0.5 * sx, y: (lowest + 1) * sy, width: span * sx });
    }
    left = null;
    lowest = -1;
  }
  for (let x = bodyLeft; x <= bodyRight; x++) {
    let supportY = bottom;
    while (supportY >= yStart && rgba[(supportY * w + x) * 4 + 3] < 178) supportY--;
    if (supportY >= yStart) {
      if (left === null) left = x;
      end = x;
      lowest = Math.max(lowest, supportY);
    } else if (x - end > maxGap) {
      finish();
    }
  }
  finish();
  if (!supports.length || supports.length > 2) return null;
  const x = supports.reduce((sum, p) => sum + p.x, 0) / supports.length;
  return { x, y: (bottom + 1) * sy, bodyHeight: bodyHeight * sy, supports };
}
