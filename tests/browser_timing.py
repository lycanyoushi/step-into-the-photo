"""Exercise timed trials and ensure later outlines never replace the blind baselines."""

import io
import json
import os
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

from browser_engine import QuietHandler, ROOT
from browser_studio import point


def main():
    handler = partial(QuietHandler, directory=str(ROOT / "public"))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server, sync_playwright() as playwright:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        browser = playwright.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"))
        page = browser.new_page(viewport={"width": 1320, "height": 900})
        calls = []
        def segment(route):
            # Deliberately return a different outline on the second trial.
            mask = Image.new("L", (850, 505))
            area = (360, 140, 410, 410) if not calls else (0, 0, 90, 450)
            ImageDraw.Draw(mask).rectangle(area, fill=255)
            data = io.BytesIO()
            mask.save(data, format="PNG")
            calls.append(area)
            route.fulfill(body=data.getvalue(), content_type="image/png", headers={"X-Segmenter": "Fixture"})
        page.route("**/api/segment", segment)
        page.route("**/api/status", lambda r: r.fulfill(json={"segmenter": "Fixture"}))
        try:
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            page.wait_for_function("document.querySelector('#feedback').textContent.includes('Sample ready')")
            page.locator("#scene-file").set_input_files(ROOT / "public/samples/kitty-hawk.jpg")
            page.wait_for_function("document.querySelector('#scene-label').textContent==='kitty-hawk.jpg'")
            finish = page.locator('[data-tab="finish"]')
            finish.click()
            page.locator("#study-tools summary").click()
            page.locator("#trial-participant").fill("P-01")
            page.locator("#trial-scene").fill("S-01")
            def timed(method, box=0.32, repair=False):
                finish.click()
                page.locator("#trial-method").select_option(method)
                page.locator("#trial-start").click()
                assert page.locator(f'[data-tool="{method}"]').get_attribute("aria-pressed") == "true"
                assert not page.locator("#mask-apply").is_enabled()
                if method == "trace":
                    for x, y in [(box,.28),(box+.10,.28),(box+.10,.68),(box,.68)]:
                        point(page, "#mask-canvas", x, y)
                    page.locator("#close-trace").click()
                else:
                    point(page, "#mask-canvas", .46, .45)
                page.locator("#mask-apply").wait_for()
                if repair:
                    page.locator('[data-tool="erase"]').click()
                    point(page, "#mask-canvas", box+.05, .45)
                page.locator("#mask-apply").click()
                page.locator("#mask-dialog").wait_for(state="hidden")
                with page.expect_download():
                    page.locator("#save").click()
            def comparison():
                finish.click()
                page.locator("#compare").click()
                page.wait_for_function("document.querySelectorAll('.comparison-grid canvas').length===2")
                page.locator("[data-choice]").select_option("tie")
                page.locator("[data-vote]").click()
                images = page.evaluate("""async () => {
                  const {getVotes}=await import('/study.js'), order=getVotes().at(-1).order;
                  return Object.fromEntries([...document.querySelectorAll('.comparison-grid canvas')]
                    .map((c,i)=>[order[i],c.toDataURL()]));
                }""")
                page.locator("#comparison-dialog form button").click()
                return images
            timed("trace", repair=True)
            finish.click()
            page.locator("#trial-note").fill("Asked how to close the trace.")
            timed("tap")
            before = comparison()
            timed("tap")
            timed("trace", box=.52)
            after = comparison()
            assert len(calls) == 2 and before == after
            assert before["B"] != before["C"]
            with page.expect_download() as saved:
                page.locator("#metrics").click()
            measurements = json.loads(Path(saved.value.path()).read_text())["session"]
            trials = [q for q in measurements if q["kind"] == "timed setup"]
            assert len(trials) == 4
            for q in trials:
                assert q["participantId"] == "P-01" and q["sceneId"] == "S-01" and q["outcome"] == "saved"
                assert 0 < q["firstOutlineMs"] <= q["firstAppliedMs"] <= q["timeToSavedPoseMs"]
                assert q["placementMs"] == q["timeToSavedPoseMs"] - q["firstAppliedMs"]
            assert trials[0]["helpNote"] and trials[0]["corrections"] == 1
            assert trials[1]["outlineMethod"] == "Fixture"
            print("PASS: four clean timed trials, true milestones, repairs/help recorded, frozen B/C panels.")
        finally:
            browser.close()
            server.shutdown()


if __name__ == "__main__":
    main()
