import { createNativeMicrophone } from './native-microphone.js';

const names = { audio_input_state: 'system_audio_state', audio_start: 'system_audio_start', audio_stop: 'system_audio_stop' };
const sourceText = value => String(value || '')
  .replaceAll('микрофонов', 'устройств вывода').replaceAll('микрофоны', 'устройства вывода')
  .replaceAll('микрофоном', 'источником звука').replaceAll('микрофона', 'источника звука')
  .replaceAll('Микрофон', 'Звук встречи').replaceAll('микрофон', 'источник звука');

/** Reuse bounded native capture lifecycle, with its own endpoint and owner.
 * System capture never falls back to getUserMedia or mixes into the mic. */
export function createSystemAudio({ nativeAudio, initialDevice = '', onDevice, onDevices,
  onState, onLevels, onError, isReady, sendEvent, sendAudio } = {}) {
  if (!nativeAudio) return {
    active: false, refresh: async () => {}, stop: async () => {}, destroy: async () => {},
    select: async () => {}, start: async () => { throw new Error('Захват звука встречи доступен в приложении Windows.'); },
  };
  const capture = createNativeMicrophone({
    nativeAudio: {
      Channel: nativeAudio.Channel,
      invoke(command, args) {
        const name = names[command];
        if (!name) throw new Error('Эта операция не поддерживается для звука встречи.');
        return nativeAudio.invoke(name, command === 'audio_start' ? { ...args, noiseSuppression: false } : args);
      },
    },
    initialSettings: { deviceId: initialDevice, noiseSuppression: false },
    onSettings: value => onDevice?.(value.deviceId),
    isReady,
    sendEvent: (type, data) => sendEvent(type === 'mic_start' ? 'system_start' : 'system_stop', data),
    sendAudio,
    onState: state => onState?.({
      systemAudioActive: !state.microphoneMuted,
      systemAudioBusy: state.microphoneBusy,
      systemAudioAvailable: state.audioAvailable,
      systemAudioDevice: state.microphoneDevice,
      systemAudioStatus: sourceText(state.microphoneStatus),
      systemAudioError: sourceText(state.microphoneError),
    }),
    onDevices: (devices, selected) => onDevices?.(devices.map(device => ({ ...device, label: sourceText(device.label) })), selected),
    onLevels: levels => onLevels?.({ ...levels, source: 'system' }),
    onError: error => onError?.(sourceText(error)),
  });
  return {
    get active() { return capture.active; },
    start: () => capture.start(),
    stop: tail => capture.stop(tail),
    refresh: () => capture.refresh(),
    select: deviceId => capture.select(deviceId),
    destroy: () => capture.destroy(),
  };
}
