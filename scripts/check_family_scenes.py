"""Verify the family scenes offline or reproduce the outlines from their recorded SAM taps."""

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


def reproduce_mask(model, photo, layers):
    merged = np.zeros(photo.shape[:2], dtype=np.uint8)
    for layer in layers:
        points = np.array([[p["x"], p["y"]] for p in layer], dtype=np.float32)
        labels = np.array([p["label"] for p in layer], dtype=np.int32)
        np.maximum(merged, model.segment(photo, points, labels), out=merged)
    return merged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reproduce", action="store_true", help="also compare fresh local SAM 2.1 inference")
    args = parser.parse_args()
    model = None
    if args.reproduce:
        sys.path.insert(0, str(ROOT))
        from server.imaging import PhotoTools

        model = PhotoTools()
        if not model.status()["sam2"]:
            raise RuntimeError("Use the SAM 2 environment to reproduce the masks.")
    manifest = json.loads((PUBLIC / "families/scenes.json").read_text(encoding="utf-8"))
    study = json.loads((PUBLIC / "scenes.json").read_text(encoding="utf-8"))
    used_ids = {entry["id"] for entry in study}
    used_photos = {entry["sha256"] for entry in study}
    for entry in manifest:
        photo_file = PUBLIC / entry["image"]
        mask_file = PUBLIC / entry["mask"]
        digest = hashlib.sha256(photo_file.read_bytes()).hexdigest()
        if digest != entry["sha256"] or digest in used_photos or entry["id"] in used_ids:
            raise ValueError(f"Changed or repeated photo: {photo_file}")
        used_photos.add(digest)
        used_ids.add(entry["id"])
        if hashlib.sha256(mask_file.read_bytes()).hexdigest() != entry["maskSHA256"]:
            raise ValueError(f"Changed foreground mask: {mask_file}")
        with Image.open(photo_file) as image, Image.open(mask_file) as matte:
            rgb = np.array(image.convert("RGB"))
            mask = np.array(matte.convert("L"))
        if mask.shape != rgb.shape[:2] or set(np.unique(mask)) != {0, 255}:
            raise ValueError(f"Invalid mask: {mask_file}")
        if model and not np.array_equal(reproduce_mask(model, rgb, entry["selectionPoints"]), mask):
            raise ValueError(f"Segmentation differs: {mask_file}")
        print(f"{entry['id']}: {rgb.shape[1]} x {rgb.shape[0]}, {np.count_nonzero(mask)} foreground pixels")


if __name__ == "__main__":
    main()
