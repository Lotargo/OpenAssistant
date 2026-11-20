// Capturing/resampling settings are kept from the validated Pilot microphone path.
export function microphoneConstraints(deviceId = '') {
  const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

export function createMicrophone({ isReady, sendEvent, sendAudio, onState, onDevices, onError } = {}) {
  let audio = null;
  let selected = '';
  let devices = [];
  let defaultSignature = '';
  let switchRevision = 0;
  let generation = 0;
  let starting = null;
  let destroyed = false;

  function publish() {
    onState?.({ microphoneMuted: !audio, microphoneDevice: selected, audioAvailable: Boolean(navigator.mediaDevices?.getUserMedia) });
  }
  function publishDevices() {
    const preferred = devices.find(device => device.deviceId === 'default') || devices[0];
    onDevices?.([
      { deviceId: '', label: preferred?.label ? 'Системный · ' + preferred.label : 'Системный по умолчанию' },
      ...devices.filter(device => device.deviceId && !['default', 'communications'].includes(device.deviceId))
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || 'Микрофон ' + (index + 1) })),
    ], selected);
  }
  async function refresh({ checkDefault = false } = {}) {
    if (destroyed || !navigator.mediaDevices?.enumerateDevices) { publishDevices(); return; }
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
      if (destroyed) return;
      const preferred = devices.find(device => device.deviceId === 'default') || devices[0];
      const signature = preferred ? preferred.groupId || preferred.label || preferred.deviceId : '';
      const changed = Boolean(defaultSignature && signature && defaultSignature !== signature);
      defaultSignature = signature;
      const vanished = selected && !devices.some(device => device.deviceId === selected);
      if (vanished) selected = '';
      publishDevices();
      if (audio && (vanished || (!selected && checkDefault && changed))) await hotSwap('');
    } catch (error) {
      onError?.('Не удалось получить список микрофонов: ' + error.message);
    }
  }
  async function hotSwap(deviceId) {
    if (!audio) { selected = deviceId; publishDevices(); publish(); return; }
    const current = audio;
    const previous = current.devicePreference;
    const revision = ++switchRevision;
    let replacement;
    let source;
    try {
      replacement = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
      if (revision !== switchRevision || audio !== current || current.context.state === 'closed' || destroyed) {
        replacement.getTracks().forEach(track => track.stop());
        return;
      }
      source = current.context.createMediaStreamSource(replacement);
      source.connect(current.node);
      const oldSource = current.source;
      const oldStream = current.stream;
      current.source = source;
      current.stream = replacement;
      current.devicePreference = deviceId;
      selected = deviceId;
      oldSource.disconnect();
      oldStream.getTracks().forEach(track => track.stop());
      publishDevices();
      publish();
    } catch (error) {
      source?.disconnect();
      replacement?.getTracks().forEach(track => track.stop());
      if (revision === switchRevision && audio === current) {
        selected = previous;
        publishDevices();
        onError?.('Не удалось сменить микрофон. Предыдущий источник сохранён. ' + error.message);
      }
    }
  }

  async function startCapture() {
    if (audio || destroyed) return;
    if (!isReady()) throw new Error('Сначала подключись к Realtime.');
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      throw new Error('Для микрофона нужен Chrome или Edge с поддержкой AudioWorklet.');
    }
    const captureGeneration = ++generation;
    let stream;
    let context;
    try {
      const deviceId = selected;
      stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
      if (captureGeneration !== generation || destroyed || !isReady()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      context = new AudioContext({ sampleRate: 24000 });
      await context.audioWorklet.addModule(new URL('mic-worklet.js', document.baseURI).href);
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'pcm24k-recorder');
      const owned = { stream, context, source, node, devicePreference: deviceId, resolveFlush: null };
      node.port.onmessage = event => {
        if (event.data?.type === 'flushed') { owned.resolveFlush?.(); return; }
        if (audio !== owned || event.data?.type !== 'pcm') return;
        if (isReady()) sendAudio(event.data.buffer);
      };
      source.connect(node);
      node.connect(context.destination);
      await context.resume();
      if (captureGeneration !== generation || destroyed || !isReady()) {
        stream.getTracks().forEach(track => track.stop());
        source.disconnect();
        node.disconnect();
        await context.close().catch(() => {});
        return;
      }
      audio = owned;
      if (!await sendEvent('mic_start')) throw new Error('Соединение закрыто.');
      publish();
      await refresh();
    } catch (error) {
      if (audio?.context === context) audio = null;
      stream?.getTracks().forEach(track => track.stop());
      if (context) await context.close().catch(() => {});
      publish();
      if (captureGeneration !== generation || destroyed) return;
      const detail = error.name === 'NotAllowedError' ? 'Разреши доступ к микрофону в браузере.'
        : error.name === 'NotFoundError' ? 'Микрофон не найден.'
        : error.name === 'NotReadableError' ? 'Микрофон занят или не отвечает.'
        : error.message;
      throw new Error('Не удалось включить микрофон. ' + detail);
    }
  }
  function start() {
    if (starting) return starting;
    starting = startCapture().finally(() => { starting = null; });
    return starting;
  }
  async function stop(sendTail = true) {
    ++generation;
    ++switchRevision;
    const current = audio;
    if (!current) { publish(); return; }
    if (sendTail && isReady()) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 250);
        current.resolveFlush = () => { clearTimeout(timer); resolve(); };
        current.node.port.postMessage({ type: 'flush' });
      });
    }
    if (audio !== current) return;
    audio = null;
    current.stream.getTracks().forEach(track => track.stop());
    current.source.disconnect();
    current.node.disconnect();
    await current.context.close().catch(() => {});
    try { if (sendTail && isReady()) await sendEvent('mic_stop'); }
    finally { publish(); }
  }
  const onDeviceChange = () => { void refresh({ checkDefault: true }); };
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
  publish();
  return {
    start, stop, refresh,
    select: deviceId => hotSwap(String(deviceId || '')),
    get active() { return Boolean(audio); },
    async destroy() {
      destroyed = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      await stop(false);
    },
  };
}
