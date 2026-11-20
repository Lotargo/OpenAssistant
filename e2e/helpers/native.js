import { expect } from '@playwright/test';

const nativeWindows = new WeakMap();

async function routeWindowEvent(record, { target, event, payload }) {
  // Tauri emit_to visits every WebView: Any listeners also receive sibling
  // window events. The registered listener target, not its owner, filters them.
  await Promise.all([record.main, record.settings, record.notification].filter(view => view && !view.isClosed()).map(view =>
    view.evaluate(packet => window.__receiveNativeEvent?.(packet.event, packet.payload, packet.target),
      { target, event, payload })));

}

async function installSettingsWindow(page, record) {
  await page.setViewportSize({ width: 860, height: 690 });
  // Tauri PageLoadEvent::Started invalidates only a local check on child reload.
  await page.exposeFunction('__settingsPageStarted', () => record.main.isClosed() ? undefined
    : record.main.evaluate(() => window.__nativeContract.invalidateAudioTest()));
  await page.exposeFunction('__routeNativeEvent', packet => routeWindowEvent(record, packet));
  await page.exposeFunction('__settingsNativeInvoke', async ({ name, args }) => {
    if (record.main.isClosed()) throw new Error('Main owner is closed');
    return record.main.evaluate(({ name, args }) => {
      if (['start_window_drag', 'get_window_activity'].includes(name)) {
        return window.__TAURI_INTERNALS__.invoke(name, args, 'settings');
      }
      if (name === 'set_settings_open') return window.__TAURI_INTERNALS__.invoke(name, args);
      throw new Error('Unexpected direct native command from settings: ' + name);
    }, { name, args });
  });
  await page.addInitScript(() => {
    window.isTauri = true;
    void window.__settingsPageStarted();
    const callbacks = new Map();
    const listeners = new Map();
    let nextCallback = 1;
    window.__settingsNativeCalls = [];
    window.__receiveNativeEvent = (event, payload, target = { kind: 'Any' }) => {
      const emitted = typeof target === 'string' ? { kind: 'AnyLabel', label: target } : target;
      for (const listener of listeners.get(event) || []) {
        const registered = listener.target;
        const matches = emitted.kind === 'Any' || registered.kind === 'Any'
          || emitted.kind === 'AnyLabel' && emitted.label === registered.label
          || emitted.kind === registered.kind && emitted.label === registered.label;
        if (matches) callbacks.get(listener.id)?.({ event, id: listener.id, payload });
      }
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'settings' }, currentWebview: { label: 'settings' } },
      transformCallback(callback, once = false) {
        const id = nextCallback++;
        callbacks.set(id, payload => { if (once) callbacks.delete(id); callback(payload); });
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(name, args = {}) {
        window.__settingsNativeCalls.push({ name, args: { ...args } });
        if (name === 'plugin:event|listen') {
          const ids = listeners.get(args.event) || [];
          ids.push({ id: args.handler, target: args.target || { kind: 'Any' } }); listeners.set(args.event, ids);
          return args.handler;
        }
        if (name === 'plugin:event|unlisten') {
          listeners.set(args.event, (listeners.get(args.event) || []).filter(listener => listener.id !== args.eventId));
          return null;
        }
        if (name === 'plugin:event|emit_to') return window.__routeNativeEvent(args);
        return window.__settingsNativeInvoke({ name, args });
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { callbacks.delete(id); } };
  });
}


async function installNotificationWindow(page, record) {
  await page.setViewportSize({ width: 420, height: 200 });
  await page.exposeFunction('__notificationNativeInvoke', async ({ name, args }) => {
    if (record.main.isClosed()) throw new Error('Main owner is closed');
    if (!['notification_ready', 'notification_present', 'notification_dismissed'].includes(name)) {
      throw new Error('Unexpected native command from notification: ' + name);
    }
    return record.main.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args, 'notification'), { name, args });
  });
  await page.addInitScript(() => {
    window.isTauri = true;
    const callbacks = new Map();
    const listeners = new Map();
    let nextCallback = 1;
    window.__notificationNativeCalls = [];
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.nativeVisible = 'false'; }, { once: true });
    window.__receiveNativeEvent = (event, payload, target = { kind: 'Any' }) => {
      const emitted = typeof target === 'string' ? { kind: 'AnyLabel', label: target } : target;
      for (const listener of listeners.get(event) || []) {
        const registered = listener.target;
        const matches = emitted.kind === 'Any' || registered.kind === 'Any'
          || emitted.kind === 'AnyLabel' && emitted.label === registered.label
          || emitted.kind === registered.kind && emitted.label === registered.label;
        if (matches) callbacks.get(listener.id)?.({ event, id: listener.id, payload });
      }
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'notification' }, currentWebview: { label: 'notification' } },
      transformCallback(callback, once = false) {
        const id = nextCallback++;
        callbacks.set(id, payload => { if (once) callbacks.delete(id); callback(payload); });
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(name, args = {}) {
        window.__notificationNativeCalls.push({ name, args: { ...args } });
        if (name === 'plugin:event|listen') {
          const ids = listeners.get(args.event) || [];
          ids.push({ id: args.handler, target: args.target || { kind: 'Any' } });
          listeners.set(args.event, ids);
          return args.handler;
        }
        if (name === 'plugin:event|unlisten') {
          listeners.set(args.event, (listeners.get(args.event) || []).filter(listener => listener.id !== args.eventId));
          return null;
        }
        return window.__notificationNativeInvoke({ name, args });
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { callbacks.delete(id); } };
  });
}

/** Return the separate, non-interactive notification view; no native input is used. */
export async function notificationPage(page) {
  const record = nativeWindows.get(page);
  if (!record) throw new Error('openNative must be called first');
  await expect.poll(() => Boolean(record.notification)).toBe(true);
  if (record.notificationPromise) await record.notificationPromise;
  await expect(record.notification.locator('html')).toHaveAttribute('data-ready', 'true');
  return record.notification;
}

/** Return the independent settings webview created by the native open command. */
export async function settingsPage(page) {
  const record = nativeWindows.get(page);
  if (!record) throw new Error('openNative must be called first');
  await expect.poll(() => Boolean(record.settings)).toBe(true);
  if (record.settingsPromise) await record.settingsPromise;
  await expect(record.settings.locator('html')).toHaveAttribute('data-ready', 'true');
  return record.settings;
}


/**
 * Offline Tauri IPC fixture. Production bridge, Channel, settings and geometry run
 * unchanged. This verifies transport/UI contracts, not Windows focus or hooks.
 * No Codex process, network provider or physical microphone is used.
 */
export async function openNative(page, options = {}) {
  const record = { main: page, settings: null, settingsPromise: null, notification: null, notificationPromise: null };
  nativeWindows.set(page, record);
  await page.exposeFunction('__routeNativeEvent', packet => routeWindowEvent(record, packet));
  await page.exposeFunction('__setSettingsNativeOpen', async open => {
    if (open && !record.settings) {
      record.settingsPromise = (async () => {
        const child = await page.context().newPage();
        record.settings = child;
        nativeWindows.set(child, record);
        await installSettingsWindow(child, record);
        await child.goto('/settings.html');
        return child;
      })();
      await record.settingsPromise;
    }
    if (record.settings && !record.settings.isClosed()) {
      await record.settings.evaluate(visible => { document.documentElement.dataset.nativeVisible = String(visible); }, open);
      if (record.settingsVisible !== open) {
        record.settingsVisible = open;
        await routeWindowEvent(record, { target: 'settings', event: 'overlay:window-activity', payload: { active: open } });
      }
    }
  });
  await page.exposeFunction('__ensureNotificationWindow', async () => {
    if (!record.notification || record.notification.isClosed()) {
      record.notificationPromise = (async () => {
        const child = await page.context().newPage();
        record.notification = child;
        nativeWindows.set(child, record);
        await installNotificationWindow(child, record);
        await child.goto('/notification.html');
        return child;
      })();
    }
    if (record.notificationPromise) await record.notificationPromise;
  });
  await page.exposeFunction('__setNotificationVisible', async ({ visible, height }) => {
    const child = record.notification;
    if (!child || child.isClosed()) return;
    if (visible && height) await child.setViewportSize({ width: 420, height });
    await child.evaluate(value => { document.documentElement.dataset.nativeVisible = String(value); }, visible);
  });
  await page.exposeFunction('__applyNativeSize', async ({ width, height }) => {
    await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
  });
  await page.addInitScript((options) => {
    window.isTauri = true;
    Object.defineProperty(screen, 'availWidth', { configurable: true, get: () => 1440 });
    Object.defineProperty(screen, 'availHeight', { configurable: true, get: () => 1000 });
    let nextCallback = 1;
    let nextSession = 1;
    let nextTask = 1;
    let nextCapture = 1;
    let audioDevices = options.audioDevices || [
      { id: 'fixture-default', name: 'Fixture Microphone', is_default: true },
      { id: 'fixture-usb', name: 'USB Microphone', is_default: false },
    ];
    let systemAudioDevices = options.systemAudioDevices || [
      { id: 'fixture-speakers', name: 'Meeting Speakers', is_default: true },
      { id: 'fixture-headphones', name: 'Meeting Headphones', is_default: false },
    ];
    let workspaceState = options.workspaceState || null;
    const workspaceChoices = [...(options.workspaceChoices || [])];
    let state = {
      revision: 1, microphoneMuted: true, screenCaptureEnabled: false,
      scrollLocked: false, settingsOpen: false, windowMode: 'overlay', connectionStatus: 'idle',
      audioAvailable: false, screenCaptureAvailable: false, liveAvailable: false,
      nativeWindow: true, nativeWheelRouting: true, platform: 'windows', lastError: '',
    };
    const callbacks = new Map();
    const listeners = new Map();
    const delayed = new Map();
    const failures = new Map();
    const pending = [];
    const delayedExecution = new Map();
    const pendingExecution = [];
    const storeKey = 'openassistant.native-contract.store';
    const persisted = sessionStorage.getItem(storeKey);
    const values = new Map(persisted ? JSON.parse(persisted) : Object.entries(options.storeValues || {}));
    const sessions = new Map();
    const tasks = new Map();
    const captures = new Map();
    let notification = null;
    let notificationWanted = false;
    let notificationVisible = false;
    function stopBoundCaptures(sessionId, broadcastId) {
      for (const capture of captures.values()) {
        if (capture.active && capture.mode !== 'test' && capture.sessionId === sessionId && capture.broadcastId === broadcastId) {
          capture.active = false;
          harness.emitAudio(capture.id, { type: 'stopped', reason: 'invalidated' });
        }
      }
    }
    function closeIdleSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session?.active || session.broadcast?.stage !== 'ended'
        || [...tasks.values()].some(task => task.sessionId === sessionId && task.status === 'running')) return;
      session.active = false;
      if (workspaceState?.path === session.workspace) {
        workspaceState = { ...workspaceState, cleanup_status: workspaceState.temporary ? 'removed' : 'preserved' };
        harness.emitSession(sessionId, { type: 'workspace_state', ...workspaceState });
      }
      harness.emitSession(sessionId, { type: 'session_closed', message: 'Эфир завершён.' });
    }
    let models = options.models || [
      { id: 'fixture-codex', display_name: 'Fixture Codex', description: 'General fixture model', is_default: true, reasoning_efforts: ['medium', 'high'], default_effort: 'medium' },
      { id: 'fixture-codex-small', display_name: 'Fixture Small', description: 'Small fixture model', is_default: false, reasoning_efforts: ['low', 'medium'], default_effort: 'low' },
    ];
    const harness = {
      calls: [], resizes: [], saves: [], agentSaves: [], windowModeSaves: [], dragStarts: [], sessionIds: [], events: [],
      messages: [], audio: [], audioStarts: [], audioStops: [], audioNoiseChanges: [], audioSaves: [], captureIds: [], pending, applyResizes: true,
      systemAudioStarts: [], systemAudioStops: [], clipboardWrites: [], workspaceChoices,
      broadcastStarts: [], broadcastStops: [], voiceOpens: [], voiceCloses: [], pendingExecution,
      notificationShows: [], notificationHides: [], notificationThemes: [], notificationPresentations: [], notificationDismissals: [],
      getNotification() { return { notification: notification ? structuredClone(notification) : null, wanted: notificationWanted, visible: notificationVisible }; },
      setModels(next) { models = structuredClone(next); },
      queueWorkspaceChoice(path) { workspaceChoices.push(path); },
      getWorkspaceState() { return structuredClone(workspaceState); },
      getState() { return { ...state }; },
      invalidateAudioTest() {
        for (const capture of captures.values()) {
          if (capture.active && capture.mode === 'test') {
            capture.active = false;
            harness.emitAudio(capture.id, { type: 'stopped', reason: 'invalidated' });
          }
        }
      },
      async closeSettingsWindow() {
        harness.invalidateAudioTest();
        harness.pushState({ settingsOpen: false });
        await window.__setSettingsNativeOpen(false);
      },
      setAudioDevices(devices) { audioDevices = structuredClone(devices); },
      setSystemAudioDevices(devices) { systemAudioDevices = structuredClone(devices); },
      emitAudio(captureId, event) {
        const capture = captures.get(captureId);
        if (!capture) throw new Error('Unknown fixture capture ' + captureId);
        const callback = callbacks.get(capture.channel.id);
        if (!callback) throw new Error('Audio Channel callback is not registered');
        callback({ message: { capture_id: captureId, ...(capture.source === 'system' ? { source: 'system' } : {}), ...event }, index: capture.index++ });
      },
      lastCapture(source = 'microphone') {
        const capture = [...captures.values()].filter(item => item.source === source).at(-1);
        return capture ? { id: capture.id, channelId: capture.channel.id, mode: capture.mode, active: capture.active, noiseSuppression: capture.noiseSuppression } : null;
      },
      delayNext(name) { delayed.set(name, (delayed.get(name) || 0) + 1); },
      delayBefore(name) { delayedExecution.set(name, (delayedExecution.get(name) || 0) + 1); },
      releaseBefore(name) {
        const index = pendingExecution.findIndex(item => item.name === name);
        if (index < 0) throw new Error('No pending ' + name + ' execution');
        pendingExecution.splice(index, 1)[0].resolve();
      },
      failNext(name, message = 'Fixture command failed') { failures.set(name, message); },
      release(name) {
        const index = pending.findIndex(item => item.name === name);
        if (index < 0) throw new Error('No pending ' + name + ' reply');
        const [item] = pending.splice(index, 1);
        if (item.failure) item.reject(item.failure);
        else item.resolve(item.value);
      },
      emit(event, payload, target = { kind: 'Any' }) {
        const emitted = typeof target === 'string' ? { kind: 'AnyLabel', label: target } : target;
        for (const listener of listeners.get(event) || []) {
          const registered = listener.target;
          const matches = emitted.kind === 'Any' || registered.kind === 'Any'
            || emitted.kind === 'AnyLabel' && emitted.label === registered.label
            || emitted.kind === registered.kind && emitted.label === registered.label;
          if (matches) callbacks.get(listener.id)?.({ event, id: listener.id, payload });
        }
      },
      emitTo(target, event, payload) {
        return window.__routeNativeEvent({ target, event, payload });
      },
      pushState(patch) {
        state = { ...state, ...patch, revision: state.revision + 1 };
        harness.emit('overlay:state', { ...state });
        return { ...state };
      },
      emitSession(sessionId, message) {
        const session = sessions.get(sessionId);
        if (!session) throw new Error('Unknown fixture session ' + sessionId);
        harness.events.push({ sessionId, ...structuredClone(message) });
        // Dispatch through the real Tauri Channel callback, including its index.
        // The session may deliberately be closed to exercise stale-event fencing.
        const callback = callbacks.get(session.channel.id);
        if (!callback) throw new Error('Tauri Channel callback is not registered');
        callback({ message, index: session.index++ });
      },
      readySession(sessionId) {
        const session = sessions.get(sessionId);
        harness.emitSession(sessionId, { type: 'agent_models', models });
        harness.emitSession(sessionId, { type: 'workspace_state', ...workspaceState });
        harness.emitSession(sessionId, {
          type: 'agent_state', stage: 'ready', detail: 'Codex подключён',
          workspace: session.workspace, workspace_mode: session.config.workspace_mode || 'temporary',
          model: session.config.model || models.find(model => model.is_default)?.id || '', effort: session.config.effort || 'medium',
        });
        harness.emitSession(sessionId, {
          type: 'status', stage: 'ready', realtime: false, detail: 'Codex · текстовый режим',
        });
      },
      readyBroadcast(sessionId) {
        const session = sessions.get(sessionId);
        if (!session?.active || session.broadcast?.stage !== 'starting') return false;
        const id = session.broadcast.id;
        session.broadcast.stage = 'live';
        harness.emitSession(sessionId, { type: 'status', stage: 'ready', realtime: true, detail: 'Realtime подключён', broadcast_id: id });
        harness.emitSession(sessionId, { type: 'broadcast_state', stage: 'live', broadcast_id: id });
        return true;
      },
      finishBroadcast(sessionId, reason = 'user', farewell = '') {
        const session = sessions.get(sessionId);
        if (!session?.active || !session.broadcast || session.broadcast.stage === 'ended') return false;
        const id = session.broadcast.id;
        session.broadcast.stage = 'stopping';
        harness.emitSession(sessionId, { type: 'broadcast_state', stage: 'stopping', broadcast_id: id, reason });
        stopBoundCaptures(sessionId, id);
        if (session.voiceOpen) harness.voiceCloses.push({ sessionId, broadcastId: id, reason });
        session.voiceOpen = false;
        session.broadcast.stage = 'ended';
        harness.emitSession(sessionId, { type: 'broadcast_state', stage: 'ended', broadcast_id: id, reason, ...(farewell ? { farewell } : {}) });
        queueMicrotask(() => closeIdleSession(sessionId));
        return true;
      },
      lastBroadcast() {
        const sessionId = harness.broadcastStarts.at(-1)?.sessionId;
        const session = sessions.get(sessionId);
        return session?.broadcast ? { sessionId, ...session.broadcast, voiceOpen: session.voiceOpen, sessionActive: session.active } : null;
      },
      lastTask() { return [...tasks.values()].at(-1); },
      finishTask(taskId, text = '', status = 'completed') {
        const task = tasks.get(taskId);
        if (!task) throw new Error('Unknown fixture task ' + taskId);
        task.status = status;
        harness.emitSession(task.sessionId, { type: 'agent_done', task_id: taskId, text, status });
        if (![...tasks.values()].some(item => item.sessionId === task.sessionId && item.status === 'running')) {
          harness.emitSession(task.sessionId, { type: 'agent_state', stage: 'ready', detail: 'Codex подключён' });
        }
        closeIdleSession(task.sessionId);
      },
    };
    window.__nativeContract = harness;
    window.__receiveNativeEvent = harness.emit;

    async function execute(name, args, windowLabel = 'main') {
      const recorded = { ...args };
      delete recorded.onEvent;
      harness.calls.push({ name, args: recorded });
      const typedKey = name === 'assistant_send' ? name + ':' + args.message?.type : name;
      const failureKey = failures.has(typedKey) ? typedKey : name;
      if (failures.has(failureKey)) {
        const message = failures.get(failureKey);
        failures.delete(failureKey);
        throw new Error(message);
      }
      switch (name) {
        case 'plugin:event|listen': {
          const ids = listeners.get(args.event) || [];
          ids.push({ id: args.handler, target: args.target || { kind: 'Any' } });
          listeners.set(args.event, ids);
          return args.handler;
        }
        case 'plugin:event|emit_to': return window.__routeNativeEvent(args);
        case 'plugin:event|unlisten':
          listeners.set(args.event, (listeners.get(args.event) || []).filter(listener => listener.id !== args.eventId));
          return null;
        case 'notification_show': {
          if (windowLabel !== 'main') throw new Error('Only the main view may show a notification');
          notification = structuredClone(args.notification);
          notificationWanted = true;
          harness.notificationShows.push(structuredClone(notification));
          const id = notification.id;
          await window.__ensureNotificationWindow();
          if (notificationWanted && notification?.id === id) await harness.emitTo('notification', 'notification:update', structuredClone(notification));
          return null;
        }
        case 'notification_hide': {
          if (windowLabel !== 'main') throw new Error('Only the main view may hide a notification');
          harness.notificationHides.push({ ...args });
          if (!notification || args.id != null && args.id !== notification.id) return null;
          notificationWanted = false;
          await harness.emitTo('notification', 'notification:hide', { id: notification.id });
          return null;
        }
        case 'notification_theme':
          if (windowLabel !== 'main') throw new Error('Only the main view may change the notification theme');
          harness.notificationThemes.push(structuredClone(args.theme));
          if (notification) notification.theme = structuredClone(args.theme);
          await harness.emitTo('notification', 'notification:theme', { theme: structuredClone(args.theme) });
          return null;
        case 'notification_ready':
          if (windowLabel !== 'notification') throw new Error('Only the notification view may request its payload');
          return { notification: notificationWanted ? structuredClone(notification) : null };
        case 'notification_present': {
          if (windowLabel !== 'notification') throw new Error('Only the notification view may present itself');
          const shown = notificationWanted && notification?.id === args.id;
          const height = Math.max(64, Math.min(200, Math.ceil(Number(args.height) || 100)));
          harness.notificationPresentations.push({ id: args.id, shown, width: 420, height });
          if (shown) {
            notificationVisible = true;
            await window.__setNotificationVisible({ visible: true, height });
          }
          return { shown, width: 420, height };
        }
        case 'notification_dismissed': {
          if (windowLabel !== 'notification') throw new Error('Only the notification view may finish dismissal');
          const dismissed = notification?.id === args.id;
          harness.notificationDismissals.push({ id: args.id, dismissed });
          if (dismissed) {
            notification = null;
            notificationWanted = false;
            notificationVisible = false;
            await window.__setNotificationVisible({ visible: false });
          }
          return dismissed;
        }
        case 'get_runtime_state': return { ...state };
        case 'get_window_activity': return { active: true };
        case 'set_scroll_locked': return harness.pushState({ scrollLocked: args.locked });
        case 'set_window_mode':
          if (!['overlay', 'standard'].includes(args.mode)) throw new Error('Invalid window mode');
          return harness.pushState({ windowMode: args.mode });
        case 'start_window_drag':
          harness.dragStarts.push({ windowLabel, windowMode: state.windowMode, settingsOpen: state.settingsOpen });
          return null;
        case 'set_microphone_muted': return harness.pushState({ microphoneMuted: args.muted });
        case 'sync_audio_state': return harness.pushState({ microphoneMuted: args.muted, audioAvailable: args.available });
        case 'set_settings_open': {
          const next = harness.pushState({ settingsOpen: args.open });
          await window.__setSettingsNativeOpen(args.open);
          return next;
        }
        case 'resize_overlay':
          harness.resizes.push({ width: args.width, height: args.height });
          if (harness.applyResizes) await window.__applyNativeSize(args);
          return { width: innerWidth, height: innerHeight };
        case 'update_hit_rects':
          harness.hitRects = args.rects;
          return null;
        case 'audio_input_state':
          return { devices: structuredClone(audioDevices), available: audioDevices.length > 0 };
        case 'system_audio_state':
          return { devices: structuredClone(systemAudioDevices), available: systemAudioDevices.length > 0 };
        case 'audio_start':
        case 'system_audio_start': {
          const source = name === 'system_audio_start' ? 'system' : 'microphone';
          if (args.mode !== 'test') {
            const owner = sessions.get(args.sessionId);
            if (!owner?.active || owner.broadcast?.stage !== 'live' || args.broadcastId !== owner.broadcast.id) {
              throw new Error('Эфир завершён или не готов к захвату звука.');
            }
          } else if (args.sessionId != null || args.broadcastId != null) throw new Error('Local microphone checks must not bind to a broadcast.');
          const devices = source === 'system' ? systemAudioDevices : audioDevices;
          const device = args.deviceId ? devices.find(item => item.id === args.deviceId)
            : devices.find(item => item.is_default);
          if (!device) throw new Error(source === 'system' ? 'Устройство вывода недоступно.' : 'Выбранный микрофон недоступен.');
          const id = nextCapture++;
          for (const previous of captures.values()) {
            if (previous.active && previous.source === source) {
              previous.active = false;
              harness.emitAudio(previous.id, { type: 'stopped', reason: 'replaced' });
            }
          }
          captures.set(id, { id, source, channel: args.onEvent, index: 0, active: true, mode: args.mode, noiseSuppression: args.noiseSuppression, sessionId: args.sessionId, broadcastId: args.broadcastId });
          harness.captureIds.push(id);
          const starts = source === 'system' ? harness.systemAudioStarts : harness.audioStarts;
          starts.push({ captureId: id, mode: args.mode, deviceId: args.deviceId, noiseSuppression: args.noiseSuppression, ...(args.mode !== 'test' ? { sessionId: args.sessionId, broadcastId: args.broadcastId } : {}) });
          queueMicrotask(() => harness.emitAudio(id, { type: 'started', device_id: device.id, device_name: device.name }));
          return id;
        }
        case 'audio_set_noise_suppression': {
          const capture = captures.get(args.captureId);
          if (!capture?.active) throw new Error('Audio capture is closed');
          capture.noiseSuppression = args.enabled;
          harness.audioNoiseChanges.push({ captureId: args.captureId, enabled: args.enabled });
          return null;
        }
        case 'audio_stop':
        case 'system_audio_stop': {
          const source = name === 'system_audio_stop' ? 'system' : 'microphone';
          (source === 'system' ? harness.systemAudioStops : harness.audioStops).push(args.captureId);
          const capture = captures.get(args.captureId);
          if (capture?.active && capture.source === source) {
            capture.active = false;
            harness.emitAudio(capture.id, { type: 'stopped', reason: 'requested' });
          }
          return null;
        }
        case 'assistant_models': return { models: structuredClone(models) };
        case 'assistant_choose_workspace': return workspaceChoices.length ? workspaceChoices.shift() : null;
        case 'assistant_workspace_state': return structuredClone(workspaceState);
        case 'assistant_cleanup_workspaces': {
          const active = workspaceState?.temporary && workspaceState.cleanup_status === 'active' ? 1 : 0;
          const removed = workspaceState?.temporary && workspaceState.cleanup_status === 'pending' ? 1 : 0;
          if (removed) workspaceState = { ...workspaceState, cleanup_status: 'removed' };
          return { removed, pending: 0, active };
        }
        case 'assistant_status':
          return { codex_available: true, oauth: 'available', workspace: 'F:\\fixture-workspace', mode: 'real' };
        case 'assistant_connect': {
          const id = nextSession++;
          const temporary = args.config.workspace_mode !== 'project';
          const workspace = temporary ? 'F:\\fixture-temporary\\session-' + id : args.config.workspace;
          workspaceState = { workspace_mode: temporary ? 'temporary' : 'project', path: workspace, temporary, cleanup_status: 'active' };
          sessions.set(id, { channel: args.onEvent, index: 0, config: structuredClone(args.config), workspace, active: true, broadcast: null, voiceOpen: false });
          harness.sessionIds.push(id);
          if (options.autoReady !== false) queueMicrotask(() => harness.readySession(id));
          return id;
        }
        case 'assistant_send': {
          const session = sessions.get(args.sessionId);
          if (!session?.active) throw new Error('Session is closed');
          const message = structuredClone(args.message);
          harness.messages.push({ sessionId: args.sessionId, ...message });
          if (message.type === 'broadcast_start') {
            if (!session.config.realtime) throw new Error('Голосовое подключение выключено.');
            if (session.broadcast || typeof message.broadcast_id !== 'string' || !message.broadcast_id) throw new Error('Для нового эфира нужна новая сессия.');
            const id = message.broadcast_id;
            session.broadcast = { id, stage: 'starting' };
            session.voiceOpen = true;
            harness.broadcastStarts.push({ sessionId: args.sessionId, broadcastId: id });
            const meeting = session.config.scenario === 'interview' || session.config.scenario === 'custom' && session.config.custom_behavior !== 'dialogue';
            harness.voiceOpens.push({ sessionId: args.sessionId, broadcastId: id, sources: meeting ? ['microphone', 'system'] : ['microphone'] });
            harness.emitSession(args.sessionId, { type: 'broadcast_state', stage: 'starting', broadcast_id: id });
            harness.emitSession(args.sessionId, { type: 'status', stage: 'connecting', realtime: true, broadcast_id: id });
            if (options.autoVoiceReady !== false) queueMicrotask(() => harness.readyBroadcast(args.sessionId));
          } else if (message.type === 'broadcast_stop') {
            if (!session.broadcast || message.broadcast_id !== session.broadcast.id) throw new Error('Устаревший эфир.');
            harness.broadcastStops.push({ sessionId: args.sessionId, broadcastId: message.broadcast_id });
            harness.finishBroadcast(args.sessionId, 'user', 'Эфир завершён. Нажмите «Эфир», чтобы начать снова.');
          } else if (['mic_start', 'mic_stop', 'system_start', 'system_stop', 'interview_start', 'interview_stop'].includes(message.type)) {
            if (!session.broadcast || message.broadcast_id !== session.broadcast.id) throw new Error('Голосовая команда не привязана к текущему эфиру.');
          } else if (message.type === 'agent_task') {
            const taskId = 'fixture-task-' + nextTask++;
            tasks.set(taskId, { task_id: taskId, sessionId: args.sessionId, task: message.task, status: 'running' });
            harness.emitSession(args.sessionId, { type: 'agent_state', stage: 'running', detail: 'Codex выполняет задачу' });
            harness.emitSession(args.sessionId, {
              type: 'agent_task_started', task_id: taskId, thread_id: 'thread-' + taskId, task: message.task,
            });
            harness.emitSession(args.sessionId, {
              type: 'agent_activity', task_id: taskId, item_id: taskId + '-command',
              kind: 'command', title: 'Проверка проекта', detail: 'fixture command', status: 'running',
            });
          } else if (message.type === 'agent_interrupt') {
            for (const task of tasks.values()) {
              if (task.sessionId === args.sessionId && task.status === 'running' && (!message.task_id || task.task_id === message.task_id)) {
                harness.finishTask(task.task_id, '', 'interrupted');
              }
            }
          } else if (message.type === 'agent_approval') {
            harness.emitSession(args.sessionId, { type: 'agent_approval_resolved', request_id: message.request_id });
          } else if (message.type === 'agent_input') {
            harness.emitSession(args.sessionId, { type: 'agent_input_resolved', request_id: message.request_id });
          }
          return null;
        }
        case 'clipboard_write_text':
          harness.clipboardWrites.push(args.text);
          return null;
        case 'assistant_audio': {
          const session = sessions.get(args.sessionId);
          if (!session?.active || session.broadcast?.stage !== 'live' || args.broadcastId !== session.broadcast.id) throw new Error('Audio belongs to a closed broadcast');
          harness.audio.push({ sessionId: args.sessionId, broadcastId: args.broadcastId, bytes: args.audio.length, source: args.source || 'microphone' });
          return null;
        }
        case 'assistant_disconnect': {
          const session = sessions.get(args.sessionId);
          if (session) {
            session.active = false;
            if (session.broadcast) {
              stopBoundCaptures(args.sessionId, session.broadcast.id);
              if (session.voiceOpen) harness.voiceCloses.push({ sessionId: args.sessionId, broadcastId: session.broadcast.id, reason: 'disconnect' });
              session.voiceOpen = false;
            }
          }
          if (session && workspaceState?.path === session.workspace) {
            workspaceState = { ...workspaceState, cleanup_status: workspaceState.temporary ? 'removed' : 'preserved' };
            harness.emitSession(args.sessionId, { type: 'workspace_state', ...workspaceState });
          }
          return null;
        }
        case 'plugin:store|load': return 1;
        case 'plugin:store|get': return [values.get(args.key) ?? null, values.has(args.key)];
        case 'plugin:store|set':
          values.set(args.key, structuredClone(args.value));
          return null;
        case 'plugin:store|save':
          harness.saves.push(structuredClone(values.get('appearance')));
          harness.agentSaves.push(structuredClone(values.get('agent')));
          harness.audioSaves.push(structuredClone(values.get('audio')));
          harness.windowModeSaves.push(structuredClone(values.get('windowMode')));
          sessionStorage.setItem(storeKey, JSON.stringify([...values]));
          return null;
        default: throw new Error('Unexpected native command in contract test: ' + name);
      }
    }

    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback, once = false) {
        const id = nextCallback++;
        callbacks.set(id, payload => {
          if (once) callbacks.delete(id);
          callback(payload);
        });
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(name, args = {}, windowLabel = 'main') {
        const typedKey = name === 'assistant_send' ? name + ':' + args.message?.type : name;
        const executionKey = delayedExecution.get(typedKey) > 0 ? typedKey : name;
        if ((delayedExecution.get(executionKey) || 0) > 0) {
          delayedExecution.set(executionKey, delayedExecution.get(executionKey) - 1);
          await new Promise(resolve => pendingExecution.push({ name: executionKey, resolve }));
        }
        const replyKey = delayed.get(typedKey) > 0 ? typedKey : name;
        const hold = (delayed.get(replyKey) || 0) > 0;
        if (hold) delayed.set(replyKey, delayed.get(replyKey) - 1);
        let value;
        let failure;
        try { value = await execute(name, args, windowLabel); }
        catch (error) { failure = error; }
        if (hold) return new Promise((resolve, reject) => pending.push({ name: replyKey, value, failure, resolve, reject }));
        if (failure) throw failure;
        return value;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event, id) { callbacks.delete(id); },
    };
  }, options);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).not.toHaveClass(/browser-preview/);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.resizes.length)).toBeGreaterThan(0);
}

export async function openSettingsTab(page, tab = 'appearance') {
  const record = nativeWindows.get(page);
  if (!record?.settings || !await record.settings.locator('#settings-dialog').isVisible()) {
    await record.main.locator('[data-action="settings"]').click();
  }
  const settings = await settingsPage(page);
  await settings.locator('#tab-' + tab).click();
  return settings;
}

export async function openAgent(page) {
  return openSettingsTab(page, 'agent');
}

export async function setPressed(button, pressed) {
  await expect(button).toHaveAttribute('aria-pressed', /^(true|false)$/);
  if (await button.getAttribute('aria-pressed') !== String(pressed)) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(pressed));
}

export async function connectAgent(page, { realtime = false } = {}) {
  const settings = await openAgent(page);
  await setPressed(settings.locator('#agent-realtime'), realtime);
  await settings.locator('#agent-connect').click();
  await expect(settings.locator('#agent-connect')).toHaveText('Переподключить');
  await expect(settings.locator('#agent-model option')).toHaveCount(3);
  return page.evaluate(() => window.__nativeContract.sessionIds.at(-1));
}


export async function setScenario(page, scenario) {
  const cycle = ['assistant', 'interview', 'custom'];
  if (!cycle.includes(scenario)) throw new Error('Unknown fixture scenario ' + scenario);
  const button = page.locator('#mode-btn');
  for (let step = 0; step < cycle.length; step++) {
    const current = await button.getAttribute('data-current-scenario');
    if (current === scenario) return;
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    await button.click();
    await expect(button).toHaveAttribute('data-current-scenario', next);
  }
  await expect(button).toHaveAttribute('data-current-scenario', scenario);
}

export async function startBroadcast(page, { scenario } = {}) {
  if (scenario) await setScenario(page, scenario);
  await page.locator('#broadcast-btn').click();
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'live');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(true);
  return page.evaluate(() => window.__nativeContract.lastBroadcast());
}

export async function sendTask(page, text) {
  const settings = await openAgent(page);
  await settings.locator('#agent-prompt').fill(text);
  await settings.locator('#agent-send').click();
  await expect(settings.locator('#settings-dialog')).toBeHidden();
  return page.evaluate(() => window.__nativeContract.lastTask());
}

export async function emitSession(page, sessionId, event) {
  await page.evaluate(({ sessionId, event }) => window.__nativeContract.emitSession(sessionId, event), { sessionId, event });
}
