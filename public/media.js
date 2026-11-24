import { dimensions, makeCanvas, maskToAlpha, resize } from './canvas.js';
import { LiveMatte, floorSupport, subjectExtent, refineCameraEdge, featherCategories } from './live-matte.js';
import { MatteMotion } from './matte-motion.js';

const vendor = new URL('./vendor/mediapipe/', import.meta.url);
let modelPromise, detailPromise;

async function loadModel(detailed = false) {
  // Lazy load so transparent art and traced cutouts also work on browsers
  // without WebGL. Share the immutable IMAGE-mode model across cutout sources.
  const { FilesetResolver, ImageSegmenter } = await import('./vendor/mediapipe/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(new URL('wasm', vendor).href);
  return ImageSegmenter.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: new URL(
        detailed ? 'selfie_multiclass_256x256.tflite' : 'selfie_segmenter.tflite',
        vendor
      ).href,
      delegate: detailed ? 'GPU' : 'CPU'
    },
    runningMode: 'IMAGE',
    outputConfidenceMasks: !detailed,
    outputCategoryMask: detailed
  });
}

function localSegmenter() {
  if (!modelPromise) {
    modelPromise = loadModel().catch((error) => {
      modelPromise = null;
      throw new Error(
        'Could not load the local person segmenter. Try a browser with WebGL2, a transparent PNG, or a source selection.',
        { cause: error }
      );
    });
  }
  return modelPromise;
}

export class PersonCutout {
  constructor({ live = false, photographic = false } = {}) {
    this.output = makeCanvas();
    // The detailed model serves a camera and a single photograph alike.
    this.photographic = photographic;
    this.motion = this.photographic ? new MatteMotion() : null;
    this.context = this.output.getContext('2d', { willReadFrequently: this.photographic });
    this.modelInput = makeCanvas();
    this.modelMask = makeCanvas();
    this.live = live;
    this.matte = new LiveMatte();
    this.onSeek = () => {
      this.matte.reset();
      this.motion?.reset();
    };
    this.generation = 0;
    this.reset();
  }

  reset() {
    ++this.generation;
    this.source?.removeEventListener?.('seeking', this.onSeek);
    this.matte.reset();
    this.motion?.reset();
    this.source = null;
    this.hasAlpha = null;
    this.method = null;
  }

  async frame(source, { mask = null, mirror = false, time = undefined } = {}) {
    const started = performance.now();
    const [originalWidth, originalHeight] = dimensions(source);
    if (!originalWidth || !originalHeight) throw new Error('The source frame is not ready.');
    if (this.source !== source) {
      this.reset();
      this.source = source;
      if (this.live) this.source.addEventListener?.('seeking', this.onSeek);
    }
    const generation = this.generation;
    const video = source instanceof HTMLVideoElement;
    const moving = video || this.live;
    const maxEdge = !moving ? 1600 : !this.photographic ? 640 : this.preferCpu ? 640 : this.detailLimit || 960;
    const scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
    const w = Math.max(1, Math.round(originalWidth * scale));
    const h = Math.max(1, Math.round(originalHeight * scale));
    resize(this.output, w, h);
    this.output.foregroundBounds = null;
    this.output.floorContact = null;
    const ctx = this.context;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    if (mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, 0, 0, w, h);
    ctx.restore();

    if (mask) {
      this.matte.reset();
      this.motion?.reset();
      const alpha = maskToAlpha(mask, w, h);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      if (mirror) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(alpha, 0, 0);
      ctx.restore();
      this.method = 'Selected mask';
      return this.output;
    }
    if (!video && !this.live && this.hasAlpha === null) {
      const pixels = ctx.getImageData(0, 0, w, h).data;
      this.hasAlpha = false;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] < 255) {
          this.hasAlpha = true;
          break;
        }
      }
    }
    if (this.hasAlpha) {
      this.method = 'Embedded alpha';
      return this.output;
    }

    let segmenter;
    if (this.photographic && !this.preferCpu) {
      detailPromise ??= loadModel(true).catch(() => null);
      segmenter = await detailPromise;
      if (!segmenter) this.preferCpu = true;
    }
    let detailed = !!segmenter;
    if (!segmenter) segmenter = await localSegmenter();
    if (generation !== this.generation) throw new DOMException('Source changed', 'AbortError');
    // The bundled selfie model uses a 256-square tensor. Its confidence map
    // is computed at this resolution, then interpolated onto the original.
    const ratio = Math.min(1, (this.photographic ? 256 : 320) / Math.max(w, h));
    resize(this.modelInput, Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio)));
    const inputCtx = this.modelInput.getContext('2d');
    if (this.photographic) {
      // The GPU graph reads the small model tensor straight from the video.
      // Uploading the donor's full CPU canvas stalls every high-resolution frame.
      inputCtx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? this.modelInput.width : 0, 0);
      inputCtx.drawImage(source, 0, 0, this.modelInput.width, this.modelInput.height);
    } else {
      inputCtx.drawImage(this.output, 0, 0, this.modelInput.width, this.modelInput.height);
    }
    const useMotion = detailed && video && !source.paused;
    const rgb = useMotion ? this.motion.read(this.output) : null;
    const stamp = time ?? (video ? source.currentTime : performance.now() / 1000);
    const prediction = rgb && this.motion.predict(rgb, stamp, mirror);
    let anchorPixels;
    const collectMask = (result) => {
      // In the multiclass model every category other than background belongs
      // to the person. This includes disconnected accessories, hands and shoes.
      const foreground = prediction || (detailed ? result.categoryMask : result.confidenceMasks[0]);
      let confidence;
      if (prediction) confidence = prediction.background;
      else if (detailed) {
        const labels = foreground.getAsUint8Array();
        if (this.background?.length !== labels.length) this.background = new Float32Array(labels.length);
        featherCategories(labels, foreground.width, foreground.height, this.background);
        confidence = this.background;
        if (useMotion) anchorPixels = confidence;
      } else confidence = foreground.getAsFloat32Array();
      resize(this.modelMask, foreground.width, foreground.height);
      const maskCtx = this.modelMask.getContext('2d');
      if (
        !this.maskPixels ||
        this.maskPixels.width !== foreground.width ||
        this.maskPixels.height !== foreground.height
      ) {
        this.maskPixels = maskCtx.createImageData(foreground.width, foreground.height);
      }
      const pixels = this.maskPixels.data;
      const live = this.live;
      if (live) {
        this.matte.begin(foreground.width, foreground.height, stamp, mirror);
        if (this.rowStart?.length !== foreground.height) {
          this.rowStart = new Int32Array(foreground.height);
          this.rowEnd = new Int32Array(foreground.height);
        }
      }
      const { history, offsets, blend } = this.matte;
      const extent = detailed ? subjectExtent(confidence, foreground.width, foreground.height) : null;
      let left = foreground.width,
        top = foreground.height;
      let right = -1,
        bottom = -1;
      for (let y = 0, i = 0; y < foreground.height; y++) {
        let first = foreground.width,
          last = -1;
        let firstCore = foreground.width,
          lastCore = -1;
        for (let x = 0; x < foreground.width; x++, i++) {
          const keep =
            !extent || (x >= extent.left && x < extent.right && y >= extent.top && y < extent.bottom);
          const probability = keep ? (detailed ? 1 - confidence[i] : confidence[i]) : 0;
          const t = Math.min(1, Math.max(0, (probability - 0.12) / 0.72));
          pixels[4 * i + 3] = 255 * t * t * (3 - 2 * t);
          if (live) {
            let alpha = pixels[4 * i + 3];
            if (blend && alpha > 0 && alpha < 255) {
              alpha += offsets[history[i] - alpha + 255];
              pixels[4 * i + 3] = alpha;
            }
            history[i] = alpha;
            if (alpha >= 178) {
              if (x < firstCore) firstCore = x;
              lastCore = x;
            }
          }
          if (pixels[4 * i + 3]) {
            if (x < first) first = x;
            last = x;
          }
        }
        if (live) {
          this.rowStart[y] = firstCore;
          this.rowEnd[y] = lastCore;
        }
        if (last >= 0) {
          left = Math.min(first, left);
          right = Math.max(last, right);
          top = Math.min(y, top);
          bottom = y;
        }
      }
      if (live) {
        this.output.floorContact = floorSupport(
          pixels,
          foreground.width,
          foreground.height,
          this.rowStart,
          this.rowEnd,
          w,
          h
        );
      }
      if (right >= 0) {
        // Include the interpolation footprint when scaling this confidence
        // image. Original donor framing and the actual matte stay untouched.
        const sx = w / foreground.width,
          sy = h / foreground.height;
        const x = Math.max(0, Math.floor((left - 2) * sx)),
          y = Math.max(0, Math.floor((top - 2) * sy));
        this.output.foregroundBounds = {
          x,
          y,
          width: Math.min(w, Math.ceil((right + 3) * sx)) - x,
          height: Math.min(h, Math.ceil((bottom + 3) * sy)) - y
        };
      }
      maskCtx.putImageData(this.maskPixels, 0, 0);
    };
    const at = performance.now();
    try {
      if (prediction) collectMask(null);
      else segmenter.segment(this.modelInput, collectMask);
    } catch (error) {
      if (!detailed) throw error;
      this.preferCpu = true;
      detailed = false;
      const fallback = await localSegmenter();
      if (generation !== this.generation) throw new DOMException('Source changed', 'AbortError');
      this.matte.reset();
      fallback.segment(this.modelInput, collectMask);
    }
    if (detailed && !prediction) {
      if (anchorPixels)
        this.motion.remember(
          rgb,
          anchorPixels,
          this.modelMask.width,
          this.modelMask.height,
          stamp,
          mirror,
          performance.now() - at
        );
      // Give software-rendered WebGL a few warm frames before falling back.
      this.detailFrames = (this.detailFrames || 0) + 1;
      this.slowFrames =
        this.detailFrames > 2 && performance.now() - at > 110 ? (this.slowFrames || 0) + 1 : 0;
      if (this.slowFrames >= 4) {
        this.preferCpu = true;
        this.matte.reset();
      }
    }
    if (this.photographic && this.output.foregroundBounds) {
      const box = this.output.foregroundBounds;
      this.fullMask ??= makeCanvas();
      resize(this.fullMask, w, h);
      const maskCtx = this.fullMask.getContext('2d', { willReadFrequently: true });
      maskCtx.globalCompositeOperation = 'copy';
      maskCtx.drawImage(this.modelMask, 0, 0, w, h);
      const mask = maskCtx.getImageData(box.x, box.y, box.width, box.height);
      const donor = ctx.getImageData(box.x, box.y, box.width, box.height);
      refineCameraEdge(donor, mask.data, w / this.modelMask.width);
      ctx.clearRect(0, 0, w, h);
      ctx.putImageData(donor, box.x, box.y);
      if (useMotion && !prediction && (this.detailFrames ?? 0) > 2 && Math.max(w, h) > 640) {
        // Keep the same field of view on a slow GPU while reducing the amount
        // of donor RGB read back and composited per frame. Placement is normalized.
        this.lateDetail = performance.now() - started > 54 ? (this.lateDetail || 0) + 1 : 0;
        if (this.lateDetail >= 4) this.detailLimit = 640;
      }
      this.method = detailed ? 'MediaPipe multiclass' : 'MediaPipe';
      return this.output;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.modelMask, 0, 0, w, h);
    ctx.restore();
    this.method = detailed ? 'MediaPipe multiclass' : 'MediaPipe';
    return this.output;
  }
}
