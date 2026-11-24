"""Exercise phone/scan import and the installed relative-depth model through Flask."""

import io
from pathlib import Path
import unittest

import numpy as np
from PIL import Image

from app import create_app, register_heif_opener
from server.weights import DEPTH, weight_path

ROOT = Path(__file__).resolve().parents[1]


class LivePhotographTests(unittest.TestCase):
    def setUp(self):
        self.client = create_app().test_client()

    def upload(self, image, fmt, name, path="/api/decode", **options):
        stream = io.BytesIO()
        image.save(stream, format=fmt, **options)
        stream.seek(0)
        return self.client.post(path, data={"image": (stream, name)})

    def test_portrait_orientation_and_scan_alpha(self):
        oriented = Image.new("RGB", (70, 40), "goldenrod")
        exif = oriented.getexif()
        exif[274] = 6
        response = self.upload(oriented, "JPEG", "sideways.jpg", exif=exif)
        self.assertEqual(Image.open(io.BytesIO(response.data)).size, (40, 70))
        image = Image.new("RGBA", (100, 220), (119, 90, 80, 66))
        result = self.upload(image, "TIFF", "scan.tiff")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(Image.open(io.BytesIO(result.data)).getpixel((20, 20)), (119, 90, 80, 66))

    @unittest.skipUnless(register_heif_opener, "Install pillow-heif for iPhone import")
    def test_phone_photo(self):
        result = self.upload(Image.new("RGB", (120, 80), "navy"), "HEIF", "phone.heic")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(Image.open(io.BytesIO(result.data)).size, (120, 80))

    @unittest.skipUnless(weight_path(DEPTH).is_file(), "Install the depth checkpoint to test inference")
    def test_depth_orientation_and_convention(self):
        with Image.open(ROOT / "public/samples/kitty-hawk.jpg") as scene:
            response = self.upload(scene, "PNG", "independent-upload.png", "/api/depth")
            self.assertEqual(response.status_code, 200)
            depth = np.asarray(Image.open(io.BytesIO(response.data)))
            self.assertEqual(depth.shape, (scene.height, scene.width))
        self.assertGreater(float(np.median(depth[-30:])) - float(np.median(depth[:30])), 100)


if __name__ == "__main__":
    unittest.main()
