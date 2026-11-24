"""Exercise camera failure and recovery with Chromium's synthetic camera."""

import os

from playwright.sync_api import sync_playwright


def main():
    origin = os.getenv("STEP_STUDIO_URL", "http://127.0.0.1:5181").rstrip("/")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"), args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"
        ])
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.add_init_script("""
            const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async options => {
              if (window.cameraProblem) throw new DOMException('Test camera failure', window.cameraProblem);
              window.testStream = await nativeCapture(options);
              return window.testStream;
            };
            const play = HTMLVideoElement.prototype.play;
            HTMLVideoElement.prototype.play = function() {
              if (this.srcObject && window.holdCamera) {
                window.openedUncommitted = true;
                return new Promise(() => {});
              }
              return play.call(this);
            };
        """)
        page.goto(origin + "/")
        page.wait_for_function("document.querySelector('#feedback').textContent.includes('Sample ready')")
        name = page.locator("#person-name")
        camera = page.locator("#camera")
        original = name.inner_text()
        for problem, advice in [("NotAllowedError", "Allow camera access"),
                                ("NotFoundError", "Connect a webcam"),
                                ("NotReadableError", "Close other apps")]:
            page.evaluate("name => window.cameraProblem = name", problem)
            camera.click()
            page.wait_for_function(
                "text => document.querySelector('#feedback').textContent.includes(text)", arg=advice)
            assert name.inner_text() == original
            assert camera.is_enabled()

        # Lose the camera before playback is ready. The operator can keep editing.
        page.evaluate("() => {window.cameraProblem=''; window.holdCamera=true}")
        camera.click()
        page.wait_for_function("window.openedUncommitted")
        page.evaluate("() => window.testStream.getVideoTracks()[0].dispatchEvent(new Event('ended'))")
        page.wait_for_function("!document.querySelector('.desk').inert")
        assert "Reconnect" in page.locator("#feedback").inner_text()
        assert name.inner_text() == original
        assert page.evaluate("window.testStream.getVideoTracks()[0].readyState") == "ended"

        page.evaluate("window.holdCamera = false")
        camera.click()
        page.wait_for_function("document.querySelector('#person-name').textContent==='Live webcam'", timeout=45000)
        page.evaluate("""() => {
            window.oldTrack = window.testStream.getVideoTracks()[0];
            oldTrack.dispatchEvent(new Event('ended'));
        }""")
        assert name.inner_text() == "Choose a person"
        assert "Reconnect" in page.locator("#feedback").inner_text()
        assert page.evaluate("oldTrack.readyState") == "ended"
        camera.click()
        page.wait_for_function("document.querySelector('#person-name').textContent==='Live webcam'")
        page.evaluate("() => oldTrack.dispatchEvent(new Event('ended'))")
        assert name.inner_text() == "Live webcam"
        camera.click()
        page.wait_for_function("document.querySelector('#person-name').textContent.includes('still')")
        assert page.evaluate("window.testStream.getVideoTracks()[0].readyState") == "ended"
        assert not errors, errors
        browser.close()
    print("PASS: denied, missing and busy camera; disconnect during startup and active preview; retry and freeze cleanup")


if __name__ == "__main__":
    main()
