import { invoke } from '@tauri-apps/api/core';
import { listen, emitTo } from '@tauri-apps/api/event';

const REQUEST = 'settings:request';
const RESPONSE = 'settings:response';
const SNAPSHOT = 'settings:snapshot';
const AUDIO = 'settings:audio';
const HOST_READY = 'settings:host-ready';
const EVENTS = { listen, emitTo };
const COMMANDS = new Set([
  'set_microphone_muted', 'set_microphone_device', 'refresh_microphones',
  'request_microphone_permission', 'start_microphone_test', 'stop_microphone_test',
  'set_microphone_noise_suppression', 'set_scroll_locked', 'set_screen_capture_enabled',
  'reconnect_session', 'disconnect_session', 'agent_task', 'select_agent_task',
  'agent_interrupt', 'agent_approval', 'agent_input',
  'refresh_models', 'choose_workspace', 'clear_temporary_workspace',
  'start_interview', 'stop_interview', 'set_system_audio_device',
  'clear_journal', 'copy_journal', 'set_window_mode',
]);
const copy = value => value == null ? value : structuredClone(value);
const errorText = error => String(error?.message ?? error).slice(0, 8000);
const newId = () => globalThis.crypto.randomUUID();

/** The main webview remains the sole owner of Codex, audio and persisted settings.
 * The settings window receives snapshots and sends only these explicit operations.
 */
export async function createSettingsWindowHost({
  bridge, getSettings, onChange, onOpenChange, events = EVENTS,
} = {}) {
  const hostId = newId();
  let clientId = null;
  let sequence = 0;
  let intentSequence = 0;
  let destroyed = false;
  let lastOpen = Boolean(bridge.getRuntimeState().settingsOpen);
  let intent = { open: lastOpen, tab: 'appearance', request: null, sequence: 0 };
  let transitionQueue = Promise.resolve();
  let transitions = 0;

  const snapshot = () => ({
    hostId, sequence: ++sequence,
    runtime: copy(bridge.getRuntimeState()), settings: copy(getSettings()),
    sessionGeneration: bridge.getSessionGeneration?.() ?? 0,
    openRequest: { ...copy(intent), open: intent.open && Boolean(bridge.getRuntimeState().settingsOpen) },
  });
  function send(event, payload) {
    if (destroyed || !clientId) return;
    void events.emitTo('settings', event, { clientId, ...payload }).catch(() => {});
  }
  function refresh() {
    if (destroyed) return;
    const opened = Boolean(bridge.getRuntimeState().settingsOpen);
    if (!opened && lastOpen && !transitions) intent = { ...intent, open: false, sequence: ++intentSequence };
    if (opened !== lastOpen) {
      lastOpen = opened;
      onOpenChange?.(opened);
      // Native Alt+F4/hide is an observation, not another close command.
      if (!opened) void bridge.command('stop_microphone_test').catch(() => {});
    }
    if (opened || intent.open || clientId) send(SNAPSHOT, snapshot());
  }
  function transition(open) {
    transitions++;
    const operation = transitionQueue.then(() => {
      if (destroyed) return;
      return bridge.command('set_settings_open', { open });
    });
    transitionQueue = operation.catch(() => {});
    return operation.finally(() => { transitions--; refresh(); });
  }
  async function open(tab = 'appearance', request = null) {
    if (destroyed) return;
    const previous = intent;
    intent = { open: true, tab, request: copy(request), sequence: ++intentSequence };
    const requested = intent.sequence;
    try { await transition(true); }
    catch (error) {
      if (intent.sequence === requested) intent = { ...previous, sequence: ++intentSequence };
      refresh();
      throw error;
    }
  }
  async function close() {
    if (destroyed) return;
    const closingSequence = ++intentSequence;
    await transition(false);
    // Keep the form visible if native hide fails; a newer open intent wins.
    if (intent.sequence < closingSequence) {
      intent = { ...intent, open: false, request: null, sequence: closingSequence };
    }
    refresh();
  }
  async function handleRequest({ payload }) {
    if (destroyed || !payload || typeof payload.clientId !== 'string') return;
    const { id, method, args = [], clientId: sender } = payload;
    if (!Array.isArray(args)) return;
    if (method === 'snapshot') clientId = sender;
    if (sender !== clientId) return;
    if (method === 'detach') {
      clientId = null;
      void bridge.command('stop_microphone_test').catch(() => {});
      return;
    }
    if (typeof id !== 'string') return;
    let result;
    let error;
    try {
      switch (method) {
        case 'snapshot': break;
        case 'saveSettings':
          await onChange(copy(args[0]));
          result = copy(getSettings());
          break;
        case 'setAgentSettings': result = await bridge.setAgentSettings(copy(args[0])); break;
        case 'reportError': result = bridge.reportError(errorText(args[0])); break;
        case 'command': {
          const [name, commandArgs = {}] = args;
          if (name === 'set_settings_open') {
            await (commandArgs.open ? open() : close());
            result = bridge.getRuntimeState();
          } else {
            if (!COMMANDS.has(name)) throw new Error('Команда недоступна в окне настроек.');
            if (name === 'agent_approval' || name === 'agent_input') {
              const current = bridge.getRuntimeState();
              const requests = name === 'agent_approval' ? current.approvals : current.inputs;
              if (payload.sessionGeneration !== (bridge.getSessionGeneration?.() ?? 0)
                || !requests?.some(item => item.request_id === commandArgs.request_id)) {
                throw new Error('Этот запрос уже завершён или относится к прежней сессии.');
              }
            }
            if (name === 'start_microphone_test' && !bridge.getRuntimeState().settingsOpen) {
              throw new Error('Открой настройки для проверки микрофона.');
            }
            result = await bridge.command(name, copy(commandArgs));
          }
          break;
        }
        default: throw new Error('Неизвестное действие окна настроек.');
      }
    } catch (failure) { error = errorText(failure); }
    if (destroyed || sender !== clientId) return;
    await events.emitTo('settings', RESPONSE, {
      clientId: sender, id, result: copy(result), error, snapshot: snapshot(),
    }).catch(() => {});
  }
  const unlisten = await events.listen(REQUEST, event => { void handleRequest(event); });
  void events.emitTo('settings', HOST_READY, { hostId }).catch(() => {});
  return {
    open, close, refresh,
    get isOpen() { return Boolean(bridge.getRuntimeState().settingsOpen); },
    updateAudioLevels(levels) {
      if (!destroyed && bridge.getRuntimeState().settingsOpen) {
        send(AUDIO, { hostId, sequence: ++sequence, levels: copy(levels) });
      }
    },
    destroy() {
      destroyed = true;
      clientId = null;
      unlisten();
    },
  };
}

/** A lightweight remote view: no transport, microphone capture or Store instance. */
export async function createSettingsProxy({
  onState, onAppearance, onAudioLevels, onOpen, onClose, onWindowActivity, events = EVENTS,
  nativeInvoke = invoke, requestTimeout = 75_000, readyTimeout = 2_000, readyAttempts = 5,
} = {}) {
  const clientId = newId();
  let requestId = 0;
  let activityVersion = 0;
  let hostId = null;
  let stateSequence = -1;
  let audioSequences = { microphone: -1, system: -1 };
  let sessionGeneration = 0;
  let destroyed = false;
  let runtime = {};
  let appearance = {};
  let openRequest = { open: false, tab: 'appearance', request: null, sequence: -1 };
  const pending = new Map();
  const unlisteners = [];

  function applySnapshot(packet, allowNewHost = false) {
    if (!packet || typeof packet.hostId !== 'string' || !Number.isSafeInteger(packet.sequence)) return;
    if (hostId && hostId !== packet.hostId && !allowNewHost) return;
    if (hostId !== packet.hostId) {
      hostId = packet.hostId;
      stateSequence = -1;
      audioSequences = { microphone: -1, system: -1 };
    }
    if (packet.sequence <= stateSequence) return;
    stateSequence = packet.sequence;
    const previous = runtime;
    runtime = copy(packet.runtime || {});
    for (const [source, field] of [['microphone', 'microphoneLevels'], ['system', 'systemAudioLevels']]) {
      if (packet.sequence < audioSequences[source]) runtime[field] = previous[field];
      else audioSequences[source] = packet.sequence;
    }
    appearance = copy(packet.settings || {});
    sessionGeneration = packet.sessionGeneration ?? 0;
    const previousOpen = openRequest;
    openRequest = copy(packet.openRequest || { open: Boolean(runtime.settingsOpen), sequence: packet.sequence });
    onAppearance?.(copy(appearance));
    onState?.(copy(runtime));
    if (openRequest.open && (!previousOpen.open || openRequest.sequence !== previousOpen.sequence)) {
      onOpen?.(openRequest.tab || 'appearance', copy(openRequest.request));
    } else if (!openRequest.open && previousOpen.open) onClose?.();
  }
  function request(method, args = [], timeout = requestTimeout) {
    if (destroyed) return Promise.reject(new Error('Окно настроек уже закрыто.'));
    const id = clientId + ':' + ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Основная панель не ответила. Закрой и снова открой настройки.'));
      }, timeout);
      pending.set(id, { resolve, reject, timer, method });
      void events.emitTo('main', REQUEST, { clientId, id, method, args: copy(args), sessionGeneration }).catch(error => {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        reject(error);
      });
    });
  }
  function dispose() {
    if (destroyed) return;
    destroyed = true;
    for (const unlisten of unlisteners) unlisten();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Окно настроек закрыто.'));
    }
    pending.clear();
    void events.emitTo('main', REQUEST, { clientId, method: 'detach' }).catch(() => {});
  }
  try {
    unlisteners.push(await events.listen(RESPONSE, ({ payload }) => {
      if (destroyed || payload?.clientId !== clientId) return;
      const entry = pending.get(payload.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(payload.id);
      applySnapshot(payload.snapshot, entry.method === 'snapshot');
      if (payload.error) entry.reject(new Error(payload.error));
      else entry.resolve(copy(payload.result));
    }));
    unlisteners.push(await events.listen(SNAPSHOT, ({ payload }) => {
      if (!destroyed && payload?.clientId === clientId) applySnapshot(payload);
    }));
    unlisteners.push(await events.listen(AUDIO, ({ payload }) => {
      const source = payload?.levels?.source === 'system' ? 'system' : 'microphone';
      if (destroyed || payload?.clientId !== clientId || payload.hostId !== hostId
        || !Number.isSafeInteger(payload.sequence) || payload.sequence <= audioSequences[source]) return;
      audioSequences[source] = payload.sequence;
      const field = source === 'system' ? 'systemAudioLevels' : 'microphoneLevels';
      runtime = { ...runtime, [field]: copy(payload.levels) };
      onAudioLevels?.(copy(payload.levels));
    }));
    unlisteners.push(await events.listen(HOST_READY, ({ payload }) => {
      if (destroyed || !hostId || !payload?.hostId || payload.hostId === hostId) return;
      // A main-window reload replaces the owner. Reconnect the view, but never
      // replay a task, an approval or any other action from the previous owner.
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Основная панель перезапущена. Повтори действие.'));
      }
      pending.clear();
      void request('snapshot', [], readyTimeout).catch(error => {
        if (destroyed) return;
        runtime = { ...runtime, lastError: errorText(error) };
        onState?.(copy(runtime));
      });
    }));
    const activity = payload => {
      if (destroyed || typeof payload?.active !== 'boolean') return;
      activityVersion++;
      onWindowActivity?.({ active: payload.active });
    };
    unlisteners.push(await events.listen('overlay:window-activity', ({ payload }) => activity(payload)));
    const initialActivityVersion = activityVersion;
    try {
      const initial = await nativeInvoke('get_window_activity');
      if (activityVersion === initialActivityVersion) activity(initial);
    } catch { /* Native activity events still handle subsequent transitions. */ }
    for (let attempt = 0; ; attempt++) {
      try { await request('snapshot', [], readyTimeout); break; }
      catch (error) { if (attempt + 1 >= readyAttempts) throw error; }
    }
  } catch (error) { dispose(); throw error; }
  return {
    native: true,
    getRuntimeState: () => copy(runtime),
    getAgentSettings: () => copy(runtime.agentConfig || {}),
    getOpenRequest: () => copy(openRequest),
    loadSettings: async () => copy(appearance),
    saveSettings: settings => request('saveSettings', [settings]),
    setAgentSettings: settings => request('setAgentSettings', [settings]),
    command(name, args = {}) {
      // Invoke against this webview, so only the settings window starts dragging.
      if (name === 'start_window_drag') return nativeInvoke(name).then(() => copy(runtime));
      return request('command', [name, args]);
    },
    reportError(error) {
      const message = errorText(error);
      runtime = { ...runtime, lastError: message };
      onState?.(copy(runtime));
      void request('reportError', [message]).catch(() => {});
      return message;
    },
    destroy: dispose,
  };
}
