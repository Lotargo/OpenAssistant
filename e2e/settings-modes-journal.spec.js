import { test, expect } from '@playwright/test';
import { openNative, openSettingsTab, connectAgent, sendTask, emitSession, setPressed } from './helpers/native.js';

test('custom mode keeps its exact draft and disabled voice across both window reloads and native connect', async ({ page }) => {
  await openNative(page);
  let settings = await openSettingsTab(page, 'modes');
  await settings.locator('#agent-scenario').selectOption('custom');
  await expect(settings.locator('#agent-custom-fields')).toBeVisible();
  await settings.locator('#agent-custom-name').fill('🙂'.repeat(65));
  expect([...(await settings.locator('#agent-custom-name').inputValue())]).toHaveLength(64);
  await settings.locator('#agent-custom-name').fill('Разбор SQL');
  const instructions = '  Сначала уточни ограничения.\nПоказывай один короткий SQL-пример.\n\tНе меняй проект.  ';
  await settings.locator('#agent-custom-instructions').fill(instructions);
  await settings.locator('#agent-custom-behavior').selectOption('on_request');
  const expected = { scenario: 'custom', custom_name: 'Разбор SQL', custom_instructions: instructions, custom_behavior: 'on_request', realtime: false };
  await settings.locator('#tab-agent').click();
  await expect(settings.locator('#agent-realtime')).toHaveJSProperty('tagName', 'BUTTON');
  await setPressed(settings.locator('#agent-realtime'), false);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1))).toMatchObject(expected);
  const toggleColors = await settings.locator('#section-agent').evaluate(section => {
    const active = section.querySelector('#agent-web-search');
    const inactive = section.querySelector('#agent-realtime');
    return [getComputedStyle(active).backgroundColor, getComputedStyle(inactive).backgroundColor];
  });
  expect(toggleColors[0]).not.toBe(toggleColors[1]);
  await settings.locator('#tab-modes').click();
  await expect(settings.locator('#interview-start')).toBeDisabled();
  await expect(settings.locator('#interview-detail')).toContainText('Голос выключен');
  await settings.locator('#agent-scenario').selectOption('assistant');
  await expect(settings.locator('#agent-custom-fields')).toBeHidden();
  await expect(settings.locator('#voice-start')).toBeDisabled();
  await settings.locator('#agent-scenario').selectOption('custom');
  await expect(settings.locator('#agent-custom-instructions')).toHaveValue(instructions);
  await settings.reload();
  await expect(settings.locator('html')).toHaveAttribute('data-ready', 'true');
  await settings.locator('#tab-modes').click();
  await expect(settings.locator('#agent-custom-name')).toHaveValue(expected.custom_name);
  await expect(settings.locator('#agent-custom-instructions')).toHaveValue(instructions);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  settings = await openSettingsTab(page, 'modes');
  await expect(settings.locator('#agent-scenario')).toHaveValue('custom');
  await expect(settings.locator('#agent-custom-behavior')).toHaveValue('on_request');
  await expect(settings.locator('#agent-custom-instructions')).toHaveValue(instructions);
  await settings.locator('#tab-agent').click();
  await expect(settings.locator('#agent-realtime')).toHaveAttribute('aria-pressed', 'false');
  await settings.locator('#agent-connect').click();
  await expect(settings.locator('#agent-connect')).toHaveText('Переподключить');
  const config = await page.evaluate(() => window.__nativeContract.calls.find(call => call.name === 'assistant_connect').args.config);
  expect(config).toMatchObject(expected);
  expect(await page.evaluate(() => window.__nativeContract.captureIds)).toEqual([]);
});

for (const change of ['stop-connect', 'mode-stop', 'instructions']) {
  test('custom dialogue cannot start capture after pending broadcast ' + change, async ({ page }) => {
    await openNative(page, { autoReady: false, autoVoiceReady: false });
    const settings = await openSettingsTab(page, 'modes');
    await settings.locator('#agent-scenario').selectOption('custom');
    await expect(page.locator('#mode-switcher [data-scenario="custom"]')).toHaveAttribute('aria-pressed', 'true');
    if (change === 'stop-connect') await page.evaluate(() => window.__nativeContract.delayNext('assistant_connect'));
    await settings.locator('#voice-start').click();
    await expect.poll(() => page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(1);
    const sessionId = await page.evaluate(() => window.__nativeContract.sessionIds[0]);
    await expect(settings.locator('#voice-stop')).toBeEnabled();
    if (change === 'stop-connect') {
      await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.some(item => item.name === 'assistant_connect'))).toBe(true);
      await settings.locator('#voice-stop').click();
      await page.evaluate(() => window.__nativeContract.release('assistant_connect'));
      await page.evaluate(id => window.__nativeContract.readySession(id), sessionId);
    } else {
      await page.evaluate(id => window.__nativeContract.readySession(id), sessionId);
      await expect.poll(() => page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(1);
      await expect(settings.locator('#agent-realtime-status')).toContainText('подключается');
      if (change === 'mode-stop') {
        // Changing source semantics ends the pending old broadcast; it must not
        // automatically create a microphone-plus-system broadcast.
        await settings.locator('#agent-custom-behavior').selectOption('selective');
        await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.custom_behavior)).toBe('selective');
      } else {
        await settings.locator('#agent-custom-instructions').fill('Новое правило после готовности текстового агента.');
        await settings.locator('#agent-custom-name').focus();
        await expect(settings.locator('#mode-config-status')).toContainText('следующем подключении');
      }
    }
    await page.evaluate(id => window.__nativeContract.readyBroadcast(id), sessionId);
    await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
    await expect(page.locator('[data-action="microphone"]')).toBeDisabled();
    if (change === 'instructions') await expect(settings.locator('#agent-error')).toContainText('Настройки изменились во время подключения');
    await expect(settings.locator(change === 'mode-stop' ? '#interview-stop' : '#voice-stop')).toBeDisabled();
    expect(await page.evaluate(() => ({
      microphone: window.__nativeContract.audioStarts,
      system: window.__nativeContract.systemAudioStarts,
      starts: window.__nativeContract.broadcastStarts.length,
    }))).toEqual({ microphone: [], system: [], starts: change === 'stop-connect' ? 0 : 1 });
    await settings.locator('#tab-agent').click();
    await settings.locator('#agent-prompt').fill('Текстовый агент остаётся доступен.');
    await expect(settings.locator('#agent-send')).toBeEnabled();
  });
}

test('journal copies every shown record and clear does not cancel work or revive late item updates', async ({ page }) => {
  await openNative(page);
  const sessionId = await connectAgent(page);
  const task = await sendTask(page, 'Offline journal contract task');
  await page.evaluate(({ sessionId, taskId }) => {
    const h = window.__nativeContract;
    for (let index = 0; index < 65; index++) h.emitSession(sessionId, {
      type: 'agent_activity', task_id: taskId, item_id: 'journal-' + index,
      kind: 'command', title: 'Journal step ' + index, status: 'completed',
      detail: 'Step detail ' + index, command: 'fixture-command ' + index,
      path: 'file-' + index + '.rs',
      changes: index === 64 ? [{ path: 'answer.rs', diff: '+fn answer() -> u8 { 42 }' }] : [],
    });
  }, { sessionId, taskId: task.task_id });
  const settings = await openSettingsTab(page, 'journal');
  await expect(settings.locator('#agent-log [data-kind="command"]')).toHaveCount(66);
  const titles = await settings.locator('#agent-log .activity-heading strong').allTextContents();
  expect(titles).toContain('Journal step 0');
  expect(titles).toContain('Journal step 64');
  await expect(settings.locator('#agent-log time').first()).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(settings.locator('#agent-log .activity-item').first()).toHaveAttribute('data-activity-id', /.+/);
  await settings.locator('#journal-copy').click();
  await expect(settings.locator('#journal-status')).toContainText('Журнал скопирован');
  const copied = await page.evaluate(() => window.__nativeContract.clipboardWrites.at(-1));
  for (const title of titles) expect(copied).toContain(title);
  for (const value of ['fixture-command 64', 'Step detail 64', 'file-64.rs', 'answer.rs', '+fn answer() -> u8 { 42 }', task.task_id, 'journal-64']) expect(copied).toContain(value);
  await settings.locator('#journal-clear').click();
  await expect(settings.locator('#agent-log .activity-item')).toHaveCount(0);
  await expect(settings.locator('#journal-copy')).toBeDisabled();
  await expect(settings.locator('#journal-clear')).toBeDisabled();
  await emitSession(page, sessionId, {
    type: 'agent_activity', task_id: task.task_id, item_id: 'journal-64',
    kind: 'command', title: 'Late cleared update', status: 'completed',
  });
  await expect(settings.locator('#agent-log .activity-item')).toHaveCount(0);
  await emitSession(page, sessionId, {
    type: 'agent_activity', task_id: task.task_id, item_id: 'journal-new',
    kind: 'command', title: 'New step in the running task', status: 'running',
  });
  await expect(settings.locator('#agent-log .activity-item')).toHaveCount(1);
  await expect(settings.locator('#agent-log')).toContainText('New step in the running task');
  expect(await page.evaluate(() => ({
    status: window.__nativeContract.lastTask().status,
    interrupts: window.__nativeContract.messages.filter(message => message.type === 'agent_interrupt').length,
    disconnects: window.__nativeContract.calls.filter(call => call.name === 'assistant_disconnect').length,
    copies: window.__nativeContract.clipboardWrites.length,
  }))).toEqual({ status: 'running', interrupts: 0, disconnects: 0, copies: 1 });
});
