import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { applyTheme } from './settings.js';
import { createNotificationView } from './notification-view.js';

const element = document.getElementById('notification-card');
const view = createNotificationView({
  element, text: document.getElementById('notification-message'), applyTheme,
  onPresent: args => invoke('notification_present', args),
  onDismissed: args => invoke('notification_dismissed', args),
});
const unlisteners = [];
let received = 0;
let latestTheme = null;
let disposed = false;
function failure(error) {
  console.error('Notification view:', error);
  if (!disposed) document.documentElement.dataset.ready = 'error';
}
async function start() {
  const options = { target: { kind: 'WebviewWindow', label: 'notification' } };
  unlisteners.push(await listen('notification:update', event => {
    ++received;
    void view.show(event.payload).catch(failure);
  }, options));
  unlisteners.push(await listen('notification:hide', event => {
    ++received;
    void view.hide(event.payload || {}).catch(failure);
  }, options));
  unlisteners.push(await listen('notification:theme', event => {
    latestTheme = event.payload?.theme || null;
    void view.updateTheme(latestTheme).catch(failure);
  }, options));
  const before = received;
  const snapshot = await invoke('notification_ready');
  if (disposed) return;
  if (received === before && snapshot?.notification) await view.show({ ...snapshot.notification, ...(latestTheme ? { theme: latestTheme } : {}) });
  document.documentElement.dataset.ready = 'true';
}
window.addEventListener('pagehide', () => {
  disposed = true;
  view.destroy();
  for (const unlisten of unlisteners.splice(0)) unlisten();
});
void start().catch(failure);
