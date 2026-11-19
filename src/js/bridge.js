import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { load } from '@tauri-apps/plugin-store';

const SETTINGS_KEY = 'openassistant.settings.v1';

/** The browser preview deliberately has no capture or model simulation. */
export async function createBridge({ onState, onScroll, onSettings, onError, onTurnStart, onChunk, onTurnEnd } = {}) {
  const native = isTauri();
  let runtime = {
    microphoneMuted: true,
    screenCaptureEnabled: false,
    scrollLocked: false,
    settingsOpen: false,
    connectionStatus: 'unavailable',
    audioAvailable: false,
    screenCaptureAvailable: false,
    liveAvailable: false,
    nativeWindow: native,
    platform: native ? 'desktop' : 'browser',
    lastError: '',
  };
  let store;
  let saveQueue = Promise.resolve();
  const unlisten = [];

  function publish(state) {
    // IPC replies and emitted events may arrive out of order. A late reply must
    // never undo a newer hotkey change or persist an obsolete scroll-lock value.
    if (Number.isSafeInteger(state?.revision) && state.revision < (runtime.revision ?? -1)) {
      return { ...runtime };
    }
    runtime = { ...runtime, ...state };
    onState?.({ ...runtime });
    return { ...runtime };
  }

  function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    publish({ lastError: message });
    onError?.(message);
    return message;
  }

  async function command(name, args = {}) {
    try {
      if (native) return publish(await invoke(name, args));
      switch (name) {
        case 'set_microphone_muted': return publish({ microphoneMuted: args.muted });
        case 'set_scroll_locked': return publish({ scrollLocked: args.locked });
        case 'set_settings_open': return publish({ settingsOpen: args.open });
        case 'set_screen_capture_enabled':
          if (!args.enabled) return publish({ screenCaptureEnabled: false });
          throw new Error('Захват экрана ещё не подключён. Передача изображения модели не ведётся.');
        case 'reconnect_session':
          throw new Error('Gemini Live ещё не подключён. Соединение с моделью не установлено.');
        default: throw new Error(`Неизвестная команда: ${name}`);
      }
    } catch (error) {
      reportError(error);
      throw error;
    }
  }

  if (native) {
    // Subscribe before reading state: a tray/hotkey change must not be lost.
    const handlers = {
      'overlay:state': publish,
      'overlay:scroll': payload => onScroll?.(payload),
      'overlay:settings': payload => onSettings?.(payload),
      'overlay:error': payload => reportError(payload?.message ?? payload),
      'assistant:turn-start': payload => onTurnStart?.(payload),
      'assistant:chunk': payload => onChunk?.(payload),
      'assistant:turn-end': payload => onTurnEnd?.(payload),
    };
    for (const [event, handler] of Object.entries(handlers)) {
      unlisten.push(await listen(event, ({ payload }) => handler(payload)));
    }
    publish(await invoke('get_runtime_state'));
  }

  return {
    native,
    getRuntimeState: () => ({ ...runtime }),
    command,
    reportError,
    async loadSettings() {
      try {
        if (native) {
          store ??= await load('settings.json', { autoSave: false, defaults: {} });
          return await store.get('appearance');
        }
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
      } catch (error) {
        reportError(`Не удалось прочитать настройки: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    },
    saveSettings(settings) {
      // Serialize saves so rapid slider input cannot overwrite a newer value.
      const snapshot = structuredClone(settings);
      const operation = saveQueue.then(async () => {
        if (native) {
          store ??= await load('settings.json', { autoSave: false, defaults: {} });
          await store.set('appearance', snapshot);
          await store.save();
        } else {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
        }
      });
      saveQueue = operation.catch(() => {});
      return operation.catch(error => {
        reportError(`Не удалось сохранить настройки: ${error instanceof Error ? error.message : error}`);
        throw error;
      });
    },
    async resize(width, height) {
      if (native) await invoke('resize_overlay', { width, height });
    },
    async updateHitRects(rects) {
      if (native) await invoke('update_hit_rects', { rects });
    },
    async destroy() {
      for (const stop of unlisten) stop();
      await saveQueue;
    },
  };
}
