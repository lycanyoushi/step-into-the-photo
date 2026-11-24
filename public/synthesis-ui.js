import { $, toBlob, fileImage, bounds, copyImage } from './ui.js';
import { PersonCutout } from './media.js';

export function setupGeneration({ getGuide, getJoints, getReference, apply }) {
  const editor = $('pose-dialog'),
    details = document.createElement('details');
  details.className = 'generation';
  details.innerHTML =
    '<summary>Generate pose details</summary><p class="help">Local diffusion can redraw clothing and newly exposed areas. Inspect the face and hands before applying a variation.</p><div class="tools"><label>Variation strength <input id="diff-strength" type="range" min=".30" max=".75" step=".01" value=".46"><output id="strength-val">0.46</output></label><label>Seed <input id="diff-seed" type="number" min="0" max="4294967295" value="17"></label></div><label class="description">Appearance <input id="diff-description" maxlength="300" placeholder="e.g. white spacesuit with a gold visor"></label><div class="tools"><button id="generate-pose" disabled>Generate variation</button><span id="generation-status" class="help" aria-live="polite">Checking local model…</span></div><div id="candidate" hidden><div class="generation-pair"><figure><img id="guide-preview" alt="Textured geometric pose"><figcaption>Geometric pose</figcaption></figure><figure><img id="gen-preview" alt="Generated cutout"><figcaption>Generated variation</figcaption></figure></div><button id="apply-generated">Use generated variation</button></div>';
  editor.insertBefore(details, editor.querySelector('.dialog-actions'));
  let result = null,
    key = null,
    busy = false,
    epoch = 0;
  const fingerprint = () => JSON.stringify(getJoints());
  $('diff-strength').oninput = (e) => {
    $('strength-val').value = Number(e.target.value).toFixed(2);
  };
  details.ontoggle = async () => {
    if (!details.open || busy) return;
    try {
      const res = await fetch('/api/pose/status');
      if (!res.ok) throw Error('Local generator unavailable.');
      const status = await res.json();
      $('generate-pose').disabled = !status.available;
      let label = status.appearance ? 'Local pose and appearance models ready.' : 'Local pose model ready.';
      if (status.busy) label = 'Another local variation is rendering.';
      $('generation-status').textContent = status.available ? label : status.detail;
    } catch (e) {
      $('generation-status').textContent = e.message;
      $('generate-pose').disabled = true;
    }
  };
  function hideCandidate() {
    result = key = null;
    $('candidate').hidden = true;
  }
  editor.addEventListener('close', () => {
    epoch++;
    hideCandidate();
    details.open = false;
  });
  $('generate-pose').onclick = async () => {
    if (busy) return;
    busy = true;
    const requestEpoch = epoch,
      guide = copyImage(getGuide()),
      signature = fingerprint();
    hideCandidate();
    $('generate-pose').disabled = true;
    $('generation-status').textContent = 'Rendering locally. The first variation may take several minutes…';
    try {
      const data = new FormData();
      data.set('guide', await toBlob(guide), 'guide.png');
      data.set('joints', signature);
      data.set('strength', $('diff-strength').value);
      data.set('seed', $('diff-seed').value);
      data.set('description', $('diff-description').value);
      data.set('reference', await toBlob(getReference()), 'reference.png');
      const response = await fetch('/api/pose/generate', { method: 'POST', body: data });
      if (!response.ok) {
        const info = await response.json().catch(() => ({}));
        throw Error(info.error || 'Local pose generation failed.');
      }
      if (epoch !== requestEpoch) return;
      const image = await fileImage(await response.blob(), 2048),
        cut =
          response.headers.get('X-Alpha-Mode') === 'embedded'
            ? image
            : copyImage(await new PersonCutout().frame(image));
      if (epoch !== requestEpoch) return;
      if (!bounds(cut, true))
        throw Error(
          'The generated person could not be separated from the background. Try another strength or seed.'
        );
      if (signature !== fingerprint())
        throw Error('The pose changed during generation. Generate again for the current joints.');
      result = cut;
      key = signature;
      $('guide-preview').src = copyImage(guide, 300).toDataURL();
      $('gen-preview').src = copyImage(cut, 300).toDataURL();
      $('candidate').hidden = false;
      $('generation-status').textContent = 'Variation ready to inspect.';
    } catch (error) {
      if (epoch === requestEpoch) $('generation-status').textContent = error.message;
    } finally {
      busy = false;
      $('generate-pose').disabled = false;
    }
  };
  $('apply-generated').onclick = () => {
    if (result && key === fingerprint()) apply(result);
    else {
      hideCandidate();
      $('generation-status').textContent = 'The pose changed. Generate a fresh variation.';
    }
  };
}
