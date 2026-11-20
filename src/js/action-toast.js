/** Brief in-window messages share the overlay's theme and capture protection.
 * No native notification, extra window or change to content geometry is needed.
 */
export function createActionToast({ element, overlay, toolbar, announcer, isEnabled = () => true, duration = 2800 } = {}) {
  let timer;
  let visible = true;
  let destroyed = false;
  const text = element.querySelector('.action-toast-message');
  function layout() {
    if (destroyed) return;
    const toolbarHeight = toolbar.getBoundingClientRect().height || 56;
    const available = overlay.getBoundingClientRect().height - toolbarHeight - 12;
    element.style.bottom = (toolbarHeight + 6) + 'px';
    element.style.setProperty('--toast-lines', available >= 50 ? '2' : '1');
  }
  function dismiss() {
    clearTimeout(timer);
    element.dataset.visible = 'false';
    element.hidden = true;
  }
  const Resize = overlay.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
  const observer = Resize ? new Resize(layout) : null;
  observer?.observe(overlay);
  observer?.observe(toolbar);
  return {
    show(message, { kind = 'info', timeout = duration } = {}) {
      if (destroyed || !visible || !isEnabled()) return false;
      const value = String(message || '').replace(/\s+/g, ' ').trim();
      if (!value) return false;
      clearTimeout(timer);
      text.textContent = value;
      element.dataset.kind = kind;
      layout();
      element.hidden = false;
      element.dataset.visible = 'true';
      if (announcer) announcer.textContent = value;
      timer = setTimeout(dismiss, Math.max(1000, Math.min(10000, timeout)));
      return true;
    },
    dismiss,
    setVisible(active) { visible = active !== false; if (!visible) dismiss(); },
    destroy() { destroyed = true; dismiss(); observer?.disconnect(); },
  };
}
