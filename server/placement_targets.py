"""Find the visible subjects named in a placement request with local Grounding DINO."""

import hashlib
import importlib.util
from collections import OrderedDict
from threading import Lock

import numpy as np
import onnxruntime as ort
from PIL import Image

from .weights import GROUNDING, GROUNDING_TOKENIZER, weight_path


def select_boxes(logits, boxes, word_positions):
    """Rank the named subjects and suppress repeat detections of the same outline."""
    scores = 1.0 / (1.0 + np.exp(-np.clip(logits[:, word_positions].max(axis=1), -50, 50)))
    corners = np.clip(np.concatenate((boxes[:, :2] - boxes[:, 2:] / 2,
                                     boxes[:, :2] + boxes[:, 2:] / 2), axis=1), 0, 1)
    accepted = []
    for idx in np.argsort(-scores):
        if scores[idx] < 0.32:
            break
        box = corners[idx]
        if not np.isfinite(box).all() or not np.isfinite(scores[idx]):
            continue
        dims = box[2:] - box[:2]
        if min(dims) <= 0:
            continue
        if accepted:
            earlier = corners[accepted]
            intersection = np.maximum(0, np.minimum(box[2:], earlier[:, 2:]) -
                                      np.maximum(box[:2], earlier[:, :2])).prod(axis=1)
            union = dims.prod() + (earlier[:, 2:] - earlier[:, :2]).prod(axis=1) - intersection
            if np.any(intersection > 0.5 * union):
                continue
        accepted.append(idx)
    return [{"box": corners[i].tolist(), "score": float(scores[i])} for i in accepted]


class PlacementTargets:
    method = "Grounding DINO Tiny"

    def __init__(self):
        self.session = None
        self.tokenizer = None
        self.lock = Lock()
        # One prompt after another reuses the same photograph and often the
        # same subject. Detection takes seconds on a laptop processor.
        self.recent = OrderedDict()

    @property
    def available(self):
        return (weight_path(GROUNDING).is_file() and weight_path(GROUNDING_TOKENIZER).is_file()
                and importlib.util.find_spec("tokenizers") is not None)

    def detect(self, rgb, query):
        if len(query) > 200:
            raise ValueError("Describe the subject in 200 characters or fewer.")
        phrase = " ".join(query.lower().split()).rstrip(".!?").strip() or "person"
        if not any(character.isalnum() for character in phrase):
            raise ValueError("Enter the name or a short description of a visible subject.")
        if not self.available:
            raise FileNotFoundError("Install the studio requirements and run python -m server.weights --model placement.")

        key = (hashlib.sha1(rgb).digest(), rgb.shape, phrase)
        with self.lock:
            if key in self.recent:
                self.recent.move_to_end(key)
                return [dict(hit) for hit in self.recent[key]]
            if self.tokenizer is None:
                from tokenizers import Tokenizer
                self.tokenizer = Tokenizer.from_file(str(weight_path(GROUNDING_TOKENIZER)))
            caption = self.tokenizer.encode(phrase + ".")
            # The final period and BERT boundary markers have no visible meaning.
            # For an expression like "person wearing glasses", score the subject.
            # The remaining caption is still part of the model's visual attention.
            positions = []
            for index, token in enumerate(caption.tokens[1:-2], start=1):
                if positions and token in {"in", "with", "wearing", "holding", "carrying", "beside", "near"}:
                    break
                if token not in {"a", "an", "the"}:
                    positions.append(index)
            if not positions:
                raise ValueError("Enter the name or a short description of a visible subject.")

            if self.session is None:
                options = ort.SessionOptions()
                options.intra_op_num_threads = 4
                options.inter_op_num_threads = 1
                self.session = ort.InferenceSession(str(weight_path(GROUNDING)), options,
                                                    providers=["CPUExecutionProvider"])
            # This ONNX export uses a fixed 800-square stretch. Box coordinates
            # are normalized separately on each axis, also for portrait photos.
            resized = Image.fromarray(rgb).resize((800, 800), Image.Resampling.BILINEAR)
            pixels = np.asarray(resized, dtype=np.float32) / 255
            pixels -= np.array([0.485, 0.456, 0.406], dtype=np.float32)
            pixels /= np.array([0.229, 0.224, 0.225], dtype=np.float32)
            ids = np.array([caption.ids], dtype=np.int64)
            inputs = {"input_ids": ids, "token_type_ids": np.zeros_like(ids),
                      "attention_mask": np.ones_like(ids), "pixel_mask": np.ones((1, 800, 800), dtype=np.int64),
                      "pixel_values": np.ascontiguousarray(pixels.transpose(2, 0, 1)[None])}
            logits, boxes = self.session.run(["logits", "pred_boxes"], inputs)
            found = select_boxes(logits[0], boxes[0], positions)
            self.recent[key] = found
            while len(self.recent) > 48:
                self.recent.popitem(last=False)
        return [dict(hit) for hit in found]
