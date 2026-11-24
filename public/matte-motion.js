import { makeCanvas, resize } from './canvas.js';

// Interpolate at most two camera frames from the last real segmentation.
// Block matching measures the backward displacement of the *current* RGB
// image. Seek, scene cut, fast movement or a poor match forces new inference.
export class MatteMotion {
  constructor() {
    this.canvas = makeCanvas();
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }
  reset() {
    this.anchor = null;
  }
  read(source) {
    const w = 96,
      h = Math.max(8, Math.round((w * source.height) / source.width));
    resize(this.canvas, w, h);
    this.ctx.drawImage(source, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }
  remember(rgb, matte, w, h, time, mirror, cost) {
    this.anchor = { rgb, matte: matte.slice(), w, h, time, mirror, cost, frames: 0 };
  }
  predict(rgb, time, mirror) {
    const a = this.anchor,
      delta = time - (a?.time ?? Infinity);
    if (
      !a ||
      a.cost < 22 ||
      a.frames >= 2 ||
      delta <= 0 ||
      delta > 0.145 ||
      a.mirror !== mirror ||
      a.rgb.width !== rgb.width ||
      a.rgb.height !== rgb.height
    )
      return null;
    a.frames++;
    const { width: w, height: h, data: current } = rgb,
      prior = a.rgb.data;
    const step = 6,
      cols = Math.ceil((w - 1) / step) + 1,
      rows = Math.ceil((h - 1) / step) + 1;
    const fieldX = new Int8Array(cols * rows),
      fieldY = new Int8Array(cols * rows);
    let error = 0,
      votes = 0,
      mismatches = 0,
      subjectVotes = 0,
      subjectMisses = 0,
      edgeMisses = 0;
    for (let row = 0; row < rows; row++) {
      const y = Math.min(h - 1, row * step);
      for (let col = 0; col < cols; col++) {
        const x = Math.min(w - 1, col * step);
        const loX = Math.max(0, x - 3),
          hiX = Math.min(w - 1, x + 3);
        const loY = Math.max(0, y - 3),
          hiY = Math.min(h - 1, y + 3);
        let best = Infinity,
          motionX = 0,
          motionY = 0;
        const n = (1 + ((hiX - loX) >> 1)) * (1 + ((hiY - loY) >> 1));
        for (let dy = Math.max(-4, -loY); dy <= Math.min(4, h - 1 - hiY); dy++) {
          for (let dx = Math.max(-4, -loX); dx <= Math.min(4, w - 1 - hiX); dx++) {
            const off = 4 * (dy * w + dx);
            let sum = n * 0.8 * (Math.abs(dx) + Math.abs(dy));
            for (let py = loY; py <= hiY && sum < best; py += 2) {
              for (let px = loX; px <= hiX; px += 2) {
                const i = (py * w + px) * 4;
                // Luma and some chroma discriminate similarly bright clothes and room.
                sum +=
                  Math.abs(current[i] - prior[i + off]) * 0.24 +
                  Math.abs(current[i + 1] - prior[i + off + 1]) * 0.53 +
                  Math.abs(current[i + 2] - prior[i + off + 2]) * 0.23;
              }
            }
            if (sum < best) {
              best = sum;
              motionX = dx;
              motionY = dy;
            }
          }
        }
        const k = row * cols + col;
        fieldX[k] = motionX;
        fieldY[k] = motionY;
        // Measure residual near the anchor person in addition to global cuts.
        const mx = Math.min(a.w - 1, Math.floor((x * a.w) / w)),
          my = Math.min(a.h - 1, Math.floor((y * a.h) / h));
        const weight = a.matte[my * a.w + mx] < 0.95 ? 5 : 1;
        if (weight > 1) {
          subjectVotes++;
          if (best / n > 18) subjectMisses++;
        }
        // Two high-residual patches at the silhouette are enough to request
        // a fresh mask for a fast hand even if the stationary torso aligns.
        if (best / n > 25) {
          const sx = Math.max(1, Math.round((step * a.w) / w)),
            sy = Math.max(1, Math.round((step * a.h) / h));
          const neighborhood = [
            a.matte[my * a.w + mx],
            a.matte[my * a.w + Math.max(0, mx - sx)],
            a.matte[my * a.w + Math.min(a.w - 1, mx + sx)],
            a.matte[Math.max(0, my - sy) * a.w + mx],
            a.matte[Math.min(a.h - 1, my + sy) * a.w + mx]
          ];
          if (Math.min(...neighborhood) < 0.5 && Math.max(...neighborhood) > 0.5) edgeMisses++;
        }
        error += (weight * best) / n;
        votes += weight;
        if (best / n > 21) mismatches += weight;
      }
    }
    if (
      !subjectVotes ||
      subjectMisses > subjectVotes * 0.25 ||
      edgeMisses >= 2 ||
      error / votes > 10 ||
      mismatches > votes * 0.12
    )
      return null;
    const predicted = new Float32Array(a.w * a.h);
    for (let y = 0; y < a.h; y++) {
      const v = (y * h) / (a.h * step),
        row = Math.min(rows - 2, Math.floor(v)),
        fy = Math.min(1, v - row);
      for (let x = 0; x < a.w; x++) {
        const u = (x * w) / (a.w * step),
          col = Math.min(cols - 2, Math.floor(u)),
          fx = Math.min(1, u - col);
        const k = row * cols + col;
        const tl = (1 - fx) * (1 - fy),
          tr = fx * (1 - fy),
          bl = (1 - fx) * fy,
          br = fx * fy;
        const dx = tl * fieldX[k] + tr * fieldX[k + 1] + bl * fieldX[k + cols] + br * fieldX[k + cols + 1];
        const dy = tl * fieldY[k] + tr * fieldY[k + 1] + bl * fieldY[k + cols] + br * fieldY[k + cols + 1];
        const sx = Math.min(a.w - 1, Math.max(0, x + (dx * a.w) / w)),
          sy = Math.min(a.h - 1, Math.max(0, y + (dy * a.h) / h));
        const lx = Math.min(a.w - 2, Math.floor(sx)),
          ly = Math.min(a.h - 2, Math.floor(sy)),
          ix = sx - lx,
          iy = sy - ly;
        const p = ly * a.w + lx;
        predicted[y * a.w + x] =
          ((1 - ix) * a.matte[p] + ix * a.matte[p + 1]) * (1 - iy) +
          ((1 - ix) * a.matte[p + a.w] + ix * a.matte[p + a.w + 1]) * iy;
      }
    }
    return { background: predicted, width: a.w, height: a.h };
  }
}
