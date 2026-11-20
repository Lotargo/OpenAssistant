import { createBridge } from './bridge.js';
import { usesMeetingAudio } from './agent-config.js';
import { createStreamParser } from './stream-parser.js';
import { createMarkdownStream } from './markdown-stream.js';
import { createRenderer } from './renderer.js';
import { createSettingsModal } from './settings-modal.js';
import { createSettingsWindowHost } from './settings-window-bridge.js';
import { DEFAULT_SETTINGS, normalizeSettings, applyTheme } from './settings.js';
import { setButtonIcon } from './icons.js';
import { createMicrophoneIndicator, createToolbarAudioIndicator } from './microphone-meter.js';
import { createGeometrySync } from './geometry.js';
import { createWindowInteraction } from './window-interaction.js';
import { playDemo } from './demo.js';

const byId = id => document.getElementById(id);
const overlay = byId('overlay');
let settings = { ...DEFAULT_SETTINGS };
let bridge;
let modal;
let geometry;
let windowInteraction;
let nativeWindowActive = true;
let modalOpen = false;
let pendingSettingsRequest = null;
let saveTimer;
let runtime = {};
const demoAbort = new AbortController();
const microphoneIndicator = createMicrophoneIndicator(document.querySelector('[data-action="microphone"]'));
const toolbarAudioIndicator = createToolbarAudioIndicator(byId('toolbar'));

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void bridge.saveSettings(settings).catch(() => modal?.refresh()), 150);
}

function requestSettings(payload) {
  if (!modal) { pendingSettingsRequest = payload; return; }
  const operation = payload.open ? modal.open(payload.tab || 'appearance', payload.request ?? null) : modal.close();
  void Promise.resolve(operation).catch(error => {
    bridge?.reportError(error);
    byId('announcer').textContent = 'Не удалось открыть или закрыть настройки. ' + String(error?.message ?? error);
  });
}

function renderControls(next = runtime) {
  runtime = next;
  const mic = document.querySelector('[data-action="microphone"]');
  const screenButton = document.querySelector('[data-action="screen"]');
  const lock = document.querySelector('[data-action="scroll-lock"]');
  const reconnect = document.querySelector('[data-action="reconnect"]');
  mic.setAttribute('aria-pressed', String(Boolean(runtime.microphoneMuted)));
  const interview = usesMeetingAudio(runtime.agentConfig) || runtime.systemAudioActive;
  const starting = runtime.microphoneStarting || runtime.interviewStarting;
  mic.setAttribute('aria-label', starting ? 'Остановить подключение микрофона' : interview
    ? runtime.microphoneMuted ? 'Начать прослушивание собеседования' : 'Остановить прослушивание собеседования'
    : runtime.microphoneMuted ? 'Включить микрофон' : 'Выключить микрофон');
  setButtonIcon(mic, runtime.microphoneMuted ? 'microphone-muted' : 'microphone');
  setButtonIcon(screenButton, 'screen');
  setButtonIcon(reconnect, 'reconnect');
  const settingsButton = document.querySelector('[data-action="settings"]');
  setButtonIcon(settingsButton, 'settings');
  if (bridge?.native) settingsButton.setAttribute('aria-expanded', String(Boolean(runtime.settingsOpen)));
  microphoneIndicator.update(runtime.microphoneLevels, runtime);
  toolbarAudioIndicator.update(runtime.microphoneLevels, runtime);
  screenButton.setAttribute('aria-pressed', String(Boolean(runtime.screenCaptureEnabled)));
  screenButton.dataset.state = runtime.screenCaptureEnabled ? 'active' : 'idle';
  lock.setAttribute('aria-pressed', String(Boolean(runtime.scrollLocked)));
  lock.setAttribute('aria-label', runtime.scrollLocked ? 'Разблокировать прокрутку' : 'Заблокировать прокрутку');
  setButtonIcon(lock, runtime.scrollLocked ? 'lock' : 'unlock');
  reconnect.dataset.state = runtime.connectionStatus || 'unavailable';
  const windowMode = runtime.windowMode === 'standard' ? 'standard' : 'overlay';
  const windowButton = byId('window-mode-btn');
  windowButton.setAttribute('aria-pressed', String(windowMode === 'standard'));
  windowButton.setAttribute('aria-label', windowMode === 'standard'
    ? 'Обычное окно. Переключить в защищённый оверлей'
    : 'Защищённый оверлей. Переключить в обычное окно');
  windowButton.dataset.mode = windowMode;
  setButtonIcon(windowButton, windowMode === 'standard' ? 'window-standard' : 'window-overlay');
  overlay.dataset.windowMode = windowMode;
  if (Boolean(runtime.scrollLocked) !== settings.scrollLocked) {
    settings = normalizeSettings({ ...settings, scrollLocked: Boolean(runtime.scrollLocked) });
    if (bridge) persist();
  }
  overlay.dataset.scrollLocked = String(settings.scrollLocked);
  modal?.refresh();
}

const renderer = createRenderer({
  textContent: byId('text-content'),
  codeContent: byId('code-content'),
  notesContent: byId('notes-content'),
  codeFilename: byId('code-filename'),
  getAutoScroll: () => settings.autoScroll,
  onRender: () => geometry?.schedule(),
});

function updateSnapshot(snapshot) {
  overlay.dataset.mode = snapshot.mode === 'text' ? 'text' : 'code';
  renderer.update(snapshot);
  geometry?.schedule();
}
const parser = createStreamParser({ onUpdate: updateSnapshot, onError: error => bridge?.reportError(error?.message ?? error) });
const liveParser = createMarkdownStream({ onUpdate: updateSnapshot, onError: error => bridge?.reportError(error?.message ?? error) });
let activeParser = liveParser;

function scrollPanel({ target, deltaY }) {
  if (settings.scrollLocked || modalOpen || !['text', 'code', 'notes'].includes(target) || !Number.isFinite(deltaY)) return;
  byId(`${target}-panel`)?.scrollBy({ top: deltaY, behavior: 'instant' });
}

async function applySettings(next) {
  const previousLock = settings.scrollLocked;
  settings = normalizeSettings(next);
  applyTheme(settings);
  overlay.dataset.scrollLocked = String(settings.scrollLocked);
  geometry?.schedule();
  persist();
  if (previousLock !== settings.scrollLocked) {
    try { await bridge.command('set_scroll_locked', { locked: settings.scrollLocked }); }
    catch { modal?.refresh(); }
  }
}

async function start() {
  bridge = await createBridge({
    onState: renderControls,
    onWindowActivity({ active }) {
      nativeWindowActive = active;
      windowInteraction?.setActive(active);
      geometry?.setActive(active);
      microphoneIndicator.setVisible(active);
      toolbarAudioIndicator.setVisible(active);
    },
    onAudioLevels(levels) {
      if (levels?.source === 'system') runtime = { ...runtime, systemAudioLevels: levels };
      else {
        runtime = { ...runtime, microphoneLevels: levels };
        microphoneIndicator.update(levels, runtime);
      }
      toolbarAudioIndicator.update(runtime.microphoneLevels, runtime);
      modal?.updateAudioLevels(levels);
    },
    onScroll: scrollPanel,
    onSettings: payload => requestSettings({ tab: 'agent', ...payload }),
    onError: () => modal?.refresh(),
    onTurnStart: payload => {
      activeParser = payload?.format === 'tagged' ? parser : liveParser;
      activeParser.reset({ preserveCode: Boolean(payload?.preserveCode) });
    },
    onChunk: payload => { if (typeof payload?.text === 'string') activeParser.feed(payload.text); },
    onTurnEnd: () => activeParser.finish(),
  });
  document.body.classList.toggle('browser-preview', !bridge.native);
  settings = normalizeSettings(await bridge.loadSettings());
  applyTheme(settings);

  if (bridge.native) {
    modal = await createSettingsWindowHost({
      bridge,
      getSettings: () => settings,
      onChange: next => applySettings(next),
      onOpenChange(open) {
        document.querySelector('[data-action="settings"]').setAttribute('aria-expanded', String(open));
      },
    });
  } else {
    modal = createSettingsModal({
      bridge,
      getSettings: () => settings,
      onChange: next => applySettings(next),
      onOpenChange(open) {
        modalOpen = open;
        geometry?.schedule();
        return bridge.command('set_settings_open', { open }).catch(() => modal?.refresh());
      },
      getRuntimeState: () => bridge.getRuntimeState(),
    });
  }
  geometry = createGeometrySync({ bridge, overlay, getSettings: () => settings, isModalOpen: () => !bridge.native && modalOpen });
  windowInteraction = createWindowInteraction({
    startDrag: () => bridge.native ? bridge.command('start_window_drag') : undefined,
    onError: error => bridge.reportError(error),
  });
  windowInteraction.setActive(nativeWindowActive);
  geometry.setActive(nativeWindowActive);
  await bridge.command('set_scroll_locked', { locked: settings.scrollLocked });
  renderControls(bridge.getRuntimeState());
  if (pendingSettingsRequest) {
    const request = pendingSettingsRequest;
    pendingSettingsRequest = null;
    requestSettings(request);
  }

  document.querySelector('#toolbar').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || modalOpen) return;
    const action = button.dataset.action;
    if (action === 'settings') { requestSettings({ open: true, tab: 'appearance' }); return; }
    if (action !== 'microphone') button.disabled = true;
    try {
      if (action === 'microphone') await bridge.command('set_microphone_muted', { muted: Boolean(runtime.microphoneStarting || runtime.interviewStarting || !runtime.microphoneMuted) });
      if (action === 'screen') await bridge.command('set_screen_capture_enabled', { enabled: !runtime.screenCaptureEnabled });
      if (action === 'reconnect') await bridge.command('reconnect_session');
      if (action === 'scroll-lock') await bridge.command('set_scroll_locked', { locked: !runtime.scrollLocked });
      if (action === 'window-mode') await bridge.command('set_window_mode', { mode: runtime.windowMode === 'standard' ? 'overlay' : 'standard' });
    } catch (error) {
      if (action === 'window-mode') {
        byId('announcer').textContent = 'Не удалось изменить режим окна. ' + String(error?.message ?? error);
        renderControls(bridge.getRuntimeState());
      } else requestSettings({ open: true, tab: action === 'microphone' ? 'audio' : action === 'screen' ? 'screen' : 'agent' });
    } finally { if (action !== 'microphone') button.disabled = false; }
  });

  // Browser wheel input is handled normally. In desktop click-through mode the
  // Windows wheel hook supplies overlay:scroll instead. Lock blocks both paths.
  for (const panel of document.querySelectorAll('[data-scroll-panel]')) {
    panel.addEventListener('wheel', event => {
      if (settings.scrollLocked) event.preventDefault();
    }, { passive: false });
    panel.addEventListener('touchmove', event => {
      if (settings.scrollLocked) event.preventDefault();
    }, { passive: false });
    panel.addEventListener('keydown', event => {
      if (settings.scrollLocked && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        event.preventDefault();
      }
    });
  }

  const demo = new URLSearchParams(location.search).get('demo');
  if (['text', 'code', 'settings', 'stream'].includes(demo)) {
    await playDemo(parser, demo, { signal: demoAbort.signal });
    if (demo === 'settings') requestSettings({ open: true, tab: 'appearance' });
  }
  await renderer.flush();
  document.documentElement.dataset.ready = 'true';
}

window.addEventListener('pagehide', () => {
  clearTimeout(saveTimer);
  demoAbort.abort();
  microphoneIndicator.destroy();
  toolbarAudioIndicator.destroy();
  windowInteraction?.destroy();
  geometry?.destroy();
  renderer.destroy();
  modal?.destroy();
  if (bridge) void bridge.saveSettings(settings).catch(() => {});
  void bridge?.destroy();
});

start().catch(error => {
  console.error('OpenAssistant startup failed:', error);
  byId('text-content').textContent = `Не удалось запустить интерфейс: ${error instanceof Error ? error.message : error}`;
  document.documentElement.dataset.ready = 'error';
});
