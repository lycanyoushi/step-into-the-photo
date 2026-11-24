export const $ = (id) => document.getElementById(id);
export function canvas(w, h) {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  return el;
}
export function copyImage(image, limit = Infinity) {
  const w = image.naturalWidth || image.videoWidth || image.width,
    h = image.naturalHeight || image.videoHeight || image.height;
  if (!w || !h) throw Error('The image has no readable pixels.');
  const scale = Math.min(1, limit / Math.max(w, h)),
    out = canvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  out.getContext('2d').drawImage(image, 0, 0, out.width, out.height);
  return out;
}
export async function readImage(url) {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw Error('This picture could not be decoded. Try a JPEG, PNG or WebP file.');
  }
  return img;
}
export async function fileImage(file, limit = 1600) {
  const url = URL.createObjectURL(file);
  try {
    return copyImage(await readImage(url), limit);
  } catch (error) {
    if (!(file instanceof File)) throw error;
    const form = new FormData();
    form.set('image', file, file.name);
    const response = await fetch('/api/decode', { method: 'POST', body: form });
    if (!response.ok) {
      const info = await response.json().catch(() => ({}));
      throw Error(info.error || 'This photograph could not be opened.');
    }
    return fileImage(await response.blob(), limit);
  } finally {
    URL.revokeObjectURL(url);
  }
}
export const toBlob = (image, type = 'image/png') =>
  new Promise((resolve, reject) =>
    image.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error('The browser could not encode this image.'))),
      type
    )
  );
export function download(blob, name) {
  const link = document.createElement('a'),
    url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}
export function notify(msg, warning = false) {
  $('feedback').textContent = msg;
  $('feedback').parentElement.classList.toggle('warn', warning);
}
export async function apiImage(path, data) {
  const form = new FormData();
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') form.set(key, value);
    else form.set(key, await toBlob(value), key + '.png');
  }
  const response = await fetch('/api/' + path, { method: 'POST', body: form });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(error.error || 'Local model returned HTTP ' + response.status + '.');
  }
  const blob = await response.blob();
  return {
    image: await fileImage(blob, Infinity),
    method:
      response.headers.get('X-Segmenter') ||
      response.headers.get('X-Inpainter') ||
      response.headers.get('X-Remover')
  };
}
export function bounds(image, alpha = false) {
  if (!image) return null;
  const { width: w, height: h } = image,
    data = image.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let left = w,
    top = h,
    right = -1,
    bottom = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + (alpha ? 3 : 0)] > 45) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return right >= left ? { x: left, y: top, w: right - left + 1, h: bottom - top + 1 } : null;
}
export function trim(image) {
  const b = bounds(image, true);
  if (!b) throw Error('No visible person was found. Use Select person to tap or trace your subject.');
  const out = canvas(b.w, b.h);
  out.getContext('2d').drawImage(image, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return out;
}
export function maskedCrop(photo, mask) {
  const box = bounds(mask);
  if (!box) throw Error('Select a person in the scene first.');
  const out = canvas(box.w, box.h),
    ctx = out.getContext('2d');
  ctx.drawImage(photo, -box.x, -box.y);
  const rgba = ctx.getImageData(0, 0, box.w, box.h),
    data = mask.getContext('2d').getImageData(box.x, box.y, box.w, box.h).data;
  for (let i = 0; i < data.length; i += 4) rgba.data[i + 3] = data[i];
  ctx.putImageData(rgba, 0, 0);
  return out;
}
export function coords(event, element) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(element.width - 1, ((event.clientX - rect.left) * element.width) / rect.width)),
    y: Math.max(0, Math.min(element.height - 1, ((event.clientY - rect.top) * element.height) / rect.height))
  };
}
const paths = {
  film: '<rect x="3" y="5" width="15" height="15" rx="2"/><path d="M8 2h12a2 2 0 0 1 2 2v12M6 16l4-4 3 3 2-2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  frame: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  move: '<path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3"/>',
  record: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-9v.1"/>',
  sliders:
    '<path d="M3 7h5m4 0h9M3 17h11m4 0h3"/><circle cx="10" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
  'person-plus': '<circle cx="9" cy="7" r="3"/><path d="M2 20v-2a7 7 0 0 1 13-3m4-6v8m-4-4h8"/>',
  swap: '<path d="M3 7h16l-4-4m6 14H5l4 4M19 7l-4 4M5 17l4-4"/>',
  cut: '<path d="m8 8 12 12M8 16 20 4"/><circle cx="5.5" cy="6.5" r="3"/><circle cx="5.5" cy="17.5" r="3"/>',
  camera: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>',
  outline: '<path stroke-dasharray="3 3" d="M4 5q7-4 11-1t4 9q3 7-5 8T3 16Q1 11 4 5Z"/>',
  person: '<circle cx="12" cy="4" r="2"/><path d="m3 7 9 3 9-3m-9 3v4m0 0-6 8m6-8 6 8"/>',
  freeze: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 8v8m6-8v8"/>',
  layers: '<path d="m12 2 10 6-10 6L2 8Zm-9 11 9 5 9-5m-18 5 9 5 9-5"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>'
};
export function icons() {
  for (const node of document.querySelectorAll('[data-icon]'))
    node.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[node.dataset.icon] || '') + '</svg>';
}
