import { test, expect } from '@playwright/test';

/**
 * Frontend/IPC contract tests, not tests of Windows focus, hooks or capture.
 * The shim follows the installed Tauri core/event callbacks and store replies.
 * Production main.js, bridge.js and geometry.js execute their native branches.
 */
async function openNative(page) {
  await page.exposeFunction('__applyNativeSize', async ({ width, height }) => {
    await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
  });
  await page.addInitScript(() => {
    window.isTauri = true;
    // A native window resize does not resize the physical monitor.
    Object.defineProperty(screen, 'availWidth', { configurable: true, get: () => 1440 });
    Object.defineProperty(screen, 'availHeight', { configurable: true, get: () => 1000 });
    let nextId = 1;
    let state = {
      revision: 1, microphoneMuted: true, screenCaptureEnabled: false,
      scrollLocked: false, settingsOpen: false, connectionStatus: 'unavailable',
      audioAvailable: false, screenCaptureAvailable: false, liveAvailable: false,
      nativeWindow: true, nativeWheelRouting: true, platform: 'windows', lastError: '',
    };
    const callbacks = new Map();
    const listeners = new Map();
    const delayed = new Map();
    const pending = [];
    const values = new Map();
    const harness = {
      calls: [], resizes: [], saves: [], applyResizes: true, pending,
      delayNext(name) { delayed.set(name, (delayed.get(name) || 0) + 1); },
      release(name) {
        const index = pending.findIndex((item) => item.name === name);
        if (index < 0) throw new Error(`No pending ${name} reply`);
        const [item] = pending.splice(index, 1);
        item.resolve(item.value);
      },
      emit(event, payload) {
        for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, id, payload });
      },
      pushState(patch) {
        state = { ...state, ...patch, revision: state.revision + 1 };
        harness.emit('overlay:state', { ...state });
        return { ...state };
      },
    };
    window.__nativeContract = harness;

    async function execute(name, args) {
      harness.calls.push({ name, args });
      switch (name) {
        case 'plugin:event|listen': {
          const ids = listeners.get(args.event) || [];
          ids.push(args.handler);
          listeners.set(args.event, ids);
          return args.handler;
        }
        case 'plugin:event|unlisten':
          listeners.set(args.event, (listeners.get(args.event) || []).filter((id) => id !== args.eventId));
          return null;
        case 'get_runtime_state': return { ...state };
        case 'set_scroll_locked': return harness.pushState({ scrollLocked: args.locked });
        case 'set_microphone_muted': return harness.pushState({ microphoneMuted: args.muted });
        case 'set_settings_open': return harness.pushState({ settingsOpen: args.open });
        case 'resize_overlay':
          harness.resizes.push({ width: args.width, height: args.height });
          if (harness.applyResizes) await window.__applyNativeSize(args);
          return { width: innerWidth, height: innerHeight };
        case 'update_hit_rects':
          harness.hitRects = args.rects;
          return null;
        case 'plugin:store|load': return 1;
        case 'plugin:store|get': return [values.get(args.key) ?? null, values.has(args.key)];
        case 'plugin:store|set':
          values.set(args.key, structuredClone(args.value));
          return null;
        case 'plugin:store|save':
          harness.saves.push(structuredClone(values.get('appearance')));
          return null;
        default: throw new Error(`Unexpected native command in contract test: ${name}`);
      }
    }

    window.__TAURI_INTERNALS__ = {
      transformCallback(callback, once = false) {
        const id = nextId++;
        callbacks.set(id, (payload) => {
          if (once) callbacks.delete(id);
          callback(payload);
        });
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(name, args = {}) {
        const hold = (delayed.get(name) || 0) > 0;
        if (hold) delayed.set(name, delayed.get(name) - 1);
        // Capture the reply before a later event changes state, like real IPC.
        const value = await execute(name, args);
        if (hold) return new Promise((resolve) => pending.push({ name, value, resolve }));
        return value;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event, id) { callbacks.delete(id); },
    };
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).not.toHaveClass(/browser-preview/);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.resizes.length)).toBeGreaterThan(0);
}

async function sendTurn(page, content, preserveCode = false) {
  await page.evaluate(({ content, preserveCode }) => {
    const { emit } = window.__nativeContract;
    emit('assistant:turn-start', { preserveCode });
    for (let offset = 0; offset < content.length; offset += 19) {
      emit('assistant:chunk', { text: content.slice(offset, offset + 19) });
    }
    emit('assistant:turn-end', {});
  }, { content, preserveCode });
}

test('native bridge ignores an older command reply after a newer hotkey state and saves the newer value', async ({ page }) => {
  await openNative(page);
  await page.evaluate(() => window.__nativeContract.delayNext('set_scroll_locked'));
  await page.locator('[data-action="scroll-lock"]').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.length)).toBe(1);
  await expect(page.locator('[data-action="scroll-lock"]')).toHaveAttribute('aria-pressed', 'true');

  // Simulate a second, native hotkey change before the first command reply arrives.
  await page.evaluate(() => window.__nativeContract.pushState({ scrollLocked: false }));
  await expect(page.locator('[data-action="scroll-lock"]')).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => window.__nativeContract.release('set_scroll_locked'));
  await expect(page.locator('[data-action="scroll-lock"]')).toBeEnabled();
  await expect(page.locator('#overlay')).toHaveAttribute('data-scroll-locked', 'false');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.saves.at(-1)?.scrollLocked)).toBe(false);
});

test('settings wait for the native focus acknowledgement before moving keyboard focus into the modal', async ({ page }) => {
  await openNative(page);
  await page.evaluate(() => window.__nativeContract.delayNext('set_settings_open'));
  await page.locator('[data-action="settings"]').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.length)).toBe(1);
  // Give an incorrectly scheduled focus callback two animation frames to run.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#settings-dialog')))).toBe(false);

  await page.evaluate(() => window.__nativeContract.release('set_settings_open'));
  await expect(page.locator('#tab-appearance')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.calls.filter((call) => call.name === 'set_settings_open').at(-1)?.args.open)).toBe(false);
});

test('native response events preserve code during correction, resize back to short content and respect a small viewport', async ({ page }) => {
  await openNative(page);
  const longCode = Array.from({ length: 70 }, (_, index) => `SELECT ${index + 1};`).join('\n');
  await sendTurn(page, `<mode>code</mode><code_meta>{"filename":"query.sql","lang":"sql"}</code_meta><code>${longCode}</code><notes>Исходные пояснения.</notes>`);
  await expect(page.locator('#code-content .line')).toHaveCount(70);
  await expect.poll(() => page.evaluate(() => innerHeight)).toBeGreaterThan(500);
  const originalCode = await page.locator('#code-content').textContent();

  await sendTurn(page, '<mode>correction</mode><notes>Исправьте имя таблицы в редакторе.</notes>', true);
  await expect(page.locator('#notes-content')).toHaveText('Исправьте имя таблицы в редакторе.');
  await expect(page.locator('#code-filename')).toHaveText('query.sql');
  expect(await page.locator('#code-content').textContent()).toBe(originalCode);
  await expect(page.locator('#overlay')).toHaveAttribute('data-mode', 'code');

  await sendTurn(page, '<mode>code</mode><code_meta>{"filename":"short.sql","lang":"sql"}</code_meta><code>SELECT 1;</code><notes>Короткий ответ.</notes>');
  await expect(page.locator('#code-content .line')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => innerHeight)).toBeLessThan(400);
  const settledCount = await page.evaluate(() => window.__nativeContract.resizes.length);
  await page.waitForTimeout(350); // More than three geometry debounce intervals.
  expect(await page.evaluate(() => window.__nativeContract.resizes.length)).toBe(settledCount);

  // Simulate an OS/window-manager size constraint after the resize request.
  await page.evaluate(() => { window.__nativeContract.applyResizes = false; });
  await page.setViewportSize({ width: 560, height: 180 });
  const overlay = page.locator('#overlay');
  await expect.poll(async () => (await overlay.boundingBox()).y).toBeGreaterThanOrEqual(0);
  const box = await overlay.boundingBox();
  const toolbar = await page.locator('#toolbar').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(560);
  expect(box.y + box.height).toBeLessThanOrEqual(180);
  expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(180);
  await expect(page.locator('#code-panel')).toBeVisible();
  await expect(page.locator('#notes-panel')).toBeVisible();
});
