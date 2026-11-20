import { test, expect } from '@playwright/test';
import { openNative, notificationPage } from './helpers/native.js';

test('both halves of the wide neutral mode button cycle equally and all nine icon controls fit compact windows', async ({ page }) => {
  await openNative(page, { storeValues: { appearance: { accentColor: '#00FF00' } } });
  const buttons = page.locator('#toolbar button');
  await expect(buttons).toHaveCount(9);
  const mode = page.locator('#mode-btn');
  const names = { assistant: 'Ассистент', interview: 'Совещание', custom: 'Свой режим' };
  const icons = [];
  const currentIcon = mode.locator('.mode-current-icon > svg');
  const cycleIcon = mode.locator('.mode-cycle-icon > svg');
  const cycleShape = await cycleIcon.innerHTML();
  const cycle = [['assistant', 'interview'], ['interview', 'custom'], ['custom', 'assistant']];
  for (const [index, [current, next]] of [...cycle, ...cycle].entries()) {
    await expect(mode).toHaveAttribute('data-current-scenario', current);
    await expect(mode).toHaveAccessibleName('Режим: ' + names[current] + '. Переключить: ' + names[next]);
    if (index < 3) icons.push(await currentIcon.innerHTML());
    const box = await mode.boundingBox();
    // Alternating halves across two cycles exercises each half in every mode.
    await mode.click({ position: { x: box.width * (index % 2 ? .75 : .25), y: box.height / 2 } });
    await expect(mode).toHaveAttribute('data-current-scenario', next);
    expect(await cycleIcon.innerHTML()).toBe(cycleShape);
  }
  expect(new Set(icons).size).toBe(3);
  expect(await currentIcon.innerHTML()).toBe(icons[0]);
  expect(await currentIcon.evaluate(node => node.getBoundingClientRect().width)).toBe(21);
  expect(await cycleIcon.evaluate(node => node.getBoundingClientRect().width)).toBe(16);
  for (const part of ['.mode-current-icon', '.mode-cycle-icon']) {
    expect(await mode.locator(part).evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
  }
  await expect.poll(() => page.evaluate(() => window.__nativeContract.agentSaves.at(-1)?.scenario)).toBe('assistant');
  expect(await page.evaluate(() => ({
    sessions: window.__nativeContract.sessionIds, captures: window.__nativeContract.captureIds,
    starts: window.__nativeContract.broadcastStarts,
  }))).toEqual({ sessions: [], captures: [], starts: [] });
  for (const button of await buttons.all()) {
    expect((await button.innerText()).trim()).toBe('');
    await expect(button.locator('svg')).toHaveCount(await button.getAttribute('id') === 'mode-btn' ? 2 : 1);
    for (const svg of await button.locator('svg').all()) {
      expect(await svg.evaluate(node => Number.parseFloat(getComputedStyle(node).strokeWidth))).toBeCloseTo(1.65, 2);
    }
    await expect(button).toHaveAccessibleName(/\S/);
    expect(await button.getAttribute('title')).toBeNull();
    expect(await button.getAttribute('data-tooltip')).toBe(await button.getAttribute('aria-label'));
  }
  await page.locator('[data-action="scroll-lock"]').click();
  await expect(page.locator('[data-action="scroll-lock"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#window-mode-btn').click();
  await expect(page.locator('#window-mode-btn')).toHaveAttribute('aria-pressed', 'true');
  // A deliberately saturated settings accent must not tint the toolbar.
  expect(await page.locator('html').evaluate(node => node.style.getPropertyValue('--settings-accent'))).toBe('#00FF00');
  for (const selector of ['#mode-btn', '#notifications-btn', '#window-mode-btn', '[data-action="scroll-lock"]']) {
    const colors = await page.locator(selector).evaluate(node => {
      const style = getComputedStyle(node);
      const visibleColors = [style.backgroundColor];
      if (style.borderTopStyle !== 'none' && Number.parseFloat(style.borderTopWidth) > 0) visibleColors.push(style.borderTopColor);
      return visibleColors.map(color => color.match(/[\d.]+/g).slice(0, 3).map(Number));
    });
    for (const [red, green, blue] of colors) {
      expect(red).toBe(green);
      expect(green).toBe(blue);
    }
  }
  await expect(page.locator('[data-action="microphone"]')).toHaveCSS('color', 'rgb(184, 190, 200)');
  await mode.hover();
  const tooltip = page.locator('#toolbar-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(await mode.getAttribute('aria-label'));
  expect(await tooltip.evaluate(node => Boolean(node.closest('#overlay')))).toBe(true);
  expect(await tooltip.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
  await expect(tooltip).toHaveAttribute('data-window-drag-ignore', '');
  for (const width of [900, 390, 320]) {
    await page.evaluate(() => { window.__nativeContract.applyResizes = false; });
    await page.setViewportSize({ width, height: 180 });
    const modeBox = await mode.boundingBox();
    expect(modeBox.width).toBeCloseTo(82, 1);
    expect(modeBox.height).toBeCloseTo(40, 1);
    const boxes = await buttons.evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }));
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(180);
      expect(box.width).toBeGreaterThanOrEqual(32);
      expect(box.height).toBeGreaterThanOrEqual(32);
    }
    for (let index = 0; index < boxes.length; index++) for (const other of boxes.slice(index + 1)) {
      const box = boxes[index];
      const overlapping = box.x < other.x + other.width && other.x < box.x + box.width
        && box.y < other.y + other.height && other.y < box.y + box.height;
      expect(overlapping).toBe(false);
    }
  }
});

test('independent notifications reject stale hides, survive main inactivity and leave main geometry untouched', async ({ page }) => {
  await openNative(page);
  await page.waitForTimeout(150); // Let the initial geometry debounce settle before measuring side effects.
  const before = await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight], resizes: window.__nativeContract.resizes.length,
    hitRects: structuredClone(window.__nativeContract.hitRects), dragStarts: window.__nativeContract.dragStarts.length,
  }));
  await page.locator('[data-action="scroll-lock"]').click();
  const notification = await notificationPage(page);
  expect(notification).not.toBe(page);
  await expect(notification.locator('#notification-card')).toHaveAttribute('data-phase', 'visible');
  const oldId = await notification.locator('#notification-card').getAttribute('data-id');
  await page.locator('[data-action="scroll-lock"]').click();
  await expect.poll(() => notification.locator('#notification-card').getAttribute('data-id')).not.toBe(oldId);
  const currentId = await notification.locator('#notification-card').getAttribute('data-id');
  await expect(notification.locator('#notification-card')).toHaveAttribute('data-phase', 'visible');
  const latest = await page.evaluate(() => window.__nativeContract.notificationShows.at(-1));
  expect(latest.id).toBe(currentId);
  expect(Object.keys(latest.theme).sort()).toEqual(['accentColor', 'fontSize', 'opacity', 'panelColor', 'textColor']);
  await expect(notification.locator('#notification-message')).toHaveText(latest.message);
  await page.evaluate(id => window.__nativeContract.emitTo('notification', 'notification:hide', { id }), oldId);
  expect(await notification.evaluate(id => window.__TAURI_INTERNALS__.invoke('notification_dismissed', { id }), oldId)).toBe(false);
  await page.evaluate(id => window.__TAURI_INTERNALS__.invoke('notification_hide', { id }), oldId);
  await page.evaluate(() => window.__nativeContract.emitTo('main', 'overlay:window-activity', { active: false }));
  await expect(notification.locator('#notification-card')).toHaveAttribute('data-id', currentId);
  await expect(notification.locator('#notification-card')).toHaveAttribute('data-phase', 'visible');
  expect(await page.evaluate(() => window.__nativeContract.getNotification())).toMatchObject({ visible: true, notification: { id: currentId } });
  await expect(page.locator('#action-toast')).toHaveCount(0);
  expect(await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight], resizes: window.__nativeContract.resizes.length,
    hitRects: structuredClone(window.__nativeContract.hitRects), dragStarts: window.__nativeContract.dragStarts.length,
  }))).toEqual(before);
  const commands = await notification.evaluate(() => window.__notificationNativeCalls.filter(call => !call.name.startsWith('plugin:event|')).map(call => call.name));
  expect(commands).toContain('notification_ready');
  expect(commands).toContain('notification_present');
  expect(commands.every(name => ['notification_ready', 'notification_present', 'notification_dismissed'].includes(name))).toBe(true);
  const listeners = await notification.evaluate(() => window.__notificationNativeCalls.filter(call => call.name === 'plugin:event|listen').map(call => call.args.target));
  expect(listeners).toEqual(Array.from({ length: 3 }, () => ({ kind: 'WebviewWindow', label: 'notification' })));
});
