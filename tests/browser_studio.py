"""Check the browser workflows against a running local studio.

Run python tests/browser_studio.py while launch.ps1 is running.
Set STEP_STUDIO_URL or BROWSER_CHANNEL to test a different URL/browser.
"""

import io
import os
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def snapshot(page):
    import base64
    url = page.locator("#scene").evaluate("el => el.toDataURL()")
    return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGB")


def changed(a, b):
    return ImageChops.difference(a, b).getbbox() is not None


def settled(page):
    """The composite once the local models have answered and it stops changing.

    Scene depth and the measured colours both arrive shortly after an edit.
    """
    page.locator('#scene[data-tone="measured"], #scene[data-tone="estimated"]').wait_for(timeout=45000)
    previous = snapshot(page)
    for _ in range(40):
        page.wait_for_timeout(450)
        current = snapshot(page)
        if not changed(previous, current):
            return current
        previous = current
    raise AssertionError("The composite kept changing")


def same_picture(a, b):
    # Model inference on a graphics card is repeatable to a rounding step.
    difference = ImageChops.difference(a, b).convert("L")
    histogram = difference.histogram()
    return sum(histogram[5:]) < 0.002 * a.width * a.height


def point(page, selector, x, y):
    target = page.locator(selector)
    target.scroll_into_view_if_needed()
    bounds = target.bounding_box()
    target.click(position={"x": x * bounds["width"], "y": y * bounds["height"]})


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"))
        page = browser.new_page(viewport={"width": 1320, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(os.getenv("STEP_STUDIO_URL", "http://127.0.0.1:5181"))
        page.wait_for_function("document.querySelector('#feedback').textContent.includes('Sample ready')")
        sample = snapshot(page)
        page.locator('[data-view="original"]').click()
        original = snapshot(page)
        assert changed(sample, original)
        page.locator('[data-view="composite"]').click()
        page.locator('[data-tab="pose"]').click()
        page.locator('#rig').click()
        page.locator('#rig-done').wait_for(state="visible", timeout=45000)
        page.locator('#pose-preset').select_option("wave")
        page.locator('#rig-done').click()
        wave = settled(page)
        assert changed(sample, wave)
        page.locator('[data-tab="finish"]').click()
        page.locator('#stamp').click()
        assert not changed(wave, snapshot(page))
        page.locator('[data-tab="finish"]').click()
        page.locator('#undo-stamp').click()
        assert same_picture(wave, settled(page))
        page.locator('[data-tab="layers"]').click()
        page.locator('#replace').click()
        point(page, '#mask-canvas', 757/850, 211/505)
        page.wait_for_function("document.querySelector('#mask-hint').textContent.includes('outline ready')", timeout=75000)
        page.locator('#mask-apply').click()
        page.locator('#mask-dialog').wait_for(state="hidden", timeout=95000)
        assert page.locator('#replace').get_attribute('aria-pressed') == 'true'
        assert changed(original, snapshot(page))
        page.locator('#add').click()
        page.locator('#outline').click()
        page.locator('[data-tool="trace"]').click()
        for x, y in [(739,185),(774,185),(780,267),(739,267)]:
            point(page, '#mask-canvas', x/850, y/505)
        page.locator('#close-trace').click()
        page.locator('#mask-apply').click()
        page.locator('[data-tab="finish"]').click()
        page.locator('#study-tools summary').click()
        page.locator('#compare').click()
        page.wait_for_function("document.querySelectorAll('#compare-content canvas').length===2")
        page.locator('[data-choice]').select_option('tie')
        page.locator('[data-vote]').click()
        page.locator('#comparison-dialog form button').click()
        with page.expect_download() as saved:
            page.locator('#metrics').click()
        import json
        report = json.loads(Path(saved.value.path()).read_text())
        assert report["votes"][-1]["choice"] == "tie" and report["session"]
        with page.expect_download() as result:
            page.locator('#save').click()
        assert Image.open(result.value.path()).size == (850, 505)
        page.locator('[data-tab="layers"]').click()
        page.locator('#person-file').set_input_files(ROOT/'public/samples/moonwalk.jpg')
        page.wait_for_function("document.querySelector('#person-name').textContent==='moonwalk.jpg' && !document.querySelector('.desk').inert", timeout=45000)
        page.locator('#source-select').click()
        point(page, '#mask-canvas', .51, .28)
        page.wait_for_function("document.querySelector('#mask-hint').textContent.includes('outline ready')", timeout=75000)
        page.locator('#mask-apply').click()
        page.locator('#mask-dialog').wait_for(state='hidden')
        page.locator('#scene-file').set_input_files(ROOT/'public/samples/kitty-hawk.jpg')
        page.wait_for_function("document.querySelector('#scene-label').textContent==='kitty-hawk.jpg'")
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert not errors, errors
        browser.close()
        print("PASS: add, original, pose, keep/undo, target removal, independent trace/tap, blind ballot, exports, source selection and mobile layout")


if __name__ == "__main__":
    main()
