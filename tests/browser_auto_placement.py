"""Exercise the live placement controls with a file-backed camera in Edge.

The default case fixes the detector, mask and depth responses so incorrect
target selection, pixel order and stale network responses are reproducible.
Pass --real to run against the local models on a newly cropped family photo.
"""

import argparse
import io
import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageOps
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
URL = os.getenv("STEP_STUDIO_URL", "http://127.0.0.1:5181").rstrip("/")
PEOPLE = [[0.62, 0.22, 0.76, 0.88], [0.81, 0.25, 0.94, 0.86]]

# Observe the production renderer after it paints each decoded camera frame.
# To check depth order, project that same frame's original alpha onto a separate
# canvas and compare the displayed pixels to the original scene under the mask.
OBSERVE_RENDER = """async () => {
  const {SceneRenderer} = await import('/engine.js');
  const render = SceneRenderer.prototype.render;
  const probe = window.placementProbe = {frames: 0};
  SceneRenderer.prototype.render = function(visitor, options) {
    const result = render.call(this, visitor, options);
    if (visitor && this.output.id === 'scene') {
      probe.frames++;
      probe.pose = [options.x, options.y, options.width];
      probe.latest = {renderer: this, visitor, options};
    }
    return result;
  };
  probe.pixels = (targetBox = null) => {
    const {renderer, visitor, options: p} = probe.latest;
    const {width: w, height: h} = renderer.output;
    function surface() {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h; return canvas.getContext('2d');
    }
    const get = ctx => ctx.getImageData(0, 0, w, h).data;
    const original = surface(), actor = surface();
    original.drawImage(renderer.scene, 0, 0, w, h);
    const actorWidth = w*p.width, actorHeight = actorWidth*visitor.height/visitor.width;
    actor.translate(w*p.x, h*p.y);
    actor.rotate((p.rotation || 0)*Math.PI/180); actor.scale(p.flip ? -1 : 1, 1);
    actor.drawImage(visitor, -actorWidth/2, -actorHeight/2, actorWidth, actorHeight);
    const live = get(renderer.ctx), scene = get(original), body = get(actor);
    const mask = renderer.foreground && get(renderer.foreground.getContext('2d'));
    let covered = 0, leaked = 0, visible = 0, insideTarget = 0, totalX = 0, count = 0;
    for (let i = 0; i < body.length; i += 4) {
      if (body[i+3] < 180) continue;
      const x = (i/4)%w, y = Math.floor((i/4)/w);
      totalX += x; count++;
      const change = Math.max(Math.abs(live[i]-scene[i]), Math.abs(live[i+1]-scene[i+1]),
                              Math.abs(live[i+2]-scene[i+2]));
      if (mask && mask[i+3] === 255) { covered++; if (change > 1) leaked++; }
      else if (change > 5) visible++;
      if (change > 5 && targetBox && x/w > targetBox[0] && x/w < targetBox[2]
          && y/h > targetBox[1] && y/h < targetBox[3]) insideTarget++;
    }
    return {covered, leaked, visible, insideTarget, bodyX: totalX/(count*w)};
  };
}"""


def png(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def bounds(box, size):
    return tuple(round(n * size[i % 2]) for i, n in enumerate(box))


def upload(page, path):
    with page.expect_file_chooser() as chooser:
        page.locator("#live-photo").click()
    chooser.value.set_files(path)
    page.wait_for_function("name => document.querySelector('#scene-label').textContent === name", arg=path.name)


def state(page, name):
    page.locator(f'#placement-status[data-state="{name}"]').wait_for()


def prompt(page, value):
    page.locator("#placement-prompt").fill(value)
    page.locator("#apply-placement").click()


def check_foreground(page):
    page.wait_for_function("""() => {
      if (!placementProbe.latest) return false;
      const {covered, visible, leaked} = placementProbe.pixels();
      return covered > 80 && visible > 180 && leaked === 0;
    }""", timeout=12000)
    return page.evaluate("placementProbe.pixels()")


def sampled_mask(page):
    # Left subject and two different heights on the right subject.
    return page.evaluate("""() => {
      const mask = placementProbe.latest.renderer.foreground;
      if (!mask) return [0,0,0];
      const ctx = mask.getContext('2d');
      return [[.69,.50], [.88,.45], [.88,.75]].map(([x,y]) =>
        ctx.getImageData(x * mask.width, y * mask.height, 1, 1).data[3]);
    }""")


def fixture_test(page, directory):
    size = (800, 500)
    scene = Image.new("RGB", size, "#ced9df")
    draw = ImageDraw.Draw(scene)
    draw.rectangle((0, 300, 800, 500), fill="#aca67d")
    for box, color in zip(PEOPLE, ["#37536b", "#7b4831"]):
        draw.rectangle(bounds(box, size), fill=color)
    scene.save(directory / "group.png")
    ImageOps.mirror(scene).save(directory / "second.png")
    masks = []
    for box in PEOPLE:
        mask = Image.new("L", size, 0)
        ImageDraw.Draw(mask).rectangle(bounds(box, size), fill=255)
        masks.append(png(mask))
    base = Image.new("L", size, 0)
    ImageDraw.Draw(base).rectangle(bounds(PEOPLE[0], size), fill=255)
    ImageDraw.Draw(base).rectangle(bounds([.81,.25,.94,.55], size), fill=255)
    seen, pending, segmented, picks = [], [], [], []

    def detect(route):
        match = re.search(rb'name="query"\r\n\r\n([^\r]*)', route.request.post_data_buffer or b"")
        query = match[1].decode().lower() if match else ""
        seen.append(query)
        if query == "statue":
            pending.append(route)
            return
        matches = PEOPLE if query in ("", "person", "people", "woman") else []
        route.fulfill(json={"method": "test fixture", "targets": [
            {"box": box, "score": .93} for box in matches
        ]})

    def segment(route):
        data = route.request.post_data_buffer or b""
        match = re.search(rb'name="box"\r\n\r\n([^\r]*)', data)
        if match:
            selected = json.loads(match[1])
            segmented.append(selected)
            index = PEOPLE.index(selected)
        else:
            point = re.search(rb'name="points"\r\n\r\n([^\r]*)', data)
            selection = json.loads(point[1])[0]
            picks.append(selection)
            index = 0 if selection["x"] < .8 * size[0] else 1
        route.fulfill(content_type="image/png", body=masks[index])

    page.route("**/api/placement-targets", detect)
    page.route("**/api/segment", segment)
    page.route("**/families/park-picnic.jpg", lambda r: r.fulfill(content_type="image/png", body=png(scene)))
    page.route("**/families/park-picnic-front.png", lambda r: r.fulfill(content_type="image/png", body=png(base)))
    depth = png(Image.new("L", (40, 25), 92))
    page.route("**/api/depth", lambda route: route.fulfill(content_type="image/png", body=depth))
    page.goto(URL + "/?live=1")
    upload(page, directory / "group.png")
    state(page, "ready")
    assert any(q in ("", "person", "people") for q in seen), "Uploaded photo skipped automatic analysis"
    page.evaluate(OBSERVE_RENDER)
    page.locator("#live-camera").click()
    page.wait_for_function("placementProbe.frames > 4 && placementProbe.pixels().visible > 300")
    auto = page.evaluate("placementProbe.pixels()")
    assert auto["bodyX"] < PEOPLE[0][0], f"Automatic placement should use the unoccupied side: {auto}"

    prompt(page, "behind the woman")
    state(page, "choosing")
    choices = page.locator("#placement-choices button")
    assert choices.count() == 2 and "woman" in seen
    choices.last.click()
    state(page, "ready")
    assert segmented == [PEOPLE[1]], f"Wrong subject sent to the segmenter: {segmented}"
    behind = check_foreground(page)
    assert behind["bodyX"] > .6, behind

    prompt(page, "behind the missing unicorn")
    state(page, "error")
    assert page.locator("#placement-status").inner_text().strip()
    assert check_foreground(page)["covered"] > 80, "Unmatched prompt discarded the prior foreground"
    page.locator("#pick-placement-target").click()
    canvas = page.locator("#scene")
    canvas.scroll_into_view_if_needed()
    size_on_screen = canvas.bounding_box()
    canvas.click(position={"x": size_on_screen["width"] * .69, "y": size_on_screen["height"] * .5})
    state(page, "ready")
    assert len(picks) == 1 and abs(picks[0]["x"] / size[0] - .69) < .016 and picks[0]["label"] == 1, picks
    assert sampled_mask(page) == [255, 0, 0], "Click fallback should keep the tapped subject in front"
    check_foreground(page)

    before = page.evaluate("placementProbe.pose")
    page.locator("#scene").focus()
    page.keyboard.press("Shift+ArrowLeft")
    state(page, "manual")
    after = page.evaluate("placementProbe.pose")
    assert after[0] < before[0] and after[1:] == before[1:], (before, after)
    count = page.evaluate("placementProbe.frames")
    page.wait_for_function("n => placementProbe.frames > n + 10", arg=count)
    assert page.evaluate("placementProbe.pose") == after, "Live motion overwrote the manual placement"

    prompt(page, "in front of the woman on the right")
    state(page, "ready")
    page.wait_for_function("box => placementProbe.pixels(box).insideTarget > 80", arg=PEOPLE[1])
    assert not page.locator("#placement-choices button").count()

    with page.expect_request(lambda r: r.url.endswith("/api/placement-targets")):
        prompt(page, "behind the statue")
    assert pending, seen
    upload(page, directory / "second.png")
    state(page, "ready")
    fresh = page.evaluate("placementProbe.pose")
    # An aborted browser request may still have run on the server. Its result
    # must never be installed over a newer photograph.
    pending[0].fulfill(json={"method": "late fixture", "targets": [
        {"box": PEOPLE[1], "score": .99}
    ]})
    count = page.evaluate("placementProbe.frames")
    page.wait_for_function("n => placementProbe.frames > n + 6", arg=count)
    assert page.evaluate("placementProbe.pose") == fresh
    assert page.locator("#placement-status").get_attribute("data-state") == "ready"
    assert page.locator("#live-status").inner_text().lower() == "camera live"

    page.locator("#live-library").click()
    page.locator("#collection").select_option("families")
    page.get_by_role("button", name="A picnic in the park").click()
    page.wait_for_function("document.querySelector('#scene-label').textContent === 'A picnic in the park'")
    state(page, "ready")
    assert sampled_mask(page) == [255, 255, 0]
    prompt(page, "in front of the woman on the right")
    state(page, "ready")
    assert sampled_mask(page) == [255, 0, 0], "An unrelated foreground subject was erased"
    page.wait_for_function("box => placementProbe.pixels(box).insideTarget > 80", arg=PEOPLE[1])
    prompt(page, "behind the woman on the right")
    state(page, "ready")
    assert sampled_mask(page) == [255, 255, 255], "Prepared and selected foregrounds must both be present"
    check_foreground(page)
    print("Fixture PASS: automatic open space, ambiguous target choice, behind and in-front pixel order, "
          "manual pick fallback, layered family foreground, manual override and stale scene response. "
          f"Occluded pixels: {behind['covered']}.")


def real_test(page, directory):
    photo = directory / "own-family-photo.png"
    with Image.open(ROOT / "public/families/family-kitchen.jpg") as image:
        scene = ImageOps.fit(ImageOps.mirror(image.convert("RGB")), (890, 610))
        scene.save(photo)
    page.goto(URL + "/?live=1")
    upload(page, photo)
    state(page, "ready")
    page.evaluate(OBSERVE_RENDER)
    prompt(page, "behind the woman")
    page.wait_for_function("""['choosing','ready','error'].includes(
        document.querySelector('#placement-status').dataset.state)""")
    if page.locator("#placement-status").get_attribute("data-state") == "choosing":
        page.locator("#placement-choices button").first.click()
    state(page, "ready")
    page.locator("#live-camera").click()
    page.wait_for_function("placementProbe.frames > 2")
    measurement = check_foreground(page)
    mask = page.evaluate("""() => {
      const mask = placementProbe.latest.renderer.foreground;
      const ctx = mask.getContext('2d');
      return [[.50,.52], [.78,.39], [.30,.64]].map(([x,y]) =>
        ctx.getImageData(x * mask.width, y * mask.height, 1, 1).data[3]);
    }""")
    assert mask[0] > 200 and max(mask[1:]) < 60, f"The mask missed the requested adult in pink: {mask}"
    print(f"Model PASS: uploaded family photo and behind-the-woman prompt. "
          f"Foreground restored {measurement['covered']} overlapping body pixels, "
          f"with {measurement['visible']} visitor pixels visible.")


def check_walk_in(page):
    """Hold a hand at the frame edge, then bring the whole person into view."""
    page.route("**/api/placement-targets", lambda route: route.fulfill(json={
        "targets": [{"box": [.55,.20,.76,.87], "score": .91}], "method": "fixture"
    }))
    page.goto(URL + "/?live=1")
    state(page, "ready")
    page.evaluate(OBSERVE_RENDER)
    page.evaluate("""async () => {
      const {PersonCutout} = await import('/media.js');
      const frame = document.createElement('canvas');
      frame.width = 640; frame.height = 480;
      const ctx = frame.getContext('2d');
      window.entryFrame = 'empty';
      PersonCutout.prototype.frame = async () => {
        ctx.clearRect(0, 0, 640, 480);
        const boxes = {hand: [0, 160, 58, 95], body: [150, 65, 200, 310], step: [235, 65, 200, 310]};
        const box = boxes[window.entryFrame];
        if (box) {
          ctx.fillStyle = '#b66b4e'; ctx.fillRect(...box);
          const [x,y,width,height] = box;
          frame.foregroundBounds = {x,y,width,height};
        } else frame.foregroundBounds = null;
        return frame;
      };
    }""")
    page.locator("#live-camera").click()
    page.wait_for_function("placementProbe.frames > 2")
    initial = page.evaluate("placementProbe.pose.slice()")
    page.evaluate("window.entryFrame = 'hand'")
    page.wait_for_function("p => placementProbe.pose.some((v,i)=>Math.abs(v-p[i])>.0001)", arg=initial)
    provisional = page.evaluate("placementProbe.pose.slice()")
    assert provisional[2] < 1.5, f"An entering hand was enlarged to person scale: {provisional}"
    page.evaluate("window.entryFrame = 'body'")
    page.wait_for_function("p => placementProbe.pose.some((v,i)=>Math.abs(v-p[i])>.0001)", arg=provisional)
    final = page.evaluate("placementProbe.pose.slice()")
    count = page.evaluate("placementProbe.frames")
    page.evaluate("window.entryFrame = 'step'")
    page.wait_for_function("n => placementProbe.frames > n + 8", arg=count)
    assert page.evaluate("placementProbe.pose") == final, "Walking triggered another automatic fit"
    page.locator("#live-camera").click()
    page.wait_for_function("document.querySelector('#live-status').textContent === 'Camera off'")
    page.evaluate("window.entryFrame = 'hand'")
    page.locator("#live-camera").click()
    page.wait_for_function("document.querySelector('#live-status').textContent === 'Camera live' && !document.querySelector('.desk').inert")
    page.locator("#scene").focus()
    page.keyboard.press("Shift+ArrowLeft")
    state(page, "manual")
    manual = page.evaluate("placementProbe.pose.slice()")
    count = page.evaluate("placementProbe.frames")
    page.evaluate("window.entryFrame = 'body'")
    page.wait_for_function("n => placementProbe.frames > n + 8", arg=count)
    assert page.evaluate("placementProbe.pose") == manual, "A manual edit during entry was overwritten"
    print("Entry PASS: empty room, edge hand, one correction for a fuller entrant, free motion and manual override.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--real", action="store_true", help="Exercise the installed models")
    args = parser.parse_args()
    with TemporaryDirectory() as temp, sync_playwright() as playwright:
        directory = Path(temp)
        camera = directory / "visitor.y4m"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i",
                        str(ROOT / "public/demo/movement.mp4"), "-pix_fmt", "yuv420p", str(camera)], check=True)
        browser = playwright.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"), args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
            f"--use-file-for-fake-video-capture={camera}",
        ])
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.set_default_timeout(120000 if args.real else 30000)
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        (real_test if args.real else fixture_test)(page, directory)
        if not args.real:
            check_walk_in(page)
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    main()
