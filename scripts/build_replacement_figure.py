"""Export the field-notes replacement from a running local LaMa studio."""

import argparse
import base64
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

PUBLIC = Path(__file__).resolve().parents[1] / "public"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:5181")
    origin = parser.parse_args().origin.rstrip("/")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=os.environ.get("PLAYWRIGHT_BROWSER_CHANNEL", "chrome"),
                                             args=["--enable-unsafe-swiftshader"])
        page = browser.new_page()
        page.goto(f"{origin}/pose.js")
        result = page.evaluate("""
            async () => {
                const {SceneRenderer}=await import('./engine.js');
                const {canvas,copyImage,readImage,apiImage}=await import('./ui.js');
                const {expandRemovalMask,defaultRemovalMargin}=await import('./mask-editor.js');
                const {padForPose,createPoseRig,applyPosePreset,renderPose}=await import('./pose.js');
                const [scene,mask,visitor]=await Promise.all(
                    ['kitty-hawk.jpg','wilbur-mask.png','traveler.png'].map(async file=>
                        copyImage(await readImage('./samples/'+file))));
                const margin=defaultRemovalMargin(scene), expanded=expandRemovalMask(mask,margin);
                const {image:plate,method}=await apiImage('remove',{image:scene,mask:expanded});
                if(method!=='LaMa') throw Error('This figure requires the LaMa model');
                const data=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                const [before,after,outline]=[scene,plate,expanded].map(data);
                let changed=0,selected=0;
                for(let i=0;i<before.length;i+=4) {
                    const delta=before[i]!==after[i]||before[i+1]!==after[i+1]||before[i+2]!==after[i+2];
                    if(outline[i]>=128) {selected++; if(delta) changed++;}
                    else if(delta) throw Error('Removal changed a pixel outside its target');
                }
                if(!changed) throw Error('Removal left the selected person intact');
                const cut=padForPose(visitor), rig=await createPoseRig(cut);
                if(!rig.detected) throw Error('Pose estimation failed for the sample astronaut');
                applyPosePreset(rig,'wave');
                const out=canvas(1,1), renderer=new SceneRenderer(out);
                renderer.setScene(scene);renderer.setReference(mask);renderer.setCleanPlate(plate);
                renderer.render(renderPose(cut,rig),{mode:'replace',look:'simple',x:.895,y:.449,width:.138});
                const figures=[plate,out].map(image=>{
                    const detail=canvas(408,310);
                    detail.getContext('2d').drawImage(image,621,136,204,155,0,0,408,310);
                    return detail.toDataURL('image/webp',.94);
                });
                return {figures,margin,selected,changed};
            }""")
        browser.close()
    for name, data in zip(["replacement-background", "replacement-posed"], result.pop("figures")):
        (PUBLIC / "figures" / f"{name}.webp").write_bytes(base64.b64decode(data.split(",", 1)[1]))
    print("Verified LaMa removal and pose render.", result)


if __name__ == "__main__":
    main()
