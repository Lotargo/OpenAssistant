import { test, expect } from '@playwright/test';
import { openNative, openSettingsTab, connectAgent, sendTask, emitSession, setPressed, startBroadcast, setScenario, notificationPage } from './helpers/native.js';

test('text connection stays silent and microphone mute does not stop a meeting broadcast', async ({ page }) => {
  await openNative(page);
  await expect(page.locator('[data-action="microphone"]')).toBeDisabled();
  await connectAgent(page, { realtime: true });
  expect(await page.evaluate(() => ({
    voices: window.__nativeContract.voiceOpens.length, captures: window.__nativeContract.captureIds.length,
  }))).toEqual({ voices: 0, captures: 0 });
  await setScenario(page, 'interview');
  expect(await page.evaluate(() => window.__nativeContract.broadcastStarts)).toEqual([]);
  const broadcast = await startBroadcast(page);
  expect(await page.evaluate(() => window.__nativeContract.voiceOpens.at(-1))).toMatchObject({
    sessionId: broadcast.sessionId, broadcastId: broadcast.id, sources: ['microphone', 'system'],
  });
  const sources = await page.evaluate(() => ({
    microphone: window.__nativeContract.lastCapture().id,
    system: window.__nativeContract.lastCapture('system').id,
  }));
  await page.locator('[data-action="microphone"]').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture().active)).toBe(false);
  expect(await page.evaluate(() => window.__nativeContract.lastCapture('system'))).toMatchObject({ id: sources.system, active: true });
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'live');
  expect(await page.evaluate(() => ({ stops: window.__nativeContract.broadcastStops, closes: window.__nativeContract.voiceCloses })))
    .toEqual({ stops: [], closes: [] });
  await page.evaluate(id => window.__nativeContract.emitAudio(id, {
    type: 'levels', rms: .1, raw_rms: .1, peak: .5, input_peak: .5, clipped_ratio: 0, waveform: [0, -.5, .25, 0],
  }), sources.system);
  await expect(page.locator('#toolbar')).toHaveAttribute('data-audio-source', 'system');
  await expect(page.locator('.toolbar-audio[data-active="true"]')).toHaveCount(2);
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-active', 'false');
  await page.locator('[data-action="microphone"]').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture().active)).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.lastCapture().id)).not.toBe(sources.microphone);
  expect(await page.evaluate(() => window.__nativeContract.voiceOpens.length)).toBe(1);
  await page.locator('#broadcast-btn').click();
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  await expect(page.locator('[data-action="microphone"]')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastBroadcast())).toMatchObject({ stage: 'ended', voiceOpen: false, sessionActive: false });
  expect(await page.evaluate(() => ({
    microphone: window.__nativeContract.lastCapture().active,
    system: window.__nativeContract.lastCapture('system').active,
  }))).toEqual({ microphone: false, system: false });
});

test('ordinary task completion keeps broadcast live and explicit Stop lets a running text task finish', async ({ page }) => {
  await openNative(page);
  await startBroadcast(page);
  const first = await sendTask(page, 'First independent text task');
  await page.evaluate(id => window.__nativeContract.finishTask(id, 'First result.'), first.task_id);
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'live');
  expect(await page.evaluate(() => window.__nativeContract.voiceCloses)).toEqual([]);
  await expect(page.locator('#text-content')).toHaveText('First result.');
  await page.locator('#broadcast-btn').click();
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  // Manual farewell belongs to the notification; it must not replace the answer.
  await expect(page.locator('#text-content')).toHaveText('First result.');
  const broadcast = await startBroadcast(page);
  const running = await sendTask(page, 'A text task that outlives broadcast Stop');
  await page.locator('#broadcast-btn').click();
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  expect(await page.evaluate(() => ({
    task: window.__nativeContract.lastTask().status,
    broadcast: window.__nativeContract.lastBroadcast(),
    interrupts: window.__nativeContract.messages.filter(message => message.type === 'agent_interrupt').length,
  }))).toMatchObject({ task: 'running', broadcast: { sessionId: broadcast.sessionId, stage: 'ended', voiceOpen: false, sessionActive: true }, interrupts: 0 });
  await page.evaluate(id => window.__nativeContract.finishTask(id, 'Text task completed after Stop.'), running.task_id);
  await expect(page.locator('#text-content')).toContainText('Text task completed after Stop.');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastBroadcast().sessionActive)).toBe(false);
});

test('native stream start rejected after Stop cannot reopen a capture or leak an unhandled rejection', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openNative(page);
  await page.evaluate(() => window.__nativeContract.delayBefore('audio_start'));
  await page.locator('#broadcast-btn').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pendingExecution.some(item => item.name === 'audio_start'))).toBe(true);
  await page.locator('#broadcast-btn').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastBroadcast()?.stage)).toBe('ended');
  await page.evaluate(() => window.__nativeContract.releaseBefore('audio_start'));
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  await expect(page.locator('[data-action="microphone"]')).toBeDisabled();
  expect(await page.evaluate(() => ({ starts: window.__nativeContract.audioStarts, closes: window.__nativeContract.voiceCloses.length })))
    .toEqual({ starts: [], closes: 1 });
  expect(errors).toEqual([]);
});

test('mode switch stops the old broadcast and stale end events cannot close a fresh broadcast', async ({ page }) => {
  await openNative(page);
  const old = await startBroadcast(page);
  await setScenario(page, 'interview');
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  expect(await page.evaluate(() => ({ starts: window.__nativeContract.broadcastStarts.length, active: window.__nativeContract.lastCapture().active })))
    .toEqual({ starts: 1, active: false });
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.scenario)).toBe('interview');
  const current = await startBroadcast(page);
  expect(current.sessionId).not.toBe(old.sessionId);
  expect(current.id).not.toBe(old.id);
  await emitSession(page, old.sessionId, { type: 'broadcast_state', stage: 'ended', broadcast_id: old.id, reason: 'silence' });
  await emitSession(page, old.sessionId, { type: 'session_closed', message: 'Obsolete session finished' });
  await emitSession(page, current.sessionId, { type: 'broadcast_state', stage: 'ended', broadcast_id: old.id, reason: 'agent' });
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'live');
  expect(await page.evaluate(() => ({
    broadcast: window.__nativeContract.lastBroadcast(),
    microphone: window.__nativeContract.lastCapture().active,
    system: window.__nativeContract.lastCapture('system').active,
    closes: window.__nativeContract.voiceCloses.length,
  }))).toMatchObject({ broadcast: { id: current.id, stage: 'live', voiceOpen: true }, microphone: true, system: true, closes: 1 });
});

for (const reason of ['silence', 'agent']) {
  test(reason + ' end closes every source and displays the current broadcast farewell', async ({ page }) => {
    await openNative(page);
    const broadcast = await startBroadcast(page, { scenario: 'interview' });
    const farewell = reason === 'silence' ? 'Эфир завершён после паузы.' : 'Обсуждение завершено. До встречи!';
    if (reason === 'agent') await setPressed(page.locator('#notifications-btn'), false);
    await page.evaluate(({ id, reason, farewell }) => window.__nativeContract.finishBroadcast(id, reason, farewell), { id: broadcast.sessionId, reason, farewell });
    await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
    const notification = await notificationPage(page);
    if (reason === 'agent') {
      await expect(notification.locator('#notification-card')).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.__nativeContract.getNotification().visible)).toBe(false);
    } else {
      await expect(notification.locator('#notification-card')).toHaveAttribute('data-phase', 'visible');
      await expect(notification.locator('#notification-message')).toContainText(farewell);
    }
    await expect(page.locator('#action-toast')).toHaveCount(0);
    await expect(page.locator('#text-content')).toContainText(farewell);
    await expect(page.locator('[data-action="microphone"]')).toBeDisabled();
    expect(await page.evaluate(() => ({
      microphone: window.__nativeContract.lastCapture().active,
      system: window.__nativeContract.lastCapture('system').active,
      closes: window.__nativeContract.voiceCloses,
    }))).toEqual({ microphone: false, system: false, closes: [{ sessionId: broadcast.sessionId, broadcastId: broadcast.id, reason }] });
  });
}

test('notification dismissal keeps capture running and shares the panel appearance and capture mode', async ({ page }) => {
  await openNative(page);
  await startBroadcast(page);
  const notification = await notificationPage(page);
  const settings = await openSettingsTab(page, 'appearance');
  await page.locator('#window-mode-btn').click();
  await expect(page.locator('#overlay')).toHaveAttribute('data-window-mode', 'standard');
  await expect(notification.locator('#notification-card')).toHaveAttribute('data-phase', 'visible');
  const noticeId = await notification.locator('#notification-card').getAttribute('data-id');
  await settings.locator('#setting-opacity').evaluate(node => {
    node.value = '24'; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => window.__nativeContract.saves.at(-1)?.opacity)).toBe(24);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.notificationThemes.at(-1)?.opacity)).toBe(24);
  await expect(notification.locator('#notification-card')).toHaveAttribute('data-id', noticeId);
  const panelBackground = await page.locator('#overlay').evaluate(node => getComputedStyle(node).backgroundColor);
  expect(await notification.locator('#notification-card').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(panelBackground);
  await expect(page.locator('#action-toast')).toHaveCount(0);
  expect(await notification.locator('body').evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
  const before = await page.evaluate(() => ({ capture: window.__nativeContract.lastCapture(), closes: window.__nativeContract.voiceCloses.length }));
  await setPressed(page.locator('#notifications-btn'), false);
  await expect(notification.locator('#notification-card')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.getNotification().visible)).toBe(false);
  const shownBefore = await page.evaluate(() => window.__nativeContract.notificationShows.length);
  await page.locator('[data-action="scroll-lock"]').click();
  await expect(notification.locator('#notification-card')).toBeHidden();
  expect(await page.evaluate(() => window.__nativeContract.notificationShows.length)).toBe(shownBefore);
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'live');
  expect(await page.evaluate(() => ({ capture: window.__nativeContract.lastCapture(), closes: window.__nativeContract.voiceCloses.length }))).toEqual(before);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.saves.at(-1)?.actionNotifications)).toBe(false);
  await page.locator('#broadcast-btn').click();
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#notifications-btn')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-action="scroll-lock"]').click();
  expect(await page.evaluate(() => window.__nativeContract.notificationShows)).toEqual([]);
});

test('silence and semantic-end preferences persist without starting a broadcast', async ({ page }) => {
  await openNative(page);
  let settings = await openSettingsTab(page, 'behavior');
  await expect(settings.locator('#agent-silence-timeout')).toHaveValue('300');
  await expect(settings.locator('#agent-auto-end')).toHaveAttribute('aria-pressed', 'true');
  await settings.locator('#agent-silence-timeout').selectOption('0');
  await setPressed(settings.locator('#agent-auto-end'), false);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1))).toMatchObject({ silence_timeout_secs: 0, agent_auto_end: false });
  expect(await page.evaluate(() => window.__nativeContract.sessionIds)).toEqual([]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  settings = await openSettingsTab(page, 'behavior');
  await expect(settings.locator('#agent-silence-timeout')).toHaveValue('0');
  await expect(settings.locator('#agent-auto-end')).toHaveAttribute('aria-pressed', 'false');
  await connectAgent(page, { realtime: true });
  expect(await page.evaluate(() => window.__nativeContract.calls.find(call => call.name === 'assistant_connect').args.config))
    .toMatchObject({ silence_timeout_secs: 0, agent_auto_end: false });
  expect(await page.evaluate(() => window.__nativeContract.voiceOpens)).toEqual([]);
});

test('failed broadcast Stop preserves running text work and retires the session only after it finishes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openNative(page);
  const broadcast = await startBroadcast(page);
  const task = await sendTask(page, 'Keep this text task through a failed voice shutdown');
  await page.evaluate(() => window.__nativeContract.failNext('assistant_send:broadcast_stop', 'Fixture broadcast Stop failed'));
  await page.locator('#broadcast-btn').click();
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture().active)).toBe(false);
  expect(await page.evaluate(() => ({
    task: window.__nativeContract.lastTask().status,
    disconnects: window.__nativeContract.calls.filter(call => call.name === 'assistant_disconnect').length,
    interrupts: window.__nativeContract.messages.filter(message => message.type === 'agent_interrupt').length,
  }))).toEqual({ task: 'running', disconnects: 0, interrupts: 0 });
  await page.evaluate(id => window.__nativeContract.finishTask(id, 'Result preserved after failed Stop.'), task.task_id);
  await expect(page.locator('#text-content')).toHaveText('Result preserved after failed Stop.');
  await expect.poll(() => page.evaluate(id => window.__nativeContract.calls.filter(call =>
    call.name === 'assistant_disconnect' && call.args.sessionId === id).length, broadcast.sessionId)).toBe(1);
  expect(await page.evaluate(() => window.__nativeContract.lastBroadcast())).toMatchObject({ sessionActive: false, voiceOpen: false });
  expect(errors).toEqual([]);
});

test('mode change awaiting Stop preserves a concurrent configuration edit and never auto-starts', async ({ page }) => {
  await openNative(page);
  await startBroadcast(page);
  const settings = await openSettingsTab(page, 'agent');
  await expect(settings.locator('#agent-web-search')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.__nativeContract.delayNext('assistant_send:broadcast_stop'));
  await page.locator('#mode-btn').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.some(item => item.name === 'assistant_send:broadcast_stop'))).toBe(true);
  await expect(page.locator('#mode-btn')).toBeDisabled();
  await setPressed(settings.locator('#agent-web-search'), false);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.web_search)).toBe(false);
  await page.evaluate(() => window.__nativeContract.release('assistant_send:broadcast_stop'));
  await expect(page.locator('#mode-btn')).toHaveAttribute('data-current-scenario', 'interview');
  await expect(settings.locator('#agent-web-search')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1))).toMatchObject({ scenario: 'interview', web_search: false });
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  expect(await page.evaluate(() => ({ starts: window.__nativeContract.broadcastStarts.length, capture: window.__nativeContract.lastCapture().active })))
    .toEqual({ starts: 1, capture: false });
});

test('session close without a terminal task event releases busy guards and preserves partial output', async ({ page }) => {
  await openNative(page);
  const old = await startBroadcast(page);
  const task = await sendTask(page, 'A task whose final native event will be lost');
  const partial = 'Частичный ответ уже получен.';
  await emitSession(page, old.sessionId, { type: 'agent_delta', task_id: task.task_id, text: partial });
  await expect(page.locator('#text-content')).toHaveText(partial);
  await page.locator('#broadcast-btn').click();
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  expect(await page.evaluate(() => window.__nativeContract.lastTask().status)).toBe('running');
  await emitSession(page, old.sessionId, { type: 'session_closed', message: 'Native session ended before the task terminal event.' });
  await expect(page.locator('#text-content')).toHaveText(partial);
  const settings = await openSettingsTab(page, 'agent');
  await expect(settings.locator('#agent-tasks .task-status')).toHaveText('Ошибка');
  await expect(settings.locator('[data-interrupt-task]')).toHaveCount(0);
  await expect(settings.locator('#agent-connect')).toBeEnabled();
  await expect(settings.locator('#agent-connect')).toHaveText('Подключить');
  expect(await page.evaluate(id => window.__nativeContract.events.filter(event =>
    event.sessionId === id && event.type === 'agent_done').length, old.sessionId)).toBe(0);
  const current = await startBroadcast(page);
  expect(current.sessionId).not.toBe(old.sessionId);
  expect(current.id).not.toBe(old.id);
  expect(await page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(2);
});
