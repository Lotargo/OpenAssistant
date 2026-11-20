import { expect } from '@playwright/test';

/**
 * Offline Tauri IPC fixture. Production bridge, Channel, settings and geometry run
 * unchanged. This verifies transport/UI contracts, not Windows focus or hooks.
 * No Codex process, network provider or physical microphone is used.
 */
export async function openNative(page, options = {}) {
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
    let state = {
      revision: 1, microphoneMuted: true, screenCaptureEnabled: false,
      scrollLocked: false, settingsOpen: false, connectionStatus: 'idle',
      audioAvailable: false, screenCaptureAvailable: false, liveAvailable: false,
      nativeWindow: true, nativeWheelRouting: true, platform: 'windows', lastError: '',
    };
    const callbacks = new Map();
    const listeners = new Map();
    const delayed = new Map();
    const failures = new Map();
    const pending = [];
    const values = new Map();
    const sessions = new Map();
    const tasks = new Map();
    const captures = new Map();
    const models = [
      { id: 'fixture-codex', display_name: 'Fixture Codex', is_default: true, reasoning_efforts: ['medium', 'high'] },
      { id: 'fixture-codex-small', display_name: 'Fixture Small', is_default: false, reasoning_efforts: ['low', 'medium'] },
    ];
    const harness = {
      calls: [], resizes: [], saves: [], agentSaves: [], sessionIds: [], events: [],
      messages: [], audio: [], audioStarts: [], audioStops: [], audioNoiseChanges: [], audioSaves: [], captureIds: [], pending, applyResizes: true,
      setAudioDevices(devices) { audioDevices = structuredClone(devices); },
      emitAudio(captureId, event) {
        const capture = captures.get(captureId);
        if (!capture) throw new Error('Unknown fixture capture ' + captureId);
        const callback = callbacks.get(capture.channel.id);
        if (!callback) throw new Error('Audio Channel callback is not registered');
        callback({ message: { capture_id: captureId, ...event }, index: capture.index++ });
      },
      lastCapture() {
        const capture = [...captures.values()].at(-1);
        return capture ? { id: capture.id, channelId: capture.channel.id, mode: capture.mode, active: capture.active, noiseSuppression: capture.noiseSuppression } : null;
      },
      delayNext(name) { delayed.set(name, (delayed.get(name) || 0) + 1); },
      failNext(name, message = 'Fixture command failed') { failures.set(name, message); },
      release(name) {
        const index = pending.findIndex(item => item.name === name);
        if (index < 0) throw new Error('No pending ' + name + ' reply');
        const [item] = pending.splice(index, 1);
        if (item.failure) item.reject(item.failure);
        else item.resolve(item.value);
      },
      emit(event, payload) {
        for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, id, payload });
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
        harness.emitSession(sessionId, {
          type: 'agent_state', stage: 'ready', detail: 'Codex подключён',
          workspace: session.config.workspace, model: 'fixture-codex', effort: 'medium',
        });
        harness.emitSession(sessionId, {
          type: 'status', stage: session.config.realtime ? 'ready' : 'disabled',
          detail: session.config.realtime ? 'Realtime подключён' : 'Только текстовый Codex',
        });
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
      },
    };
    window.__nativeContract = harness;

    async function execute(name, args) {
      const recorded = { ...args };
      delete recorded.onEvent;
      harness.calls.push({ name, args: recorded });
      if (failures.has(name)) {
        const message = failures.get(name);
        failures.delete(name);
        throw new Error(message);
      }
      switch (name) {
        case 'plugin:event|listen': {
          const ids = listeners.get(args.event) || [];
          ids.push(args.handler);
          listeners.set(args.event, ids);
          return args.handler;
        }
        case 'plugin:event|unlisten':
          listeners.set(args.event, (listeners.get(args.event) || []).filter(id => id !== args.eventId));
          return null;
        case 'get_runtime_state': return { ...state };
        case 'set_scroll_locked': return harness.pushState({ scrollLocked: args.locked });
        case 'set_microphone_muted': return harness.pushState({ microphoneMuted: args.muted });
        case 'sync_audio_state': return harness.pushState({ microphoneMuted: args.muted, audioAvailable: args.available });
        case 'set_settings_open': return harness.pushState({ settingsOpen: args.open });
        case 'resize_overlay':
          harness.resizes.push({ width: args.width, height: args.height });
          if (harness.applyResizes) await window.__applyNativeSize(args);
          return { width: innerWidth, height: innerHeight };
        case 'update_hit_rects':
          harness.hitRects = args.rects;
          return null;
        case 'audio_input_state':
          return { devices: structuredClone(audioDevices), available: audioDevices.length > 0 };
        case 'audio_start': {
          const device = args.deviceId ? audioDevices.find(item => item.id === args.deviceId)
            : audioDevices.find(item => item.is_default);
          if (!device) throw new Error('Выбранный микрофон недоступен.');
          const id = nextCapture++;
          for (const previous of captures.values()) {
            if (previous.active) {
              previous.active = false;
              harness.emitAudio(previous.id, { type: 'stopped', reason: 'replaced' });
            }
          }
          captures.set(id, { id, channel: args.onEvent, index: 0, active: true, mode: args.mode, noiseSuppression: args.noiseSuppression });
          harness.captureIds.push(id);
          harness.audioStarts.push({ captureId: id, mode: args.mode, deviceId: args.deviceId, noiseSuppression: args.noiseSuppression });
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
        case 'audio_stop': {
          harness.audioStops.push(args.captureId);
          const capture = captures.get(args.captureId);
          if (capture?.active) {
            capture.active = false;
            harness.emitAudio(capture.id, { type: 'stopped', reason: 'requested' });
          }
          return null;
        }
        case 'assistant_status':
          return { codex_available: true, oauth: 'available', workspace: 'F:\\fixture-workspace', mode: 'real' };
        case 'assistant_connect': {
          const id = nextSession++;
          sessions.set(id, { channel: args.onEvent, index: 0, config: structuredClone(args.config), active: true });
          harness.sessionIds.push(id);
          if (options.autoReady !== false) queueMicrotask(() => harness.readySession(id));
          return id;
        }
        case 'assistant_send': {
          const session = sessions.get(args.sessionId);
          if (!session?.active) throw new Error('Session is closed');
          const message = structuredClone(args.message);
          harness.messages.push({ sessionId: args.sessionId, ...message });
          if (message.type === 'agent_task') {
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
        case 'assistant_audio':
          if (!sessions.get(args.sessionId)?.active) throw new Error('Session is closed');
          harness.audio.push({ sessionId: args.sessionId, bytes: args.audio.length });
          return null;
        case 'assistant_disconnect':
          if (sessions.has(args.sessionId)) sessions.get(args.sessionId).active = false;
          return null;
        case 'plugin:store|load': return 1;
        case 'plugin:store|get': return [values.get(args.key) ?? null, values.has(args.key)];
        case 'plugin:store|set':
          values.set(args.key, structuredClone(args.value));
          return null;
        case 'plugin:store|save':
          harness.saves.push(structuredClone(values.get('appearance')));
          harness.agentSaves.push(structuredClone(values.get('agent')));
          harness.audioSaves.push(structuredClone(values.get('audio')));
          return null;
        default: throw new Error('Unexpected native command in contract test: ' + name);
      }
    }

    window.__TAURI_INTERNALS__ = {
      transformCallback(callback, once = false) {
        const id = nextCallback++;
        callbacks.set(id, payload => {
          if (once) callbacks.delete(id);
          callback(payload);
        });
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(name, args = {}) {
        const hold = (delayed.get(name) || 0) > 0;
        if (hold) delayed.set(name, delayed.get(name) - 1);
        let value;
        let failure;
        try { value = await execute(name, args); }
        catch (error) { failure = error; }
        if (hold) return new Promise((resolve, reject) => pending.push({ name, value, failure, resolve, reject }));
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

export async function openAgent(page) {
  if (!await page.locator('#settings-dialog').isVisible()) await page.locator('[data-action="settings"]').click();
  await page.getByRole('tab', { name: 'Агент', exact: true }).click();
}

export async function connectAgent(page, { realtime = false } = {}) {
  await openAgent(page);
  await page.locator('#agent-realtime').setChecked(realtime);
  await page.locator('#agent-connect').click();
  await expect(page.locator('#agent-connect')).toHaveText('Переподключить');
  await expect(page.locator('#agent-model option')).toHaveCount(3);
  return page.evaluate(() => window.__nativeContract.sessionIds.at(-1));
}

export async function sendTask(page, text) {
  await openAgent(page);
  await page.locator('#agent-prompt').fill(text);
  await page.locator('#agent-send').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  return page.evaluate(() => window.__nativeContract.lastTask());
}

export async function emitSession(page, sessionId, event) {
  await page.evaluate(({ sessionId, event }) => window.__nativeContract.emitSession(sessionId, event), { sessionId, event });
}
