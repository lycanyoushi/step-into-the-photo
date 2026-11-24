import { icons } from './ui.js';

icons();
const grid = document.getElementById('family-grid');
const elem = (name, cls, text) => {
  const node = document.createElement(name);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

function card(item) {
  const article = elem('article', 'family-card');
  article.id = item.id;
  const stage = elem('div', 'family-image');
  const photograph = new Image();
  photograph.src = item.image;
  photograph.alt = item.title;
  const clip = elem('video');
  clip.controls = true;
  clip.hidden = true;
  clip.loop = clip.muted = clip.playsInline = true;
  clip.preload = 'none';
  clip.src = './families/demos/' + item.id + '.mp4';
  clip.setAttribute('aria-label', item.title + ' with a moving visitor');
  stage.append(photograph, clip);
  const caption = elem('div', 'family-caption');
  const credit = elem('p');
  const original = elem('a', '', item.credit);
  original.href = item.url;
  const rights = elem('a', '', item.rights);
  rights.href = item.rightsUrl || item.url;
  credit.append(original, ' · ', rights);
  const actions = elem('div', 'family-actions');
  const toggle = elem('button', 'primary', 'Play example');
  toggle.onclick = async () => {
    const showClip = clip.hidden;
    clip.hidden = !showClip;
    photograph.hidden = showClip;
    toggle.textContent = showClip ? 'Show original' : 'Play example';
    if (showClip) {
      for (const other of grid.querySelectorAll('video')) if (other !== clip) other.pause();
      try {
        await clip.play();
      } catch {
        /* Native controls also provide manual playback. */
      }
    } else clip.pause();
  };
  const link = elem('a', '', 'Open in studio');
  link.href = './?family=' + encodeURIComponent(item.id);
  const live = elem('a', '', 'Use my camera');
  live.href = './?live=1&family=' + encodeURIComponent(item.id);
  actions.append(toggle, live, link);
  caption.append(elem('h2', '', item.title), credit, actions);
  article.append(stage, caption);
  return article;
}

try {
  const response = await fetch('./families/scenes.json');
  if (!response.ok) throw Error('Family photographs could not be loaded.');
  for (const item of await response.json()) grid.append(card(item));
} catch (err) {
  grid.textContent = err.message;
}
