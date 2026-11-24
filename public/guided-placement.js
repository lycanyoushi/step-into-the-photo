import { $, apiImage, bounds, canvas, coords, copyImage, toBlob } from './ui.js';
import { standingHeight } from './pose.js';
import { SceneDepth } from './scene-depth.js';
import { maskToAlpha } from './canvas.js';
import { faceMeter } from './face-scale.js';
import { profileVisitor } from './visitor-shape.js';
import { estimateLight, peopleTone } from './finish.js';
import {
  InitialCameraFit,
  SceneGeometry,
  parsePlacementPrompt,
  planPlacement,
  selectPlacementTarget
} from './placement-plan.js';

const relationText = {
  behind: 'behind',
  front: 'in front of',
  beside: 'beside',
  left: 'to the left of',
  right: 'to the right of'
};
export const placementKey = (p) => [p.x, p.y, p.width, p.rotation, p.flip].join(',');

// A subject outline as a function of scene position, for the planner.
function coverage(mask, scene) {
  const scale = 192 / Math.max(scene.width, scene.height);
  const w = Math.max(1, Math.round(scene.width * scale)),
    h = Math.max(1, Math.round(scene.height * scale));
  const ctx = canvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(mask, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  return (x, y) => {
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return 0;
    const i = 4 * (Math.floor(y * h) * w + Math.floor(x * w));
    return (rgba[i] * rgba[i + 3]) / 65025;
  };
}

// Keep only the outlined people and objects that are at least as near as the
// visitor. Whoever stands farther back must not be painted over them.
function nearerPart(mask, field, depth) {
  const { width, height } = mask;
  const result = maskToAlpha(mask, width, height);
  if (!field || !Number.isFinite(depth)) return result;
  const ctx = result.getContext('2d', { willReadFrequently: true });
  const pixels = ctx.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let y = 0, i = 3; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      if (!data[i]) continue;
      const d = field.sample((x + 0.5) / width, (y + 0.5) / height);
      if (d !== null && d < depth - 0.045) data[i] = 0;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return result;
}

// A detector sees only the original photograph. The camera matte supplies the
// visitor's scale and offset once, so their next step or wave is free to move.
export function setupGuidedPlacement({ state, liveScene, renderer, refresh, placementUI }) {
  const input = $('placement-prompt'),
    status = $('placement-status'),
    choices = $('placement-choices');
  const pick = $('pick-placement-target'),
    picture = $('picture'),
    output = $('scene');
  let revision = 0,
    committed = null,
    pendingFit = false,
    manual = false;
  let meter,
    faces = new Map(),
    fields = new WeakMap(),
    statures = new WeakMap();
  let calibration = new InitialCameraFit();
  let originalMask = null,
    fallbackPick = null,
    picking = false,
    cache = new Map(),
    encoded;
  let initialPrompt = (new URLSearchParams(location.search).get('place') || '').slice(0, input.maxLength);

  function report(kind, message) {
    status.dataset.state = kind;
    status.textContent = message;
  }
  function clearChoices() {
    choices.replaceChildren();
    fallbackPick = null;
    picking = false;
    pick.hidden = true;
    pick.textContent = 'Pick subject in photo';
    picture.classList.remove('picking-subject');
  }
  function markManual() {
    if (manual && status.dataset.state === 'manual') return;
    ++revision;
    clearChoices();
    manual = true;
    pendingFit = false;
    committed = null;
    report('manual', 'Using your adjustments. Choose Place me to calculate a new position.');
  }
  async function detect(query) {
    // Keep current-scene requests shared across rapid edits and disambiguation.
    const scene = state.scene,
      queries = cache;
    if (!queries.has(query)) {
      encoded ??= toBlob(scene);
      const blob = encoded;
      const pending = (async () => {
        const form = new FormData();
        form.set('image', await blob, 'photograph.png');
        form.set('query', query);
        const response = await fetch('/api/placement-targets', { method: 'POST', body: form });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(result.targets))
          throw Error(result.error || 'Subject detection is unavailable.');
        return result.targets;
      })().catch((error) => {
        queries.delete(query);
        throw error;
      });
      queries.set(query, pending);
    }
    return queries.get(query);
  }
  function frontFor(depth) {
    const { subjectMask, intent, field } = committed;
    // Beside someone, as behind them, their own outline stays in front where
    // the two overlap: the newcomer's shoulder tucks behind, as in a real row.
    const behind = intent.relation !== 'front' && subjectMask;
    const base = originalMask ? nearerPart(originalMask, field, depth) : null;
    if (!base) return behind ? subjectMask : null;
    if (!subjectMask || (!behind && intent.relation !== 'front')) return base;
    // The named subject is added to, or cut out of, whatever was already
    // outlined to stay in front.
    const ctx = base.getContext('2d');
    ctx.globalCompositeOperation = behind ? 'source-over' : 'destination-out';
    ctx.drawImage(maskToAlpha(subjectMask, base.width, base.height), 0, 0);
    return base;
  }
  function fitFrame(cut) {
    if (!pendingFit || !cut || !committed) return;
    // A still is complete at once. A camera may first show an empty room,
    // then a hand or shoulder.
    const visible = state.video
      ? cut.foregroundBounds
      : cut.foregroundBounds || { x: 0, y: 0, width: cut.width, height: cut.height };
    const fit = state.video ? calibration.next(visible, cut.width, cut.height, performance.now()) : 'final';
    if (!fit) return;
    const { intent, target, geometry, front } = committed,
      scene = state.scene;
    const face = meter?.(cut, [
      visible.x / cut.width,
      visible.y / cut.height,
      (visible.x + visible.width) / cut.width,
      (visible.y + visible.height) / cut.height
    ]);
    const visitor = profileVisitor(cut, face, statures.get(cut));
    const plan = planPlacement({ geometry, intent, visitor, target, front });
    if (!plan) return;
    if (fit === 'final' && !visitor.cropped && !statures.has(cut)) measureStature(cut);
    const bodyHeight = fit === 'provisional' ? Math.max(visitor.height, cut.height * 0.5) : visitor.height;
    const gain = (plan.height * scene.height) / bodyHeight;
    const width = Math.max(0.01, Math.min(6, (gain * cut.width) / scene.width));
    const scale = (width * scene.width) / cut.width;
    state.placement = {
      x: plan.x + ((cut.width / 2 - visitor.centre) * scale) / scene.width,
      y: plan.y + ((cut.height / 2 - visitor.bottom) * scale) / scene.height,
      width,
      rotation: 0,
      flip: false
    };
    state.planned = { key: placementKey(state.placement), depth: plan.depth, mode: plan.mode };
    state.foreground = frontFor(plan.depth);
    renderer.setForeground(state.foreground);
    committed.plan = plan;
    committed.visitor = visitor;
    // Say so when a waist-up view could not be given the spot that was asked for.
    committed.framing = !visitor.cropped
      ? ''
      : plan.mode === 'foreground' && (target || intent.relation === 'position')
        ? ' Nothing there can hide a waist-up view, so the visitor is in the foreground. Step back until your feet are in view to stand in the scene.'
        : plan.seam < 0.9
          ? ' Step back until your legs are visible to hide the camera crop.'
          : '';
    if (status.dataset.state === 'ready' && committed.message)
      report('ready', committed.message + committed.framing);
    pendingFit = fit === 'provisional';
    placementUI();
  }

  // Measure the visitor's limbs once, on a copy, and fit again when the
  // answer arrives. A camera reuses one canvas, so one measurement serves it.
  function measureStature(cut) {
    statures.set(cut, null);
    standingHeight(copyImage(cut))
      .then((standing) => {
        if (!standing || state.cut !== cut) return;
        statures.set(cut, standing);
        if (manual || !committed) return;
        pendingFit = true;
        calibration = new InitialCameraFit();
        fitFrame(state.cut);
        refresh();
      })
      .catch(() => {});
  }

  function initialFraming() {
    if (!state.cut || !state.scene) return;
    const width = (0.66 * state.scene.height * state.cut.width) / (state.scene.width * state.cut.height);
    state.placement = { x: 0.5, y: 0.57, width: Math.min(1.3, width), rotation: 0, flip: false };
    placementUI();
  }

  async function outline(target) {
    return (await apiImage('segment', { image: state.scene, box: JSON.stringify(target.box) })).image;
  }
  async function sceneField() {
    // One depth estimate serves occlusion, scale and ground contact.
    try {
      const image = await liveScene.depthFor(state.scene);
      if (!fields.has(image)) {
        const field = new SceneDepth(image);
        // A featureless estimate orders nothing and must not hide the visitor.
        let near = 0,
          far = 1;
        for (let i = 0; i < 81; i++) {
          const d = field.sample(((i % 9) + 0.5) / 9, (Math.floor(i / 9) + 0.5) / 9);
          near = Math.max(near, d);
          far = Math.min(far, d);
        }
        fields.set(image, near - far > 0.08 ? field : null);
      }
      return fields.get(image);
    } catch {
      return null; // A basic install still places by the photographed people.
    }
  }
  async function finish(job, target = null, pickedMask = null) {
    if (revision !== job.id) return;
    clearChoices();
    const { intent, people } = job,
      scene = state.scene;
    let subjectMask = pickedMask;
    try {
      if (target && (intent.relation !== 'front' || originalMask)) {
        report('analyzing', 'Tracing the subject’s outline in the photograph…');
        subjectMask ??= await outline(target);
      }
    } catch (error) {
      // Standing beside someone works without their outline; behind does not.
      if (intent.relation === 'behind' || intent.relation === 'front') {
        if (job.id === revision)
          offerPick(job, 'The subject outline could not be found. Pick the subject in the photo.');
        return;
      }
    }
    if (revision !== job.id) return;
    report('analyzing', 'Measuring depth and scale in the photograph…');
    const [field, measure] = await Promise.all([sceneField(), faceMeter()]);
    if (revision !== job.id) return;
    meter = measure;
    function withFace(hit) {
      if (!meter) return hit;
      const key = hit.box.join(',');
      if (!faces.has(key)) faces.set(key, meter(scene, hit.box));
      return { ...hit, face: faces.get(key) };
    }
    const geometry = new SceneGeometry({
      depth: field ? field.sample.bind(field) : null,
      people: people.map(withFace),
      aspect: scene.width / scene.height,
      frame: renderer.frame
    });
    renderer.setLight(estimateLight(scene, geometry.people));
    renderer.setPeopleTone(peopleTone(scene, geometry.people, geometry.depth));
    committed = {
      intent,
      geometry,
      field,
      target: target ? withFace(target) : null,
      subjectMask,
      front: intent.relation === 'behind' && subjectMask ? coverage(subjectMask, scene) : null
    };
    manual = false;
    pendingFit = true;
    calibration = new InitialCameraFit();
    // Depth decides who covers whom. Outlines sharpen that boundary.
    liveScene.config().mode = field ? 'auto' : 'outline';
    if (!state.cut) {
      state.foreground = frontFor(null);
    }
    fitFrame(state.cut);
    refresh();
    const ready = target
      ? 'Placement set ' + relationText[intent.relation] + ' the selected subject.'
      : intent.relation === 'position'
        ? 'Placement set in the requested part of the photo.'
        : job.limited
          ? 'Using an estimated position. Subject detection is unavailable.'
          : 'Automatic placement ready. Enter a direction to change it.';
    committed.message = ready;
    report('ready', ready + (committed.framing || ''));
    if (target) {
      fallbackPick = job;
      pick.hidden = false;
      pick.textContent = 'Pick a different subject';
    }
  }
  function offerPick(job, message) {
    fallbackPick = job;
    pick.hidden = false;
    report('error', message);
  }
  function showCandidates(job, matches) {
    offerPick(job, '');
    report('choosing', 'Several subjects match. Choose the one you mean.');
    const scene = state.scene;
    for (const [i, match] of [...matches].sort((a, b) => a.box[0] - b.box[0]).entries()) {
      const button = document.createElement('button'),
        thumb = canvas(100, 100);
      button.type = 'button';
      const [l, t, r, b] = match.box;
      const width = (r - l) * scene.width,
        height = (b - t) * scene.height;
      // Show the top of a tall subject at a legible scale for recognition.
      const side = Math.min(Math.max(width, height * 0.36) * 1.2, scene.width, scene.height);
      const x = Math.max(0, Math.min(scene.width - side, ((l + r) / 2) * scene.width - side / 2));
      const y = Math.max(0, Math.min(scene.height - side, t * scene.height - side * 0.06));
      thumb.getContext('2d').drawImage(scene, x, y, side, side, 0, 0, 100, 100);
      button.append(thumb, document.createTextNode('Match ' + (i + 1)));
      button.onclick = () => finish(job, match);
      choices.append(button);
    }
  }
  async function apply() {
    const id = ++revision,
      scene = state.scene;
    clearChoices();
    if (!scene) return;
    const intent = parsePlacementPrompt(input.value);
    if (intent.relation === 'unsupported') {
      report('error', intent.error || 'Try a direction such as “behind the woman” or “on the left”.');
      return;
    }
    report(
      'analyzing',
      intent.query
        ? 'Looking for “' + intent.query + '” in the photograph…'
        : 'Finding a position in the photograph…'
    );
    const job = { id, intent, people: [], limited: false };
    const people = detect('').catch(() => {
      job.limited = true;
      return [];
    });
    const subject = intent.query
      ? detect(intent.query === 'person' ? '' : intent.query)
      : Promise.resolve([]);
    try {
      const [all, matches] = await Promise.all([people, subject]);
      if (id !== revision) return;
      job.people = all;
      if (!intent.query) return finish(job);
      const selection = selectPlacementTarget(matches, intent);
      if (selection.target) return finish(job, selection.target);
      if (selection.reason === 'ambiguous') return showCandidates(job, selection.candidates);
      offerPick(
        job,
        'No confident match for “' +
          intent.query +
          '”. Pick the subject in the photo or try another description.'
      );
    } catch {
      if (id === revision)
        offerPick(job, 'Subject detection is unavailable. Pick the subject in the photograph.');
    }
  }
  pick.onclick = () => {
    picking = !picking;
    picture.classList.toggle('picking-subject', picking);
    pick.textContent = picking ? 'Cancel selection' : 'Pick subject in photo';
    if (picking) {
      report('choosing', 'Click the subject inside the photograph.');
      output.focus({ preventScroll: true });
    } else report('choosing', 'Pick a subject or enter another direction.');
  };
  output.addEventListener(
    'pointerdown',
    async (event) => {
      if (!picking || !fallbackPick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const job = fallbackPick,
        scene = state.scene,
        p = coords(event, output);
      clearChoices();
      report('analyzing', 'Finding the outline at the selected point…');
      try {
        const point = {
          x: Math.min(scene.width - 1, Math.max(0, p.x)),
          y: Math.min(scene.height - 1, Math.max(0, p.y)),
          label: 1
        };
        const { image } = await apiImage('segment', { image: scene, points: JSON.stringify([point]) });
        if (job.id !== revision) return;
        const b = bounds(image);
        if (!b) throw Error('Empty outline');
        const box = [
          b.x / scene.width,
          b.y / scene.height,
          (b.x + b.w) / scene.width,
          (b.y + b.h) / scene.height
        ];
        await finish(job, { box, score: 1 }, image);
      } catch {
        if (job.id === revision) offerPick(job, 'Try a point farther inside the subject.');
      }
    },
    true
  );

  $('placement-form').onsubmit = (event) => {
    event.preventDefault();
    apply();
  };
  return {
    sceneChanged() {
      originalMask = state.foreground;
      committed = null;
      state.planned = null;
      manual = pendingFit = false;
      encoded = null;
      faces = new Map();
      cache = new Map();
      input.value = initialPrompt;
      initialPrompt = '';
      initialFraming();
      apply();
    },
    // A camera, a recording or a photograph of a person has become the visitor.
    visitorChanged() {
      if (manual) return;
      initialFraming();
      calibration = new InitialCameraFit();
      pendingFit = !!committed;
      fitFrame(state.cut);
    },
    reset() {
      input.value = '';
      apply();
    },
    manualOutline(mask) {
      markManual();
      originalMask = mask;
    },
    markManual,
    fitFrame,
    get committed() {
      return committed;
    }
  };
}
