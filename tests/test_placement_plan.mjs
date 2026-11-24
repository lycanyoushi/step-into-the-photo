import assert from 'node:assert/strict';
import {
  InitialCameraFit,
  SceneGeometry,
  parsePlacementPrompt as parse,
  planPlacement,
  selectPlacementTarget
} from '../public/placement-plan.js';

const woman = { box: [0.42, 0.25, 0.57, 0.85], score: 0.82 };
const man = { box: [0.21, 0.28, 0.41, 0.85], score: 0.9 };
const entering = new InitialCameraFit();
const hand = { x: 1, y: 140, width: 55, height: 90 };
const torso = { x: 150, y: 40, width: 270, height: 440 };
assert.equal(entering.next(null, 640, 480, 0), null);
assert.equal(entering.next(hand, 640, 480, 100), null);
assert.equal(entering.next(hand, 640, 480, 600), null);
assert.equal(entering.next(hand, 640, 480, 900), 'provisional');
assert.equal(entering.next(hand, 640, 480, 2600), null);
assert.equal(entering.next(torso, 640, 480, 2640), 'final');
assert.equal(entering.next({ ...torso, x: 250 }, 640, 480, 2680), null);
assert.equal(new InitialCameraFit().next(torso, 640, 480, 0), 'final');
assert.deepEqual(parse('Could you place me just behind the woman on the left?'), {
  relation: 'behind',
  query: 'woman',
  qualifier: 'left'
});
assert.deepEqual(parse('Please put me beside the woman in green.'), {
  relation: 'beside',
  query: 'woman in green',
  qualifier: null
});
assert.deepEqual(parse('on the right side of the photograph'), {
  relation: 'position',
  query: '',
  qualifier: 'right'
});
assert.equal(parse('to the left of the person wearing glasses').relation, 'left');
assert.equal(parse('put me in front of the rightmost chair').qualifier, 'right');
assert.equal(parse('').relation, 'auto');
assert.equal(parse('behind').relation, 'unsupported');
assert.equal(parse('behind him').relation, 'unsupported');
assert.equal(parse('behind the person and in front of the tree').relation, 'unsupported');
assert.equal(parse('between two people').relation, 'unsupported');

assert.equal(selectPlacementTarget([], parse('behind the woman')).reason, 'missing');
assert.equal(selectPlacementTarget([woman, man], parse('behind a person')).reason, 'ambiguous');
assert.equal(selectPlacementTarget([woman, man], parse('behind the person on the left')).target, man);
assert.equal(selectPlacementTarget([woman, man], parse('behind the rightmost person')).target, woman);
assert.equal(
  selectPlacementTarget([woman, { ...woman, score: 0.5 }], parse('behind the woman')).target,
  woman
);
const weakerMatch = { ...man, score: 0.56 };
assert.equal(selectPlacementTarget([woman, weakerMatch], parse('behind the woman')).target, woman);
assert.equal(selectPlacementTarget([woman, weakerMatch], parse('behind the person')).reason, 'ambiguous');
assert.equal(selectPlacementTarget([woman, man], parse('behind the woman')).reason, 'ambiguous');


// A level lawn seen in perspective: relative depth rises linearly from the
// horizon to the bottom edge. Two adults stand on it at the same distance.
const aspect = 1.5;
const horizon = 0.45;
const lawn = (y) => Math.max(0, (y - horizon) / (1 - horizon));
const standing = lawn(0.85);
const inside = (box, x, y) => x > box[0] && x < box[2] && y > box[1] && y < box[3];
const meadow = (x, y) => (inside(woman.box, x, y) || inside(man.box, x, y) ? standing : lawn(y));
const adultWoman = { ...woman, face: { x: 0.495, y: 0.31, height: 0.06 } };
const adultMan = { ...man, face: { x: 0.31, y: 0.34, height: 0.057 } };
const family = new SceneGeometry({ depth: meadow, people: [adultWoman, adultMan], aspect });
assert.ok(Math.abs(family.people[0].depth - standing) < 0.01, 'A subject takes the depth of their body');
assert.ok(family.ground, 'Receding ground is recognised');
assert.ok(Math.abs(family.groundRow(0.8, standing).y - 0.85) < 0.02, 'Ground row matches the depth');
assert.ok(family.groundRow(0.8, standing).visible, 'Open lawn shows the contact point');
assert.ok(family.groundRow(0.5, standing - 0.1).hidden, 'A person in front hides the ground behind them');
assert.ok(Math.abs(family.faceAt(standing) - 0.0585) < 0.004, 'Faces calibrate the scale at their depth');
assert.ok(family.faceAt(standing + 0.1) > family.faceAt(standing), 'Nearer people are larger');

// Silhouettes are sampled relative to the bottom centre in units of height.
function silhouette({ width, cropped, faceFraction, faceUp }) {
  const body = [],
    seam = [];
  for (let i = 0; i < 16; i++) {
    const dx = ((i + 0.5) / 16 - 0.5) * width;
    for (let j = 0; j < 40; j++) {
      const dy = -(j + 0.5) / 40;
      body.push([dx, dy, Math.abs(-dy - faceUp) < faceFraction / 2 && Math.abs(dx) < 0.16 * width + 0.04]);
    }
    seam.push(dx);
  }
  return {
    aspect: width,
    cropped,
    body,
    seam: cropped ? seam : [],
    faceFraction,
    faceUp,
    contains: (dx, dy) => Math.abs(dx) < width / 2 && dy < 0 && dy > -1
  };
}
const walker = silhouette({ width: 0.42, cropped: false, faceFraction: 0.1, faceUp: 0.91 });
const webcam = silhouette({ width: 0.9, cropped: true, faceFraction: 0.3, faceUp: 0.62 });
const place = (text, visitor = walker, target = null, geometry = family, front = null) =>
  planPlacement({ geometry, intent: parse(text), visitor, target, front });
const halfWidth = (plan, visitor = walker) => (visitor.aspect * plan.height) / aspect / 2;

const beside = place('beside the woman', walker, adultWoman);
assert.ok(
  beside.x - halfWidth(beside) > woman.box[2] - 0.02 || beside.x + halfWidth(beside) < woman.box[0] + 0.02,
  'Beside leaves the subject uncovered'
);
assert.ok(Math.abs(beside.y - 0.85) < 0.03, 'Feet rest on the ground at the subject’s depth');
assert.ok(Math.abs(beside.height - 0.585) < 0.06, 'A standing visitor is as tall as the adults beside them');
assert.ok(Math.abs(beside.depth - standing) < 0.03);
assert.ok(place('left of the woman', walker, adultWoman).x < woman.box[0]);
assert.ok(place('right of the woman', walker, adultWoman).x > woman.box[2]);

const cover = (x, y) => (inside(woman.box, x, y) ? 1 : 0);
const behind = place('behind the woman', walker, adultWoman, family, cover);
assert.ok(behind.depth < standing && behind.height < beside.height, 'Farther back is smaller');
assert.ok(behind.y < 0.85, 'Feet farther away are higher in the picture');
assert.ok(behind.view.behindTarget > 0.08 && behind.view.face >= 0.96, 'Partly covered, face clear');
const front = place('in front of the woman', walker, adultWoman);
assert.ok(front.depth > standing && front.y > 0.85 && front.height > beside.height, 'Nearer is lower and larger');
assert.ok(front.view.overTarget < 0.5, 'In front does not blot out the subject');

const right = place('on the right');
assert.ok(right.x > 0.62, 'A side of the photograph is honoured');
assert.ok(Math.abs(right.y - family.groundRow(right.x, right.depth).y) < 0.02, 'Standing on the ground');
const unprompted = place('');
assert.ok(unprompted.view.crowding < 0.05 && unprompted.view.covering === 0, 'Automatic placement finds room');

// A waist-up camera view has an edge to hide. Open ground cannot hide it:
// the visitor moves to the foreground and is cropped by the photograph.
const selfie = place('on the right', webcam);
assert.equal(selfie.mode, 'foreground');
assert.ok(selfie.y >= 1 && selfie.seam === 1 && selfie.x > 0.6);
assert.ok(selfie.height * webcam.faceFraction > family.faceAt(standing), 'A nearer face is larger');
// Behind a subject, their body covers the camera edge.
const peek = place('behind the woman', webcam, adultWoman, family, cover);
assert.equal(peek.mode, 'tucked');
assert.ok(peek.seam >= 0.8 && peek.view.face >= 0.9 && peek.depth < standing);
assert.ok(peek.view.behindTarget >= 0.14, 'Behind means partly covered by that subject');
assert.ok(
  Math.abs(peek.height * webcam.faceFraction - family.faceAt(peek.depth)) < 0.004,
  'Face size, not silhouette height, sets the scale of a cropped visitor'
);

// A reflection below a person is not a second person, and a distant passer-by
// must not change the scale of the group.
const mirrored = { box: [0.425, 0.86, 0.565, 0.99], score: 0.4 };
const passerBy = { box: [0.8, 0.455, 0.808, 0.475], score: 0.5 };
const busy = new SceneGeometry({
  depth: meadow,
  people: [adultWoman, adultMan, mirrored, passerBy],
  aspect
});
assert.equal(busy.people.length, 3, 'Mirror image discarded');
assert.ok(Math.abs(busy.faceAt(standing) - family.faceAt(standing)) < 0.005);

// A kitchen counter also recedes like ground, but the cooks stand behind it.
const cook = { box: [0.3, 0.15, 0.5, 0.72], face: { x: 0.4, y: 0.22, height: 0.1 } };
const counter = (x, y) => (y > 0.7 ? 0.6 + (0.4 * (y - 0.7)) / 0.3 : inside(cook.box, x, y) ? 0.3 : 0.1);
const kitchen = new SceneGeometry({ depth: counter, people: [cook], aspect });
assert.equal(kitchen.ground, null, 'A surface people stand behind is not the floor');
const guest = place('beside the cook', walker, cook, kitchen);
assert.ok(guest.y > 0.95, 'Feet belong below the counter, out of sight');
assert.ok(guest.view.visible < 0.85 && guest.view.face >= 0.96, 'The counter hides the legs');
assert.ok(Math.abs(guest.height - 1.0) < 0.12, 'Standing height follows the cook’s face');
const leaning = place('beside the cook', webcam, cook, kitchen);
assert.equal(leaning.mode, 'tucked');
assert.ok(leaning.seam >= 0.95, 'The counter covers a waist-up visitor’s camera edge');

console.log('PASS: prompt parsing, target selection, scene geometry and placement planning');
