import { microphoneLevels, emptyMicrophoneLevels } from './microphone-levels.js';

const TEST_MS = 20_000;
const MAX_PENDING_PCM_BYTES = 48_000;

/** Native CPAL capture shared by live input and a bounded, entirely local check. */
export function createNativeMicrophone({
  nativeAudio, initialSettings = {}, onSettings, isReady = () => false,
  sendEvent = async () => false, sendAudio = () => false,
  onState, onDevices, onLevels, onError,
} = {}) {
  const { invoke, Channel } = nativeAudio;
  let selected = typeof initialSettings.deviceId === 'string' ? initialSettings.deviceId : '';
  let denoise = initialSettings.noiseSuppression === true;
  let devices = [];
  let available = false;
  let defaultId = '';
  let capture = null;
  let pending = null;
  let configuring = false;
  let operation = 0;
  let destroyed = false;
  let refreshPromise = null;
  let monitor = null;
  let tickCount = 0;
  let status = 'Микрофон выключен';
  let lastError = '';
  let stickyError = false;

  function selectedAvailable() {
    return Boolean(available && (selected ? devices.some(device => device.id === selected) : devices.some(device => device.is_default)));
  }
  function publish() {
    onState?.({
      microphoneMuted: !capture || capture.mode !== 'stream',
      microphoneTesting: Boolean(capture?.mode === 'test'),
      microphoneBusy: Boolean(pending || configuring || capture?.stopping),
      microphoneDevice: selected,
      microphoneNoiseSuppression: denoise,
      microphoneTestRemaining: capture?.mode === 'test' ? Math.max(0, Math.ceil((capture.deadline - Date.now()) / 1000)) : 0,
      microphoneError: lastError,
      microphoneStatus: status,
      microphonePermission: 'native',
      audioAvailable: selectedAvailable(),
    });
  }
  function publishDevices() {
    const system = devices.find(device => device.is_default);
    const options = [
      { deviceId: '', label: system ? 'Системный · ' + system.name : 'Системный по умолчанию', isDefault: true },
      ...devices.map(device => ({ deviceId: device.id, label: device.name, isDefault: device.is_default })),
    ];
    if (selected && !devices.some(device => device.id === selected)) {
      options.push({ deviceId: selected, label: 'Выбранный микрофон · недоступен', unavailable: true });
    }
    onDevices?.(options, selected);
  }
  function report(error) {
    lastError = error instanceof Error ? error.message : String(error);
    stickyError = true;
    publish();
    onError?.(lastError);
    return lastError;
  }
  function resetLevels() { onLevels?.(emptyMicrophoneLevels()); }
  function persist() {
    try {
      Promise.resolve(onSettings?.({ deviceId: selected, noiseSuppression: denoise })).catch(report);
    } catch (error) { report(error); }
  }
  function stopMonitor() {
    if (monitor) clearInterval(monitor);
    monitor = null;
  }
  function startMonitor() {
    stopMonitor();
    tickCount = 0;
    monitor = setInterval(() => {
      if (!capture || destroyed) { stopMonitor(); return; }
      if (capture.mode === 'test') {
        publish();
        if (Date.now() >= capture.deadline) { void stopTest().catch(report); return; }
      }
      if (++tickCount % 2 === 0 && !pending) void refresh({ checkDefault: true }).catch(() => {});
    }, 1000);
  }
  function closeNative(owner) {
    if (owner.id === null) return Promise.resolve();
    return invoke('audio_stop', { captureId: owner.id });
  }
  async function waitForStopped(owner) {
    if (owner.stopped) return;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 500);
      owner.resolveStopped = () => { clearTimeout(timer); resolve(); };
      if (owner.stopped) owner.resolveStopped();
    });
    owner.resolveStopped = null;
  }
  function sendPcm(owner, bytes) {
    if (owner.mode !== 'stream' || owner.retired || !owner.armed || !isReady()) return;
    const result = sendAudio(new Uint8Array(bytes).buffer);
    if (result === false && capture === owner && !owner.stopping) {
      report('Передача звука остановлена. Проверь соединение и включи микрофон снова.');
      void stop(false).catch(report);
    }
  }
  function receive(owner, event) {
    if (destroyed || owner.retired || owner.cancelled || !event || typeof event !== 'object') return;
    if (owner !== capture && pending?.owner !== owner) return;
    if (Number.isSafeInteger(event.capture_id)) {
      if (owner.id !== null && event.capture_id !== owner.id) return;
      owner.id ??= event.capture_id;
    }
    if (event.type === 'started') {
      owner.deviceName = typeof event.device_name === 'string' ? event.device_name : '';
      owner.actualDeviceId = typeof event.device_id === 'string' ? event.device_id : '';
      return;
    }
    if (event.type === 'stopped') {
      owner.stopped = true;
      owner.stopReason = event.error || event.reason || 'Захват микрофона остановлен.';
      owner.resolveStopped?.();
      if (owner.stopping || owner !== capture) return;
      capture = null;
      stopMonitor();
      resetLevels();
      status = owner.mode === 'test' ? 'Проверка завершена' : 'Микрофон выключен';
      const reasonError = event.error || ({
        device_lost: 'Микрофон отключён или перестал отвечать. Подключи его или выбери другой.',
        overflow: 'Обработка звука не успевает за микрофоном. Захват остановлен.',
        receiver_closed: 'Канал микрофона закрыт. Включи микрофон снова.',
      })[event.reason];
      if (reasonError) {
        status = owner.mode === 'test' ? 'Проверка прервана' : 'Захват микрофона прерван';
        report(reasonError);
      } else publish();
      if (!pending) void refresh().catch(() => {});
      // A replacement capture continues the same Realtime microphone interval.
      if (owner.mode === 'stream' && owner.armed && !pending && isReady()) {
        void Promise.resolve(sendEvent('mic_stop')).catch(report);
      }
      return;
    }
    if (event.type === 'levels') {
      if (owner !== capture || owner.stopping) return;
      onLevels?.(microphoneLevels(event, { active: true, testing: owner.mode === 'test' }));
      return;
    }
    if (event.type !== 'pcm' || owner.mode !== 'stream') return;
    const bytes = event.data;
    if (!Array.isArray(bytes) || !bytes.length || bytes.length > 9600 || bytes.length % 2 !== 0
      || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      report('Микрофон передал некорректный аудиофрагмент.');
      void stop(false).catch(report);
      return;
    }
    if (owner !== capture || !owner.armed) {
      owner.bufferedBytes += bytes.length;
      if (owner.bufferedBytes > MAX_PENDING_PCM_BYTES) {
        owner.cancelled = true;
        report('Запуск передачи звука не завершён. Включи микрофон снова.');
        void closeNative(owner).catch(report);
      } else owner.pcm.push(bytes);
      return;
    }
    sendPcm(owner, bytes);
  }

  async function begin(mode, next = { deviceId: selected, noiseSuppression: denoise }) {
    if (destroyed) return false;
    if (mode === 'stream' && !isReady()) throw new Error('Голосовое подключение ещё не готово.');
    if (pending || configuring) throw new Error('Дождись завершения переключения микрофона.');
    const previous = capture;
    if (previous && previous.mode !== mode) throw new Error(mode === 'test'
      ? 'Останови диктовку перед локальной проверкой.' : 'Останови проверку микрофона перед диктовкой.');
    const epoch = ++operation;
    const owner = {
      id: null, mode, armed: false, retired: false, cancelled: false, stopped: false, stopping: false,
      pcm: [], bufferedBytes: 0, deviceName: '', actualDeviceId: '', resolveStopped: null,
      deadline: mode === 'test' ? previous?.deadline || Date.now() + TEST_MS : 0,
    };
    pending = { owner, epoch };
    lastError = '';
    stickyError = false;
    status = previous ? 'Переключение микрофона…' : mode === 'test' ? 'Открываем микрофон для проверки…' : 'Открываем микрофон…';
    publish();
    const channel = new Channel();
    channel.onmessage = event => receive(owner, event);
    try {
      const id = await invoke('audio_start', {
        mode, deviceId: next.deviceId || null, noiseSuppression: Boolean(next.noiseSuppression), onEvent: channel,
      });
      if (!Number.isSafeInteger(id) || id < 0 || (owner.id !== null && owner.id !== id)) throw new Error('Некорректный номер захвата микрофона.');
      owner.id = id;
      if (destroyed || operation !== epoch || owner.cancelled) {
        owner.retired = true;
        await closeNative(owner);
        return false;
      }
      if (owner.stopped) throw new Error(owner.stopReason);
      if (mode === 'stream' && !isReady()) throw new Error('Голосовое подключение закрыто во время запуска микрофона.');
      if (mode === 'stream' && !previous?.armed) {
        owner.remoteStarting = true;
        if (!await sendEvent('mic_start')) throw new Error('Не удалось начать передачу звука.');
        owner.remoteStarting = false;
        owner.remoteOpened = true;
      }
      if (owner.stopped && !owner.cancelled) throw new Error(owner.stopReason);
      if (destroyed || operation !== epoch || owner.cancelled) {
        owner.retired = true;
        await closeNative(owner);
        return false;
      }
      if (previous) previous.retired = true;
      capture = owner;
      owner.armed = mode === 'stream';
      selected = next.deviceId || '';
      denoise = Boolean(next.noiseSuppression);
      pending = null;
      status = mode === 'test' ? 'Проверка микрофона · звук остаётся на компьютере' : 'Микрофон включён';
      publishDevices();
      publish();
      persist();
      for (const bytes of owner.pcm) sendPcm(owner, bytes);
      owner.pcm = [];
      owner.bufferedBytes = 0;
      startMonitor();
      return true;
    } catch (error) {
      owner.retired = true;
      await closeNative(owner).catch(() => {});
      if (owner.remoteOpened && !previous?.armed && isReady()) await Promise.resolve(sendEvent('mic_stop')).catch(() => {});
      if (operation !== epoch || destroyed || owner.cancelled) return false;
      pending = null;
      capture = previous && !previous.stopped ? previous : null;
      if (!capture) { stopMonitor(); resetLevels(); }
      status = capture ? capture.mode === 'test' ? 'Проверка продолжается на прежнем микрофоне' : 'Прежний микрофон продолжает работать' : 'Микрофон выключен';
      report(error);
      throw error;
    } finally {
      if (pending?.owner === owner) { pending = null; publish(); }
    }
  }

  async function end(mode, sendTail) {
    if (pending?.owner.mode === mode) {
      ++operation;
      const cancelled = pending.owner;
      cancelled.cancelled = true;
      pending = null;
      void closeNative(cancelled).catch(report);
      if (mode === 'stream' && (cancelled.remoteStarting || cancelled.remoteOpened) && isReady()) {
        await Promise.resolve(sendEvent('mic_stop')).catch(report);
        cancelled.remoteOpened = false;
      }
    }
    const owner = capture?.mode === mode ? capture : null;
    if (!owner) { publish(); return; }
    if (owner.stopping) return owner.stopPromise;
    owner.stopping = true;
    status = mode === 'test' ? 'Останавливаем проверку…' : 'Микрофон выключается…';
    publish();
    if (!sendTail) { owner.retired = true; capture = null; resetLevels(); }
    stopMonitor();
    const completion = (async () => {
      try {
        await closeNative(owner);
        if (sendTail) await waitForStopped(owner);
      } finally {
        owner.retired = true;
        if (capture === owner) capture = null;
        resetLevels();
        status = mode === 'test' ? 'Проверка остановлена' : 'Микрофон выключен';
        publish();
      }
      if (mode === 'stream' && owner.armed && sendTail && isReady()) await sendEvent('mic_stop');
    })();
    owner.stopPromise = completion;
    return completion;
  }
  function stop(sendTail = true) { return end('stream', sendTail); }
  function stopTest() { return end('test', false); }

  async function refresh({ checkDefault = false } = {}) {
    if (destroyed) return;
    if (refreshPromise) return refreshPromise;
    const task = (async () => {
      try {
        const state = await invoke('audio_input_state');
        if (destroyed) return;
        devices = Array.isArray(state?.devices) ? state.devices.filter(device =>
          typeof device.id === 'string' && device.id && typeof device.name === 'string') : [];
        available = state?.available !== false && devices.length > 0;
        const newDefault = devices.find(device => device.is_default)?.id || '';
        const changed = Boolean(defaultId && newDefault && defaultId !== newDefault);
        defaultId = newDefault;
        publishDevices();
        if (selected && !devices.some(device => device.id === selected)) {
          lastError = 'Выбранный микрофон отключён. Подключи его или выбери другое устройство.';
          stickyError = true;
          if (capture && !pending) {
            try { await end(capture.mode, true); }
            catch (error) { report('Не удалось завершить захват отключённого микрофона: ' + String(error)); }
          }
        } else if (!stickyError && state?.error) lastError = String(state.error);
        else if (!stickyError && !available) lastError = 'Windows не обнаружила доступных микрофонов.';
        else if (!stickyError && !capture && !pending) lastError = '';
        publish();
        if (capture && !pending && !configuring && !selected && checkDefault && changed) {
          // Device enumeration succeeded. A replacement failure preserves the old
          // capture and must not masquerade as an inventory failure.
          try { await begin(capture.mode); } catch { /* begin reports the capture error. */ }
        }
      } catch (error) {
        available = false;
        if (!stickyError) lastError = 'Не удалось обновить микрофоны: ' + String(error);
        status = 'Список микрофонов недоступен';
        publishDevices();
        publish();
      }
    })();
    refreshPromise = task;
    void task.finally(() => { if (refreshPromise === task) refreshPromise = null; }).catch(() => {});
    return task;
  }
  async function configure(patch) {
    const next = { deviceId: selected, noiseSuppression: denoise, ...patch };
    next.deviceId = typeof next.deviceId === 'string' ? next.deviceId : '';
    next.noiseSuppression = Boolean(next.noiseSuppression);
    if (pending || configuring) throw new Error('Дождись завершения переключения микрофона.');
    if (next.deviceId && !devices.some(device => device.id === next.deviceId)) throw new Error('Выбранный микрофон недоступен. Обнови список устройств.');
    if (capture) {
      const owner = capture;
      if (next.deviceId !== selected) {
        const nextActualDevice = next.deviceId || defaultId;
        if (!owner.actualDeviceId || !nextActualDevice) {
          throw new Error('Дождись определения активного микрофона и повтори выбор.');
        }
        if (nextActualDevice !== owner.actualDeviceId) return begin(owner.mode, next);
      }
      // A default-device alias and the same explicit endpoint share one stream.
      // RNNoise changes only the worker DSP, never the microphone handle.
      if (next.noiseSuppression !== denoise) {
        configuring = true;
        publish();
        try {
          await invoke('audio_set_noise_suppression', { captureId: owner.id, enabled: next.noiseSuppression });
          if (capture !== owner || owner.stopped || owner.retired || destroyed) return false;
        } catch (error) { report(error); throw error; }
        finally { configuring = false; publish(); }
      }
    }
    selected = next.deviceId;
    denoise = next.noiseSuppression;
    lastError = '';
    stickyError = false;
    publishDevices();
    publish();
    persist();
    return true;
  }

  publish();
  publishDevices();
  resetLevels();
  return {
    start() {
      if (capture?.mode === 'stream' && !pending) return Promise.resolve(true);
      return begin('stream');
    },
    stop, stopTest, refresh,
    startTest() {
      if (capture?.mode === 'test' && !pending) return Promise.resolve(true);
      return begin('test');
    },
    select: deviceId => configure({ deviceId: String(deviceId || '') }),
    setNoiseSuppression: enabled => configure({ noiseSuppression: Boolean(enabled) }),
    async requestPermission() { await refresh(); },
    get active() { return Boolean(capture?.mode === 'stream'); },
    get testing() { return Boolean(capture?.mode === 'test'); },
    async destroy() {
      destroyed = true;
      stopMonitor();
      await Promise.allSettled([stop(false), stopTest()]);
    },
  };
}
