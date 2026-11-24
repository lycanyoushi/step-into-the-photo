"""Optional local Flask endpoint. Heavy model imports run in an isolated process."""

import io
import json
import os
from contextlib import nullcontext
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from threading import Lock

from flask import Blueprint, current_app, jsonify, request, send_file
from PIL import Image, UnidentifiedImageError

from .fetch_models import APPEARANCE, REPOS, WEIGHTS
from .generate import validate_joints
from .matte import extract_candidate


blueprint = Blueprint("pose_generation", __name__)
HERE = Path(__file__).resolve().parent
BUSY = Lock()


def runtime():
    override = os.environ.get("STEP_PHOTO_GENERATOR_PYTHON")
    if override:
        return Path(override)
    return HERE / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ready(repos=REPOS):
    return runtime().is_file() and all(
        (WEIGHTS / kind / name).is_file() for kind, (_, _, names) in repos.items() for name in names
    )


@blueprint.get("/api/pose/status")
def status():
    available = ready()
    return jsonify(available=available, appearance=ready(APPEARANCE), busy=BUSY.locked(), model="Stable Diffusion 1.5 + OpenPose ControlNet",
                   detail="" if available else "Install the optional local pose models with generative/install.ps1.")


@blueprint.post("/api/pose/generate")
def generate_pose():
    if not ready():
        return jsonify(error="Install the optional local pose models with generative/install.ps1."), 503
    guide = request.files.get("guide")
    if guide is None:
        return jsonify(error="The pose guide image is missing."), 400
    try:
        with Image.open(guide.stream) as incoming:
            if min(incoming.size) < 16 or max(incoming.size) > 2048:
                raise ValueError("Use a pose guide between 16 and 2048 pixels on each side.")
            image = incoming.convert("RGBA")
        reference = None
        if "reference" in request.files and ready(APPEARANCE):
            with Image.open(request.files["reference"].stream) as incoming:
                if min(incoming.size) < 8 or max(incoming.size) > 2048:
                    raise ValueError("Use a reference between 8 and 2048 pixels on each side.")
                reference = incoming.convert("RGBA")
        joints = json.loads(request.form.get("joints", ""))
        validate_joints(joints, *image.size)
        strength = float(request.form.get("strength", 0.46))
        seed = int(request.form.get("seed", 17))
        description = request.form.get("description", "").strip()
        if not (0.30 <= strength <= 0.75 and 0 <= seed < 2**32):
            raise ValueError("Use strength 0.30-0.75 and an unsigned 32-bit seed.")
        if len(description) > 300:
            raise ValueError("Keep the pose description under 301 characters.")
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        return jsonify(error=str(exc)), 400
    if not BUSY.acquire(blocking=False):
        return jsonify(error="Another pose is rendering. Wait for it to finish."), 409
    try:
        reserve_memory = current_app.extensions.get("pose_generation_memory", nullcontext)
        with reserve_memory(), TemporaryDirectory(prefix="step-photo-pose-") as temp:
            folder = Path(temp)
            image.save(folder / "guide.png")
            (folder / "joints.json").write_text(json.dumps(joints), encoding="utf-8")
            adapter = []
            if reference is not None:
                reference.save(folder / "reference.png")
                adapter = ["--reference", str(folder / "reference.png")]
            process = subprocess.run(
                [str(runtime()), str(HERE / "generate.py"), "--guide", str(folder / "guide.png"),
                 "--joints", str(folder / "joints.json"), "--output", str(folder / "pose.png"),
                 "--strength", str(strength), "--seed", str(seed), "--description", description, *adapter],
                capture_output=True, text=True, errors="replace", timeout=600,
            )
            if process.returncode:
                if process.returncode == 75:
                    return jsonify(error="Another local generation process is using the GPU. Try again when it finishes."), 409
                lines = process.stderr.strip().splitlines()
                cause = lines[-1][:300] if lines else f"Exit code {process.returncode}"
                return jsonify(error=f"Local pose rendering failed. {cause}"), 503
            with Image.open(folder / "pose.png") as rendered:
                cutout = extract_candidate(rendered, image)
            if cutout is None:
                output = io.BytesIO((folder / "pose.png").read_bytes())
            else:
                output = io.BytesIO()
                cutout.save(output, format="PNG")
                output.seek(0)
            response = send_file(output, mimetype="image/png", max_age=0)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Alpha-Mode"] = "embedded" if cutout is not None else "segment"
            response.headers["X-Pose-Conditioning"] = "pose, appearance" if adapter else "pose"
            return response
    except subprocess.TimeoutExpired:
        return jsonify(error="Local pose rendering exceeded ten minutes."), 504
    finally:
        BUSY.release()
