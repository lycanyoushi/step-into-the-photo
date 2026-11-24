import { dimensions, makeCanvas, resize } from './canvas.js';
import { visitorTransform } from './scene-depth.js';

const buffers = new WeakMap();
const verticalScale = 0.9;

// Reflect the matched person across the horizontal waterline at the lowest visible shoe.
// Compositing onto a private matte keeps the destination photograph out of the fade.
export function drawReflection(ctx, layer, placement, contact) {
  if (!contact?.supports?.length || Math.abs(placement.rotation || 0) > 35) return;
  const [w, h] = dimensions(layer);
  const sceneW = ctx.canvas.width,
    sceneH = ctx.canvas.height;
  const transform = visitorTransform(layer, placement, sceneW, sceneH);
  const floor = Math.max(...contact.supports.map(({ x, y }) => transform.point(x, y).y));
  if (floor < 0 || floor >= sceneH) return;

  let buffer = buffers.get(ctx);
  if (!buffer) {
    buffer = makeCanvas();
    buffers.set(ctx, buffer);
  }
  // Wet sand softens the reflected contours. Render the reflection at reduced
  // resolution and magnify with interpolation; the visitor remains full resolution.
  const scale = Math.min(1, 320 / w, transform.scale * 0.68);
  resize(buffer, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const matte = buffer.getContext('2d');
  matte.clearRect(0, 0, buffer.width, buffer.height);
  matte.drawImage(layer, 0, 0, buffer.width, buffer.height);
  const foot = (contact.y * buffer.height) / h;
  const head = foot - Math.max(1, (contact.bodyHeight * buffer.height) / h);
  const fade = matte.createLinearGradient(0, head, 0, foot);
  fade.addColorStop(0, 'rgba(0,0,0,.16)');
  fade.addColorStop(0.5, 'rgba(0,0,0,.31)');
  fade.addColorStop(1, 'rgba(0,0,0,.64)');
  matte.save();
  matte.globalCompositeOperation = 'destination-in';
  matte.fillStyle = fade;
  matte.fillRect(0, 0, buffer.width, buffer.height);
  matte.restore();

  const drawW = transform.scale * w,
    drawH = transform.scale * h;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, floor, sceneW, sceneH - floor);
  ctx.clip();
  ctx.translate(0, floor);
  ctx.scale(1, -verticalScale);
  ctx.translate(0, -floor);
  ctx.translate((placement.x ?? 0.5) * sceneW, (placement.y ?? 0.5) * sceneH);
  ctx.rotate(((placement.rotation || 0) * Math.PI) / 180);
  ctx.scale(placement.flip ? -1 : 1, 1);
  ctx.drawImage(buffer, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
}
