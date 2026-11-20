const MAX_AUDIO_BYTES = 240_000;

/** Ordered Tauri IPC with bounded audio buffering and stale-session isolation. */
export function createAssistantTransport({ invoke, Channel, onEvent, onError } = {}) {
  let generation = 0;
  let sessionId = null;
  let queue = Promise.resolve();
  let bufferedBytes = 0;
  let destroyed = false;

  function enqueue(command, payload, bytes = 0) {
    const epoch = generation;
    const target = sessionId;
    if (target === null || destroyed) return Promise.reject(new Error('Соединение закрыто.'));
    bufferedBytes += bytes;
    const operation = queue.then(async () => {
      if (epoch !== generation || target !== sessionId || destroyed) return false;
      await invoke(command, { sessionId: target, ...payload });
      return true;
    }).finally(() => { bufferedBytes -= bytes; });
    queue = operation.catch(() => {});
    return operation;
  }

  async function disconnect() {
    ++generation;
    const previous = sessionId;
    sessionId = null;
    // New sessions are not delayed by a command from an obsolete session.
    queue = Promise.resolve();
    if (previous !== null) await invoke('assistant_disconnect', { sessionId: previous });
  }

  return {
    get connected() { return sessionId !== null; },
    get sessionId() { return sessionId; },
    get bufferedAmount() { return bufferedBytes; },
    async connect(config) {
      if (destroyed) throw new Error('Интерфейс закрыт.');
      const epoch = ++generation;
      const previous = sessionId;
      sessionId = null;
      queue = Promise.resolve();
      if (previous !== null) await invoke('assistant_disconnect', { sessionId: previous });
      if (epoch !== generation || destroyed) return null;
      const events = new Channel();
      events.onmessage = event => {
        if (epoch === generation && !destroyed && event && typeof event === 'object' && !Array.isArray(event)) {
          onEvent?.(event);
        }
      };
      const created = await invoke('assistant_connect', { config, onEvent: events });
      if (!Number.isSafeInteger(created) || created < 0) throw new Error('Сервер вернул некорректный номер сессии.');
      if (epoch !== generation || destroyed) {
        await invoke('assistant_disconnect', { sessionId: created });
        return null;
      }
      sessionId = created;
      return created;
    },
    send(message) { return enqueue('assistant_send', { message }); },
    audio(buffer, source = 'microphone', broadcastId = null) {
      if (!['microphone', 'system'].includes(source) || typeof broadcastId !== 'string' || !broadcastId || broadcastId.length > 80) return false;
      if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || sessionId === null || destroyed) return false;
      if (buffer.byteLength > 9600 || bufferedBytes + buffer.byteLength > MAX_AUDIO_BYTES) {
        onError?.(new Error('Передача аудио не успевает за микрофоном. Микрофон остановлен.'));
        return false;
      }
      const epoch = generation;
      void enqueue('assistant_audio', { audio: Array.from(new Uint8Array(buffer)), source, broadcastId }, buffer.byteLength)
        .catch(error => { if (epoch === generation && !destroyed) onError?.(error); });
      return true;
    },
    disconnect,
    async destroy() {
      destroyed = true;
      await disconnect();
    },
  };
}