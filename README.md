# Step Into the Photo

A local browser studio for inserting a visitor into a photograph, replacing a selected person, and changing a cutout’s pose. The starting composition pairs an Apollo 11 astronaut with the Wright brothers’ first flight. Both source layers can be changed.

## Launch

On this Windows laptop, start in this directory and run:

```powershell
.\launch.ps1
```

Open [the composition studio](http://127.0.0.1:5181/) in Edge or Chrome. The [illustrated field notes](http://127.0.0.1:5181/notes.html) show the effects and their limitations. The launcher uses the project environment if present, then the existing neighboring SAM 2 environment, then the active Python. The browser models, demonstration media and fonts are served locally. Uploaded pictures are processed in browser memory and the local Flask service. Save any desired images, videos or measurements before closing the tab.

### Present a live photograph

Open the [live camera demo](http://127.0.0.1:5181/?live=1) on the display the audience will see. It opens on the original picnic photograph with the camera off. **Choose photograph** loads your own picture, and **Scene library** offers prepared alternatives.

1. Click **Start camera** and allow camera access, or choose **Use a photo of a person** to place someone from a still picture. A moving person appears inside the photo as soon as the camera sees them. The studio uses video only.
2. The demo measures the photograph first: depth, the ground, and the size of the faces already in it. It then chooses a spot where a person of the right size could really be. To direct the visitor, type **behind the woman**, **beside the child**, **to the left of the table**, or **on the right** under **Place the visitor**, then choose **Place me**. You can enter the prompt before the visitor arrives or afterwards. For “behind”, the photographed subject covers the visitor wherever their silhouettes overlap. Multiple plausible matches appear as thumbnail choices. **Pick subject in photo** lets you click a missed match.
3. Click **Present full screen**. The audience sees the composite as the person walks, leans or waves. If the person leaves the camera frame, the underlying photograph remains on screen. Press **Esc** to adjust the setup while capture continues, or choose **Stop camera** to release it and return to the original photograph.

Clear the prompt and choose **Place me** to return to automatic placement. Drag the visitor or open **Adjust the composition** to refine a result. The camera keeps that position as the performer moves. The app estimates scale and ground position from a single view, so unusual viewpoints may need an adjustment.

Under **Adjust the composition**, **Visitor lighting → Exposure** lets you brighten or darken the visitor without changing the photo. A window on the same side as the light in the photograph helps when the real room and the photograph have very different lighting.

### How the visitor is blended

Whatever spot the prompt selects, the same four steps make the visitor belong there.

- **Size and footing.** A face is about the same size on everyone, so the faces in the photograph calibrate how large a person appears at each depth. Level ground comes steadily nearer toward the bottom of a picture, which gives the row where someone at a given depth stands. A visitor with visible feet is set on that row. A kitchen counter also recedes like ground, so the studio rejects a surface that people are visibly standing behind.
- **A cropped camera view.** A waist-up visitor has a straight lower edge where the camera stopped. The studio only accepts a spot where something nearer in the photograph covers that edge, such as a person, a basket or a counter. Nearer ground does not count, because it would bury the visitor. With nothing to stand behind, the visitor moves to the near foreground and is cropped by the photograph’s own bottom edge. Step back until the camera sees your feet for more freedom.
- **Color and light.** A local harmonization network, PCT-Net, looks at the untreated visitor inside the photograph and predicts how that picture would have rendered them. The studio keeps the answer as a color table, so it stays valid while a live visitor moves, and refreshes it every couple of seconds. When most people in the scene have dark faces and torsos against a much brighter background, the studio can further darken a visitor who still looks overexposed.
- **Edges, focus and shadow.** The visitor is softened to the width of the sharpest edges the photograph has at that depth, receives a rim of light from what is behind them, and casts a soft shadow whose direction and depth are read from the shadows beside the photographed people. Scene depth, sharpened along the photograph’s own edges, decides what stands in front.
- **Grain.** The studio samples smooth areas of the scene and visitor at their displayed size. When the scene has measurably more grain, it adds fine luminance variations inside the visible visitor and keeps the pattern steady during live motion.

Finish → **Blend into the photograph** is this method and is the default. The earlier treatments remain for comparison. Without PyTorch or the harmonization weights, the studio falls back to the exposure and white-balance estimate at the visitor’s position.

### Set up another machine

For basic operation, install Python 3.11 or 3.12, run `python -m pip install -r requirements.txt`, then `python app.py`. This configuration includes point-assisted GrabCut, manual outlines, Telea inpainting, MediaPipe person cutouts, tone matching and the geometric pose editor. The studio identifies the active selection method.

To install the harmonization network independently, run `python -m server.weights --model harmonize` in an environment with PyTorch. It is a 19 MB checkpoint and runs on a processor or a graphics card. [PCT-Net](https://github.com/rakutentech/PCT-Net-Image-Harmonization) · [checkpoint](https://huggingface.co/BCMIZB/Libcom_pretrained_models/tree/2aad2ae5bcd17054dfa6f40d6f58f3d3411f2e9c)

To install the photograph's subject detector independently, run `python -m server.weights --model placement`. The app uses this local model to find the people and objects named by the presenter. [Grounding DINO Tiny checkpoint](https://huggingface.co/onnx-community/grounding-dino-tiny-ONNX/tree/ff690b0a8050566c290287545bd059350f3e9096)

For the full Windows setup, select a Python environment with compatible Torch and Torchvision installed and run `.\install-models.ps1`. Restart the launcher. Model weights are verified by SHA-256 and cached locally. To enable the optional generative pose editor on an NVIDIA CUDA machine, run `.\generative\install.ps1`. The generative environment and weights are separate from the camera and geometric editing paths. [Generative setup, licenses and CLI example](generative/README.md)

## Make a composition

### Step into a family picture live

The [family gallery](http://127.0.0.1:5181/families.html) has four playable examples. **Open in studio** loads the pictured family, foreground outlines, and a moving visitor at the demonstrated placement. Click **Use webcam** to take the visitor’s place. Upload a background at **Scene photograph** to try your own picture. Changing scenes from the library or upload control keeps the current webcam or recording playing.

For unfamiliar scenes, **Follow my movement** runs Depth Anything V2 Small locally once on the background. Place the visitor with their feet on a visible floor. That point anchors the starting depth. As the person moves in the camera, the live matte carries their body motion into the scene. Changes in foot position and apparent size together move them forward or backward relative to photographed objects. Dragging the visitor sets a new anchor. When replacing someone, the studio estimates depth from the reconstructed background. [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) · [ONNX checkpoint](https://huggingface.co/onnx-community/depth-anything-v2-small)

A position chosen from a prompt already knows its depth, including behind a subject and for a waist-up view. Use **Set depth** to override it, or for a hand-placed visitor without visible feet. **Foreground outline only** gives direct control over who stays in front. An explicit foreground outline stays in front in all three modes. Contact shadows and optional floor reflections follow visible feet. The shore example enables reflection on wet sand. The model estimates relative depth from one fixed image. Reflections, transparent surfaces, complex lighting and a limb reaching around an object can need a hand-adjusted composition.

JPEG, PNG and WebP open in the browser. A local decoder also accepts supported HEIC/HEIF and TIFF sources, applies their orientation, and retains transparency when present. The fallback works with uploads up to 48 MB and 64 megapixels. A basic install can enable scene depth independently with `python -m server.weights --model depth`.

1. **Choose the scene and visitor.** In **Layers**, use the upload controls beside **Scene photograph** and **Active person**, choose a photograph from **Scene library**, or start **Use webcam**. A transparent PNG keeps its existing alpha. For a group photograph, upload the image and choose **Select person** to isolate one individual.
2. **Add someone.** In **Add person**, drag the visitor on the preview, then adjust size, rotation or horizontal flip. With the canvas focused, arrow keys move by one pixel and Shift plus an arrow moves by ten. **Edit foreground outline** lets you tap or hand trace the subject who should stand in front of the visitor. Use exclusion taps or the correction brush for hair, glasses or a neighboring person.
3. **Replace someone.** Choose **Replace** and tap the person in the scene. Inspect the outline and adjust **Removal margin** if the person has a dark fringe or stands close to a neighbor. Orange shows the additional pixels used to clear the background. Choose **Use outline**. The local inpainter reconstructs that area and the editor fits the visitor to the original subject. An independent foreground outline can put another person or object in front of the replacement. [Illustrated replacement example](http://127.0.0.1:5181/notes.html#replacement)
4. **Change the pose.** Open **Pose → Open pose editor**. Drag the body landmarks, choose a preset, or choose **Use reference photo**. **Adjust source joints** corrects where the editor attaches the texture. **Use selected scene person’s pose** borrows the outgoing subject’s pose. For an actual turn, crouch or unusual hand position, import a photograph/video in that pose or perform it on the webcam. **Freeze current frame** makes it editable as a still.
5. **Generate pose details.** In the pose editor, expand **Generate pose details**, optionally describe the clothing and click **Generate variation**. The studio sends the original appearance reference, posed texture and target joints to the local generator. Inspect both versions before applying the generated cutout. Fine facial features, hands, clothing and accessories can change.
6. **Finish.** **Blend into the photograph** is the default look. Untouched colors, a simple grayscale or brightness/contrast correction, and masked color transfer are available for comparison under **Finish**. **Keep person in scene** fixes the current composite as the background for another addition or replacement. You can undo up to eight kept layers. **Save photo** exports the rendered PNG. **Record clip** records the rendered canvas. To capture reusable *input* motion, start the webcam, use **Pose → Record webcam take**, then stop to download the take and replay it in the editor.

Uploaded scene edges are limited to 1,600 pixels for interactive editing. The live photo demo requests up to 1280 × 960 as its preferred camera capture and processes the visitor at up to 960 pixels on the long edge. The gallery clips were rendered ahead of time with the earlier exposure-and-white-balance treatment at hand-set positions; opening a family in the studio or the live demo uses the current method. The original evaluation workflows retain their 640-pixel video processing limit. Exports use the working scene resolution. The explicit foreground layer restores original pixels inside its mask. Hands passing on opposite sides of the same person require a different mask or another compositing pass. Backgrounds hidden by the original person have to be estimated.

## Compare the proposal treatments

The [original-or-inserted comparison](http://127.0.0.1:5181/notes.html#realism-test) holds the subject and pose fixed. Choose the original exposure, reveal the answer, then inspect the untreated insertion to see which lighting and texture cues changed.

The library contains eight development photographs and twelve held-out photographs. The [manifest](public/scenes.json) records the source, credit, split and checksum for each image. A **held-out** entry is reserved for the final comparison. Loading a scene starts a new composition with the current visitor.

Use one visitor recording for each comparison and settle its position and size. In Add mode, save the first one-tap outline and a separate hand trace in the foreground editor. **Finish → Evaluation tools → Build comparison** reuses the same placement and cutout frames. The two outline conditions are a hand trace and the first automatic selection. The color conditions are untreated, simple and matched. A separate flat overlay illustrates the effect of foreground restoration. The viewer can choose a view or a tie and describe what attracted attention. Save the ballot, then export session measurements as JSON.

An uploaded take supplies up to ten seconds at 12 sampled frames per second for the comparison export. This offline trial rate is independent of live preview performance. **Measure 30 seconds** counts fresh, segmented, composited and displayed input frames on the current setup. Record whether the source was a physical webcam or a replay, its resolution, the device, and the browser. Human preference, uncoached setup time and a physical-webcam frame-rate measurement require actual sessions.

For the setup-time study, open **Finish → Evaluation tools**, enter anonymous participant and scene codes, choose a method and start a timed trial. The trial starts from a blank outline and reset placement. Save the finished photo to mark completion. Add any assistance or correction notes and export the JSON. The editor keeps the first completed automatic and hand-traced comparison masks even when the working outline is later repaired.

Two [ten-second examples](http://127.0.0.1:5181/notes.html#motion) use the same licensed dance performance in a black-and-white print and a color crew photograph. Each export has 250 decoded frames at 25 fps. The four panels show the original scene, the untreated visitor, the simple correction, and matched tones. The [recorded frame checks](public/demo/verification.json) and [media credits](public/demo/credits.txt) accompany the clips. To use that recording yourself, choose **Pose → Try the recorded dancer**.

In the integrated camera test, Edge processed and displayed 752 distinct camera timestamps in 30.051 seconds, or **25.02 fps**, using a file-backed camera replaying the recording at its native 25 fps. The 250 unique source frames loop every ten seconds. This run used the blended treatment, the detailed matte and an 850 × 505 scene. `python tests/browser_capture.py --benchmark` reproduces the measurement. [Device and timing data](public/demo/live-benchmark.json)

## Reproduction

The backend checks run with `python -m unittest discover -s tests`. Browser checks require Python Playwright and a Chromium browser. On this laptop, the following commands use the installed Edge browser. The studio workflow check uses a running local server.

```powershell
$env:BROWSER_CHANNEL = 'msedge'
python tests/browser_engine.py
python tests/check_pose_browser.py
python tests/browser_study.py
python tests/browser_timing.py
python tests/browser_removal_margin.py
python tests/browser_studio.py
python tests/browser_capture.py
python tests/browser_live_depth.py
python tests/browser_family_scenes.py
python tests/browser_presentation.py
python tests/browser_photographic_matte.py
python tests/browser_auto_placement.py
python tests/browser_auto_placement.py --real
node tests/test_placement_plan.mjs
python tests/browser_camera_lifecycle.py
python tests/browser_audience.py
python scripts/check_family_scenes.py
python scripts/fetch_scene_bank.py --verify
```

`python tests/browser_engine.py --benchmark` also measures the matched renderer on a 640 × 480 synthetic camera stream for thirty seconds. The browser checks cover foreground pixel restoration, fixed color transfer, source alpha, real local segmentation and pose detection, reference-pose transfer, replacement through the editor, undo, synchronized export and blind voting. Browser runtime assets can be rebuilt with `python scripts/fetch_browser_runtime.py`. The illustrated methods and photo credits are in [Field notes](public/notes.html).
