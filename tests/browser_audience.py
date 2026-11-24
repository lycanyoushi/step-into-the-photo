"""Check audience fullscreen, blocked fullscreen, focus and canvas continuity."""

import io
import os

from PIL import Image
from playwright.sync_api import sync_playwright


FIXTURE = """<!doctype html><html><head><link rel="stylesheet" href="./studio.css">
<link rel="stylesheet" href="./audience.css"></head><body>
<button id="present">Present</button><div class="mat"><div id="picture"><canvas id="scene"
width="160" height="240" tabindex="0"></canvas></div></div>
<script type="module">
import {setupAudience} from './audience.js';
const photo = document.querySelector('#scene'), picture = document.querySelector('#picture');
window.originalCanvas = photo;
const ctx = photo.getContext('2d'); let frame = 0;
function draw() {
  ctx.fillStyle = '#4d7aff'; ctx.fillRect(0,0,160,240);
  ctx.fillStyle = 'white'; ctx.fillRect(0,(++frame%200),8,8);
  photo.dataset.frame = frame; requestAnimationFrame(draw);
}
draw(); window.exits=0;
window.stage = setupAudience({picture, canvas:photo, onExit:()=>{ window.exits++; }});
document.querySelector('#present').onclick=()=>stage.enter();
window.ready=true;
</script></body></html>"""


def main():
    base = os.environ.get("STEP_STUDIO_URL", "http://127.0.0.1:5181").rstrip("/")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL", "msedge"))
        page = browser.new_page(viewport={"width": 800, "height": 620}, device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/audience-check.html", lambda route: route.fulfill(content_type="text/html", body=FIXTURE))
        page.goto(base + "/audience-check.html")
        page.wait_for_function("window.ready")
        page.locator("#present").click()
        page.wait_for_function("document.fullscreenElement === document.querySelector('#picture')")
        page.wait_for_function("window.stage.active && document.querySelector('.audience-room').open")
        first = int(page.locator("#scene").get_attribute("data-frame"))
        page.wait_for_function("frame=>Number(originalCanvas.dataset.frame)>frame+2", arg=first)
        assert page.evaluate("originalCanvas === document.getElementById('scene')")
        shot = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
        w, h = shot.size
        for x, y in [(w//2, 1), (w//2, h//2), (w//2, h-2)]:
            assert shot.getpixel((x, y)) == (77, 122, 255), (x, y)
        assert shot.getpixel((1, h//2)) == (0, 0, 0)
        page.evaluate("document.exitFullscreen()")
        page.wait_for_function("!stage.active && exits===1")
        assert page.locator(".mat > #picture > #scene").count() == 1
        assert page.evaluate("document.activeElement.id === 'present' && !originalCanvas.inert")

        page.evaluate("""() => { document.querySelector('#picture').requestFullscreen =
          () => Promise.reject(new DOMException('Fullscreen blocked', 'NotAllowedError')); }""")
        page.locator("#present").click()
        page.wait_for_function("stage.active && !document.fullscreenElement")
        assert page.locator("#picture").bounding_box() == {"x": 0, "y": 0, "width": 800, "height": 620}
        page.wait_for_function("!document.querySelector('#picture').classList.contains('audience-awake')")
        page.mouse.move(200, 300)
        page.get_by_role("button", name="Back to setup").click()
        page.wait_for_function("!stage.active && exits===2")
        page.locator("#present").click()
        page.keyboard.press("Escape")
        page.wait_for_function("!stage.active && exits===3 && !document.querySelector('.audience-room').open")
        page.evaluate("""async () => {
          await document.documentElement.requestFullscreen();
          stage.enter();
          stage.exit();
        }""")
        assert page.evaluate("document.fullscreenElement === document.documentElement && exits === 4")
        page.evaluate("document.exitFullscreen()")
        page.evaluate("""() => {
          let resolveFirst;
          document.querySelector('#picture').requestFullscreen = () => new Promise(r => { resolveFirst = r; });
          stage.enter();
          stage.exit();
          const previous = resolveFirst;
          stage.enter();
          previous();
          resolveFirst();
        }""")
        assert page.evaluate("stage.active")
        page.keyboard.press("Escape")
        page.wait_for_function("!stage.active && exits === 6")
        assert not errors, errors
        browser.close()
    print("PASS: native and denied fullscreen, animated original canvas, portrait letterboxing, focus, pointer and Escape return")


if __name__ == "__main__":
    main()
