import { getBackgroundDragRects, getScrollbarRects } from './window-interaction.js';

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
  let timer;
  let rectFrame;
  let lastSize = '';
  let lastRects = '';
  let resizing = false;
  let resizeAgain = false;
  const byId = id => document.getElementById(id);

  async function syncRects() {
    if (stopped || !bridge.native) return;
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
    try {
      await bridge.updateHitRects(rects);
      lastRects = signature;
    } catch (error) {
      bridge.reportError(error);
    }
  }

  function requestRects() {
    if (!rectFrame && !stopped) rectFrame = requestAnimationFrame(() => {
      rectFrame = null;
      void syncRects();
    });
  }

  async function resize() {
    if (stopped) return;
    if (resizing) { resizeAgain = true; return; }
    const modalOpen = !bridge.native && isModalOpen();
    const split = overlay.dataset.mode === 'code';
    const text = byId('text-panel');
    const code = byId('code-panel');
    const notes = byId('notes-panel');
    const toolbarHeight = byId('toolbar')?.getBoundingClientRect().height || 56;
    // scrollHeight includes the pane's padding; use the content's natural height,
    // never the current window height, to avoid a resize feedback loop.
    const textHeight = byId('text-content')?.scrollHeight || 64;
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
        try {
          await bridge.resize(size.width, size.height);
          lastSize = signature;
        } catch (error) {
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
    clearTimeout(timer);
    timer = setTimeout(() => void resize(), 90);
    requestRects();
  }

  const observer = new ResizeObserver(schedule);
  for (const id of ['overlay', 'text-content', 'code-content', 'notes-content']) {
    const element = byId(id);
    if (element) observer.observe(element);
  }
  const scrollSources = ['text-panel', 'code-panel', 'notes-panel'].map(byId).filter(Boolean);
  for (const panel of scrollSources) panel.addEventListener('scroll', requestRects, { passive: true });
  window.addEventListener('resize', schedule);
  overlay.addEventListener('transitionend', requestRects);
  schedule();
  return {
    schedule,
    destroy() {
      stopped = true;
      observer.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(rectFrame);
      for (const panel of scrollSources) panel.removeEventListener('scroll', requestRects);
      window.removeEventListener('resize', schedule);
      overlay.removeEventListener('transitionend', requestRects);
    },
  };
}
