"""Locate local weights or explicitly fetch the pinned, checksum-verified models."""

import argparse
import hashlib
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.request import urlopen


CACHE = Path(os.getenv("STEP_MODEL_DIR", Path.home() / ".cache" / "step-into-the-photo"))
SAM = "sam2.1_hiera_tiny.pt"
LAMA = "lama_fp32.onnx"
DEPTH = "depth_anything_v2_small.onnx"
GROUNDING = "grounding_dino_tiny_q8.onnx"
GROUNDING_TOKENIZER = "grounding_dino_tokenizer.json"
HARMONIZER = "pctnet_vit.pth"
GROUNDING_URL = ("https://huggingface.co/onnx-community/grounding-dino-tiny-ONNX/resolve/"
                 "ff690b0a8050566c290287545bd059350f3e9096/")
MODELS = {
    HARMONIZER: (
        "https://huggingface.co/BCMIZB/Libcom_pretrained_models/resolve/"
        "2aad2ae5bcd17054dfa6f40d6f58f3d3411f2e9c/PCTNet.pth",
        "b2cf9260036f1e733d07a295f70f08d373593d64098727ff1798ddf2ff096aef",
    ),
    GROUNDING: (
        GROUNDING_URL + "onnx/model_quantized.onnx",
        "70bf2d3310d1ae73769c96a71e00cbf2861eb33a1f4d97d84a108a7bf02c03c9",
    ),
    GROUNDING_TOKENIZER: (
        GROUNDING_URL + "tokenizer.json",
        "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    ),
    SAM: (
        "https://huggingface.co/facebook/sam2.1-hiera-tiny/resolve/"
        "de431c4043854a71d8101e17995dfe596bf101a5/sam2.1_hiera_tiny.pt",
        "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
    ),
    LAMA: (
        "https://huggingface.co/Carve/LaMa-ONNX/resolve/"
        "c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
        "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
    ),
    DEPTH: (
        "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/"
        "4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx",
        "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
    ),
}


def weight_path(name):
    path = CACHE / name
    if name == SAM and not path.is_file():
        shared = Path.home() / ".cache" / "match-cut-relay" / SAM
        if shared.is_file():
            return shared
    return path


def install(name):
    url, expected = MODELS[name]
    candidate = weight_path(name)
    if candidate.is_file():
        with candidate.open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() == expected:
                print(f"Verified {candidate}", flush=True)
                return
    CACHE.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=CACHE, delete=False) as file:
        temporary = Path(file.name)
    try:
        digest = hashlib.sha256()
        with urlopen(url, timeout=120) as response, temporary.open("wb") as file:
            while chunk := response.read(1024 * 1024):
                file.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError(f"Checksum mismatch for {name}")
        temporary.replace(CACHE / name)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Installed {CACHE / name}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["sam2", "lama", "depth", "placement", "harmonize", "both", "all"], default="all")
    choice = parser.parse_args().model
    if choice in {"sam2", "both", "all"}:
        install(SAM)
    if choice in {"lama", "both", "all"}:
        install(LAMA)
    if choice in {"depth", "all"}:
        install(DEPTH)
    if choice in {"harmonize", "all"}:
        install(HARMONIZER)
    if choice in {"placement", "all"}:
        install(GROUNDING)
        install(GROUNDING_TOKENIZER)
