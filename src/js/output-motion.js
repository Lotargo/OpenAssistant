const DURATION = 180;
const reducedMotion = view => view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Reveal once per response. Growing text never restarts the animation. */
export function createOutputReveal(element) {
  const view = element.ownerDocument?.defaultView;
  let animation = null;
  let generation = 0;
  function cancel() {
    generation++;
    animation?.cancel();
    animation = null;
    delete element.dataset.outputEntering;
  }
  return {
    start() {
      cancel();
      if (reducedMotion(view) || typeof element.animate !== 'function') return;
      const current = generation;
      element.dataset.outputEntering = 'true';
      animation = element.animate([
        { opacity: 0, clipPath: 'inset(45% 35% round 4px)' },
        { opacity: 1, clipPath: 'inset(0% 0% round 0px)' },
      ], { duration: DURATION, easing: 'ease-out' });
      const finish = () => {
        if (current !== generation) return;
        animation = null;
        delete element.dataset.outputEntering;
      };
      void animation.finished.then(finish, finish);
    },
    cancel,
    destroy: cancel,
  };
}

/** Animate the visual surface after one native resize, never one IPC per frame. */
export function createOverlayGrowth(overlay) {
  const view = overlay.ownerDocument?.defaultView;
  let generation = 0;
  let cleanupTimer = null;
  function clearHeight() {
    overlay.dataset.outputSizing = 'frozen';
    overlay.style.removeProperty('--output-height');
    delete overlay.dataset.outputGrowing;
    // Clearing an interrupted growth must not animate a shrink or a restore.
    overlay.getBoundingClientRect();
    delete overlay.dataset.outputSizing;
  }
  function cancel() {
    generation++;
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
    clearHeight();
  }
  return {
    prepare(height, mode = 'text') {
      const previous = overlay.getBoundingClientRect().height;
      const target = Number(height);
      const grow = mode === 'text' && Number.isFinite(target)
        && target > previous + 1 && !reducedMotion(view);
      const current = ++generation;
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
      overlay.dataset.outputSizing = 'frozen';
      delete overlay.dataset.outputGrowing;
      if (grow) overlay.style.setProperty('--output-height', previous + 'px');
      else overlay.style.removeProperty('--output-height');
      overlay.getBoundingClientRect();
      return (success = true) => {
        if (current !== generation) return;
        if (!success || !grow) { clearHeight(); return; }
        delete overlay.dataset.outputSizing;
        overlay.dataset.outputGrowing = 'true';
        overlay.style.setProperty('--output-height', target + 'px');
        cleanupTimer = setTimeout(() => {
          if (current === generation) clearHeight();
          cleanupTimer = null;
        }, DURATION + 40);
      };
    },
    cancel,
    destroy: cancel,
  };
}
