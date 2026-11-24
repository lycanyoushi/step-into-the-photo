const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const normalizeSide = (word) => (word === 'middle' || word === 'centre' ? 'center' : word);
const invalid = (error) => ({ relation: 'unsupported', query: '', qualifier: null, error });

// Opening on an empty room often yields an entering hand before the face or
// torso. Wait briefly for that wider view. A persistent small or edge-cut
// visitor gets a conservative fit, with one correction if their body follows.
export class InitialCameraFit {
  firstPartial = null;
  provisional = null;
  done = false;

  next(visible, width, height, now) {
    if (this.done || !visible) return null;
    const w = visible.width / width,
      h = visible.height / height;
    if (w < 0.035 || h < 0.12) return null;
    const touchesSide = visible.x < 0.035 * width || visible.x + visible.width > 0.965 * width;
    const partial = w < 0.085 || (h < 0.33 && w < 0.34) || (touchesSide && w < 0.33);
    const earlier = this.provisional;
    const muchFuller =
      earlier && w > 0.22 && h > 0.45 && w * h > 2.2 * earlier.area && h > 1.3 * earlier.height;
    if (!partial || muchFuller) {
      this.done = true;
      return 'final';
    }
    this.firstPartial ??= now;
    if (earlier || now - this.firstPartial < 750) return null;
    this.provisional = { area: w * h, height: h };
    return 'provisional';
  }
}

export function parsePlacementPrompt(text = '') {
  let phrase = text
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ');
  phrase = phrase
    .replace(/^(?:(?:can|could|would) you |i(?:'d like| want) (?:to be |you to )?)/, '')
    .replace(/^please\s+/, '')
    .replace(
      /^(?:place|put|position|insert|add|move|stand)(?:\s+(?:me|us|myself|the visitor|the new person|the live person|the person|someone))?\s+/,
      ''
    )
    .replace(/^(?:just |directly |slightly )/, '')
    .replace(/,? please$/, '')
    .trim();
  if (
    !phrase ||
    /^(?:auto(?:matic(?:ally)?)?|(?:somewhere |a )?(?:natural|realistic)(?:ly| spot| place)?|anywhere)$/.test(
      phrase
    )
  )
    return { relation: 'auto', query: '', qualifier: null };

  // Resolve an image position before looking for a subject-relative relation.
  const absolute = phrase.match(
    /^(?:(?:on|in|at|towards?|to) )?(?:the )?(?:far )?(left|right|center|centre|middle)(?: side| edge)?(?: of (?:the |this )?(?:photo(?:graph)?|picture|image|frame|scene))?$/
  );
  if (absolute) return { relation: 'position', query: '', qualifier: normalizeSide(absolute[1]) };
  const relations = [
    ['behind', /^(?:behind|in back of)\b/],
    ['front', /^in front of\b/],
    ['left', /^(?:(?:to|on) )?(?:the )?left of\b/],
    ['right', /^(?:(?:to|on) )?(?:the )?right of\b/],
    ['beside', /^(?:beside|next to|alongside)\b/]
  ];
  const entry = relations.find(([, pattern]) => pattern.test(phrase));
  if (!entry) return invalid('Try a position such as “on the left” or a subject such as “behind the woman”.');
  let query = phrase
    .replace(entry[1], '')
    .trim()
    .replace(/^(?:the|an?|that|this)\s+/, '');
  if (
    /\b(?:and|but|or|then)\s+(?:(?:directly|just)\s+)?(?:behind|in front of|next to|beside|(?:to the )?(?:left|right) of)\b/.test(
      query
    )
  )
    return invalid('Choose one placement relation at a time.');
  let qualifier = null;
  const suffix = query.match(
    /\s+(?:on|at|in) (?:the )?(?:far )?(left|right|center|centre|middle)(?: side)?(?: of (?:the )?(?:photo(?:graph)?|picture|image|frame|scene))?$/
  );
  const prefix = query.match(/^(leftmost|rightmost|left-most|right-most|middle|cent(?:er|re))\s+/);
  if (suffix || prefix) {
    qualifier = normalizeSide(suffix ? suffix[1] : prefix[1].replace(/-?most$/, ''));
    query = (suffix ? query.slice(0, suffix.index) : query.slice(prefix[0].length)).trim();
  }
  if (!query || /^(?:her|him|them|it|someone|the|a|an)$/.test(query))
    return invalid('Name the person or object to use, for example “the woman on the left”.');
  return { relation: entry[0], query, qualifier };
}

function validBox({ box } = {}) {
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every(Number.isFinite) &&
    box[0] >= 0 &&
    box[1] >= 0 &&
    box[2] <= 1 &&
    box[3] <= 1 &&
    box[2] > box[0] &&
    box[3] > box[1]
  );
}
const center = (box) => (box[0] + box[2]) / 2;
const area = (box) => (box[2] - box[0]) * (box[3] - box[1]);
function intersection(a, b) {
  return (
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  );
}
function sameSubject(a, b) {
  const common = intersection(a, b);
  return common > 0.65 * (area(a) + area(b) - common);
}

export function selectPlacementTarget(targets, intent) {
  const candidates = [];
  const ranked = targets.filter(validBox).sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const hit of ranked) {
    if (!candidates.some((existing) => sameSubject(hit.box, existing.box))) candidates.push(hit);
  }
  if (!candidates.length) return { target: null, candidates, reason: 'missing' };
  if (candidates.length === 1) return { target: candidates[0], candidates, reason: 'selected' };
  if (intent.qualifier) {
    const side = { left: 0, center: 0.5, right: 1 }[intent.qualifier];
    const distance = (hit) => Math.abs(center(hit.box) - side);
    // "The person on the right" means one of the people the photograph is
    // of, not a spectator in the distance who happens to sit nearer the edge.
    const tallest = Math.max(...candidates.map((hit) => hit.box[3] - hit.box[1]));
    const subjects = candidates.filter((hit) => hit.box[3] - hit.box[1] >= 0.45 * tallest);
    subjects.sort((a, b) => distance(a) - distance(b));
    if (subjects.length === 1 || distance(subjects[1]) - distance(subjects[0]) > 0.025)
      return { target: subjects[0], candidates, reason: 'selected' };
  } else {
    // Text grounding can return a weaker match for a nearby person or a
    // similar item. Resolve only a clear lead on a specific description.
    const first = candidates[0].score,
      second = candidates[1].score;
    if (
      !/^(?:person|people|individual|subject)$/.test(intent.query) &&
      first >= 0.65 &&
      first - second >= 0.18 &&
      second <= first * 0.78
    )
      return { target: candidates[0], candidates, reason: 'selected' };
  }
  return { target: null, candidates, reason: 'ambiguous' };
}

// Proportions of a standing adult, in units of their own height.
const FACE = 0.1; // brow to chin, as the face detector boxes it
const FACE_CENTRE = 0.91; // face centre above the soles

// Scene content this many 8-bit depth levels nearer than the visitor covers
// them. The renderer and the planner must agree exactly, or a visitor planned
// as visible is drawn hidden.
export const OCCLUDING_LEVELS = 8;
const nearer = (scene, visitor) => Math.round(scene * 255) - Math.round(visitor * 255) >= OCCLUDING_LEVELS;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : null;
};

// What one photograph says about how large, and where, a person appears at a
// given depth. Depth is the relative inverse depth of the local model, 1 near.
// People already in the picture calibrate it: a face is about the same size on
// everyone, whether they stand, sit or are half hidden.
export class SceneGeometry {
  constructor({ depth = null, people = [], aspect = 1.5, frame = null } = {}) {
    this.depth = depth;
    this.aspect = aspect;
    // The picture area, when a scan includes its mount or film edge.
    this.frame = frame || [0, 0, 1, 1];
    const real = people.filter(validBox);
    this.people = real
      .filter((person) => !real.some((other) => other !== person && mirrors(person, other)))
      .map((person) => {
        const d = this.depthOf(person.box, person.face);
        return { ...person, depth: d, grounded: this.touchesGround(person.box, d) };
      });
    this.fitScale();
    this.ground = this.fitGround();
  }

  sample(x, y) {
    if (!this.depth) return null;
    const value = this.depth(clamp(x, 0, 1), clamp(y, 0, 1));
    return Number.isFinite(value) ? value : null;
  }

  // A robust depth for a subject: the middle of its box, away from the
  // background visible around the head and between the limbs.
  depthOf(box, face = null) {
    if (!this.depth) return 0.5;
    const [l, t, r, b] = box,
      values = [];
    for (const u of [0.38, 0.5, 0.62])
      for (const v of [0.22, 0.34, 0.46, 0.58, 0.7]) {
        const d = this.sample(l + u * (r - l), t + v * (b - t));
        if (d !== null) values.push(d);
      }
    if (face) {
      const d = this.sample(face.x, face.y);
      if (d !== null) values.push(d, d);
    }
    return median(values) ?? 0.5;
  }

  // The base of the box rests on visible ground when the surface just below
  // it continues at about the subject's own depth.
  touchesGround(box, depth) {
    if (box[3] > 0.965) return false;
    if (!this.depth) return true;
    const below = [0.35, 0.5, 0.65]
      .map((u) => this.sample(box[0] + u * (box[2] - box[0]), box[3] + 0.02))
      .filter((d) => d !== null);
    return below.length > 0 && Math.abs(median(below) - depth) < 0.11;
  }

  fitScale() {
    const samples = [];
    for (const { box, face, depth } of this.people) {
      const tall = (box[3] - box[1]) / (box[2] - box[0]) / this.aspect;
      if (face && face.height > 0.012 && face.height < 0.6) samples.push([depth, face.height, 2]);
      // An upright, uncropped figure also reveals the scale without a face.
      else if (tall > 2.1 && box[3] < 0.97 && box[1] > 0.02) samples.push([depth, FACE * (box[3] - box[1]), 1]);
    }
    // Relative depth has an unknown offset: the farthest thing in the picture
    // is rarely at infinity. People at clearly different depths reveal it.
    const line = (points) => {
      let sw = 0,
        sd = 0,
        sf = 0,
        sdd = 0,
        sdf = 0;
      for (const [d, f, w] of points) {
        sw += w;
        sd += w * d;
        sf += w * f;
        sdd += w * d * d;
        sdf += w * d * f;
      }
      const k = (sw * sdf - sd * sf) / (sw * sdd - sd * sd);
      return { k, c: (sf - k * sd) / sw / k };
    };
    const spread = (points) => {
      const depths = points.map((p) => p[0]);
      return Math.max(...depths) - Math.min(...depths);
    };
    let offset = 0.3,
      slope = null;
    if (samples.length >= 3 && spread(samples) > 0.2) {
      let fit = line(samples);
      // Children and partly hidden figures read smaller than an adult at the
      // same depth. Fit the adults.
      const adults = samples.filter(([d, f]) => f > 0.62 * fit.k * (d + fit.c));
      if (adults.length >= 3 && adults.length < samples.length && spread(adults) > 0.2) fit = line(adults);
      if (fit.k > 0 && fit.c > -0.08 && fit.c < 1.1) {
        slope = fit.k;
        offset = Math.max(0.02, fit.c);
      }
    }
    if (slope === null) {
      const ratios = samples.map(([d, f]) => f / (d + offset)).sort((a, b) => b - a);
      // The larger readings are the adults. With nobody to measure, assume an
      // ordinary snapshot: a person in the middle distance stands a little
      // over half the frame tall.
      slope = ratios.length ? ratios[Math.floor((ratios.length - 1) / 4)] : (0.6 * FACE) / (0.55 + offset);
    }
    this.slope = slope;
    this.offset = offset;
    this.largestFace = Math.max(0, ...samples.map((s) => s[1]));
    // Adults whose measured size the model should reproduce exactly nearby.
    this.anchors = samples.filter(([d, f]) => f > 0.65 * slope * (d + offset));
  }

  // One row of people farther from, or nearer to, the camera.
  step(depth) {
    return 0.085 * (depth + this.offset);
  }

  // Expected face height at a depth. The fitted line carries the perspective;
  // the nearest measured adults set its level, so a visitor beside someone
  // matches that person rather than the average of the photograph.
  faceAt(depth) {
    let total = 0,
      weight = 0;
    for (const [d, f] of this.anchors) {
      const w = 1 / (Math.abs(depth - d) + 0.03) ** 2;
      total += (w * f * (depth + this.offset)) / (d + this.offset);
      weight += w;
    }
    const size = weight ? total / weight : this.slope * (depth + this.offset);
    return clamp(size, 0.01, 0.5);
  }

  bodyAt(depth) {
    return this.faceAt(depth) / FACE;
  }

  // Where a standing adult's face would be at this depth. People standing on
  // level ground share an eye line when the camera is near eye height, so the
  // highest face at a similar depth is the best local evidence.
  eyeRow(depth) {
    let level = null,
      nearest = null,
      gap = Infinity;
    for (const person of this.people) {
      if (!person.face) continue;
      const distance = Math.abs(person.depth - depth);
      if (distance < 0.13) level = level === null ? person.face.y : Math.min(level, person.face.y);
      if (distance < gap) {
        gap = distance;
        nearest = person.face.y;
      }
    }
    if (level !== null) return level;
    if (nearest !== null) return nearest;
    const tops = this.people.map((p) => p.box[1] + 0.1 * (p.box[3] - p.box[1]));
    return tops.length ? Math.min(...tops) : 0.4;
  }

  // Level ground seen in perspective comes steadily nearer toward the bottom
  // of the picture: relative depth is a straight line in the image row. Fit
  // that line to the receding surfaces, and reject it when it turns out to be
  // a table or counter that people are standing behind.
  fitGround() {
    if (!this.depth) return null;
    const points = [];
    const inPerson = (x, y) =>
      this.people.some(({ box }) => x > box[0] && x < box[2] && y > box[1] && y < box[3] - 0.03 * (box[3] - box[1]));
    const [fl, ft, fr, fb] = this.frame;
    for (let i = 0; i < 40; i++) {
      const x = fl + ((i + 0.5) / 40) * (fr - fl);
      for (let y = Math.max(0.28, ft + 0.02); y < fb - 0.015; y += 0.012) {
        if (inPerson(x, y)) continue;
        const up = this.sample(x, y - 0.02),
          here = this.sample(x, y),
          down = this.sample(x, y + 0.02);
        const left = this.sample(x - 0.02, y),
          right = this.sample(x + 0.02, y);
        if ([up, here, down, left, right].includes(null)) continue;
        // Receding, smooth along the row, and without a step or plateau.
        if (down - up < 0.012 || Math.abs(down - 2 * here + up) > 0.012 || Math.abs(right - left) > 0.035) continue;
        points.push([y, here]);
      }
    }
    if (points.length < 60) return null;
    let best = null;
    for (let trial = 0; trial < 160; trial++) {
      // A fixed stride visits pairs reproducibly; no random seed is needed.
      const p = points[(trial * 7919) % points.length],
        q = points[(trial * 104729 + 13) % points.length];
      if (Math.abs(p[0] - q[0]) < 0.08) continue;
      const a = (p[1] - q[1]) / (p[0] - q[0]);
      if (a < 0.2 || a > 8) continue;
      const b = p[1] - a * p[0];
      let support = 0;
      for (const [y, d] of points) if (Math.abs(a * y + b - d) < 0.03) support++;
      if (!best || support > best.support) best = { a, b, support };
    }
    if (!best || best.support < Math.max(40, 0.3 * points.length)) return null;
    let sy = 0,
      sd = 0,
      syy = 0,
      syd = 0,
      n = 0;
    for (const [y, d] of points) {
      if (Math.abs(best.a * y + best.b - d) >= 0.03) continue;
      n++;
      sy += y;
      sd += d;
      syy += y * y;
      syd += y * d;
    }
    const a = (n * syd - sy * sd) / (n * syy - sy * sy),
      b = (sd - a * sy) / n;
    if (!(a > 0.2)) return null;
    // People whose bodies continue, upright, below the row where this
    // surface would meet them are standing behind it, not on it.
    // Likewise people whose outlines stop short of it because seats or a
    // railing hide their legs: the surface found is the seating, not their
    // floor. Only the people the photograph is about are asked.
    let behindIt = 0,
      onIt = 0;
    const tallest = Math.max(0, ...this.people.map((p) => p.box[3] - p.box[1]));
    for (const person of this.people) {
      const { box, depth } = person;
      if (box[3] - box[1] < 0.4 * tallest) continue;
      const row = (depth - b) / a;
      const gap = box[3] - row;
      if (gap < -0.02 && box[3] < 0.965 && this.cutOffBelow(person)) {
        behindIt++;
        continue;
      }
      if (gap < 0.08) {
        onIt++;
        continue;
      }
      let upright = 0,
        count = 0;
      for (const u of [0.35, 0.5, 0.65])
        for (const v of [0.12, 0.24, 0.36, 0.48]) {
          const d = this.sample(box[0] + u * (box[2] - box[0]), row + v * gap);
          if (d === null) continue;
          count++;
          if (Math.abs(d - depth) < 0.05) upright++;
        }
      if (count && upright >= 0.4 * count) behindIt++;
      else onIt++;
    }
    if (behindIt && behindIt >= onIt) return null;
    return { slope: a, intercept: b };
  }

  // The row where something standing at this depth meets the ground, and
  // whether that spot can be seen in column x or lies behind a nearer object.
  groundRow(x, depth) {
    if (!this.ground) {
      // No visible floor: stand as tall as the people who are standing here.
      return { y: this.eyeRow(depth) + FACE_CENTRE * this.bodyAt(depth), visible: false, hidden: true };
    }
    const y = (depth - this.ground.intercept) / this.ground.slope;
    if (y >= this.frame[3] - 0.005) return { y, visible: false, below: true };
    const there = this.sample(x, y);
    if (there === null) return { y, visible: false };
    if (there > depth + 0.05) return { y, visible: false, hidden: true };
    return { y, visible: Math.abs(there - depth) <= 0.05 };
  }

  // Whether something nearer cuts this figure off below: seats, a pram, a
  // counter. Down the middle of the box, a seated or standing person meets the
  // ground gradually, while an object in front is a sudden step toward the camera.
  cutOffBelow(person) {
    if (!this.depth) return false;
    const [l, t, r, b] = person.box;
    const expected = this.ground ? this.ground.slope * 0.03 : 0.03;
    let steps = 0;
    for (const u of [0.35, 0.5, 0.65]) {
      const x = l + u * (r - l);
      let previous = this.sample(x, t + 0.5 * (b - t));
      for (let y = t + 0.5 * (b - t) + 0.03; y <= Math.min(0.995, b + 0.04); y += 0.03) {
        const here = this.sample(x, y);
        if (previous !== null && here !== null && here - previous > expected + 0.06) {
          steps++;
          break;
        }
        previous = here;
      }
    }
    return steps >= 2;
  }

  // Where someone standing at this depth belongs. The fitted ground answers
  // when the people nearby visibly rest on it. When something in front hides
  // their legs, the fitted surface may not be their floor at all, and the
  // dependable cue is the one a group photograph shows: standing people at one
  // depth have their eyes at one level. `eye` is then the row for the face.
  standRow(x, depth, beside = null) {
    const ground = this.groundRow(x, depth);
    if (!this.ground) {
      // No floor to stand on in view: share the eye line of whoever is there.
      const eye = beside?.face ? beside.face.y : this.people.some((p) => p.face) ? this.eyeRow(depth) : null;
      return eye === null ? ground : { ...ground, eye };
    }
    let reference = beside?.face ? beside : null;
    if (!reference) {
      let gap = 0.13;
      for (const person of this.people) {
        if (!person.face || Math.abs(person.depth - depth) >= gap) continue;
        gap = Math.abs(person.depth - depth);
        reference = person;
      }
    }
    // Floor that can be seen at this depth right where the visitor would
    // stand outranks the eye line.
    if (!reference || ground.visible) return ground;
    // Someone sitting on the ground behind a basket is also cut off below,
    // but their outline reaches down to the ground and is short for its face.
    const own = reference.depth ?? this.depthOf(reference.box, reference.face);
    const reach = (reference.box[3] - reference.face.y) / reference.face.height;
    const aboveGround = this.ground && reference.box[3] < this.groundRow(x, own).y - 0.02;
    if (!this.cutOffBelow(reference) || !(aboveGround || !this.ground || reach >= 5.6)) return ground;
    return { y: ground.y, eye: reference.face.y, visible: false, hidden: true };
  }

  // Something standing in front, as opposed to the ground itself coming
  // nearer toward the bottom of the picture. Only the former can hide the
  // cropped edge of a waist-up visitor; the latter would bury them.
  occludes(x, y, depth) {
    const there = this.sample(x, y);
    if (there === null || !Number.isFinite(depth) || !nearer(there, depth)) return false;
    if (!this.ground) return true;
    return there > this.ground.slope * y + this.ground.intercept + 0.05;
  }
}

// Wet sand, water and polished floors return an inverted figure directly
// beneath a person. It is not somebody to stand beside.
function mirrors(lower, upper) {
  const a = lower.box,
    b = upper.box;
  const width = b[2] - b[0];
  return (
    !lower.face &&
    Math.abs(a[1] - b[3]) < 0.035 &&
    Math.abs(center(a) - center(b)) < 0.3 * width &&
    a[2] - a[0] < 1.5 * width &&
    a[2] - a[0] > 0.5 * width
  );
}

function faceBox(person, aspect) {
  const [l, t, r, b] = person.box;
  if (person.face) {
    const ry = person.face.height * 0.62,
      rx = ry / aspect;
    return [person.face.x - rx, person.face.y - ry, person.face.x + rx, person.face.y + ry];
  }
  const w = r - l,
    h = b - t;
  return [l + 0.22 * w, t, r - 0.22 * w, t + 0.29 * h];
}

// Describe one candidate as the camera would see it: how much of the visitor
// remains visible, whether their face is clear, whether a cropped camera edge
// is covered, and how much of anyone else's face they would cover.
function inspect(geometry, visitor, { x, y, height, depth }, front, target) {
  const span = height / geometry.aspect;
  const [fl, ft, fr, fb] = geometry.frame;
  let marginal = 0;
  let visible = 0,
    faceTotal = 0,
    faceVisible = 0,
    sideCut = 0,
    overTarget = 0,
    blocking = 0,
    behindTarget = 0;
  for (const [dx, dy, onFace] of visitor.body) {
    const px = x + dx * span,
      py = y + dy * height;
    if (onFace) faceTotal++;
    if (px < fl || px > fr || py < ft) {
      sideCut++;
      continue;
    }
    if (py > fb) continue;
    if (front && front(px, py) > 0.5) {
      behindTarget++;
      continue;
    }
    const d = geometry.sample(px, py);
    // Scenery at almost the visitor's own depth could land on either side of
    // them. A spot where much of the body is in doubt is a poor one.
    if (d !== null && Number.isFinite(depth) && d > depth + 0.012 && d < depth + 0.05) marginal++;
    if (d !== null && Number.isFinite(depth) && nearer(d, depth)) {
      // Without an outline, the subject's box stands in for their silhouette.
      if (target && !front && px > target.box[0] && px < target.box[2] && py > target.box[1] && py < target.box[3])
        behindTarget++;
      continue;
    }
    visible++;
    if (onFace) faceVisible++;
    if (target && px > target.box[0] && px < target.box[2] && py > target.box[1] && py < target.box[3])
      overTarget++;
    else if (geometry.people.some(({ box: b }) => px > b[0] && px < b[2] && py > b[1] && py < b[3])) blocking++;
  }
  const count = visitor.body.length || 1;
  let seam = 1;
  if (visitor.cropped && visitor.seam.length) {
    let hidden = 0;
    for (const dx of visitor.seam) {
      const px = x + dx * span;
      let covered = y >= fb - 0.001 || px < fl || px > fr;
      // Sample just above the edge, where a visible seam would actually show.
      for (const lift of [0.004, 0.02]) {
        if (covered) break;
        const py = y - lift * height;
        covered = (front && front(px, py) > 0.5) || geometry.occludes(px, py, depth);
        if (!covered) break;
      }
      if (covered) hidden++;
    }
    seam = hidden / visitor.seam.length;
  }
  // Faces of photographed people that the visitor would stand in front of.
  let covering = 0,
    crowding = 0;
  for (const person of geometry.people) {
    if (target && sameSubject(person.box, target.box) && front) continue;
    const body = [x - (visitor.aspect * span) / 2, y - height, x + (visitor.aspect * span) / 2, y];
    // Two people at the same depth cannot share a place.
    if (!Number.isFinite(depth) || Math.abs(person.depth - depth) < 1.6 * geometry.step(depth))
      crowding += intersection(body, person.box) / Math.min(area(person.box), area(body));
    if (Number.isFinite(depth) && nearer(person.depth, depth)) continue;
    const [l, t, r, b] = faceBox(person, geometry.aspect);
    let hits = 0;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        const fx = l + ((i + 0.5) / 4) * (r - l),
          fy = t + ((j + 0.5) / 4) * (b - t);
        if (visitor.contains(((fx - x) * geometry.aspect) / height, (fy - y) / height)) hits++;
      }
    covering = Math.max(covering, hits / 16);
  }
  return {
    visible: visible / count,
    face: faceTotal ? faceVisible / faceTotal : visible / count,
    sideCut: sideCut / count,
    behindTarget: behindTarget / count,
    overTarget: overTarget / count,
    blocking: blocking / count,
    marginal: marginal / count,
    seam,
    covering,
    crowding
  };
}

// Choose where the visitor goes. Every candidate is a physical proposal:
// a depth, the size a person has at that depth, and a row that is either real
// ground contact or hidden from view. The requested relation ranks them.
export function planPlacement({ geometry, intent, visitor, target = null, front = null, trace = null }) {
  const aspect = geometry.aspect,
    frame = geometry.frame;
  // A face sets the scale. On a full-length figure it stays within the range
  // of real poses, so a helmet or a false detection cannot shrink the visitor.
  const upright = !visitor.cropped && visitor.aspect < 0.5;
  const faceFraction = visitor.cropped
    ? clamp(visitor.faceFraction || 0.27, 0.12, 0.7)
    : upright
      ? clamp(visitor.faceFraction || FACE, 0.085, 0.115)
      : clamp(visitor.faceFraction || FACE, 0.085, 0.16);
  const faceUp = visitor.faceUp ?? (visitor.cropped ? 0.62 : FACE_CENTRE);
  // With the visitor's standing height known from their limbs, they are as
  // tall as an adult at that depth, times however much of that their pose shows.
  const heightAt = (depth) =>
    clamp(
      !visitor.cropped && visitor.stature
        ? geometry.bodyAt(depth) * visitor.stature
        : geometry.faceAt(depth) / faceFraction,
      0.04,
      1.6
    );
  const widthOf = (height) => (visitor.aspect * height) / aspect;
  const candidates = [];
  const propose = (x, y, depth, cost, extra = {}) => {
    const height = extra.height ?? heightAt(depth);
    const half = widthOf(height) / 2;
    // Keep most of the visitor inside the frame. A close foreground figure
    // may be cut by the side of the picture as well as by its bottom edge.
    const inset = extra.mode === 'foreground' ? 0.3 : 0.6;
    const cx = clamp(x, frame[0] + 0.02 + inset * half, frame[2] - 0.02 - inset * half);
    // Nobody is visible below the ground they stand on. A waist-up visitor
    // whose cropped edge lies under the ground row for their depth would be
    // buried, whatever seems to cover that edge.
    if (visitor.cropped && extra.mode !== 'foreground' && geometry.ground) {
      // Seated on the ground, the waist is about at the ground row; allow
      // for the tolerance of the fitted ground as well.
      if (y > geometry.groundRow(cx, depth).y + 0.035) return;
    }
    candidates.push({ x: cx, y, depth, height, cost: cost + 6 * Math.abs(cx - x), ...extra });
  };
  // Rows a waist-up visitor can occupy: a standing eye line, then lower, as if
  // crouching or seated, until a nearer object can cover the camera edge.
  const bustRows = (depth, height, preferred = null) => {
    const standing = geometry.eyeRow(depth);
    const body = geometry.bodyAt(depth);
    const rows = [];
    for (const drop of [0, 0.07, 0.14, 0.22, 0.3, 0.38, 0.46]) {
      const faceRow = standing + drop * body;
      const off = preferred === null ? drop : Math.abs(faceRow - preferred) / body;
      rows.push({ y: faceRow + faceUp * height, cost: 2.2 * off });
    }
    if (preferred !== null) {
      for (const shift of [-0.06, 0, 0.06])
        rows.push({ y: preferred + shift * body + faceUp * height, cost: 2.2 * Math.abs(shift) });
    }
    return rows;
  };
  // A waist-up visitor in the near foreground, cropped by the photograph's
  // own bottom edge exactly as the camera cropped them.
  const foreground = (x, cost) => {
    const edge = geometry.sample(x, frame[3] - 0.012) ?? 0.9;
    const depth = clamp(Math.max(edge + 0.06, 0.92), 0, 1.08);
    const height = clamp(heightAt(depth), 0.22, 0.74);
    // Someone this close is acceptable while they do not dwarf the people
    // the photograph is about.
    const dominance = geometry.largestFace ? (height * faceFraction) / geometry.largestFace : 1;
    propose(x, frame[3] + 0.004, 1, cost + 5 * Math.max(0, dominance - 1.35), { height, mode: 'foreground' });
  };

  const relation = intent.relation;
  if (target && validBox(target)) {
    const box = target.box,
      cx = center(box),
      bw = box[2] - box[0];
    const targetDepth = geometry.depthOf(box, target.face);
    const behind = relation === 'behind',
      inFront = relation === 'front';
    const row = geometry.step(targetDepth);
    const depths = behind
      ? [targetDepth - row, targetDepth - 1.8 * row]
      : inFront
        ? [targetDepth + 2 * row, targetDepth + 3 * row]
        : visitor.cropped
          ? [targetDepth, targetDepth - 0.6 * row, targetDepth - 1.3 * row]
          : [targetDepth, targetDepth - 0.6 * row];
    const sides = relation === 'left' ? [-1] : relation === 'right' ? [1] : [-1, 1];
    depths.forEach((raw, rank) => {
      const depth = clamp(raw, 0.01, 1);
      const height = heightAt(depth),
        w = widthOf(height);
      const reach = 0.5 * (bw + w);
      const offsets =
        behind || inFront
          ? [0.25, 0.4, 0.55, 0.7, 0.85, 1.0].map((f) => f * reach)
          : visitor.cropped
            ? [1.02, 0.88, 1.16, 0.74, 1.32, 0.6, 1.5].map((f) => f * reach)
            : [0.92 * reach, reach + 0.012, 0.84 * reach, reach + 0.045, reach + 0.09];
      for (const side of sides) {
        offsets.forEach((offset, step) => {
          const x = cx + side * offset;
          const base = 1.4 * rank + 0.45 * step;
          if (visitor.cropped) {
            const level = target.face?.y ?? null;
            const preferred = level === null ? null : behind ? level - 0.5 * (target.face.height || 0) : level;
            for (const row of bustRows(depth, height, preferred)) propose(x, row.y, depth, base + row.cost);
          } else {
            const ground = geometry.standRow(x, depth, target);
            const y = ground.eye === undefined ? ground.y : ground.eye + faceUp * height;
            propose(x, y, depth, base + (ground.visible || ground.hidden || ground.below ? 0 : 0.6));
          }
        });
        if (visitor.cropped && !behind) foreground(cx + side * (0.5 * bw + 0.16), 7 + (inFront ? -3 : 0));
      }
    });
  } else {
    const across = (t) => frame[0] + t * (frame[2] - frame[0]);
    const preferredX =
      relation === 'position' ? across({ left: 0.2, center: 0.5, right: 0.8 }[intent.qualifier]) : null;
    const xs =
      preferredX == null
        ? Array.from({ length: 19 }, (_, i) => across(0.08 + i * 0.047))
        : [0, -0.05, 0.05, -0.1, 0.1, -0.15, 0.15].map((dx) => preferredX + dx);
    // The people the photograph is about, not passers-by in the distance.
    const tallest = Math.max(0, ...geometry.people.map((p) => p.box[3] - p.box[1]));
    const plane = median(
      geometry.people.filter((p) => p.box[3] - p.box[1] >= 0.4 * tallest).map((p) => p.depth)
    );
    const row = geometry.step(plane ?? 0.7);
    const depths = plane === null ? [0.72, 0.6, 0.84] : [plane, plane - row, plane + row, plane - 2 * row];
    for (const x of xs) {
      const away = preferredX == null ? 0 : 5 * Math.abs(x - preferredX);
      // Unprompted, favour joining the group over the far corners.
      const central = preferredX == null ? 1.6 * Math.abs(x - across(0.5)) : 0;
      depths.forEach((raw, rank) => {
        const depth = clamp(raw, 0.01, 1);
        const height = heightAt(depth);
        if (visitor.cropped) {
          for (const row of bustRows(depth, height)) propose(x, row.y, depth, away + central + rank + row.cost);
        } else {
          const ground = geometry.standRow(x, depth);
          const y = ground.eye === undefined ? ground.y : ground.eye + faceUp * height;
          propose(x, y, depth, away + central + rank + (ground.visible ? 0 : ground.hidden ? 0.4 : 1.2));
        }
      });
      if (visitor.cropped) foreground(x, away + central + 2.6);
      else if (plane === null && geometry.depth) {
        // Nobody to stand beside: stand on the visible ground itself.
        for (const row of [0.94, 0.86, 0.78]) {
          const depth = geometry.sample(x, row);
          if (depth !== null) propose(x, row, depth, away + central + 1.5 * Math.abs(row - 0.88));
        }
      }
    }
  }

  let best = null,
    bestCost = Infinity;
  const behind = relation === 'behind';
  for (const candidate of candidates) {
    const mask = behind ? front : null;
    const view = inspect(geometry, visitor, candidate, mask, target);
    let cost = candidate.cost;
    // A person whose face is hidden, or whose camera crop shows, is not there.
    cost += 60 * Math.max(0, 0.96 - view.face);
    cost += 55 * (1 - view.seam);
    cost += 26 * view.covering;
    cost += 9 * view.sideCut;
    cost += 6 * view.crowding;
    // A visitor in front of the family should stand clear of them.
    cost += 5 * view.blocking;
    const headroom = candidate.y - candidate.height - frame[1];
    if (headroom < 0.015) cost += 30 * (0.015 - headroom);
    cost += 22 * view.marginal;
    if (behind) {
      // Behind means partly covered by the subject, and still recognisable.
      cost += 60 * Math.max(0, 0.14 - view.behindTarget) + 14 * Math.max(0, 0.34 - view.visible);
    } else {
      cost += 16 * Math.max(0, (visitor.cropped ? 0.42 : 0.6) - view.visible);
      // Standing in front of someone should not blot them out.
      if (relation === 'front') cost += 10 * Math.max(0, view.overTarget - 0.25);
    }
    if (target && (relation === 'beside' || relation === 'left' || relation === 'right')) {
      // Beside means next to: nobody else in between.
      const from = Math.min(candidate.x, center(target.box)),
        to = Math.max(candidate.x, center(target.box));
      for (const person of geometry.people) {
        const middle = center(person.box);
        // A child on the subject's lap is part of the subject.
        const attached = intersection(person.box, target.box) > 0.3 * area(person.box);
        if (!attached && !sameSubject(person.box, target.box) && middle > from + 0.02 && middle < to - 0.02)
          cost += 7;
      }
    }
    trace?.push({ ...candidate, view, total: cost });
    if (cost < bestCost) {
      best = { ...candidate, view };
      bestCost = cost;
    }
  }
  if (!best) return null;
  return {
    x: best.x,
    y: best.y,
    height: best.height,
    depth: best.depth,
    mode: best.mode || (visitor.cropped ? 'tucked' : 'standing'),
    seam: best.view.seam,
    view: best.view
  };
}
