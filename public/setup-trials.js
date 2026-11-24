// The evaluation timer starts on an explicit operator action. Normal editing
// can take any amount of time before the trial begins.
export function setupTrials(metrics) {
  const el = (id) => document.getElementById(id);
  const codes = new WeakMap();
  let trial = null,
    latest = null,
    startTime = 0,
    currentScene = null;
  const elapsed = () => Math.round(performance.now() - startTime);
  const code = (prefix) => prefix + '-' + crypto.randomUUID().slice(0, 6);

  function setScene(scene) {
    if (currentScene === scene) return;
    if (currentScene) codes.set(currentScene, el('trial-scene').value.trim());
    stop('Scene changed');
    currentScene = scene;
    if (!codes.has(scene)) codes.set(scene, code('S'));
    el('trial-scene').value = codes.get(scene);
  }
  function finish(message) {
    trial = null;
    el('trial-start').textContent = 'Start timed setup';
    el('trial-stop').hidden = true;
    el('trial-state').textContent = message;
  }
  function stop(reason = 'Stopped by operator') {
    if (!trial) return;
    Object.assign(trial, { outcome: 'interrupted', stopReason: reason, stoppedAtMs: elapsed() });
    finish('Trial interrupted. Its measurements are in the session export.');
  }
  function bind(reset) {
    el('trial-participant').value = code('P');
    el('trial-stop').onclick = () => stop();
    el('trial-note').oninput = () => {
      if (latest) latest.helpNote = el('trial-note').value.trim();
    };
    el('trial-start').onclick = () => {
      const participantId = el('trial-participant').value.trim(),
        sceneId = el('trial-scene').value.trim();
      if (!participantId || !sceneId) {
        el('trial-state').textContent = 'Enter an anonymous participant code and scene code.';
        return;
      }
      stop('Restarted by operator');
      const method = el('trial-method').value;
      latest = trial = {
        kind: 'timed setup',
        id: crypto.randomUUID(),
        participantId,
        sceneId,
        assignedMethod: method,
        startedAt: new Date().toISOString(),
        firstOutlineMs: null,
        firstAppliedMs: null,
        timeToSavedPoseMs: null,
        afterOutlineMs: null,
        placementMs: null,
        corrections: 0,
        correctionLog: [],
        helpNote: '',
        outcome: 'running'
      };
      el('trial-note').value = '';
      el('trial-start').textContent = 'Restart timed setup';
      el('trial-stop').hidden = false;
      el('trial-state').textContent =
        'Timing setup. Apply an outline, position the visitor, then choose Save photo.';
      metrics.push(trial);
      startTime = performance.now();
      try {
        reset();
      } catch (error) {
        stop(error.message);
        el('trial-state').textContent = error.message;
      }
    };
  }
  function correction(action) {
    if (!trial) return;
    trial.corrections++;
    trial.correctionLog.push({ action, atMs: elapsed() });
  }
  function outline(method, segmenter) {
    if (!trial) return;
    if (trial.firstOutlineMs !== null) {
      correction('New ' + (method === 'trace' ? 'hand trace' : 'one-tap outline'));
      return;
    }
    if (method !== trial.assignedMethod) return;
    trial.firstOutlineMs = elapsed();
    trial.outlineMethod = segmenter;
  }
  function applied(nonempty) {
    if (!trial || !nonempty || trial.firstOutlineMs === null || trial.firstAppliedMs !== null) return;
    trial.firstAppliedMs = elapsed();
    el('trial-state').textContent = 'Outline applied. Position the visitor and choose Save photo.';
  }
  function saved(canFinish, action = 'photo') {
    if (!trial || !canFinish || trial.firstAppliedMs === null) return;
    trial.timeToSavedPoseMs = elapsed();
    trial.afterOutlineMs = trial.timeToSavedPoseMs - trial.firstOutlineMs;
    trial.placementMs = trial.timeToSavedPoseMs - trial.firstAppliedMs;
    trial.outcome = 'saved';
    trial.savedAs = action;
    finish('Trial saved. Add any help received in the note, then export session measurements.');
  }
  return {
    bind,
    setScene,
    stop,
    correction,
    outline,
    applied,
    saved,
    firstMethod: () => (trial && trial.firstOutlineMs === null ? trial.assignedMethod : null)
  };
}
