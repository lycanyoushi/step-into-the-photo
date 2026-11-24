import { canvas } from './ui.js';

let pending;

// Compare apparent face size once when fitting a visitor. A raised arm or a
// seated/cropped body changes silhouette height without changing head size.
export function faceMeter() {
  pending ??= (async () => {
    const { FilesetResolver, FaceDetector } = await import('./vendor/mediapipe/vision_bundle.mjs');
    const wasm = await FilesetResolver.forVisionTasks(
      new URL('./vendor/mediapipe/wasm', import.meta.url).href
    );
    const model = await FaceDetector.createFromOptions(wasm, {
      baseOptions: {
        modelAssetPath: new URL('./models/blaze_face_short_range.tflite', import.meta.url).href
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.55
    });
    const thumb = canvas(256, 256),
      ctx = thumb.getContext('2d');
    function search(photo, [l, t, r, b], side, ox, oy) {
      ctx.fillStyle = '#777';
      ctx.fillRect(0, 0, thumb.width, thumb.height);
      ctx.drawImage(
        photo,
        (-ox / side) * 256,
        (-oy / side) * 256,
        (photo.width / side) * 256,
        (photo.height / side) * 256
      );
      const hits = [];
      for (const det of model.detect(thumb).detections) {
        const box = det.boundingBox;
        if (!box) continue;
        const x = (ox + ((box.originX + box.width / 2) * side) / 256) / photo.width;
        const y = (oy + ((box.originY + box.height / 2) * side) / 256) / photo.height;
        const size = (box.height * side) / 256 / photo.height;
        if (x < l || y < t || x > r || y > b || size > (b - t) * 1.05) continue;
        const dx = (x - (l + r) / 2) / (r - l),
          dy = (y - t) / (b - t) - 0.23;
        hits.push({
          x,
          y,
          height: size,
          cost: dx * dx + 0.5 * dy * dy - 0.12 * (det.categories[0]?.score || 0)
        });
      }
      return hits.sort((a, b) => a.cost - b.cost)[0] || null;
    }
    return (photo, box) => {
      const [l, t, r, b] = box;
      const w = (r - l) * photo.width,
        h = (b - t) * photo.height;
      const cx = (l + r) * 0.5 * photo.width;
      const whole = Math.max(w, h) * 1.06;
      const found = search(photo, box, whole, cx - whole / 2, (t + b) * 0.5 * photo.height - whole / 2);
      if (found || h < 1.5 * w) return found;
      // The face of a full-length figure is too small in the whole-body
      // view. Look again at the head and shoulders.
      const top = Math.max(w, 0.42 * h) * 1.1;
      return search(photo, box, top, cx - top / 2, t * photo.height - 0.08 * top);
    };
  })().catch(() => null);
  return pending;
}
