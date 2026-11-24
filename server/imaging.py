"""Prompted outlines and reconstruction of the scene behind a selected subject."""

import hashlib
import importlib.util
import math
import gc
from contextlib import contextmanager
from threading import Lock

import cv2
import numpy as np

from .weights import LAMA, SAM, weight_path


def resize_for_selection(image, points, limit):
    h, w = image.shape[:2]
    scale = min(1.0, limit / max(h, w))
    if scale == 1:
        return image, points
    small = cv2.resize(image, (max(1, round(w * scale)), max(1, round(h * scale))),
                       interpolation=cv2.INTER_AREA)
    factors = np.array([small.shape[1] / w, small.shape[0] / h], dtype=np.float32)
    return small, np.minimum(points * factors, [small.shape[1] - 1, small.shape[0] - 1])


def grabcut(image, points, labels, box=None):
    h, w = image.shape[:2]
    # Probable foreground gives GrabCut a rough person-sized patch around
    # each positive click. Only the small disks at the clicks are hard labels.
    seed = np.full((h, w), cv2.GC_PR_BGD, dtype=np.uint8)
    if box is not None:
        # Keep a narrow band of known background even for edge-touching subjects.
        left, top, right, bottom = np.rint(box).astype(int)
        seed.fill(cv2.GC_BGD)
        seed[max(1, top):min(h - 1, bottom + 1), max(1, left):min(w - 1, right + 1)] = cv2.GC_PR_FGD
    radius = max(1, round(min(w, h) * 0.014))
    for (x, y), label in zip(points, labels):
        if label and box is None:
            cv2.ellipse(seed, (round(x), round(y)), (max(2, w // 6), max(2, h // 3)),
                        0, 0, 360, cv2.GC_PR_FGD, -1)
    for (x, y), label in zip(points, labels):
        cv2.circle(seed, (round(x), round(y)), radius, cv2.GC_FGD if label else cv2.GC_BGD, -1)
    if not np.any((seed == cv2.GC_BGD) | (seed == cv2.GC_PR_BGD)):
        raise ValueError("Add a background point outside the person.")
    if not np.any((seed == cv2.GC_FGD) | (seed == cv2.GC_PR_FGD)):
        raise ValueError("Add a foreground point inside the person.")
    cv2.grabCut(image, seed, None, np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64),
                4, cv2.GC_INIT_WITH_MASK)
    return ((seed & 1) * 255).astype(np.uint8)


class PhotoTools:
    def __init__(self, selection="auto", removal="auto"):
        self.sam = (selection != "grabcut" and weight_path(SAM).is_file()
                    and importlib.util.find_spec("sam2") is not None)
        self.lama = (removal != "telea" and weight_path(LAMA).is_file()
                     and importlib.util.find_spec("onnxruntime") is not None)
        self.predictor = None
        self.image_key = None
        self.lama_model = None
        self.selection_lock = Lock()
        self.removal_lock = Lock()

    def status(self):
        return dict(segmenter="SAM 2.1 tiny" if self.sam else "GrabCut",
                    remover="LaMa" if self.lama else "Telea",
                    sam2=self.sam, lama=self.lama)

    @contextmanager
    def generation_memory(self):
        """Give the generator exclusive use of a small laptop's model memory."""
        with self.selection_lock, self.removal_lock:
            had_predictor = self.predictor is not None
            self.predictor = None
            self.image_key = None
            self.lama_model = None
            gc.collect()
            if had_predictor:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            yield

    def segment(self, rgb, points, labels, box=None):
        small, coords = resize_for_selection(rgb, points, 1400 if self.sam else 768)
        if box is not None:
            sx, sy = small.shape[1] / rgb.shape[1], small.shape[0] / rgb.shape[0]
            box = np.asarray(box, np.float32) * [sx, sy, sx, sy]
        if self.sam:
            result = self.sam_mask(small, coords, labels, box)
        else:
            result = grabcut(small, coords, labels, box)
        if result.shape != rgb.shape[:2]:
            result = cv2.resize(result, rgb.shape[1::-1], interpolation=cv2.INTER_NEAREST)
        if not np.any(result):
            raise ValueError("No foreground was selected. Add a point on the person or trace the outline.")
        return result

    def sam_mask(self, image, coords, labels, box=None):
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        digest = (image.shape, hashlib.sha256(image).digest())
        use_cuda = torch.cuda.is_available()
        with self.selection_lock, torch.inference_mode(), torch.autocast(
            device_type="cuda", dtype=torch.bfloat16,
            enabled=use_cuda and torch.cuda.is_bf16_supported()
        ):
            if self.predictor is None:
                model = build_sam2("configs/sam2.1/sam2.1_hiera_t.yaml", str(weight_path(SAM)),
                                   device="cuda" if use_cuda else "cpu", apply_postprocessing=False)
                # Hole filling needs SAM's optional CUDA extension on Windows.
                self.predictor = SAM2ImagePredictor(model, max_hole_area=0, max_sprinkle_area=0)
            if digest != self.image_key:
                self.image_key = None
                self.predictor.set_image(image)
                self.image_key = digest
            # Rank alternatives for an ambiguous single tap. SAM's refinement
            # decoder handles the combined foreground/background prompts.
            masks, scores, _ = self.predictor.predict(point_coords=coords if len(coords) else None,
                                                       point_labels=labels if len(coords) else None,
                                                       box=box, multimask_output=box is None and len(coords) == 1)
            return masks[int(np.argmax(scores))].astype(np.uint8) * 255

    def remove(self, image, mask):
        if not np.any(mask):
            raise ValueError("Select the person to replace before removing them.")
        if np.all(mask):
            raise ValueError("Leave some surrounding photo visible so the background can be filled.")
        if not self.lama:
            return cv2.inpaint(image, mask, 4, cv2.INPAINT_TELEA)
        # Fill a context window around the mask. This gives small subjects
        # a reasonable share of the model's 512-pixel input resolution.
        x, y, w, h = cv2.boundingRect(mask)
        extent = max(64, math.ceil(2 * max(w, h)))
        def window(start, length, full):
            width = min(extent, full)
            offset = min(max(0, (2 * start + length - width) // 2), full - width)
            return slice(offset, offset + width)
        rows = window(y, h, image.shape[0])
        cols = window(x, w, image.shape[1])
        crop = image[rows, cols]
        cut = mask[rows, cols]
        ch, cw = cut.shape
        scale = 512 / max(ch, cw)
        size = (max(1, round(cw * scale)), max(1, round(ch * scale)))
        rgb = cv2.resize(crop, size, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        resized_mask = cv2.resize(cut, size, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_NEAREST)
        # Repeat scene edges into the padding. Mark repeated mask pixels too.
        pad = (0, 512 - size[1], 0, 512 - size[0])
        rgb = cv2.copyMakeBorder(rgb, *pad, cv2.BORDER_REPLICATE)
        resized_mask = cv2.copyMakeBorder(resized_mask, *pad, cv2.BORDER_REPLICATE)
        inputs = {"image": rgb.transpose(2, 0, 1)[None].astype(np.float32) / 255,
                  "mask": (resized_mask[None, None] > 0).astype(np.float32)}
        with self.removal_lock:
            if self.lama_model is None:
                import onnxruntime as ort
                options = ort.SessionOptions()
                options.intra_op_num_threads = 4
                self.lama_model = ort.InferenceSession(str(weight_path(LAMA)), options,
                                                       providers=["CPUExecutionProvider"])
            pred = self.lama_model.run(None, inputs)[0][0].transpose(1, 2, 0)
        pred = np.clip(pred[:size[1], :size[0]], 0, 255).astype(np.uint8)
        fill = cv2.resize(pred, (cw, ch), interpolation=cv2.INTER_LINEAR)
        result = image.copy()
        np.copyto(result[rows, cols], fill, where=cut[:, :, None] > 0)
        return result
