import { getBackgroundDragRects, getScrollbarRects } from './window-interaction.js';
import { createOverlayGrowth } from './output-motion.js';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Pure sizing policy. Values use logical pixels, matching DOM rects and Tauri IPC. */
export function calculateOverlaySize({ mode = 'text', contentHeight = 100, availableWidth = 1440, availableHeight = 900, maxHeightPercent = 70, modalOpen = false } = {}) {
  const screenWidth = Math.max(1, Number(availableWidth) || 1440);
  const screenHeight = Math.max(1, Number(availableHeight) || 900);
  const split = mode !== 'text';
  const ratio = clamp(Number(maxHeightPercent) || 70, 40, 85) / 100;
  const width = Math.min(modalOpen ? 980 : split ? 1280 : 900, Math.floor(screenWidth * (split || modalOpen ? 0.94 : 0.9)));
  const maxHeight = Math.max(1, Math.min(split ? 820 : 760, Math.floor(screenHeight * ratio)));
  const desired = Math.max(144, Math.ceil(Number(contentHeight) || 144));
  const height = modalOpen ? Math.min(780, Math.floor(screenHeight * 0.94)) : Math.min(desired, maxHeight);
  return { width: Math.max(1, width), height: Math.max(1, height), maxHeight };
}

function visibleRect(element) {
  if (!element || element.getClientRects().length === 0) return null;
  const { x, y, width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function intersectRect(rect, bounds) {
  if (!rect || !bounds) return null;
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const width = Math.min(rect.x + rect.width, bounds.x + bounds.width) - x;
  const height = Math.min(rect.y + rect.height, bounds.y + bounds.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function createGeometrySync({ bridge, overlay, getSettings, isModalOpen }) {
  let stopped = false;
  let windowActive = true;
  let sizeFrame = null;
  let sizeEpoch = 0;
  let rectFrame;
  let lastSize = '';
  let lastRects = '';
  let rectEpoch = 0;
  let rectSequence = 0;
  let resizing = false;
  let resizeAgain = false;
  const byId = id => document.getElementById(id);
  const outputGrowth = createOverlayGrowth(overlay);

  async function syncRects() {
    if (stopped || !windowActive || !bridge.native || document.hidden || window.innerWidth <= 0 || window.innerHeight <= 0) return;
    const epoch = rectEpoch;
    const surface = intersectRect(visibleRect(overlay), {
      x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
    });
    const panelRect = id => intersectRect(visibleRect(byId(id)), surface);
    const text = panelRect('text-panel');
    const code = panelRect('code-panel');
    const notes = panelRect('notes-panel');
    const backgrounds = (id, bounds = panelRect(id)) => getBackgroundDragRects(byId(id))
      .map(rect => intersectRect(rect, bounds))
      .filter(rect => rect && rect.width >= 2 && rect.height >= 2);
    const rects = {
      toolbar: panelRect('toolbar'),
      drag: panelRect('drag-region'),
      // The inner text layout can exceed the animated viewport. Empty space is
      // draggable only where it is visible, never in the transparent envelope.
      dragAreas: [
        ...backgrounds('text-panel', text), ...backgrounds('text-layout', text),
        ...backgrounds('split-view'), ...backgrounds('notes-panel', notes),
      ].slice(0, 24),
      text, code, notes,
      // Native settings live in another window and cannot intercept this one.
      modal: null,
      scrollbars: getSettings().scrollLocked ? []
        : ['text-panel', 'code-panel', 'notes-panel'].flatMap(id =>
          getScrollbarRects(byId(id)).map(rect => intersectRect(rect, panelRect(id))).filter(Boolean)),
    };
    const signature = JSON.stringify(rects);
    if (signature === lastRects) return;
    const sequence = ++rectSequence;
    try {
      await bridge.updateHitRects(rects);
      if (!stopped && epoch === rectEpoch && sequence === rectSequence) lastRects = signature;
    } catch (error) {
      if (!stopped && epoch === rectEpoch) bridge.reportError(error);
    }
  }

  function requestRects() {
    if (!rectFrame && !stopped && windowActive && !document.hidden) rectFrame = requestAnimationFrame(() => {
      rectFrame = null;
      void syncRects();
    });
  }

  async function resize() {
    if (stopped || !windowActive || document.hidden || window.innerWidth <= 0 || window.innerHeight <= 0) return;
    if (resizing) { resizeAgain = true; return; }
    const modalOpen = !bridge.native && isModalOpen();
    const split = overlay.dataset.mode === 'code';
    const text = byId('text-panel');
    const code = byId('code-panel');
    const notes = byId('notes-panel');
    const toolbarHeight = byId('toolbar')?.getBoundingClientRect().height || 56;
    // Measure the normal layout box, not scrollable overflow: animated word
    // transforms can extend scrollHeight without changing the natural text size.
    const textHeight = byId('text-content')?.getBoundingClientRect().height ?? 0;
    const codeHeight = byId('code-content')?.querySelector('pre')?.scrollHeight || 64;
    const notesHeight = byId('notes-content')?.scrollHeight || 64;
    const verticalPadding = element => {
      if (!element) return 0;
      const css = getComputedStyle(element);
      return parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    };
    const headerHeight = document.querySelector('.code-header')?.getBoundingClientRect().height || 42;
    const splitPadding = verticalPadding(byId('split-view'));
    const paneHeight = split
      ? Math.max(codeHeight + verticalPadding(code) + headerHeight + 2, notesHeight + verticalPadding(notes) + 2) + splitPadding
      : textHeight + verticalPadding(text);
    const size = calculateOverlaySize({
      mode: split ? 'code' : 'text',
      contentHeight: paneHeight + toolbarHeight + 2,
      availableWidth: screen.availWidth || 1440,
      availableHeight: screen.availHeight || 900,
      maxHeightPercent: getSettings().maxHeightPercent,
      modalOpen,
    });
    if (bridge.native) {
      const heightValue = `${size.height}px`;
      const toolbarValue = `${toolbarHeight}px`;
      const capValue = String(size.height >= size.maxHeight);
      if (overlay.style.getPropertyValue('--output-target-height') !== heightValue
        || overlay.style.getPropertyValue('--output-toolbar-height') !== toolbarValue
        || overlay.dataset.outputAtCap !== capValue) {
        overlay.dispatchEvent(new overlay.ownerDocument.defaultView.Event('output:beforelayout'));
      }
      overlay.style.setProperty('--overlay-max-height', `${size.maxHeight}px`);
      // Layout uses the final content box while only the visual surface grows.
      // New text must not overflow a temporary animation-height scroll viewport.
      overlay.style.setProperty('--output-target-height', heightValue);
      overlay.style.setProperty('--output-toolbar-height', toolbarValue);
      overlay.dataset.outputLayout = 'target';
      overlay.dataset.outputAtCap = capValue;
      overlay.dispatchEvent(new overlay.ownerDocument.defaultView.Event('output:layout'));
      const signature = `${size.width}:${size.height}`;
      if (signature !== lastSize) {
        resizing = true;
        const epoch = sizeEpoch;
        const finishGrowth = outputGrowth.prepare(size.height, split ? 'code' : 'text');
        try {
          const result = await bridge.resize(size.width, size.height);
          if (stopped || epoch !== sizeEpoch || !windowActive || document.hidden || result?.applied === false) {
            finishGrowth(false);
            return;
          }
          lastSize = signature;
          finishGrowth();
        } catch (error) {
          finishGrowth(false);
          if (!stopped && epoch === sizeEpoch && windowActive && !document.hidden) bridge.reportError(error);
        } finally {
          resizing = false;
          if (resizeAgain) { resizeAgain = false; schedule(); }
        }
      }
    }
    requestRects();
  }

  function schedule() {
    if (stopped || !windowActive || document.hidden) {
      cancelAnimationFrame(sizeFrame);
      sizeFrame = null;
      return;
    }
    // Measure the latest render before the next paint. A timer here creates a
    // temporary overflow/scroll frame before the native envelope can grow.
    if (sizeFrame === null) sizeFrame = requestAnimationFrame(() => {
      sizeFrame = null;
      void resize();
    });
    requestRects();
  }

  function refreshViewport() {
    if (stopped) return;
    rectEpoch++;
    lastRects = '';
    cancelAnimationFrame(rectFrame);
    rectFrame = null;
    if (document.hidden) {
      sizeEpoch++;
      outputGrowth.cancel();
    }
    // Keep acknowledged lastSize: input-region restoration alone must not resize.
    schedule();
  }

  const observer = new ResizeObserver(entries => {
    // A visual height transition changes hit regions, not natural content size.
    // Observing it as new content would keep restarting the growth measurement.
    if (entries.some(entry => entry.target !== overlay)) schedule();
    else requestRects();
  });
  for (const id of ['overlay', 'text-content', 'code-content', 'notes-content']) {
    const element = byId(id);
    if (element) observer.observe(element);
  }
  const scrollSources = ['text-panel', 'code-panel', 'notes-panel'].map(byId).filter(Boolean);
  for (const panel of scrollSources) panel.addEventListener('scroll', requestRects, { passive: true });
  window.addEventListener('resize', refreshViewport);
  window.addEventListener('focus', refreshViewport);
  window.addEventListener('pageshow', refreshViewport);
  document.addEventListener('visibilitychange', refreshViewport);
  overlay.addEventListener('transitionend', requestRects);
  schedule();
  return {
    schedule,
    setActive(active) {
      const next = active !== false;
      if (windowActive !== next) sizeEpoch++;
      windowActive = next;
      if (!windowActive) outputGrowth.cancel();
      refreshViewport();
    },
    destroy() {
      stopped = true;
      rectEpoch++;
      sizeEpoch++;
      observer.disconnect();
      outputGrowth.destroy();
      cancelAnimationFrame(sizeFrame);
      cancelAnimationFrame(rectFrame);
      for (const panel of scrollSources) panel.removeEventListener('scroll', requestRects);
      window.removeEventListener('resize', refreshViewport);
      window.removeEventListener('focus', refreshViewport);
      window.removeEventListener('pageshow', refreshViewport);
      document.removeEventListener('visibilitychange', refreshViewport);
      overlay.removeEventListener('transitionend', requestRects);
    },
  };
}
