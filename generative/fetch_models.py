"""Download only the pinned FP16 inference components for local pose synthesis."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
WEIGHTS = ROOT / "weights"
REPOS = {
    "base": (
        "stable-diffusion-v1-5/stable-diffusion-v1-5", "451f4fe16113bff5a5d2269ed5ad43b0592e9a14",
        ["model_index.json", "feature_extractor/preprocessor_config.json", "safety_checker/config.json",
         "safety_checker/model.fp16.safetensors", "scheduler/scheduler_config.json", "text_encoder/config.json",
         "text_encoder/model.fp16.safetensors", "tokenizer/merges.txt", "tokenizer/special_tokens_map.json",
         "tokenizer/tokenizer_config.json", "tokenizer/vocab.json", "unet/config.json",
         "unet/diffusion_pytorch_model.fp16.safetensors", "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors"],
    ),
    "control": (
        "lllyasviel/control_v11p_sd15_openpose", "9ae9f970358db89e211b87c915f9535c6686d5ba",
        ["config.json", "diffusion_pytorch_model.fp16.safetensors"],
    ),
}
APPEARANCE = {
    "appearance": (
        "h94/IP-Adapter", "018e402774aeeddd60609b4ecdb7e298259dc729",
        ["models/ip-adapter-plus_sd15.safetensors", "models/image_encoder/config.json",
         "models/image_encoder/model.safetensors"],
    ),
}


def fetch(job):
    repo, revision, details, destination = job
    expected = details["size"]
    expected_sha = details.get("lfs", {}).get("sha256")
    if destination.exists() and destination.stat().st_size == expected:
        with destination.open("rb") as f:
            if not expected_sha or hashlib.file_digest(f, "sha256").hexdigest() == expected_sha:
                return
    destination.parent.mkdir(parents=True, exist_ok=True)
    part = destination.with_suffix(destination.suffix + ".part")
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{details['rfilename']}"
    for attempt in range(4):
        offset = part.stat().st_size if part.exists() else 0
        try:
            if offset > expected:
                part.unlink()
                offset = 0
            if offset < expected:
                request = Request(f"{url}?download=true&t={time.time_ns()}",
                                  headers={"Range": f"bytes={offset}-"} if offset else {})
                with urlopen(request, timeout=90) as stream:
                    with part.open("ab" if offset and stream.status == 206 else "wb") as out:
                        while chunk := stream.read(1024 * 1024):
                            out.write(chunk)
            if part.stat().st_size != expected:
                raise OSError("Download ended before the expected byte count")
            if expected_sha:
                with part.open("rb") as f:
                    if hashlib.file_digest(f, "sha256").hexdigest() != expected_sha:
                        part.unlink()
                        raise OSError("Incorrect model checksum")
            part.replace(destination)
            print(destination.relative_to(WEIGHTS), flush=True)
            return
        except OSError as error:
            if attempt == 3:
                raise
            print(f"Retrying {destination.name}: {error}", flush=True)
            time.sleep(2 ** attempt)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--appearance", action="store_true", help="also download the IP-Adapter Plus appearance encoder")
    args = parser.parse_args()
    jobs = []
    repos = {**REPOS, **APPEARANCE} if args.appearance else REPOS
    for kind, (repo, revision, names) in repos.items():
        url = f"https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true"
        with urlopen(url, timeout=45) as response:
            meta = {x["rfilename"]: x for x in json.load(response)["siblings"]}
        jobs.extend((repo, revision, meta[name], WEIGHTS / kind / name) for name in names)
    jobs.sort(key=lambda job: -job[2]["size"])
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(fetch, jobs))
    print("Local pose model files ready.", flush=True)


if __name__ == "__main__":
    main()
