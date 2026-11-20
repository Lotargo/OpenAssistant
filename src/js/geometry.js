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

export function createGeometrySync({ bridge, overlay, getSettings, isModalOpen }) {
  let stopped = false;
  let windowActive = true;
  let timer = null;
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
    const rects = {
      toolbar: visibleRect(byId('toolbar')),
      drag: visibleRect(byId('drag-region')),
      dragAreas: ['text-panel', 'split-view', 'notes-panel']
        .flatMap(id => getBackgroundDragRects(byId(id))).slice(0, 24),
      text: visibleRect(byId('text-panel')),
      code: visibleRect(byId('code-panel')),
      notes: visibleRect(byId('notes-panel')),
      // Native settings live in another window and cannot intercept this one.
      modal: null,
      scrollbars: getSettings().scrollLocked ? []
        : ['text-panel', 'code-panel', 'notes-panel'].flatMap(id => getScrollbarRects(byId(id))),
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
    // scrollHeight includes the pane's padding; use the content's natural height,
    // never the current window height, to avoid a resize feedback loop.
    const textHeight = byId('text-content')?.scrollHeight ?? 0;
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
      overlay.style.setProperty('--overlay-max-height', `${size.maxHeight}px`);
      const signature = `${size.width}:${size.height}`;
      if (signature !== lastSize) {
        resizing = true;
        const finishGrowth = outputGrowth.prepare(size.height, split ? 'code' : 'text');
        try {
          await bridge.resize(size.width, size.height);
          lastSize = signature;
          finishGrowth();
        } catch (error) {
          finishGrowth(false);
          bridge.reportError(error);
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
      clearTimeout(timer);
      timer = null;
      return;
    }
    // Throttle rather than debounce: a continuous 70ms stream must still grow
    // before it ends, with the latest natural content height at each resize.
    if (timer === null) timer = setTimeout(() => {
      timer = null;
      void resize();
    }, 90);
    requestRects();
  }

  function refreshViewport() {
    if (stopped) return;
    rectEpoch++;
    lastRects = '';
    cancelAnimationFrame(rectFrame);
    rectFrame = null;
    // Keep lastSize: restoring input regions must not overwrite a user's window size.
    schedule();
  }

  const observer = new ResizeObserver(schedule);
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
      windowActive = active !== false;
      if (!windowActive) outputGrowth.cancel();
      refreshViewport();
    },
    destroy() {
      stopped = true;
      rectEpoch++;
      observer.disconnect();
      outputGrowth.destroy();
      clearTimeout(timer);
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
