import { test, expect } from '@playwright/test';
import { openNative, openAgent, settingsPage, setPressed } from './helpers/native.js';

test('live catalog, effort and workspace choices persist without starting capture or a session', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openNative(page);
  const bounds = await page.locator('#overlay').boundingBox();
  const settings = await openAgent(page);
  await expect(settings.locator('#agent-model option')).toHaveCount(3);
  await expect(settings.locator('#agent-catalog-status')).toContainText('получены из Codex');
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length, captures: window.__nativeContract.captureIds.length,
  }))).toEqual({ sessions: 0, captures: 0 });
  await settings.locator('#agent-model').selectOption('fixture-codex-small');
  await expect.poll(() => settings.locator('#agent-effort option').evaluateAll(nodes => nodes.map(node => node.value))).toEqual(['', 'low', 'medium']);
  await settings.locator('#agent-effort').selectOption('medium');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.model)).toBe('fixture-codex-small');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.effort)).toBe('medium');
  await settings.locator('#agent-model-refresh').click();
  await expect(settings.locator('#agent-effort')).toHaveValue('medium');

  await settings.locator('#tab-workspace').click();
  await settings.locator('#agent-workspace-mode').selectOption('project');
  await page.evaluate(() => window.__nativeContract.queueWorkspaceChoice('F:\\chosen-fixture'));
  await settings.locator('#agent-workspace-choose').click();
  await expect(settings.locator('#agent-workspace')).toHaveValue('F:\\chosen-fixture');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.workspace)).toBe('F:\\chosen-fixture');
  await page.evaluate(() => window.__nativeContract.queueWorkspaceChoice(null));
  await settings.locator('#agent-workspace-choose').click();
  await expect(settings.locator('#agent-workspace-choose')).toBeEnabled();
  await expect(settings.locator('#agent-workspace')).toHaveValue('F:\\chosen-fixture');
  await settings.locator('#agent-workspace-mode').selectOption('temporary');
  await expect(settings.locator('#agent-project-field')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.workspace_mode)).toBe('temporary');
  expect(await page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.workspace)).toBe('F:\\chosen-fixture');

  await settings.reload();
  await expect(settings.locator('html')).toHaveAttribute('data-ready', 'true');
  await settings.locator('#tab-agent').click();
  await expect(settings.locator('#agent-model')).toHaveValue('fixture-codex-small');
  await expect(settings.locator('#agent-effort')).toHaveValue('medium');
  await settings.locator('#tab-workspace').click();
  await expect(settings.locator('#agent-workspace-mode')).toHaveValue('temporary');
  expect(await page.locator('#overlay').boundingBox()).toEqual(bounds);
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length, captures: window.__nativeContract.captureIds.length,
  }))).toEqual({ sessions: 0, captures: 0 });

  await settings.locator('#tab-agent').click();
  await setPressed(settings.locator('#agent-realtime'), false);
  await settings.locator('#agent-connect').click();
  await expect(settings.locator('#agent-connect')).toHaveText('Переподключить');
  await settings.locator('#tab-workspace').click();
  await expect(settings.locator('#agent-workspace-path')).toContainText('fixture-temporary');
  await settings.locator('#tab-agent').click();
  await settings.locator('#agent-disconnect').click();
  await settings.locator('#tab-workspace').click();
  await expect(settings.locator('#agent-workspace-status')).toHaveAttribute('data-status', 'cleaned');
  await settings.locator('#agent-workspace-clear').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.calls.filter(call => call.name === 'assistant_cleanup_workspaces').length)).toBe(1);
  expect(await page.evaluate(() => window.__nativeContract.captureIds)).toEqual([]);
  expect(errors).toEqual([]);
});

test('interview explicitly starts and stops separate microphone and meeting audio streams', async ({ page }) => {
  await openNative(page);
  const settings = await openAgent(page);
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-label', 'Включить микрофон');
  await settings.locator('#tab-modes').click();
  await settings.locator('#agent-scenario').selectOption('interview');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-label', 'Начать прослушивание собеседования');
  await expect(settings.locator('#interview-panel')).toBeVisible();
  await expect(settings.locator('#interview-state')).toHaveText('Не слушаю');
  await settings.locator('#tab-audio').click();
  await settings.locator('#mic-device').selectOption('fixture-usb');
  await settings.locator('#system-audio-device').selectOption('fixture-headphones');
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length, captures: window.__nativeContract.captureIds.length,
  }))).toEqual({ sessions: 0, captures: 0 });

  await settings.locator('#tab-modes').click();
  await settings.locator('#interview-start').click();
  await expect(settings.locator('#interview-state')).toHaveText('Слушаю');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-label', 'Остановить прослушивание собеседования');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioStarts.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.systemAudioStarts.length)).toBe(1);
  expect(await page.evaluate(() => window.__nativeContract.audioStarts[0].deviceId)).toBe('fixture-usb');
  expect(await page.evaluate(() => window.__nativeContract.systemAudioStarts[0].deviceId)).toBe('fixture-headphones');
  const captures = await page.evaluate(() => ({
    microphone: window.__nativeContract.lastCapture('microphone').id,
    system: window.__nativeContract.lastCapture('system').id,
  }));
  expect(captures.microphone).not.toBe(captures.system);
  await settings.locator('#tab-audio').click();
  await page.evaluate(captures => {
    const h = window.__nativeContract;
    const emit = () => {
      h.emitAudio(captures.microphone, { type: 'levels', rms: .04, raw_rms: .04, peak: .3, input_peak: .3, clipped_ratio: 0, waveform: [0, .3, -.15, 0] });
      h.emitAudio(captures.system, { type: 'levels', rms: .1, raw_rms: .1, peak: .5, input_peak: .5, clipped_ratio: 0, waveform: [0, -.5, .25, 0] });
    };
    emit();
    window.__fixtureMeetingFrames = setInterval(emit, 40);
    h.emitAudio(captures.microphone, { type: 'pcm', data: [0, 0, 0, 0] });
    h.emitAudio(captures.system, { type: 'pcm', data: [0, 0, 0, 0] });
  }, captures);
  try {
    await expect(settings.locator('#mic-monitor')).toHaveAttribute('data-active', 'true');
    await expect(settings.locator('#system-audio-monitor')).toHaveAttribute('data-active', 'true');
    await expect.poll(() => page.evaluate(() => [...new Set(window.__nativeContract.audio.map(packet => packet.source))].sort())).toEqual(['microphone', 'system']);
    expect(await settings.locator('#mic-wave-path').getAttribute('d')).not.toBe(await settings.locator('#system-audio-wave-path').getAttribute('d'));
  } finally {
    await page.evaluate(() => clearInterval(window.__fixtureMeetingFrames));
  }
  await settings.locator('#tab-modes').click();
  await settings.locator('#interview-stop').click();
  await expect(settings.locator('#interview-state')).toHaveText('Не слушаю');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-label', 'Начать прослушивание собеседования');
  await expect.poll(() => page.evaluate(() => ({
    microphone: window.__nativeContract.lastCapture('microphone').active,
    system: window.__nativeContract.lastCapture('system').active,
  }))).toEqual({ microphone: false, system: false });
  await settings.locator('#tab-audio').click();
  await expect(settings.locator('#mic-monitor')).toHaveAttribute('data-active', 'false');
  await expect(settings.locator('#system-audio-monitor')).toHaveAttribute('data-active', 'false');
  await settings.keyboard.press('Escape');
  await page.locator('[data-action="settings"]').click();
  await settingsPage(page);
  expect(await page.evaluate(() => window.__nativeContract.captureIds.length)).toBe(2);
});

test('stopping an interview while native connect is pending never starts either capture', async ({ page }) => {
  await openNative(page, { autoReady: false });
  const settings = await openAgent(page);
  await settings.locator('#tab-modes').click();
  await settings.locator('#agent-scenario').selectOption('interview');
  await page.evaluate(() => window.__nativeContract.delayNext('assistant_connect'));
  await settings.locator('#interview-start').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.some(item => item.name === 'assistant_connect'))).toBe(true);
  const sessionId = await page.evaluate(() => window.__nativeContract.sessionIds.at(-1));
  await expect(settings.locator('#interview-stop')).toBeEnabled();
  await settings.locator('#interview-stop').click();
  await expect(settings.locator('#interview-state')).toHaveText('Не слушаю');
  await page.evaluate(id => {
    window.__nativeContract.release('assistant_connect');
    window.__nativeContract.readySession(id);
  }, sessionId);
  await expect(settings.locator('#agent-connect')).toHaveText('Переподключить');
  await expect(settings.locator('#interview-start')).toBeEnabled();
  expect(await page.evaluate(() => ({
    microphone: window.__nativeContract.audioStarts, system: window.__nativeContract.systemAudioStarts,
  }))).toEqual({ microphone: [], system: [] });
  await expect(settings.locator('#interview-state')).toHaveText('Не слушаю');
});