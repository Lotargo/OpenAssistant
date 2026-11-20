import { invoke } from '@tauri-apps/api/core';
import { createSettingsProxy } from './settings-window-bridge.js';
import { createSettingsModal } from './settings-modal.js';
import { createWindowInteraction } from './window-interaction.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';

const byId = id => document.getElementById(id);
let proxy;
let form;
let interaction;
let shuttingDown = false;
let settings = { ...DEFAULT_SETTINGS };
let authoritativeSettings = settings;
let appearanceVersion = 0;
let pendingAppearance = null;

function report(error) {
  if (shuttingDown) return;
  proxy?.reportError(error);
  byId('announcer').textContent = String(error?.message ?? error);
}

function openForm(tab = 'appearance', request = null) {
  if (!form || shuttingDown) return;
  byId('settings-window-status').hidden = true;
  byId('settings-root').hidden = false;
  void form.open(tab, request).catch(report);
}

function closeForm() {
  if (!form || shuttingDown) return;
  void form.close({ notify: false }).catch(report);
}

async function saveAppearance(next) {
  const version = ++appearanceVersion;
  pendingAppearance = version;
  settings = normalizeSettings(next);
  try {
    const confirmed = await proxy.saveSettings(settings);
    if (version === appearanceVersion) {
      settings = normalizeSettings(confirmed ?? authoritativeSettings);
      pendingAppearance = null;
    }
  } catch (error) {
    if (version === appearanceVersion) {
      settings = authoritativeSettings;
      pendingAppearance = null;
    }
    throw error;
  } finally {
    if (version === appearanceVersion && !shuttingDown) form?.refresh();
  }
}

function showStartupError(error) {
  if (shuttingDown) return;
  byId('settings-root').hidden = true;
  byId('settings-window-status').hidden = false;
  byId('settings-window-message').textContent = 'Не удалось открыть настройки. ' + String(error?.message ?? error);
  byId('settings-window-retry').hidden = false;
  document.documentElement.dataset.ready = 'error';
}

async function start() {
  proxy = await createSettingsProxy({
    onState() { if (!shuttingDown) form?.refresh(); },
    onAppearance(next) {
      authoritativeSettings = normalizeSettings(next);
      // Do not replace a locally edited slider with an older runtime snapshot
      // while its save request is still travelling to the main window.
      if (pendingAppearance === null) settings = authoritativeSettings;
      if (!shuttingDown) form?.refresh();
    },
    onAudioLevels(levels) { if (!shuttingDown) form?.updateAudioLevels(levels); },
    onOpen: openForm,
    onClose: closeForm,
  });
  settings = normalizeSettings(await proxy.loadSettings());
  authoritativeSettings = settings;
  form = createSettingsModal({
    standalone: true,
    bridge: proxy,
    getSettings: () => settings,
    getRuntimeState: () => proxy.getRuntimeState(),
    onChange: saveAppearance,
    onOpenChange: open => open ? undefined : proxy.command('set_settings_open', { open: false }),
  });
  interaction = createWindowInteraction({
    startDrag: () => proxy.command('start_window_drag'),
    onError: report,
  });
  byId('settings-window-status').hidden = true;
  byId('settings-root').hidden = false;
  const request = proxy.getOpenRequest();
  if (request.open) openForm(request.tab, request.request);
  else closeForm();
  document.documentElement.dataset.ready = 'true';
}

byId('settings-window-retry').addEventListener('click', () => location.reload());
byId('settings-window-close').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (proxy) await proxy.command('set_settings_open', { open: false });
    else await invoke('set_settings_open', { open: false });
  } catch (error) { showStartupError(error); }
  finally { button.disabled = false; }
});

window.addEventListener('pagehide', () => {
  shuttingDown = true;
  interaction?.destroy();
  form?.destroy();
  proxy?.destroy();
  form = null;
});
void start().catch(showStartupError);
