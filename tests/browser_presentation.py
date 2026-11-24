"""Check the photo → live camera → audience demonstration through its visible controls.

Run with a local studio server. Edge's file-backed camera replays the bundled
dance take. The test never requests a physical camera or a microphone.
"""

import base64
from io import BytesIO
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageOps
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
URL = os.getenv("STEP_STUDIO_URL", "http://127.0.0.1:5181").rstrip("/")

# Observe the real studio's requests and its decoded camera timestamps. The
# injected rejection exercises a retry without changing a browser permission.
OBSERVE_CAMERA = """
const probe = window.cameraProbe = { calls: 0, tracks: [], denyNext: false, time: -1, playCalls: 0 };
const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async constraints => {
  ++probe.calls;
  if (probe.denyNext) {
    probe.denyNext = false;
    throw new DOMException('Test camera access denied', 'NotAllowedError');
  }
  const stream = await acquire(constraints);
  probe.tracks.push(...stream.getTracks());
  return stream;
};
const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (...args) {
  ++probe.playCalls;
  return play.apply(this, args);
};
const onFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
  return onFrame.call(this, (now, metadata) => {
    if (this.srcObject) probe.time = metadata.mediaTime;
    return callback(now, metadata);
  });
};
"""


def snapshot(page):
    uri = page.locator("#scene").evaluate("canvas => canvas.toDataURL('image/png')")
    return np.asarray(Image.open(BytesIO(base64.b64decode(uri.split(",", 1)[1]))).convert("RGB"))


def camera_motion(page, reference):
    """Capture five independent camera moments and compare their visible pixels."""
    samples = []
    time = page.evaluate("cameraProbe.time")
    for _ in range(5):
        page.wait_for_function("previous => cameraProbe.time >= previous + .20", arg=time)
        time = page.evaluate("cameraProbe.time")
        frame = snapshot(page)
        difference = np.any(frame != reference, axis=2)
        assert difference.sum() > 500, "The camera advances but the person does not appear"
        assert difference.mean() < 0.4 and not difference[:8, :].any(), (
            "Photo pixels beyond the visitor unexpectedly changed"
        )
        samples.append(frame)
    changes = [int(np.any(a != b, axis=2).sum()) for a, b in zip(samples, samples[1:])]
    assert min(changes) > 100, f"The visible composite stopped moving: {changes}"
    return changes


def main():
    with TemporaryDirectory() as temp, sync_playwright() as p:
        camera = Path(temp) / "visitor.y4m"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i",
                        str(ROOT / "public/demo/movement.mp4"), "-pix_fmt", "yuv420p",
                        str(camera)], check=True)
        photo = Path(temp) / "own photograph.png"
        with Image.open(ROOT / "public/families/family-kitchen.jpg") as image:
            prepared = ImageOps.fit(ImageOps.mirror(image.convert("RGB")), (800, 530))
            # Encode only RGB pixels: a private photograph with no preset or color profile.
            Image.fromarray(np.asarray(prepared)).save(photo)
            reference = np.array(prepared)

        browser = p.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"), args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
            f"--use-file-for-fake-video-capture={camera}",
        ])
        page = browser.new_page(viewport={"width": 1200, "height": 840})
        page.set_default_timeout(45000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script(OBSERVE_CAMERA)
        page.goto(URL + "/?live=1")
        page.wait_for_function("document.querySelector('#live-status')?.textContent.toLowerCase().includes('off')")
        # Decode the original with the same browser JPEG decoder as the studio.
        page.wait_for_function("""async () => {
          const actual = document.querySelector('#scene');
          const img = new Image(); img.src = './families/park-picnic.jpg'; await img.decode();
          if (actual.width !== img.naturalWidth || actual.height !== img.naturalHeight) return false;
          const expected = document.createElement('canvas');
          expected.width = actual.width; expected.height = actual.height;
          expected.getContext('2d').drawImage(img, 0, 0);
          return expected.toDataURL() === actual.toDataURL();
        }""")
        assert page.evaluate("cameraProbe.calls === 0 && cameraProbe.playCalls === 0")

        with page.expect_file_chooser() as chooser:
            page.locator("#live-photo").click()
        chooser.value.set_files(photo)
        page.wait_for_function("document.querySelector('#scene').width === 800")
        assert np.array_equal(snapshot(page), reference)

        page.evaluate("cameraProbe.denyNext = true")
        page.locator("#live-camera").click()
        page.wait_for_function("cameraProbe.calls === 1 && !document.querySelector('#live-camera').disabled")
        assert np.array_equal(snapshot(page), reference)
        assert page.evaluate("cameraProbe.tracks.length === 0")
        page.locator("#live-camera").click()
        page.wait_for_function("document.querySelector('#live-status').textContent.toLowerCase().includes('live')")
        assert page.evaluate("cameraProbe.calls === 2 && cameraProbe.tracks.length === 1 && cameraProbe.tracks[0].kind === 'video'")
        preview = camera_motion(page, reference)

        page.locator("#live-adjust summary").click()
        page.locator("#visitor-exposure").fill("0.6")
        assert page.locator("#visitor-exposure-out").inner_text() == "+0.6 EV"
        page.locator("#auto-exposure").click()
        assert page.locator("#visitor-exposure").input_value() == "0"
        page.locator("#live-adjust summary").click()

        page.locator("#live-present").click()
        page.locator("dialog.audience-room[open] #picture.audience-picture #scene").wait_for()
        page.wait_for_function("""() => {
          const box = document.getElementById('picture').getBoundingClientRect();
          return box.width >= innerWidth - 2 && box.height >= innerHeight - 2;
        }""")
        audience = camera_motion(page, reference)
        page.keyboard.press("Escape")
        page.wait_for_function("!document.querySelector('dialog.audience-room[open]')")
        assert page.locator("#live-camera").is_visible()
        assert page.evaluate("cameraProbe.tracks[0].readyState === 'live' && cameraProbe.calls === 2")
        resumed = camera_motion(page, reference)

        page.locator("#live-camera").click()
        page.wait_for_function("cameraProbe.tracks.every(t => t.readyState === 'ended')")
        page.wait_for_function("document.querySelector('#live-status').textContent.toLowerCase().includes('off')")
        assert np.array_equal(snapshot(page), reference), "Stopping must restore the clean photograph"
        assert not errors, errors
        browser.close()
        print("PASS: original photo, own upload, camera permission retry, moving file-backed camera, "
              "audience presentation, Escape, continued movement, released track and exact original restoration")
        print(f"Changed pixels between successive camera samples: setup {preview}, audience {audience}, "
              f"after Escape {resumed}.")


if __name__ == "__main__":
    main()
