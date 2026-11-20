import { test, expect } from '@playwright/test';
import { openNative, settingsPage } from './helpers/native.js';

const modeButton = page => page.locator('#window-mode-btn');
const dragCount = page => page.evaluate(() => window.__nativeContract.dragStarts.length);

async function pointerDrag(page, { x, y }, { dx = 24, dy = 12, button = 'left' } = {}) {
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.move(x + dx, y + dy, { steps: 3 });
  await page.mouse.up({ button });
}

async function pointIn(locator, dx = 12, dy = 10) {
  const box = await locator.boundingBox();
  return { x: box.x + dx, y: box.y + dy };
}

test('window mode makes the native roundtrip, survives reload and keeps all six controls within a small window', async ({ page }) => {
  await openNative(page);
  const button = modeButton(page);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.windowModeSaves.at(-1))).toBe('standard');
  expect(await page.evaluate(() => window.__nativeContract.calls.filter(call => call.name === 'set_window_mode').at(-1)?.args))
    .toEqual({ mode: 'standard' });

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(modeButton(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__nativeContract.calls.some(call => call.name === 'set_window_mode' && call.args.mode === 'standard'))).toBe(true);
  await modeButton(page).click();
  await expect(modeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.windowModeSaves.at(-1))).toBe('overlay');

  await page.evaluate(() => { window.__nativeContract.applyResizes = false; });
  await page.setViewportSize({ width: 320, height: 180 });
  const controls = page.locator('#toolbar > button');
  await expect(controls).toHaveCount(6);
  const boxes = await controls.evaluateAll(buttons => buttons.map(button => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x, y, width, height };
  }));
  for (const [index, box] of boxes.entries()) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(180);
    expect(box.width).toBeGreaterThanOrEqual(36);
    if (index) expect(boxes[index - 1].x + boxes[index - 1].width).toBeLessThanOrEqual(box.x);
  }
  expect(Math.abs((boxes[0].x + boxes.at(-1).x + boxes.at(-1).width) / 2 - 160)).toBeLessThan(1);
});

test('a late window-mode command cannot overwrite a newer native mode or persist its stale value', async ({ page }) => {
  await openNative(page);
  await page.evaluate(() => window.__nativeContract.delayNext('set_window_mode'));
  await modeButton(page).click();
  await expect(modeButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.filter(item => item.name === 'set_window_mode').length)).toBe(1);
  await page.evaluate(() => window.__nativeContract.pushState({ windowMode: 'overlay' }));
  await expect(modeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => window.__nativeContract.release('set_window_mode'));
  await expect(modeButton(page)).toBeEnabled();
  await expect(modeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => window.__nativeContract.windowModeSaves.at(-1))).toBe('overlay');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(modeButton(page)).toHaveAttribute('aria-pressed', 'false');
});

test('native drag starts once after a movement threshold on free space and on the settings header', async ({ page }) => {
  await openNative(page);
  const point = await pointIn(page.locator('#drag-region'), 40, 5);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 3, point.y);
  expect(await dragCount(page)).toBe(0);
  await page.mouse.move(point.x + 20, point.y + 2);
  await expect.poll(() => dragCount(page)).toBe(1);
  await page.mouse.move(point.x + 45, point.y + 2);
  await page.mouse.up();
  expect(await dragCount(page)).toBe(1);
  expect(await page.evaluate(() => window.__nativeContract.dragStarts[0])).toMatchObject({ settingsOpen: false, windowMode: 'overlay', windowLabel: 'main' });

  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  await expect(settings.locator('#tab-appearance')).toBeFocused();
  const header = await settings.locator('.settings-header').boundingBox();
  await pointerDrag(settings, { x: header.x + header.width / 2, y: header.y + header.height / 2 });
  await expect.poll(() => dragCount(page)).toBe(2);
  expect(await page.evaluate(() => window.__nativeContract.dragStarts[1])).toMatchObject({ settingsOpen: true, windowLabel: 'settings' });
  await expect(settings.locator('#settings-dialog')).toBeVisible();
});

test('native drag ignores controls, selectable content, scrollbars, inputs and the right mouse button', async ({ page }) => {
  await openNative(page);
  await page.evaluate(() => document.addEventListener('contextmenu', event => event.preventDefault()));
  await pointerDrag(page, await pointIn(page.locator('#drag-region'), 40, 5), { button: 'right' });
  // A real answer remains selectable even though the initial panel is empty.
  await page.evaluate(() => {
    const harness = window.__nativeContract;
    harness.emit('assistant:turn-start', {});
    harness.emit('assistant:chunk', { text: '<mode>text</mode><text>Ответ для проверки выделения текста.</text>' });
    harness.emit('assistant:turn-end', {});
  });
  await expect(page.locator('#text-content p')).toHaveCount(1);
  await pointerDrag(page, await pointIn(page.locator('#text-content'), 10, 10));
  await page.evaluate(() => getSelection()?.removeAllRanges());
  const screen = await page.locator('[data-action="screen"]').boundingBox();
  await pointerDrag(page, { x: screen.x + screen.width / 2, y: screen.y + screen.height / 2 }, { dx: 0, dy: -65 });
  expect(await dragCount(page)).toBe(0);

  await page.evaluate(() => {
    const harness = window.__nativeContract;
    harness.emit('assistant:turn-start', {});
    harness.emit('assistant:chunk', { text: '<mode>text</mode><text>' + Array.from({ length: 100 }, (_, index) => 'Paragraph ' + index).join('\n\n') + '</text>' });
    harness.emit('assistant:turn-end', {});
  });
  await expect(page.locator('#text-content p')).toHaveCount(100);
  await page.addStyleTag({ content: '#text-panel { overflow-y: scroll !important; } #text-panel::-webkit-scrollbar { width: 16px !important; }' });
  const scrollbar = await page.locator('#text-panel').evaluate(panel => {
    panel.scrollTop = 0;
    const box = panel.getBoundingClientRect();
    const width = panel.offsetWidth - panel.clientWidth;
    return { x: box.right - Math.max(2, width / 2), y: box.y + 15, scrollable: panel.scrollHeight > panel.clientHeight };
  });
  // Overlay scrollbars reserve no client width on some Edge configurations.
  expect(scrollbar.scrollable).toBe(true);
  await expect.poll(() => page.evaluate(({ x, y }) => {
    const rects = window.__nativeContract.hitRects;
    const contains = rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    return {
      scrollbar: (rects?.scrollbars || []).some(contains),
      drag: (rects?.dragAreas || []).some(contains),
    };
  }, scrollbar)).toEqual({ scrollbar: true, drag: false });
  await pointerDrag(page, scrollbar, { dx: 0, dy: 90 });
  expect(await dragCount(page)).toBe(0);
  await page.evaluate(() => getSelection()?.removeAllRanges());

  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  await expect(settings.locator('#tab-appearance')).toBeFocused();
  await settings.locator('#tab-agent').click();
  await settings.locator('#agent-prompt').scrollIntoViewIfNeeded();
  await pointerDrag(settings, await pointIn(settings.locator('#agent-prompt'), 20, 15), { dx: 80, dy: 10 });
  expect(await dragCount(page)).toBe(0);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  const close = await settings.locator('[data-close-settings]').boundingBox();
  await pointerDrag(settings, { x: close.x + close.width / 2, y: close.y + close.height / 2 }, { dx: -65, dy: 25 });
  expect(await dragCount(page)).toBe(0);
  await expect(settings.locator('#settings-dialog')).toBeVisible();
});

test('restore republishes unchanged native hit areas without changing the user window size', async ({ page }) => {
  await openNative(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.__nativeContract.hitRects?.drag))).toBe(true);
  await page.evaluate(() => { window.__nativeContract.applyResizes = false; });
  await page.setViewportSize({ width: 760, height: 280 });
  await page.waitForTimeout(150);
  const initial = await page.evaluate(() => ({
    resizes: window.__nativeContract.resizes.length,
    publishes: window.__nativeContract.calls.filter(call => call.name === 'update_hit_rects').length,
  }));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    window.__nativeContract.hitRects = null;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.__nativeContract.hitRects?.drag))).toBe(true);
  const resumed = await page.evaluate(() => ({
    resizes: window.__nativeContract.resizes.length,
    publishes: window.__nativeContract.calls.filter(call => call.name === 'update_hit_rects').length,
    rects: window.__nativeContract.hitRects,
  }));
  expect(resumed.publishes).toBeGreaterThan(initial.publishes);
  expect(resumed.resizes).toBe(initial.resizes);
  expect(page.viewportSize()).toEqual({ width: 760, height: 280 });
  expect(resumed.rects.toolbar).toEqual(await page.locator('#toolbar').boundingBox());
  expect(resumed.rects.drag.width).toBeGreaterThan(0);
});

test('scoped native activity restores both window gestures and main hit areas without DOM lifecycle events', async ({ page }) => {
  await openNative(page);
  await page.locator('[data-action="settings"]').click();
  const settings = await settingsPage(page);
  const before = await page.evaluate(() => ({
    resizes: window.__nativeContract.resizes.length, width: innerWidth, height: innerHeight,
  }));
  for (const [label, view, selector] of [['main', page, '#drag-region'], ['settings', settings, '.settings-header']]) {
    await view.evaluate(() => {
      window.__fixtureLifecycle = [];
      document.addEventListener('visibilitychange', () => window.__fixtureLifecycle.push('visibilitychange'));
      for (const event of ['blur', 'focus', 'pageshow']) window.addEventListener(event, () => window.__fixtureLifecycle.push(event));
    });
    const gesture = () => view.evaluate(selector => {
      const surface = document.querySelector(selector);
      const rect = surface.getBoundingClientRect();
      const pointer = { bubbles: true, cancelable: true, pointerId: 17, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: 1, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
      surface.dispatchEvent(new PointerEvent('pointerdown', pointer));
      surface.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: pointer.clientX + 10 }));
    }, selector);
    const callCount = await page.evaluate(() => window.__nativeContract.dragStarts.length);
    await page.evaluate(() => window.__nativeContract.delayNext('start_window_drag'));
    await gesture();
    await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.filter(item => item.name === 'start_window_drag').length)).toBe(1);
    await expect(view.locator('html')).toHaveClass(/window-dragging/);
    await view.evaluate(() => window.__receiveNativeEvent('overlay:window-activity', { active: false }));
    await expect(view.locator('html')).not.toHaveClass(/window-dragging/);
    await gesture();
    expect(await page.evaluate(() => window.__nativeContract.dragStarts.length)).toBe(callCount + 1);
    if (label === 'main') await page.evaluate(() => { window.__nativeContract.hitRects = null; });
    await view.evaluate(() => window.__receiveNativeEvent('overlay:window-activity', { active: true }));
    if (label === 'main') await expect.poll(() => page.evaluate(() => Boolean(window.__nativeContract.hitRects?.drag))).toBe(true);

    await page.evaluate(() => window.__nativeContract.delayNext('start_window_drag'));
    await gesture();
    await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.filter(item => item.name === 'start_window_drag').length)).toBe(2);
    expect(await page.evaluate(() => window.__nativeContract.dragStarts.at(-1)?.windowLabel)).toBe(label);
    await page.evaluate(() => window.__nativeContract.release('start_window_drag'));
    await expect(view.locator('html')).toHaveClass(/window-dragging/);
    await page.evaluate(() => window.__nativeContract.release('start_window_drag'));
    await expect(view.locator('html')).not.toHaveClass(/window-dragging/);
    expect(await view.evaluate(() => ({ events: window.__fixtureLifecycle, hidden: document.hidden }))).toEqual({ events: [], hidden: false });
  }
  expect(await page.evaluate(() => ({
    resizes: window.__nativeContract.resizes.length, width: innerWidth, height: innerHeight,
  }))).toEqual(before);
});
