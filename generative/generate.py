"""Generate an alternative photographic pose locally from an RGBA guide and studio rig."""

import argparse
import json
import math
import os
from pathlib import Path
import sys
from tempfile import gettempdir

from PIL import Image, ImageDraw, ImageOps


HERE = Path(__file__).resolve().parent
WEIGHTS = HERE / "weights"
JOINTS = ["nose", "rightShoulder", "rightElbow", "rightWrist", "leftShoulder", "leftElbow",
          "leftWrist", "rightHip", "rightKnee", "rightAnkle", "leftHip", "leftKnee", "leftAnkle"]
# OpenPose COCO order and colors used by the released ControlNet annotator.
PALETTE = [(255,0,0),(255,85,0),(255,170,0),(255,255,0),(170,255,0),(85,255,0),
           (0,255,0),(0,255,85),(0,255,170),(0,255,255),(0,170,255),(0,85,255),
           (0,0,255),(85,0,255),(170,0,255),(255,0,255),(255,0,170),(255,0,85)]
BONES = [(1,2),(1,5),(2,3),(3,4),(5,6),(6,7),(1,8),(8,9),(9,10),(1,11),(11,12),(12,13),(1,0)]


def validate_joints(data, w, h):
    if not isinstance(data, dict):
        raise ValueError("Supply the pose editor's target joint map.")
    for name in JOINTS:
        p = data.get(name)
        if not isinstance(p, dict):
            raise ValueError(f"Missing {name}.")
        for axis, limit in [("x", w), ("y", h)]:
            value = p.get(axis)
            if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 3 * limit:
                raise ValueError(f"Invalid {axis} for {name}.")


def inputs(guide, joints, resolution):
    """Fit to the model canvas once so guide, skeleton and final crop agree."""
    guide = ImageOps.exif_transpose(guide).convert("RGBA")
    w, h = guide.size
    validate_joints(joints, w, h)
    scale = resolution / max(w, h)
    sw, sh = max(1, round(w * scale)), max(1, round(h * scale))
    x, y = (resolution - sw) // 2, (resolution - sh) // 2
    fitted = guide.resize((sw, sh), Image.Resampling.LANCZOS)
    rgb = Image.new("RGB", (resolution, resolution), (140, 140, 140))
    rgb.paste(fitted, (x, y), fitted.getchannel("A"))
    pts = [(round(x + joints[n]["x"] * sw / w), round(y + joints[n]["y"] * sh / h)) for n in JOINTS]
    neck = tuple(round((a + b) / 2) for a, b in zip(pts[1], pts[4]))
    pts.insert(1, neck)
    pose = Image.new("RGB", rgb.size, "black")
    draw = ImageDraw.Draw(pose)
    radius = max(2, round(4 * resolution / 512))
    for i, (start, end) in enumerate(BONES):
        color = tuple(round(v * 0.60) for v in PALETTE[i])
        draw.line((pts[start], pts[end]), fill=color, width=radius * 2)
    for i, (cx, cy) in enumerate(pts):
        draw.ellipse((cx-radius, cy-radius, cx+radius, cy+radius), fill=PALETTE[i])
    return rgb, pose, (x, y, x + sw, y + sh)


def generate(guide, joints, *, reference=None, strength=0.46, seed=17, steps=24, resolution=512, description=""):
    # All model reads are local. The weights are provisioned separately.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["USE_TF"] = "0"
    import torch
    from diffusers import ControlNetModel, DPMSolverMultistepScheduler, StableDiffusionControlNetImg2ImgPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("The installed pose renderer requires a CUDA-enabled PyTorch GPU.")
    rgb, pose, crop = inputs(guide, joints, resolution)
    common = dict(torch_dtype=torch.float16, variant="fp16", use_safetensors=True, local_files_only=True)
    control = ControlNetModel.from_pretrained(WEIGHTS / "control", **common)
    pipe = StableDiffusionControlNetImg2ImgPipeline.from_pretrained(WEIGHTS / "base", controlnet=control, **common)
    image_prompt = {}
    if reference is not None:
        from transformers import CLIPVisionModelWithProjection
        # Load directly as FP16 so the 2.5 GB vision checkpoint never needs
        # an additional full-precision in-memory copy on a laptop.
        encoder = CLIPVisionModelWithProjection.from_pretrained(
            WEIGHTS / "appearance" / "models" / "image_encoder",
            torch_dtype=torch.float16, low_cpu_mem_usage=True, local_files_only=True,
        )
        pipe.register_modules(image_encoder=encoder)
        pipe.load_ip_adapter(str(WEIGHTS / "appearance"), subfolder="models",
                             weight_name="ip-adapter-plus_sd15.safetensors", image_encoder_folder=None,
                             local_files_only=True)
        pipe.set_ip_adapter_scale(0.65)
        # CLIP crops to a square. Crop away transparent padding and letterbox
        # the selected person to retain shoes and head in the image prompt.
        rgba = ImageOps.exif_transpose(reference).convert("RGBA")
        bounds = rgba.getchannel("A").getbbox()
        if not bounds:
            raise ValueError("The appearance reference is transparent.")
        visible = rgba.crop(bounds)
        visible.thumbnail((224, 224), Image.Resampling.LANCZOS)
        prompt_image = Image.new("RGB", (224, 224), (140, 140, 140))
        prompt_image.paste(visible, ((224-visible.width)//2, (224-visible.height)//2), visible)
        image_prompt = {"ip_adapter_image": prompt_image}
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, algorithm_type="dpmsolver++", solver_order=2)
    # Individual weights travel to the GPU on demand, leaving room for the pose
    # model alongside the web app's SAM service on a 4 GB card.
    pipe.enable_sequential_cpu_offload()
    pipe.enable_vae_slicing()
    prompt = "full length photograph of a single person in the specified pose, natural anatomy, realistic clothing, detailed fabric, plain neutral gray studio background"
    if description:
        prompt = description.strip() + ", " + prompt
    with torch.inference_mode():
        result = pipe(
            prompt=prompt, image=rgb, control_image=pose,
            strength=strength, num_inference_steps=steps, guidance_scale=6.0,
            controlnet_conditioning_scale=1.0, generator=torch.Generator(device="cpu").manual_seed(seed),
            negative_prompt="duplicate person, mannequin, duplicate legs, extra arms, distorted hands, collage, cartoon, painting, text, watermark",
            **image_prompt,
        )
    if result.nsfw_content_detected and result.nsfw_content_detected[0]:
        raise RuntimeError("The model filtered this candidate. Adjust the pose or description and retry.")
    return result.images[0].crop(crop).resize(guide.size, Image.Resampling.LANCZOS)


def main():
    from filelock import FileLock, Timeout
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--guide", type=Path, required=True)
    parser.add_argument("--reference", type=Path, help="original cutout for IP-Adapter Plus, before pose editing")
    parser.add_argument("--joints", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--strength", type=float, default=0.46)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--steps", type=int, default=24)
    parser.add_argument("--resolution", type=int, choices=[384, 512], default=512)
    parser.add_argument("--description", default="")
    args = parser.parse_args()
    if not 0.3 <= args.strength <= 0.75 or not 8 <= args.steps <= 50:
        parser.error("Use strength 0.30–0.75 and 8–50 scheduler steps.")
    with Image.open(args.guide) as guide:
        target_pose = json.loads(args.joints.read_text("utf-8"))
        reference = None
        if args.reference:
            with Image.open(args.reference) as opened:
                reference = opened.convert("RGBA")
        # The CLI and independently launched studios share one laptop GPU.
        lock = FileLock(str(Path(gettempdir()) / "step-into-the-photo-pose.lock"))
        try:
            with lock.acquire(timeout=0):
                output = generate(guide, target_pose, reference=reference, strength=args.strength, seed=args.seed,
                                  steps=args.steps, resolution=args.resolution, description=args.description)
        except Timeout:
            print("Another local generation process is using the GPU.", file=sys.stderr)
            sys.exit(75)
    output.save(args.output)


if __name__ == "__main__":
    main()
