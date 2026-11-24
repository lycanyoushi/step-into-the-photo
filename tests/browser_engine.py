"""Run with python tests/browser_engine.py after installing Playwright + Chromium."""

from functools import partial
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


CHECK = r"""
async () => {
  const {SceneRenderer} = await import('/engine.js');
  const {PersonCutout} = await import('/media.js');
  const {makeCanvas} = await import('/canvas.js');
  const fill = (c, color, x=0, y=0, w=c.width, h=c.height) => {
    const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(x,y,w,h);
  };
  const pixel = (c,x,y) => [...c.getContext('2d').getImageData(x,y,1,1).data];
  const equal = (a,b,step) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(step + ': ' + a + ' != ' + b);
  };
  const scene = makeCanvas(20,20), visitor = makeCanvas(10,10), mask = makeCanvas(20,20);
  const output = makeCanvas(), plate = makeCanvas(20,20);
  fill(scene,'#111111'); fill(scene,'#ff0000',0,0,10,20);
  fill(plate,'#334455'); fill(visitor,'#ffcc00');
  fill(mask,'black'); fill(mask,'white',0,0,10,20);
  const engine = new SceneRenderer(output);
  engine.setScene(scene); engine.setForeground(mask);
  engine.render(visitor,{width:0.5});
  equal(pixel(output,7,8),[255,0,0,255],'restored original');
  equal(pixel(output,12,8),[255,204,0,255],'visible visitor');
  equal(pixel(output,19,19),[17,17,17,255],'outside paste');
  engine.setCleanPlate(plate);
  engine.render(visitor,{mode:'replace',width:0.5});
  equal(pixel(output,19,19),[51,68,85,255],'replacement clean plate');
  equal(pixel(output,7,8),[255,0,0,255],'independent front layer');

  // Use the right (neutral) half as color reference.
  fill(mask,'black'); fill(mask,'white',10,0,10,20);
  engine.setReference(mask); engine.setForeground(null);
  const calibration = engine.sourceColors;
  for (const look of ['simple','matched']) {
    engine.render(visitor,{look,width:0.5});
    const c = pixel(output,10,10);
    if (Math.max(...c.slice(0,3)) - Math.min(...c.slice(0,3)) > 1) throw Error(look+' gray');
  }
  fill(visitor,'#993388');
  engine.render(visitor,{look:'matched'});
  if (engine.sourceColors !== calibration) throw Error('color calibration drift');
  engine.resetMatch();
  engine.render(visitor,{look:'matched'});
  if (engine.sourceColors === calibration) throw Error('source calibration was retained');

  // Different parts of one photograph have different lighting. Lighting from a
  // nearby coloured wall must not recolour a shirt, or pump with each camera pose.
  const lightingScene=makeCanvas(160,80), camera=makeCanvas(32,32);
  fill(lightingScene,'#2e3538'); fill(lightingScene,'#d7d0c8',80,0,80,80);
  fill(camera,'#9e9d92'); fill(camera,'#060609',0,0,6,32); fill(camera,'#fff',26,0,6,32);
  fill(camera,'#cc6052',12,20,10,10);
  camera.getContext('2d').clearRect(0,0,4,4); fill(camera,'rgba(254,252,249,.4)',1,1,2,2);
  const lightOut=makeCanvas(), live=new SceneRenderer(lightOut);
  live.setScene(lightingScene);
  function place(x) {live.render(camera,{look:'photographic',x,y:.5,width:.18});}
  place(.25);
  const dark=pixel(live.workspace,15,10);
  const cached=live.photographic.curve;
  place(.25);
  equal(pixel(live.workspace,15,10),dark,'identical frame must preserve exposure');
  if (live.photographic.curve!==cached) throw Error('live calibration changed between frames');
  place(.75);
  const light=pixel(live.workspace,15,10), shirt=pixel(live.workspace,16,24);
  if (light[1]-dark[1]<12) throw Error('live exposure ignored placement '+light+' '+dark);
  if (shirt[0]-shirt[2]<95) throw Error('live transfer erased fabric colour '+shirt);
  equal(pixel(live.workspace,29,20),[255,255,255,255],'unclipped camera white');
  equal(pixel(live.workspace,2,2)[3],pixel(camera,2,2)[3],'live matte coverage');
  if (Math.max(...pixel(live.workspace,2,14).slice(0,3))>14) throw Error('lifted camera blacks');
  equal(pixel(lightOut,0,5),pixel(lightingScene,0,5),'photographic original outside the visitor');
  live.render(camera,{look:'photographic',x:.75,y:.5,width:.18,exposure:.8});
  if (pixel(live.workspace,15,10)[1] < light[1]+10) throw Error('manual exposure did not brighten the visitor');
  equal(pixel(lightOut,0,5),pixel(lightingScene,0,5),'manual exposure changed the scene');
  place(.75);
  equal(pixel(live.workspace,15,10),light,'reset automatic exposure');
  fill(lightingScene,'#8a8a8a'); live.setScene(lightingScene); place(.5);
  const mono=pixel(live.workspace,16,24);
  if (mono[0]!==mono[1] || mono[1]!==mono[2]) throw Error('photographic monochrome');

  const source = makeCanvas(20,20);
  fill(source,'#336699',0,0,10,20);
  const cutter = new PersonCutout();
  const cutout = await cutter.frame(source);
  equal(pixel(cutout,2,2),[51,102,153,255],'alpha passthrough');
  equal(pixel(cutout,18,2),[0,0,0,0],'alpha passthrough background');
  fill(source,'#336699');
  await cutter.frame(source,{mask,mirror:true});
  equal(pixel(cutout,2,2),[51,102,153,255],'mirrored explicit selection');
  equal(pixel(cutout,18,2),[0,0,0,0],'outside explicit selection');

  const img = new Image(); img.src='/samples/traveler.png'; await img.decode();
  const raw = makeCanvas(360,480);
  fill(raw,'#aebca2');
  raw.getContext('2d').drawImage(img,68,12,224,452);
  const prediction = await cutter.frame(raw);
  const p = prediction.getContext('2d').getImageData(0,0,360,480).data;
  let visible = 0;
  for (let i=3;i<p.length;i+=4) visible += p[i]>128;
  const fraction = visible / (360*480);
  if (!(fraction>0.04 && fraction<0.6)) throw Error('Unexpected MediaPipe foreground fraction '+fraction);
  equal(cutter.method,'MediaPipe','automatic cutout');
  // The optimized color path must keep every partially transparent edge
  // identical to running the same calibrated transfer on the whole canvas.
  const referenceBounds=prediction.foregroundBounds;
  if (!referenceBounds) throw Error('Missing foreground bounds');
  const colorOutput=makeCanvas(), matched=new SceneRenderer(colorOutput);
  matched.setScene(raw);
  for (const look of ['simple','matched']) {
    matched.render(prediction,{look,width:1});
    const cropped=colorOutput.toDataURL();
    prediction.foregroundBounds=null;
    matched.render(prediction,{look,width:1});
    if(cropped!==colorOutput.toDataURL()) throw Error('Foreground bounds clipped the '+look+' render');
    prediction.foregroundBounds=referenceBounds;
  }
  return {foregroundFraction:fraction, background:pixel(prediction,0,0)[3]};
}
"""

BENCHMARK = r"""
async () => {
  const {SceneRenderer} = await import('/engine.js');
  const {PersonCutout} = await import('/media.js');
  const {makeCanvas} = await import('/canvas.js');
  async function load(path) {
    const picture = new Image(); picture.src=path; await picture.decode(); return picture;
  }
  const [photo, visitor, mask] = await Promise.all([
    load('/samples/kitty-hawk.jpg'),load('/samples/traveler.png'),load('/samples/wilbur-mask.png')
  ]);
  const scene = makeCanvas(640,480), capture = makeCanvas(640,480), out = makeCanvas();
  scene.getContext('2d').drawImage(photo,0,0,640,480);
  const renderer = new SceneRenderer(out); renderer.setScene(scene);
  renderer.setReference(mask); renderer.setForeground(mask);
  document.body.replaceChildren(out);
  const ctx = capture.getContext('2d');
  function paint() {
    ctx.fillStyle='#90aeb5'; ctx.fillRect(0,0,640,480);
    ctx.drawImage(visitor,205 + 85*Math.sin(performance.now()/700),10,218,461);
  }
  paint();
  const stream = capture.captureStream(30), timer = setInterval(paint,1000/30);
  const movie = document.createElement('video');
  movie.muted=true; movie.playsInline=true; movie.srcObject=stream;
  try {
    await movie.play();
    const cutter = new PersonCutout(), options = {look:'matched',width:0.55};
    renderer.render(await cutter.frame(movie),options);
    const start = performance.now();
    let count=0, lastTime=-1;
    while (performance.now()-start < 30000) {
      const frame = await new Promise(resolve => movie.requestVideoFrameCallback((_,f) => resolve(f)));
      if (frame.mediaTime === lastTime) continue;
      lastTime=frame.mediaTime;
      renderer.render(await cutter.frame(movie),options);
      count++;
    }
    const seconds = (performance.now()-start)/1000;
    return {frames:count,seconds:seconds.toFixed(2),fps:(count/seconds).toFixed(2),userAgent:navigator.userAgent};
  } finally {
    clearInterval(timer); movie.pause();
    for (const track of stream.getTracks()) track.stop();
  }
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", action="store_true", help="also process a 30-second synthetic camera stream")
    args = parser.parse_args()
    handler = partial(QuietHandler, directory=str(ROOT / "public"))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    channel=os.environ.get("BROWSER_CHANNEL"),
                    args=["--enable-unsafe-swiftshader"],
                )
                page = browser.new_page()
                origin = f"http://127.0.0.1:{server.server_port}/"
                page.route("**/*", lambda route: route.continue_()
                           if route.request.url.startswith(origin) else route.abort())
                # Any same-origin HTML document suffices; avoid loading the studio UI.
                page.goto(origin + "vendor/")
                result = page.evaluate(CHECK)
                assert result["background"] < 10, result
                if args.benchmark:
                    print("640x480 synthetic camera, matched look:", page.evaluate(BENCHMARK), flush=True)
                browser.close()
        finally:
            server.shutdown()
    print(f"Browser compositing, color, mask and offline MediaPipe checks passed. {result}")


if __name__ == "__main__":
    main()
