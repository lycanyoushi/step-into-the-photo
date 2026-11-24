import { SceneRenderer } from './engine.js';
import { PersonCutout } from './media.js';
import {
  createPoseRig,
  padForPose,
  applyPosePreset,
  poseFromPhoto,
  renderPose,
  drawRig,
  moveJoint,
  hitJoint
} from './pose.js';
import { defaultRemovalMargin, setupMaskEditor } from './mask-editor.js';
import { setupTrials } from './setup-trials.js';
import {
  $,
  copyImage,
  readImage,
  fileImage,
  toBlob,
  download,
  notify,
  apiImage,
  bounds,
  trim,
  maskedCrop,
  coords,
  icons
} from './ui.js';
import { setupGeneration } from './synthesis-ui.js';
import { LiveScene } from './live-scene.js';
import { setupAudience } from './audience.js';
import { setupGuidedPlacement } from './guided-placement.js';
import { describeStill } from './visitor-shape.js';

icons();
const demoMode = document.documentElement.classList.contains('demo-mode');
let audience = null;
let guidedPlacement = null;
let liveExposure = 0;
const output = $('scene'),
  renderer = new SceneRenderer(output),
  openMask = setupMaskEditor();
const S = {
  scene: null,
  name: '',
  raw: null,
  sourceName: '',
  cut: null,
  sourceMask: null,
  foreground: null,
  family: null,
  frozenSpace: null,
  planned: null,
  target: null,
  removalMargin: null,
  plate: null,
  frontExtra: null,
  mode: 'add',
  look: 'natural',
  original: false,
  video: null,
  stream: null,
  url: null,
  clock: 0,
  rig: null,
  padded: null,
  manual: null,
  tap: null,
  tapMethod: null,
  metrics: [],
  history: [],
  fresh: 0,
  placement: { x: 0.37, y: 0.7, width: 0.18, rotation: 0, flip: false }
};
const trials = setupTrials(S.metrics);
const liveScene = new LiveScene(renderer, S, render);
// A newly measured colour table arrives between camera frames, and is the
// only event that repaints a still visitor.
renderer.onUpdate = () => {
  if (!S.original) render();
};
// Which local models the service reports, once it has answered.
let services = {};
let recording = null,
  rawRecorder = null,
  measuring = null,
  working = false,
  rigDirty = false;
const current = () => (S.padded && S.rig ? renderPose(S.padded, S.rig) : S.cut);
function render() {
  if (!S.scene) return;
  if (S.original || (demoMode && !current())) {
    const ctx = output.getContext('2d');
    ctx.clearRect(0, 0, output.width, output.height);
    ctx.drawImage(S.scene, 0, 0);
    return;
  }
  const visitor = current();
  const look = demoMode ? 'natural' : S.look;
  renderer.render(visitor, {
    ...S.placement,
    mode: S.mode,
    look,
    exposure: liveExposure,
    live: !!S.video,
    ...liveScene.options(visitor)
  });
}
function view(mode) {
  S.original = mode === 'original';
  for (const el of document.querySelectorAll('[data-view]')) {
    el.classList.toggle('active', el.dataset.view === mode);
    el.setAttribute('aria-pressed', String(el.dataset.view === mode));
  }
  render();
}
function placementUI() {
  $('scale').max = Math.max(200, Math.ceil(S.placement.width * 100));
  $('scale').value = S.placement.width * 100;
  $('scale-out').value = Math.round(S.placement.width * 100) + '%';
  $('rotation').value = S.placement.rotation;
  $('rotation-out').value = S.placement.rotation + '°';
  $('flip').checked = S.placement.flip;
}
function choosePlacement(fit = false) {
  const source = current();
  if (!source || !S.scene) return;
  if (S.family && !fit && S.video) {
    S.placement = { rotation: 0, flip: false, ...S.family.placement };
    placementUI();
    return;
  }
  const b = fit && S.target ? bounds(S.target) : null,
    ref = bounds(source, true) || { x: 0, y: 0, w: source.width, h: source.height };
  const familyHeight = S.family ? 0.78 * 0.75 * S.family.placement.width * S.scene.width : null;
  const width = Math.max(
      0.01,
      Math.min(
        6,
        ((b ? b.h : (familyHeight ?? 0.65 * S.scene.height)) * source.width) / ref.h / S.scene.width
      )
    ),
    gain = (width * S.scene.width) / source.width;
  S.placement = {
    x:
      (b ? (b.x + b.w / 2) / S.scene.width : (S.family?.placement.x ?? 0.48)) +
      ((source.width / 2 - ref.x - ref.w / 2) * gain) / S.scene.width,
    y:
      (b ? (b.y + b.h / 2) / S.scene.height : (S.family?.placement.y ?? 0.58)) +
      ((source.height / 2 - ref.y - ref.h / 2) * gain) / S.scene.height,
    width,
    rotation: 0,
    flip: false
  };
  placementUI();
}
function configure() {
  trials.setScene(S.scene);
  if (renderer.scene !== S.scene) renderer.setScene(S.scene);
  renderer.setCleanPlate(S.plate);
  renderer.setForeground(S.mode === 'replace' ? S.frontExtra : S.foreground);
  renderer.setReference(S.mode === 'replace' ? S.target : S.foreground);
  $('scene-name').textContent = $('scene-label').textContent = S.name;
  $('scene-thumb').src = thumbnail(S.scene);
  $('size-label').textContent = S.scene.width + ' × ' + S.scene.height + ' px';
  $('add').setAttribute('aria-pressed', String(S.mode === 'add'));
  $('replace').setAttribute('aria-pressed', String(S.mode === 'replace'));
  $('outline-title').textContent = S.mode === 'add' ? 'Foreground overlap' : 'Replacement target';
  $('outline-help').textContent =
    S.mode === 'add'
      ? 'Keep a person or object in front of the new layer.'
      : 'Select the person to remove. Their outline sets the initial size and position.';
  $('outline').querySelector('span').textContent =
    S.mode === 'add' ? 'Edit foreground outline' : 'Edit replacement target';
  $('replace-extra').hidden = S.mode !== 'replace';
  $('undo-stamp').disabled = !S.history.length;
  liveScene.refresh();
  render();
}
function thumbnail(img) {
  const small = copyImage(img, 96);
  return small.toDataURL('image/png');
}
function personUI() {
  if (demoMode) syncDemoControls();
  const pic = S.cut || S.raw;
  if (pic) $('person-thumb').src = thumbnail(pic);
  else $('person-thumb').removeAttribute('src');
  $('person-name').textContent = S.sourceName || 'Choose a person';
  $('camera').lastChild.textContent = S.stream ? 'Freeze webcam' : 'Use webcam';
  $('source-select').disabled = !S.raw || !!S.video;
  $('freeze').disabled = !S.video;
  $('stamp').disabled = !S.cut;
  $('rig').disabled = !S.cut;
  $('target-pose').disabled = !S.cut || !(S.target || S.foreground);
  $('take').disabled = !S.stream;
  liveScene.refresh();
}
let sourceEvents = null;
function stopSource() {
  sourceEvents?.abort();
  sourceEvents = null;
  if (rawRecorder?.state === 'recording') {
    rawRecorder.stop();
  }
  S.clock++;
  S.video?.pause();
  if (S.stream) for (const track of S.stream.getTracks()) track.stop();
  if (S.video) {
    S.video.srcObject = null;
    S.video.removeAttribute('src');
    S.video.load();
  }
  if (S.url) URL.revokeObjectURL(S.url);
  S.video = S.stream = S.url = null;
}
function stopLiveCamera(
  message = 'Camera stopped. Start the camera to step back into the photograph.',
  warning = false
) {
  if (!S.stream) return;
  finalizeBenchmark('Camera stopped');
  ingestPhoto(null, '', null, null, false);
  notify(message, warning);
}
function finalizeBenchmark(reason = '') {
  if (!measuring) return;
  const q = measuring;
  measuring = null;
  clearTimeout(q.timer);
  const seconds = (performance.now() - q.at) / 1000,
    frames = S.fresh - q.frames;
  const measurement = {
    kind: 'fresh-frame benchmark',
    source: q.source,
    width: q.width,
    height: q.height,
    scene: [S.scene.width, S.scene.height],
    seconds,
    frames,
    fps: frames / seconds,
    sourceFrameRate: q.captureFps,
    segmentation: q.method || null,
    processedMediaTimes: q.timestamps,
    timestampSource: q.timestampSource,
    look: q.look,
    interrupted: reason || false,
    browser: navigator.userAgent
  };
  S.metrics.push(measurement);
  $('benchmark').textContent = 'Measure 30 seconds';
  notify(
    (reason ? 'Measurement interrupted. ' : '') +
      frames +
      ' freshly segmented and displayed frames in ' +
      seconds.toFixed(1) +
      ' seconds (' +
      measurement.fps.toFixed(1) +
      ' fps).'
  );
}
function clearRig() {
  S.rig = null;
  S.padded = null;
}
function ingestPhoto(img, name, cut, mask = null, resetPlacement = true, frozenSpace = null) {
  finalizeBenchmark('Source changed');
  stopSource();
  clearRig();
  S.raw = img;
  S.sourceName = name;
  S.sourceMask = mask;
  S.cut = cut;
  S.frozenSpace = frozenSpace;
  if (!frozenSpace) renderer.resetMatch();
  if (resetPlacement) {
    if (guidedPlacement && cut) guidedPlacement.visitorChanged();
    else choosePlacement(S.mode === 'replace');
  }
  personUI();
  view('composite');
}
function facts(detail) {
  notify(detail);
}
async function guarded(action) {
  if (working) return;
  working = true;
  const desk = document.querySelector('.desk'),
    mast = document.querySelector('.mast');
  desk.inert = true;
  mast.inert = true;
  try {
    await action();
  } catch (e) {
    notify(e.message || String(e), true);
  } finally {
    working = false;
    desk.inert = false;
    mast.inert = false;
  }
}
function clearOutlines() {
  S.removalMargin = null;
  S.mode = 'add';
  S.target = S.plate = S.foreground = S.frontExtra = S.manual = S.tap = S.tapMethod = null;
}
async function newScene(file) {
  const scene = await fileImage(file);
  useScene(scene, file.name);
}
function useScene(scene, name, family = null, foreground = null) {
  finalizeBenchmark('Scene changed');
  clearOutlines();
  S.scene = scene;
  S.name = name;
  S.family = family;
  S.frozenSpace = null;
  S.planned = null;
  S.foreground = foreground;
  S.history = [];
  if (demoMode) setExposure(0);
  else choosePlacement();
  configure();
  personUI();
  view('composite');
  if (demoMode) {
    guidedPlacement.sceneChanged();
    facts(
      S.stream
        ? 'Camera live in the new photograph.'
        : 'Photograph ready. Start the camera when the person is in position.'
    );
    return;
  }
  facts(
    family
      ? 'Family photograph ready. Use the webcam to step into it, or try the recorded dancer.'
      : 'Scene loaded. Use the webcam to move in the photograph. You can drag the visitor and adjust their size.'
  );
}
async function newPerson(file) {
  if (file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|ogv)$/i.test(file.name)) {
    await movingSource(file);
    return;
  }
  const img = await fileImage(file);
  notify('Separating the person from the photograph…');
  try {
    const cutter = new PersonCutout({ photographic: true });
    let cut = await cutter.frame(img),
      outline = null;
    if (cutter.method !== 'Embedded alpha' && services.sam2 && services.placement) {
      // A street or a party has other people in it, and the camera matte keeps
      // them all. The local detector and SAM outline the one this photo is of.
      try {
        notify('Finding the person this photograph is of…');
        outline = (await apiImage('person', { image: img })).image;
        cut = await new PersonCutout().frame(img, { mask: outline });
      } catch {
        outline = null; // The camera matte remains.
      }
    }
    cut = describeStill(trim(cut));
    ingestPhoto(img, file.name, cut, outline);
    facts(
      demoMode
        ? 'Person placed in the photograph. Enter a direction under Place the visitor to move them.'
        : 'Person added. For a group photograph, use Select person to isolate one individual.'
    );
  } catch (e) {
    ingestPhoto(img, file.name, null);
    notify(e.message, true);
    editMask('source');
  }
}
async function openCamera(photographic) {
  if (!navigator.mediaDevices?.getUserMedia)
    throw Error('Open the studio on localhost or HTTPS to enable the webcam.');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: photographic ? 1280 : 640 },
        height: { ideal: photographic ? 960 : 480 },
        frameRate: { ideal: 30 }
      }
    });
  } catch (error) {
    const advice = {
      NotAllowedError:
        'Allow camera access for this site in the browser’s site settings, then start the camera again.',
      NotFoundError: 'The browser could not find a camera. Connect a webcam, then start the camera again.',
      NotReadableError: 'The browser could not open the camera. Close other apps using it and try again.',
      OverconstrainedError:
        'The camera could not provide a usable video feed. Select another camera in the browser and try again.',
      AbortError: 'Camera startup was interrupted. Reconnect the camera and try again.',
      SecurityError: 'Camera access is disabled. Enable it for this site in the browser and try again.'
    };
    throw Error(
      advice[error.name] || error.message || 'Could not start the camera. Reconnect it and try again.'
    );
  }
}

async function movingSource(file = null) {
  const photographic = demoMode || !!S.family || S.look === 'photographic' || S.look === 'natural';
  let stream = null,
    url = null;
  const video = document.createElement('video');
  const listeners = new AbortController();
  video.muted = true;
  video.playsInline = true;
  video.loop = !!file;
  try {
    if (file) {
      url = URL.createObjectURL(file);
      video.src = url;
    } else {
      stream = await openCamera(photographic);
      video.srcObject = stream;
    }
    const cutter = new PersonCutout({ live: true, photographic });
    // A device can disappear while waiting for its very first playable frame.
    // The current composition remains intact until the new cutout is ready.
    const lost = new Promise((_, reject) => {
      const opts = { signal: listeners.signal };
      const disconnected = () => {
        const message = stream
          ? 'The camera disconnected. Reconnect it, then start the camera again.'
          : 'The video could not be decoded. Try another recording.';
        reject(Error(message));
        if (S.video !== video) return;
        if (stream) stopLiveCamera(message, true);
        else {
          ingestPhoto(null, '', null, null, false);
          notify(message, true);
        }
      };
      video.addEventListener('error', disconnected, opts);
      if (stream) {
        stream.addEventListener('inactive', disconnected, opts);
        video.addEventListener('ended', disconnected, opts);
        for (const track of stream.getVideoTracks()) track.addEventListener('ended', disconnected, opts);
        if (!stream.active || !stream.getVideoTracks().some((track) => track.readyState === 'live'))
          disconnected();
      }
    });
    async function firstFrame() {
      await video.play();
      if (video.readyState < 2) {
        await new Promise((resolve) =>
          video.addEventListener('loadeddata', resolve, {
            once: true,
            signal: listeners.signal
          })
        );
      }
      notify('Starting local person segmentation…');
      return cutter.frame(video, { time: video.currentTime });
    }
    const first = await Promise.race([lost, firstFrame()]);
    finalizeBenchmark('Source changed');
    stopSource();
    clearRig();
    S.raw = S.sourceMask = null;
    S.cut = first;
    S.frozenSpace = null;
    S.sourceName = file?.name || 'Live webcam';
    S.url = url;
    S.stream = stream;
    sourceEvents = listeners;
    S.video = video;
    S.fresh = 0;
    renderer.resetMatch();
    if (guidedPlacement) guidedPlacement.visitorChanged();
    else choosePlacement(S.mode === 'replace');
    personUI();
    view('composite');
    const generation = S.clock;
    let previousTime = video.currentTime,
      processing = false;
    function schedule() {
      if (S.clock !== generation) return;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    }
    async function tick(now, meta) {
      if (S.clock !== generation) return;
      const sample = meta?.mediaTime ?? video.currentTime;
      // Register before inference so the decoder can notify the next
      // presentation as soon as this processing pass completes.
      schedule();
      if (processing || sample === previousTime) return;
      previousTime = sample;
      processing = true;
      try {
        const cut = await cutter.frame(video, { time: sample });
        if (S.clock !== generation) return;
        S.cut = cut;
        guidedPlacement?.fitFrame(cut);
        render();
        if (!S.original) {
          S.fresh++;
          if (measuring) {
            measuring.timestamps.push(sample);
            measuring.method = cutter.method;
          }
        }
      } catch (e) {
        if (S.clock === generation) {
          finalizeBenchmark('Segmentation stopped');
          const message = 'Live segmentation stopped. ' + e.message;
          if (stream) stopLiveCamera(message, true);
          else {
            ingestPhoto(null, '', null, null, false);
            notify(message, true);
          }
        }
      } finally {
        processing = false;
      }
    }
    schedule();
    facts(
      file
        ? 'Replaying your take. The same motion can be reused in Evaluation tools.'
        : 'Webcam is live. Move into position or freeze a pose.'
    );
  } catch (e) {
    listeners.abort();
    video.pause();
    if (stream) for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
    if (url) URL.revokeObjectURL(url);
    throw e;
  }
}
function freeze() {
  if (!S.video || !S.cut) throw Error('Start the webcam or import a video to freeze a frame.');
  const still = copyImage(S.cut);
  still.floorContact = S.cut.floorContact ? structuredClone(S.cut.floorContact) : null;
  ingestPhoto(still, S.sourceName + ' · still', still, null, false, { ...liveScene.lastOptions });
  facts('Frame frozen. You can now open the pose editor.');
}
function timeToSave(action = 'photo') {
  trials.saved(S.mode === 'add' && !!S.foreground && !!S.cut, action);
}
function editMask(kind) {
  if (kind === 'source' && !S.raw) throw Error('Import a still photograph to choose an individual.');
  const image = kind === 'source' ? S.raw : S.scene;
  const initial = { foreground: S.foreground, extra: S.frontExtra, target: S.target, source: S.sourceMask }[
    kind
  ];
  const foreground = kind === 'foreground';
  openMask({
    title: {
      foreground: 'Foreground outline',
      extra: 'Foreground in front of replacement',
      target: 'Select the person to replace',
      source: 'Choose a person from the source'
    }[kind],
    image,
    initial,
    removalMargin: kind === 'target' ? (S.removalMargin ?? defaultRemovalMargin(image)) : null,
    method: foreground ? trials.firstMethod() : null,
    corrected: foreground ? trials.correction : null,
    evidenceReady: foreground
      ? (method, mask, segmenter) => {
          if (method === 'tap' && !S.tap) {
            S.tap = mask;
            S.tapMethod = segmenter;
          }
          if (method === 'trace' && !S.manual) S.manual = mask;
          trials.outline(method, segmenter);
        }
      : null,
    apply: async (data) => {
      if (kind === 'source') {
        if (!data.mask) throw Error('Tap or trace the person first.');
        const cut = describeStill(trim(await new PersonCutout().frame(S.raw, { mask: data.mask })));
        ingestPhoto(S.raw, S.sourceName, cut, data.mask);
      } else if (kind === 'target') {
        if (!data.mask) throw Error('Select the person to replace first.');
        const { image: plate, method } = await apiImage('remove', { image, mask: data.removalMask });
        if (!data.isCurrent() || S.scene !== image) return;
        S.target = data.mask;
        S.removalMargin = data.removalMargin;
        S.plate = plate;
        S.mode = 'replace';
        choosePlacement(true);
        configure();
        facts(
          (method || 'Background reconstruction') +
            ' complete. Drag the replacement or open Pose to borrow the selected person’s pose.'
        );
      } else {
        if (kind === 'extra') S.frontExtra = data.mask;
        else {
          guidedPlacement?.manualOutline(data.mask);
          S.foreground = data.mask;
          trials.applied(!!data.mask);
        }
        configure();
        facts(
          data.mask
            ? 'Outline applied. Original pixels inside it stay in front.'
            : 'Foreground outline cleared.'
        );
      }
      S.metrics.push({
        kind: 'outline editor',
        role: kind,
        scene: S.name,
        editorMs: data.elapsed,
        firstOutlineInEditorMs: data.firstTime,
        corrections: data.corrections,
        method: data.manual ? 'hand trace' : data.tapMethod || 'edited outline'
      });
      personUI();
      view('composite');
    }
  });
}
function selectMode(mode) {
  if (mode === S.mode) return;
  if (mode === 'replace' && !S.plate) {
    editMask('target');
    return;
  }
  S.mode = mode;
  configure();
  if (mode === 'replace') choosePlacement(true);
  render();
}
function selectTab(name) {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const active = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(active));
    $(tab.dataset.tab).hidden = !active;
  }
}
async function prepareRig() {
  if (S.video) freeze();
  if (!S.cut) throw Error('Import a person before editing their pose.');
  if (S.rig) return;
  notify('Finding the body joints…');
  const padded = padForPose(S.cut),
    rig = await createPoseRig(padded),
    p = padded.posePadding;
  if (p) {
    const oldWidth = S.placement.width,
      gain = (oldWidth * S.scene.width) / S.cut.width;
    const dx =
        ((padded.width / 2 - p.offsetX) / p.scale - S.cut.width / 2) * gain * (S.placement.flip ? -1 : 1),
      dy = ((padded.height / 2 - p.offsetY) / p.scale - S.cut.height / 2) * gain;
    const a = (S.placement.rotation * Math.PI) / 180;
    S.placement.x += (dx * Math.cos(a) - dy * Math.sin(a)) / S.scene.width;
    S.placement.y += (dx * Math.sin(a) + dy * Math.cos(a)) / S.scene.height;
    S.placement.width = (oldWidth * padded.width) / (p.scale * S.cut.width);
  }
  S.padded = padded;
  S.rig = rig;
  placementUI();
  $('pose-preset').value = 'original';
  $('anchors').checked = false;
}
function drawPose() {
  const c = $('rig-canvas');
  if (!S.rig) return;
  if (c.width !== S.padded.width || c.height !== S.padded.height) {
    c.width = S.padded.width;
    c.height = S.padded.height;
  }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage($('anchors').checked ? S.padded : current(), 0, 0);
  drawRig(ctx, S.rig, $('anchors').checked);
  renderer.visitorEdited();
  render();
}
function showRig() {
  drawPose();
  $('rig-message').textContent = S.rig.message || 'Drag the joints to move the person.';
  $('pose-dialog').showModal();
  notify('Pose editor ready.');
}
async function transfer(photo) {
  await poseFromPhoto(S.rig, photo);
  $('pose-preset').value = 'custom';
  $('anchors').checked = false;
  drawPose();
}
function bindPose() {
  setupGeneration({
    getGuide: () => current(),
    getJoints: () => S.rig.target,
    getReference: () => S.padded,
    apply: (cut) => {
      describeStill(cut);
      ingestPhoto(cut, S.sourceName + ' · generated', cut, null, false);
      $('pose-dialog').close();
      notify('Generated cutout applied. Use the source layer to inspect it at full size.');
    }
  });
  $('rig').onclick = () =>
    guarded(async () => {
      await prepareRig();
      showRig();
    });
  $('target-pose').onclick = () =>
    guarded(async () => {
      const ref = maskedCrop(S.scene, S.mode === 'replace' ? S.target : S.foreground);
      await prepareRig();
      await transfer(ref);
      showRig();
      $('rig-message').textContent =
        'Pose estimated from the selected scene person. Drag a joint to refine it.';
    });
  $('pose-preset').onchange = (e) => {
    applyPosePreset(S.rig, e.target.value);
    $('anchors').checked = false;
    drawPose();
  };
  $('pose-ref').onclick = () => $('pose-file').click();
  $('pose-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await transfer(await fileImage(file));
      $('rig-message').textContent = 'Reference pose applied. Drag a joint to refine it.';
    } catch (err) {
      $('rig-message').textContent = err.message;
    }
  };
  $('anchors').onchange = drawPose;
  $('rig-done').onclick = () => $('pose-dialog').close();
  const c = $('rig-canvas');
  let joint = null;
  c.onpointerdown = (e) => {
    const p = coords(e, c);
    joint = hitJoint(S.rig, p.x, p.y, (16 * c.width) / c.getBoundingClientRect().width, $('anchors').checked);
    if (joint) c.setPointerCapture(e.pointerId);
  };
  c.onpointermove = (e) => {
    if (!joint) return;
    const p = coords(e, c);
    moveJoint(S.rig, joint, p.x, p.y, $('anchors').checked);
    $('pose-preset').value = 'custom';
    if (!rigDirty) {
      rigDirty = true;
      requestAnimationFrame(() => {
        rigDirty = false;
        drawPose();
      });
    }
  };
  c.onpointerup = c.onpointercancel = () => {
    joint = null;
  };
}
function stamp() {
  if (!current()) throw Error('Add a person before keeping this layer.');
  view('composite');
  const photo = copyImage(output);
  if (S.video) freeze();
  const retained = [
    'scene',
    'name',
    'raw',
    'sourceName',
    'cut',
    'sourceMask',
    'foreground',
    'family',
    'frozenSpace',
    'target',
    'removalMargin',
    'plate',
    'frontExtra',
    'mode',
    'look',
    'manual',
    'tap',
    'tapMethod',
    'rig',
    'padded'
  ];
  const previous = Object.fromEntries(retained.map((key) => [key, S[key]]));
  previous.placement = { ...S.placement };
  S.history.push(previous);
  if (S.history.length > 8) S.history.shift();
  previous.calibration = renderer.sourceColors;
  S.scene = photo;
  S.name += ' + person';
  S.raw = S.cut = S.sourceMask = null;
  clearRig();
  S.sourceName = '';
  S.family = S.frozenSpace = null;
  clearOutlines();
  configure();
  personUI();
  selectTab('layers');
  notify('Person kept in the scene. Import the next person or start the webcam.');
}
function undoStamp() {
  const entry = S.history.pop();
  if (!entry) return;
  const { calibration, ...rest } = entry;
  stopSource();
  Object.assign(S, rest);
  document.querySelector('input[name=look][value="' + S.look + '"]').checked = true;
  configure();
  renderer.sourceColors = calibration;
  renderer.transforms = null;
  placementUI();
  personUI();
  view('composite');
  notify('Restored the previous scene and active person.');
}
function beginRecording() {
  if (recording) {
    recording.stop();
    return;
  }
  if (!window.MediaRecorder || !output.captureStream)
    throw Error('This browser cannot record canvas video. Use a current Chromium browser.');
  view('composite');
  const stream = output.captureStream(30),
    type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) =>
      MediaRecorder.isTypeSupported(t)
    );
  recording = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks = [];
  const rec = recording;
  const heartbeat = setInterval(() => render(), 100);
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.onstop = () => {
    clearInterval(heartbeat);
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType });
    download(blob, 'composition.' + (rec.mimeType.includes('mp4') ? 'mp4' : 'webm'));
    recording = null;
    $('record').querySelector('span').textContent = 'Record clip';
    timeToSave('clip');
    notify('Composite clip saved.');
  };
  rec.start(250);
  $('record').querySelector('span').textContent = 'Stop & save';
  notify('Recording the composition. Choose Stop & save to download it.');
}
function recordTake() {
  if (rawRecorder) {
    if (rawRecorder.state === 'recording') rawRecorder.stop();
    return;
  }
  if (!S.stream || !window.MediaRecorder)
    throw Error('Start the webcam in a browser with video recording support.');
  const chunks = [],
    rec = new MediaRecorder(S.stream),
    stream = S.stream;
  rawRecorder = rec;
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.onstop = async () => {
    rawRecorder = null;
    $('take').textContent = 'Record webcam take';
    const file = new File(chunks, ['visitor-take', rec.mimeType.includes('mp4') ? 'mp4' : 'webm'].join('.'), {
      type: rec.mimeType
    });
    if (!file.size) {
      notify('The webcam recording was empty. Record a longer take.', true);
      return;
    }
    download(file, file.name);
    if (S.stream === stream) {
      await guarded(() => movingSource(file));
    }
  };
  rec.start(250);
  $('take').textContent = 'Stop & replay take';
  notify('Recording the original visitor. Stop to save and replay the same motion for every treatment.');
}
function benchmark() {
  if (measuring) {
    finalizeBenchmark('Stopped by operator');
    return;
  }
  if (!S.video) throw Error('Start the webcam or import a recorded take to measure fresh frames.');
  view('composite');
  measuring = {
    frames: S.fresh,
    at: performance.now(),
    source: S.stream ? 'webcam' : 'uploaded video',
    captureFps: S.stream?.getVideoTracks()[0]?.getSettings().frameRate ?? null,
    look: S.look,
    timestamps: [],
    timestampSource: S.video.requestVideoFrameCallback
      ? 'requestVideoFrameCallback.mediaTime'
      : 'video.currentTime',
    width: S.video.videoWidth,
    height: S.video.videoHeight,
    timer: setTimeout(() => finalizeBenchmark(), 30000)
  };
  $('benchmark').textContent = 'Stop measurement';
  notify('Measuring freshly segmented, matched and displayed frames for 30 seconds. Keep this tab visible.');
}
function attach() {
  for (const btn of document.querySelectorAll('[data-tab]')) btn.onclick = () => selectTab(btn.dataset.tab);
  for (const btn of document.querySelectorAll('[data-view]'))
    btn.onclick = () => {
      if (recording || measuring) {
        notify('Finish the recording or measurement before switching views.');
        return;
      }
      view(btn.dataset.view);
    };
  for (const name of ['scene', 'person']) {
    $('open-' + name).onclick = () => $(name + '-file').click();
    $(name + '-file').onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) guarded(() => (name === 'scene' ? newScene(f) : newPerson(f)));
    };
  }
  $('camera').onclick = () => guarded(() => (S.stream ? freeze() : movingSource()));
  $('freeze').onclick = () => guarded(freeze);
  $('add').onclick = () => selectMode('add');
  $('replace').onclick = () => selectMode('replace');
  $('outline').onclick = () => editMask(S.mode === 'add' ? 'foreground' : 'target');
  $('front-extra').onclick = () => editMask('extra');
  $('source-select').onclick = () => editMask('source');
  $('scale').oninput = (e) => {
    guidedPlacement?.markManual();
    S.placement.width = Number(e.target.value) / 100;
    placementUI();
    view('composite');
  };
  $('rotation').oninput = (e) => {
    guidedPlacement?.markManual();
    S.placement.rotation = Number(e.target.value);
    placementUI();
    view('composite');
  };
  $('flip').onchange = (e) => {
    guidedPlacement?.markManual();
    S.placement.flip = e.target.checked;
    view('composite');
  };
  $('reset-place').onclick = () => {
    if (guidedPlacement) guidedPlacement.reset();
    else choosePlacement(S.mode === 'replace');
    view('composite');
  };
  for (const radio of document.querySelectorAll('input[name=look]'))
    radio.onchange = () => {
      S.look = radio.value;
      view('composite');
    };
  $('stamp').onclick = () => guarded(stamp);
  $('undo-stamp').onclick = () => guarded(undoStamp);
  $('record').onclick = () => guarded(beginRecording);
  $('take').onclick = () => guarded(recordTake);
  $('sample-take').onclick = () => guarded(sampleTake);
  $('save').onclick = () =>
    guarded(async () => {
      view('composite');
      download(await toBlob(output), 'step-into-the-photo.png');
      timeToSave();
      notify('Saved the composition as a PNG.');
    });
  trials.bind(() => {
    if (!S.scene || !S.cut) throw Error('Load the scene and visitor before timing a setup.');
    S.mode = 'add';
    S.foreground = null;
    choosePlacement();
    configure();
    personUI();
    view('composite');
    selectTab('layers');
    editMask('foreground');
  });
  $('metrics').onclick = () =>
    guarded(async () => {
      const { getVotes } = await import('./study.js');
      download(
        new Blob([JSON.stringify({ session: S.metrics, votes: getVotes() }, null, 2)], {
          type: 'application/json'
        }),
        'session-measurements.json'
      );
    });
  $('benchmark').onclick = () => guarded(benchmark);
  $('compare').onclick = () =>
    guarded(async () => {
      if (S.mode !== 'add' || !S.cut)
        throw Error('Use Add person with a visitor to compare the proposal treatments.');
      const { openComparison } = await import('./study.js'),
        cutter = new PersonCutout();
      if (S.stream) throw Error('Import a recorded take or freeze the webcam to compare identical motion.');
      notify('Preparing the comparison…');
      const v = S.video;
      if (v) v.pause();
      try {
        await openComparison({
          scene: S.scene,
          sceneName: S.name,
          sourceName: S.sourceName,
          cutout: current(),
          video: v,
          makeFrame: (el) => cutter.frame(el),
          placement: { ...S.placement },
          manualMask: S.manual,
          tapMask: S.tap,
          tapMethod: S.tapMethod
        });
      } finally {
        if (v && v === S.video) await v.play();
      }
    });
  let drag = null;
  output.onpointerdown = (e) => {
    if (!current() || S.original) return;
    const p = coords(e, output);
    drag = { ...p, sx: S.placement.x, sy: S.placement.y };
    output.setPointerCapture(e.pointerId);
  };
  output.onpointermove = (e) => {
    if (!drag) return;
    const p = coords(e, output);
    if (p.x === drag.x && p.y === drag.y) return;
    guidedPlacement?.markManual();
    S.placement.x = drag.sx + (p.x - drag.x) / output.width;
    S.placement.y = drag.sy + (p.y - drag.y) / output.height;
    render();
  };
  output.onpointerup = output.onpointercancel = () => {
    drag = null;
  };
  output.onkeydown = (e) => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (delta) {
      e.preventDefault();
      if (guidedPlacement && !current()) return;
      guidedPlacement?.markManual();
      S.placement.x += (delta[0] * (e.shiftKey ? 10 : 1)) / output.width;
      S.placement.y += (delta[1] * (e.shiftKey ? 10 : 1)) / output.height;
      view('composite');
    }
  };
  bindPose();
  bindLibrary();
  window.addEventListener('pagehide', () => {
    if (S.stream) stopLiveCamera();
  });
}
async function sampleTake(take = null) {
  const r = await fetch(take?.source || './demo/movement.mp4');
  if (!r.ok) throw Error('The sample recording could not be loaded.');
  await movingSource(new File([await r.blob()], take?.label || 'Studio dancer.mp4', { type: 'video/mp4' }));
  if (S.name === 'Kitty Hawk, 1903' && S.mode === 'add') {
    Object.assign(S.placement, { x: 0.875, y: 0.42, width: 0.183 });
    placementUI();
    render();
  }
}
async function loadFamily(item) {
  const [scene, mask] = await Promise.all(
    [item.image, item.mask].map(async (path) => copyImage(await readImage(path)))
  );
  if (mask.width !== scene.width || mask.height !== scene.height)
    throw Error('The family outline does not fit the photograph.');
  useScene(scene, item.title, item, mask);
}
async function familyCollection() {
  const res = await fetch('./families/scenes.json');
  if (!res.ok) throw Error('The family photographs could not be opened.');
  return res.json();
}
function bindLibrary() {
  let entries = null;
  function populate() {
    const split = $('collection').value;
    $('family-gallery-link').hidden = split !== 'families';
    $('library-hint').textContent =
      split === 'families'
        ? 'Each family photograph includes a foreground outline and a starting position for the visitor.'
        : split === 'development'
          ? 'Choose a scene to start a new composition with the current visitor.'
          : 'These scenes are reserved for the final comparison. Opening one starts a new composition.';
    const grid = $('library-grid');
    grid.replaceChildren();
    for (const item of entries.filter((it) => it.split === split)) {
      const button = document.createElement('button'),
        img = new Image(),
        label = document.createElement('span');
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      label.textContent = item.title;
      button.append(img, label);
      button.onclick = () =>
        guarded(async () => {
          if (item.split === 'families') await loadFamily(item);
          else useScene(copyImage(await readImage(item.image)), item.title);
          $('library-dialog').close();
        });
      grid.append(button);
    }
  }
  $('library').onclick = () =>
    guarded(async () => {
      if (!entries) {
        const r = await fetch('./scenes.json');
        if (!r.ok) throw Error('Scene library could not be opened.');
        entries = [
          ...(await r.json()),
          ...(await familyCollection()).map((item) => ({ ...item, split: 'families' }))
        ];
      }
      populate();
      $('library-dialog').showModal();
    });
  $('collection').onchange = populate;
}

function syncDemoControls() {
  const on = !!S.stream;
  const present = on || !!S.cut;
  if (!present && audience?.active) audience.exit();
  $('live-camera').disabled = !S.scene;
  $('live-camera').querySelector('span').textContent = on ? 'Stop camera' : 'Start camera';
  $('live-camera').classList.toggle('primary', !on);
  $('live-present').disabled = !present;
  $('live-present').classList.toggle('primary', present);
  $('live-person').disabled = !S.scene;
  $('live-outline').disabled = !S.scene;
  $('live-status').textContent = on ? 'Camera live' : 'Camera off';
  $('live-status').classList.toggle('on', on);
}

function bindDemo() {
  document.title = 'Live photo demo · Step Into the Photo';
  $('live-placement').append($('placement-controls'));
  $('live-message').append($('feedback').parentElement);
  audience = setupAudience({ picture: $('picture'), canvas: output });
  guidedPlacement = setupGuidedPlacement({ state: S, liveScene, renderer, refresh: configure, placementUI });
  $('visitor-exposure').oninput = (e) => {
    setExposure(Number(e.target.value));
    render();
  };
  $('auto-exposure').onclick = () => {
    setExposure(0);
    render();
  };
  $('live-photo').disabled = false;
  $('live-photo').onclick = () => $('scene-file').click();
  $('live-library').onclick = () => $('library').click();
  $('live-outline').onclick = () => editMask('foreground');
  $('live-person').onclick = () => $('person-file').click();
  $('live-camera').onclick = () =>
    guarded(async () => {
      if (S.stream) {
        stopLiveCamera();
        return;
      }
      $('live-status').textContent = 'Starting camera…';
      try {
        await movingSource();
        facts('Camera live. Choose Present full screen when you’re ready.');
      } finally {
        syncDemoControls();
      }
    });
  $('live-present').onclick = () => {
    if (S.stream || S.cut) audience.enter();
  };
  syncDemoControls();
}

function setExposure(value) {
  liveExposure = value;
  $('visitor-exposure').value = value;
  $('visitor-exposure-out').value = value ? (value > 0 ? '+' : '') + value.toFixed(1) + ' EV' : 'Auto';
}

async function openStudioSample() {
  const [scene, person, mask] = await Promise.all(
    ['kitty-hawk.jpg', 'traveler.png', 'wilbur-mask.png'].map(async (name) =>
      copyImage(await readImage('./samples/' + name))
    )
  );
  S.scene = scene;
  S.name = 'Kitty Hawk, 1903';
  S.raw = person;
  S.cut = describeStill(person);
  S.sourceName = 'Apollo 11 astronaut';
  S.foreground = mask;
  S.tap = copyImage(mask);
  S.tapMethod = 'SAM 2.1 tiny (sample)';
  S.placement = { x: 0.365, y: 0.68, width: 0.15, rotation: 0, flip: false };
  configure();
  placementUI();
  personUI();
  notify('Sample ready. Change either source layer to work with your own photographs.');
}

async function start() {
  attach();
  const familyId = new URLSearchParams(location.search).get('family');
  if (demoMode) {
    bindDemo();
    await guarded(async () => {
      const collection = await familyCollection();
      const item = collection.find((row) => row.id === (familyId || 'park-picnic'));
      if (!item) throw Error('Choose a photograph from your device or the scene library to start.');
      await loadFamily(item);
    });
  } else {
    await openStudioSample();
  }
  if (familyId && !demoMode)
    await guarded(async () => {
      const item = (await familyCollection()).find((row) => row.id === familyId);
      if (!item) throw Error('This family photograph could not be found. Choose a scene from the library.');
      await loadFamily(item);
      await sampleTake(item.take);
      notify('The recorded visitor is moving in the photograph. Choose Use webcam to take their place.');
    });
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw Error();
    const info = await res.json();
    services = info;
    $('service').textContent = info.segmenter + ' online';
  } catch {
    $('service').textContent = 'Manual editing available';
  }
}
// Development aid: ?debug=1 exposes the live state to the browser console.
if (new URLSearchParams(location.search).has('debug'))
  window.stepStudio = { S, renderer, liveScene, placement: () => guidedPlacement };
start().catch((e) => notify('Could not open the studio. ' + e.message, true));
