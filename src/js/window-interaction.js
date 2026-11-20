const DRAG_THRESHOLD = 6;
const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="slider"], [data-no-window-drag]';

function clientBox(element) {
  if (!element?.getClientRects().length) return null;
  const rect = element.getBoundingClientRect();
  const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
  const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
  const width = element.clientWidth * scaleX;
  const height = element.clientHeight * scaleY;
  if (width <= 0 || height <= 0) return null;
  return { x: rect.left + element.clientLeft * scaleX, y: rect.top + element.clientTop * scaleY, width, height };
}

const OVERLAY_SCROLLBAR_INSET = 12;

/** Overlay scrollbars may reserve zero layout pixels in WebView2. Keep one
 * shared hit area for native input routing and the drag exclusion in that case.
 */
export function getScrollbarRects(element) {
  if (!element?.getClientRects().length) return [];
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (style.scrollbarWidth === 'none') return [];
  const left = parseFloat(style.borderLeftWidth) || 0;
  const right = parseFloat(style.borderRightWidth) || 0;
  const top = parseFloat(style.borderTopWidth) || 0;
  const bottom = parseFloat(style.borderBottomWidth) || 0;
  const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
  const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
  const vertical = Math.max(0, element.offsetWidth - element.clientWidth - left - right);
  const horizontal = Math.max(0, element.offsetHeight - element.clientHeight - top - bottom);
  const scrolls = overflow => ['auto', 'scroll', 'overlay'].includes(overflow);
  const result = [];
  if (scrolls(style.overflowY || style.overflow) && element.scrollHeight > element.clientHeight + 1) {
    const width = Math.min(rect.width, (vertical || OVERLAY_SCROLLBAR_INSET) * scaleX);
    result.push({
      x: rect.right - right * scaleX - width, y: rect.top + top * scaleY, width,
      height: Math.max(0, rect.height - (top + bottom) * scaleY),
    });
  }
  if (scrolls(style.overflowX || style.overflow) && element.scrollWidth > element.clientWidth + 1) {
    const height = Math.min(rect.height, (horizontal || OVERLAY_SCROLLBAR_INSET) * scaleY);
    result.push({
      x: rect.left + left * scaleX, y: rect.bottom - bottom * scaleY - height,
      width: Math.max(0, rect.width - (left + right) * scaleX), height,
    });
  }
  return result.filter(area => area.width > 0 && area.height > 0);
}

function contains(rect, x, y) {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function subtract(rect, occupied) {
  const left = Math.max(rect.x, occupied.left);
  const top = Math.max(rect.y, occupied.top);
  const right = Math.min(rect.x + rect.width, occupied.right);
  const bottom = Math.min(rect.y + rect.height, occupied.bottom);
  if (left >= right || top >= bottom) return [rect];
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: top - rect.y },
    { x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom },
    { x: rect.x, y: top, width: left - rect.x, height: bottom - top },
    { x: right, y: top, width: rect.x + rect.width - right, height: bottom - top },
  ].filter(area => area.width > 0 && area.height > 0);
}

/** Visible empty space only: child content, borders and scrollbar gutters stay out.
 * Using current child rectangles also accounts for content moving through padding
 * when the pane scrolls; padding alone is not a reliable drag hit area.
 */
export function getBackgroundDragRects(element) {
  const box = clientBox(element);
  if (!box) return [];
  let areas = [box];
  for (const child of element.children) {
    if (!child.getClientRects().length) continue;
    if (child.hasAttribute('data-window-drag-ignore')
      && element.ownerDocument.defaultView.getComputedStyle(child).pointerEvents === 'none') continue;
    const rect = child.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    areas = areas.flatMap(area => subtract(area, rect));
  }
  for (const scrollbar of getScrollbarRects(element)) {
    const rect = { left: scrollbar.x, top: scrollbar.y, right: scrollbar.x + scrollbar.width, bottom: scrollbar.y + scrollbar.height };
    areas = areas.flatMap(area => subtract(area, rect));
  }
  return areas.filter(area => area.width >= 2 && area.height >= 2);
}

function hasSelection(doc) {
  const selection = doc.getSelection();
  return Boolean(selection && !selection.isCollapsed);
}

function dragSurface(event, doc) {
  const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  if (!target || target.closest(INTERACTIVE)) return null;
  const surface = target.closest('[data-window-drag]');
  if (!surface || surface.closest('[hidden], [inert]') || hasSelection(doc)) return null;
  if (surface.dataset.windowDrag === 'background') {
    // Only the surface itself is blank. Descendant response text remains selectable.
    if (target !== surface) return null;
    return getBackgroundDragRects(surface).some(rect => contains(rect, event.clientX, event.clientY)) ? surface : null;
  }
  if (surface.dataset.windowDrag !== 'handle') return null;
  const box = clientBox(surface);
  return box && contains(box, event.clientX, event.clientY) ? surface : null;
}

/** Delegate one native drag after deliberate mouse movement; never move the cursor
 * or synthesize window coordinates. Controls, text selection and scrollbars retain
 * normal browser behavior in both window modes.
 */
export function createWindowInteraction({ document: doc = document, startDrag, onError } = {}) {
  const view = doc.defaultView;
  let candidate = null;
  let activeDrag = null;
  let windowActive = true;
  let destroyed = false;

  function cancelCandidate() { candidate = null; }
  function resetGesture() {
    candidate = null;
    activeDrag = null;
    doc.documentElement.classList.remove('window-dragging');
  }
  function pointerDown(event) {
    cancelCandidate();
    if (destroyed || !windowActive || activeDrag || event.defaultPrevented || event.button !== 0 || event.buttons !== 1
      || event.isPrimary === false || (event.pointerType && event.pointerType !== 'mouse')
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const surface = dragSurface(event, doc);
    if (!surface) return;
    candidate = { surface, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.preventDefault();
  }
  function pointerMove(event) {
    if (!candidate || event.pointerId !== candidate.pointerId) return;
    if (event.buttons !== 1 || event.isPrimary === false || hasSelection(doc)
      || !candidate.surface.isConnected || candidate.surface.closest('[hidden], [inert]')) {
      cancelCandidate();
      return;
    }
    const dx = event.clientX - candidate.x;
    const dy = event.clientY - candidate.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
    const operation = { pointerId: candidate.pointerId };
    cancelCandidate();
    event.preventDefault();
    activeDrag = operation;
    doc.documentElement.classList.add('window-dragging');
    let result;
    try { result = startDrag?.(); }
    catch (error) { result = Promise.reject(error); }
    void Promise.resolve(result).catch(error => {
      if (!destroyed && activeDrag === operation) onError?.(error);
    }).finally(() => {
      // A reply from before minimize/blur must not unlock or overwrite a newer gesture.
      if (activeDrag === operation) {
        activeDrag = null;
        doc.documentElement.classList.remove('window-dragging');
      }
    });
  }
  function pointerEnd(event) {
    if (candidate?.pointerId === event.pointerId) cancelCandidate();
    if (activeDrag?.pointerId === event.pointerId) resetGesture();
  }

  doc.addEventListener('pointerdown', pointerDown, true);
  doc.addEventListener('pointermove', pointerMove, { capture: true, passive: false });
  doc.addEventListener('pointerup', pointerEnd, true);
  doc.addEventListener('pointercancel', pointerEnd, true);
  doc.addEventListener('lostpointercapture', pointerEnd, true);
  doc.addEventListener('visibilitychange', resetGesture);
  view?.addEventListener('blur', resetGesture);
  view?.addEventListener('pageshow', resetGesture);
  return {
    setActive(active) {
      if (destroyed) return;
      windowActive = active !== false;
      resetGesture();
    },
    destroy() {
      destroyed = true;
      resetGesture();
      doc.removeEventListener('pointerdown', pointerDown, true);
      doc.removeEventListener('pointermove', pointerMove, true);
      doc.removeEventListener('pointerup', pointerEnd, true);
      doc.removeEventListener('pointercancel', pointerEnd, true);
      doc.removeEventListener('lostpointercapture', pointerEnd, true);
      doc.removeEventListener('visibilitychange', resetGesture);
      view?.removeEventListener('blur', resetGesture);
      view?.removeEventListener('pageshow', resetGesture);
    },
  };
}
