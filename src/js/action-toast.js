import { normalizeSettings, applyTheme } from './settings.js';
import { createNotificationView } from './notification-view.js';

/** Native notifications live in a separate non-focusing window. Browser preview
 * uses the same renderer at the viewport corner, outside the assistant panel. */
export function createActionToast({
  announcer, isEnabled = () => true, duration = 2800, getBridge = () => null,
  getTheme = () => ({}), document = globalThis.document,
} = {}) {
  let currentId = null;
  let queue = Promise.resolve();
  let preview;
  let previewElement;
  let destroyed = false;
  let sequence = 0;
  function theme() {
    const { panelColor, textColor, accentColor, opacity, fontSize } = normalizeSettings(getTheme());
    return { panelColor, textColor, accentColor, opacity, fontSize };
  }
  function send(name, args, guard = () => true) {
    queue = queue.then(async () => {
      const bridge = getBridge();
      if (bridge?.native && guard()) await bridge.command(name, args);
    }).catch(() => {
      if (!destroyed && announcer) announcer.textContent = 'Не удалось обновить уведомление.';
    });
  }
  function fallback() {
    if (preview) return preview;
    previewElement = document.createElement('div');
    previewElement.id = 'action-toast';
    previewElement.className = 'notification-card notification-preview';
    previewElement.hidden = true;
    previewElement.dataset.phase = 'hidden';
    previewElement.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'notification-message';
    previewElement.append(text);
    document.body.append(previewElement);
    preview = createNotificationView({
      element: previewElement, text, applyTheme: value => applyTheme(value, previewElement),
    });
    return preview;
  }
  function dismiss() {
    currentId = null;
    if (getBridge()?.native) send('notification_hide', {});
    else void preview?.hide().catch(() => {});
  }
  return {
    show(message, { kind = 'info', timeout = duration } = {}) {
      if (destroyed || !isEnabled()) return false;
      const value = [...String(message || '').replace(/\s+/g, ' ').trim()].slice(0, 2000).join('');
      if (!value) return false;
      const bridge = getBridge();
      if (!bridge) return false;
      const id = 'notice-' + (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + (++sequence));
      currentId = id;
      const notification = { id, message: value, kind: kind === 'error' ? 'error' : 'info',
        timeout: Math.max(500, Math.min(30000, Number(timeout) || duration)), theme: theme() };
      if (bridge.native) send('notification_show', { notification }, () => !destroyed && isEnabled() && currentId === id);
      else void fallback().show(notification).catch(() => {});
      if (announcer) announcer.textContent = value;
      return true;
    },
    dismiss,
    updateTheme() {
      if (destroyed) return;
      if (getBridge()?.native) send('notification_theme', { theme: theme() }, () => !destroyed);
      else void preview?.updateTheme(theme()).catch(() => {});
    },
    // Kept for callers from older embedded previews; main activity cannot hide a
    // native notification, which must also survive minimize and settings focus.
    setVisible() {},
    destroy() { if (destroyed) return; dismiss(); destroyed = true; preview?.destroy(); previewElement?.remove(); },
  };
}
