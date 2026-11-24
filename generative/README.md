# Local photographic pose synthesis

The studio first repositions visible source pixels with its editable skeleton. This optional second pass can fill stretched joints, smooth gaps and invent newly visible clothing. An OpenPose ControlNet constrains the target limbs during Stable Diffusion 1.5 image-to-image sampling. The posed source supplies the initial image. IP-Adapter Plus conditions the result on the original cutout's appearance when those additional weights and a reference are present.

## Run

On Windows, run the following from the project folder with Python 3.11 or 3.12. The installer creates a separate Python environment and downloads about 6.1 GB of pinned weights. Inference runs locally. This configuration uses NVIDIA CUDA, half precision and sequential CPU offload.

```powershell
.\generative\install.ps1
```

On a Linux machine with a compatible NVIDIA driver, run the equivalent setup from the project folder.

```sh
python3 -m venv generative/.venv
generative/.venv/bin/python -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121
generative/.venv/bin/python -m pip install -r generative/requirements.txt
generative/.venv/bin/python generative/fetch_models.py --appearance
```

Open the studio pose editor, move the joints, then generate a candidate. Supplying a short description of clothing, viewing direction or pose can help. Lower strength retains more of the guide. Higher strength redraws more of the person. The CLI and studio share a local GPU lock. The generation process exits after each candidate, releasing its GPU memory.

The following command renders the supplied astronaut example directly from the project folder.

```powershell
.\generative\.venv\Scripts\python.exe generative\generate.py --guide generative\example\wave-guide.png --joints generative\example\wave-joints.json --reference public\samples\traveler.png --description "an astronaut in a white spacesuit, reflective golden helmet, one hand raised in a wave" --output wave.png
```

The guide and joint coordinates must share a pixel coordinate system. The tool letterboxes both onto the same 512 × 512 inference canvas, then crops and scales the generated RGB image back to the guide dimensions. The studio endpoint uses the guide alpha to initialize GrabCut on the generated RGB pixels. A wide search region around the original outline lets the matte follow newly drawn fingertips, fabric and accessories. Soft edges are corrected for the studio background color before compositing. An opaque guide, a complex generated background or an implausible extracted area triggers browser MediaPipe segmentation. The CLI writes the full RGB candidate. The `--resolution 384` switch and fewer scheduler steps trade detail for faster iteration. Omitting `--reference` uses only the guide and OpenPose model. To provision only these smaller weights, run `fetch_models.py` without `--appearance`.

## Interpreting the output

The example starts with the bundled Apollo 11 astronaut cutout and the studio's Wave preset. Compare `example/wave-guide.png` with `example/wave-synthesized.png` for the guide-only generation and `example/wave-with-reference.png` for IP-Adapter Plus conditioning. The generated glove and boots gain coherent outlines while the visor reflection, chest fittings and small suit details change. Single-view synthesis estimates hidden surfaces and can alter faces, hands, clothing, proportions and viewpoint. A 2D target skeleton leaves depth, facing direction and finger placement ambiguous.

`example/wave-cutout.png` is the reference-conditioned candidate with the studio's refined matte. It can be imported directly as a transparent person. On this 949 × 949 example, matte extraction took about 1.1 seconds on CPU. The refined mask retained the raised glove, added 16,732 pixels outside the guide outline, and removed 4,494 pixels from the guide where the generated silhouette had moved. These counts use an alpha threshold of 128.

On the test laptop with Windows, a 4 GB GeForce RTX 3050 and 16 GB system RAM, a 512 × 512 guide-only candidate took 64.9 seconds from process start to saved PNG. The reference-conditioned candidate took 83.8 seconds through the local Flask endpoint. Both used seed 17, 24 scheduler steps and strength 0.46, which executes 11 effective denoising steps. The result PNG is resampled to the guide dimensions. These measurements include loading the components fresh for each request.

## Model sources

- Stable Diffusion v1.5 uses CreativeML OpenRAIL-M. Base weights include the UNet, VAE, text encoder and safety checker, approximately 2.74 GB. [Model card and terms](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5)
- OpenPose ControlNet v1.1 uses CreativeML OpenRAIL-M. The FP16 weight file occupies 723 MB. [Model card and terms](https://huggingface.co/lllyasviel/control_v11p_sd15_openpose)
- IP-Adapter Plus uses Apache 2.0. The appearance adapter occupies 98 MB and the CLIP vision encoder 2.53 GB. [Model card and terms](https://huggingface.co/h94/IP-Adapter)
- [Diffusers ControlNet image-to-image implementation](https://huggingface.co/docs/diffusers/api/pipelines/controlnet).

The installer reads model metadata at fixed revisions, verifies each large file's published LFS SHA-256 digest and resumes partial downloads. Model loading uses local-files-only mode.
