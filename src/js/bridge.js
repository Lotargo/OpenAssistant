import { invoke, isTauri, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { load } from '@tauri-apps/plugin-store';
import { createMicrophone } from './microphone.js';
import { createAssistantTransport } from './session-transport.js';

const APPEARANCE_KEY = 'openassistant.settings.v1';
const AGENT_KEY = 'openassistant.agent.v1';
const AUDIO_KEY = 'openassistant.audio.v1';
const WINDOW_MODE_KEY = 'openassistant.window-mode.v1';
const validWindowMode = mode => mode === 'overlay' || mode === 'standard';
const PREVIEW_ONLY = 'Codex доступен в приложении OpenAssistant. Браузер открыт только для просмотра интерфейса.';
const DEFAULT_AGENT = Object.freeze({
  workspace: '', model: '', effort: '', web_search: true, parallel: true,
  realtime: true, realtime_model: 'gpt-realtime-2.1',
});

function normalizeAgent(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    workspace: typeof source.workspace === 'string' ? source.workspace.trim() : '',
    model: typeof source.model === 'string' ? source.model : '',
    effort: typeof source.effort === 'string' ? source.effort : '',
    web_search: typeof source.web_search === 'boolean' ? source.web_search : true,
    parallel: typeof source.parallel === 'boolean' ? source.parallel : true,
    realtime: typeof source.realtime === 'boolean' ? source.realtime : true,
    realtime_model: ['gpt-realtime-2.1', 'gpt-realtime-1.5'].includes(source.realtime_model) ? source.realtime_model : 'gpt-realtime-2.1',
  };
}
function normalizeAudio(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    deviceId: typeof source.deviceId === 'string' ? source.deviceId : '',
    noiseSuppression: source.noiseSuppression === true,
  };
}
function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch { return fallback; }
}

/** Native IPC carries only safe status, events and user input. OAuth stays in Rust. */
export async function createBridge({ onState, onScroll, onSettings, onError, onTurnStart, onChunk, onTurnEnd, onAudioLevels, onWindowActivity } = {}) {
  const native = isTauri();
  let storePromise;
  const getStore = () => storePromise ??= load('settings.json', { autoSave: false, defaults: {} });
  let saveQueue = Promise.resolve();
  let audioSyncQueue = Promise.resolve();
  let lastAudioState = '';
  const unlisten = [];
  let initialError = '';
  let activityVersion = 0;
  function receiveWindowActivity(payload) {
    if (typeof payload?.active !== 'boolean') return;
    activityVersion++;
    onWindowActivity?.({ active: payload.active });
  }
  let storedAgent;
  try { storedAgent = native ? await (await getStore()).get('agent') : readStored(AGENT_KEY, DEFAULT_AGENT); }
  catch (error) { initialError = 'Не удалось прочитать параметры агента: ' + String(error); }
  let storedAudio;
  try { storedAudio = native ? await (await getStore()).get('audio') : readStored(AUDIO_KEY, {}); }
  catch (error) { initialError = 'Не удалось прочитать параметры микрофона: ' + String(error); }
  let storedWindowMode;
  try { storedWindowMode = native ? await (await getStore()).get('windowMode') : readStored(WINDOW_MODE_KEY, 'overlay'); }
  catch (error) { initialError = 'Не удалось прочитать режим окна: ' + String(error); }
  let audioConfig = normalizeAudio(storedAudio);
  let config = normalizeAgent(storedAgent);
  let generation = 0;
  let destroyed = false;
  let waiting = null;
  let voiceWaiting = null;
  let connectionPromise = null;
  let sessionConfig = null;
  let visibleTask = null;
  let activeSource = null;
  let pinnedAgent = false;
  let progressTask = null;
  const taskText = new Map();
  let realtimeText = '';
  let runtime = {
    microphoneMuted: true, microphoneDevice: audioConfig.deviceId, microphoneDevices: [],
    microphoneNoiseSuppression: audioConfig.noiseSuppression, microphoneTesting: false,
    microphoneBusy: false, microphoneError: '', microphoneStatus: '', microphoneLevels: null,
    screenCaptureEnabled: false, scrollLocked: false, settingsOpen: false,
    windowMode: !native && validWindowMode(storedWindowMode) ? storedWindowMode : 'overlay',
    connectionStatus: native ? 'idle' : 'unavailable', agentStage: 'idle', agentDetail: '',
    audioAvailable: false,
    screenCaptureAvailable: false, liveAvailable: false, nativeWindow: native,
    platform: native ? 'desktop' : 'browser', lastError: initialError, agentConfig: { ...config }, models: [],
    activities: [], approvals: [], inputs: [], tasks: [], transcript: '',
    audioStats: null, configDirty: false, codexAvailable: false, mode: 'real', voiceError: '',
  };
  function publish(patch = {}) {
    runtime = { ...runtime, ...patch };
    onState?.({ ...runtime });
    return { ...runtime };
  }
  function publishNative(state = {}) {
    if (Number.isSafeInteger(state.revision) && state.revision < (runtime.revision ?? -1)) return { ...runtime };
    const patch = {};
    for (const key of ['revision', 'scrollLocked', 'settingsOpen', 'windowMode', 'nativeWindow', 'nativeWheelRouting', 'platform']) {
      if (key in state) patch[key] = state[key];
    }
    // Capturing and model connections have their own lifecycle, not native preferences.
    return publish(patch);
  }
  function reportError(error, open = false) {
    const message = error instanceof Error ? error.message : String(error);
    publish({ lastError: message });
    onError?.(message);
    if (open) onSettings?.({ open: true, tab: 'agent' });
    return message;
  }
  function saveValue(field, browserKey, value) {
    const snapshot = structuredClone(value);
    const operation = saveQueue.then(async () => {
      if (native) {
        const store = await getStore();
        await store.set(field, snapshot);
        await store.save();
      } else localStorage.setItem(browserKey, JSON.stringify(snapshot));
    });
    saveQueue = operation.catch(() => {});
    return operation.catch(error => { reportError('Не удалось сохранить настройки: ' + String(error)); throw error; });
  }
  function syncAudio(state) {
    const current = {
      muted: Boolean(state.microphoneMuted ?? runtime.microphoneMuted),
      available: native && Boolean(state.audioAvailable ?? runtime.audioAvailable),
    };
    publish({ ...state, audioAvailable: current.available });
    if (!native || destroyed) return;
    const signature = JSON.stringify(current);
    if (signature === lastAudioState) return;
    lastAudioState = signature;
    audioSyncQueue = audioSyncQueue.then(() => invoke('sync_audio_state', current))
      .then(publishNative).catch(error => { lastAudioState = ''; reportError(error); });
  }
  const transport = createAssistantTransport({
    invoke, Channel, onEvent: receive,
    onError(error) { reportError(error); stopVoiceSafely(); },
  });
  function send(type, data = {}) { return transport.send({ type, ...data }); }
  function log(activity) {
    publish({ activities: [...runtime.activities, {
      title: activity.title || activity.kind || 'Событие',
      detail: String(activity.detail || '').slice(0, 8000),
      ...activity,
    }].slice(-80) });
  }
  const mic = createMicrophone({
    nativeAudio: native ? { invoke, Channel } : null,
    initialSettings: audioConfig,
    onSettings(preferences) {
      audioConfig = normalizeAudio(preferences);
      return saveValue('audio', AUDIO_KEY, audioConfig).catch(() => {});
    },
    onLevels(levels) {
      runtime = { ...runtime, microphoneLevels: levels };
      // Audio meters have their own lightweight rendering path. A signal frame
      // must not rebuild the settings controls or move keyboard focus.
      onAudioLevels?.(levels);
    },
    isReady: () => native && runtime.liveAvailable && config.realtime && transport.connected,
    sendEvent: send,
    sendAudio(buffer) { return transport.audio(buffer); },
    onState: syncAudio,
    onDevices: (devices, selected) => publish({ microphoneDevices: devices, microphoneDevice: selected }),
    onError: message => reportError(message),
  });

  function stopVoiceSafely() {
    void mic.stop(false).catch(error => reportError('Не удалось остановить микрофон: ' + String(error)));
  }

  function begin(source, taskId = null) {
    activeSource = source;
    progressTask = null;
    if (source === 'agent') { visibleTask = taskId; pinnedAgent = true; publish({ visibleTaskId: taskId }); }
    onTurnStart?.({ source, task_id: taskId });
  }
  function showProgress(taskId, activity = null) {
    if (visibleTask !== taskId || (taskText.get(taskId) || '').length) return;
    const escape = value => String(value || '').replace(/\s+/g, ' ').slice(0, 280).replace(/[\u0060*_[\]<>#\\]/g, '\\$&');
    const detail = activity?.title
      ? '\n\n' + (activity.status === 'completed' ? 'Завершён шаг: ' : activity.status === 'failed' ? 'Ошибка шага: ' : 'Выполняется: ') + '**' + escape(activity.title) + '**'
      : '';
    progressTask = taskId;
    onTurnStart?.({ source: 'agent', task_id: taskId, progress: true });
    onChunk?.({ text: '### Codex выполняет задачу' + detail });
  }
  function updateTask(taskId, patch) {
    const tasks = runtime.tasks.filter(task => task.task_id !== taskId);
    tasks.push({ ...runtime.tasks.find(task => task.task_id === taskId), task_id: taskId, ...patch });
    const recent = tasks.slice(-20);
    for (const id of taskText.keys()) { if (!recent.some(task => task.task_id === id)) taskText.delete(id); }
    publish({ tasks: recent });
  }
  function readyIfPossible() {
    if (!waiting) return;
    if (['ready', 'running'].includes(runtime.agentStage) && transport.connected) {
      clearTimeout(waiting.timer);
      waiting.resolve();
      waiting = null;
      publish({ configDirty: JSON.stringify(config) !== JSON.stringify(sessionConfig), lastError: runtime.voiceError || '' });
    }
  }
  function failWaiting(message) {
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waiting.reject(new Error(message));
    waiting = null;
  }
  function receive(event) {
    switch (event.type) {
      case 'status': {
        const stage = event.stage || 'idle';
        if (stage === 'idle' && runtime.connectionStatus === 'connecting') return;
        const voiceReady = stage === 'ready' && event.realtime !== false && Boolean(sessionConfig?.realtime ?? config.realtime);
        publish({ connectionStatus: stage, liveAvailable: voiceReady, connectionDetail: event.detail || stage });
        if (stage === 'voice_error') {
          const message = event.detail || 'Голосовая сессия недоступна. Текстовые задачи Codex доступны.';
          publish({ voiceError: message });
          failVoice(message);
          stopVoiceSafely();
          reportError(message);
        } else if (stage === 'ready') {
          if (voiceReady) { publish({ voiceError: '' }); void mic.refresh(); resolveVoice(); }
          else {
            stopVoiceSafely();
            failVoice('Голосовой режим отключён. Текстовые задачи Codex доступны.');
          }
        }
        if (stage === 'disconnected') {
          stopVoiceSafely();
          failVoice(event.detail || 'Realtime отключён.');
        }
        break;
      }
      case 'agent_state':
        publish({ agentStage: event.stage || 'idle', agentDetail: event.detail || '',
          activeWorkspace: event.workspace, activeModel: event.model, activeEffort: event.effort });
        if (event.stage === 'error') failWaiting(event.detail || 'Не удалось подключить Codex.');
        readyIfPossible();
        break;
      case 'agent_models':
        publish({ models: Array.isArray(event.models) ? event.models : [] });
        break;
      case 'agent_task_started':
        taskText.set(event.task_id, '');
        updateTask(event.task_id, { task: event.task || '', status: 'running', thread_id: event.thread_id });
        begin('agent', event.task_id);
        showProgress(event.task_id);
        break;
      case 'agent_delta': {
        const text = String(event.text || '');
        const previous = taskText.get(event.task_id) || '';
        taskText.set(event.task_id, (previous + text).slice(-512 * 1024));
        if (visibleTask === null) begin('agent', event.task_id);
        if (visibleTask === event.task_id) {
          if (progressTask === event.task_id && text) { progressTask = null; onTurnStart?.({ source: 'agent', task_id: event.task_id }); }
          if (activeSource !== 'agent') {
            begin('agent', event.task_id);
            if (previous) onChunk?.({ text: previous });
          }
          onChunk?.({ text, phase: event.phase });
        }
        break;
      }
      case 'agent_activity': {
        const key = event.item_id || event.title;
        const existing = runtime.activities.findIndex(item => item.task_id === event.task_id && (item.item_id || item.title) === key);
        if (existing >= 0) {
          const activities = [...runtime.activities];
          activities[existing] = { ...activities[existing], ...event };
          publish({ activities });
        } else log(event);
        showProgress(event.task_id, event);
        break;
      }
      case 'agent_done': {
        updateTask(event.task_id, { status: event.status || 'completed' });
        const accumulated = taskText.get(event.task_id) || '';
        const text = String(event.text || accumulated);
        taskText.set(event.task_id, text);
        if (visibleTask === event.task_id) {
          if (text !== accumulated || activeSource !== 'agent' || progressTask === event.task_id) {
            begin('agent', event.task_id);
            onChunk?.({ text: text || (event.status === 'interrupted' ? 'Задача остановлена.' : event.status === 'failed' ? 'Codex не завершил задачу.' : 'Задача завершена без текстового ответа.') });
          }
          onTurnEnd?.({ source: 'agent', task_id: event.task_id, status: event.status });
          activeSource = null;
        }
        break;
      }
      case 'agent_approval_resolved':
        publish({ approvals: runtime.approvals.filter(item => item.request_id !== event.request_id) });
        break;
      case 'agent_input_resolved':
        publish({ inputs: runtime.inputs.filter(item => item.request_id !== event.request_id) });
        break;
      case 'agent_approval': {
        const isNew = !runtime.approvals.some(item => item.request_id === event.request_id);
        publish({ approvals: [...runtime.approvals.filter(item => item.request_id !== event.request_id), event] });
        if (isNew) onSettings?.({ open: true, tab: 'agent', request: { kind: 'approval', id: event.request_id } });
        break;
      }
      case 'agent_input': {
        const isNew = !runtime.inputs.some(item => item.request_id === event.request_id);
        publish({ inputs: [...runtime.inputs.filter(item => item.request_id !== event.request_id), event] });
        if (isNew) onSettings?.({ open: true, tab: 'agent', request: { kind: 'input', id: event.request_id } });
        break;
      }
      case 'agent_error':
        if (event.task_id) updateTask(event.task_id, { status: 'failed' });
        failWaiting(event.message || 'Не удалось подключить Codex.');
        reportError(event.message || 'Ошибка Codex.', true);
        break;
      case 'delta':
        // The direct agent turn owns the canvas while tools are working.
        if (pinnedAgent || runtime.tasks.some(task => task.status === 'running')) break;
        if (activeSource !== 'realtime') { realtimeText = ''; begin('realtime'); }
        realtimeText += event.text || '';
        onChunk?.({ text: event.text || '' });
        break;
      case 'text_done':
        if (!pinnedAgent && activeSource !== 'agent' && !realtimeText && event.text) {
          begin('realtime');
          realtimeText = event.text;
          onChunk?.({ text: event.text });
        }
        break;
      case 'response_done':
        if (activeSource === 'realtime') { onTurnEnd?.({ source: 'realtime' }); activeSource = null; realtimeText = ''; }
        break;
      case 'transcript':
        publish({ transcript: String(event.text || '') });
        break;
      case 'mic_state':
        if (event.stage === 'speech' && !runtime.tasks.some(task => task.status === 'running')) pinnedAgent = false;
        publish({ micStage: event.stage, micDetail: event.detail });
        break;
      case 'audio_stats':
        publish({ audioStats: event });
        break;
      case 'tool':
        log({ kind: 'agent', title: event.name || 'Инструмент', detail: String(event.result || ''), status: 'completed' });
        break;
      case 'voice_error':
      case 'error': {
        const message = event.message || 'Ошибка Realtime.';
        publish({ voiceError: message, connectionStatus: 'error', liveAvailable: false });
        failVoice(message);
        stopVoiceSafely();
        reportError(message);
        break;
      }
      case 'session_closed':
        failWaiting(event.message || 'Сессия закрыта.');
        failVoice(event.message || 'Сессия закрыта.');
        stopVoiceSafely();
        publish({ connectionStatus: 'idle', connectionDetail: '', agentStage: 'idle', agentDetail: event.message || 'Сессия закрыта.', liveAvailable: false, approvals: [], inputs: [] });
        break;
      default: break;
    }
  }

  function resolveVoice() {
    if (!voiceWaiting || !runtime.liveAvailable) return;
    clearTimeout(voiceWaiting.timer);
    voiceWaiting.resolve();
    voiceWaiting = null;
  }
  function failVoice(message) {
    if (!voiceWaiting) return;
    clearTimeout(voiceWaiting.timer);
    voiceWaiting.reject(new Error(message));
    voiceWaiting = null;
  }
  function waitForVoice() {
    if (runtime.liveAvailable) return Promise.resolve();
    if (runtime.connectionStatus === 'ready') return Promise.reject(new Error('Голосовой режим отключён. Текстовые задачи Codex доступны.'));
    if (runtime.voiceError) return Promise.reject(new Error(runtime.voiceError));
    if (['disconnected', 'error'].includes(runtime.connectionStatus)) return Promise.reject(new Error(runtime.connectionDetail || 'Realtime отключён. Переподключи сессию.'));
    if (voiceWaiting) return voiceWaiting.promise;
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    voiceWaiting = { promise, resolve, reject, timer: setTimeout(() => failVoice('Realtime не ответил за 60 секунд. Текстовые задачи Codex доступны.'), 60_000) };
    return promise;
  }

  async function disconnect() {
    ++generation;
    connectionPromise = null;
    failWaiting('Подключение отменено.');
    failVoice('Подключение отменено.');
    await mic.stop(false).catch(error => reportError('Не удалось остановить микрофон: ' + String(error)));
    await transport.disconnect();
    activeSource = null;
    visibleTask = null;
    pinnedAgent = false;
    progressTask = null;
    realtimeText = '';
    taskText.clear();
    publish({ connectionStatus: native ? 'idle' : 'unavailable', connectionDetail: '', agentStage: 'idle', agentDetail: '', liveAvailable: false,
      approvals: [], inputs: [], tasks: [], activities: [], visibleTaskId: null, voiceError: '' });
  }

  function connect() {
    if (!native) return Promise.reject(new Error(PREVIEW_ONLY));
    if (connectionPromise) return connectionPromise;
    if (transport.connected && ['ready', 'running'].includes(runtime.agentStage) && !runtime.configDirty) return Promise.resolve();
    const operation = (async () => {
      await disconnect();
      const epoch = generation;
      publish({ connectionStatus: config.realtime ? 'connecting' : 'idle', agentStage: 'starting', lastError: '', voiceError: '' });
      let resolve;
      let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      // Mark the readiness promise handled while the native command is starting.
      promise.catch(() => {});
      waiting = { promise, resolve, reject, timer: setTimeout(() => {
        failWaiting('Codex не завершил подключение за 60 секунд.');
        void transport.disconnect().catch(reportError);
      }, 60_000) };
      try {
        sessionConfig = { ...config };
        const created = await transport.connect(sessionConfig);
        if (epoch !== generation || destroyed || created === null) throw new Error('Подключение отменено.');
        readyIfPossible();
        await promise;
      } catch (error) {
        if (epoch === generation) {
          const message = error instanceof Error ? error.message : String(error);
          failWaiting(message);
          failVoice(message);
          publish({ agentStage: 'error', agentDetail: message, connectionStatus: 'error', connectionDetail: message, liveAvailable: false });
          await mic.stop(false).catch(error => reportError('Не удалось остановить микрофон: ' + String(error)));
          await transport.disconnect().catch(() => {});
        }
        throw error;
      }
    })();
    connectionPromise = operation;
    void operation.finally(() => { if (connectionPromise === operation) connectionPromise = null; }).catch(() => {});
    return operation;
  }

  async function command(name, args = {}) {
    try {
      switch (name) {
        case 'set_microphone_muted':
          if (args.muted) await mic.stop();
          else {
            await mic.stopTest();
            if (!config.realtime) throw new Error('Включи Realtime во вкладке «Агент», чтобы использовать микрофон.');
            if (runtime.configDirty && runtime.tasks.some(item => item.status === 'running')) throw new Error('Примени изменённые параметры после завершения текущей задачи.');
            await connect();
            if (runtime.configDirty) throw new Error('Параметры изменились во время подключения. Примени их кнопкой переподключения.');
            await waitForVoice();
            await mic.start();
          }
          return { ...runtime };
        case 'set_microphone_device':
          await mic.select(args.deviceId || '');
          return { ...runtime };
        case 'refresh_microphones':
          await mic.refresh();
          return { ...runtime };
        case 'request_microphone_permission':
          await mic.requestPermission();
          return { ...runtime };
        case 'start_microphone_test':
          if (!native) throw new Error('Проверка микрофона доступна в приложении OpenAssistant.');
          await mic.startTest();
          return { ...runtime };
        case 'stop_microphone_test':
          await mic.stopTest();
          return { ...runtime };
        case 'set_microphone_noise_suppression':
          await mic.setNoiseSuppression(Boolean(args.enabled));
          return { ...runtime };
        case 'set_window_mode': {
          if (!validWindowMode(args.mode)) throw new Error('Неизвестный режим окна.');
          if (native) publishNative(await invoke(name, { mode: args.mode }));
          else publish({ windowMode: args.mode });
          // Native revisions are authoritative, including a newer state that may
          // arrive while an older command response is still in transit.
          await saveValue('windowMode', WINDOW_MODE_KEY, runtime.windowMode);
          return { ...runtime };
        }
        case 'start_window_drag':
          if (native) await invoke(name);
          return { ...runtime };
        case 'set_scroll_locked':
          return native ? publishNative(await invoke(name, args)) : publish({ scrollLocked: Boolean(args.locked) });
        case 'set_settings_open':
          if (!args.open) await mic.stopTest();
          return native ? publishNative(await invoke(name, args)) : publish({ settingsOpen: Boolean(args.open) });
        case 'set_screen_capture_enabled':
          if (!args.enabled) return publish({ screenCaptureEnabled: false });
          throw new Error('Передача изображения экрана модели в этой версии не подключена.');
        case 'reconnect_session':
          await disconnect();
          await connect();
          return { ...runtime };
        case 'disconnect_session':
          await disconnect();
          return { ...runtime };
        case 'agent_task': {
          const task = String(args.task || '').trim();
          if (!task) throw new Error('Введи задачу Codex.');
          if ([...task].length > 16000) throw new Error('Задача слишком длинная: максимум 16000 символов.');
          if (runtime.configDirty && runtime.tasks.some(item => item.status === 'running')) throw new Error('Дождись завершения текущей задачи, затем примени изменённые параметры.');
          await connect();
          if (runtime.configDirty) throw new Error('Параметры изменились во время подключения. Примени их кнопкой переподключения.');
          if (!await send('agent_task', { task })) throw new Error('Соединение закрыто.');
          return { ...runtime };
        }
        case 'select_agent_task': {
          const task = runtime.tasks.find(item => item.task_id === args.task_id);
          if (!task) return { ...runtime };
          begin('agent', args.task_id);
          const saved = taskText.get(args.task_id) || '';
          if (!saved && task.status === 'running') showProgress(args.task_id);
          else onChunk?.({ text: saved });
          if (task.status !== 'running') onTurnEnd?.({ source: 'agent', task_id: args.task_id, status: task.status });
          return { ...runtime };
        }
        case 'agent_interrupt':
          if (!await send('agent_interrupt', args.task_id ? { task_id: args.task_id } : {})) throw new Error('Соединение закрыто.');
          return { ...runtime };
        case 'agent_approval':
          if (!['accept', 'decline', 'cancel'].includes(args.decision)) throw new Error('Неизвестное решение.');
          if (!await send('agent_approval', { request_id: args.request_id, decision: args.decision })) throw new Error('Соединение закрыто.');
          return publish({ approvals: runtime.approvals.filter(item => item.request_id !== args.request_id) });
        case 'agent_input':
          if (!await send('agent_input', { request_id: args.request_id, answers: args.answers })) throw new Error('Соединение закрыто.');
          return publish({ inputs: runtime.inputs.filter(item => item.request_id !== args.request_id) });
        default: throw new Error('Неизвестная команда: ' + name);
      }
    } catch (error) { reportError(error); throw error; }
  }

  if (native) {
    const handlers = {
      'overlay:state': publishNative,
      'overlay:window-activity': receiveWindowActivity,
      'overlay:scroll': payload => onScroll?.(payload),
      'overlay:settings': payload => onSettings?.({ tab: 'appearance', ...payload }),
      'overlay:error': payload => reportError(payload?.message ?? payload),
      'overlay:action': payload => {
        const action = payload?.action === 'microphone'
          ? command('set_microphone_muted', { muted: payload.muted ?? !runtime.microphoneMuted })
          : payload?.action === 'reconnect' ? command('reconnect_session') : null;
        void action?.catch(() => onSettings?.({ open: true, tab: payload.action === 'microphone' ? 'sources' : 'agent' }));
      },
      'assistant:turn-start': payload => onTurnStart?.({ ...payload, format: 'tagged' }),
      'assistant:chunk': payload => onChunk?.({ ...payload, format: 'tagged' }),
      'assistant:turn-end': payload => onTurnEnd?.({ ...payload, format: 'tagged' }),
    };
    for (const [event, handler] of Object.entries(handlers)) {
      unlisten.push(await listen(event, ({ payload }) => handler(payload)));
    }
    const initialActivityVersion = activityVersion;
    try {
      const activity = await invoke('get_window_activity');
      if (activityVersion === initialActivityVersion) receiveWindowActivity(activity);
    } catch { /* Activity events and native input guards remain available. */ }
    try { publishNative(await invoke('get_runtime_state')); }
    catch (error) { reportError(error); }
    if (validWindowMode(storedWindowMode) && storedWindowMode !== runtime.windowMode) {
      try { publishNative(await invoke('set_window_mode', { mode: storedWindowMode })); }
      catch (error) { reportError('Не удалось восстановить режим окна: ' + String(error)); }
    }
    try {
      const status = await invoke('assistant_status');
      if (!config.workspace && typeof status.workspace === 'string') config.workspace = status.workspace;
      publish({ agentConfig: { ...config }, mode: status.mode || 'real',
        codexAvailable: status.codex_available === true, auth: status.oauth, lastError: status.message || runtime.lastError || initialError });
    } catch (error) { reportError(error); }
    await mic.refresh();
  } else publish({ agentDetail: PREVIEW_ONLY });

  return {
    native,
    getRuntimeState: () => ({ ...runtime }),
    getSessionGeneration: () => generation,
    getAgentSettings: () => ({ ...config }),
    async setAgentSettings(patch) {
      const next = normalizeAgent({ ...config, ...patch });
      const changed = JSON.stringify(next) !== JSON.stringify(config);
      config = next;
      publish({ agentConfig: { ...config }, configDirty: runtime.configDirty || changed });
      await saveValue('agent', AGENT_KEY, config);
      return { ...runtime };
    },
    command, reportError,
    async loadSettings() {
      try { return native ? await (await getStore()).get('appearance') : readStored(APPEARANCE_KEY, null); }
      catch (error) { reportError('Не удалось прочитать настройки: ' + String(error)); return null; }
    },
    saveSettings(settings) { return saveValue('appearance', APPEARANCE_KEY, settings); },
    async resize(width, height) { if (native) await invoke('resize_overlay', { width, height }); },
    async updateHitRects(rects) { if (native) await invoke('update_hit_rects', { rects }); },
    async destroy() {
      destroyed = true;
      for (const stop of unlisten) stop();
      await disconnect().catch(() => {});
      await mic.destroy();
      await transport.destroy().catch(() => {});
      await Promise.all([saveQueue, audioSyncQueue]);
    },
  };
}
