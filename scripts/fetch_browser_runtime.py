"""Rebuild the vendored, offline MediaPipe Image Segmenter assets."""

from hashlib import sha256
from io import BytesIO
from pathlib import Path
import tarfile
from urllib.request import urlopen


DEST = Path(__file__).resolve().parents[1] / "public" / "vendor" / "mediapipe"
PACKAGE = "https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz"
MODEL = ("https://storage.googleapis.com/mediapipe-models/image_segmenter/"
         "selfie_segmenter/float16/1/selfie_segmenter.tflite")
MULTICLASS = ("https://storage.googleapis.com/mediapipe-models/image_segmenter/"
              "selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite")
POSE = ("https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_lite/float16/1/pose_landmarker_lite.task")
FACE = ("https://storage.googleapis.com/mediapipe-models/face_detector/"
        "blaze_face_short_range/float16/1/blaze_face_short_range.tflite")
LICENSE = "https://raw.githubusercontent.com/google-ai-edge/mediapipe/v0.10.21/LICENSE"


def verified(url, expected):
    with urlopen(url, timeout=90) as response:
        data = response.read()
    if sha256(data).hexdigest() != expected:
        raise ValueError(f"Checksum mismatch for {url}")
    return data


def main():
    package = verified(PACKAGE, "343736570f433c0100ffc360dbe70f09cc502a5fc573f5cd95954692edc9cfde")
    model = verified(MODEL, "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b")
    multiclass = verified(MULTICLASS, "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0")
    pose = verified(POSE, "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a")
    license_text = verified(LICENSE, "8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8")
    (DEST / "wasm").mkdir(parents=True, exist_ok=True)
    names = [
        "vision_bundle.mjs",
        "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm",
        "wasm/vision_wasm_nosimd_internal.js", "wasm/vision_wasm_nosimd_internal.wasm",
    ]
    with tarfile.open(fileobj=BytesIO(package), mode="r:gz") as archive:
        for name in names:
            (DEST / name).write_bytes(archive.extractfile("package/" + name).read())
    (DEST / "selfie_segmenter.tflite").write_bytes(model)
    (DEST / "selfie_multiclass_256x256.tflite").write_bytes(multiclass)
    (DEST / "LICENSE").write_bytes(license_text)
    models = DEST.parents[1] / "models"
    models.mkdir(exist_ok=True)
    (models / "pose_landmarker_lite.task").write_bytes(pose)
    (models / "blaze_face_short_range.tflite").write_bytes(
        verified(FACE, "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f"))
    print("Installed MediaPipe Tasks Vision 0.10.21, both selfie models, Pose Landmarker Lite and BlazeFace.")


if __name__ == "__main__":
    main()
