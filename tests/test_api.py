"""Exercise the same multipart interface as the browser, including exact background preservation."""

import io
import json
import unittest

import numpy as np
from PIL import Image

from app import create_app


def upload(image):
    buffer = io.BytesIO()
    Image.fromarray(image).save(buffer, format="PNG")
    buffer.seek(0)
    return buffer, "image.png"


def pixels(response):
    return np.array(Image.open(io.BytesIO(response.data)))


class PhotoApiTests(unittest.TestCase):
    def setUp(self):
        self.client = create_app(selection="grabcut", removal="telea").test_client()
        self.scene = np.full((80, 100, 3), (43, 78, 111), dtype=np.uint8)
        self.scene[20:65, 35:65] = [211, 71, 53]
        self.mask = np.zeros(self.scene.shape[:2], dtype=np.uint8)
        self.mask[20:65, 35:65] = 255

    def select(self, points):
        return self.client.post("/api/segment", data={"image": upload(self.scene), "points": json.dumps(points)})

    def remove(self, mask):
        return self.client.post("/api/remove", data={"image": upload(self.scene), "mask": upload(mask)})

    def test_foreground_and_background_taps(self):
        r = self.select([dict(x=50, y=42, label=1), dict(x=20, y=35, label=0)])
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["X-Segmenter"], "GrabCut")
        self.assertEqual(self.client.get("/api/status").json["segmenter"], "GrabCut")
        mask = pixels(r)
        self.assertEqual(mask.shape, self.mask.shape)
        self.assertEqual(mask[42, 50], 255)
        self.assertEqual(mask[35, 20], 0)

    def test_removal_preserves_pixels_outside_mask(self):
        for mask in [self.mask, np.dstack((np.zeros_like(self.scene), self.mask))]:
            with self.subTest(channels=mask.ndim):
                r = self.remove(mask)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.headers["X-Inpainter"], "Telea")
                output = pixels(r)
                np.testing.assert_array_equal(output[self.mask == 0], self.scene[self.mask == 0])
                self.assertGreater(np.abs(output.astype(int) - self.scene)[self.mask > 0].mean(), 50)

    def test_box_prompt_and_validation(self):
        def segment(box):
            return self.client.post("/api/segment", data={"image": upload(self.scene), "box": json.dumps(box)})
        response = segment([0.3, 0.2, 0.7, 0.9])
        self.assertEqual(response.status_code, 200)
        np.testing.assert_array_equal(pixels(response), self.mask)
        for box in [None, [], [0.1, .2, .1, .9], [-1, 0, 1, 1], [0, 0, True, 1]]:
            with self.subTest(box=box):
                self.assertEqual(segment(box).status_code, 400)

    def test_invalid_uploads_are_rejected(self):
        for mask in [self.mask[:10], self.mask * 0, np.full_like(self.mask, 255)]:
            self.assertEqual(self.remove(mask).status_code, 400)
        for points in [[], [dict(x=-1, y=0, label=1)], [dict(x=10, y=10, label=0)]]:
            self.assertEqual(self.select(points).status_code, 400)
        self.assertEqual(self.client.post("/api/segment", data={}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
