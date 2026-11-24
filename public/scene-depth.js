import { dimensions, makeCanvas } from './canvas.js';
import { OCCLUDING_LEVELS } from './placement-plan.js';

// A white depth sample is near the camera. Keep a compact copy of the field in
// memory; changing visitor depth only reclassifies that field into an alpha mask.
export class SceneDepth {
  constructor(image) {
    const [w, h] = dimensions(image);
    const scale = Math.min(1, 800 / Math.max(w, h));
    this.canvas = makeCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    const { width, height } = this.canvas;
    this.ctx.drawImage(image, 0, 0, width, height);
    this.image = this.ctx.getImageData(0, 0, width, height);
    this.depth = new Uint8Array(width * height);
    for (let i = 0; i < this.depth.length; i++) this.depth[i] = this.image.data[i * 4];
    this.last = -1;
    this.ramp = new Uint8ClampedArray(256);
  }

  opacity(visitorDepth) {
    const level = Math.min(255, Math.max(0, Math.round(visitorDepth * 255)));
    if (this.last === level) return this.canvas;
    this.last = level;
    for (let i = 0; i < 256; i++) {
      // Depth is uncertain by a few levels, so whatever is only marginally
      // nearer leaves the visitor whole. The step is abrupt on purpose: a flat
      // surface inside a gradual ramp would half-cover the visitor everywhere
      // and turn them into a ghost. Edges stay soft through interpolation.
      const t = i - level >= OCCLUDING_LEVELS ? 1 : 0;
      this.ramp[i] = 255 * t * t * (3 - 2 * t);
    }
    const data = this.image.data;
    for (let i = 0; i < this.depth.length; i++) data[4 * i + 3] = this.ramp[this.depth[i]];
    this.ctx.putImageData(this.image, 0, 0);
    return this.canvas;
  }

  sample(x, y) {
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    const { width, height } = this.canvas;
    return (
      this.depth[
        Math.min(height - 1, Math.floor(y * height)) * width + Math.min(width - 1, Math.floor(x * width))
      ] / 255
    );
  }
}

export function visitorTransform(visitor, placement, sceneW, sceneH) {
  const [w, h] = dimensions(visitor);
  const angle = ((placement.rotation || 0) * Math.PI) / 180;
  const cx = (placement.x ?? 0.5) * sceneW,
    cy = (placement.y ?? 0.5) * sceneH;
  const scale = ((placement.width ?? 0.45) * sceneW) / w;
  const ux = Math.cos(angle) * scale,
    uy = Math.sin(angle) * scale;
  const sign = placement.flip ? -1 : 1;
  return {
    scale,
    flip: sign,
    point(x, y) {
      const dx = (x - w / 2) * sign,
        dy = y - h / 2;
      return { x: cx + ux * dx - uy * dy, y: cy + uy * dx + ux * dy };
    }
  };
}

export function depthAtSupport(field, cut, placement, w, h) {
  const contact = cut?.floorContact;
  if (!field || !contact || Math.abs(placement.rotation || 0) > 35) return null;
  const mapping = visitorTransform(cut, placement, w, h);
  const values = [];
  for (const foot of contact.supports) {
    const point = mapping.point(foot.x, foot.y);
    const offset = Math.max(2, contact.bodyHeight * mapping.scale * 0.018);
    for (const dx of [-0.35, 0, 0.35]) {
      for (const dy of [1, 2]) {
        const sample = field.sample(
          (point.x + dx * foot.width * mapping.scale) / w,
          (point.y + dy * offset) / h
        );
        if (sample !== null) values.push(sample);
      }
    }
  }
  values.sort((a, b) => a - b);
  return values.length ? (values[(values.length - 1) >> 1] + values[values.length >> 1]) * 0.5 : null;
}

// Only this rectangle must be cleared and drawn for this frame. Its coordinates
// remain in scene space so the depth image aligns after drag, flip and rotation.
export function visitorPatch(visitor, mapping, cast, reflect, w, h) {
  const [sourceWidth, sourceHeight] = dimensions(visitor);
  const b = visitor.foregroundBounds || { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  const corners = [
    mapping.point(b.x, b.y),
    mapping.point(b.x + b.width, b.y),
    mapping.point(b.x, b.y + b.height),
    mapping.point(b.x + b.width, b.y + b.height)
  ];
  let left = Math.min(...corners.map((p) => p.x)),
    top = Math.min(...corners.map((p) => p.y));
  let right = Math.max(...corners.map((p) => p.x)),
    bottom = Math.max(...corners.map((p) => p.y));
  if (cast || reflect) {
    for (const foot of visitor.floorContact.supports) {
      const point = mapping.point(foot.x, foot.y);
      if (reflect) bottom = Math.max(bottom, point.y + Math.max(0, point.y - top));
      if (cast) {
        const { rx, ry } = radii(visitor.floorContact.bodyHeight, foot.width, mapping.scale);
        left = Math.min(left, point.x - rx);
        right = Math.max(right, point.x + rx);
        bottom = Math.max(bottom, point.y + ry);
      }
    }
  }
  const x0 = Math.max(0, Math.floor(left - 3)),
    y0 = Math.max(0, Math.floor(top - 3));
  const x1 = Math.min(w, Math.ceil(right + 3)),
    y1 = Math.min(h, Math.ceil(bottom + 3));
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

let contactSprite;

function radii(bodyHeight, width, scale) {
  return {
    rx: Math.max(bodyHeight * 0.045, width * 0.8) * scale,
    ry: Math.max(1.25, bodyHeight * 0.019 * scale)
  };
}

export function contactShadows(ctx, cut, mapping, gain = 1) {
  if (!contactSprite) {
    contactSprite = makeCanvas(80, 80);
    const brush = contactSprite.getContext('2d');
    const grad = brush.createRadialGradient(40, 40, 0, 40, 40, 40);
    grad.addColorStop(0, 'rgba(0,0,0,0.25)');
    grad.addColorStop(0.42, 'rgba(0,0,0,0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    brush.fillStyle = grad;
    brush.fillRect(0, 0, 80, 80);
  }
  const { supports, bodyHeight } = cut.floorContact;
  for (const foot of supports) {
    const p = mapping.point(foot.x, foot.y);
    const { rx, ry } = radii(bodyHeight, foot.width, mapping.scale);
    ctx.drawImage(contactSprite, p.x - rx, p.y - 1.15 * ry, 2 * rx, 2 * ry);
    // A second, tighter pass deepens the crease where the shoe meets the ground.
    if (gain > 1) ctx.drawImage(contactSprite, p.x - 0.7 * rx, p.y - 0.9 * ry, 1.4 * rx, 1.4 * ry);
  }
}
