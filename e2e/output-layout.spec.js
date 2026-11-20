import { test, expect } from '@playwright/test';
import { openNative } from './helpers/native.js';

async function response(page, content) {
  await page.evaluate(content => {
    const h = window.__nativeContract;
    h.emit('assistant:turn-start', {});
    h.emit('assistant:chunk', { text: content });
    h.emit('assistant:turn-end', {});
  }, content);
}

test('short output is centered and a continuous text stream grows before its end without hiding the beginning', async ({ page }) => {
  await openNative(page);
  await page.evaluate(() => { window.__nativeContract.applyResizes = false; });
  await page.setViewportSize({ width: 900, height: 360 });
  await response(page, '<mode>text</mode><text>Короткий ответ.</text>');
  await expect(page.locator('#text-content')).toHaveText('Короткий ответ.');
  await expect(page.locator('#text-content')).not.toHaveAttribute('data-output-entering', 'true');
  const centered = await page.evaluate(() => {
    const panel = document.querySelector('#text-panel').getBoundingClientRect();
    const content = document.querySelector('#text-content').getBoundingClientRect();
    return {
      x: Math.abs(content.x + content.width / 2 - panel.x - panel.width / 2),
      y: Math.abs(content.y + content.height / 2 - panel.y - panel.height / 2),
      align: getComputedStyle(document.querySelector('#text-content p')).textAlign,
    };
  });
  expect(centered.x).toBeLessThan(2);
  expect(centered.y).toBeLessThan(2);
  expect(centered.align).toBe('center');

  // Restore the compact test window; a pure OS resize does not invalidate the
  // native target-size cache by design.
  await page.setViewportSize({ width: 900, height: 144 });
  await page.evaluate(() => {
    const h = window.__nativeContract;
    h.applyResizes = true;
    h.emit('assistant:turn-start', {});
    h.emit('assistant:chunk', { text: '<mode>text</mode><text>Начало потока.\n\n' });
  });
  await expect(page.locator('#text-content')).toHaveText('Начало потока.');
  await expect.poll(() => page.evaluate(() => innerHeight)).toBeLessThan(250);
  const initialHeight = await page.evaluate(() => innerHeight);
  await page.evaluate(() => {
    const h = window.__nativeContract;
    const stream = window.__layoutStream = { count: 0, complete: false, samples: [] };
    const sample = () => {
      const rect = document.querySelector('#overlay').getBoundingClientRect();
      stream.samples.push({ height: rect.height, bottom: rect.bottom, viewport: innerHeight });
      if (!stream.complete) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const timer = setInterval(() => {
      stream.count++;
      h.emit('assistant:chunk', { text: 'Строка ' + stream.count + ': новый фрагмент ответа.\n\n' });
      if (stream.count === 32) {
        clearInterval(timer);
        h.emit('assistant:chunk', { text: '</text>' });
        h.emit('assistant:turn-end', {});
        stream.complete = true;
      }
    }, 45);
  });
  await expect.poll(() => page.evaluate(height => innerHeight - height, initialHeight)).toBeGreaterThan(60);
  expect(await page.evaluate(() => window.__layoutStream.complete)).toBe(false);
  await expect(page.locator('#text-content')).toContainText('Строка 32:');
  await expect.poll(() => page.evaluate(() => window.__layoutStream.complete)).toBe(true);
  await expect(page.locator('#overlay')).not.toHaveAttribute('data-output-growing', 'true');
  const streamGeometry = await page.evaluate(initial => ({
    grewBetweenFrames: window.__layoutStream.samples.some(sample => sample.height > initial + 1 && sample.height < sample.viewport - 2),
    bottomAnchored: window.__layoutStream.samples.every(sample => Math.abs(sample.bottom - sample.viewport) < 2),
    bounded: window.__layoutStream.samples.every(sample => sample.height <= sample.viewport + 1),
    height: innerHeight,
    scrolls: document.querySelector('#text-panel').scrollHeight > document.querySelector('#text-panel').clientHeight,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }), initialHeight);
  expect(streamGeometry).toMatchObject({ grewBetweenFrames: true, bottomAnchored: true, bounded: true, scrolls: true, overflow: false });
  expect(streamGeometry.height).toBeLessThanOrEqual(700);
  await page.locator('#text-panel').evaluate(node => { node.scrollTop = 0; });
  const start = await page.evaluate(() => {
    const panel = document.querySelector('#text-panel').getBoundingClientRect();
    const first = document.querySelector('#text-content p').getBoundingClientRect();
    return { top: first.top - panel.top, bottom: first.bottom - panel.top, panelHeight: panel.height };
  });
  expect(start.top).toBeGreaterThanOrEqual(0);
  expect(start.bottom).toBeLessThan(start.panelHeight);
});

test('reduced motion keeps centered prose immediate and split code with left-aligned notes within narrow bounds', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openNative(page);
  await page.evaluate(() => { window.__nativeContract.applyResizes = false; });
  await page.setViewportSize({ width: 390, height: 420 });
  await response(page, '<mode>text</mode><text>Первый абзац.\n\nВторой абзац.</text>');
  await expect(page.locator('#text-content p')).toHaveCount(2);
  await expect(page.locator('#text-content')).not.toHaveAttribute('data-output-entering', 'true');
  await expect(page.locator('#overlay')).not.toHaveAttribute('data-output-growing', 'true');
  expect(await page.locator('#text-content').evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  expect(await page.locator('#text-content p').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).textAlign === 'center'))).toBe(true);

  const source = Array.from({ length: 45 }, (_, index) => 'SELECT ' + (index + 1) + ';').join('\n');
  await response(page, '<mode>code</mode><code_meta>{"filename":"stream.sql","lang":"sql"}</code_meta><code>'
    + source + '</code><notes>Пояснения остаются отдельными.\n\n1. Проверьте схему.\n2. Выполните запрос.</notes>');
  await expect(page.locator('#code-content .line')).toHaveCount(45);
  await expect(page.locator('#notes-content')).toContainText('Пояснения остаются отдельными.');
  await expect(page.locator('#text-panel')).toBeHidden();
  expect(['left', 'start']).toContain(await page.locator('#notes-content p').evaluate(node => getComputedStyle(node).textAlign));
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 420 });
    const boxes = await page.evaluate(() => {
      const rect = selector => {
        const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      };
      return { code: rect('#code-panel'), notes: rect('#notes-panel'), toolbar: rect('#toolbar'),
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(boxes.code.right).toBeLessThan(boxes.notes.x);
    expect(boxes.notes.right).toBeLessThanOrEqual(width);
    expect(boxes.toolbar.bottom).toBeLessThanOrEqual(420);
    expect(boxes.code.height).toBeGreaterThan(0);
    expect(boxes.notes.height).toBeGreaterThan(0);
    expect(boxes.overflow).toBe(false);
  }
  expect(await page.evaluate(() => ({
    audio: window.__nativeContract.captureIds.length,
    sessions: window.__nativeContract.sessionIds.length,
  }))).toEqual({ audio: 0, sessions: 0 });
});
