import { createBridge } from './bridge.js';
import { createActionToast } from './action-toast.js';
import { createStreamParser } from './stream-parser.js';
import { createMarkdownStream } from './markdown-stream.js';
import { createRenderer } from './renderer.js';
import { createSettingsModal } from './settings-modal.js';
import { createSettingsWindowHost } from './settings-window-bridge.js';
import { DEFAULT_SETTINGS, normalizeSettings, applyTheme } from './settings.js';
import { setButtonIcon, setModeButtonIcon } from './icons.js';
import { createMicrophoneIndicator, createToolbarAudioIndicator, selectToolbarAudio } from './microphone-meter.js';
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
let modeChanging = false;
let broadcastOperation = null;
let broadcastEpoch = 0;
let previousBroadcastStage = 'idle';
const notifiedBroadcasts = new Set();
const modeLabels = { assistant: 'Ассистент', interview: 'Совещание', custom: 'Свой режим' };
const demoAbort = new AbortController();
const microphoneIndicator = createMicrophoneIndicator(document.querySelector('[data-action="microphone"]'));
const toolbar = byId('toolbar');
const toolbarAudioIndicator = createToolbarAudioIndicator(toolbar);
const actionToast = createActionToast({
  announcer: byId('announcer'), isEnabled: () => settings.actionNotifications,
  getBridge: () => bridge, getTheme: () => settings,
});
let notificationPreference = null;
const toolbarTooltip = byId('toolbar-tooltip');
let hintedButton = null;
function hideToolbarHint() {
  hintedButton = null;
  toolbarTooltip.hidden = true;
}
function showToolbarHint(button) {
  const label = button?.dataset.tooltip || button?.getAttribute('aria-label');
  if (!label || !nativeWindowActive) { hideToolbarHint(); return; }
  hintedButton = button;
  toolbarTooltip.textContent = label;
  const panel = overlay.getBoundingClientRect(), bar = toolbar.getBoundingClientRect(), control = button.getBoundingClientRect();
  toolbarTooltip.style.bottom = (bar.height + 5) + 'px';
  toolbarTooltip.style.setProperty('--tooltip-lines', panel.height - bar.height >= 48 ? '2' : '1');
  toolbarTooltip.hidden = false;
  const width = toolbarTooltip.getBoundingClientRect().width;
  const center = control.left + control.width / 2 - panel.left;
  toolbarTooltip.style.left = Math.max(width / 2 + 8, Math.min(panel.width - width / 2 - 8, center)) + 'px';
}
toolbar.addEventListener('pointerover', event => {
  const button = event.target.closest('button');
  if (button && button !== hintedButton) showToolbarHint(button);
});
toolbar.addEventListener('pointerout', event => {
  if (!event.relatedTarget || !toolbar.contains(event.relatedTarget)) hideToolbarHint();
  else if (hintedButton && !hintedButton.contains(event.relatedTarget)) hideToolbarHint();
});
toolbar.addEventListener('focusin', event => {
  const button = event.target.closest('button');
  if (button?.matches(':focus-visible')) showToolbarHint(button);
});
toolbar.addEventListener('focusout', hideToolbarHint);
toolbar.addEventListener('pointerdown', hideToolbarHint);
function syncToolbarLayout() {
  const anchor = toolbar.querySelector(window.matchMedia('(max-width: 600px)').matches ? '.toolbar-actions' : '.toolbar-controls');
  const bar = toolbar.getBoundingClientRect(), content = anchor.getBoundingClientRect();
  if (bar.width <= 0 || content.width <= 0) return;
  toolbar.style.setProperty('--toolbar-wave-span', content.width + 'px');
  toolbar.style.setProperty('--toolbar-audio-top', (content.top - bar.top + content.height / 2) + 'px');
  if (hintedButton) showToolbarHint(hintedButton);
}
const toolbarLayoutObserver = new ResizeObserver(syncToolbarLayout);
for (const element of [toolbar, toolbar.querySelector('.toolbar-controls'), toolbar.querySelector('.toolbar-actions')]) toolbarLayoutObserver.observe(element);

function updateToolbarAudio() {
  const audio = selectToolbarAudio(runtime);
  toolbar.dataset.audioSource = audio.source;
  toolbarAudioIndicator.update(audio.levels, audio);
}

function renderNotificationControl() {
  const button = byId('notifications-btn');
  button.setAttribute('aria-pressed', String(settings.actionNotifications));
  button.setAttribute('aria-label', settings.actionNotifications ? 'Выключить всплывающие уведомления' : 'Включить всплывающие уведомления');
  setButtonIcon(button, settings.actionNotifications ? 'notifications' : 'notifications-off');
  button.dataset.tooltip = button.getAttribute('aria-label');
  if (!settings.actionNotifications && notificationPreference !== false) actionToast.dismiss();
  notificationPreference = settings.actionNotifications;
}
function observeBroadcast(state = {}) {
  const stage = state.stage || 'idle';
  if (stage === 'starting' && previousBroadcastStage !== 'starting') broadcastEpoch++;
  previousBroadcastStage = stage;
  if (stage !== 'ended') return;
  const key = state.broadcast_id == null ? 'local:' + broadcastEpoch : String(state.broadcast_id);
  if (notifiedBroadcasts.has(key)) return;
  notifiedBroadcasts.add(key);
  while (notifiedBroadcasts.size > 20) notifiedBroadcasts.delete(notifiedBroadcasts.values().next().value);
  actionToast.show(state.farewell || state.detail || 'Эфир завершён.', { timeout: 4500, kind: state.reason === 'error' ? 'error' : 'info' });
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void bridge.saveSettings(settings).catch(() => modal?.refresh()), 150);
}

function requestSettings(payload) {
  if (!modal) { pendingSettingsRequest = payload; return Promise.resolve(false); }
  const operation = payload.open ? modal.open(payload.tab || 'appearance', payload.request ?? null) : modal.close();
  return Promise.resolve(operation).then(() => true).catch(error => {
    bridge?.reportError(error);
    byId('announcer').textContent = 'Не удалось открыть или закрыть настройки. ' + String(error?.message ?? error);
    actionToast.show(byId('announcer').textContent, { kind: 'error' });
    return false;
  });
}

function renderControls(next = runtime) {
  runtime = next;
  const mic = document.querySelector('[data-action="microphone"]');
  const screenButton = document.querySelector('[data-action="screen"]');
  const lock = document.querySelector('[data-action="scroll-lock"]');
  const reconnect = document.querySelector('[data-action="reconnect"]');
  mic.setAttribute('aria-pressed', String(Boolean(runtime.microphoneMuted)));
  const broadcast = runtime.broadcastState || {};
  const stage = broadcast.stage || 'idle';
  const active = ['starting', 'live', 'stopping'].includes(stage);
  mic.disabled = stage !== 'live' || Boolean(runtime.microphoneBusy);
  mic.setAttribute('aria-label', stage !== 'live' ? 'Микрофон доступен во время эфира'
    : runtime.microphoneMuted ? 'Включить микрофон в эфире' : 'Выключить микрофон в эфире');
  const broadcastButton = byId('broadcast-btn');
  broadcastButton.dataset.stage = stage;
  broadcastButton.setAttribute('aria-pressed', String(active));
  broadcastButton.setAttribute('aria-label', stage === 'starting' ? 'Остановить подключение эфира'
    : stage === 'stopping' ? 'Эфир завершается' : active ? 'Завершить эфир' : 'Включить эфир');
  broadcastButton.disabled = !runtime.nativeWindow || stage === 'stopping' || broadcastOperation?.kind === 'stop';
  setButtonIcon(broadcastButton, active ? 'stop' : 'broadcast');
  const scenario = ['assistant', 'interview', 'custom'].includes(runtime.agentConfig?.scenario) ? runtime.agentConfig.scenario : 'assistant';
  const nextScenario = { assistant: 'interview', interview: 'custom', custom: 'assistant' }[scenario];
  const modeButton = byId('mode-btn');
  modeButton.dataset.currentScenario = scenario;
  modeButton.setAttribute('aria-label', 'Режим: ' + modeLabels[scenario] + '. Переключить: ' + modeLabels[nextScenario]);
  modeButton.disabled = modeChanging || stage === 'stopping';
  setModeButtonIcon(modeButton, { assistant: 'mode-assistant', interview: 'mode-meeting', custom: 'mode-custom' }[scenario]);
  renderNotificationControl();
  observeBroadcast(broadcast);
  setButtonIcon(mic, runtime.microphoneMuted ? 'microphone-muted' : 'microphone');
  setButtonIcon(screenButton, 'screen');
  setButtonIcon(reconnect, 'reconnect');
  const settingsButton = document.querySelector('[data-action="settings"]');
  setButtonIcon(settingsButton, 'settings');
  if (bridge?.native) settingsButton.setAttribute('aria-expanded', String(Boolean(runtime.settingsOpen)));
  microphoneIndicator.update(runtime.microphoneLevels, runtime);
  updateToolbarAudio();
  screenButton.setAttribute('aria-pressed', String(Boolean(runtime.screenCaptureEnabled)));
  screenButton.dataset.state = runtime.screenCaptureEnabled ? 'active' : 'idle';
  lock.setAttribute('aria-pressed', String(Boolean(runtime.scrollLocked)));
  lock.setAttribute('aria-label', runtime.scrollLocked ? 'Разблокировать прокрутку' : 'Заблокировать прокрутку');
  setButtonIcon(lock, runtime.scrollLocked ? 'lock' : 'unlock');
  reconnect.dataset.state = runtime.connectionStatus || 'unavailable';
  reconnect.disabled = ['starting', 'stopping'].includes(stage) || runtime.connectionStatus === 'connecting';
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
  for (const button of toolbar.querySelectorAll('button')) {
    button.dataset.tooltip = button.getAttribute('aria-label') || '';
    button.removeAttribute('title');
  }
  if (hintedButton) showToolbarHint(hintedButton);
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
  actionToast.updateTheme();
  renderNotificationControl();
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
      if (!active) hideToolbarHint();
    },
    onAudioLevels(levels) {
      if (levels?.source === 'system') runtime = { ...runtime, systemAudioLevels: levels };
      else {
        runtime = { ...runtime, microphoneLevels: levels };
        microphoneIndicator.update(levels, runtime);
      }
      updateToolbarAudio();
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
  actionToast.updateTheme();

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

  async function toggleBroadcast() {
    const state = bridge.getRuntimeState().broadcastState || {};
    const stop = ['starting', 'live', 'stopping'].includes(state.stage) || broadcastOperation?.kind === 'start';
    const operation = { kind: stop ? 'stop' : 'start' };
    broadcastOperation = operation;
    renderControls(bridge.getRuntimeState());
    try {
      await bridge.command(stop ? 'stop_broadcast' : 'start_broadcast');
      if (broadcastOperation === operation && !stop && bridge.getRuntimeState().broadcastState?.stage === 'live') actionToast.show('Эфир включён');
    } catch (error) {
      if (broadcastOperation === operation) {
        actionToast.show(String(error?.message ?? error), { kind: 'error', timeout: 4500 });
        void requestSettings({ open: true, tab: 'modes' });
      }
    } finally {
      if (broadcastOperation === operation) broadcastOperation = null;
      renderControls(bridge.getRuntimeState());
    }
  }

  toolbar.addEventListener('click', async event => {
    if (modalOpen) return;
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'mode') {
      if (modeChanging) return;
      const scenario = { assistant: 'interview', interview: 'custom', custom: 'assistant' }[runtime.agentConfig?.scenario || 'assistant'];
      modeChanging = true;
      renderControls();
      try {
        await bridge.command('set_scenario', { scenario });
        actionToast.show('Режим: ' + modeLabels[bridge.getAgentSettings().scenario]);
      } catch (error) { actionToast.show(String(error?.message ?? error), { kind: 'error', timeout: 4500 }); }
      finally { modeChanging = false; renderControls(bridge.getRuntimeState()); }
      return;
    }
    if (action === 'settings') {
      if (await requestSettings({ open: true, tab: 'appearance' })) actionToast.show('Настройки открыты');
      return;
    }
    if (action === 'notifications') {
      await applySettings({ ...settings, actionNotifications: !settings.actionNotifications });
      if (settings.actionNotifications) actionToast.show('Уведомления включены');
      return;
    }
    if (action === 'broadcast') { await toggleBroadcast(); return; }
    button.disabled = true;
    try {
      if (action === 'microphone') {
        await bridge.command('set_microphone_muted', { muted: !runtime.microphoneMuted });
        if (bridge.getRuntimeState().broadcastState?.stage === 'live') actionToast.show(bridge.getRuntimeState().microphoneMuted ? 'Микрофон выключен' : 'Микрофон включён');
      }
      if (action === 'screen') await bridge.command('set_screen_capture_enabled', { enabled: !runtime.screenCaptureEnabled });
      if (action === 'reconnect') {
        await bridge.command('reconnect_session');
        actionToast.show('Codex подключён');
      }
      if (action === 'scroll-lock') {
        await bridge.command('set_scroll_locked', { locked: !runtime.scrollLocked });
        actionToast.show(bridge.getRuntimeState().scrollLocked ? 'Прокрутка заблокирована' : 'Прокрутка разблокирована');
      }
      if (action === 'window-mode') {
        await bridge.command('set_window_mode', { mode: runtime.windowMode === 'standard' ? 'overlay' : 'standard' });
        actionToast.show(bridge.getRuntimeState().windowMode === 'standard' ? 'Обычное окно' : 'Защищённый оверлей');
      }
    } catch (error) {
      actionToast.show(String(error?.message ?? error), { kind: 'error', timeout: 4500 });
      if (action === 'window-mode') byId('announcer').textContent = 'Не удалось изменить режим окна. ' + String(error?.message ?? error);
      else void requestSettings({ open: true, tab: action === 'microphone' ? 'audio' : action === 'screen' ? 'screen' : 'agent' });
    } finally {
      button.disabled = false;
      renderControls(bridge.getRuntimeState());
    }
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
  toolbarLayoutObserver.disconnect();
  actionToast.destroy();
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
