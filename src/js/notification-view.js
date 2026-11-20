/** Latest notification wins. Animation and expiry belong to this independent view. */
export function createNotificationView({
  element, text, applyTheme, onPresent = async () => {}, onDismissed = async () => {},
  measure = () => element.offsetHeight + 24,
  reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
} = {}) {
  let current = null;
  let epoch = 0;
  let timer;
  let exitTimer;
  let frame;
  let entryTimer;
  let finishExit;
  let destroyed = false;
  const requestFrame = element.ownerDocument.defaultView.requestAnimationFrame.bind(element.ownerDocument.defaultView);
  const cancelFrame = element.ownerDocument.defaultView.cancelAnimationFrame.bind(element.ownerDocument.defaultView);
  function clearPending() {
    clearTimeout(timer);
    clearTimeout(exitTimer);
    clearTimeout(entryTimer);
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    if (finishExit) { finishExit(); finishExit = null; }
  }
  async function hide({ id } = {}) {
    if (destroyed || !current || (id && id !== current.id)) return false;
    const closing = current.id;
    const generation = ++epoch;
    clearPending();
    element.dataset.phase = 'exiting';
    let resolveExit;
    await new Promise(resolve => {
      resolveExit = resolve;
      finishExit = resolve;
      exitTimer = setTimeout(resolve, reducedMotion() ? 0 : 200);
    });
    if (finishExit === resolveExit) finishExit = null;
    if (destroyed || epoch !== generation || current?.id !== closing) return false;
    current = null;
    element.hidden = true;
    element.dataset.phase = 'hidden';
    await onDismissed({ id: closing });
    return true;
  }
  async function show(notification) {
    if (destroyed || !notification || typeof notification.id !== 'string' || !notification.id) return false;
    const message = typeof notification.message === 'string' ? notification.message.trim() : '';
    if (!message) return false;
    const generation = ++epoch;
    clearPending();
    current = { ...notification, timeout: Math.max(500, Math.min(30000, Number(notification.timeout) || 2800)) };
    applyTheme?.(notification.theme || {});
    text.textContent = [...message].slice(0, 2000).join('');
    element.dataset.id = notification.id;
    element.dataset.kind = notification.kind === 'error' ? 'error' : 'info';
    element.dataset.phase = 'entering';
    element.hidden = false;
    try {
      const presented = await onPresent({ id: notification.id, height: Math.max(64, Math.min(200, Math.ceil(measure()))) });
      if (destroyed || epoch !== generation || current?.id !== notification.id) return false;
      if (presented === false || presented?.shown === false) {
        current = null;
        element.hidden = true;
        element.dataset.phase = 'hidden';
        return false;
      }
      const enter = () => {
        clearTimeout(entryTimer);
        if (frame !== undefined) cancelFrame(frame);
        frame = undefined;
        if (destroyed || epoch !== generation) return;
        element.dataset.phase = 'visible';
        timer = setTimeout(() => { void hide({ id: notification.id }).catch(() => {}); }, current.timeout);
      };
      frame = requestFrame(enter);
      entryTimer = setTimeout(enter, 80);
      return true;
    } catch (error) {
      if (epoch === generation) {
        current = null;
        element.hidden = true;
        element.dataset.phase = 'hidden';
      }
      throw error;
    }
  }
  async function updateTheme(theme) {
    if (destroyed) return;
    applyTheme?.(theme || {});
    if (!current || element.dataset.phase === 'exiting') return;
    await onPresent({ id: current.id, height: Math.max(64, Math.min(200, Math.ceil(measure()))) });
  }
  return {
    show, hide, updateTheme,
    destroy() { destroyed = true; ++epoch; current = null; clearPending(); element.hidden = true; element.dataset.phase = 'hidden'; },
  };
}
