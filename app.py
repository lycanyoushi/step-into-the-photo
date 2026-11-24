"""Local photo studio. Run python app.py and visit http://127.0.0.1:5181."""

import argparse
import base64
import io
import json
import math
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_file
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.exceptions import RequestEntityTooLarge

from server.imaging import PhotoTools
from server.depth import SceneDepth
from server.harmonize import Harmonizer
from server.placement_targets import PlacementTargets
from generative.api import blueprint as pose_generation


ROOT = Path(__file__).resolve().parent

try:
    from pillow_heif import register_heif_opener
except ImportError:
    register_heif_opener = None
else:
    register_heif_opener()


def read_image(field, is_mask=False):
    file = request.files.get(field)
    if file is None:
        raise ValueError(f"Upload the {field} file.")
    try:
        with Image.open(file.stream) as source:
            w, h = source.size
            if min(w, h) < 8 or w * h > 16_000_000:
                raise ValueError("Use an image at least 8 pixels on each side and at most 16 megapixels.")
            oriented = ImageOps.exif_transpose(source)
            if is_mask and "A" in oriented.getbands():
                alpha = oriented.getchannel("A")
                if alpha.getextrema()[0] < 255:
                    return np.array(alpha)
            return np.array(oriented.convert("L" if is_mask else "RGB"))
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError(f"The {field} file could not be decoded.") from exc


def read_points(width, height):
    try:
        points = json.loads(request.form.get("points", "[]"))
    except json.JSONDecodeError as exc:
        raise ValueError("Points must be a JSON list of x, y, and label values.") from exc
    if not isinstance(points, list) or not 1 <= len(points) <= 128:
        raise ValueError("Supply between 1 and 128 selection points.")
    coords = []
    labels = []
    for point in points:
        if not isinstance(point, dict):
            raise ValueError("Each point needs x, y, and label.")
        x, y, label = point.get("x"), point.get("y"), point.get("label")
        if (type(x) not in (int, float) or type(y) not in (int, float)
                or not 0 <= x < width or not 0 <= y < height
                or not math.isfinite(x) or not math.isfinite(y)):
            raise ValueError("Each point must fall inside the photo.")
        if type(label) is not int or label not in (0, 1):
            raise ValueError("Use label 1 for foreground or 0 for background.")
        coords.append((x, y))
        labels.append(label)
    if 1 not in labels:
        raise ValueError("Add a foreground point inside the person.")
    return np.array(coords, dtype=np.float32), np.array(labels, dtype=np.int32)


def png_response(pixels, header, method):
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    buffer.seek(0)
    response = send_file(buffer, mimetype="image/png", max_age=0)
    response.headers["Cache-Control"] = "no-store"
    response.headers[header] = method
    return response


def create_app(selection="auto", removal="auto"):
    app = Flask(__name__, static_folder=str(ROOT / "public"), static_url_path="")
    app.config["MAX_CONTENT_LENGTH"] = 48 * 1024 * 1024
    app.register_blueprint(pose_generation)
    photo = PhotoTools(selection, removal)
    depth = SceneDepth()
    placement = PlacementTargets()
    harmonizer = Harmonizer()
    app.extensions["pose_generation_memory"] = photo.generation_memory

    @app.get("/")
    def studio():
        return app.send_static_file("index.html")

    @app.get("/api/status")
    def status():
        return jsonify(**photo.status(), depth=depth.available, placement=placement.available,
                       harmonize=harmonizer.available,
                       heif=register_heif_opener is not None)

    @app.post("/api/placement-targets")
    def placement_targets():
        try:
            targets = placement.detect(read_image("image"), request.form.get("query", ""))
        except FileNotFoundError as exc:
            return jsonify(error=str(exc)), 503
        return jsonify(targets=targets, method=placement.method)

    @app.post("/api/harmonize")
    def harmonize():
        image = read_image("image")
        mask = read_image("mask", is_mask=True)
        if mask.shape != image.shape[:2]:
            raise ValueError("The mask and composite must have identical dimensions.")
        try:
            table, affine = harmonizer.table(image, mask)
        except FileNotFoundError as exc:
            return jsonify(error=str(exc)), 503
        return jsonify(grid=int(table.shape[0]), table=base64.b64encode(table.tobytes()).decode("ascii"),
                       affine=affine.tolist(), method=harmonizer.method)

    @app.post("/api/depth")
    def scene_depth():
        try:
            pixels = depth.estimate(read_image("image"))
        except FileNotFoundError as exc:
            return jsonify(error=str(exc)), 503
        return png_response(pixels, "X-Depth-Model", "Depth Anything V2 Small")

    @app.post("/api/decode")
    def decode_photo():
        upload = request.files.get("image")
        if upload is None:
            raise ValueError("Choose a photograph first.")
        try:
            with Image.open(upload.stream) as source:
                if source.width * source.height > 64_000_000:
                    raise ValueError("Choose a photograph of up to 64 megapixels.")
                source.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                oriented = ImageOps.exif_transpose(source)
                if oriented.mode.startswith("I;16"):
                    oriented = Image.fromarray((np.asarray(oriented) / 257).astype(np.uint8))
                has_alpha = "A" in oriented.getbands() or "transparency" in oriented.info
                pixels = np.asarray(oriented.convert("RGBA" if has_alpha else "RGB"))
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ValueError("This file could not be decoded. Try a JPEG, PNG, WebP, HEIC or TIFF photograph.") from exc
        return png_response(pixels, "X-Decoder", "Pillow")

    @app.post("/api/segment")
    def select_person():
        image = read_image("image")
        h, w = image.shape[:2]
        box = None
        if "box" in request.form:
            raw = json.loads(request.form["box"])
            if (not isinstance(raw, list) or len(raw) != 4
                    or any(type(n) not in (int, float) or not 0 <= n <= 1 for n in raw)
                    or (raw[2] - raw[0]) * w < 2 or (raw[3] - raw[1]) * h < 2):
                raise ValueError("Use a normalized subject box with a positive width and height.")
            box = np.array(raw, dtype=np.float32) * [w - 1, h - 1, w - 1, h - 1]
        points, labels = (read_points(w, h) if box is None or "points" in request.form
                          else (np.empty((0, 2), np.float32), np.empty(0, np.int32)))
        return png_response(photo.segment(image, points, labels, box), "X-Segmenter", photo.status()["segmenter"])

    @app.post("/api/person")
    def find_person():
        """Outline the main person in a photograph of someone, with a soft edge."""
        image = read_image("image")
        try:
            found = placement.detect(image, "person")
        except FileNotFoundError as exc:
            return jsonify(error=str(exc)), 503
        if not found:
            raise ValueError("No person was found in this photograph.")
        # The subject of a portrait is large and confidently a person; passers-by are small.
        area = lambda hit: (hit["box"][2] - hit["box"][0]) * (hit["box"][3] - hit["box"][1])
        subject = max(found, key=lambda hit: area(hit) * hit["score"])
        h, w = image.shape[:2]
        box = np.array(subject["box"], dtype=np.float32) * [w - 1, h - 1, w - 1, h - 1]
        mask = photo.segment(image, np.empty((0, 2), np.float32), np.empty(0, np.int32), box)
        # Draw the outline in by about half a pixel and soften it, so no rim of
        # the old background travels with the person.
        sigma = max(0.8, max(h, w) / 1100)
        soft = cv2.GaussianBlur(mask.astype(np.float32) / 255, (0, 0), sigma)
        alpha = np.clip((soft - 0.42) / 0.42, 0, 1)
        return png_response(np.rint(alpha * 255).astype(np.uint8), "X-Segmenter", photo.status()["segmenter"])

    @app.post("/api/remove")
    def remove_person():
        image = read_image("image")
        mask = read_image("mask", is_mask=True)
        if mask.shape != image.shape[:2]:
            raise ValueError("The mask and photo must have identical dimensions.")
        selection = (mask >= 128).astype(np.uint8) * 255
        return png_response(photo.remove(image, selection), "X-Inpainter", photo.status()["remover"])

    @app.errorhandler(ValueError)
    def invalid(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(RequestEntityTooLarge)
    def too_large(_error):
        return jsonify(error="The combined upload must fit in 48 MB."), 413

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5181)
    parser.add_argument("--selection", choices=["auto", "grabcut"], default="auto")
    parser.add_argument("--removal", choices=["auto", "telea"], default="auto")
    args = parser.parse_args()
    cv2.setNumThreads(4)
    create_app(args.selection, args.removal).run(host=args.host, port=args.port, threaded=True)
