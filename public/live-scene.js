import { $, apiImage } from './ui.js';
import { placementKey } from './guided-placement.js';

// A photograph has relative depth, with no camera intrinsics or distances in metres.
// Anchor the visitor once at their feet. Avoid resampling an occluding object as they pass it.
export class LiveScene {
  constructor(renderer, state, redraw) {
    this.renderer = renderer;
    this.state = state;
    this.redraw = redraw;
    this.maps = new WeakMap();
    this.settings = new WeakMap();
    this.currentMap = null;
    this.baseImage = null;
    this.ticket = 0;
    this.anchor = null;
    this.lastOptions = {};
    $('space-mode').onchange = () => {
      this.config().mode = $('space-mode').value;
      this.refresh();
      this.redraw();
    };
    $('depth-level').oninput = () => {
      this.config().level = Number($('depth-level').value) / 100;
      $('depth-level-out').value = $('depth-level').value + '%';
      this.redraw();
    };
    $('floor-shadow').onchange = () => {
      this.config().shadow = $('floor-shadow').checked;
      this.redraw();
    };
    $('floor-reflection').onchange = () => {
      this.config().reflection = $('floor-reflection').checked;
      this.redraw();
    };
  }

  config() {
    const s = this.state;
    if (!this.settings.has(s.scene)) {
      this.settings.set(s.scene, {
        mode: s.foreground ? 'outline' : 'auto',
        level: 0.7,
        shadow: true,
        reflection: s.family?.reflection === true
      });
    }
    return this.settings.get(s.scene);
  }

  status(message) {
    if ($('depth-help').textContent !== message) $('depth-help').textContent = message;
  }

  depthFor(base) {
    let pending = this.maps.get(base);
    if (!pending) {
      pending = apiImage('depth', { image: base })
        .then((result) => result.image)
        .catch((error) => {
          this.maps.delete(base);
          throw error;
        });
      this.maps.set(base, pending);
    }
    return pending;
  }

  async refresh() {
    const s = this.state;
    // Depth, shadow and reflection apply to a still visitor as much as a moving one.
    const enabled = !!s.cut;
    $('live-tools').hidden = !enabled;
    const ticket = ++this.ticket;
    const base = s.mode === 'replace' ? s.plate : s.scene;
    const config = this.config();
    $('space-mode').value = config.mode;
    $('manual-depth').hidden = config.mode !== 'manual';
    $('depth-level').value = config.level * 100;
    $('depth-level-out').value = Math.round(config.level * 100) + '%';
    $('floor-shadow').checked = config.shadow;
    $('floor-reflection').checked = config.reflection;
    if (base !== this.baseImage) {
      this.baseImage = base;
      this.currentMap = null;
      this.renderer.setDepthMap(null);
    }
    this.anchor = null;
    if ((!enabled && !s.frozenSpace) || !base) return;
    if (config.mode === 'outline') {
      this.status('Use a foreground outline for any person or object that should stay in front.');
      return;
    }
    if (!this.currentMap) {
      this.status('Estimating depth from this photograph…');
      try {
        const image = await this.depthFor(base);
        if (ticket !== this.ticket || this.baseImage !== base) return;
        this.currentMap = image;
        this.renderer.setDepthMap(image);
      } catch (error) {
        if (ticket === this.ticket) this.status(error.message + ' The visitor can still move in the scene.');
        return;
      }
    }
    if (config.mode === 'manual')
      this.status('Move the slider toward Near to appear in front of more of the photograph.');
    this.redraw();
  }

  options(cut) {
    const s = this.state;
    if (!s.video && s.frozenSpace && !s.rig) return s.frozenSpace;
    if (!cut) return {};
    const config = this.config();
    let depth = null;
    if (this.currentMap && config.mode === 'manual') depth = config.level;
    if (this.currentMap && config.mode === 'auto') depth = this.trackedDepth(cut, s.placement);
    this.lastOptions = { grounded: config.shadow, reflection: config.reflection, depth };
    return this.lastOptions;
  }

  trackedDepth(cut, placement) {
    const feet = cut?.floorContact;
    const key = placementKey(placement);
    // A planned position knows its depth even when no feet are in view: behind
    // a subject, or cropped at the waist by the camera.
    const planned = this.state.planned;
    if (key !== this.anchor?.key) this.anchor = null;
    const size = feet ? feet.bodyHeight / cut.height : null;
    if (!this.anchor) {
      let depth = planned?.key === key && Number.isFinite(planned.depth) ? planned.depth : null;
      const fixed = depth !== null;
      if (depth === null && feet && size > 0) {
        const sample = this.renderer.depthAtFeet(cut, placement);
        if (Number.isFinite(sample)) depth = sample;
      }
      if (depth === null) {
        // Moved by hand without visible feet: keep the last known depth.
        if (Number.isFinite(planned?.depth)) return planned.depth;
        this.status(
          feet
            ? 'Place the visitor’s feet on a visible floor or ground surface to anchor their depth.'
            : 'Auto depth uses visible feet. Step back, or choose Set depth for a cropped or seated visitor.'
        );
        return null;
      }
      this.anchor = { key, depth, initialDepth: depth, size, fixed, footY: feet ? feet.y / cut.height : null };
    }
    const a = this.anchor;
    // A planned spot was chosen for its depth: who covers the visitor there,
    // and what hides a cropped edge. A pose that changes the silhouette's
    // height must not carry the visitor back through the wall behind them.
    if (a.fixed || !feet || !this.state.video) return a.depth;
    if (a.size === null) {
      a.size = size;
      a.footY = feet.y / cut.height;
    }
    // Size and ground contact should agree on approach/retreat. A crouch in
    // place changes the silhouette height without advancing the feet.
    const rate = Math.log2(Math.max(0.1, size / a.size));
    const travel = feet.y / cut.height - a.footY;
    const movement =
      Math.sign(rate) === Math.sign(travel)
        ? Math.sign(rate) * Math.min(Math.abs(rate) * 0.6, Math.abs(travel) * 2.3)
        : 0;
    const target = Math.max(0, Math.min(1, a.initialDepth + movement));
    a.depth += 0.28 * (target - a.depth);
    this.status(
      'Depth follows your floor position and apparent size. Drag the visitor to set a new starting point.'
    );
    return a.depth;
  }
}
