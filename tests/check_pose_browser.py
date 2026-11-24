"""Exercise the local landmarker and textured warp in Chrome.

Run with: python tests/check_pose_browser.py
Use --figures to regenerate the illustrations displayed in Field notes.
Requires Playwright and Chrome (or set PLAYWRIGHT_BROWSER_CHANNEL).
"""

import argparse
import base64
import functools
import http.server
import json
import os
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


PUBLIC = Path(__file__).resolve().parents[1] / "public"


class QuietServer(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


BROWSER_CHECK = """
async () => {
  const pose = await import('./pose.js');
  const {SceneRenderer} = await import('./engine.js');
  const {canvas, copyImage, readImage} = await import('./ui.js');
  const [visitor,scene,mask] = await Promise.all(['traveler.png','kitty-hawk.jpg','wilbur-mask.png']
    .map(name => readImage('./samples/'+name)));
  const src = pose.padForPose(copyImage(visitor));
  const rig = await pose.createPoseRig(src);
  const assert = (condition, label) => { if (!condition) throw Error(label); };
  assert(rig.detected, 'Real source landmarks');
  assert(pose.renderPose(src,rig)===src,'Identity render');
  const before = { ...rig.source.leftWrist };
  assert(pose.hitJoint(rig,before.x,before.y,2)==='leftWrist','Joint hit testing');
  pose.moveJoint(rig,'leftWrist',before.x+10,before.y-7,true);
  assert(rig.target.leftWrist.x===rig.source.leftWrist.x,'Source calibration preserves rest pose');
  pose.moveJoint(rig,'leftWrist',before.x,before.y,true);
  const poseFrame = (skin, anchors = false) => {
    const out=canvas(390,360), ctx=out.getContext('2d');
    ctx.fillStyle='#343931'; ctx.fillRect(0,0,out.width,out.height);
    ctx.save(); ctx.translate(195,180); ctx.scale(420/src.width,420/src.height);
    ctx.translate(-src.width/2,-src.height/2); ctx.drawImage(skin,0,0);
    if(anchors) pose.drawRig(ctx,rig,true);
    ctx.restore(); return out.toDataURL('image/webp',.93);
  };
  const figures={'pose-source':poseFrame(src), 'pose-joints':poseFrame(src,true)};
  pose.applyPosePreset(rig,'wave');
  const wave=pose.renderPose(src,rig);
  assert(rig.target.leftWrist.y < rig.target.leftElbow.y,'Wave forearm angles upward');
  const hand=rig.target.leftHand;
  const region=wave.getContext('2d').getImageData(Math.floor(hand.x)-5,Math.floor(hand.y)-5,11,11);
  assert(region.data.some((v,i)=>i%4===3&&v>128),'Visible warped glove at target hand');
  figures['pose-wave']=poseFrame(wave);
  const mirrored=canvas(visitor.width,visitor.height), mc=mirrored.getContext('2d');
  mc.translate(mirrored.width,0);mc.scale(-1,1);mc.drawImage(visitor,0,0);
  await pose.poseFromPhoto(rig,mirrored);
  assert(Math.hypot(rig.target.nose.x-rig.source.nose.x,rig.target.nose.y-rig.source.nose.y)>2,
    'Photo reference changes target geometry');
  assert(pose.renderPose(src,rig)!==src,'Reference pose renders');
  pose.applyPosePreset(rig,'original');
  assert(pose.renderPose(src,rig)===src,'Restored source');
  const blank=canvas(120,120), bc=blank.getContext('2d'); bc.fillStyle='#74542e';bc.fillRect(10,20,90,88);
  const manual=await pose.createPoseRig(blank);
  assert(!manual.detected && Object.keys(manual.source).length===17,'Manual fallback for missing pose');
  let failed=false;
  try {await pose.poseFromPhoto(rig,blank);} catch {failed=true;}
  assert(failed,'Reject an empty pose reference');

  // Put the green glove in front of the red jacket; raster output verifies depth and texture.
  const s={nose:{x:100,y:35,z:0}};
  const c=canvas(200,200), cc=c.getContext('2d');
  cc.fillStyle='#e63031';cc.fillRect(78,55,44,65);
  for(const [side,sgn] of [['left',1],['right',-1]]) {
    const joints={Shoulder:[20,58],Elbow:[40,74],Wrist:[53,87],Hand:[58,95],
      Hip:[14,115],Knee:[17,143],Ankle:[20,169],Foot:[25,177]};
    for(const [key,[dx,y]] of Object.entries(joints)) s[side+key]={x:100+sgn*dx,y,z:0};
    for(const chain of [['Shoulder','Elbow','Wrist','Hand'],['Hip','Knee','Ankle','Foot']]) {
      cc.strokeStyle=side==='left'?'#19c13b':'#3161ae';cc.lineWidth=12;cc.lineCap='round';
      cc.beginPath();chain.forEach((key,i)=>cc[i?'lineTo':'moveTo'](s[side+key].x,s[side+key].y));cc.stroke();
    }
  }
  const testRig={source:s,target:structuredClone(s)};
  pose.moveJoint(testRig,'leftWrist',104,83);pose.moveJoint(testRig,'leftHand',97,85);
  const cross=pose.renderPose(c,testRig).getContext('2d').getImageData(97,85,1,1).data;
  assert(cross[1]>cross[0]*2 && cross[3]>190,'Crossing left hand retains green texture over red jacket');

  const result=canvas(scene.width,scene.height), renderer=new SceneRenderer(result);
  renderer.setScene(scene);
  const crop=layer=>{
    const c=canvas(408,310);
    c.getContext('2d').drawImage(layer,621,136,204,155,0,0,408,310);
    return c.toDataURL('image/webp',.94);
  };
  const placement={width:.061,x:.863,y:.433};
  figures['original']=crop(scene);
  renderer.render(visitor,{...placement,look:'untreated'}); figures['overlay']=crop(result);
  renderer.setReference(mask); renderer.setForeground(mask);renderer.render(visitor,{...placement,look:'matched'});
  figures['composite']=crop(result);
  return {figures, jointCount:Object.keys(rig.source).length};
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--figures", action="store_true")
    args = parser.parse_args()
    handler = functools.partial(QuietServer, directory=PUBLIC)
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    channel=os.environ.get("PLAYWRIGHT_BROWSER_CHANNEL", "chrome"),
                    headless=True, args=["--enable-unsafe-swiftshader"],
                )
                page = browser.new_page()
                page.goto(f"http://127.0.0.1:{server.server_port}/pose.js")
                result = page.evaluate(BROWSER_CHECK)
                browser.close()
        finally:
            server.shutdown()
    figures = result.pop("figures")
    if args.figures:
        dest = PUBLIC / "figures"
        dest.mkdir(exist_ok=True)
        for name, data in figures.items():
            (dest / f"{name}.webp").write_bytes(base64.b64decode(data.split(",", 1)[1]))
    print("Pose/renderer checks passed.", json.dumps(result))


if __name__ == "__main__":
    main()
