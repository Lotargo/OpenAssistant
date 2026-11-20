const REVEAL_DURATION = 180;
const reducedMotion = view => view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

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
      ], { duration: REVEAL_DURATION, easing: 'ease-out' });
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

/** Smooth only visible prose words, with bounded work and no container transform. */
export function createWordMotion(root) {
  const document = root.ownerDocument;
  const view = document.defaultView;
  const panel = root.closest('[data-scroll-panel]') || root.parentElement;
  const motions = new Map();
  let destroyed = false;
  function cancel() {
    for (const animation of motions.values()) animation.cancel();
    motions.clear();
    delete root.dataset.outputMoving;
  }
  function visibleWords() {
    if (destroyed || document.hidden || reducedMotion(view)) return [];
    const viewport = panel.getBoundingClientRect();
    if (viewport.width <= 0 || viewport.height <= 0) return [];
    const result = [];
    let blocks = 0, inspected = 0;
    // Only the tail can be reflowed by an append. Do not scan a huge response.
    for (let block = root.lastElementChild; block && blocks < 3; block = block.previousElementSibling) {
      if (!block.matches('.output-prose')) continue;
      blocks++;
      const box = block.getBoundingClientRect();
      if (box.bottom < viewport.top || box.top > viewport.bottom) continue;
      const words = block.querySelectorAll('.output-word');
      for (let index = words.length - 1; index >= 0 && inspected < 256 && result.length < 128; index--) {
        inspected++;
        const node = words[index], rect = node.getBoundingClientRect();
        if (rect.bottom < viewport.top) break;
        if (rect.top <= viewport.bottom && rect.right >= viewport.left && rect.left <= viewport.right) result.push({ node, rect });
      }
      if (inspected >= 256 || result.length >= 128) break;
    }
    return result;
  }
  function capture() {
    return new Map(visibleWords().map(({ node, rect }) => [node, rect]));
  }
  function play(before) {
    cancel();
    if (destroyed || !before?.size || document.hidden || reducedMotion(view)) return;
    const words = visibleWords();
    const offsets = [];
    const entries = words.map(({ node, rect }) => {
      const old = before.get(node);
      if (!old) return { node, rect, fresh: true };
      let x = old.left - rect.left, y = old.top - rect.top;
      const crossedLine = Math.abs(y) > Math.max(8, rect.height * .6) && Math.abs(x) > 48;
      if (crossedLine) {
        // A wrapped word must not fly from one edge to the other.
        x = clamp(x, -18, 18);
        y = clamp(y, -8, 8);
      } else {
        x = clamp(x, -160, 160);
        y = clamp(y, -80, 80);
        offsets.push({ top: rect.top, x, y });
      }
      return { node, rect, x, y, crossedLine };
    });
    for (const entry of entries) {
      const { node, rect, fresh, crossedLine } = entry;
      if (typeof node.animate !== 'function') continue;
      const line = fresh ? offsets.find(offset => Math.abs(offset.top - rect.top) < 2) : null;
      const x = fresh ? line?.x || 0 : entry.x;
      const y = fresh ? line?.y || 0 : entry.y;
      if (!fresh && Math.abs(x) < .3 && Math.abs(y) < .3) continue;
      const duration = clamp(Math.hypot(x, y) / .5, 100, 240);
      const start = { transform: 'translate(' + x + 'px,' + y + 'px)' };
      if (fresh) start.opacity = 0;
      else if (crossedLine) start.opacity = .7;
      const animation = node.animate([start, { transform: 'translate(0px,0px)', opacity: 1 }], { duration, easing: 'linear' });
      motions.set(node, animation);
      root.dataset.outputMoving = 'true';
      const finish = () => {
        if (motions.get(node) === animation) motions.delete(node);
        if (!motions.size) delete root.dataset.outputMoving;
      };
      void animation.finished.then(finish, finish);
    }
  }
  const onVisibility = () => { if (document.hidden) cancel(); };
  document.addEventListener('visibilitychange', onVisibility);
  return {
    capture, play, cancel,
    destroy() {
      destroyed = true;
      cancel();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/** Animate only automatic following; user scrolling always takes ownership. */
export function createScrollFollow(panel, onInterrupt = () => {}) {
  const document = panel.ownerDocument;
  const view = document.defaultView;
  let frame = null, target = null, from = 0, started = 0, duration = 0;
  let lastWritten = panel.scrollTop;
  let writes = 0;
  function cancel() {
    if (frame !== null) view.cancelAnimationFrame?.(frame);
    frame = null;
    target = null;
    delete panel.dataset.outputFollowing;
  }
  function write(top) {
    panel.scrollTop = top;
    lastWritten = panel.scrollTop;
    writes++;
  }
  function interrupt() {
    cancel();
    onInterrupt();
  }
  function tick(now) {
    frame = null;
    if (target === null) return;
    if (document.hidden) { cancel(); return; }
    if (Math.abs(panel.scrollTop - lastWritten) > 2) { interrupt(); return; }
    const progress = reducedMotion(view) ? 1 : Math.min(1, (now - started) / duration);
    write(from + (target - from) * progress);
    if (progress === 1) { cancel(); return; }
    frame = view.requestAnimationFrame(tick);
  }
  function follow(top) {
    const next = Math.max(0, Number(top) || 0);
    if (target !== null && Math.abs(panel.scrollTop - lastWritten) > 2) { interrupt(); return; }
    const current = panel.scrollTop;
    cancel();
    if (document.hidden || reducedMotion(view) || !view.requestAnimationFrame || Math.abs(next - current) <= 1) {
      write(next);
      return;
    }
    from = current;
    target = next;
    lastWritten = current;
    started = view.performance.now();
    duration = clamp(Math.abs(next - current) / .6, 100, 300);
    panel.dataset.outputFollowing = 'true';
    frame = view.requestAnimationFrame(tick);
  }
  const onScroll = () => {
    if (target !== null && Math.abs(panel.scrollTop - lastWritten) > 2) interrupt();
  };
  const onVisibility = () => { if (document.hidden) cancel(); };
  panel.addEventListener('scroll', onScroll, { passive: true });
  panel.addEventListener('wheel', interrupt, { passive: true });
  panel.addEventListener('touchstart', interrupt, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  return {
    follow, cancel, interrupt,
    get active() { return target !== null && Math.abs(panel.scrollTop - lastWritten) <= 2; },
    get revision() { return writes; },
    ownsPositionSince(revision) { return writes > revision && Math.abs(panel.scrollTop - lastWritten) <= 2; },
    destroy() {
      cancel();
      panel.removeEventListener('scroll', onScroll);
      panel.removeEventListener('wheel', interrupt);
      panel.removeEventListener('touchstart', interrupt);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/** One CSS visual-height transition; later targets retarget it without freezing. */
export function createOverlayGrowth(overlay) {
  const view = overlay.ownerDocument?.defaultView;
  let generation = 0;
  let cleanupTimer = null;
  let pinned = false;
  let lastTarget = 0;
  function clearHeight() {
    overlay.dataset.outputSizing = 'frozen';
    overlay.style.removeProperty('--output-height');
    delete overlay.dataset.outputGrowing;
    overlay.getBoundingClientRect();
    delete overlay.dataset.outputSizing;
    pinned = false;
  }
  function cancel() {
    generation++;
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
    lastTarget = 0;
    clearHeight();
  }
  return {
    prepare(height, mode = 'text') {
      const previous = overlay.getBoundingClientRect().height;
      const target = Number(height);
      const grow = mode === 'text' && Number.isFinite(target)
        && target > previous + 1 && target >= lastTarget && !reducedMotion(view);
      const current = ++generation;
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
      lastTarget = target;
      if (!grow) {
        clearHeight();
        overlay.dataset.outputSizing = 'frozen';
      } else if (!pinned) {
        overlay.dataset.outputSizing = 'frozen';
        overlay.style.setProperty('--output-height', previous + 'px');
        overlay.getBoundingClientRect();
        pinned = true;
      }
      return (success = true) => {
        if (current !== generation) return;
        if (!success) { lastTarget = 0; clearHeight(); return; }
        if (!grow) { clearHeight(); return; }
        delete overlay.dataset.outputSizing;
        overlay.dataset.outputGrowing = 'true';
        overlay.style.setProperty('--output-height', target + 'px');
        cleanupTimer = setTimeout(() => {
          if (current === generation) clearHeight();
          cleanupTimer = null;
        }, REVEAL_DURATION + 60);
      };
    },
    cancel,
    destroy: cancel,
  };
}
