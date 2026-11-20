import { test, expect } from '@playwright/test';
import { openNative, openSettingsTab, startBroadcast, connectAgent, sendTask, emitSession } from './helpers/native.js';

async function expectPreparing(page) {
  await expect(page.locator('#mode-btn')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-action="reconnect"]')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'starting');
  await expect(page.locator('#broadcast-btn')).toBeEnabled();
}

async function expectSettled(page) {
  await expect(page.locator('#mode-btn')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-action="reconnect"]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#mode-btn')).toBeEnabled();
}

test('mode resume waits for native session close, preserves a busy task and restores muted devices', async ({ page }) => {
  await openNative(page, { storeValues: { audio: {
    deviceId: 'fixture-usb', systemDeviceId: 'fixture-headphones', noiseSuppression: true,
  } } });
  const old = await startBroadcast(page);
  await page.locator('[data-action="microphone"]').click();
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-pressed', 'true');
  const settings = await openSettingsTab(page, 'modes');
  // Replay an already queued Start click through the existing settings proxy.
  // Normally disabled while live, this control must not reset the muted intent.
  await settings.locator('#voice-start').evaluate(button => {
    button.disabled = false;
    button.click();
  });
  await expect(settings.locator('#voice-start')).toBeDisabled();
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(1);
  const task = await sendTask(page, 'Finish this task before changing the voice session.');
  await page.evaluate(id => window.__nativeContract.holdSessionClose(id), old.sessionId);
  await page.locator('#mode-btn').click();
  await expectPreparing(page);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastBroadcast().stage)).toBe('ended');
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length,
    task: window.__nativeContract.lastTask().status,
    interrupts: window.__nativeContract.messages.filter(message => message.type === 'agent_interrupt').length,
    disconnects: window.__nativeContract.calls.filter(call => call.name === 'assistant_disconnect').length,
  }))).toEqual({ sessions: 1, task: 'running', interrupts: 0, disconnects: 0 });

  await page.evaluate(id => window.__nativeContract.finishTask(id, 'The task finished before its session closed.'), task.task_id);
  await expect(page.locator('#text-content')).toHaveText('The task finished before its session closed.');
  await expectPreparing(page);
  expect(await page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(1);
  await page.evaluate(id => window.__nativeContract.releaseSessionClose(id), old.sessionId);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(2);
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'live');
  await expectSettled(page);
  const current = await page.evaluate(() => window.__nativeContract.lastBroadcast());
  expect(current.sessionId).not.toBe(old.sessionId);
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__nativeContract.audioStarts)).toHaveLength(1);
  expect(await page.evaluate(() => window.__nativeContract.lastCapture().active)).toBe(false);
  expect(await page.evaluate(() => window.__nativeContract.systemAudioStarts)).toEqual([{
    captureId: expect.any(Number), mode: 'stream', deviceId: 'fixture-headphones', noiseSuppression: false,
    sessionId: current.sessionId, broadcastId: current.id,
  }]);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture('system')?.active)).toBe(true);
  await page.locator('[data-action="microphone"]').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioStarts.length)).toBe(2);
  expect(await page.evaluate(() => window.__nativeContract.audioStarts.at(-1))).toMatchObject({
    deviceId: 'fixture-usb', noiseSuppression: true, sessionId: current.sessionId, broadcastId: current.id,
  });
  expect(await page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(2);
});

test('starting mode changes coalesce to the latest custom source policy and ignore stale readiness', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openNative(page, { autoVoiceReady: false });
  const settings = await openSettingsTab(page, 'modes');
  await page.locator('#broadcast-btn').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(1);
  const old = await page.evaluate(() => window.__nativeContract.lastBroadcast());
  await page.evaluate(() => window.__nativeContract.delayNext('assistant_send:broadcast_stop'));
  await settings.locator('#agent-scenario').selectOption('interview');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.some(item => item.name === 'assistant_send:broadcast_stop'))).toBe(true);
  await settings.locator('#agent-scenario').selectOption('custom');
  await settings.locator('#agent-custom-behavior').selectOption('selective');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1))).toMatchObject({
    scenario: 'custom', custom_behavior: 'selective',
  });
  await expectPreparing(page);
  await page.evaluate(() => window.__nativeContract.release('assistant_send:broadcast_stop'));
  await expect.poll(() => page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(2);
  const current = await page.evaluate(() => window.__nativeContract.lastBroadcast());
  expect(current.sessionId).not.toBe(old.sessionId);
  expect(await page.evaluate(() => window.__nativeContract.calls.filter(call => call.name === 'assistant_connect').at(-1).args.config))
    .toMatchObject({ scenario: 'custom', custom_behavior: 'selective' });
  await emitSession(page, old.sessionId, { type: 'status', stage: 'ready', realtime: true, broadcast_id: old.id });
  await emitSession(page, old.sessionId, { type: 'broadcast_state', stage: 'live', broadcast_id: old.id });
  expect(await page.evaluate(() => window.__nativeContract.captureIds)).toEqual([]);
  await page.evaluate(id => window.__nativeContract.readyBroadcast(id), current.sessionId);
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'live');
  await expectSettled(page);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture('system')?.active)).toBe(true);
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length,
    starts: window.__nativeContract.broadcastStarts.length,
    microphone: window.__nativeContract.audioStarts.length,
    system: window.__nativeContract.systemAudioStarts.length,
  }))).toEqual({ sessions: 2, starts: 2, microphone: 1, system: 1 });
  expect(errors).toEqual([]);
});

for (const action of ['stop', 'disconnect']) {
  test(action + ' during mode reconnect cancels automatic resume despite a late connect reply', async ({ page }) => {
    await openNative(page);
    await startBroadcast(page);
    const settings = await openSettingsTab(page, 'agent');
    await page.evaluate(() => window.__nativeContract.delayNext('assistant_connect'));
    await page.locator('#mode-btn').click();
    await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.some(item => item.name === 'assistant_connect'))).toBe(true);
    const pendingSession = await page.evaluate(() => window.__nativeContract.sessionIds.at(-1));
    await expectPreparing(page);
    if (action === 'stop') await page.locator('#broadcast-btn').click();
    else await settings.locator('#agent-disconnect').click();
    await page.evaluate(() => window.__nativeContract.release('assistant_connect'));
    await page.evaluate(id => window.__nativeContract.readySession(id), pendingSession);
    await emitSession(page, pendingSession, { type: 'status', stage: 'ready', realtime: true });
    await expectSettled(page);
    await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
    await expect(page.locator('[data-action="microphone"]')).toBeDisabled();
    await expect.poll(() => page.evaluate(id => window.__nativeContract.calls.some(call =>
      call.name === 'assistant_disconnect' && call.args.sessionId === id), pendingSession)).toBe(true);
    expect(await page.evaluate(() => ({
      starts: window.__nativeContract.broadcastStarts.length,
      microphones: window.__nativeContract.audioStarts.length,
      microphoneActive: window.__nativeContract.lastCapture().active,
      system: window.__nativeContract.systemAudioStarts.length,
    }))).toEqual({ starts: 1, microphones: 1, microphoneActive: false, system: 0 });
  });
}

test('a failed automatic reconnect leaves the chosen mode off with settled controls and can be retried', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openNative(page);
  await startBroadcast(page);
  await page.evaluate(() => window.__nativeContract.failNext('assistant_connect', 'Fixture new mode connection failed'));
  await page.locator('#mode-btn').click();
  await expect(page.locator('#mode-btn')).toHaveAttribute('data-current-scenario', 'interview');
  await expectSettled(page);
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  await expect(page.locator('[data-action="microphone"]')).toBeDisabled();
  await expect(page.locator('#announcer')).toContainText('Fixture new mode connection failed');
  expect(await page.evaluate(() => ({
    starts: window.__nativeContract.broadcastStarts.length,
    microphoneActive: window.__nativeContract.lastCapture().active,
    system: window.__nativeContract.systemAudioStarts.length,
  }))).toEqual({ starts: 1, microphoneActive: false, system: 0 });
  const retry = await startBroadcast(page);
  expect(await page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(2);
  await expectSettled(page);
  expect(await page.evaluate(() => window.__nativeContract.systemAudioStarts.at(-1))).toMatchObject({
    sessionId: retry.sessionId, broadcastId: retry.id,
  });
  expect(errors).toEqual([]);
});


test('unexpected close of a session with a running task cancels mode resume instead of hiding the failure', async ({ page }) => {
  await openNative(page);
  const old = await startBroadcast(page);
  const task = await sendTask(page, 'A task that must survive the planned mode switch.');
  await emitSession(page, old.sessionId, { type: 'agent_delta', task_id: task.task_id, text: 'Уже полученный ответ.' });
  await page.locator('#mode-btn').click();
  await expectPreparing(page);
  await emitSession(page, old.sessionId, { type: 'session_closed', message: 'Fixture session closed before its task finished.' });
  await expectSettled(page);
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'ended');
  await expect(page.locator('#text-content')).toHaveText('Уже полученный ответ.');
  const settings = await openSettingsTab(page, 'agent');
  await expect(settings.locator('#agent-tasks .task-status')).toHaveText('Ошибка');
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length,
    starts: window.__nativeContract.broadcastStarts.length,
    active: window.__nativeContract.lastCapture().active,
  }))).toEqual({ sessions: 1, starts: 1, active: false });
});


test('mode change during a cold Start drains a text-only session before resuming once', async ({ page }) => {
  await openNative(page);
  const oldSession = await connectAgent(page, { realtime: true });
  const task = await sendTask(page, 'This text-only task has not opened a broadcast.');
  const settings = await openSettingsTab(page, 'audio');
  await settings.locator('#mic-test').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture())).toMatchObject({ mode: 'test', active: true });
  await page.evaluate(() => window.__nativeContract.delayBefore('audio_stop'));
  await page.locator('#broadcast-btn').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pendingExecution.some(item => item.name === 'audio_stop'))).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.broadcastStarts)).toEqual([]);
  await page.locator('#mode-btn').click();
  await expectPreparing(page);
  expect(await page.evaluate(() => ({
    task: window.__nativeContract.lastTask().status,
    disconnects: window.__nativeContract.calls.filter(call => call.name === 'assistant_disconnect').length,
    interrupts: window.__nativeContract.messages.filter(message => message.type === 'agent_interrupt').length,
  }))).toEqual({ task: 'running', disconnects: 0, interrupts: 0 });
  await page.evaluate(() => window.__nativeContract.releaseBefore('audio_stop'));
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture().active)).toBe(false);
  await page.evaluate(id => window.__nativeContract.finishTask(id, 'Cold-start task completed safely.'), task.task_id);
  await expect(page.locator('#text-content')).toHaveText('Cold-start task completed safely.');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.broadcastStarts.length)).toBe(1);
  await expect(page.locator('#broadcast-btn')).toHaveAttribute('data-stage', 'live');
  await expectSettled(page);
  const current = await page.evaluate(() => window.__nativeContract.lastBroadcast());
  expect(current.sessionId).not.toBe(oldSession);
  expect(await page.evaluate(id => window.__nativeContract.calls.filter(call =>
    call.name === 'assistant_disconnect' && call.args.sessionId === id).length, oldSession)).toBe(1);
  expect(await page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture('system')?.active)).toBe(true);
});
