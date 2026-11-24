/* Photo pose editing. All public joint positions use pixels in the cutout canvas.
   "left" and "right" refer to the person's own body, as in MediaPipe. */
const SIDES = ['left', 'right'];
const GROUPS = ['body', 'leftLeg', 'rightLeg', 'leftArm', 'rightArm'];
const CHAINS = {
  leftArm: ['leftShoulder', 'leftElbow', 'leftWrist', 'leftHand'],
  rightArm: ['rightShoulder', 'rightElbow', 'rightWrist', 'rightHand'],
  leftLeg: ['leftHip', 'leftKnee', 'leftAnkle', 'leftFoot'],
  rightLeg: ['rightHip', 'rightKnee', 'rightAnkle', 'rightFoot']
};
const INDEX = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHand: 19,
  rightHand: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftFoot: 31,
  rightFoot: 32
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });
const clone = (joints) => Object.fromEntries(Object.entries(joints).map(([k, p]) => [k, { ...p }]));
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}
function bounds(input) {
  const d = input.getContext('2d').getImageData(0, 0, input.width, input.height).data;
  let x0 = input.width,
    y0 = input.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < input.height; y++) {
    for (let x = 0; x < input.width; x++) {
      if (d[(y * input.width + x) * 4 + 3] < 16) continue;
      x0 = Math.min(x, x0);
      x1 = Math.max(x, x1);
      y0 = Math.min(y, y0);
      y1 = Math.max(y, y1);
    }
  }
  if (x1 < x0) throw new Error('The cutout is empty. Select the person again.');
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Recenter the subject and leave transparent space for longer reaches.
export function padForPose(cutout) {
  const b = bounds(cutout);
  const side = Math.ceil(Math.max(b.w * 1.35, b.h * 1.42));
  const scale = Math.min(1, 960 / side);
  const c = canvas(side * scale, side * scale);
  c.posePadding = {
    scale,
    sourceWidth: cutout.width,
    sourceHeight: cutout.height,
    offsetX: (c.width - b.w * scale) / 2 - b.x * scale,
    offsetY: (c.height - b.h * scale) / 2 - b.y * scale
  };
  c.getContext('2d').drawImage(
    cutout,
    b.x,
    b.y,
    b.w,
    b.h,
    (c.width - b.w * scale) / 2,
    (c.height - b.h * scale) / 2,
    b.w * scale,
    b.h * scale
  );
  return c;
}

let detectorPromise;
async function detector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import('./vendor/mediapipe/vision_bundle.mjs');
      const wasm = await FilesetResolver.forVisionTasks(
        new URL('./vendor/mediapipe/wasm', import.meta.url).href
      );
      return PoseLandmarker.createFromOptions(wasm, {
        baseOptions: { modelAssetPath: new URL('./models/pose_landmarker_lite.task', import.meta.url).href },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.45,
        outputSegmentationMasks: false
      });
    })().catch((err) => {
      detectorPromise = null;
      throw err;
    });
  }
  return detectorPromise;
}
async function detect(photo, box) {
  // A neutral backdrop avoids treating transparent black padding as part of the subject.
  const margin = Math.max(box.w, box.h) * 0.065;
  const w = box.w + 2 * margin,
    h = box.h + 2 * margin,
    scale = Math.min(1, 900 / Math.max(w, h));
  const input = canvas(w * scale, h * scale),
    ctx = input.getContext('2d');
  ctx.fillStyle = '#999';
  ctx.fillRect(0, 0, input.width, input.height);
  ctx.drawImage(
    photo,
    box.x,
    box.y,
    box.w,
    box.h,
    (margin / w) * input.width,
    (margin / h) * input.height,
    (box.w / w) * input.width,
    (box.h / h) * input.height
  );
  const result = (await detector()).detect(input);
  try {
    const landmarks = result.landmarks[0];
    if (!landmarks) return null;
    return Object.fromEntries(
      Object.entries(INDEX).map(([k, i]) => {
        const p = landmarks[i];
        return [
          k,
          {
            x: box.x - margin + p.x * w,
            y: box.y - margin + p.y * h,
            z: p.z * w,
            confidence: p.visibility ?? 1
          }
        ];
      })
    );
  } finally {
    result.close?.();
  }
}
// How tall the person would stand, in cutout pixels, whatever their pose.
// Limb lengths do not change when someone lunges, crouches or raises an arm,
// so this sets a visitor's scale more surely than the height of their outline.
export async function standingHeight(cutout) {
  const joints = await detect(cutout, bounds(cutout));
  if (!joints) return null;
  const sure = (...names) => names.every((name) => joints[name].confidence >= 0.5);
  if (!sure('leftShoulder', 'rightShoulder', 'leftHip', 'rightHip')) return null;
  const legs = SIDES.filter((side) => sure(side + 'Knee', side + 'Ankle')).map(
    (side) => dist(joints[side + 'Hip'], joints[side + 'Knee']) + dist(joints[side + 'Knee'], joints[side + 'Ankle'])
  );
  if (!legs.length) return null;
  const torso = dist(mid(joints.leftShoulder, joints.rightShoulder), mid(joints.leftHip, joints.rightHip));
  // Shoulder to ankle is about 0.78 of standing height.
  return (Math.max(...legs) + torso) / 0.78;
}

function template(b) {
  const result = { nose: { x: b.x + b.w * 0.5, y: b.y + b.h * 0.105, z: 0 } };
  const points = {
    Shoulder: [0.22, 0.24],
    Elbow: [0.35, 0.405],
    Wrist: [0.405, 0.54],
    Hand: [0.415, 0.585],
    Hip: [0.14, 0.51],
    Knee: [0.155, 0.735],
    Ankle: [0.16, 0.945],
    Foot: [0.215, 0.98]
  };
  for (const side of SIDES) {
    const sign = side === 'left' ? 1 : -1;
    for (const [joint, [x, y]] of Object.entries(points)) {
      result[side + joint] = { x: b.x + b.w * (0.5 + sign * x), y: b.y + b.h * y, z: 0 };
    }
  }
  return result;
}

export async function createPoseRig(cutoutCanvas) {
  const box = bounds(cutoutCanvas);
  let source = null;
  let message = 'No pose detected. Align the source joints to the person before posing.';
  try {
    source = await detect(cutoutCanvas, box);
  } catch (error) {
    message = 'Pose detector unavailable. Align the source joints manually. ' + error.message;
  }
  const detected = Boolean(source);
  if (source) message = 'Body landmarks detected. Adjust any misplaced source joints before posing.';
  source ||= template(box);
  return {
    source,
    target: clone(source),
    detected,
    message,
    width: cutoutCanvas.width,
    height: cutoutCanvas.height
  };
}

function transferVector(origin, referenceEnd, sourceStart, sourceEnd, destStart, core = false) {
  const dx = referenceEnd.x - origin.x,
    dy = referenceEnd.y - origin.y;
  const ref2 = Math.hypot(dx, dy);
  if (ref2 < 1e-3) return { ...destStart };
  const referenceLength = Math.hypot(ref2, (referenceEnd.z || 0) - (origin.z || 0));
  const src2 = dist(sourceStart, sourceEnd);
  const src3 = Math.min(src2 * 1.7, Math.hypot(src2, (sourceEnd.z || 0) - (sourceStart.z || 0)));
  // Monocular z is noisy, particularly on large clothing and unusual lenses.
  // Bound the projected length change so the texture keeps its proportions.
  const projected = (src3 / Math.max(referenceLength, 1e-3)) * ref2;
  const ratio = clamp(projected, src2 * (core ? 0.87 : 0.58), src2 * (core ? 1.1 : 1.22)) / ref2;
  return {
    x: destStart.x + dx * ratio,
    y: destStart.y + dy * ratio,
    z: (destStart.z || 0) + ((referenceEnd.z || 0) - (origin.z || 0)) * ratio
  };
}

// Fit the reference's projected bone directions and foreshortening to this person's proportions.
export function retargetPose(rig, reference) {
  const s = rig.source,
    r = reference,
    t = {};
  const hip = mid(s.leftHip, s.rightHip),
    refHip = mid(r.leftHip, r.rightHip);
  const chest = mid(s.leftShoulder, s.rightShoulder),
    refChest = mid(r.leftShoulder, r.rightShoulder);
  const targetChest = transferVector(refHip, refChest, hip, chest, hip, true);
  for (const side of SIDES) {
    t[side + 'Hip'] = transferVector(refHip, r[side + 'Hip'], hip, s[side + 'Hip'], hip, true);
    t[side + 'Shoulder'] = transferVector(
      refChest,
      r[side + 'Shoulder'],
      chest,
      s[side + 'Shoulder'],
      targetChest,
      true
    );
  }
  t.nose = transferVector(refChest, r.nose, chest, s.nose, targetChest, true);
  for (const chain of Object.values(CHAINS)) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1],
        b = chain[i];
      t[b] = transferVector(r[a], r[b], s[a], s[b], t[a]);
    }
  }
  rig.target = t;
  return rig;
}
export async function poseFromPhoto(rig, photo) {
  const w = photo.naturalWidth || photo.videoWidth || photo.width;
  const h = photo.naturalHeight || photo.videoHeight || photo.height;
  const ref = await detect(photo, { x: 0, y: 0, w, h });
  if (!ref) throw new Error('No person detected in the pose reference. Try a clear full-body photo.');
  return retargetPose(rig, ref);
}

function setDirection(t, s, start, end, dx, dy) {
  const length = dist(s[start], s[end]) / Math.max(Math.hypot(dx, dy), 1e-4);
  t[end] = { ...t[end], x: t[start].x + length * dx, y: t[start].y + length * dy };
}
export function applyPosePreset(rig, name) {
  if (!['original', 'wave', 'reach', 'stride'].includes(name)) throw new Error('Unknown pose preset.');
  const t = clone(rig.source),
    s = rig.source;
  const sign = s.leftShoulder.x >= s.rightShoulder.x ? 1 : -1;
  const aim = (a, b, x, y) => setDirection(t, s, a, b, x * sign, y);
  if (name === 'wave') {
    aim('leftShoulder', 'leftElbow', 0.92, -0.23);
    aim('leftElbow', 'leftWrist', 0.08, -1);
    aim('leftWrist', 'leftHand', 0.15, -1);
  } else if (name === 'reach') {
    for (const side of SIDES) {
      const k = side === 'left' ? 1 : -1;
      aim(side + 'Shoulder', side + 'Elbow', k, -0.48);
      aim(side + 'Elbow', side + 'Wrist', k, -0.65);
      aim(side + 'Wrist', side + 'Hand', k, -0.65);
    }
  } else if (name === 'stride') {
    for (const side of SIDES) {
      const k = side === 'left' ? 1 : -1;
      aim(side + 'Hip', side + 'Knee', k * 0.83, 0.85);
      aim(side + 'Knee', side + 'Ankle', k * 0.27, 1);
      aim(side + 'Ankle', side + 'Foot', k, 0.25);
      aim(side + 'Shoulder', side + 'Elbow', -k * 0.67, 1);
      aim(side + 'Elbow', side + 'Wrist', -k, 0.2);
      aim(side + 'Wrist', side + 'Hand', -k, 0.2);
    }
  }
  rig.target = t;
  return rig;
}
export function moveJoint(rig, name, x, y, editSource = false) {
  const joints = editSource ? rig.source : rig.target;
  if (!joints[name] || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = x - joints[name].x,
    dy = y - joints[name].y;
  joints[name] = { ...joints[name], x, y };
  if (editSource) {
    rig.target[name] = { ...rig.target[name], x: rig.target[name].x + dx, y: rig.target[name].y + dy };
  } else {
    const chain = Object.values(CHAINS).find((c) => c.includes(name));
    if (chain)
      for (const child of chain.slice(chain.indexOf(name) + 1)) {
        joints[child] = { ...joints[child], x: joints[child].x + dx, y: joints[child].y + dy };
      }
  }
}
export function hitJoint(rig, x, y, radius, editSource = false) {
  const joints = editSource ? rig.source : rig.target;
  let best = null,
    nearest = radius;
  for (const [name, p] of Object.entries(joints)) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d <= nearest) {
      nearest = d;
      best = name;
    }
  }
  return best;
}
export function drawRig(ctx, rig, editSource = false) {
  const j = editSource ? rig.source : rig.target;
  const lineWidth = 2 / Math.max(0.01, Math.hypot(ctx.getTransform().a, ctx.getTransform().b));
  ctx.save();
  const path = (names) => {
    ctx.beginPath();
    ctx.moveTo(j[names[0]].x, j[names[0]].y);
    for (const name of names.slice(1)) ctx.lineTo(j[name].x, j[name].y);
    ctx.stroke();
  };
  const paths = [
    ...Object.values(CHAINS),
    ['leftShoulder', 'rightShoulder', 'rightHip', 'leftHip', 'leftShoulder']
  ];
  for (const [color, width] of [
    ['#173534', 2.4],
    [editSource ? '#ffcf6d' : '#81f0d8', 1]
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * width;
    for (const names of paths) path(names);
    const neck = mid(j.leftShoulder, j.rightShoulder);
    ctx.beginPath();
    ctx.moveTo(j.nose.x, j.nose.y);
    ctx.lineTo(neck.x, neck.y);
    ctx.stroke();
  }
  for (const p of Object.values(j)) {
    ctx.fillStyle = editSource ? '#ffd582' : '#f5fffb';
    ctx.strokeStyle = '#193c36';
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.3 * lineWidth, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function segment(a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = Math.max(0.001, Math.hypot(dx, dy));
  return { a, b, dx, dy, length, ux: dx / length, uy: dy / length };
}
function segmentDistanceSq(x, y, bone, trim = 0) {
  const along = clamp((x - bone.a.x) * bone.ux + (y - bone.a.y) * bone.uy, trim, bone.length - trim);
  const dx = x - bone.a.x - bone.ux * along,
    dy = y - bone.a.y - bone.uy * along;
  return dx * dx + dy * dy;
}
function anatomy(j) {
  const chest = mid(j.leftShoulder, j.rightShoulder),
    hip = mid(j.leftHip, j.rightHip);
  const spine = segment(chest, hip);
  const width = Math.max(4, dist(j.leftShoulder, j.rightShoulder), spine.length * 0.48);
  const hipWidth = Math.max(width * 0.45, dist(j.leftHip, j.rightHip));
  const head = segment(chest, j.nose);
  const chains = Object.fromEntries(
    Object.entries(CHAINS).map(([group, names]) => {
      const isArm = group.endsWith('Arm');
      const radii = isArm ? [0.15, 0.12, 0.14] : [0.23, 0.16, 0.16];
      return [
        group,
        names.slice(1).map((name, i) => ({
          ...segment(j[names[i]], j[name]),
          radius: Math.max(2, width * radii[i])
        }))
      ];
    })
  );
  return { j, chest, hip, spine, width, hipWidth, head, chains };
}
function torsoFraction(x, y, body) {
  const s = body.spine;
  return ((x - s.a.x) * s.ux + (y - s.a.y) * s.uy) / s.length;
}
function closestLayer(x, y, body) {
  const v = clamp(torsoFraction(x, y, body), 0, 1);
  const torsoRadius = (body.width * (1 - v) + body.hipWidth * v) * 0.49;
  const headRadius = Math.max(body.width * 0.27, body.head.length * 0.48, 2);
  const headD = (x - body.head.b.x) ** 2 + (y - body.head.b.y) ** 2;
  let best = Math.min(
    segmentDistanceSq(x, y, body.spine) / torsoRadius ** 2,
    headD / headRadius ** 2,
    segmentDistanceSq(x, y, body.head) / (headRadius * 0.7) ** 2
  );
  let layer = 0;
  for (let k = 1; k < GROUPS.length; k++) {
    for (const bone of body.chains[GROUPS[k]]) {
      const score = segmentDistanceSq(x, y, bone) / (bone.radius * bone.radius);
      if (score < best) {
        best = score;
        layer = k;
      }
    }
  }
  return layer;
}
function rigidPoint(x, y, from, to, stretch = true) {
  const dx = x - from.a.x,
    dy = y - from.a.y;
  const along = (dx * from.ux + dy * from.uy) * (stretch ? to.length / from.length : 1);
  const across = dy * from.ux - dx * from.uy;
  return { x: to.a.x + to.ux * along - to.uy * across, y: to.a.y + to.uy * along + to.ux * across };
}
function bodyPoint(x, y, s, t) {
  const v = torsoFraction(x, y, s),
    f = clamp(v, 0, 1);
  const left = (j, axis) =>
    (1 - f) * (j.leftShoulder[axis] - j.rightShoulder[axis]) + f * (j.leftHip[axis] - j.rightHip[axis]);
  const vx = left(s.j, 'x'),
    vy = left(s.j, 'y');
  const cx = (1 - f) * s.chest.x + f * s.hip.x,
    cy = (1 - f) * s.chest.y + f * s.hip.y;
  const u = ((x - cx) * vx + (y - cy) * vy) / Math.max((s.width * 0.12) ** 2, vx * vx + vy * vy);
  const sx = x + (1 - f) * (t.chest.x - s.chest.x) + f * (t.hip.x - s.hip.x) + u * (left(t.j, 'x') - vx);
  const sy = y + (1 - f) * (t.chest.y - s.chest.y) + f * (t.hip.y - s.hip.y) + u * (left(t.j, 'y') - vy);
  if (v >= 0.015 || s.head.length < 1 || t.head.length < 1) return { x: sx, y: sy };
  // A rigid head keeps facial texture coherent while the neck blends into the shoulders.
  const h = rigidPoint(x, y, s.head, t.head, false);
  h.x += t.head.b.x - (t.head.a.x + t.head.ux * s.head.length);
  h.y += t.head.b.y - (t.head.a.y + t.head.uy * s.head.length);
  const a = clamp((0.015 - v) / 0.21, 0, 1),
    ease = a * a * (3 - 2 * a);
  return { x: sx * (1 - ease) + h.x * ease, y: sy * (1 - ease) + h.y * ease };
}
function warpVertex(x, y, group, s, t) {
  if (group === 'body') return bodyPoint(x, y, s, t);
  let total = 0,
    xSum = 0,
    ySum = 0;
  const chain = s.chains[group],
    posed = t.chains[group];
  for (let i = 0; i < chain.length; i++) {
    const bone = chain[i];
    const trim = Math.min(bone.length * 0.24, bone.radius * 0.65);
    const d2 = segmentDistanceSq(x, y, bone, trim);
    const weight = 1 / (d2 + (bone.radius * 0.42) ** 2) ** 3;
    const p = rigidPoint(x, y, bone, posed[i]);
    xSum += p.x * weight;
    ySum += p.y * weight;
    total += weight;
  }
  return { x: xSum / total, y: ySum / total };
}

// The skin is partitioned before deformation, so an arm can pass in front of
// the torso without drawing a triangle of stretched shirt between them.
function bind(cutout, source) {
  const width = cutout.width,
    height = cutout.height;
  const rgba = cutout.getContext('2d').getImageData(0, 0, width, height).data;
  const labels = new Uint8Array(width * height);
  const body = anatomy(source),
    cell = Math.max(4, Math.ceil(Math.max(width, height) / 82));
  const cols = Math.ceil(width / cell),
    rows = Math.ceil(height / cell);
  const usage = new Uint8Array(cols * rows);
  const fill = new Int32Array(width * height);
  const queue = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!rgba[idx * 4 + 3]) continue;
      const k = closestLayer(x + 0.5, y + 0.5, body);
      labels[idx] = k;
      const v = torsoFraction(x + 0.5, y + 0.5, body);
      const radius = 0.49 * (body.width * (1 - clamp(v, 0, 1)) + body.hipWidth * clamp(v, 0, 1));
      const inTorso =
        v > -0.035 && v < 1.09 && segmentDistanceSq(x + 0.5, y + 0.5, body.spine) < radius * radius;
      if (inTorso) {
        if (k === 0) {
          fill[idx] = idx + 1;
          queue.push(idx);
        } else fill[idx] = -1;
      }
      // Bilinear reconstruction can sample across a cell boundary.
      const x0 = Math.floor(Math.max(0, x - 1) / cell),
        x1 = Math.floor(Math.min(width - 1, x + 1) / cell);
      const y0 = Math.floor(Math.max(0, y - 1) / cell),
        y1 = Math.floor(Math.min(height - 1, y + 1) / cell);
      for (let cy = y0; cy <= y1; cy++)
        for (let cx = x0; cx <= x1; cx++) usage[cy * cols + cx] |= (1 << k) | (inTorso ? 1 : 0);
    }
  // Where a bent arm was photographed across the shirt, carry nearby clothing
  // into the covered torso core. Moving the arm can now reveal an intact torso.
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    for (const d of [-width, width, -1, 1]) {
      const n = p + d;
      if (fill[n] === -1 && (Math.abs(d) !== 1 || Math.floor(p / width) === Math.floor(n / width))) {
        fill[n] = fill[p];
        queue.push(n);
      }
    }
  }
  const cells = GROUPS.map(() => []);
  for (let i = 0; i < usage.length; i++)
    for (let k = 0; k < GROUPS.length; k++) if (usage[i] & (1 << k)) cells[k].push(i);
  return { rgba, labels, fill, cells, cols, cell, body, width, height };
}

// Inverse-map each deformed triangle, bilinearly filtering premultiplied
// source color and alpha so transparent borders do not acquire dark fringes.
function rasterTriangle(surface, dst, layer, a, b, c) {
  const { width: w, height: h, rgba, labels, fill } = surface;
  const bx = b.x - a.x,
    by = b.y - a.y,
    cx = c.x - a.x,
    cy = c.y - a.y;
  const det = bx * cy - by * cx;
  if (Math.abs(det) < 1e-6) return;
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))),
    x1 = Math.min(w, Math.ceil(Math.max(a.x, b.x, c.x)));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))),
    y1 = Math.min(h, Math.ceil(Math.max(a.y, b.y, c.y)));
  const ux = cy / det,
    uy = -cx / det,
    vx = -by / det,
    vy = bx / det;
  for (let y = y0; y < y1; y++) {
    let u = (x0 + 0.5 - a.x) * ux + (y + 0.5 - a.y) * uy,
      v = (x0 + 0.5 - a.x) * vx + (y + 0.5 - a.y) * vy;
    for (let x = x0; x < x1; x++, u += ux, v += vx) {
      if (u < 0 || v < 0 || u + v > 1) continue;
      const sx = a.sx + u * (b.sx - a.sx) + v * (c.sx - a.sx) - 0.5,
        sy = a.sy + u * (b.sy - a.sy) + v * (c.sy - a.sy) - 0.5;
      const ix = Math.floor(sx),
        iy = Math.floor(sy),
        fx = sx - ix,
        fy = sy - iy;
      let alpha = 0,
        r = 0,
        g = 0,
        blue = 0;
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const xx = ix + dx,
            yy = iy + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const p = yy * w + xx;
          const texel = labels[p] === layer ? p : layer === 0 ? fill[p] - 1 : -1;
          if (texel < 0) continue;
          const q = texel * 4,
            weight = ((dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * rgba[p * 4 + 3]) / 255;
          alpha += weight;
          r += rgba[q] * weight;
          g += rgba[q + 1] * weight;
          blue += rgba[q + 2] * weight;
        }
      if (alpha < 0.001) continue;
      const i = (y * w + x) * 4,
        under = ((1 - alpha) * dst[i + 3]) / 255,
        out = alpha + under;
      dst[i] = (r + dst[i] * under) / out;
      dst[i + 1] = (g + dst[i + 1] * under) / out;
      dst[i + 2] = (blue + dst[i + 2] * under) / out;
      dst[i + 3] = out * 255;
    }
  }
}

const boundRigs = new WeakMap();
export function renderPose(cutoutCanvas, rig) {
  const sKey = JSON.stringify(rig.source),
    tKey = JSON.stringify(rig.target);
  if (Object.keys(rig.source).every((k) => dist(rig.source[k], rig.target[k]) < 1e-5)) return cutoutCanvas;
  let cache = boundRigs.get(rig);
  if (!cache || cache.input !== cutoutCanvas || cache.sourceKey !== sKey) {
    cache = {
      input: cutoutCanvas,
      sourceKey: sKey,
      surface: bind(cutoutCanvas, rig.source),
      output: canvas(cutoutCanvas.width, cutoutCanvas.height)
    };
    boundRigs.set(rig, cache);
  }
  if (cache.targetKey === tKey) return cache.output;
  const { surface, output } = cache,
    { width, height, cell, cols, cells, body } = surface;
  const posed = anatomy(rig.target),
    ctx = output.getContext('2d');
  const image = ctx.createImageData(width, height);
  // Positive MediaPipe z is farther from the camera. Ties bring arms in front of the shirt.
  const depth = (group) => {
    if (group === 'body') return (posed.chest.z + posed.hip.z) / 2;
    const names = CHAINS[group],
      a = rig.target[names[1]],
      b = rig.target[names[2]];
    return ((a.z || 0) + (b.z || 0)) / 2 + (group.endsWith('Leg') ? 0.04 : -0.04) * body.width;
  };
  const order = GROUPS.map((_, k) => k).sort((a, b) => depth(GROUPS[b]) - depth(GROUPS[a]));
  for (const k of order) {
    const vertices = new Map();
    function vertex(cx, cy) {
      const idx = cy * (cols + 1) + cx;
      if (!vertices.has(idx)) {
        const sx = Math.min(width, cx * cell),
          sy = Math.min(height, cy * cell);
        vertices.set(idx, { ...warpVertex(sx, sy, GROUPS[k], body, posed), sx, sy });
      }
      return vertices.get(idx);
    }
    for (const cellIndex of cells[k]) {
      const cx = cellIndex % cols,
        cy = Math.floor(cellIndex / cols);
      const a = vertex(cx, cy),
        b = vertex(cx + 1, cy),
        c = vertex(cx + 1, cy + 1),
        d = vertex(cx, cy + 1);
      rasterTriangle(surface, image.data, k, a, b, c);
      rasterTriangle(surface, image.data, k, a, c, d);
    }
  }
  ctx.putImageData(image, 0, 0);
  cache.targetKey = tKey;
  return output;
}
