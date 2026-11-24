"""Measure rendered grain and coverage in a headless browser, using known image pairs."""

from functools import partial
from http.server import ThreadingHTTPServer
import os
import threading

from playwright.sync_api import sync_playwright

from browser_engine import QuietHandler, ROOT


CHECK = r"""
async () => {
  const { PrintTexture } = await import('/print-texture.js');
  const { SceneRenderer } = await import('/engine.js');
  const { makeCanvas } = await import('/canvas.js');
  const W = 280, H = 200, bounds = [36, 30, 208, 140];
  function field(width, height, noise) {
    const canvas = makeCanvas(width, height), ctx = canvas.getContext('2d');
    const data = ctx.createImageData(width, height);
    let seed = 581;
    const random = () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) + 0.5) / 2**32;
    for (let i = 0; i < data.data.length; i += 4) {
      const value = 128 + noise * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
      data.data.set([value, value, value, 255], i);
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  }
  function stats(canvas, x, y, w, h) {
    const { data } = canvas.getContext('2d').getImageData(x, y, w, h);
    let sum = 0, squared = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i]; squared += data[i] ** 2;
    }
    const mean = sum / (w * h);
    return { mean, sigma: Math.sqrt(squared / (w * h) - mean ** 2) };
  }
  const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const same = (a, b) => a.every((v, i) => v === b[i]);
  function run(scene, donorNoise, stripedShirt = false) {
    const layer = makeCanvas(W, H), ctx = layer.getContext('2d');
    const [x, y, w, h] = bounds;
    ctx.drawImage(field(w, h, donorNoise), x, y);
    if (stripedShirt) {
      ctx.fillStyle = '#565656';
      for (let i = x; i < x + w; i += 8) ctx.fillRect(i, y, 3, h);
    }
    // A high-contrast seam and an aperture within the bounding box.
    ctx.fillStyle = '#262626'; ctx.fillRect(145, 31, 4, 120);
    ctx.clearRect(187, 63, 21, 41);
    const texture = new PrintTexture(scene);
    const out = makeCanvas(W, H), target = out.getContext('2d');
    const draw = () => { target.drawImage(scene, 0, 0); target.drawImage(layer, 0, 0); };
    draw(); const before = pixels(out);
    texture.apply(target, layer, bounds, 1, true); const after = pixels(out);
    const sigma = stats(out, 50, 43, 80, 91).sigma;
    const seam = stats(out, 145, 43, 4, 91).mean;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
      const i = 4 * (yy * W + xx);
      const empty = xx < x || yy < y || xx >= x + w || yy >= y + h ||
                    (xx >= 187 && xx < 208 && yy >= 63 && yy < 104);
      if (empty && !same(before.subarray(i, i + 4), after.subarray(i, i + 4))) {
        throw Error('Changed uncovered pixel ' + xx + ',' + yy);
      }
    }
    draw(); texture.apply(target, layer, bounds, 1, true);
    if (!same(after, pixels(out))) throw Error('Static visitor flickers on the live path');
    if (Math.abs(seam - 38) > 2) throw Error('Clothing seam lost contrast: ' + seam);
    return { sigma, changed: !same(after, before) };
  }
  const scene = field(W, H, 8);
  const clean = run(scene, 0), partial = run(scene, 4), noisy = run(scene, 12);
  const matched = run(scene, 8), fabric = run(scene, 0, true);
  const smooth = run(field(W, H, 0), 0);
  const stripes = field(W, H, 0), st = stripes.getContext('2d');
  st.fillStyle = '#d3d3d3';
  for (let x = 0; x < W; x += 6) st.fillRect(x, 0, 2, H);
  const patterned = run(stripes, 0);
  if (smooth.changed || noisy.changed || matched.changed || patterned.changed) throw Error('Added spurious noise');
  if (!fabric.changed) throw Error('Skipped the entire visitor because of a fabric pattern');
  if ([clean, partial].some(v => !v.changed || Math.abs(v.sigma - 8) > 1.1))
    throw Error('Target noise mismatch ' + JSON.stringify({clean, partial}));

  // Exercise the actual draw order, including restored foreground and look selection.
  const out = makeCanvas(), visitor = field(140, 120, 0), mask = makeCanvas(W, H);
  const renderer = new SceneRenderer(out);
  const maskCtx = mask.getContext('2d');
  maskCtx.fillStyle = '#000'; maskCtx.fillRect(0, 0, W, H);
  maskCtx.fillStyle = '#fff'; maskCtx.fillRect(0, 0, W / 2, H);
  renderer.measureHarmony = () => {};
  renderer.setScene(scene); renderer.setForeground(mask);
  renderer.render(visitor, { look: 'raw', width: .5 });
  if (renderer.printTexture) throw Error('Measured grain in raw mode');
  renderer.render(visitor, { look: 'natural', width: .5 });
  if (!renderer.printTexture?.strength) throw Error('Natural renderer did not apply grain');
  const original = scene.getContext('2d').getImageData(85, 85, 36, 36).data;
  const occluded = out.getContext('2d').getImageData(85, 85, 36, 36).data;
  if (!same(original, occluded)) throw Error('Front subject changed');
  return { photoSigma: stats(scene, 50, 43, 80, 91).sigma, clean, partial, noisy };
}
"""


def main():
    handler = partial(QuietHandler, directory=str(ROOT / "public"))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL"))
                page = browser.new_page()
                page.goto(f"http://127.0.0.1:{server.server_port}/vendor/")
                print("Photographic grain checks passed.", page.evaluate(CHECK))
                browser.close()
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
