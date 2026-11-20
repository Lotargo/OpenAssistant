import { test, expect } from '@playwright/test';
import { openNative, settingsPage, connectAgent, sendTask, emitSession } from './helpers/native.js';

test('separate settings forward appearance to the owner, stay opaque and reopen after native close', async ({ page }) => {
  await openNative(page);
  const bounds = await page.locator('#overlay').boundingBox();
  const viewport = page.viewportSize();
  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  await settings.locator('#picker-hex').fill('#123456');
  await settings.locator('#picker-hex').press('Tab');
  await expect.poll(() => page.locator('html').evaluate(node => node.style.getPropertyValue('--panel-rgb'))).toBe('18, 52, 86');
  await settings.locator('#setting-opacity').evaluate(node => {
    node.value = '24';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => page.locator('html').evaluate(node => node.style.getPropertyValue('--panel-opacity'))).toBe('0.24');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.saves.at(-1)?.opacity)).toBe(24);
  expect(await settings.locator('#settings-dialog').evaluate(node => ({
    color: getComputedStyle(node).backgroundColor, opacity: getComputedStyle(node).opacity,
  }))).toEqual({ color: 'rgb(24, 24, 27)', opacity: '1' });
  expect(await page.locator('#overlay').boundingBox()).toEqual(bounds);
  expect(page.viewportSize()).toEqual(viewport);

  await settings.reload();
  await expect(settings.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(settings.locator('#picker-hex')).toHaveValue('#123456');
  await expect(settings.locator('#setting-opacity')).toHaveValue('24');
  const beforeClose = await page.evaluate(() => window.__nativeContract.calls.filter(call => call.name === 'set_settings_open').length);
  await page.evaluate(() => window.__nativeContract.closeSettingsWindow());
  await expect(settings.locator('#settings-dialog')).toBeHidden();
  // An observed Alt+F4/hide state must not issue another native close command.
  expect(await page.evaluate(() => window.__nativeContract.calls.filter(call => call.name === 'set_settings_open').length)).toBe(beforeClose);
  await page.locator('[data-action="settings"]').click();
  await expect(settings.locator('#tab-appearance')).toBeFocused();
  await expect(settings.locator('#picker-hex')).toHaveValue('#123456');
  expect(await page.locator('#overlay').boundingBox()).toEqual(bounds);
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length,
    captures: window.__nativeContract.captureIds.length,
  }))).toEqual({ sessions: 0, captures: 0 });
  const directCalls = await settings.evaluate(() => window.__settingsNativeCalls.map(call => call.name));
  expect(directCalls.some(name => /^(assistant_|audio_|plugin:store)/.test(name))).toBe(false);
});

test('reloading the settings view stops a local check while the owner task and later approval remain usable', async ({ page }) => {
  await openNative(page);
  const sessionId = await connectAgent(page);
  const task = await sendTask(page, 'Задача переживает перезагрузку настроек');
  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  await settings.locator('#tab-audio').click();
  await settings.locator('#mic-test').click();
  await expect(settings.locator('#mic-test')).toHaveAttribute('aria-pressed', 'true');
  const captureId = await page.evaluate(() => window.__nativeContract.lastCapture().id);

  await settings.reload();
  await expect(settings.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(false);
  expect(await page.evaluate(() => window.__nativeContract.sessionIds)).toEqual([sessionId]);
  expect(await page.evaluate(() => window.__nativeContract.calls.filter(call => call.name === 'assistant_disconnect'))).toEqual([]);
  await expect(page.locator('#text-content')).toContainText('Codex выполняет задачу');
  await emitSession(page, sessionId, {
    type: 'agent_approval', task_id: task.task_id, request_id: 'after-reload',
    command: 'fixture after reload', reason: 'Подтверждение после перезагрузки', choices: ['accept', 'decline'],
  });
  const card = settings.locator('.approval-card[data-request-id="after-reload"]');
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  expect(await page.evaluate(() => window.__nativeContract.messages.filter(message => message.type === 'agent_approval'))).toEqual([]);
  await card.locator('[data-approval-decision="decline"]').click();
  await expect(card).toHaveCount(0);
  await page.evaluate(taskId => window.__nativeContract.finishTask(taskId, 'Владелец сессии продолжил работу.'), task.task_id);
  await expect(page.locator('#text-content')).toHaveText('Владелец сессии продолжил работу.');
  expect(await page.evaluate(() => window.__nativeContract.captureIds)).toEqual([captureId]);
  expect(await page.evaluate(() => window.__nativeContract.audio)).toEqual([]);
});

test('accent picker persists through the separate window and owner reload while rounded settings stay opaque', async ({ page }) => {
  await openNative(page);
  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  const accentTarget = settings.locator('[data-color-target="accentColor"]');
  await accentTarget.click();
  await settings.locator('#picker-hex').fill('#2e8b57');
  await settings.locator('#picker-hex').press('Tab');
  await expect(settings.locator('#picker-hex')).toHaveValue('#2E8B57');
  for (const view of [page, settings]) {
    await expect.poll(() => view.locator('html').evaluate(node => node.style.getPropertyValue('--settings-accent'))).toBe('#2E8B57');
  }
  await expect.poll(() => page.evaluate(() => window.__nativeContract.saves.at(-1)?.accentColor)).toBe('#2E8B57');
  expect(await page.evaluate(() => ({
    panelColor: window.__nativeContract.saves.at(-1)?.panelColor,
    textColor: window.__nativeContract.saves.at(-1)?.textColor,
  }))).toEqual({ panelColor: '#202329', textColor: '#F5F7FA' });
  expect(await settings.locator('#settings-dialog').evaluate(node => ({
    background: getComputedStyle(node).backgroundColor,
    radius: getComputedStyle(node).borderTopLeftRadius,
    opacity: getComputedStyle(node).opacity,
  }))).toEqual({ background: 'rgb(24, 24, 27)', radius: '8px', opacity: '1' });

  await settings.reload();
  await expect(settings.locator('html')).toHaveAttribute('data-ready', 'true');
  await accentTarget.click();
  await expect(settings.locator('#picker-hex')).toHaveValue('#2E8B57');
  await settings.keyboard.press('Escape');
  await expect(settings.locator('#settings-dialog')).toBeHidden();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => page.locator('html').evaluate(node => node.style.getPropertyValue('--settings-accent'))).toBe('#2E8B57');
  await page.locator('[data-action="settings"]').click();
  await expect(settings.locator('#settings-dialog')).toBeVisible();
  await accentTarget.click();
  await expect(settings.locator('#picker-hex')).toHaveValue('#2E8B57');
  await expect.poll(() => settings.locator('html').evaluate(node => node.style.getPropertyValue('--settings-accent'))).toBe('#2E8B57');
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length, captures: window.__nativeContract.captureIds.length,
  }))).toEqual({ sessions: 0, captures: 0 });
});