"""Exercise the live matte, floor contact and scene depth compositor on decoded dance footage."""

import os
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright
import cv2


ROOT = Path(__file__).resolve().parents[1]

CHECK = r"""async frames => {
  const {SceneRenderer} = await import('/engine.js');
  const {PersonCutout} = await import('/media.js');
  const {makeCanvas} = await import('/canvas.js');
  const {LiveMatte} = await import('/live-matte.js');
  const scene=makeCanvas(120,100), visitor=makeCanvas(20,40), out=makeCanvas();
  function solid(c, color, x=0,y=0,w=c.width,h=c.height) {
    const ctx=c.getContext('2d'); ctx.fillStyle=color; ctx.fillRect(x,y,w,h);
  }
  function gray(c,x,y) { return c.getContext('2d').getImageData(x,y,1,1).data[0]; }
  function expect(condition,message) { if (!condition) throw Error(message); }
  const cutGround={x:10,y:40,bodyHeight:40,supports:[{x:10,y:40,width:4}]};
  solid(scene,'#ffffff'); solid(visitor,'#000000');
  visitor.floorContact=cutGround;
  const field=makeCanvas(120,100); solid(field,'black'); solid(field,'white',60,0,60,100);
  const r=new SceneRenderer(out); r.setScene(scene); r.setDepthMap(field);
  const p={x:.5,y:.5,width:1/3,look:'untreated'};
  r.render(visitor,{...p,depth:.5});
  expect(gray(out,50,50)===0 && gray(out,70,50)===255,'near photo pixels must cover visitor');
  r.render(visitor,{...p,depth:1});
  expect(gray(out,70,50)===0,'near visitor should cover high-depth background');
  r.render(visitor,{...p,depth:-.01});
  const clean=makeCanvas(120,100); solid(clean,'#555555'); r.setCleanPlate(clean);
  r.render(visitor,{...p,mode:'replace',depth:.5});
  expect(gray(out,70,50)===85,'depth must reveal reconstructed plate');
  const fixed=makeCanvas(120,100); solid(fixed,'black'); solid(fixed,'white',42,0,6,100);
  r.setForeground(fixed); r.render(visitor,{...p,depth:1});
  expect(gray(out,44,50)===255,'explicit foreground must retain priority over scene depth');
  expect(r.depthAtFeet(visitor,{...p,x:.3})===0 && r.depthAtFeet(visitor,{...p,x:.7})===1,
    'sample near the transformed feet, including after lateral placement');
  expect(r.depthAtFeet(visitor,{...p,y:1.2})===null,'offscreen feet must have no sample');
  r.setForeground(null); r.setDepthMap(null);
  r.render(visitor,p); const unshadowed=gray(out,60,90);
  r.render(visitor,{...p,grounded:true}); expect(gray(out,60,90)<unshadowed,'foot contact must darken floor');
  r.render(visitor,{...p,reflection:true,y:.36}); expect(gray(out,60,83)<245,'reflective floor should show the visitor');
  r.setDepthMap(field); r.render(visitor,{...p,reflection:true,y:.36,depth:.5});
  expect(gray(out,55,83)<245 && gray(out,65,83)===255,'depth must occlude the mirrored visitor');
  r.setDepthMap(null);
  visitor.floorContact=null; r.render(visitor,{...p,grounded:true});
  expect(gray(out,60,90)===unshadowed,'cropped body must not leave a floating shadow');
  const history=new LiveMatte();
  history.begin(20,10,0,false); history.begin(20,10,.04,false);
  expect(history.blend && history.offsets[255+12]>0 && history.offsets[255+100]===0,
    'stationary confidence jitter should damp and fast motion should snap');
  history.begin(20,10,.43,false); expect(!history.blend,'reset history after pause');
  history.begin(20,10,.4,false); expect(!history.blend,'reset history on reverse seek');
  history.begin(20,10,.44,true); expect(!history.blend,'reset history when mirrored');
  const cut=new PersonCutout({live:true}), raw=new PersonCutout(), frame=makeCanvas(640,480);
  const ctx=frame.getContext('2d');
  const sample=makeCanvas(320,240), sampleCtx=sample.getContext('2d',{willReadFrequently:true});
  function alpha(image) {
    sampleCtx.clearRect(0,0,320,240);sampleCtx.drawImage(image,0,0,320,240);
    return sampleCtx.getImageData(0,0,320,240).data;
  }
  let changed=0, oldOpaque=0, supported=0, minX=Infinity, maxX=-Infinity;
  let decoded;
  for(let n=0;n<frames.length;n++) {
    const t=1+n/25;
    decoded=new Image();decoded.src='data:image/jpeg;base64,'+frames[n];await decoded.decode();
    ctx.drawImage(decoded,0,0,640,480);
    const sample=await cut.frame(frame,{time:t}), a=alpha(sample), b=alpha(await raw.frame(frame));
    for(let i=3;i<a.length;i+=4) {
      if(a[i]!==b[i]) changed++;
      if(a[i]>90 && b[i]===0) oldOpaque++;
    }
    if(sample.floorContact) {
      supported++; minX=Math.min(minX,sample.floorContact.x); maxX=Math.max(maxX,sample.floorContact.x);
    }
  }
  expect(changed>100,'temporal matte should change near-stationary confidences');
  expect(oldOpaque===0,'vacated background must not retain opaque trails');
  expect(supported>18 && maxX-minX>4,'support follows the moving full-body dancer');
  solid(frame,'#cccccc');
  const empty=await cut.frame(frame,{time:2.28});
  expect(!empty.floorContact,'support clears when dancer leaves');
  ctx.drawImage(decoded,188,0,270,220,0,0,640,480);
  const cropped=await cut.frame(frame,{time:3.2});
  expect(!cropped.floorContact,'upper-body crop must not acquire a floor');
  return {frames:32, supported, footMotionPixels:+(maxX-minX).toFixed(2), changed, ghostPixels:oldOpaque};
}"""


class QuietServer(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    capture = cv2.VideoCapture(str(ROOT / "public/demo/movement.mp4"))
    frames = []
    for i in range(25 + 32):
        ok, frame = capture.read()
        assert ok, "Could not decode the bundled visitor take"
        if i >= 25:
            success, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 94])
            assert success
            frames.append(base64.b64encode(encoded).decode())
    capture.release()
    assert len(set(frames)) == len(frames)
    with ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietServer, directory=str(ROOT / "public"))) as host:
        Thread(target=host.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL", "msedge"))
                page = browser.new_page()
                page.goto(f"http://127.0.0.1:{host.server_port}/vendor/")
                result = page.evaluate(CHECK, frames)
                browser.close()
                print("Live matte, contact and depth checks passed:", result)
        finally:
            host.shutdown()


if __name__ == "__main__":
    main()
