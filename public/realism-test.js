const pair = document.getElementById('realism-pair');
const result = document.getElementById('realism-result');
const method = document.getElementById('realism-method');
const original = Math.random() < 0.5 ? 0 : 1;
const names = ['A', 'B'];

for (const [i, name] of names.entries()) {
  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = true;
  const image = new Image();
  image.alt = 'Photograph ' + name + ', showing Jemison among the crew.';
  const caption = document.createElement('span');
  caption.textContent = 'Choose ' + name + ' as the original';
  button.append(image, caption);
  pair.append(button);
  image.onload = () => {
    if (
      [...pair.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth) &&
      pair.children.length === 2
    ) {
      for (const choice of pair.children) choice.disabled = false;
    }
  };
  image.onerror = () => {
    result.textContent = 'A comparison image could not be loaded. Reload to try again.';
  };
  image.src = './demo/realism-' + (i === original ? 'original' : 'blended') + '.jpg';
  button.onclick = () => {
    for (const [index, choice] of [...pair.children].entries()) {
      choice.disabled = true;
      choice.querySelector('span').textContent =
        names[index] + (index === original ? ' · Original photograph' : ' · Studio insertion');
    }
    result.textContent =
      (i === original ? 'You picked the original. ' : 'You picked the studio insertion. ') +
      'Photograph ' +
      names[original] +
      ' is the original exposure.';
    method.hidden = false;
  };
}
