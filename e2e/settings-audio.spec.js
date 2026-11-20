import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openNative, settingsPage, setPressed } from './helpers/native.js';

async function openAudio(page) {
  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  await settings.locator('#tab-audio').click();
  await expect(settings.locator('#section-audio')).toBeVisible();
  return settings;
}

async function captureScreenshot(page, testInfo, name) {
  const directory = process.env.OPENASSISTANT_SCREENSHOT_DIR || testInfo.outputPath('screenshots');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name + '.png'), animations: 'disabled' });
}

async function assertStableTabs(page, testInfo, screenshots = false) {
  let first;
  await expect(page.locator('[role="tab"]')).toHaveCount(8);
  const controls = { modes: '#agent-scenario', agent: '#agent-model', workspace: '#agent-workspace-mode',
    audio: '#mic-device', screen: '#screen-window-mode', behavior: '#setting-scroll-lock', journal: '#journal-copy' };
  for (const [tab, control] of Object.entries(controls)) {
    await expect(page.locator('#section-' + tab).locator(control)).toHaveCount(1);
  }
  for (const tab of ['appearance', 'modes', 'agent', 'workspace', 'audio', 'screen', 'behavior', 'journal', 'appearance']) {
    await page.locator('#tab-' + tab).click();
    await expect(page.locator('#section-' + tab)).toBeVisible();
    await expect(page.locator('[role="tabpanel"]:visible')).toHaveCount(1);
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

  const mainViewport = page.viewportSize();
  const mainBounds = await page.locator('#overlay').boundingBox();
  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  expect(settings).not.toBe(page);
  await expect(settings.locator('#tab-appearance')).toBeFocused();
  const bounds = await assertStableTabs(settings, testInfo, true);
  expect(bounds).toEqual({ x: 0, y: 0, width: 860, height: 690 });
  expect(page.viewportSize()).toEqual(mainViewport);
  expect(await page.locator('#overlay').boundingBox()).toEqual(mainBounds);
  await expect(page.locator('#settings-dialog')).toHaveCount(0);
  await expect(page.locator('#overlay')).not.toHaveAttribute('inert', '');
  await expect(settings.locator('#overlay')).toHaveCount(0);
  expect(await settings.locator('body').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(24, 24, 27)');
  expect(await settings.locator('#settings-dialog').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(24, 24, 27)');
  await settings.locator('#tab-audio').click();
  expect(await settings.locator('.settings-main').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await settings.keyboard.press('Escape');
  await expect(settings.locator('#settings-dialog')).toBeHidden();
  await page.locator('[data-action="settings"]').click();
  await expect(settings.locator('#tab-appearance')).toBeFocused();
  expect(await settings.locator('#settings-dialog').boundingBox()).toEqual(bounds);
  expect(await page.locator('#overlay').boundingBox()).toEqual(mainBounds);
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
  await page.locator('#tab-audio').click();
  await captureScreenshot(page, testInfo, 'settings-narrow');
});

test('all eight tabs fit a narrow independent settings window', async ({ page }, testInfo) => {
  await openNative(page);
  const mainBounds = await page.locator('#overlay').boundingBox();
  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  await settings.setViewportSize({ width: 390, height: 690 });
  const bounds = await assertStableTabs(settings, testInfo, true);
  expect(bounds).toEqual({ x: 0, y: 0, width: 390, height: 690 });
  expect(await page.locator('#overlay').boundingBox()).toEqual(mainBounds);
});

test('local microphone check renders the same real levels without refreshing agent controls or opening Codex', async ({ page }, testInfo) => {
  await openNative(page);
  const idleWaves = await page.locator('.toolbar-audio-wave').evaluateAll(paths => paths.map(node => node.getAttribute('d')));
  const settings = await openAudio(page);
  await expect(settings.locator('#mic-noise-suppression')).toHaveAttribute('aria-pressed', 'false');
  await expect(settings.locator('#mic-device option')).toHaveCount(3);
  await settings.locator('#mic-test').click();
  await expect(settings.locator('#mic-test')).toHaveAttribute('aria-pressed', 'true');
  await expect(settings.locator('#mic-test-status')).toContainText('Говорите обычным голосом');
  expect(await page.evaluate(() => window.__nativeContract.audioStarts[0])).toMatchObject({
    mode: 'test', deviceId: null, noiseSuppression: false,
  });
  await settings.evaluate(() => {
    window.__agentMutations = 0;
    window.__agentObserver = new MutationObserver(records => { window.__agentMutations += records.length; });
    window.__agentObserver.observe(document.querySelector('#section-agent'), { subtree: true, childList: true, attributes: true });
  });
  await page.evaluate(() => {
    const harness = window.__nativeContract;
    const id = harness.lastCapture().id;
    const levels = {
      type: 'levels', rms: .1, raw_rms: .125, peak: .5, input_peak: .6, clipped_ratio: 0,
      waveform: [0, .35, -.25, .5, -.6, .1, 0],
    };
    for (let frame = 0; frame < 12; frame++) harness.emitAudio(id, levels);
    // Keep synthetic capture frames arriving while both webviews are photographed.
    // The separate stale-frame scenario intentionally sends a single frame.
    window.__fixtureLevelTimer = setInterval(() => harness.emitAudio(id, levels), 33);
  });
  await expect(settings.locator('#mic-level')).toHaveAttribute('aria-valuenow', '-18');
  await expect(settings.locator('#mic-level-label')).toHaveText('Входящий звук');
  await expect(settings.locator('#mic-wave-path')).not.toHaveAttribute('d', 'M0 32H480');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-active', 'true');
  await expect(page.locator('.toolbar-audio[data-active="true"]')).toHaveCount(2);
  const activeWaves = await page.locator('.toolbar-audio-wave').evaluateAll(paths => paths.map(node => node.getAttribute('d')));
  expect(activeWaves).toHaveLength(2);
  activeWaves.forEach((wave, index) => { expect(wave).toBeTruthy(); expect(wave).not.toBe(idleWaves[index]); });
  expect(await settings.evaluate(() => window.__agentMutations)).toBe(0);
  await captureScreenshot(page, testInfo, 'toolbar-microphone-active');
  await captureScreenshot(settings, testInfo, 'settings-microphone-active');
  await settings.evaluate(() => window.__agentObserver.disconnect());
  await page.evaluate(() => {
    clearInterval(window.__fixtureLevelTimer);
    delete window.__fixtureLevelTimer;
    const harness = window.__nativeContract;
    harness.emitAudio(harness.lastCapture().id, {
      type: 'levels', rms: .3, raw_rms: .5, peak: .6, input_peak: 1, clipped_ratio: .02, waveform: [0, 1, -.99, 0],
    });
  });
  await expect(settings.locator('#mic-level-label')).toHaveText('Слишком громко');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-clipped', 'true');
  await expect(page.locator('.toolbar-audio[data-clipped="true"]')).toHaveCount(2);

  const initialCapture = await page.evaluate(() => window.__nativeContract.lastCapture());
  await setPressed(settings.locator('#mic-noise-suppression'), true);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioNoiseChanges.at(-1))).toEqual({ captureId: initialCapture.id, enabled: true });
  expect(await page.evaluate(() => window.__nativeContract.captureIds)).toEqual([initialCapture.id]);
  await settings.locator('#mic-device').selectOption('fixture-usb');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioStarts.at(-1)?.deviceId)).toBe('fixture-usb');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioSaves.at(-1))).toEqual({ deviceId: 'fixture-usb', noiseSuppression: true, systemDeviceId: '' });
  await settings.locator('#tab-behavior').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(false);
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-active', 'false');
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length,
    sent: window.__nativeContract.audio.length,
  }))).toEqual({ sessions: 0, sent: 0 });
});

test('closing settings cancels a microphone check while native start is still pending', async ({ page }) => {
  await openNative(page);
  const settings = await openAudio(page);
  await page.evaluate(() => window.__nativeContract.delayNext('audio_start'));
  await settings.locator('#mic-test').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.filter(item => item.name === 'audio_start').length)).toBe(1);
  await expect(settings.locator('#mic-test')).toBeEnabled();
  await settings.keyboard.press('Escape');
  await expect(settings.locator('#settings-dialog')).toBeHidden();
  await page.evaluate(() => window.__nativeContract.release('audio_start'));
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(false);
  await openAudio(page);
  await expect(settings.locator('#mic-test')).toHaveAttribute('aria-pressed', 'false');
  await expect(settings.locator('#mic-test')).toBeEnabled();
  expect(await page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(0);
});

test('closing settings and losing focus keep live dictation running, but local testing stays disabled', async ({ page }) => {
  await openNative(page);
  await page.locator('[data-action="microphone"]').click();
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioStarts.at(-1)?.mode)).toBe('stream');
  const settings = await openAudio(page);
  await expect(settings.locator('#mic-test')).toBeDisabled();
  await expect(settings.locator('#mic-test-status')).toHaveText('Уровень текущего голосового ввода.');
  const initialCapture = await page.evaluate(() => window.__nativeContract.lastCapture());
  await settings.locator('#mic-device').selectOption('fixture-default');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioSaves.at(-1)?.deviceId)).toBe('fixture-default');
  await setPressed(settings.locator('#mic-noise-suppression'), true);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioNoiseChanges.at(-1))).toEqual({ captureId: initialCapture.id, enabled: true });
  expect(await page.evaluate(() => window.__nativeContract.lastCapture())).toMatchObject({
    id: initialCapture.id, channelId: initialCapture.channelId, active: true, noiseSuppression: true,
  });
  expect(await page.evaluate(() => window.__nativeContract.captureIds)).toEqual([initialCapture.id]);
  await page.evaluate(id => window.__nativeContract.emitAudio(id, { type: 'pcm', data: [0, 0, 1, 0] }), initialCapture.id);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audio.at(-1)?.bytes)).toBe(4);
  await settings.locator('#tab-behavior').click();
  await settings.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.audioStops)).toEqual([]);
  await page.locator('[data-action="microphone"]').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(false);
});

test('a missing selected microphone stays explicit and another device can be selected', async ({ page }) => {
  await openNative(page);
  const settings = await openAudio(page);
  await settings.locator('#mic-device').selectOption('fixture-usb');
  await page.evaluate(() => window.__nativeContract.setAudioDevices([
    { id: 'fixture-default', name: 'Fixture Microphone', is_default: true },
  ]));
  await settings.locator('#mic-refresh').click();
  await expect(settings.locator('#mic-device')).toHaveValue('fixture-usb');
  await expect(settings.locator('#mic-error')).toBeVisible();
  await expect(settings.locator('#mic-test')).toBeDisabled();
  await expect(settings.locator('#mic-device')).toBeEnabled();
  await settings.locator('#mic-device').selectOption('');
  await expect(settings.locator('#mic-error')).toBeHidden();
  await expect(settings.locator('#mic-test')).toBeEnabled();
  expect(await page.evaluate(() => window.__nativeContract.audioStarts)).toEqual([]);
});

test('meters clear frozen audio before capture times out without stopping the microphone', async ({ page }) => {
  await openNative(page);
  const settings = await openAudio(page);
  await settings.locator('#mic-test').click();
  await expect(settings.locator('#mic-test-status')).toContainText('Говорите обычным голосом');
  await page.evaluate(() => {
    const harness = window.__nativeContract;
    harness.emitAudio(harness.lastCapture().id, {
      type: 'levels', rms: .3, raw_rms: .5, peak: .8, input_peak: 1, clipped_ratio: .02, waveform: [0, .8, -.7, 0],
    });
  });
  await expect(settings.locator('#mic-monitor')).toHaveAttribute('data-active', 'true');
  await expect(settings.locator('#mic-level-label')).toHaveText('Слишком громко');
  await expect(settings.locator('#mic-level-label')).toHaveText('Нет сигнала', { timeout: 2000 });
  await expect(settings.locator('#mic-level')).toHaveAttribute('aria-valuenow', '-60');
  await expect(settings.locator('#mic-wave-path')).toHaveAttribute('d', 'M0 32H480');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-active', 'false');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('data-audio-clipped', 'false');
  await expect(page.locator('.toolbar-audio[data-active="false"][data-clipped="false"]')).toHaveCount(2);
  // A later lifecycle refresh with the same levels must leave the display empty.
  await page.waitForTimeout(300);
  await expect(settings.locator('#mic-level-label')).toHaveText('Нет сигнала');
  expect(await page.evaluate(() => window.__nativeContract.lastCapture()?.active)).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.audioStops)).toEqual([]);
  await settings.keyboard.press('Escape');
});

test('noise toggle preserves pending intent through native latency and reverts on rejection', async ({ page }) => {
  await openNative(page);
  const settings = await openAudio(page);
  await settings.locator('#mic-test').click();
  await expect(settings.locator('#mic-test-status')).toContainText('Говорите обычным голосом');
  const noise = settings.locator('#mic-noise-suppression');
  const initialCapture = await page.evaluate(() => window.__nativeContract.lastCapture());
  await page.evaluate(() => window.__nativeContract.delayNext('audio_set_noise_suppression'));
  await setPressed(noise, true);
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.filter(item => item.name === 'audio_set_noise_suppression').length)).toBe(1);
  await expect(noise).toHaveAttribute('aria-pressed', 'true');
  await expect(noise).toBeDisabled();
  // An unrelated native state update runs the same full settings refresh.
  await page.evaluate(() => window.__nativeContract.pushState({ scrollLocked: true }));
  await expect(noise).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.__nativeContract.release('audio_set_noise_suppression'));
  await expect(noise).toBeEnabled();
  await expect(noise).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.audioSaves.at(-1)?.noiseSuppression)).toBe(true);

  await page.evaluate(() => {
    window.__nativeContract.failNext('audio_set_noise_suppression', 'Fixture noise update rejected');
    window.__nativeContract.delayNext('audio_set_noise_suppression');
  });
  await setPressed(noise, false);
  await expect(noise).toHaveAttribute('aria-pressed', 'false');
  await expect(noise).toBeDisabled();
  await page.evaluate(() => window.__nativeContract.pushState({ scrollLocked: false }));
  await expect(noise).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => window.__nativeContract.release('audio_set_noise_suppression'));
  await expect(noise).toBeEnabled();
  await expect(noise).toHaveAttribute('aria-pressed', 'true'); // Confirmed true is restored; rejected false is not persisted.
  await expect(settings.locator('#mic-error')).toContainText('Fixture noise update rejected');
  expect(await page.evaluate(() => window.__nativeContract.audioSaves.at(-1)?.noiseSuppression)).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.lastCapture())).toMatchObject({
    id: initialCapture.id, channelId: initialCapture.channelId, active: true, noiseSuppression: true,
  });
  await settings.keyboard.press('Escape');
});

test('startup remains empty and two audio decorations use the free toolbar edges around six centered controls', async ({ page }) => {
  await openNative(page);
  await expect(page.locator('#text-content')).toHaveText('');
  await expect(page.locator('#notes-content')).toHaveText('');
  await expect(page.locator('#code-content')).toHaveText('');
  const indicators = page.locator('.toolbar-audio');
  await expect(indicators).toHaveCount(2);
  for (const side of ['left', 'right']) {
    const indicator = page.locator('[data-toolbar-audio="' + side + '"]');
    await expect(indicator).toHaveAttribute('aria-hidden', 'true');
    await expect(indicator).toHaveAttribute('data-active', 'false');
    expect(await indicator.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
  }
  for (const width of [900, 320]) {
    await page.evaluate(() => { window.__nativeContract.applyResizes = false; });
    await page.setViewportSize({ width, height: 180 });
    const bounds = await page.evaluate(() => {
      const box = selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        toolbar: box('#toolbar'), first: box('#toolbar > button:first-of-type'),
        last: box('#toolbar > button:last-of-type'),
        left: box('[data-toolbar-audio="left"]'), right: box('[data-toolbar-audio="right"]'),
      };
    });
    expect(Math.abs((bounds.first.x + bounds.last.x + bounds.last.width) / 2 - width / 2)).toBeLessThan(1);
    if (width > 360) {
      expect(bounds.left.width).toBeGreaterThan(0);
      expect(bounds.right.width).toBeGreaterThan(0);
      expect(bounds.left.x).toBeGreaterThanOrEqual(bounds.toolbar.x);
      expect(bounds.left.x + bounds.left.width).toBeLessThanOrEqual(bounds.first.x);
      expect(bounds.right.x).toBeGreaterThanOrEqual(bounds.last.x + bounds.last.width);
      expect(bounds.right.x + bounds.right.width).toBeLessThanOrEqual(bounds.toolbar.x + bounds.toolbar.width);
    } else {
      // Narrow windows reserve the available width for all six controls.
      expect(bounds.left.width).toBe(0);
      expect(bounds.right.width).toBe(0);
      expect(bounds.first.x).toBeGreaterThanOrEqual(0);
      expect(bounds.last.x + bounds.last.width).toBeLessThanOrEqual(width);
    }
  }
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds.length,
    captures: window.__nativeContract.captureIds.length,
  }))).toEqual({ sessions: 0, captures: 0 });
});