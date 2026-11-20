import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openNative } from './helpers/native.js';

async function openSources(page) {
  if (!await page.locator('#settings-dialog').isVisible()) await page.locator('[data-action="settings"]').click();
  await page.locator('#tab-sources').click();
  await expect(page.locator('#section-sources')).toBeVisible();
}

async function captureScreenshot(page, testInfo, name) {
  const directory = process.env.OPENASSISTANT_SCREENSHOT_DIR || testInfo.outputPath('screenshots');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name + '.png'), animations: 'disabled' });
}

async function assertStableTabs(page, testInfo, screenshots = false) {
  let first;
  for (const tab of ['appearance', 'behavior', 'sources', 'agent', 'appearance']) {
    await page.locator('#tab-' + tab).click();
    await expect(page.locator('#section-' + tab)).toBeVisible();
    const rect = await page.locator('#settings-dialog').boundingBox();
    if (!first) first = rect;
    for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(rect[key] - first[key]), tab + ' ' + key).toBeLessThan(.5);
    expect(await page.locator('.settings-main').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    if (screenshots) await captureScreenshot(page, testInfo, 'settings-' + tab);
  }
  return first;
}

test('settings keep one native rectangle across tabs and the settings icon is centered', async ({ page }, testInfo) => {
  await openNative(page);
  const centers = await page.locator('[data-action="settings"]').evaluate(button => {
    const svg = button.querySelector('svg');
    const b = button.getBoundingClientRect();
    const s = svg.getBoundingClientRect();
    const shape = svg.getBBox();
    return {
      dx: s.x + s.width / 2 - b.x - b.width / 2,
      dy: s.y + s.height / 2 - b.y - b.height / 2,
      shapeX: shape.x + shape.width / 2,
      shapeY: shape.y + shape.height / 2,
    };
  });
  expect(Math.abs(centers.dx)).toBeLessThan(.5);
  expect(Math.abs(centers.dy)).toBeLessThan(.5);
  expect(centers.shapeX).toBeCloseTo(12);
  expect(centers.shapeY).toBeCloseTo(12);

  await page.locator('[data-action="settings"]').click();
  await expect.poll(() => page.viewportSize()).toEqual({ width: 980, height: 780 });
  await expect(page.locator('#tab-appearance')).toBeFocused();
  const bounds = await assertStableTabs(page, testInfo, true);
  expect(bounds).toEqual({ x: 60, y: 45, width: 860, height: 690 });
  await page.locator('#tab-agent').click();
  expect(await page.locator('.settings-main').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
});

test('settings preserve their bounds and remain usable on a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('[data-action="settings"]').click();
  const bounds = await assertStableTabs(page, testInfo);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
  await page.locator('#tab-sources').click();
  await captureScreenshot(page, testInfo, 'settings-narrow');
});

test('local microphone check renders the same real levels without refreshing agent controls or opening Codex', async ({ page }, testInfo) => {
  await openNative(page);
  await openSources(page);
  await expect(page.locator('#mic-noise-suppression')).not.toBeChecked();
  await expect(page.locator('#mic-device option')).toHaveCount(3);
  await page.locator('#mic-test').click();
  await expect(page.locator('#mic-test')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mic-test-status')).toContainText('Говорите обычным голосом');
  expect(await page.evaluate(() => window.__nativeContract.audioStarts[0])).toMatchObject({
    mode: 'test', deviceId: null, noiseSuppression: false,
  });
  await page.evaluate(() => {
    window.__agentMutations = 0;
    window.__agentObserver = new MutationObserver(records => { window.__agentMutations += records.length; });
    window.__agentObserver.observe(document.querySelector('#section-agent'), { subtree: true, childList: true, attributes: true });
    const harness = window.__nativeContract;
    const id = harness.lastCapture().id;
    for (let frame = 0; frame < 12; frame++) harness.emitAudio(id, {
      type: 'levels', rms: .1, raw_rms: .125, peak: .5, input_peak: .6, clipped_ratio: 0,
      waveform: [0, .35, -.25, .5, -.6, .1, 0],
    });
  });
  await expect(page.locator('#mic-level')).toHaveAttribute('aria-valuenow', '-18');
  await expect(page.locator('#mic-level-label')).toHaveText('Входящий звук');
  await expect(page.locator('#mic-wave-path')).not.toHaveAttribute('d', 'M0 32H480');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-active', 'true');
  expect(await page.evaluate(() => window.__agentMutations)).toBe(0);
  await captureScreenshot(page, testInfo, 'settings-microphone-active');
  await page.evaluate(() => {
    window.__agentObserver.disconnect();
    const harness = window.__nativeContract;
    harness.emitAudio(harness.lastCapture().id, {
      type: 'levels', rms: .3, raw_rms: .5, peak: .6, input_peak: 1, clipped_ratio: .02, waveform: [0, 1, -.99, 0],
    });
  });
  await expect(page.locator('#mic-level-label')).toHaveText('Слишком громко');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-clipped', 'true');

  const initialCapture = await page.evaluate(() => window.__nativeContract.lastCapture());
  await page.locator('#mic-noise-suppression').check();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioNoiseChanges.at(-1))).toEqual({ captureId: initialCapture.id, enabled: true });
  expect(await page.evaluate(() => window.__nativeContract.captureIds)).toEqual([initialCapture.id]);
  await page.locator('#mic-device').selectOption('fixture-usb');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioStarts.at(-1)?.deviceId)).toBe('fixture-usb');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioSaves.at(-1))).toEqual({ deviceId: 'fixture-usb', noiseSuppression: true });
  await page.locator('#tab-behavior').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(false);
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-active', 'false');
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length,
    sent: window.__nativeContract.audio.length,
  }))).toEqual({ sessions: 0, sent: 0 });
});

test('closing settings cancels a microphone check while native start is still pending', async ({ page }) => {
  await openNative(page);
  await openSources(page);
  await page.evaluate(() => window.__nativeContract.delayNext('audio_start'));
  await page.locator('#mic-test').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.filter(item => item.name === 'audio_start').length)).toBe(1);
  await expect(page.locator('#mic-test')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await page.evaluate(() => window.__nativeContract.release('audio_start'));
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(false);
  await openSources(page);
  await expect(page.locator('#mic-test')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#mic-test')).toBeEnabled();
  expect(await page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(0);
});

test('closing settings and losing focus keep live dictation running, but local testing stays disabled', async ({ page }) => {
  await openNative(page);
  await page.locator('[data-action="microphone"]').click();
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioStarts.at(-1)?.mode)).toBe('stream');
  await openSources(page);
  await expect(page.locator('#mic-test')).toBeDisabled();
  await expect(page.locator('#mic-test-status')).toHaveText('Уровень текущего голосового ввода.');
  const initialCapture = await page.evaluate(() => window.__nativeContract.lastCapture());
  await page.locator('#mic-device').selectOption('fixture-default');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioSaves.at(-1)?.deviceId)).toBe('fixture-default');
  await page.locator('#mic-noise-suppression').check();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioNoiseChanges.at(-1))).toEqual({ captureId: initialCapture.id, enabled: true });
  expect(await page.evaluate(() => window.__nativeContract.lastCapture())).toMatchObject({
    id: initialCapture.id, channelId: initialCapture.channelId, active: true, noiseSuppression: true,
  });
  expect(await page.evaluate(() => window.__nativeContract.captureIds)).toEqual([initialCapture.id]);
  await page.evaluate(id => window.__nativeContract.emitAudio(id, { type: 'pcm', data: [0, 0, 1, 0] }), initialCapture.id);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audio.at(-1)?.bytes)).toBe(4);
  await page.locator('#tab-behavior').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.audioStops)).toEqual([]);
  await page.locator('[data-action="microphone"]').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(false);
});

test('a missing selected microphone stays explicit and another device can be selected', async ({ page }) => {
  await openNative(page);
  await openSources(page);
  await page.locator('#mic-device').selectOption('fixture-usb');
  await page.evaluate(() => window.__nativeContract.setAudioDevices([
    { id: 'fixture-default', name: 'Fixture Microphone', is_default: true },
  ]));
  await page.locator('#mic-refresh').click();
  await expect(page.locator('#mic-device')).toHaveValue('fixture-usb');
  await expect(page.locator('#mic-error')).toBeVisible();
  await expect(page.locator('#mic-test')).toBeDisabled();
  await expect(page.locator('#mic-device')).toBeEnabled();
  await page.locator('#mic-device').selectOption('');
  await expect(page.locator('#mic-error')).toBeHidden();
  await expect(page.locator('#mic-test')).toBeEnabled();
  expect(await page.evaluate(() => window.__nativeContract.audioStarts)).toEqual([]);
});

test('meters clear frozen audio before capture times out without stopping the microphone', async ({ page }) => {
  await openNative(page);
  await openSources(page);
  await page.locator('#mic-test').click();
  await expect(page.locator('#mic-test-status')).toContainText('Говорите обычным голосом');
  await page.evaluate(() => {
    const harness = window.__nativeContract;
    harness.emitAudio(harness.lastCapture().id, {
      type: 'levels', rms: .3, raw_rms: .5, peak: .8, input_peak: 1, clipped_ratio: .02, waveform: [0, .8, -.7, 0],
    });
  });
  await expect(page.locator('#mic-monitor')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('#mic-level-label')).toHaveText('Слишком громко');
  await expect(page.locator('#mic-level-label')).toHaveText('Нет сигнала', { timeout: 2000 });
  await expect(page.locator('#mic-level')).toHaveAttribute('aria-valuenow', '-60');
  await expect(page.locator('#mic-wave-path')).toHaveAttribute('d', 'M0 32H480');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-active', 'false');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-clipped', 'false');
  // A later lifecycle refresh with the same levels must leave the display empty.
  await page.waitForTimeout(300);
  await expect(page.locator('#mic-level-label')).toHaveText('Нет сигнала');
  expect(await page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.audioStops)).toEqual([]);
  await page.keyboard.press('Escape');
});

test('noise toggle preserves pending intent through native latency and reverts on rejection', async ({ page }) => {
  await openNative(page);
  await openSources(page);
  await page.locator('#mic-test').click();
  await expect(page.locator('#mic-test-status')).toContainText('Говорите обычным голосом');
  const noise = page.locator('#mic-noise-suppression');
  const initialCapture = await page.evaluate(() => window.__nativeContract.lastCapture());
  await page.evaluate(() => window.__nativeContract.delayNext('audio_set_noise_suppression'));
  await noise.check();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.filter(item => item.name === 'audio_set_noise_suppression').length)).toBe(1);
  await expect(noise).toBeChecked();
  await expect(noise).toBeDisabled();
  // An unrelated native state update runs the same full settings refresh.
  await page.evaluate(() => window.__nativeContract.pushState({ scrollLocked: true }));
  await expect(noise).toBeChecked();
  await page.evaluate(() => window.__nativeContract.release('audio_set_noise_suppression'));
  await expect(noise).toBeEnabled();
  await expect(noise).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioSaves.at(-1)?.noiseSuppression)).toBe(true);

  await page.evaluate(() => {
    window.__nativeContract.failNext('audio_set_noise_suppression', 'Fixture noise update rejected');
    window.__nativeContract.delayNext('audio_set_noise_suppression');
  });
  await noise.uncheck();
  await expect(noise).not.toBeChecked();
  await expect(noise).toBeDisabled();
  await page.evaluate(() => window.__nativeContract.pushState({ scrollLocked: false }));
  await expect(noise).not.toBeChecked();
  await page.evaluate(() => window.__nativeContract.release('audio_set_noise_suppression'));
  await expect(noise).toBeEnabled();
  await expect(noise).toBeChecked(); // Confirmed true is restored; rejected false is not persisted.
  await expect(page.locator('#mic-error')).toContainText('Fixture noise update rejected');
  expect(await page.evaluate(() => window.__nativeContract.audioSaves.at(-1)?.noiseSuppression)).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.lastCapture())).toMatchObject({
    id: initialCapture.id, channelId: initialCapture.channelId, active: true, noiseSuppression: true,
  });
  await page.keyboard.press('Escape');
});
