"""Render two replayable 10-second comparisons from the bundled visitor recording.

Run: python scripts/build_motion_demo.py
Requires Chrome, playwright, imageio-ffmpeg and opencv-python.
"""

import argparse
import base64
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

PUBLIC = Path(__file__).resolve().parents[1] / "public"
DEMO = PUBLIC / "demo"
SCENES = [
    dict(name="kitty-hawk", photo="samples/kitty-hawk.jpg", mask="samples/wilbur-mask.png",
         placement=dict(width=.183, x=.875, y=.42), crop=[601, 113, 248, 186], simple="Grayscale"),
    dict(name="spacelab", photo="scene-bank/spacelab-crew.jpg", mask="demo/jemison-mask.png",
         placement=dict(width=.64, x=.77, y=.48), crop=[428, 66, 672, 504], simple="Brightness and contrast"),
]


class QuietServer(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


SETUP = """
async configs => {
  const {canvas,readImage}=await import('./ui.js');
  const {SceneRenderer}=await import('./engine.js');
  const {PersonCutout}=await import('./media.js');
  const source=canvas(640,480), sourceContext=source.getContext('2d');
  const model=new PersonCutout();
  const sample=canvas(64,48), sc=sample.getContext('2d',{willReadFrequently:true});
  const stages=await Promise.all(configs.map(async c=>{
    const [photo,mask]=await Promise.all([readImage(c.photo),readImage(c.mask)]);
    const out=canvas(1,1), renderer=new SceneRenderer(out);
    renderer.setScene(photo);renderer.setForeground(mask);renderer.setReference(mask);
    const w=384,h=288,bar=26;
    const sheet=canvas(2*w,2*(h+bar)), ctx=sheet.getContext('2d');
    const overlap=canvas(275,Math.round(275*photo.height/photo.width));
    const oc=overlap.getContext('2d',{willReadFrequently:true});
    oc.drawImage(mask,0,0,overlap.width,overlap.height);
    const region=oc.getImageData(0,0,overlap.width,overlap.height).data;
    return {c,out,renderer,photo,sheet,ctx,overlap,oc,region,w,h,bar};
  }));
  return window.drawReplayFrame=async png=>{
    const frame=await readImage(png);
    sourceContext.drawImage(frame,0,0);
    sc.drawImage(source,0,0,64,48);const pixels=sc.getImageData(0,0,64,48).data;
    let hash=2166136261;
    for(let n=0;n<pixels.length;n+=4) hash=Math.imul(hash^((pixels[n]<<16)|(pixels[n+1]<<8)|pixels[n+2]),16777619);
    const visitor=await model.frame(source);
    if(model.method!=='MediaPipe') throw Error('Expected the local MediaPipe image segmenter');
    const results=[];
    for(const {c,out,renderer,photo,sheet,ctx,overlap,oc,region,w,h,bar} of stages) {
      const place=c.placement;
      oc.clearRect(0,0,overlap.width,overlap.height);
      const dw=place.width*overlap.width,dh=dw*visitor.height/visitor.width;
      oc.drawImage(visitor,place.x*overlap.width-dw/2,place.y*overlap.height-dh/2,dw,dh);
      const alpha=oc.getImageData(0,0,overlap.width,overlap.height).data;
      let covered=0,visible=0;
      for(let q=0;q<alpha.length;q+=4) if(alpha[q+3]>128) {
        if(region[q]>128) covered++;
        else visible++;
      }
      const labels=['Original photograph','Untreated visitor',c.simple,'Matched to foreground'];
      for(const [index,look] of ['original','untreated','simple','matched'].entries()) {
        const left=index%2*w,top=Math.floor(index/2)*(h+bar);
        ctx.fillStyle='#242821';ctx.fillRect(left,top,w,h+bar);
        ctx.fillStyle='#fbfbf4';ctx.font='bold 14px Arial';ctx.textBaseline='middle';
        ctx.fillText(labels[index],left+10,top+bar/2);
        if(index) renderer.render(visitor,{...place,look});
        ctx.drawImage(index?out:photo,...c.crop,left,top+bar,w,h);
      }
      results.push({image:sheet.toDataURL('image/jpeg',.92),covered,visible});
    }
    return {hash,results};
  };
}
"""


def frame_bytes(result):
    return base64.b64decode(result["image"].split(",", 1)[1])


def read_frame(capture):
    # Passing the decoded frame losslessly avoids browser timing differences
    # between a paused video's seeked event and presentation of its new frame.
    ok, frame = capture.read()
    if not ok:
        raise ValueError("The source recording ended early")
    ok, png = cv2.imencode(".png", frame, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    if not ok:
        raise RuntimeError("Source frame conversion failed")
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def check_output(path):
    cap = cv2.VideoCapture(str(path))
    try:
        if cap.get(cv2.CAP_PROP_FPS) != 25 or int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) != 250:
            raise ValueError(f"Expected exactly 250 frames at 25 fps in {path}")
        hashes = set()
        for _ in range(250):
            ok, image = cap.read()
            if not ok:
                raise ValueError(f"Incomplete video in {path}")
            hashes.add(hashlib.sha256(image.tobytes()).digest())
        if len(hashes) < 245:
            raise ValueError(f"Insufficient distinct decoded frames in {path}")
        return len(hashes)
    finally:
        cap.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="Write frame 119 from both scenes to this directory and exit")
    args = parser.parse_args()
    source_hashes = set()
    metrics = {s["name"]: {"occluded_frames": 0, "min_hidden_samples": float("inf"),
                           "max_hidden_samples": 0, "min_visible_samples": float("inf")} for s in SCENES}
    handler = functools.partial(QuietServer, directory=PUBLIC)
    with tempfile.TemporaryDirectory(dir=DEMO) as tmp, \
            http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler) as server, \
            sync_playwright() as playwright, contextlib.ExitStack() as encoders:
        tmp = Path(tmp)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        browser = playwright.chromium.launch(channel=os.environ.get("PLAYWRIGHT_BROWSER_CHANNEL", "chrome"),
                                             headless=True, args=["--enable-unsafe-swiftshader"])
        capture = cv2.VideoCapture(str(DEMO / "movement.mp4"))
        try:
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{server.server_port}/pose.js")
            page.evaluate(SETUP, SCENES)
            if args.preview:
                args.preview.mkdir(exist_ok=True, parents=True)
                capture.set(cv2.CAP_PROP_POS_FRAMES,119)
                output = page.evaluate("png => window.drawReplayFrame(png)", read_frame(capture))
                for s, r in zip(SCENES, output["results"]):
                    (args.preview / f"{s['name']}.jpg").write_bytes(frame_bytes(r))
                    print(s["name"], r["covered"], r["visible"])
                return
            pipes = []
            for scene in SCENES:
                name = scene["name"]
                cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y", "-f", "image2pipe",
                       "-framerate", "25", "-c:v", "mjpeg", "-i", "pipe:0", "-an", "-c:v", "libx264",
                       "-threads", "2", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
                       "-movflags", "+faststart", str(tmp / f"{name}.mp4")]
                proc = encoders.enter_context(subprocess.Popen(cmd, stdin=subprocess.PIPE))
                pipes.append(proc)
            for i in range(250):
                output = page.evaluate("png => window.drawReplayFrame(png)", read_frame(capture))
                source_hashes.add(output["hash"])
                for scene, proc, result in zip(SCENES, pipes, output["results"]):
                    frame = frame_bytes(result)
                    proc.stdin.write(frame)
                    if i == 119:
                        (tmp / f"{scene['name']}.jpg").write_bytes(frame)
                    m = metrics[scene["name"]]
                    m["occluded_frames"] += int(result["covered"] > 0)
                    m["min_hidden_samples"] = min(m["min_hidden_samples"], result["covered"])
                    m["max_hidden_samples"] = max(m["max_hidden_samples"], result["covered"])
                    m["min_visible_samples"] = min(m["min_visible_samples"], result["visible"])
            for proc in pipes:
                proc.stdin.close()
                if proc.wait():
                    raise RuntimeError("FFmpeg failed")
            if len(source_hashes) != 250:
                raise ValueError(f"Expected 250 distinct source frames, observed {len(source_hashes)}")
            for scene in SCENES:
                name = scene["name"]
                metrics[name]["distinct_decoded_output_frames"] = check_output(tmp / f"{name}.mp4")
                if metrics[name]["occluded_frames"] < 1 or metrics[name]["min_visible_samples"] < 1:
                    raise ValueError(f"Check visitor placement in {name}")
            report = {"input": "movement.mp4", "frame_count": 250, "fps": 25,
                      "distinct_source_frames": len(source_hashes), "mask_sample_width": 275,
                      "results": metrics, "scenes": SCENES}
            (tmp / "verification.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
            for path in tmp.iterdir():
                path.replace(DEMO / path.name)
            print(json.dumps(report["results"], indent=2))
        finally:
            capture.release()
            browser.close()
            server.shutdown()


if __name__ == "__main__":
    main()
