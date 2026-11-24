"""Check visible-subject grounding on an uploaded photograph with no scene metadata."""

import io
from pathlib import Path
import unittest

from PIL import Image, ImageOps

from app import create_app
from server.placement_targets import PlacementTargets


class PlacementTargetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()
        source = Path(__file__).resolve().parents[1] / "public/families/park-picnic.jpg"
        with Image.open(source) as photo, io.BytesIO() as buffer:
            ImageOps.mirror(photo.convert("RGB")).save(buffer, format="JPEG", quality=94)
            cls.image = buffer.getvalue()

    def detect(self, query):
        return self.client.post("/api/placement-targets", data={
            "image": (io.BytesIO(self.image), "uploaded-photo.jpg"), "query": query,
        })

    def test_overlong_prompt(self):
        self.assertEqual(self.detect("x" * 201).status_code, 400)

    @unittest.skipUnless(PlacementTargets().available, "Install local placement weights for inference")
    def test_visible_subject_and_absent_subject(self):
        response = self.detect("the woman")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.json["method"], "Grounding DINO Tiny")
        candidates = response.json["targets"]
        self.assertTrue(candidates)
        left, top, right, bottom = candidates[0]["box"]
        # In the mirrored picnic the raised hands and torso of the central
        # adult are near 0.47 across, away from the two neighboring children.
        self.assertLess(left, 0.47)
        self.assertGreater(right, 0.47)
        self.assertLess(top, 0.33)
        self.assertGreater(bottom, 0.68)
        self.assertGreater(candidates[0]["score"], 0.5)
        for candidate in candidates:
            self.assertTrue(all(0 <= v <= 1 for v in candidate["box"]))
        self.assertEqual(self.detect("giraffe").json["targets"], [])


if __name__ == "__main__":
    unittest.main()
