import { test, expect } from '@playwright/test';

import { openNative, settingsPage } from './helpers/native.js';

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

test('native settings focus and visibility are isolated from the main overlay during a delayed open reply', async ({ page }) => {
  await openNative(page);
  const bounds = await page.locator('#overlay').boundingBox();
  const viewport = page.viewportSize();
  await page.evaluate(() => window.__nativeContract.delayNext('set_settings_open'));
  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  await expect(settings.locator('#settings-dialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.length)).toBe(1);
  await expect(page.locator('#settings-dialog')).toHaveCount(0);
  expect(await page.locator('#overlay').boundingBox()).toEqual(bounds);
  expect(page.viewportSize()).toEqual(viewport);
  await expect(settings.locator('#tab-appearance')).toBeFocused();

  await page.evaluate(() => window.__nativeContract.release('set_settings_open'));
  await expect(settings.locator('#tab-appearance')).toBeFocused();
  await settings.keyboard.press('Escape');
  await expect(settings.locator('#settings-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.calls.filter(call => call.name === 'set_settings_open').at(-1)?.args.open)).toBe(false);
  expect(await page.locator('#overlay').boundingBox()).toEqual(bounds);
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
