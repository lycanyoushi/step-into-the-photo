"""Rebuild the pose-controlled reference in Field notes with a running local studio.

Source: NASA / Johnson Space Center, STS047-09-009, September 1992.
https://images.nasa.gov/details/sts047-09-009
The development photograph and its existing SAM outline are bundled with the studio.
The renderer receives only a clean plate and the altered visitor. The original is
reserved for creating the controlled donor, scoring, and the unedited reference.
Run python scripts/build_realism_reference.py --url http://127.0.0.1:5190.
"""

import argparse
import base64
from io import BytesIO
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1] / "public"
# Same crop for all views, covering the subject's head, clothing and adjoining crew.
CROP = (455, 142, 1045, 652)


def reference_outline():
    # This SAM mask omits the ear, portions of the collar and deep folds in
    # the blue uniform. Repair the visible silhouette, independent of colour
    # grading, so those regions cannot retain the original subject's RGB.
    mask = (np.array(Image.open(ROOT / "demo/jemison-mask.png").convert("L")) > 127).astype(np.uint8) * 255
    head = [(635, 268), (637, 258), (640, 250), (646, 243), (653, 237),
            (660, 233), (669, 232), (678, 232), (686, 234), (694, 238),
            (702, 245), (709, 255), (714, 265), (718, 276), (716, 280),
            (713, 281), (715, 287), (716, 292), (714, 299), (713, 306),
            (712, 308), (707, 309), (706, 320), (706, 328), (714, 327),
            (726, 333), (732, 337), (723, 351), (704, 358), (688, 365),
            (686, 380), (668, 377), (659, 373), (652, 375), (651, 368),
            (655, 363), (659, 359), (666, 355), (664, 347), (661, 338),
            (653, 332), (647, 325), (643, 318), (641, 310), (638, 301),
            (638, 288)]
    hip = [(844, 494), (862, 495), (875, 504), (887, 493), (903, 498),
           (925, 502), (938, 510), (954, 514), (959, 528), (969, 545),
           (973, 559), (963, 571), (981, 586), (1000, 599), (1006, 609),
           (1004, 620), (1019, 628), (1032, 643), (1036, 650),
           (987, 676), (931, 638), (900, 607), (861, 596), (834, 563)]
    hand = [(720, 516), (733, 520), (748, 526), (754, 531), (758, 526),
            (768, 517), (775, 513), (768, 506), (741, 506)]
    for polygon in (head, hip, hand):
        cv2.fillPoly(mask, [np.array(polygon, dtype=np.int32)], 255)
    count, parts, stats, _ = cv2.connectedComponentsWithStats((mask == 0).astype(np.uint8))
    for part in range(1, count):
        x, y, w, h, area = stats[part]
        if area <= 192 and x > 0 and y > 0 and x + w < mask.shape[1] and y + h < mask.shape[0]:
            mask[parts == part] = 255
    return mask


def make_inputs(original, mask):
    # Interpolate from outside a three-pixel guard band so the plate contains no
    # original subject RGB within the outline, even at the contour.
    enlarged = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    removed = cv2.inpaint(original, enlarged, 5, cv2.INPAINT_TELEA)
    plate = np.where(mask[..., None] > 0, removed, original)

    # An independently specified, cooler, +0.8 EV capture with mild smoothing.
    # Normalise the filter by mask coverage to avoid importing background colour.
    weight = mask.astype(np.float32) / 255
    coverage = cv2.GaussianBlur(weight, (5, 5), 0.85)
    softened = cv2.GaussianBlur(original.astype(np.float32) * weight[..., None], (5, 5), 0.85)
    srgb = np.clip(softened / np.maximum(coverage[..., None], 1e-5) / 255, 0, 1)
    light = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    gain = 2 ** 0.8 * np.array([0.78, 1.0, 1.25], dtype=np.float32)
    exposed = gain * light / (1 + (gain - 1) * light)
    rgb = np.where(exposed <= 0.0031308, 12.92 * exposed, 1.055 * exposed ** (1 / 2.4) - 0.055)
    donor = np.dstack((np.rint(255 * np.clip(rgb, 0, 1)).astype(np.uint8), mask))
    donor[mask == 0] = 0
    return plate, donor


def uri(pixels):
    stream = BytesIO()
    Image.fromarray(pixels).save(stream, format="PNG")
    return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")


def luma(pixels):
    return pixels.astype(np.float32) @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def smooth_tiles(reference, interior):
    # Score flat midtones where small fluctuations are visible. Choose tiles using
    # the held-out reference only; every output is then scored at identical pixels.
    smooth = cv2.GaussianBlur(luma(reference), (7, 7), 1.5)
    tiles = []
    for y in range(0, reference.shape[0] - 15, 16):
        for x in range(0, reference.shape[1] - 15, 16):
            tile = np.s_[y:y + 16, x:x + 16]
            if not np.all(interior[tile]):
                continue
            dark, bright = np.percentile(smooth[tile], [10, 90])
            if dark > 20 and bright < 235 and bright - dark <= 12:
                tiles.append(tile)
    return tiles


def fine_texture(image, tiles):
    # Diagonal Haar detail cancels constant colour and linear shading. Its RMS
    # captures fine local variation, including texture, scan grain and JPEG noise.
    light = luma(image)
    details = []
    for tile in tiles:
        patch = light[tile]
        details.append((patch[::2, ::2] + patch[1::2, 1::2] -
                        patch[::2, 1::2] - patch[1::2, ::2]) * 0.5)
    return np.sqrt(np.mean(np.square(details)))


RENDER = """
async ({plate, donor, bounds}) => {
  const {canvas, readImage, toBlob} = await import('/ui.js');
  const {SceneRenderer} = await import('/engine.js');
  const {peopleTone} = await import('/finish.js');
  const [base, subject] = await Promise.all([readImage(plate), readImage(donor)]);
  function surface(image) {
    const c = canvas(image.width, image.height);
    c.getContext('2d').drawImage(image,0,0);
    return c;
  }
  const scene = surface(base), cut = surface(subject), output = canvas(1,1);
  cut.foregroundBounds = bounds;
  const renderer = new SceneRenderer(output);
  renderer.setScene(scene);
  // Only other people still visible in the clean plate can supply exposure cues.
  const form = new FormData();
  form.set('image', await toBlob(scene), 'plate.png');
  form.set('query','person');
  const detected = await fetch('/api/placement-targets', {method:'POST', body:form});
  if (!detected.ok) throw Error('Enable subject detection to reproduce the scene exposure estimate.');
  const {targets} = await detected.json();
  renderer.setPeopleTone(peopleTone(scene, targets));
  const placement = {x:.5, y:.5, width:1, live:false, grounded:false};
  renderer.render(cut, {...placement,look:'untreated'});
  const raw = output.toDataURL();
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(Error('Local harmonisation did not settle.')), 60000);
    function paint() {
      renderer.render(cut, {...placement,look:'natural'});
      if (output.dataset.tone === 'measured') { clearTimeout(timer); resolve(); }
      else if (output.dataset.tone === 'estimated') {
        clearTimeout(timer); reject(Error('Enable the local PCT-Net weights before rendering.'));
      }
    }
    renderer.onUpdate = paint;
    paint();
  });
  return {
    images: [raw, output.toDataURL()],
    exposure: renderer.exposureTrim?.value ?? 0,
    grain: renderer.printTexture?.strength ?? 0,
    targetDetail: renderer.printTexture?.photo?.fine ?? null,
    donorGrainMeasured: renderer.printTexture?.sample?.valid ?? false
  };
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.getenv("STEP_STUDIO_URL", "http://127.0.0.1:5190"))
    args = parser.parse_args()
    original = np.array(Image.open(ROOT / "scene-bank/spacelab-crew.jpg").convert("RGB"))
    mask = reference_outline()
    plate, donor = make_inputs(original, mask)
    x, y, w, h = cv2.boundingRect(mask)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.getenv("BROWSER_CHANNEL", "msedge"))
        page = browser.new_page()
        page.goto(args.url.rstrip("/") + "/ui.js")
        result = page.evaluate(RENDER, {"plate": uri(plate), "donor": uri(donor),
                                        "bounds": {"x": x, "y": y, "width": w, "height": h}})
        browser.close()
    raw, blend = (np.array(Image.open(BytesIO(base64.b64decode(item.split(",")[1]))).convert("RGB"))
                  for item in result["images"])
    core = cv2.erode(mask, np.ones((7, 7), np.uint8)) > 0
    # Test dimensions, alignment and leakage before compressing the exhibit images.
    assert np.array_equal(raw[core], donor[..., :3][core])
    assert np.array_equal(raw[mask == 0], original[mask == 0])
    assert np.any(np.abs(blend.astype(int) - raw.astype(int))[core] > 1)
    l, t, r, b = CROP
    region = core[t:b, l:r]
    reference = original[t:b, l:r]
    tiles = smooth_tiles(reference, region)
    assert tiles
    print(f'Settled fit: additional exposure {result["exposure"]} stops, '
          f'grain amplitude {result["grain"]}, scene detail estimate {result["targetDetail"]}, '
          f'donor texture measured {result["donorGrainMeasured"]}.')
    for name, pixels in (("original", original), ("untreated", raw), ("blended", blend)):
        image = pixels[t:b, l:r]
        Image.fromarray(image).save(ROOT / "demo" / f"realism-{name}.jpg", quality=96, subsampling=0)
        delta = image.astype(np.float32) - reference.astype(np.float32)
        print(f"{name}: mean absolute RGB error in {region.sum()} interior subject pixels = "
              f"{np.abs(delta[region]).mean():.2f} / 255; fine luminance detail RMS "
              f"in {len(tiles)} smooth 16x16 tiles = {fine_texture(image, tiles):.2f} / 255")


if __name__ == "__main__":
    main()
