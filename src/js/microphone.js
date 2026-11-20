import { createMicrophone as createBrowserMicrophone } from './browser-microphone.js';
import { createNativeMicrophone } from './native-microphone.js';

export { microphoneConstraints } from './browser-microphone.js';

/** Windows uses CPAL so device discovery does not depend on WebView permissions. */
export function createMicrophone(options = {}) {
  if (options.nativeAudio) return createNativeMicrophone(options);
  const browser = createBrowserMicrophone(options);
  return {
    ...browser,
    get active() { return browser.active; },
    get testing() { return false; },
    async startTest() { throw new Error('Локальная проверка микрофона доступна в приложении OpenAssistant.'); },
    async stopTest() {},
    async setNoiseSuppression() { throw new Error('Шумоподавление доступно в приложении OpenAssistant.'); },
    async requestPermission() { await browser.refresh(); },
  };
}
