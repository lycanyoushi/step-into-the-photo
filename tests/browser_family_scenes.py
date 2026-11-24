"""Check family gallery handoff and live editing when an unprepared scan replaces the background."""

import os
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageOps
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = os.getenv("STEP_STUDIO_URL", "http://127.0.0.1:5181").rstrip("/")


def main():
    with TemporaryDirectory() as tmp, sync_playwright() as p:
        scan = Path(tmp) / "personal-portrait-scan.tiff"
        # Flip and crop a development image; the studio receives only the file, with no preset metadata.
        with Image.open(ROOT / "public/scene-bank/spacelab-crew.jpg") as source:
            ImageOps.mirror(source.crop((210, 0, 860, 720))).save(scan)
        browser = p.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"))
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(URL + "/families.html")
        page.wait_for_function("document.querySelectorAll('.family-card').length === 4")
        for card in page.locator(".family-card").all():
            card.get_by_text("Play example").click()
            clip = card.locator("video")
            clip.evaluate("async v => { if(v.currentTime<0.03) await new Promise(r => v.addEventListener('timeupdate',r,{once:true})); }")
            assert clip.evaluate("v => v.videoWidth > 0 && v.duration === 10 && v.currentTime > 0")
            card.get_by_text("Show original").click()
            assert card.locator("img").is_visible()
        page.locator("#shore-walk").get_by_text("Open in studio").click()
        page.locator("#person-name").filter(has_text="Studio dancer.mp4").wait_for()
        assert page.locator("#floor-reflection").is_checked()
        assert page.locator("#space-mode").input_value() == "outline"
        assert page.locator("#live-tools").is_visible()
        with page.expect_response(lambda r: r.url.endswith("/api/depth") and r.status == 200):
            page.locator("#scene-file").set_input_files(scan)
        page.wait_for_function("document.querySelector('#depth-help').textContent.includes('Depth follows')", timeout=25000)
        assert page.locator("#space-mode").input_value() == "auto"
        assert not page.locator("#floor-reflection").is_checked()
        assert page.locator("#scene-name").inner_text() == scan.name
        assert page.locator("#scene").evaluate("el=>[el.width,el.height]") == [650, 720]
        assert page.locator("#person-name").inner_text() == "Studio dancer.mp4"
        page.locator("#space-mode").select_option("manual")
        for level in ("0", "100"):
            page.locator("#depth-level").fill(level)
            assert page.locator("#depth-level-out").inner_text() == level + "%"
        page.locator("#library").click()
        page.locator("#collection").select_option("families")
        page.get_by_role("button", name="Together in the kitchen").click()
        page.wait_for_function("document.querySelector('#scene-name').textContent==='Together in the kitchen'")
        assert page.locator("#space-mode").input_value() == "outline"
        assert page.locator("#person-name").inner_text() == "Studio dancer.mp4"
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(URL + "/families.html")
        page.locator(".family-card").first.wait_for()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert not errors, errors
        browser.close()
        print("PASS: four clips and original views, prepared scene, moving visitor across arbitrary TIFF and family switch, automatic/manual depth, mobile gallery")


if __name__ == "__main__":
    main()
