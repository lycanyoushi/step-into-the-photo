// Present the existing canvas. Keeping the node and its context alive preserves
// the camera stream, segmentation history, depth anchor and frame callbacks.
export function setupAudience({ picture, canvas, onExit }) {
  const room = document.createElement('dialog');
  room.className = 'audience-room';
  room.setAttribute('aria-label', 'Live photograph');
  document.body.append(room);

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'audience-return';
  back.textContent = 'Back to setup';
  back.title = 'Back to setup (Esc)';
  back.onclick = () => exit();

  let session = null;
  let timer;
  function wakeControls() {
    if (!session) return;
    clearTimeout(timer);
    picture.classList.add('audience-awake');
    timer = setTimeout(() => picture.classList.remove('audience-awake'), 2200);
  }

  function finish() {
    if (!session) return;
    const { marker, trigger, wasInert, tabIndex } = session;
    session = null;
    clearTimeout(timer);
    picture.classList.remove('audience-picture', 'audience-awake');
    back.remove();
    if (tabIndex === null) picture.removeAttribute('tabindex');
    else picture.setAttribute('tabindex', tabIndex);
    canvas.inert = wasInert;
    marker.replaceWith(picture);
    if (room.open) room.close();
    onExit?.();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function leaveOwnedFullscreen() {
    if (document.fullscreenElement === picture && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function exit() {
    if (!session) return;
    if (session.requested) leaveOwnedFullscreen();
    finish();
  }

  function enter() {
    if (session) return;
    const marker = document.createComment('studio picture');
    const entry = {
      marker,
      trigger: document.activeElement,
      wasInert: canvas.inert,
      tabIndex: picture.getAttribute('tabindex'),
      requested: false,
      fullscreen: false
    };
    session = entry;
    picture.before(marker);
    room.append(picture);
    picture.classList.add('audience-picture');
    picture.tabIndex = -1;
    canvas.inert = true;
    picture.append(back);
    room.showModal();
    picture.focus({ preventScroll: true });
    wakeControls();

    // The modal already fills the viewport on browsers without fullscreen or
    // embedded contexts where the browser denies it. Request while the launch
    // button's user activation is still available.
    if (!document.fullscreenElement && document.fullscreenEnabled && picture.requestFullscreen) {
      entry.requested = true;
      try {
        Promise.resolve(picture.requestFullscreen())
          .then(() => {
            if (!session) leaveOwnedFullscreen();
            else if (session === entry && document.fullscreenElement === picture) entry.fullscreen = true;
          })
          .catch(() => {});
      } catch {
        // A browser may reject synchronously. The viewport presentation is ready.
      }
    }
  }

  picture.addEventListener('pointermove', wakeControls);
  picture.addEventListener('pointerdown', wakeControls);
  picture.addEventListener('focusin', wakeControls);
  room.addEventListener('keydown', (event) => {
    if (!session) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      exit();
    } else wakeControls();
  });
  room.addEventListener('cancel', (event) => {
    event.preventDefault();
    exit();
  });
  document.addEventListener('fullscreenchange', () => {
    if (!session || !session.requested) return;
    if (document.fullscreenElement === picture) session.fullscreen = true;
    else if (session.fullscreen) finish();
  });

  return {
    enter,
    exit,
    get active() {
      return session !== null;
    }
  };
}
