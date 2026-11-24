import { makeCanvas } from './canvas.js';
import { floorSupport } from './live-matte.js';

const COLUMNS = 64;

function readAlpha(cut, columns) {
  const rows = Math.max(1, Math.round((columns * cut.height) / cut.width));
  const thumb = makeCanvas(columns, rows);
  const ctx = thumb.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(cut, 0, 0, columns, rows);
  return { rows, pixels: ctx.getImageData(0, 0, columns, rows).data };
}

// A photograph of a person has no camera frame to tell whether their feet are
// in the picture. A cropped figure ends in a wide flat edge; shoes are narrow.
// Record the answer, and the ground contact when there is one, on the cutout.
export function describeStill(cut) {
  const w = Math.min(256, cut.width),
    { rows: h, pixels } = readAlpha(cut, w);
  const start = new Int32Array(h),
    end = new Int32Array(h);
  let widest = 0,
    left = w,
    right = -1,
    top = -1;
  for (let y = 0; y < h; y++) {
    let first = w,
      last = -1;
    for (let x = 0; x < w; x++) {
      if (pixels[(y * w + x) * 4 + 3] < 178) continue;
      if (x < first) first = x;
      last = x;
    }
    start[y] = first;
    end[y] = last;
    widest = Math.max(widest, last - first + 1);
    if (last >= first) {
      if (top < 0) top = y;
      left = Math.min(left, first);
      right = Math.max(right, last);
    }
  }
  let base = h - 1;
  while (base > 0 && end[base] < start[base]) base--;
  // Count solid pixels along the base, so two separate shoes are not one span.
  let solid = 0;
  for (let x = 0; x < w; x++) if (pixels[(base * w + x) * 4 + 3] >= 178) solid++;
  if (right >= left) {
    // Measure the person by their solid silhouette. A matte often carries a
    // faint haze of background that would make them seem larger than they are.
    const sx = cut.width / w,
      sy = cut.height / h;
    const x = Math.max(0, Math.floor((left - 1) * sx)),
      y = Math.max(0, Math.floor((top - 1) * sy));
    cut.foregroundBounds = {
      x,
      y,
      width: Math.min(cut.width, Math.ceil((right + 2) * sx)) - x,
      height: Math.min(cut.height, Math.ceil((base + 2) * sy)) - y
    };
  }
  cut.cropped = widest > 0 && solid >= 0.42 * widest;
  cut.floorContact = cut.cropped ? null : floorSupport(pixels, w, h, start, end, cut.width, cut.height, false);
  return cut;
}

// The visitor as the planner needs them: silhouette samples relative to the
// bottom centre, in units of visible height, plus the camera edge and face.
export function profileVisitor(cut, face = null, standing = null) {
  const visible = cut.foregroundBounds || { x: 0, y: 0, width: cut.width, height: cut.height };
  const feet = cut.floorContact;
  const height = feet?.bodyHeight || visible.height;
  const bottom = feet?.y ?? visible.y + visible.height;
  const centre = feet?.x ?? visible.x + visible.width / 2;
  const { rows, pixels } = readAlpha(cut, COLUMNS);
  const body = [],
    seam = [];
  const filled = new Uint8Array(COLUMNS * rows);
  const onFace = (sx, sy) =>
    face
      ? Math.abs(sx - face.x) * cut.width < (face.height * cut.height) / 2 &&
        Math.abs(sy - face.y) < face.height / 2
      : null;
  let lowest = -1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      if (pixels[(y * COLUMNS + x) * 4 + 3] < 128) continue;
      filled[y * COLUMNS + x] = 1;
      lowest = y;
      const sx = (x + 0.5) / COLUMNS,
        sy = (y + 0.5) / rows;
      const dx = (sx * cut.width - centre) / height,
        dy = (sy * cut.height - bottom) / height;
      body.push([dx, dy, onFace(sx, sy) ?? dy < -0.76]);
    }
  }
  // A live frame is cropped when the matte runs into the bottom of the camera
  // image. A still carries the answer from describeStill.
  const edge = cut.cropped === undefined ? rows - 1 : lowest;
  if (edge >= 0) {
    for (let x = 0; x < COLUMNS; x++) {
      if (filled[edge * COLUMNS + x]) seam.push((((x + 0.5) / COLUMNS) * cut.width - centre) / height);
    }
  }
  const cropped =
    cut.cropped === undefined ? !feet && seam.length >= Math.max(2, COLUMNS * 0.035) : cut.cropped;
  return {
    height,
    bottom,
    centre,
    aspect: visible.width / height,
    cropped,
    body,
    seam: cropped ? seam : [],
    // Visible height as a share of standing height: below one for a crouch or lunge.
    stature: standing > 0 ? Math.max(0.4, Math.min(1.2, height / standing)) : null,
    faceFraction: face ? (face.height * cut.height) / height : null,
    faceUp: face ? (bottom - face.y * cut.height) / height : null,
    contains(dx, dy) {
      const x = Math.floor(((dx * height + centre) / cut.width) * COLUMNS),
        y = Math.floor(((dy * height + bottom) / cut.height) * rows);
      return x >= 0 && x < COLUMNS && y >= 0 && y < rows && filled[y * COLUMNS + x] === 1;
    }
  };
}
