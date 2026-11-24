"""Estimate relative inverse depth once per photograph with Depth Anything V2 Small."""

import hashlib
from threading import Lock

import cv2
import numpy as np
import onnxruntime as ort

from .weights import DEPTH, weight_path


def snap_to_edges(depth, rgb):
    """Guided filter: move the soft upsampled depth boundaries onto the photograph's own edges."""
    guide = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    radius = max(3, round(max(rgb.shape[:2]) / 150))
    window = (2 * radius + 1, 2 * radius + 1)
    mean = lambda image: cv2.blur(image, window, borderType=cv2.BORDER_REFLECT)
    guide_mean, depth_mean = mean(guide), mean(depth)
    variance = mean(guide * guide) - guide_mean * guide_mean
    slope = (mean(guide * depth) - guide_mean * depth_mean) / (variance + 6e-4)
    return np.clip(mean(slope) * guide + mean(depth_mean - slope * guide_mean), 0, 1)


class SceneDepth:
    def __init__(self):
        self.session = None
        self.lock = Lock()
        self.recent = {}

    @property
    def available(self):
        return weight_path(DEPTH).is_file()

    def estimate(self, rgb):
        if not self.available:
            raise FileNotFoundError("Install the local depth model with python -m server.weights --model depth.")
        key = (hashlib.sha1(rgb).digest(), rgb.shape)
        if key in self.recent:
            return self.recent[key]
        height, width = rgb.shape[:2]
        # Preserve the field of view and cap transformer tokens on panoramas.
        scale = min(518 / min(height, width), 840 / max(height, width))
        size = tuple(max(14, 14 * round(n * scale / 14)) for n in (width, height))
        small = cv2.resize(rgb, size, interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
        small -= np.array([0.485, 0.456, 0.406], dtype=np.float32)
        small /= np.array([0.229, 0.224, 0.225], dtype=np.float32)
        tensor = np.ascontiguousarray(small.transpose(2, 0, 1)[None])
        with self.lock:
            if self.session is None:
                options = ort.SessionOptions()
                options.intra_op_num_threads = 4
                options.inter_op_num_threads = 1
                self.session = ort.InferenceSession(str(weight_path(DEPTH)), options,
                                                    providers=["CPUExecutionProvider"])
            depth = self.session.run(["predicted_depth"], {"pixel_values": tensor})[0][0]
        if not np.isfinite(depth).all():
            raise ValueError("The model could not estimate depth for this photograph.")
        far, near = np.percentile(depth, [1, 99])
        if near - far < 1e-5:
            raise ValueError("The photo has too little depth variation. Use a foreground outline instead.")
        normalized = np.clip((depth - far) / (near - far), 0, 1).astype(np.float32)
        full = cv2.resize(normalized, (width, height), interpolation=cv2.INTER_LINEAR)
        result = np.rint(snap_to_edges(full, rgb) * 255).astype(np.uint8)
        if len(self.recent) >= 6:
            self.recent.pop(next(iter(self.recent)))
        self.recent[key] = result
        return result
