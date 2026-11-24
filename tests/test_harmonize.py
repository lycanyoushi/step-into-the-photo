"""Check the colour table that summarises a harmonised visitor, and its endpoint."""

import base64
import io
import unittest

import numpy as np
from PIL import Image

from app import create_app
from server.depth import snap_to_edges
from server.harmonize import GRID, Harmonizer, colour_table


def lookup(table, colours):
    """Trilinear interpolation, as the browser applies the table."""
    position = np.clip(colours, 0, 1) * (GRID - 1)
    base = np.minimum(position.astype(int), GRID - 2)
    frac = position - base
    result = np.zeros_like(colours)
    for corner in range(8):
        offset = np.array([(corner >> 2) & 1, (corner >> 1) & 1, corner & 1])
        weight = np.prod(np.where(offset, frac, 1 - frac), axis=1, keepdims=True)
        index = base + offset
        result += weight * table[index[:, 0], index[:, 1], index[:, 2]]
    return result


def upload(image):
    buffer = io.BytesIO()
    Image.fromarray(image).save(buffer, format="PNG")
    buffer.seek(0)
    return buffer, "image.png"


class ColourTableTests(unittest.TestCase):
    def setUp(self):
        random = np.random.default_rng(7)
        # A visitor in a warm shirt and dark trousers, with a little skin.
        centres = np.array([[0.85, 0.55, 0.3], [0.12, 0.12, 0.16], [0.75, 0.6, 0.5]])
        self.source = np.clip(centres[random.integers(0, 3, 4000)] + random.normal(0, 0.03, (4000, 3)), 0, 1)
        self.weight = np.ones(len(self.source))

    def test_identity_is_preserved(self):
        table, affine = colour_table(self.source, self.source, self.weight)
        self.assertLess(np.abs(lookup(table, self.source) - self.source).max(), 0.02)
        self.assertLess(np.abs(affine[:3] - np.eye(3)).max(), 0.05)

    def test_reproduces_a_tone_dependent_change(self):
        # Darker and cooler overall, with shadows lifted: more than one matrix can express.
        target = np.clip(self.source * [0.7, 0.75, 0.9] + 0.08 * (1 - self.source) ** 2, 0, 1)
        table, _ = colour_table(self.source, target, self.weight)
        self.assertLess(np.abs(lookup(table, self.source) - target).mean(), 0.012)

    def test_unseen_colours_follow_the_overall_change(self):
        target = np.clip(self.source * 0.6, 0, 1)
        table, _ = colour_table(self.source, target, self.weight)
        unseen = np.array([[0.2, 0.8, 0.3], [0.5, 0.5, 0.9]])
        darker = lookup(table, unseen)
        self.assertTrue(np.all(darker.mean(axis=1) < unseen.mean(axis=1) - 0.05))
        self.assertTrue(np.all((darker >= 0) & (darker <= 1)))


class DepthEdgeTests(unittest.TestCase):
    def test_soft_depth_boundary_moves_to_the_photograph_edge(self):
        rgb = np.full((80, 120, 3), 40, np.uint8)
        rgb[:, 60:] = 210
        # The estimate spreads the boundary over eight pixels, mostly to the left.
        depth = np.clip((np.arange(120) - 52) / 8, 0, 1).astype(np.float32)[None].repeat(80, 0)
        sharp = snap_to_edges(depth, rgb)
        before = depth[40, 60] - depth[40, 59]
        after = sharp[40, 60] - sharp[40, 59]
        self.assertGreater(after, 2 * before, "The largest step should land on the photograph's edge")
        self.assertGreater(sharp[40, 60], 0.97)
        self.assertTrue(np.all((sharp >= 0) & (sharp <= 1)))


class HarmonizeEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = create_app(selection="grabcut", removal="telea").test_client()
        self.scene = np.full((90, 120, 3), (70, 90, 60), dtype=np.uint8)
        self.scene[25:80, 45:75] = [230, 150, 90]
        self.mask = np.zeros(self.scene.shape[:2], dtype=np.uint8)
        self.mask[25:80, 45:75] = 255

    def request(self, mask):
        return self.client.post("/api/harmonize", data={"image": upload(self.scene), "mask": upload(mask)})

    def test_table_or_clear_unavailability(self):
        response = self.request(self.mask)
        if not Harmonizer().available:
            self.assertEqual(response.status_code, 503)
            self.assertIn("harmonize", response.get_json()["error"])
            return
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["grid"], GRID)
        table = np.frombuffer(base64.b64decode(body["table"]), np.uint8)
        self.assertEqual(table.size, GRID**3 * 3)
        # Black stays dark and white stays light whatever the photograph.
        cube = table.reshape(GRID, GRID, GRID, 3).astype(int)
        self.assertLess(cube[0, 0, 0].mean() + 60, cube[-1, -1, -1].mean())

    def test_rejects_a_missing_visitor_and_mismatched_sizes(self):
        if Harmonizer().available:
            empty = self.request(np.zeros_like(self.mask))
            self.assertEqual(empty.status_code, 400)
        wrong = self.request(np.zeros((10, 10), np.uint8))
        self.assertEqual(wrong.status_code, 400)


if __name__ == "__main__":
    unittest.main()
