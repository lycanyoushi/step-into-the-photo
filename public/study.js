import { makeCanvas, dimensions } from './canvas.js';
import { SceneRenderer } from './engine.js';

const fps = 12;
const votes = [];
let active;
export const getVotes = () => structuredClone(votes);

const groups = {
  outlines: ['B', 'C'],
  tones: ['C', 'Simple', 'D'],
  flat: ['A']
};

function drawCopy(source, maxSize) {
  const [w, h] = dimensions(source);
  const factor = Math.min(1, maxSize / Math.max(w, h));
  const canvas = makeCanvas(Math.max(1, Math.round(w * factor)), Math.max(1, Math.round(h * factor)));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function asPNG(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error('Could not encode the image.'))),
      'image/png'
    )
  );
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function waitForVideo(video, event, signal, action) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(Error('The browser could not read the recorded take.'));
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(failed, 15000);
    video.addEventListener(event, ready);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', aborted);
    action();
  });
}

async function sampleTake(input, makeFrame, signal, progress) {
  if (!makeFrame || input.srcObject) throw Error('Use an uploaded recording for a moving comparison.');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const fileURL = input instanceof Blob ? URL.createObjectURL(input) : null;
  const src = fileURL || input.currentSrc || input.src;
  const seek = (t) =>
    waitForVideo(video, 'seeked', signal, () => {
      video.currentTime = t;
    });
  try {
    await waitForVideo(video, 'loadeddata', signal, () => {
      video.src = src;
    });
    if (!Number.isFinite(video.duration)) {
      // Browser-recorded WebM files may omit duration from the container.
      await seek(1e8);
      await seek(0);
    }
    if (!(video.duration > 0 && Number.isFinite(video.duration))) {
      throw Error('This recording has no readable duration. Try an MP4 or WebM with a duration.');
    }
    const count = Math.max(1, Math.ceil(Math.min(10, video.duration) * fps));
    const frames = [];
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted();
      if (i) await seek(i / fps);
      const cutout = await makeFrame(video);
      signal.throwIfAborted();
      // Lossless compressed cutouts bound RAM more tightly than 120 RGBA
      // canvases. All panels decode this exact same frame at each timestamp.
      frames.push(await asPNG(drawCopy(cutout, 480)));
      progress(i + 1, count);
    }
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();
    if (fileURL) URL.revokeObjectURL(fileURL);
  }
}

function shuffled(items) {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// Canvas captureStream records wall time and can drop slow frames. Give the
// encoder an explicit presentation timestamp for every sampled source frame.
async function encodeClip(frameCount, draw, signal, progress) {
  if (!window.VideoEncoder)
    throw Error('Clip export needs WebCodecs. Open this studio in Chrome or Edge on localhost.');
  const { Muxer, ArrayBufferTarget } = await import('./vendor/webm-muxer-5.1.4/webm-muxer.mjs');
  const first = await draw(0);
  const config = {
    codec: 'vp8',
    width: first.width,
    height: first.height,
    bitrate: Math.max(1000000, first.width * first.height * 6),
    framerate: fps
  };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) {
    throw Error('This browser cannot encode VP8 for these dimensions. Try Chrome or Edge.');
  }
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'V_VP8', width: first.width, height: first.height, frameRate: fps }
  });
  let failure;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => {
      failure = error;
    }
  });
  try {
    encoder.configure(config);
    for (let i = 0; i < frameCount; i++) {
      signal.throwIfAborted();
      if (failure) throw failure;
      const canvas = i ? await draw(i) : first;
      const timestamp = Math.round((i * 1e6) / fps);
      const frame = new VideoFrame(canvas, {
        timestamp,
        duration: Math.round(((i + 1) * 1e6) / fps) - timestamp
      });
      try {
        encoder.encode(frame, { keyFrame: i % (2 * fps) === 0 });
      } finally {
        frame.close();
      }
      if (encoder.encodeQueueSize >= 4) await encoder.flush();
      progress(i + 1, frameCount);
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/webm' });
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

export async function openComparison({
  scene,
  cutout,
  video,
  makeFrame,
  placement,
  manualMask,
  tapMask,
  tapMethod = '',
  sceneName = '',
  sourceName = ''
}) {
  const dialog = document.querySelector('#comparison-dialog');
  const content = document.querySelector('#compare-content');
  if (!scene || (!video && !cutout)) throw Error('Choose a scene and a visitor first.');
  active?.abort();
  const controller = (active = new AbortController());
  const { signal } = controller;
  const frozenScene = drawCopy(scene, 720);
  const fixedPlacement = { ...placement, mode: 'add' };
  const status = document.createElement('p');
  status.className = 'help';
  status.setAttribute('role', 'status');
  status.textContent = 'Preparing comparison…';
  content.replaceChildren(status);
  dialog.addEventListener('close', () => controller.abort(), { once: true, signal });
  if (!dialog.open) dialog.showModal();

  let frames;
  try {
    frames = video
      ? await sampleTake(video, makeFrame, signal, (done, total) => {
          status.textContent = `Extracting the recorded take · ${done} / ${total} frames`;
        })
      : [await asPNG(drawCopy(cutout, 720))];
    signal.throwIfAborted();
  } catch (error) {
    if (!signal.aborted) status.textContent = error.message;
    return;
  }

  content.insertAdjacentHTML(
    'afterbegin',
    `
    <div class="tools"><label>Comparison <select data-group>
      <option value="outlines">Outlines</option><option value="tones">Photographic look</option>
      <option value="flat">Flat overlay example</option></select></label></div>
    <div class="comparison-grid"></div>
    <div class="tools" data-timeline><button data-play>Play</button><label>Frame
      <input type="range" data-frame min="0" value="0"></label><output data-time></output></div>
    <div data-feedback><label>Which view looks more convincing?
      <select data-choice></select></label><label style="display:block;margin-top:10px">
      What caught your eye first?<textarea data-notes rows="2"></textarea></label>
      <div class="tools"><button data-vote>Save vote</button><button data-next>New viewer</button></div></div>
    <div class="tools"><label>Export <select data-export></select></label><button data-png>Save PNG</button>
      <button data-clip>Save WebM clip</button></div>`
  );
  const find = (selector) => content.querySelector(selector);
  const group = find('[data-group]'),
    grid = find('.comparison-grid'),
    choice = find('[data-choice]');
  const exportChoice = find('[data-export]'),
    slider = find('[data-frame]'),
    notes = find('[data-notes]');
  group.options[0].disabled = !manualMask || !tapMask;
  group.options[1].disabled = !tapMask;
  group.value = manualMask && tapMask ? 'outlines' : tapMask ? 'tones' : 'flat';
  slider.max = frames.length - 1;
  find('[data-timeline]').hidden = frames.length === 1;
  find('[data-clip]').hidden = frames.length === 1;
  let panels,
    order,
    trial,
    playing = false,
    exporting = false,
    generation = 0,
    renderedIndex = 0;
  const first = await createImageBitmap(frames[0]);
  if (signal.aborted) {
    first.close();
    return;
  }
  signal.addEventListener(
    'abort',
    () => {
      playing = false;
      first.close();
      frames.length = 0;
    },
    { once: true }
  );

  function pause() {
    playing = false;
    find('[data-play]').textContent = 'Play';
    generation++;
  }
  function paint(frame) {
    for (const p of panels) p.engine.render(frame, { ...fixedPlacement, look: p.look });
  }
  async function show(index, token) {
    const image = index ? await createImageBitmap(frames[index]) : first;
    try {
      if (signal.aborted || token !== generation) return false;
      paint(image);
      renderedIndex = index;
      slider.value = index;
      find('[data-time]').textContent = `${index + 1} / ${frames.length}`;
      return true;
    } finally {
      if (index) image.close();
    }
  }
  function newTrial() {
    pause();
    trial = crypto.randomUUID();
    order = shuffled(groups[group.value]);
    grid.replaceChildren();
    choice.replaceChildren(new Option('Choose a view…', ''));
    exportChoice.replaceChildren(new Option('All views', 'all'));
    panels = order.map((id, i) => {
      const canvas = makeCanvas(),
        engine = new SceneRenderer(canvas);
      engine.setScene(frozenScene);
      engine.setForeground(id === 'A' ? null : id === 'B' ? manualMask : tapMask);
      engine.setReference(id === 'A' ? null : id === 'B' ? manualMask : tapMask);
      const figure = document.createElement('figure'),
        caption = document.createElement('figcaption');
      const label = group.value === 'flat' ? 'Flat overlay' : `View ${i + 1}`;
      caption.textContent = label;
      canvas.style.cssText = 'display:block;width:100%;height:auto';
      figure.append(caption, canvas);
      grid.append(figure);
      choice.add(new Option(label, String(i)));
      exportChoice.add(new Option(label, String(i)));
      return { canvas, engine, look: id === 'D' ? 'matched' : id === 'Simple' ? 'simple' : 'untreated' };
    });
    choice.add(new Option('No difference', 'tie'));
    notes.value = '';
    find('[data-vote]').disabled = false;
    find('[data-feedback]').hidden = group.value === 'flat';
    status.textContent = [
      !tapMask ? 'Save a first tap in the foreground editor to compare looks.' : '',
      !manualMask ? 'Save a hand trace to compare outlines.' : '',
      video ? `${frames.length} shared samples at ${fps} fps.` : 'Still photograph.'
    ]
      .filter(Boolean)
      .join(' ');
    // Every transfer calibrates on the same first visitor, including when a
    // viewer scrubs directly to a later time or exports a single variant.
    show(0, generation);
  }
  newTrial();
  group.onchange = newTrial;
  find('[data-next]').onclick = newTrial;
  slider.oninput = () => {
    pause();
    show(Number(slider.value), generation);
  };
  find('[data-play]').onclick = async () => {
    if (playing) {
      pause();
      return;
    }
    playing = true;
    const token = ++generation;
    find('[data-play]').textContent = 'Pause';
    let next = renderedIndex === frames.length - 1 ? 0 : renderedIndex + 1;
    while (playing && !signal.aborted && generation === token) {
      const start = performance.now();
      if (!(await show(next, token))) break;
      next = (next + 1) % frames.length;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 1000 / fps - (performance.now() - start)))
      );
    }
  };
  find('[data-vote]').onclick = () => {
    if (!choice.value) {
      status.textContent = 'Choose a view or No difference before saving.';
      return;
    }
    const selection = choice.value === 'tie' ? 'tie' : order[Number(choice.value)];
    votes.push({
      trial,
      recordedAt: new Date().toISOString(),
      scene: sceneName,
      source: sourceName,
      comparison: group.value,
      order: [...order],
      choice: selection,
      comments: notes.value.trim(),
      tapMethod,
      placement: { ...fixedPlacement },
      sourceFrames: frames.length,
      fps: video ? fps : null
    });
    find('[data-vote]').disabled = true;
    status.textContent = 'Vote saved in session measurements.';
  };

  function sheet() {
    const selected = exportChoice.value === 'all' ? panels : [panels[Number(exportChoice.value)]];
    const strip = makeCanvas(frozenScene.width * selected.length, frozenScene.height);
    const ctx = strip.getContext('2d');
    selected.forEach(({ canvas }, i) => ctx.drawImage(canvas, i * frozenScene.width, 0));
    return strip;
  }
  const fileStem = () =>
    `comparison-${trial.slice(0, 8)}-${exportChoice.value === 'all' ? 'all' : 'view-' + (Number(exportChoice.value) + 1)}`;
  find('[data-png]').onclick = async () => {
    pause();
    const file = await asPNG(sheet());
    if (!signal.aborted) download(file, `${fileStem()}-frame-${renderedIndex + 1}.png`);
  };
  find('[data-clip]').onclick = async () => {
    if (exporting) return;
    exporting = true;
    pause();
    const restore = renderedIndex,
      token = generation;
    const controls = [...content.querySelectorAll('input, button, select')].filter(
      (control) => !control.disabled
    );
    controls.forEach((control) => {
      control.disabled = true;
    });
    try {
      const blob = await encodeClip(
        frames.length,
        async (i) => {
          await show(i, token);
          signal.throwIfAborted();
          return sheet();
        },
        signal,
        (i, n) => {
          status.textContent = `Encoding frame ${i} / ${n}…`;
        }
      );
      signal.throwIfAborted();
      download(blob, fileStem() + '.webm');
      status.textContent = `Saved ${frames.length} frames at ${fps} fps.`;
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message;
    } finally {
      if (!signal.aborted) {
        await show(restore, token);
        controls.forEach((control) => {
          control.disabled = false;
        });
      }
      exporting = false;
    }
  };
}
