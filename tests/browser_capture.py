"""Exercise camera capture, original take replay, composite recording and freeze.

The browser receives the bundled dancer through a file-backed camera.
Pass --benchmark to also run the studio's 30-second fresh-frame measurement.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import platform

import imageio_ffmpeg
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", action="store_true")
    parser.add_argument("--scene", type=Path, help="Upload an arbitrary local photo before starting the camera")
    parser.add_argument("--occlusion", choices=("auto", "outline", "manual"),
                        help="Select live occlusion mode and wait for scene depth when needed")
    parser.add_argument("--report", type=Path, help="write the measured benchmark to this JSON file")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as temp:
        camera = Path(temp) / "dancer.y4m"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i",
                        str(ROOT / "public/demo/movement.mp4"),
                        "-pix_fmt", "yuv420p", str(camera)], check=True)
        with camera.open("rb") as stream:
            header = stream.readline().split()
        assert b"F25:1" in header and b"W640" in header and b"H480" in header
        with sync_playwright() as p:
            browser = p.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"),
                                        args=["--use-fake-device-for-media-stream",
                                              "--use-fake-ui-for-media-stream",
                                              f"--use-file-for-fake-video-capture={camera}"])
            page = browser.new_page(viewport={"width": 1250, "height": 900})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(os.getenv("STEP_STUDIO_URL", "http://127.0.0.1:5181"))
            if args.scene:
                page.locator("#scene-file").set_input_files(str(args.scene.resolve()))
                page.wait_for_function("name => document.querySelector('#scene-name').textContent === name",
                                       arg=args.scene.name)
            page.locator("#camera").click()
            page.wait_for_function("document.querySelector('#person-name').textContent==='Live webcam'", timeout=45000)
            if args.occlusion:
                page.locator("#space-mode").select_option(args.occlusion)
                if args.occlusion != "outline":
                    page.wait_for_function("""() => /Depth follows|Move the slider/.test(
                      document.querySelector('#depth-help').textContent)""", timeout=90000)
            if args.benchmark:
                mode = page.locator("#space-mode").input_value()
                shadow = page.locator("#floor-shadow").is_checked()
                page.locator('[data-tab="finish"]').click()
                page.locator('#study-tools summary').click()
                page.locator('#benchmark').click()
                page.wait_for_function("document.querySelector('#feedback').textContent.includes('displayed frames in')", timeout=45000)
                with page.expect_download() as report:
                    page.locator('#metrics').click()
                metrics = json.loads(Path(report.value.path()).read_text())["session"]
                stat = next(row for row in metrics if row["kind"] == "fresh-frame benchmark")
                assert stat["width"] == 640 and stat["height"] == 480 and stat["frames"] > 0
                times = stat["processedMediaTimes"]
                assert len(times) == len(set(times)) == stat["frames"]
                assert all(b > a for a, b in zip(times, times[1:]))
                assert stat["sourceFrameRate"] == 25 and stat["segmentation"].startswith("MediaPipe")
                assert stat["look"] == "natural" and not stat["interrupted"]
                run = {**stat, "source": "public/demo/movement.mp4", "syntheticDevice": True,
                       "captureMethod": "File-backed browser camera; native YUV4MPEG input",
                       "sourceNativeFps": 25, "sourceDurationSeconds": 10, "looped": True,
                       "browserVersion": browser.version, "platform": platform.platform(),
                       "scenePhoto": args.scene.name if args.scene else page.locator("#scene-name").text_content(),
                       "occlusion": mode, "contactShadow": shadow}
                if os.name == "nt" and args.report:
                    for key, query in [("processor", "(Get-CimInstance Win32_Processor).Name"),
                                       ("graphics", "(Get-CimInstance Win32_VideoController).Name")]:
                        run[key] = subprocess.check_output(["powershell", "-NoProfile", "-Command", query],
                                                           text=True).strip().splitlines()
                if args.report:
                    args.report.write_text(json.dumps(run, indent=2) + "\n", encoding="utf-8")
                print(f"Native 25-fps dancer, 640 x 480, {stat['segmentation']}, {stat['look']}: "
                      f"{len(times)} distinct camera timestamps / {stat['seconds']:.3f} s = {stat['fps']:.2f} fps",
                      flush=True)
            page.locator('[data-tab="pose"]').click()
            page.locator('#take').click()
            page.wait_for_timeout(1600)
            with page.expect_download() as take:
                page.locator('#take').click()
            assert Path(take.value.path()).stat().st_size > 1000
            page.wait_for_function("document.querySelector('#person-name').textContent.includes('visitor-take')", timeout=30000)
            page.locator('#record').click()
            page.wait_for_timeout(1600)
            with page.expect_download() as clip:
                page.locator('#record').click()
            assert Path(clip.value.path()).stat().st_size > 1000
            page.locator('#freeze').click()
            assert page.locator('#freeze').is_disabled()
            assert "still" in page.locator('#person-name').inner_text()
            page.locator('#sample-take').click()
            page.wait_for_function("document.querySelector('#person-name').textContent==='Studio dancer.mp4'")
            assert not errors, errors
            browser.close()
            print("PASS: camera, source take export and replay, composite clip export, freeze, sample take")


if __name__ == "__main__":
    main()
