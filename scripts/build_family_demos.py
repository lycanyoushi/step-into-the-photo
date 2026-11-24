"""Render the studio's family presets with a real 10-second, 25-fps visitor.

Run from the project directory with python scripts/build_family_demos.py.
For a placement check, use --preview DIRECTORY. The build uses the browser
models and the same full-frame placement as a webcam visitor.
"""

import argparse
import contextlib
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

import cv2
import imageio_ffmpeg
from playwright.sync_api import sync_playwright

from build_motion_demo import PUBLIC, QuietServer, check_output, frame_bytes, read_frame


DEFAULT_TAKE = "./demo/movement.mp4"
FAMILIES = PUBLIC / "families"
DESTINATION = FAMILIES / "demos"
FPS = 25
FRAMES = 250
POSTER_FRAME = 119
AUDIT_FRAMES = sorted({*range(0, FRAMES, FPS), POSTER_FRAME, FRAMES - 1})


SETUP = """
async scenes => {
  const {canvas, readImage} = await import('./ui.js');
  const {maskToAlpha} = await import('./canvas.js');
  const {PersonCutout} = await import('./media.js');
  const {SceneRenderer} = await import('./engine.js');
  const source = canvas(1, 1);
  const sourceContext = source.getContext('2d');
  const cutout = new PersonCutout({live: true, photographic: true});
  const stages = await Promise.all(scenes.map(async scene => {
    const [photo, mask] = await Promise.all([readImage(scene.image), readImage(scene.mask)]);
    if (photo.width !== mask.width || photo.height !== mask.height) {
      throw Error('Foreground mask size differs from the photo: ' + scene.id);
    }
    const scale = Math.min(1, 1000 / Math.max(photo.width, photo.height));
    // YUV 4:2:0 requires an even number of pixels in each direction.
    const w = 2 * Math.max(1, Math.round(photo.width * scale / 2));
    const h = 2 * Math.max(1, Math.round(photo.height * scale / 2));
    const base = canvas(w, h);
    const baseCtx = base.getContext('2d', {willReadFrequently: true});
    baseCtx.drawImage(photo, 0, 0, w, h);
    const original = baseCtx.getImageData(0, 0, w, h).data;
    const region = maskToAlpha(mask, w, h).getContext('2d').getImageData(0, 0, w, h).data;
    const output = canvas(w, h);
    const renderer = new SceneRenderer(output);
    renderer.setScene(base);
    renderer.setForeground(mask);
    renderer.setReference(mask);
    const coverage = canvas(w, h);
    const coverageRenderer = new SceneRenderer(coverage);
    coverageRenderer.setScene(canvas(w, h));
    return {scene, original, region, renderer, output, coverageRenderer, coverage};
  }));

  function audit(stage, visitor, placement) {
    const {output, region, original, coverage, coverageRenderer} = stage;
    const {width, height} = output;
    const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const result = pixels(output);
    coverageRenderer.render(visitor, {...placement, look: 'untreated', grounded: false, reflection: false});
    const body = pixels(coverage);
    let withoutReflection = null;
    if (placement.reflection) {
      coverageRenderer.render(visitor, {...placement, look: 'untreated', grounded: true, reflection: false});
      withoutReflection = pixels(coverage);
    }
    coverageRenderer.render(visitor, {...placement, look: 'untreated', grounded: true});
    const support = pixels(coverage);
    let hidden = 0, visible = 0, reflected = 0, sumX = 0, protectedCount = 0, maxDifference = 0;
    for (let i = 0; i < original.length; i += 4) {
      if (withoutReflection && support[i + 3] > withoutReflection[i + 3] + 8 && region[i + 3] < 128) {
        reflected++;
      }
      if (body[i + 3] >= 128) {
        if (region[i + 3] === 255) hidden++;
        else if (region[i + 3] < 128) {
          visible++;
          sumX += (i / 4) % width;
        }
      }
      if (support[i + 3] === 0 || region[i + 3] === 255) {
        protectedCount++;
        for (let ch = 0; ch < 3; ch++) {
          maxDifference = Math.max(maxDifference, Math.abs(result[i + ch] - original[i + ch]));
        }
      }
    }
    return {hiddenBodyPixels: hidden, visibleBodyPixels: visible, reflectedPixels: reflected,
            meanVisibleX: sumX / Math.max(1, visible),
            protectedPixels: protectedCount, maxProtectedChannelDifference: maxDifference};
  }

  window.renderVisit = async ({png, time, auditFrame}) => {
    const image = await readImage(png);
    if (source.width !== image.width || source.height !== image.height) {
      source.width = image.width;
      source.height = image.height;
    }
    sourceContext.drawImage(image, 0, 0);
    const person = await cutout.frame(source, {time});
    if (!cutout.method?.startsWith('MediaPipe')) throw Error('Real person segmentation was unavailable.');
    return stages.map(stage => {
      const placement = {...stage.scene.placement, reflection: stage.scene.reflection === true};
      stage.renderer.render(person, {...placement, look: 'photographic', grounded: true});
      return {image: stage.output.toDataURL('image/jpeg', .94),
              audit: auditFrame ? audit(stage, person, placement) : null};
    });
  };
}
"""


def encoder(path, stack):
    args = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y", "-f", "image2pipe",
            "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "pipe:0", "-an", "-c:v", "libx264",
            "-threads", "2", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(path)]
    proc = stack.enter_context(subprocess.Popen(args, stdin=subprocess.PIPE))
    stack.callback(proc.stdin.close)
    return proc


def render(scenes, folder, source, preview=False):
    checks = {scene["id"]: {} for scene in scenes}
    unique_sources = set()
    handler = functools.partial(QuietServer, directory=PUBLIC)
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler) as server, \
            sync_playwright() as playwright, contextlib.ExitStack() as stack:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        stack.callback(server.shutdown)
        browser = playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL", "msedge"),
                                             args=["--enable-unsafe-swiftshader"])
        stack.callback(browser.close)
        page = browser.new_page()
        page.goto(f"http://127.0.0.1:{server.server_port}/ui.js")
        page.evaluate(SETUP, scenes)
        capture = cv2.VideoCapture(str(source))
        stack.callback(capture.release)
        if int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) != FRAMES or capture.get(cv2.CAP_PROP_FPS) != FPS:
            raise RuntimeError("The reference take should contain 250 frames at 25 fps.")
        pipes = {} if preview else {s["id"]: encoder(folder / f"{s['id']}.mp4", stack) for s in scenes}
        frame_range = [0, POSTER_FRAME, FRAMES - 1] if preview else range(FRAMES)
        for i in frame_range:
            if preview:
                capture.set(cv2.CAP_PROP_POS_FRAMES, i)
            png = read_frame(capture)
            unique_sources.add(hashlib.sha256(png.encode("ascii")).digest())
            results = page.evaluate("frame => renderVisit(frame)", {
                "png": png, "time": i / FPS, "auditFrame": i in AUDIT_FRAMES,
            })
            for scene, result in zip(scenes, results):
                key = scene["id"]
                jpeg = frame_bytes(result)
                if preview:
                    (folder / f"{key}-{i:03}.jpg").write_bytes(jpeg)
                else:
                    pipes[key].stdin.write(jpeg)
                    if i == POSTER_FRAME:
                        (folder / f"{key}.jpg").write_bytes(jpeg)
                if result["audit"] is not None:
                    checks[key][i] = result["audit"]
        for key, proc in pipes.items():
            proc.stdin.close()
            if proc.wait() != 0:
                raise RuntimeError(f"Could not encode {key}")
    if len(unique_sources) != len(frame_range):
        raise ValueError("The source contains duplicate frames.")
    return checks


def take_for(scene):
    return scene.get("take", {}).get("source", DEFAULT_TAKE)


def render_all(scenes, folder, preview=False):
    checks = {}
    for take in dict.fromkeys(take_for(scene) for scene in scenes):
        group = [scene for scene in scenes if take_for(scene) == take]
        checks.update(render(group, folder, PUBLIC / take, preview))
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="Save first, middle and last frames to inspect placement")
    args = parser.parse_args()
    scenes = json.loads((FAMILIES / "scenes.json").read_text(encoding="utf-8-sig"))
    ids = [s["id"] for s in scenes]
    if len(ids) != len(set(ids)) or not ids:
        raise ValueError("The family collection needs unique scene IDs.")
    if args.preview:
        args.preview.mkdir(parents=True, exist_ok=True)
        print(json.dumps(render_all(scenes, args.preview, preview=True), indent=2))
        return
    DESTINATION.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DESTINATION) as temp:
        folder = Path(temp)
        checks = render_all(scenes, folder)
        report = {"frameCount": FRAMES, "sourceDistinctFrames": FRAMES, "fps": FPS, "durationSeconds": FRAMES / FPS,
                  "auditFrames": AUDIT_FRAMES, "renderAudit": "Before JPEG and H.264 encoding. Protected pixels "
                  "are fully covered by the foreground mask or outside the visitor, its contact shadow and "
                  "any enabled wet-floor reflection.",
                  "scenes": {}}
        for scene in scenes:
            key = scene["id"]
            audit = list(checks[key].values())
            hidden_peak = max(m["hiddenBodyPixels"] for m in audit)
            min_visible = min(m["visibleBodyPixels"] for m in audit)
            max_delta = max(m["maxProtectedChannelDifference"] for m in audit)
            peak_reflected = max(m["reflectedPixels"] for m in audit)
            if scene.get("reflection") and peak_reflected < 4:
                raise ValueError(f"The prepared wet floor in {key} did not show the visitor's reflection.")
            xs = [m["meanVisibleX"] for m in audit]
            excursion = round(max(xs) - min(xs), 2)
            if hidden_peak < 4 or min_visible < 32 or max_delta > 2 or excursion < 2:
                raise ValueError(f"Check the placement in {key}: hidden peak {hidden_peak}, "
                                 f"minimum visible {min_visible}, maximum protected change {max_delta}, "
                                 f"visible silhouette centroid travel {excursion}px.")
            report["scenes"][key] = {
                "source": take_for(scene),
                "sourceSHA256": hashlib.sha256((PUBLIC / take_for(scene)).read_bytes()).hexdigest(),
                "distinctDecodedFrames": check_output(folder / f"{key}.mp4"),
                "placement": scene["placement"],
                "reflection": bool(scene.get("reflection", False)),
                "auditedFramesWithOcclusion": sum(m["hiddenBodyPixels"] > 0 for m in audit),
                "peakHiddenBodyPixels": hidden_peak, "minimumVisibleBodyPixels": min_visible,
                "peakReflectedPixels": peak_reflected,
                "visibleCentroidHorizontalRangePixels": excursion,
                "maxProtectedChannelDifference": max_delta,
                "minimumProtectedPixels": min(m["protectedPixels"] for m in audit),
            }
        (folder / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        for path in folder.iterdir():
            path.replace(DESTINATION / path.name)
        print(json.dumps(report["scenes"], indent=2))


if __name__ == "__main__":
    main()
