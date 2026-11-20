import { createBridge } from './bridge.js';
import { createStreamParser } from './stream-parser.js';
import { createMarkdownStream } from './markdown-stream.js';
import { createRenderer } from './renderer.js';
import { createSettingsModal } from './settings-modal.js';
import { DEFAULT_SETTINGS, normalizeSettings, applyTheme } from './settings.js';
import { setButtonIcon } from './icons.js';
import { createGeometrySync } from './geometry.js';
import { playDemo } from './demo.js';

const byId = id => document.getElementById(id);
const overlay = byId('overlay');
let settings = { ...DEFAULT_SETTINGS };
let bridge;
let modal;
let geometry;
let modalOpen = false;
let saveTimer;
let runtime = {};
const demoAbort = new AbortController();

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void bridge.saveSettings(settings).catch(() => modal?.refresh()), 150);
}

function renderControls(next = runtime) {
  runtime = next;
  const mic = document.querySelector('[data-action="microphone"]');
  const screenButton = document.querySelector('[data-action="screen"]');
  const lock = document.querySelector('[data-action="scroll-lock"]');
  const reconnect = document.querySelector('[data-action="reconnect"]');
  mic.setAttribute('aria-pressed', String(Boolean(runtime.microphoneMuted)));
  mic.setAttribute('aria-label', runtime.microphoneMuted ? 'Включить микрофон' : 'Выключить микрофон');
  setButtonIcon(mic, runtime.microphoneMuted ? 'microphone-muted' : 'microphone');
  screenButton.setAttribute('aria-pressed', String(Boolean(runtime.screenCaptureEnabled)));
  screenButton.dataset.state = runtime.screenCaptureEnabled ? 'active' : 'idle';
  lock.setAttribute('aria-pressed', String(Boolean(runtime.scrollLocked)));
  lock.setAttribute('aria-label', runtime.scrollLocked ? 'Разблокировать прокрутку' : 'Заблокировать прокрутку');
  setButtonIcon(lock, runtime.scrollLocked ? 'lock' : 'unlock');
  reconnect.dataset.state = runtime.connectionStatus || 'unavailable';
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
    onScroll: scrollPanel,
    onSettings: ({ open, tab, request }) => open ? modal?.open(tab || 'agent', request) : modal?.close(),
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
  geometry = createGeometrySync({ bridge, overlay, getSettings: () => settings, isModalOpen: () => modalOpen });
  await bridge.command('set_scroll_locked', { locked: settings.scrollLocked });
  renderControls(bridge.getRuntimeState());

  document.querySelector('#toolbar').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || modalOpen) return;
    const action = button.dataset.action;
    if (action === 'settings') { modal.open(); return; }
    button.disabled = true;
    try {
      if (action === 'microphone') await bridge.command('set_microphone_muted', { muted: !runtime.microphoneMuted });
      if (action === 'screen') await bridge.command('set_screen_capture_enabled', { enabled: !runtime.screenCaptureEnabled });
      if (action === 'reconnect') await bridge.command('reconnect_session');
      if (action === 'scroll-lock') await bridge.command('set_scroll_locked', { locked: !runtime.scrollLocked });
    } catch {
      modal.open(action === 'microphone' || action === 'screen' ? 'sources' : 'agent');
    } finally { button.disabled = false; }
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

  parser.feed('<mode>text</mode><text>Здесь появится ответ ассистента.</text>');
  parser.finish();
  const demo = new URLSearchParams(location.search).get('demo');
  if (['text', 'code', 'settings', 'stream'].includes(demo)) {
    await playDemo(parser, demo, { signal: demoAbort.signal });
    if (demo === 'settings') modal.open();
  }
  await renderer.flush();
  document.documentElement.dataset.ready = 'true';
}

window.addEventListener('pagehide', () => {
  clearTimeout(saveTimer);
  demoAbort.abort();
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
