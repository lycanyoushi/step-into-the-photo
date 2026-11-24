import { $, canvas, copyImage, coords, apiImage, bounds } from './ui.js';

export function defaultRemovalMargin(frame) {
  return Math.max(1, Math.min(20, Math.round((3 * Math.max(frame.width, frame.height)) / 850)));
}

export function expandRemovalMask(mask, radius) {
  const margin = Math.max(0, Math.min(20, Math.round(radius)));
  if (!margin) return mask;
  const out = copyImage(mask),
    ctx = out.getContext('2d');
  const w = out.width,
    h = out.height,
    stride = w + 1;
  const image = ctx.getImageData(0, 0, w, h),
    bytes = image.data;
  // An integral image tests if a square neighborhood contains any selected
  // pixel. Match the inpainting API's 128 threshold, including at the border.
  const sum = new Uint32Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += Number(bytes[(y * w + x) * 4] >= 128);
      sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + row;
    }
  }
  for (let y = 0; y < h; y++) {
    const top = Math.max(0, y - margin) * stride;
    const bottom = Math.min(h, y + margin + 1) * stride;
    for (let x = 0; x < w; x++) {
      const left = Math.max(0, x - margin),
        right = Math.min(w, x + margin + 1);
      const selected = sum[bottom + right] - sum[bottom + left] - sum[top + right] + sum[top + left] > 0;
      const i = (y * w + x) * 4;
      bytes[i] = bytes[i + 1] = bytes[i + 2] = selected ? 255 : 0;
      bytes[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

export function setupMaskEditor() {
  const dialog = $('mask-dialog'),
    view = $('mask-canvas'),
    ctx = view.getContext('2d');
  let frame,
    mask,
    tint,
    history,
    points,
    trace,
    tool,
    pending = false,
    drawing = false,
    previous,
    onApply;
  let token = 0,
    firstTap,
    tapMethod,
    manual,
    firstTime,
    started,
    baseManual = false,
    corrections = 0;
  let requiredTool, onEvidence, onCorrection, margin, removalMask;
  const fresh = () => {
    const out = canvas(frame.width, frame.height);
    const c = out.getContext('2d');
    c.fillStyle = 'black';
    c.fillRect(0, 0, out.width, out.height);
    return out;
  };
  function setTool(next) {
    tool = next;
    for (const btn of $('mask-tools').querySelectorAll('[data-tool]'))
      btn.setAttribute('aria-pressed', String(btn.dataset.tool === tool));
    $('close-trace').hidden = tool !== 'trace';
    $('mask-hint').textContent = {
      tap: 'Tap inside the subject. Extra taps refine the same outline.',
      exclude: 'Tap a neighboring area that should be excluded.',
      paint: 'Paint over missing pixels. Brush size is measured in photo pixels.',
      erase: 'Paint over pixels to remove them from the outline.',
      trace: 'Click around the silhouette, then choose Close trace to fill it.'
    }[tool];
  }
  function draw(recolor = true) {
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(frame, 0, 0);
    if (recolor) {
      tint = copyImage(mask);
      const t = tint.getContext('2d'),
        data = t.getImageData(0, 0, tint.width, tint.height);
      removalMask = margin === null ? null : expandRemovalMask(mask, margin);
      const expanded =
        margin > 0 ? removalMask.getContext('2d').getImageData(0, 0, tint.width, tint.height).data : null;
      for (let i = 0; i < data.data.length; i += 4) {
        const val = data.data[i];
        const padding = expanded && val < 128 && expanded[i] >= 128;
        data.data[i] = padding ? 255 : 183;
        data.data[i + 1] = padding ? 156 : 252;
        data.data[i + 2] = padding ? 39 : 82;
        data.data[i + 3] = padding ? 215 : margin === null ? val * 0.48 : val >= 128 ? 122 : 0;
      }
      t.putImageData(data, 0, 0);
    }
    ctx.drawImage(tint, 0, 0);
    const unit = Math.max(1, view.width / 500);
    if (trace.length) {
      ctx.beginPath();
      ctx.moveTo(trace[0].x, trace[0].y);
      for (const p of trace.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.lineWidth = unit * 2;
      ctx.strokeStyle = '#edff80';
      ctx.stroke();
    }
    for (const p of [...points, ...trace]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, unit * 3, 0, 2 * Math.PI);
      ctx.fillStyle = p.label === 0 ? '#ff765c' : '#edff80';
      ctx.fill();
      ctx.strokeStyle = '#273416';
      ctx.lineWidth = unit;
      ctx.stroke();
    }
  }
  function save() {
    history.push({ mask: copyImage(mask), points: [...points], baseManual });
    if (history.length > 10) history.shift();
  }
  function time() {
    if (firstTime === null && bounds(mask)) firstTime = performance.now() - started;
  }
  function correction(action) {
    corrections++;
    onCorrection?.(action);
  }
  function evidence(method, image, segmenter) {
    time();
    onEvidence?.(method, image, segmenter);
    if (requiredTool === method) {
      requiredTool = null;
      busy(false);
    }
  }
  function busy(value) {
    pending = value;
    for (const el of dialog.querySelectorAll('button:not(form button),input')) el.disabled = value;
    if (!value && requiredTool) {
      for (const btn of $('mask-tools').querySelectorAll('[data-tool]'))
        btn.disabled = btn.dataset.tool !== requiredTool;
      $('mask-apply').disabled = true;
    }
  }
  function closeTrace() {
    if (trace.length < 3) throw Error('Place at least three points around the person.');
    const unassisted = baseManual && !bounds(mask);
    save();
    const c = mask.getContext('2d');
    c.beginPath();
    c.moveTo(trace[0].x, trace[0].y);
    for (const p of trace.slice(1)) c.lineTo(p.x, p.y);
    c.closePath();
    c.fillStyle = 'white';
    c.fill();
    trace = [];
    draw();
    if (!bounds(mask)) throw Error('Trace a region with visible area.');
    time();
    if (!manual && unassisted) {
      manual = copyImage(mask);
      evidence('trace', manual, 'Hand trace');
    } else correction('additional trace');
  }
  function brush(p) {
    const c = mask.getContext('2d'),
      radius = Number($('brush').value);
    c.strokeStyle = c.fillStyle = tool === 'paint' ? 'white' : 'black';
    c.lineWidth = 2 * radius;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(previous.x, previous.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    c.beginPath();
    c.arc(p.x, p.y, radius, 0, 2 * Math.PI);
    c.fill();
    previous = p;
    draw();
  }
  view.onpointerdown = async (event) => {
    if (pending) return;
    const p = coords(event, view);
    if (tool === 'trace') {
      trace.push(p);
      draw(false);
      return;
    }
    if (tool === 'paint' || tool === 'erase') {
      save();
      view.setPointerCapture(event.pointerId);
      drawing = true;
      previous = p;
      brush(p);
      return;
    }
    if (tool === 'exclude' && !points.length) {
      $('mask-hint').textContent = 'Tap inside the subject first, then add an exclusion point.';
      return;
    }
    const currentToken = token,
      next = [...points, { x: Math.round(p.x), y: Math.round(p.y), label: tool === 'tap' ? 1 : 0 }];
    busy(true);
    $('mask-hint').textContent = 'Finding the outline locally…';
    try {
      const result = await apiImage('segment', { image: frame, points: JSON.stringify(next) });
      if (token !== currentToken) return;
      save();
      points = next;
      mask = result.image;
      baseManual = false;
      draw();
      if (!firstTap && points.length === 1) {
        firstTap = copyImage(mask);
        tapMethod = result.method || 'point selection';
        evidence('tap', firstTap, tapMethod);
      } else correction('point refinement');
      time();
      $('mask-hint').textContent =
        (result.method || 'Selection') + ' outline ready. Add points or use the brush to refine it.';
    } catch (err) {
      if (token === currentToken)
        $('mask-hint').textContent = err.message + ' You can also hand trace or brush the outline.';
    } finally {
      if (token === currentToken) busy(false);
    }
  };
  view.onpointermove = (e) => {
    if (drawing) brush(coords(e, view));
  };
  function endBrush() {
    if (drawing) {
      drawing = false;
      time();
      baseManual = false;
      correction(tool === 'paint' ? 'brush addition' : 'brush removal');
    }
  }
  view.onpointerup = endBrush;
  view.onpointercancel = endBrush;
  $('removal-margin').oninput = (event) => {
    margin = Number(event.target.value);
    $('removal-margin-out').value = margin + ' px';
    draw();
  };
  for (const el of $('mask-tools').querySelectorAll('[data-tool]'))
    el.onclick = () => {
      const next = el.dataset.tool;
      if (trace.length && next !== 'trace') {
        $('mask-hint').textContent = 'Close the current trace, or undo its points first.';
        return;
      }
      if (next === 'trace' && !baseManual) {
        save();
        mask = fresh();
        points = [];
        baseManual = true;
        draw();
      }
      setTool(next);
    };
  $('close-trace').onclick = () => {
    try {
      closeTrace();
    } catch (e) {
      $('mask-hint').textContent = e.message;
    }
  };
  $('mask-clear').onclick = () => {
    if (bounds(mask) || trace.length) correction('cleared outline');
    save();
    mask = fresh();
    points = [];
    trace = [];
    baseManual = true;
    draw();
  };
  $('mask-undo').onclick = () => {
    if (trace.length) {
      trace.pop();
      correction('undid trace point');
      draw(false);
      return;
    }
    const last = history.pop();
    if (last) {
      ({ mask, points, baseManual } = last);
      correction('undid edit');
      draw();
    }
  };
  $('mask-apply').onclick = async () => {
    const currentToken = token;
    try {
      if (trace.length) closeTrace();
      const data = {
        mask: bounds(mask) ? copyImage(mask) : null,
        removalMask,
        removalMargin: margin,
        isCurrent: () => currentToken === token && dialog.open,
        firstTap,
        tapMethod,
        manual,
        firstTime,
        elapsed: performance.now() - started,
        corrections
      };
      busy(true);
      $('mask-hint').textContent = 'Applying this outline…';
      await onApply(data);
      if (currentToken === token) dialog.close();
    } catch (e) {
      if (currentToken === token) $('mask-hint').textContent = e.message;
    } finally {
      if (currentToken === token) busy(false);
    }
  };
  dialog.addEventListener('close', () => {
    token++;
    busy(false);
    drawing = false;
  });
  return function open({
    title,
    image,
    initial,
    apply,
    method = null,
    removalMargin = null,
    evidenceReady = null,
    corrected = null
  }) {
    token++;
    frame = image;
    onApply = apply;
    view.width = image.width;
    view.height = image.height;
    mask = initial ? copyImage(initial) : fresh();
    history = [];
    points = [];
    trace = [];
    firstTap = null;
    tapMethod = null;
    manual = null;
    firstTime = null;
    baseManual = !initial;
    corrections = 0;
    started = performance.now();
    onEvidence = evidenceReady;
    onCorrection = corrected;
    requiredTool = method;
    margin = removalMargin;
    $('removal-margin-controls').hidden = margin === null;
    if (margin !== null) {
      $('removal-margin').value = margin;
      $('removal-margin-out').value = margin + ' px';
    }
    $('mask-title').textContent = title;
    busy(false);
    setTool(method || 'tap');
    draw();
    dialog.showModal();
  };
}
