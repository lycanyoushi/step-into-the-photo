"""Verify blinded votes and decode the exported comparison to check its frame count."""

import base64
import os
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import threading

import cv2
import imageio_ffmpeg
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

from browser_engine import QuietHandler, ROOT


STUDY = """
async encoded => {
  const {openComparison, getVotes} = await import('/study.js');
  document.body.innerHTML = '<dialog id="comparison-dialog"><div id="compare-content"></div></dialog>';
  function canvas(w,h,color) {
    const c = document.createElement('canvas'); c.width=w; c.height=h;
    if (color) { const g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,w,h); }
    return c;
  }
  const scene=canvas(96,64,'#526068'), mask=canvas(96,64), cutout=canvas(32,32,'red');
  const ctx=mask.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,48,64);
  const props={scene,cutout,placement:{x:.5,y:.5,width:.4},sceneName:'demo',tapMethod:'GrabCut'};
  await openComparison(props);
  if (document.querySelector('[data-group]').value!=='flat') throw Error('unavailable comparisons enabled');
  document.querySelector('dialog').close();
  await new Promise(r=>setTimeout(r,40));
  await openComparison({...props,manualMask:mask,tapMask:mask});
  document.querySelector('[data-choice]').value='tie';
  document.querySelector('[data-notes]').value='The edge around the collar.';
  document.querySelector('[data-vote]').click();
  const vote=getVotes()[0];
  if (vote.choice!=='tie' || vote.order.sort().join()!=='B,C' || vote.tapMethod!=='GrabCut') throw Error('vote');
  const group=document.querySelector('[data-group]');
  group.value='tones';group.dispatchEvent(new Event('change'));
  if (document.querySelectorAll('.comparison-grid canvas').length!==3) throw Error('tones group');
  document.querySelector('dialog').close();
  await new Promise(r=>setTimeout(r,40));
  const blob=new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'video/webm'});
  const original=document.createElement('video');original.src=URL.createObjectURL(blob);
  let calls=0;
  await openComparison({...props,video:original,tapMask:mask,manualMask:mask,makeFrame(v){
    if(v===original) throw Error('original player was modified');
    const frame=canvas(96,64);frame.getContext('2d').drawImage(v,0,0);calls++;return frame;
  }});
  if (calls!==12 || original.currentTime!==0) throw Error('sample sequence: '+calls);
  const slider=document.querySelector('[data-frame]');
  slider.value='8';slider.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,50));
  if (!document.querySelector('[data-time]').textContent.includes('9 / 12')) throw Error('scrub');
  return {calls,vote};
}
"""


def main():
    handler = partial(QuietHandler, directory=str(ROOT / "public"))
    with TemporaryDirectory() as folder, ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        path = Path(folder)
        movie = path / "take.webm"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-f", "lavfi",
                        "-i", "testsrc=size=96x64:rate=12:duration=1", "-c:v", "libvpx", "-pix_fmt",
                        "yuv420p", str(movie)], check=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL"))
                page = browser.new_page()
                page.goto(f"http://127.0.0.1:{server.server_port}/vendor/")
                result = page.evaluate(STUDY, base64.b64encode(movie.read_bytes()).decode())
                with page.expect_download(timeout=10000) as still:
                    page.locator("[data-png]").click()
                still.value.save_as(path / "comparison.png")
                with Image.open(path / "comparison.png") as picture:
                    data = np.asarray(picture)
                    np.testing.assert_array_equal(data[:, :96], data[:, 96:])
                with page.expect_download(timeout=30000) as report:
                    page.locator("[data-clip]").click()
                report.value.save_as(path / "comparison.webm")
                reader = cv2.VideoCapture(str(path / "comparison.webm"))
                try:
                    count = 0
                    decoded = []
                    while True:
                        ok, frame = reader.read()
                        if not ok:
                            break
                        assert frame.shape[:2] == (64, 192)
                        assert np.abs(frame[:, :96].astype(float) - frame[:, 96:]).mean() < 4
                        decoded.append(frame)
                        count += 1
                    assert count == result["calls"] == 12, (count, result)
                    assert not np.array_equal(decoded[0], decoded[-1])
                finally:
                    reader.release()
                browser.close()
        finally:
            server.shutdown()
    print("Blind still vote, missing-mask handling and private take passed. Decoded 12 synchronized WebM frames.")


if __name__ == "__main__":
    main()
