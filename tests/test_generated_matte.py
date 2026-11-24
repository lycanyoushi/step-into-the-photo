"""Regression checks on an actual reference-conditioned diffusion result."""

import io
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

from flask import Flask
import numpy as np
from PIL import Image

from generative.api import blueprint
from generative.matte import extract_candidate


EXAMPLE = Path(__file__).resolve().parents[1] / "generative" / "example"


class CandidateMatteTests(unittest.TestCase):
    def test_candidate_boundary_follows_redrawn_glove_and_suit(self):
        guide = Image.open(EXAMPLE / "wave-guide.png")
        generated = Image.open(EXAMPLE / "wave-with-reference.png")
        joints = json.loads((EXAMPLE / "wave-joints.json").read_text())
        cutout = extract_candidate(generated, guide)
        self.assertIsNotNone(cutout)
        self.assertEqual(cutout.size, generated.size)
        alpha = np.asarray(cutout.getchannel("A"))
        old = np.asarray(guide.getchannel("A")) > 127
        self.assertEqual(alpha[0, 0], 0)
        for name in ["leftHand", "leftWrist"]:
            point = joints[name]
            self.assertEqual(alpha[round(point["y"]), round(point["x"])], 255)
        self.assertGreater(np.count_nonzero((alpha > 127) & ~old), 5000)
        self.assertGreater(np.count_nonzero((alpha < 128) & old), 1500)
        self.assertGreater(np.count_nonzero((alpha > 0) & (alpha < 255)), 100)
        np.testing.assert_array_equal(np.asarray(cutout)[:, :, :3][alpha == 255],
                                      np.asarray(generated)[alpha == 255])

    def test_endpoint_reports_embedded_matte_and_semantic_fallback(self):
        app = Flask(__name__)
        app.register_blueprint(blueprint)
        generated = EXAMPLE / "wave-with-reference.png"
        original = Image.open(EXAMPLE / "wave-guide.png")
        opaque = original.convert("RGB")

        def copy_render(args, **kwargs):
            shutil.copyfile(generated, args[args.index("--output") + 1])
            return subprocess.CompletedProcess(args, 0)

        for guide, expected in [(original, "embedded"), (opaque, "segment")]:
            with self.subTest(expected=expected):
                data = io.BytesIO()
                guide.save(data, format="PNG")
                data.seek(0)
                with patch("generative.api.ready", return_value=True), patch("generative.api.subprocess.run", copy_render):
                    response = app.test_client().post("/api/pose/generate", data={
                        "guide": (data, "guide.png"), "joints": (EXAMPLE / "wave-joints.json").read_text(),
                    })
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["X-Alpha-Mode"], expected)
                with Image.open(io.BytesIO(response.data)) as image:
                    self.assertEqual(image.mode, "RGBA" if expected == "embedded" else "RGB")


if __name__ == "__main__":
    unittest.main()
