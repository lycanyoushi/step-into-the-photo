"""Verify replacement mask geometry and editing state on the bundled Wilbur photo."""

from email import policy
from email.parser import BytesParser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import os
from pathlib import Path
import threading

import numpy as np
from PIL import Image, ImageFilter
from playwright.sync_api import sync_playwright


PUBLIC = Path(__file__).resolve().parents[1] / "public"
SAMPLES = PUBLIC / "samples"


class QuietFiles(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def run(browser, origin):
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    prior = Image.open(SAMPLES / "wilbur-mask.png").convert("L")
    expanded = prior.filter(ImageFilter.MaxFilter(7))
    requests = []

    # Replay a real saved SAM mask and supply a still in place of running LaMa.
    # The test observes the exact bytes the browser sends to the inpainting API.
    def remove(route):
        content_type = route.request.headers["content-type"]
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\n\r\n".encode() + route.request.post_data_buffer
        )
        part = next(p for p in message.iter_parts() if p.get_param("name", header="content-disposition") == "mask")
        with Image.open(io.BytesIO(part.get_payload(decode=True))) as mask:
            requests.append(np.array(mask.convert("L")))
        route.fulfill(path=SAMPLES / "kitty-hawk.jpg", content_type="image/jpeg")

    page.route("**/api/status", lambda r: r.fulfill(json={"segmenter": "Fixture", "remover": "Fixture"}))
    page.route("**/api/segment", lambda r: r.fulfill(path=SAMPLES / "wilbur-mask.png", content_type="image/png"))
    page.route("**/api/remove", remove)
    page.goto(origin)
    page.wait_for_function("document.querySelector('#feedback').textContent.includes('Sample ready')")
    page.locator("#replace").click()
    margin = page.locator("#removal-margin")
    assert margin.is_visible() and margin.input_value() == "3"
    view = page.locator("#mask-canvas")
    size = view.bounding_box()
    view.click(position={"x": size["width"] * 757 / 850, "y": size["height"] * 211 / 505})
    page.wait_for_function("document.querySelector('#mask-hint').textContent.includes('outline ready')")
    # Check a real halo pixel on the photo. Changing the margin updates its tint.
    yy, xx = np.argwhere((np.asarray(expanded) > 127) & (np.asarray(prior) < 128))[0]
    probe = [int(xx), int(yy)]
    sample = "(c,[x,y])=>[...c.getContext('2d').getImageData(x,y,1,1).data]"
    set_margin = "(s,n)=>{s.value=n; s.dispatchEvent(new Event('input',{bubbles:true}));}"
    halo_color = view.evaluate(sample, probe)
    margin.evaluate(set_margin, "0")
    raw_color = view.evaluate(sample, probe)
    assert halo_color[0] - halo_color[2] > 90 and abs(raw_color[0] - raw_color[2]) < 20
    margin.evaluate(set_margin, "3")

    def apply():
        page.locator("#mask-apply").click()
        page.locator("#mask-dialog").wait_for(state="hidden")
        return page.locator("#scale").input_value()

    original_scale = apply()
    np.testing.assert_array_equal(requests[-1], np.asarray(expanded))
    page.locator("#outline").click()
    margin.evaluate(set_margin, "8")
    assert apply() == original_scale
    np.testing.assert_array_equal(requests[-1], np.asarray(prior.filter(ImageFilter.MaxFilter(17))))
    page.locator("#outline").click()
    assert margin.input_value() == "8"
    margin.evaluate(set_margin, "0")
    assert apply() == original_scale
    np.testing.assert_array_equal(requests[-1], np.asarray(prior))

    page.locator("#front-extra").click()
    assert not margin.is_visible()
    page.locator("#mask-dialog form button").click()
    page.locator("#add").click()
    page.locator("#outline").click()
    assert not margin.is_visible()
    page.locator("#mask-dialog form button").click()
    page.locator("#scene-file").set_input_files(SAMPLES / "kitty-hawk.jpg")
    page.wait_for_function("document.querySelector('#scene-label').textContent==='kitty-hawk.jpg'")
    page.locator("#replace").click()
    assert margin.input_value() == "3"
    page.close()
    print(f"Wilbur mask {np.count_nonzero(np.asarray(prior) >= 128)} pixels, "
          f"3 px margin {np.count_nonzero(np.asarray(expanded) >= 128)} pixels. Browser checks passed.")


def main():
    with ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietFiles, directory=str(PUBLIC))) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"), args=["--disable-gpu"])
                run(browser, f"http://127.0.0.1:{server.server_port}/")
                browser.close()
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
