"""Check real cutout detail on a specific frame of the bundled studio dancer."""

import os
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"))
        page = browser.new_page()
        page.route("**/matte-check", lambda route: route.fulfill(content_type="text/html", body="<html></html>"))
        page.goto(os.getenv("STEP_STUDIO_URL", "http://127.0.0.1:5181").rstrip("/") + "/matte-check")
        result = page.evaluate("""async () => {
          const { PersonCutout } = await import('/media.js');
          const { refineCameraEdge } = await import('/live-matte.js');
          const { MatteMotion } = await import('/matte-motion.js');
          const video = document.createElement('video');
          video.muted = true;
          video.src = '/demo/movement.mp4';
          await new Promise(resolve => video.onloadeddata = resolve);
          video.currentTime = 4.80;
          await new Promise(resolve => video.onseeked = resolve);
          const frames = {};
          for (const photographic of [false, true]) {
            const cutter = new PersonCutout({live: true, photographic});
            const cut = await cutter.frame(video, {time: 4.8});
            const ctx = cut.getContext('2d');
            function opacity(x,y,w,h) {
              const rgba = ctx.getImageData(x,y,w,h).data;
              let sum = 0;
              for (let i=3; i<rgba.length; i+=4) sum += rgba[i];
              return sum/(w*h);
            }
            frames[photographic ? 'detail' : 'legacy'] = {
              sleeve: opacity(416,102,9,15), shoe: opacity(417,363,9,6),
              corner: opacity(580,420,60,60), method: cutter.method
            };
          }
          // A sharp transition in donor RGB and a soft segmentation border.
          // The fractional edge pixel contains some of the old background.
          const image = new ImageData(24, 7), mask = new Uint8ClampedArray(image.data.length);
          for (let y=0; y<7; y++) for (let x=0; x<24; x++) {
            const i=4*(y*24+x), coverage=x<12?0:x===12?.5:1;
            for (let c=0;c<3;c++) image.data[i+c]=40+160*coverage;
            image.data[i+3]=255; mask[i+3]=Math.max(0,Math.min(255,128+42*(x-12)));
          }
          refineCameraEdge(image, mask, 1);
          const at = x => [...image.data.slice(4*(3*24+x),4*(3*24+x)+4)];
          function patch(offset) {
            const color = new ImageData(96,72), background = new Float32Array(96*72);
            for(let y=0;y<72;y++) for(let x=0;x<96;x++) {
              const i=y*96+x, fore=x>=24+offset&&x<64+offset&&y>=12&&y<57;
              background[i]=fore?0:1;
              for(let c=0;c<3;c++) color.data[4*i+c]= fore ? 91+(37*y+13*(x-offset)+20*c)%111 : 17+(y+x)%5;
              color.data[4*i+3]=255;
            }
            return {color,background};
          }
          const first=patch(0), second=patch(3), tracker=new MatteMotion();
          tracker.remember(first.color,first.background,96,72,1,false,50);
          const moved=tracker.predict(second.color,1.06,false);
          const mismatch = m => m.reduce((n,v,i)=>n+Math.abs(v-second.background[i]),0);
          const registered=moved?mismatch(moved.background):1e7;
          const flash=new ImageData(96,72);
          flash.data.fill(240);
          const sceneCut = tracker.predict(flash,1.12,false);
          tracker.remember(first.color,first.background,96,72,1,false,50);
          const bigStep = tracker.predict(patch(21).color,1.10,false);
          return {frames, edge: [at(11),at(12),at(13)], errorBefore:mismatch(first.background),
                  errorAfter:registered, sceneCutIgnored:sceneCut===null, fastMotionIgnored:bigStep===null};
        }""")
        legacy, detail = result["frames"]["legacy"], result["frames"]["detail"]
        assert legacy["method"] == "MediaPipe" and detail["method"] == "MediaPipe multiclass", result
        assert detail["sleeve"] > 220 and detail["sleeve"] > legacy["sleeve"] + 150, result
        assert detail["shoe"] > 230 and detail["corner"] < 0.5, result
        outer, mixed, inner = result["edge"]
        assert outer[3] < 25 and inner[3] > 225, result
        assert 115 <= mixed[3] <= 140 and mixed[0] > 135, result
        assert result["errorAfter"] < result["errorBefore"] * .65 and result["sceneCutIgnored"], result
        assert result["fastMotionIgnored"], result
        print("PASS: real sleeve, shoe, empty background, guided edge and foreground color.", result)
        # Force delegate/model startup failure, then exercise the same photograph
        # workflow on the installed lighter model. No camera permissions needed.
        page.route("**/selfie_multiclass_256x256.tflite",
                   lambda route: route.fulfill(status=404, body="unavailable"))
        page.reload()
        fallback = page.evaluate("""async () => {
          const {PersonCutout} = await import('/media.js');
          const video = document.createElement('video');
          video.muted=true;video.src='/demo/movement.mp4';
          await new Promise(r => video.onloadeddata=r);
          video.currentTime=4.8;
          await new Promise(r => video.onseeked=r);
          const cutter = new PersonCutout({live:true,photographic:true});
          const cut = await cutter.frame(video, {time:4.8});
          return [cutter.method,cut.foregroundBounds.width,cut.height,cut.width];
        }""")
        assert fallback[0] == "MediaPipe" and fallback[1] > 50 and fallback[2:] == [480, 640], fallback
        print("PASS: detailed model unavailable, CPU cutout rendered.", fallback)
        browser.close()


if __name__ == "__main__":
    main()
