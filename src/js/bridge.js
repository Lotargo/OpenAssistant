import { invoke, isTauri, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { load } from '@tauri-apps/plugin-store';
import { createMicrophone } from './microphone.js';
import { createAssistantTransport } from './session-transport.js';
import { createSystemAudio } from './system-audio.js';
import { DEFAULT_AGENT, normalizeAgent, validateCustomSettings, usesMeetingAudio, modeLabel } from './agent-config.js';
import { createActivityJournal, formatJournal } from './activity-journal.js';

const APPEARANCE_KEY = 'openassistant.settings.v1';
const AGENT_KEY = 'openassistant.agent.v1';
const AUDIO_KEY = 'openassistant.audio.v1';
const WINDOW_MODE_KEY = 'openassistant.window-mode.v1';
const validWindowMode = mode => mode === 'overlay' || mode === 'standard';
const PREVIEW_ONLY = 'Codex доступен в приложении OpenAssistant. Браузер открыт только для просмотра интерфейса.';
function normalizeAudio(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    deviceId: typeof source.deviceId === 'string' ? source.deviceId : '',
    systemDeviceId: typeof source.systemDeviceId === 'string' ? source.systemDeviceId : '',
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
  let modelsPromise = null;
  let dialogueStartToken = null;
  let interviewStarting = false;
  let interviewListeningIntent = false;
  let interviewStartToken = null;
  let interviewStopping = null;
  let visibleTask = null;
  let activeSource = null;
  let pinnedAgent = false;
  let progressTask = null;
  const taskText = new Map();
  const journal = createActivityJournal();
  let realtimeText = '';
  let runtime = {
    microphoneMuted: true, microphoneStarting: false, microphoneDevice: audioConfig.deviceId, microphoneDevices: [],
    microphoneNoiseSuppression: audioConfig.noiseSuppression, microphoneTesting: false,
    microphoneBusy: false, microphoneError: '', microphoneStatus: '', microphoneLevels: null,
    systemAudioActive: false, systemAudioBusy: false, systemAudioAvailable: false,
    systemAudioDevice: audioConfig.systemDeviceId, systemAudioDevices: [], systemAudioLevels: null,
    systemAudioStatus: '', systemAudioError: '',
    modelCatalog: { status: 'idle', error: '', updatedAt: null },
    workspaceState: { mode: config.workspace_mode, path: '', cleanupStatus: 'idle', detail: '' },
    interviewStarting: false, interviewState: { stage: 'idle', detail: 'Прослушивание выключено' },
    speakerState: { status: 'idle', detail: '' }, transcriptHistory: [],
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
    log({ kind: 'error', title: 'Ошибка', detail: message, status: 'failed' });
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
    if (state.microphoneMuted === true && !interviewStarting && interviewActive() && !interviewStopping) {
      void stopInterview('Микрофон остановлен · прослушивание приостановлено').catch(reportError);
    }
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
    publish({ activities: journal.record(activity, generation) });
  }
  const mic = createMicrophone({
    nativeAudio: native ? { invoke, Channel } : null,
    initialSettings: audioConfig,
    onSettings(preferences) {
      audioConfig = normalizeAudio({ ...audioConfig, ...preferences });
      return saveValue('audio', AUDIO_KEY, audioConfig).catch(() => {});
    },
    onLevels(levels) {
      runtime = { ...runtime, microphoneLevels: levels };
      // Audio meters have their own lightweight rendering path. A signal frame
      // must not rebuild the settings controls or move keyboard focus.
      onAudioLevels?.(levels);
    },
    isReady: () => native && runtime.liveAvailable && (sessionConfig?.realtime ?? config.realtime) && transport.connected,
    sendEvent: send,
    sendAudio(buffer) { return transport.audio(buffer, 'microphone'); },
    onState: syncAudio,
    onDevices: (devices, selected) => publish({ microphoneDevices: devices, microphoneDevice: selected }),
    onError: message => reportError(message),
  });

  const systemAudio = createSystemAudio({
    nativeAudio: native ? { invoke, Channel } : null,
    initialDevice: audioConfig.systemDeviceId,
    onDevice(deviceId) {
      audioConfig = normalizeAudio({ ...audioConfig, systemDeviceId: deviceId });
      return saveValue('audio', AUDIO_KEY, audioConfig);
    },
    onDevices: (devices, selected) => publish({ systemAudioDevices: devices, systemAudioDevice: selected }),
    onState(state) {
      publish(state);
      if (state.systemAudioActive === false && !interviewStarting && interviewActive() && !interviewStopping) {
        void stopInterview('Источник встречи остановлен · прослушивание приостановлено').catch(reportError);
      }
    },
    onLevels(levels) {
      runtime = { ...runtime, systemAudioLevels: levels };
      onAudioLevels?.(levels);
    },
    onError: reportError,
    isReady: () => native && runtime.liveAvailable && usesMeetingAudio(sessionConfig) && transport.connected,
    sendEvent: send,
    sendAudio: buffer => transport.audio(buffer, 'system'),
  });
  function interviewActive() {
    return ['starting', 'listening', 'evaluating', 'helping'].includes(runtime.interviewState?.stage);
  }
  async function refreshModels() {
    if (!native) throw new Error(PREVIEW_ONLY);
    if (modelsPromise) return modelsPromise;
    const operation = (async () => {
      publish({ modelCatalog: { ...runtime.modelCatalog, status: 'loading', error: '' } });
      try {
        const result = await invoke('assistant_models');
        if (!Array.isArray(result?.models)) throw new Error('Codex не вернул каталог моделей.');
        if (!destroyed) publish({ models: result.models, modelCatalog: { status: 'ready', error: '', updatedAt: Date.now() } });
      } catch (error) {
        if (!destroyed) publish({ modelCatalog: { ...runtime.modelCatalog, status: 'error', error: String(error?.message ?? error) } });
        throw error;
      }
    })();
    modelsPromise = operation;
    void operation.finally(() => { if (modelsPromise === operation) modelsPromise = null; }).catch(() => {});
    return operation;
  }
  function workspaceState(value) {
    value = value || {};
    const cleanupStatus = ({ removed: 'cleaned', preserved: 'idle' })[value.cleanup_status] || value.cleanup_status || 'idle';
    return { mode: value.workspace_mode || value.mode || config.workspace_mode, path: value.path || '', cleanupStatus, detail: value.message || '' };
  }
  async function refreshWorkspace() {
    if (!native || destroyed) return;
    const state = await invoke('assistant_workspace_state');
    if (!destroyed) publish({ workspaceState: workspaceState(state) });
  }
  async function stopInterview(detail = 'Прослушивание остановлено', preserveStart = false) {
    if (!preserveStart) {
      // The text session survives Stop. Fence queued meeting events immediately,
      // before native capture shutdown and the final cleared snapshot complete.
      interviewListeningIntent = false;
      interviewStarting = false;
      publish({ interviewStarting: false });
      if (interviewStartToken) {
        interviewStartToken.cancelled = true;
        interviewStartToken.cancel();
      }
    }
    if (interviewStopping) return interviewStopping;
    const operation = (async () => {
      publish({ interviewState: { ...runtime.interviewState, stage: 'stopping', detail } });
      if (transport.connected && usesMeetingAudio(sessionConfig)) {
        await send('interview_stop').catch(() => {});
      }
      const stopped = await Promise.allSettled([mic.stop(false), systemAudio.stop(false)]);
      if (transport.connected && usesMeetingAudio(sessionConfig)) {
        await send('mic_stop').catch(() => {});
        await send('system_stop').catch(() => {});
      }
      publish({ interviewState: { stage: 'idle', detail }, transcript: '', transcriptHistory: [],
        speakerState: { status: 'idle', detail: 'Группировка голосов выключена' } });
      const failed = stopped.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    interviewStopping = operation;
    try { await operation; }
    finally { if (interviewStopping === operation) interviewStopping = null; }
  }
  async function startInterview() {
    if (!native) throw new Error(PREVIEW_ONLY);
    if (!usesMeetingAudio(config)) throw new Error('Выбери режим с прослушиванием встречи.');
    if (!config.realtime) throw new Error('Включи голосовое подключение для прослушивания встречи.');
    if (interviewActive() || interviewStarting) return;
    if (runtime.configDirty && runtime.tasks.some(task => task.status === 'running')) throw new Error('Сначала заверши текущую задачу.');
    const cancelled = Symbol('interview-cancelled');
    const token = { cancelled: false, cancel: null };
    const cancellation = new Promise(resolve => { token.cancel = () => resolve(cancelled); });
    interviewStartToken = token;
    interviewStarting = true;
    interviewListeningIntent = true;
    async function step(operation) {
      const result = await Promise.race([operation, cancellation]);
      if (result === cancelled || token.cancelled || destroyed) throw cancelled;
      return result;
    }
    publish({ interviewStarting: true, interviewState: { stage: 'starting', detail: 'Подключаю режим «' + modeLabel(config) + '»' } });
    try {
      await step(mic.stopTest());
      await step(connect(true));
      await step(waitForVoice());
      if (runtime.configDirty) throw new Error('Настройки изменились. Подключись с новыми параметрами.');
      publish({ interviewState: { stage: 'starting', detail: 'Открываю микрофон и звук встречи' } });
      await step(Promise.all([systemAudio.refresh(), mic.refresh()]));
      if (!runtime.systemAudioAvailable) throw new Error('Выбери доступное устройство вывода для звука встречи.');
      if (!runtime.audioAvailable) throw new Error('Выбери доступный микрофон.');
      await step(systemAudio.start());
      await step(mic.start());
      await step(send('interview_start'));
      publish({ interviewState: { stage: 'listening', detail: 'Слушаю микрофон и участников встречи' } });
    } catch (error) {
      if (error === cancelled || token.cancelled) return;
      await stopInterview('Не удалось начать прослушивание');
      publish({ interviewState: { stage: 'idle', detail: 'Прослушивание выключено', error: String(error?.message ?? error) } });
      throw error;
    } finally {
      if (interviewStartToken === token) {
        interviewStartToken = null;
        interviewStarting = false;
        publish({ interviewStarting: false });
      }
    }
  }
  function cancelDialogueStart() {
    if (dialogueStartToken) {
      dialogueStartToken.cancelled = true;
      dialogueStartToken.cancel();
      dialogueStartToken = null;
    }
    if (runtime.microphoneStarting) publish({ microphoneStarting: false });
  }
  async function startDialogue() {
    if (!native) throw new Error(PREVIEW_ONLY);
    if (dialogueStartToken || !runtime.microphoneMuted) return;
    if (!config.realtime) throw new Error('Включи голосовое подключение во вкладке «Агенты».');
    if (runtime.configDirty && runtime.tasks.some(item => item.status === 'running')) throw new Error('Примени изменённые параметры после завершения текущей задачи.');
    const cancelled = Symbol('dialogue-cancelled');
    const token = { cancelled: false, cancel: null };
    const cancellation = new Promise(resolve => { token.cancel = () => resolve(cancelled); });
    dialogueStartToken = token;
    publish({ microphoneStarting: true });
    async function step(operation) {
      const result = await Promise.race([operation, cancellation]);
      if (result === cancelled || token.cancelled || destroyed) throw cancelled;
      return result;
    }
    try {
      await step(mic.stopTest());
      await step(connect(false, true));
      if (runtime.configDirty) throw new Error('Параметры изменились во время подключения. Примени их кнопкой переподключения.');
      await step(waitForVoice());
      if (runtime.configDirty) throw new Error('Параметры изменились во время подключения. Примени их кнопкой переподключения.');
      await step(mic.start());
    } catch (error) {
      if (error === cancelled || token.cancelled) return;
      await mic.stop(false).catch(() => {});
      throw error;
    } finally {
      if (dialogueStartToken === token) {
        dialogueStartToken = null;
        publish({ microphoneStarting: false });
      }
    }
  }

  function stopVoiceSafely() {
    cancelDialogueStart();
    if (usesMeetingAudio(sessionConfig) || systemAudio.active || interviewStarting) {
      void stopInterview().catch(reportError);
    } else void mic.stop(false).catch(error => reportError('Не удалось остановить микрофон: ' + String(error)));
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
        if (stage !== runtime.connectionStatus || (event.detail || stage) !== runtime.connectionDetail) {
          log({ kind: 'connection', title: 'Голосовое подключение', detail: event.detail || stage, status: stage });
        }
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
        if (event.stage !== runtime.agentStage || event.detail !== runtime.agentDetail) {
          log({ kind: 'connection', title: 'Codex', detail: event.detail || '', status: event.stage || 'idle' });
        }
        publish({ agentStage: event.stage || 'idle', agentDetail: event.detail || '',
          activeWorkspace: event.workspace, activeModel: event.model, activeEffort: event.effort });
        if (event.stage === 'error') failWaiting(event.detail || 'Не удалось подключить Codex.');
        readyIfPossible();
        break;
      case 'agent_models':
        publish({ models: Array.isArray(event.models) ? event.models : [],
          modelCatalog: { status: 'ready', error: '', updatedAt: Date.now() } });
        break;
      case 'workspace_state':
        log({ kind: 'workspace', title: event.temporary ? 'Временная рабочая область' : 'Рабочая область проекта',
          status: event.cleanup_status || 'idle', path: event.path || '', detail: event.message || '' });
        publish({ workspaceState: workspaceState(event) });
        break;
      case 'speaker_state':
        if (usesMeetingAudio(sessionConfig) && !interviewListeningIntent
          && !['idle', 'error', 'unavailable'].includes(event.status)) break;
        publish({ speakerState: { status: event.status || 'unavailable', detail: event.detail || '' } });
        break;
      case 'interview_state':
        if (usesMeetingAudio(sessionConfig) && !interviewListeningIntent
          && !['idle', 'error', 'unavailable'].includes(event.stage)) break;
        if (interviewStarting && event.stage === 'idle') break;
        publish({ interviewState: { ...runtime.interviewState, ...event } });
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
        log(event);
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
      case 'transcript': {
        if (usesMeetingAudio(sessionConfig) && !interviewListeningIntent) break;
        const text = String(event.text || '');
        const entry = { text, utterance_id: event.utterance_id, item_id: event.item_id,
          source: event.source || 'microphone', speaker: event.speaker || null,
          speaker_label: event.speaker_label || (event.source === 'system' ? 'Участники встречи' : 'Мой микрофон') };
        publish({ transcript: usesMeetingAudio(sessionConfig) ? entry.speaker_label + ': ' + text : text,
          transcriptHistory: [...runtime.transcriptHistory, entry].slice(-32),
          ...(usesMeetingAudio(sessionConfig) ? { interviewState: { ...runtime.interviewState,
            source: entry.source, speaker: entry.speaker, speaker_label: entry.speaker_label } } : {}) });
        break;
      }
      case 'speaker_attribution': {
        if ((usesMeetingAudio(sessionConfig) && !interviewListeningIntent)
          || !Number.isSafeInteger(event.utterance_id)) break;
        const history = runtime.transcriptHistory.map(entry => entry.utterance_id === event.utterance_id
          && entry.source === 'system' ? { ...entry, speaker: event.speaker || null,
            speaker_label: event.speaker_label || 'Участники встречи' } : entry);
        const latest = history.at(-1);
        const current = latest?.utterance_id === event.utterance_id && latest.source === 'system';
        publish({ transcriptHistory: history, ...(current ? {
          transcript: latest.speaker_label + ': ' + latest.text,
          interviewState: { ...runtime.interviewState, speaker: latest.speaker, speaker_label: latest.speaker_label },
        } : {}) });
        break;
      }
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

  async function disconnect(preserveInterviewStart = false, preserveDialogueStart = false) {
    if (!preserveDialogueStart) cancelDialogueStart();
    ++generation;
    connectionPromise = null;
    failWaiting('Подключение отменено.');
    failVoice('Подключение отменено.');
    await stopInterview('Прослушивание остановлено', preserveInterviewStart).catch(reportError);
    await transport.disconnect();
    await refreshWorkspace().catch(() => {});
    activeSource = null;
    visibleTask = null;
    pinnedAgent = false;
    progressTask = null;
    realtimeText = '';
    taskText.clear();
    publish({ connectionStatus: native ? 'idle' : 'unavailable', connectionDetail: '', agentStage: 'idle', agentDetail: '', liveAvailable: false,
      approvals: [], inputs: [], tasks: [], visibleTaskId: null, voiceError: '',
      transcript: '', transcriptHistory: [], interviewState: { stage: preserveInterviewStart ? 'starting' : 'idle', detail: preserveInterviewStart ? 'Подключаю источники' : 'Прослушивание выключено' } });
  }

  function connect(preserveInterviewStart = false, preserveDialogueStart = false) {
    if (!native) return Promise.reject(new Error(PREVIEW_ONLY));
    if (connectionPromise) return connectionPromise;
    if (transport.connected && ['ready', 'running'].includes(runtime.agentStage) && !runtime.configDirty) return Promise.resolve();
    const operation = (async () => {
      await disconnect(preserveInterviewStart, preserveDialogueStart);
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
          if (args.muted) cancelDialogueStart();
          if (usesMeetingAudio(config) || interviewStarting || interviewStartToken || usesMeetingAudio(sessionConfig) && interviewActive()) {
            if (args.muted) await stopInterview(); else await startInterview();
            return { ...runtime };
          }
          if (args.muted) { cancelDialogueStart(); await mic.stop(); }
          else await startDialogue();
          return { ...runtime };
        case 'clear_journal': {
          const cleared = journal.clear();
          publish({ activities: [] });
          return { cleared };
        }
        case 'copy_journal': {
          const entries = journal.entries();
          if (!entries.length) return { copied: false, entries: 0 };
          const text = formatJournal(entries);
          if (native) await invoke('clipboard_write_text', { text });
          else {
            if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Буфер обмена недоступен в этом браузере.');
            await navigator.clipboard.writeText(text);
          }
          return { copied: true, entries: entries.length };
        }
        case 'set_microphone_device':
          await mic.select(args.deviceId || '');
          return { ...runtime };
        case 'refresh_microphones':
          await Promise.all([mic.refresh(), systemAudio.refresh()]);
          return { ...runtime };
        case 'refresh_models':
          await refreshModels();
          return { ...runtime };
        case 'choose_workspace': {
          if (!native) throw new Error(PREVIEW_ONLY);
          const path = await invoke('assistant_choose_workspace');
          if (typeof path === 'string' && path) {
            config = normalizeAgent({ ...config, workspace: path, workspace_mode: 'project' });
            publish({ agentConfig: { ...config }, configDirty: true });
            await saveValue('agent', AGENT_KEY, config);
          }
          return { ...runtime };
        }
        case 'clear_temporary_workspace':
          if (!native) throw new Error(PREVIEW_ONLY);
          if (runtime.tasks.some(task => task.status === 'running') || interviewActive()) throw new Error('Останови прослушивание и дождись завершения задач перед очисткой.');
          await disconnect();
          await invoke('assistant_cleanup_workspaces');
          await refreshWorkspace();
          return { ...runtime };
        case 'start_interview':
          await startInterview();
          return { ...runtime };
        case 'stop_interview':
          await stopInterview();
          return { ...runtime };
        case 'set_system_audio_device':
          await systemAudio.select(args.deviceId || '');
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
          ? command('set_microphone_muted', { muted: dialogueStartToken || interviewStartToken ? true : payload.muted ?? !runtime.microphoneMuted })
          : payload?.action === 'reconnect' ? command('reconnect_session') : null;
        void action?.catch(() => onSettings?.({ open: true, tab: payload.action === 'microphone' ? 'audio' : 'agent' }));
      },
      'assistant:turn-start': payload => onTurnStart?.({ ...payload, format: 'tagged' }),
      'assistant:chunk': payload => onChunk?.({ ...payload, format: 'tagged' }),
      'assistant:turn-end': payload => onTurnEnd?.({ ...payload, format: 'tagged' }),
    };
    for (const [event, handler] of Object.entries(handlers)) {
      // Any-target listeners also receive activity emitted to sibling windows.
      const options = event === 'overlay:window-activity'
        ? { target: { kind: 'WebviewWindow', label: 'main' } } : undefined;
      unlisten.push(await listen(event, ({ payload }) => handler(payload), options));
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
      publish({ agentConfig: { ...config }, mode: status.mode || 'real',
        codexAvailable: status.codex_available === true, auth: status.oauth, lastError: status.message || runtime.lastError || initialError });
    } catch (error) { reportError(error); }
    await Promise.all([mic.refresh(), systemAudio.refresh()]);
    await refreshWorkspace().catch(() => {});
    void refreshModels().catch(() => {});
  } else publish({ agentDetail: PREVIEW_ONLY });

  return {
    native,
    getRuntimeState: () => ({ ...runtime }),
    getSessionGeneration: () => generation,
    getAgentSettings: () => ({ ...config }),
    async setAgentSettings(patch) {
      const next = normalizeAgent({ ...config, ...patch });
      validateCustomSettings(next);
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
      await Promise.allSettled([mic.destroy(), systemAudio.destroy()]);
      await transport.destroy().catch(() => {});
      await Promise.all([saveQueue, audioSyncQueue]);
    },
  };
}
