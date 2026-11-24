"""Rebuild the public-domain scene-bank JPEGs from their credited public records.

The first-flight example is already bundled with the studio. This script verifies
that example and recreates only files inside public/scene-bank.
"""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import hashlib
from io import BytesIO
import json
from pathlib import Path
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

from PIL import Image, ImageOps


PUBLIC = Path(__file__).resolve().parents[1] / "public"


def build(entry, verify):
    destination = PUBLIC / entry["image"]
    if not verify and destination.parent.resolve() == (PUBLIC / "scene-bank").resolve():
        for attempt in range(3):
            try:
                request = Request(entry["sourceImage"], headers={"User-Agent": "StepIntoThePhoto/1.0"})
                with urlopen(request, timeout=35) as response:
                    raw = response.read()
                break
            except (URLError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
        with Image.open(BytesIO(raw)) as source:
            resized = ImageOps.exif_transpose(source).convert("RGB")
            resized.thumbnail((1100, 1100), Image.Resampling.LANCZOS)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temp = destination.with_suffix(".partial")
            try:
                resized.save(temp, format="JPEG", quality=90, optimize=True)
                temp.replace(destination)
            finally:
                temp.unlink(missing_ok=True)
    with Image.open(destination) as image:
        image.load()
        if image.format != "JPEG" or max(image.size) > 1100 or min(image.size) < 180:
            raise ValueError(f"Invalid scene JPEG: {destination} {image.size}")
        size = image.size
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    if verify and digest != entry.get("sha256"):
        raise ValueError(f"Scene does not match its frozen split: {entry['id']}")
    print(f"{entry['split']:12} {entry['id']:23} {size[0]} x {size[1]}", flush=True)
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="read and check existing JPEGs offline")
    args = parser.parse_args()
    manifest = json.loads((PUBLIC / "scenes.json").read_text(encoding="utf-8"))
    if Counter(row["split"] for row in manifest) != {"development": 8, "held-out": 12}:
        raise ValueError("Expected the frozen eight-development, twelve-held-out split.")
    if len({row["id"] for row in manifest}) != 20:
        raise ValueError("Duplicate scene IDs.")
    with ThreadPoolExecutor(max_workers=4) as pool:
        digests = list(pool.map(partial(build, verify=args.verify), manifest))
    if len(set(digests)) != 20:
        raise ValueError("Duplicate scene image content.")


if __name__ == "__main__":
    main()
