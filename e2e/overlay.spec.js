import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

async function openDemo(page, mode) {
  await page.goto(`/?demo=${mode}`);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
}

test('text uses rendered Markdown and a centered mode and broadcast strip with seven icon controls', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openDemo(page, 'text');
  const text = page.locator('#text-content');
  await expect(text.locator('h1')).toHaveText('Найти два числа с заданной суммой');
  await expect(text.locator('h2')).toHaveCount(3);
  await expect(text.locator('code')).not.toHaveCount(0);
  await expect(page.locator('#split-view')).toBeHidden();
  expect(await text.innerText()).not.toContain('##');

  const controls = page.locator('.toolbar-actions > button');
  await expect(controls).toHaveCount(7);
  expect(await controls.evaluateAll((buttons) => buttons.map((button) => button.dataset.action)))
    .toEqual(['screen', 'microphone', 'reconnect', 'settings', 'scroll-lock', 'window-mode', 'notifications']);
  for (const button of await controls.all()) {
    await expect(button.locator('svg')).toHaveCount(1);
    expect((await button.innerText()).trim()).toBe('');
    expect(await button.getAttribute('title')).toBeNull();
    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(36);
    expect(box.height).toBeGreaterThanOrEqual(36);
  }
  const overlay = await page.locator('#overlay').boundingBox();
  const toolbar = await page.locator('#toolbar').boundingBox();
  await expect(page.locator('#mode-switcher button')).toHaveCount(3);
  await expect(page.locator('#mode-switcher [aria-pressed="true"]')).toHaveCount(1);
  const strip = await page.locator('.toolbar-controls').boundingBox();
  expect(Math.abs(strip.x + strip.width / 2 - (overlay.x + overlay.width / 2))).toBeLessThan(2);
  expect(Math.abs(toolbar.y + toolbar.height - (overlay.y + overlay.height - 1))).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('streamed code remains separate from guidance and has syntax highlighting', async ({ page }) => {
  await openDemo(page, 'stream');
  await expect(page.locator('#text-panel')).toBeHidden();
  await expect(page.locator('#split-view')).toBeVisible();
  await expect(page.locator('#code-filename')).toHaveText('users.sql');
  const code = page.locator('#code-content');
  await expect(code).toContainText('SELECT');
  await expect(code).not.toContainText('Создайте файл');
  await expect(page.locator('#notes-content')).toContainText('Создайте файл');
  await expect(code.locator('.line')).toHaveCount(16);
  await expect(code.locator('.shiki')).not.toHaveClass(/plaintext/);
  const colors = await code.locator('.line > span[style]').evaluateAll((tokens) => [...new Set(tokens.map((token) => token.style.color))]);
  expect(colors.length).toBeGreaterThan(2);
  const codeBox = await page.locator('.code-card').boundingBox();
  const notesBox = await page.locator('#notes-panel').boundingBox();
  expect(codeBox.x).toBeLessThan(notesBox.x);
  expect(codeBox.width / notesBox.width).toBeGreaterThan(1.45);
  expect(codeBox.width / notesBox.width).toBeLessThan(1.55);
});

test('settings preview colors, opacity and font live, persist, and trap focus', async ({ page }) => {
  await openDemo(page, 'text');
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#overlay')).toHaveAttribute('inert', '');

  // The first and last enabled controls wrap within the dialog.
  await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#setting-font-size')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeFocused();

  const hex = page.getByRole('textbox', { name: 'HEX', exact: true });
  await hex.fill('#394454');
  await hex.press('Enter');
  await expect.poll(() => page.locator('html').evaluate((element) => element.style.getPropertyValue('--panel-rgb'))).toBe('57, 68, 84');
  await page.getByRole('button', { name: 'Цвет текста', exact: true }).click();
  await hex.fill('#E5EAF2');
  await hex.press('Enter');
  await expect.poll(() => page.locator('html').evaluate((element) => element.style.getPropertyValue('--text-color'))).toBe('#E5EAF2');

  await page.locator('#setting-opacity').focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-value="opacity"]')).toHaveText('100%');
  await expect.poll(() => page.locator('html').evaluate((element) => element.style.getPropertyValue('--panel-opacity'))).toBe('1');
  await page.locator('#setting-font-size').focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-value="fontSize"]')).toHaveText('22 px');
  await expect(page.locator('#text-panel')).toHaveCSS('font-size', '22px');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openassistant.settings.v1') || '{}').fontSize)).toBe(22);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Открыть настройки', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#text-panel')).toHaveCSS('font-size', '22px');
  await expect.poll(() => page.locator('html').evaluate((element) => element.style.getPropertyValue('--panel-rgb'))).toBe('57, 68, 84');
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  await expect(page.locator('#setting-opacity')).toHaveValue('100');
});

test('invalid HEX cannot corrupt saved theme and canvas supports keyboard editing', async ({ page }) => {
  await openDemo(page, 'settings');
  const hex = page.getByRole('textbox', { name: 'HEX', exact: true });
  await hex.fill('wrong');
  await hex.press('Enter');
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#picker-hex-error')).toBeVisible();
  expect(await page.locator('html').evaluate((element) => element.style.getPropertyValue('--panel-rgb'))).toBe('32, 35, 41');
  await page.locator('canvas.color-square').focus();
  await page.keyboard.press('ArrowUp');
  await expect(hex).toHaveAttribute('aria-invalid', 'false');
  await expect(hex).not.toHaveValue('#202329');
  await expect(page.locator('#picker-hex-error')).toBeHidden();
});

test('scroll lock blocks manual wheel and unlock restores scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 400 });
  await openDemo(page, 'text');
  const panel = page.locator('#text-panel');
  await panel.evaluate((element) => { element.scrollTop = 0; });
  expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.getByRole('button', { name: 'Заблокировать прокрутку', exact: true }).click();
  await panel.hover();
  await page.mouse.wheel(0, 220);
  await page.waitForTimeout(150);
  expect(await panel.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'Разблокировать прокрутку', exact: true }).click();
  await panel.hover();
  await page.mouse.wheel(0, 220);
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test('browser preview explains unavailable capture and native-only Codex without pretending to connect', async ({ page }) => {
  await openDemo(page, 'text');
  const screen = page.locator('#toolbar [data-action="screen"]');
  await screen.click();
  await expect(page.locator('#tab-screen')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settings-runtime-error')).toContainText('Передача изображения экрана модели в этой версии не подключена');
  await expect(screen).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#section-screen')).toBeVisible();
  await expect(page.locator('#screen-capture')).toBeDisabled();
  await page.keyboard.press('Escape');
  const reconnect = page.locator('#toolbar [data-action="reconnect"]');
  await reconnect.click();
  await expect(page.locator('#agent-error')).toContainText('Codex доступен в приложении OpenAssistant');
  await expect(reconnect).not.toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#tab-agent')).toHaveAttribute('aria-selected', 'true');
});

test('narrow viewport preserves both panes and keeps the modal inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page, 'code');
  await expect(page.locator('#code-panel')).toBeVisible();
  await expect(page.locator('#notes-panel')).toBeVisible();
  const code = await page.locator('#code-panel').boundingBox();
  const notes = await page.locator('#notes-panel').boundingBox();
  expect(code.x + code.width).toBeLessThan(notes.x);
  expect(notes.x + notes.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
  const dialog = await page.locator('#settings-dialog').boundingBox();
  expect(dialog.x).toBeGreaterThanOrEqual(0);
  expect(dialog.y).toBeGreaterThanOrEqual(0);
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(390);
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(844);
  await page.getByRole('tab', { name: 'Поведение' }).click();
  await expect(page.getByLabel('Блокировка прокрутки', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
});

test('capture all three reference layouts for visual review', async ({ page }, testInfo) => {
  const screenshotDirectory = process.env.OPENASSISTANT_SCREENSHOT_DIR
    || testInfo.outputPath('screenshots');
  await mkdir(screenshotDirectory, { recursive: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const mode of ['text', 'code', 'settings']) {
    await openDemo(page, mode);
    await page.screenshot({ path: path.join(screenshotDirectory, `${mode}.png`), animations: 'disabled' });
  }
});
