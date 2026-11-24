import { dimensions, makeCanvas, maskToAlpha, resize } from './canvas.js';
import { SceneDepth, visitorTransform, visitorPatch, depthAtSupport, contactShadows } from './scene-depth.js';
import { drawReflection } from './reflection.js';
import { PhotographicMatch, applyPhotographic } from './photographic.js';
import { Harmony } from './harmony.js';
import { PrintTexture } from './print-texture.js';
import {
  blurFilter,
  canFilter,
  castShadow,
  edgeWidth,
  lightWrap,
  pictureFrame,
  printTone,
  visitorTone
} from './finish.js';
import {
  applyMatched,
  applySimple,
  makeMatchedTransfer,
  makeSimpleTransfer,
  measureColors
} from './color.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const BANDS = 6;
const ANALYSIS = 256;
// How much of the measured colour change to apply. Slightly under full
// strength keeps skin and clothing recognisably the visitor's own.
const HARMONY = 0.9;
// Without a measured light direction, a short soft shadow toward the viewer
// reads as the pool of shade below a person under open sky.
const OPEN_SHADE = { dx: 0.16, dy: 0.1, strength: 0.3, softness: 0.05 };

export class SceneRenderer {
  constructor(outputCanvas) {
    this.output = outputCanvas;
    this.ctx = outputCanvas.getContext('2d');
    this.workspace = makeCanvas();
    this.workCtx = this.workspace.getContext('2d', { willReadFrequently: true });
    this.scene = null;
    this.onUpdate = null;
    this.harmony = new Harmony(() => this.onUpdate?.());
    this.light = { ...OPEN_SHADE };
    this.resetMatch();
  }

  setScene(image) {
    const [width, height] = dimensions(image);
    if (!width || !height) throw new Error('The scene image is not ready.');
    resize(this.output, width, height);
    this.scene = image;
    this.foreground = null;
    this.depthField = null;
    this.plate = null;
    this.focus = null;
    this.printTexture = null;
    this.peopleTone = null;
    this.exposureTrim = null;
    this.ramp = printTone(image);
    this.frame = pictureFrame(image);
    this.light = { ...OPEN_SHADE };
    this.sceneColors = measureColors(image);
    this.targetColors = this.sceneColors;
    this.resetMatch();
  }

  setCleanPlate(image) {
    this.plate = image;
  }

  setDepthMap(image) {
    this.depthField = image ? new SceneDepth(image) : null;
    this.focus = null;
  }

  setLight(light) {
    if (light) this.light = { ...this.light, ...light };
  }

  // The visitor's own pixels changed without moving, as after a pose edit.
  visitorEdited() {
    this.harmony.invalidate();
    this.visitorFocus = null;
    if (this.printTexture) this.printTexture.sample = null;
  }

  // Linear brightness of consistently backlit people in the scene, or null.
  setPeopleTone(tone) {
    this.peopleTone = tone > 0 ? tone : null;
    this.exposureTrim = null;
  }

  // Reduce a large residual brightness gap in a strongly backlit scene.
  trimExposure(pixels, measured) {
    const prior = this.exposureTrim;
    if (prior?.measured === measured) return prior.value;
    let value = 0;
    const own = this.peopleTone ? visitorTone(pixels) : null;
    if (own) {
      const stops = Math.log2(this.peopleTone / own);
      if (stops < -0.9) value = Math.max(-1.5, 0.62 * stops);
    }
    // A live visitor's tone varies a little with pose. Move gradually.
    if (prior) value = prior.value + 0.5 * (value - prior.value);
    value = Math.round(value * 10) / 10;
    this.exposureTrim = { measured, value };
    return value;
  }

  depthAtFeet(visitor, placement = {}) {
    return depthAtSupport(this.depthField, visitor, placement, this.output.width, this.output.height);
  }

  setForeground(mask) {
    this.foreground = null;
    this.harmony.invalidate();
    if (!mask || !this.scene) return;
    const { width, height } = this.output;
    const foreground = makeCanvas(width, height);
    const ctx = foreground.getContext('2d');
    ctx.drawImage(this.scene, 0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(insetMask(mask, width, height), 0, 0);
    this.foreground = foreground;
  }

  setReference(mask) {
    this.targetColors =
      mask && this.scene ? measureColors(this.scene, mask) || this.sceneColors : this.sceneColors;
    // A refined reference should reuse the same source calibration frame.
    this.transforms = null;
  }

  resetMatch() {
    this.sourceColors = null;
    this.transforms = null;
    this.photographic = null;
    this.visitorFocus = null;
    this.exposureTrim = null;
    this.harmony.reset();
    if (this.printTexture) this.printTexture.sample = null;
  }

  // Ask the local model how this photograph would render the visitor where
  // they now stand. The request shows the untreated visitor with the same
  // occlusion as the final picture, inside a window of surrounding context.
  measureHarmony(visitor, placement, background, depth, live) {
    const { width: w, height: h } = this.output;
    const mapping = visitorTransform(visitor, placement, w, h);
    const [bx, by, bw, bh] = visitorPatch(visitor, mapping, false, false, w, h);
    if (bw < 8 || bh < 8) return;
    const occlude = this.depthField && Number.isFinite(depth) && depth < 1;
    const key = [
      Math.round(placement.x * 40),
      Math.round(placement.y * 40),
      Math.round(placement.width * 60),
      placement.flip,
      occlude ? Math.round(depth * 12) : 'open',
      background === this.scene ? 'scene' : 'plate'
    ].join(',');
    this.harmonyKey = key;
    if (!this.harmony.wants(key, live, performance.now())) return;
    const side = Math.max(2.6 * Math.max(bw, bh), 0.45 * Math.min(w, h));
    const ww = Math.min(w, side),
      wh = Math.min(h, side);
    const wx = clamp(bx + bw / 2 - ww / 2, 0, w - ww),
      wy = clamp(by + bh / 2 - wh / 2, 0, h - wh);
    this.analysis ??= [makeCanvas(ANALYSIS, ANALYSIS), makeCanvas(ANALYSIS, ANALYSIS), makeCanvas(ANALYSIS, ANALYSIS)];
    const [cover, composite, coverage] = this.analysis;
    const ctx = cover.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, ANALYSIS, ANALYSIS);
    ctx.setTransform(ANALYSIS / ww, 0, 0, ANALYSIS / wh, (-wx * ANALYSIS) / ww, (-wy * ANALYSIS) / wh);
    drawVisitor(ctx, visitor, placement, w, h);
    ctx.globalCompositeOperation = 'destination-out';
    if (occlude) ctx.drawImage(this.depthField.opacity(depth), 0, 0, w, h);
    if (this.foreground) ctx.drawImage(this.foreground, 0, 0, w, h);
    const [sw, sh] = dimensions(background);
    const picture = composite.getContext('2d');
    picture.drawImage(background, (wx * sw) / w, (wy * sh) / h, (ww * sw) / w, (wh * sh) / h, 0, 0, ANALYSIS, ANALYSIS);
    picture.drawImage(cover, 0, 0);
    const matte = coverage.getContext('2d');
    matte.globalCompositeOperation = 'copy';
    matte.drawImage(cover, 0, 0);
    matte.globalCompositeOperation = 'source-in';
    matte.fillStyle = '#fff';
    matte.fillRect(0, 0, ANALYSIS, ANALYSIS);
    matte.globalCompositeOperation = 'destination-over';
    matte.fillStyle = '#000';
    matte.fillRect(0, 0, ANALYSIS, ANALYSIS);
    this.harmony.measure(key, composite, coverage);
  }

  prepareVisitor(visitor, look, placement, background) {
    let photographicCurve, table;
    const monochrome = this.ramp;
    const manual = placement.exposure || 0;
    if (look === 'natural')
      table = this.harmony.table(HARMONY, manual + (this.exposureTrim?.value || 0), monochrome);
    if (table) {
      // The measured table already contains exposure, balance and contrast.
    } else if (look === 'photographic' || look === 'natural') {
      const box = visitor.foregroundBounds;
      const [vw, vh] = dimensions(visitor);
      // Wait for a visible visitor. The first frame on an empty webcam may
      // contain only a few uncertain pixels, or just the hand entering first.
      if (box && (box.width < vw * 0.035 || box.height < vh * 0.12)) return visitor;
      const prior = this.photographic?.bounds;
      const startedSmall = prior && prior.width * prior.height < 0.1 * vw * vh;
      const filledFrame = box && startedSmall && box.width * box.height > 3 * prior.width * prior.height;
      if (!this.photographic || this.photographic.scene !== background || filledFrame) {
        const match = new PhotographicMatch(visitor, background, box);
        if (!match.source) return visitor;
        this.photographic = match;
      }
      photographicCurve = this.photographic.transfer(placement, this.sceneColors?.monochrome);
      if (!photographicCurve) return visitor;
    } else {
      if (!this.sourceColors) this.sourceColors = measureColors(visitor);
      if (look === 'untreated' || !this.sourceColors || !this.targetColors) return visitor;
    }
    if (!this.transforms) this.transforms = {};
    const [w, h] = dimensions(visitor);
    resize(this.workspace, w, h);
    const ctx = this.workCtx;
    ctx.clearRect(0, 0, w, h);
    const rect = visitor.foregroundBounds || { x: 0, y: 0, width: w, height: h };
    ctx.drawImage(visitor, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    const pixels = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    if (table) {
      if (this.peopleTone && this.exposureTrim?.measured !== this.harmony.to) {
        // A new measurement: judge its colours on their own, then add the
        // correction toward the photographed people.
        const trial = new Uint8ClampedArray(pixels.data);
        applyMatched(trial, this.harmony.table(HARMONY, 0, monochrome));
        table = this.harmony.table(HARMONY, manual + this.trimExposure(trial, this.harmony.to), monochrome);
      }
      applyMatched(pixels.data, table);
    } else if (photographicCurve) {
      applyPhotographic(pixels, photographicCurve);
    } else if (look === 'simple') {
      if (!('simple' in this.transforms)) {
        this.transforms.simple = makeSimpleTransfer(this.sourceColors, this.targetColors);
      }
      applySimple(pixels.data, this.transforms.simple);
    } else {
      this.transforms.matched ??= makeMatchedTransfer(this.sourceColors, this.targetColors);
      applyMatched(pixels.data, this.transforms.matched);
    }
    ctx.putImageData(pixels, rect.x, rect.y);
    this.workspace.foregroundBounds = visitor.foregroundBounds;
    this.workspace.floorContact = visitor.floorContact;
    return this.workspace;
  }

  // The sharpest edges of the photograph, per depth band, in scene pixels.
  sceneFocus(depth) {
    if (!this.focus) {
      const { width: w, height: h } = this.output;
      const probe = makeCanvas(w, h);
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(this.scene, 0, 0, w, h);
      const image = ctx.getImageData(0, 0, w, h);
      const field = this.depthField;
      const bands = [];
      if (field) {
        for (let band = 0; band < BANDS; band++)
          bands.push(
            edgeWidth(image, (p, x, y) => Math.min(BANDS - 1, Math.floor(field.sample(x / w, y / h) * BANDS)) === band)
          );
      }
      this.focus = { all: edgeWidth(image), bands };
    }
    const { all, bands } = this.focus;
    if (!bands.length || !Number.isFinite(depth)) return all;
    const band = clamp(Math.floor(depth * BANDS), 0, BANDS - 1);
    return bands[band] ?? bands[band + 1] ?? bands[band - 1] ?? all;
  }

  // Extra blur, in scene pixels, that brings the visitor's edges to the same
  // width as the photograph's at this depth. A sharper visitor reads as pasted.
  focusBlur(layer, mapping, rect, depth, live) {
    if (!canFilter) return 0;
    const scene = this.sceneFocus(depth);
    if (!scene) return 0;
    const now = performance.now();
    const key = Math.round(mapping.scale * 20);
    const prior = this.visitorFocus;
    if (!prior || prior.key !== key || (live && now - prior.at > 1100)) {
      const [, , w, h] = rect;
      if (w < 12 || h < 12) return 0;
      const shrink = Math.min(1, 520 / Math.max(w, h));
      this.focusProbe ??= makeCanvas();
      resize(this.focusProbe, Math.max(8, Math.round(w * shrink)), Math.max(8, Math.round(h * shrink)));
      const ctx = this.focusProbe.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, this.focusProbe.width, this.focusProbe.height);
      const b = layer.foregroundBounds || { x: 0, y: 0, width: layer.width, height: layer.height };
      ctx.drawImage(layer, b.x, b.y, b.width, b.height, 0, 0, this.focusProbe.width, this.focusProbe.height);
      const image = ctx.getImageData(0, 0, this.focusProbe.width, this.focusProbe.height);
      const measured = edgeWidth(image, null, true);
      let sigma = measured ? measured / shrink : null;
      // Movement blurs single frames. Keep the sharpest recent measurement.
      if (prior?.key === key && prior.sigma != null)
        sigma = sigma == null ? prior.sigma : Math.min(sigma, prior.sigma * 1.12);
      this.visitorFocus = { key, at: now, sigma };
    }
    const own = this.visitorFocus.sigma;
    if (own == null) return 0;
    const extra = Math.sqrt(Math.max(0, scene * scene - own * own));
    return extra < 0.7 ? 0 : Math.min(6, extra);
  }

  render(
    visitor,
    {
      mode = 'add',
      look = 'untreated',
      x = 0.5,
      y = 0.5,
      width = 0.45,
      rotation = 0,
      flip = false,
      exposure = 0,
      depth = null,
      grounded = false,
      reflection = false,
      live = false
    } = {}
  ) {
    if (!this.scene) return;
    const w = this.output.width,
      h = this.output.height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const background = mode === 'replace' && this.plate ? this.plate : this.scene;
    ctx.drawImage(background, 0, 0, w, h);
    if (visitor) {
      const placement = { x, y, width, rotation, flip, exposure };
      const finish = look === 'natural';
      if (finish) this.measureHarmony(visitor, placement, background, depth, live);
      const layer = this.prepareVisitor(visitor, look, placement, background);
      // Lets the interface and the checks tell an early estimate from the
      // settled, measured colours.
      const tone = !finish
        ? 'off'
        : !this.harmony.available
          ? 'estimated'
          : this.harmony.ready &&
              !this.harmony.from &&
              !this.harmony.pending &&
              this.harmony.key === this.harmonyKey
            ? 'measured'
            : 'measuring';
      if (this.output.dataset && this.output.dataset.tone !== tone) this.output.dataset.tone = tone;
      const occlude = this.depthField && Number.isFinite(depth) && depth < 1;
      const upright = Math.abs(rotation) <= 35;
      const mapping = visitorTransform(visitor, placement, w, h);
      // Feet behind a nearer object leave no visible mark on the ground.
      const standing =
        visitor.floorContact &&
        upright &&
        !(occlude && this.depthAtFeet(visitor, placement) > depth + 0.07);
      const cast = grounded && standing;
      const reflect = reflection && visitor.floorContact && upright;
      const tight = visitorPatch(visitor, mapping, false, reflect, w, h);
      const soften = finish ? this.focusBlur(layer, mapping, tight, depth, live) : 0;
      const pad = Math.ceil(2.5 * soften);
      const left = Math.max(0, tight[0] - pad),
        top = Math.max(0, tight[1] - pad);
      const rect = [
        left,
        top,
        Math.min(w, tight[0] + tight[2] + pad) - left,
        Math.min(h, tight[1] + tight[3] + pad) - top
      ];
      if (cast) {
        // Shadows fall onto the photograph itself, in front of the visitor's
        // depth, so they are drawn before the occluded visitor layer.
        if (finish) castShadow(ctx, visitor, mapping, this.light);
        contactShadows(ctx, visitor, mapping, finish ? 1.25 : 1);
      }
      // This canvas holds the live layer alone, so cutting a hole reveals the
      // clean plate in Replace mode as well as the original image in Add mode.
      this.liveLayer ??= makeCanvas();
      resize(this.liveLayer, w, h);
      const painter = this.liveLayer.getContext('2d');
      painter.save();
      painter.beginPath();
      painter.rect(...rect);
      painter.clip();
      painter.clearRect(...rect);
      if (finish && this.frame) {
        // Stay inside the picture area of a mounted print or film scan.
        const [fl, ft, fr, fb] = this.frame;
        painter.beginPath();
        painter.rect(fl * w, ft * h, (fr - fl) * w, (fb - ft) * h);
        painter.clip();
      }
      if (reflect) drawReflection(painter, layer, placement, visitor.floorContact);
      if (soften) painter.filter = blurFilter(soften);
      drawVisitor(painter, layer, placement, w, h);
      painter.filter = 'none';
      if (finish) {
        const bodyHeight = (visitor.foregroundBounds?.height || dimensions(visitor)[1]) * mapping.scale;
        lightWrap(painter, background, rect, clamp(0.014 * bodyHeight, 1.4, 8), 0.6);
        // Where the camera cut the visitor off and nothing in the photograph
        // covers that edge, let it dissolve instead of ending in a ruled line.
        const edge = cropEdge(visitor, mapping);
        const floor = (this.frame ? this.frame[3] : 1) * h;
        if (edge !== null && edge < floor - 2 && upright) {
          const band = clamp(0.085 * bodyHeight, 6, 60);
          const fade = painter.createLinearGradient(0, edge - band, 0, edge);
          fade.addColorStop(0, 'rgba(0,0,0,0)');
          fade.addColorStop(1, 'rgba(0,0,0,1)');
          painter.globalCompositeOperation = 'destination-out';
          painter.fillStyle = fade;
          painter.fillRect(rect[0], edge - band, rect[2], band + 4);
          painter.globalCompositeOperation = 'source-over';
        }
      }
      if (occlude) {
        painter.globalCompositeOperation = 'destination-out';
        painter.drawImage(this.depthField.opacity(depth), 0, 0, w, h);
      }
      painter.restore();
      if (rect[2] && rect[3]) ctx.drawImage(this.liveLayer, ...rect, ...rect);
      if (finish && rect[2] && rect[3]) {
        this.printTexture ??= new PrintTexture(this.scene, this.frame);
        this.printTexture.apply(ctx, this.liveLayer, rect, mapping.scale, live, `${tone}/${exposure}`);
      }
    }
    if (this.foreground) ctx.drawImage(this.foreground, 0, 0);
  }
}

// The scene row of a visitor's cropped lower edge, or null when their feet
// are in view. A camera frame crops at its bottom border; a still photograph
// says so itself.
function cropEdge(visitor, mapping) {
  const [, vh] = dimensions(visitor);
  if (visitor.floorContact) return null;
  const bounds = visitor.foregroundBounds;
  const cropped = visitor.cropped ?? (bounds ? bounds.y + bounds.height >= vh - 2 : false);
  return cropped ? mapping.point(0, vh).y : null;
}

function drawVisitor(ctx, layer, { x, y, width, rotation, flip }, w, h) {
  const [sourceWidth, sourceHeight] = dimensions(layer);
  const drawWidth = w * width,
    drawHeight = (drawWidth * sourceHeight) / sourceWidth;
  ctx.save();
  ctx.translate(x * w, y * h);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(flip ? -1 : 1, 1);
  ctx.drawImage(layer, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
}

// A selection outline usually includes a thin rim of whatever stood behind the
// subject. Pull the restored foreground in by about a pixel and soften its
// border so that rim does not appear as a dark fringe over the visitor.
function insetMask(mask, width, height) {
  const alpha = maskToAlpha(mask, width, height);
  if (!canFilter) return alpha;
  const soft = makeCanvas(width, height);
  const ctx = soft.getContext('2d', { willReadFrequently: true });
  ctx.filter = blurFilter(Math.max(0.9, Math.max(width, height) / 900));
  ctx.drawImage(alpha, 0, 0);
  ctx.filter = 'none';
  const pixels = ctx.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let i = 3; i < data.length; i += 4) {
    const t = clamp((data[i] - 118) / 110, 0, 1);
    data[i] = 255 * t * t * (3 - 2 * t);
  }
  ctx.putImageData(pixels, 0, 0);
  return soft;
}
