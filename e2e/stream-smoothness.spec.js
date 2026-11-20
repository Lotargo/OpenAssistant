import { test, expect } from '@playwright/test';
import { openNative } from './helpers/native.js';
import { recordStreamTrace, summarizeStreamTrace } from './helpers/output-trace.js';

for (const width of [900, 390]) {
  test('streamed prose at ' + width + 'px keeps visible words and the surface smooth without temporary scrolling', async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await openNative(page, { screen: { width: width === 390 ? 434 : 1440, height: 1000 } });
    const trace = await recordStreamTrace(page, { mode: 'characters', gap: 45 });
    const metrics = summarizeStreamTrace(trace);
    await testInfo.attach('motion-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
    expect(trace.samples.filter(sample => sample.first?.visible).length).toBeGreaterThan(30);
    expect(trace.samples.some(sample => sample.chars < trace.samples.at(-1).chars && sample.resizeCount > 1)).toBe(true);
    // Controlled 7-character chunks used to move an existing word by 55px in
    // one frame. Bound the motion, not just the existence of intermediate heights.
    expect(Math.abs(metrics.incomingMotion.deltaPer16ms)).toBeLessThanOrEqual(12);
    expect(Math.abs(metrics.visibleMotionPerFrame.deltaPer16ms)).toBeLessThanOrEqual(16);
    expect(Math.abs(metrics.surfaceMotion.deltaPer16ms)).toBeLessThanOrEqual(12);
    expect(Math.abs(metrics.firstGlyphX.delta)).toBeLessThanOrEqual(1);
    expect(metrics.transientScroll).toEqual([]);
    expect(metrics.visualShrinks).toEqual([]);
    expect(page.viewportSize().width).toBe(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect({ captures: trace.captures, sessions: trace.sessions, errors }).toEqual({ captures: 0, sessions: 0, errors: [] });
  });
}

test('height-capped output follows its tail while a manual upward scroll between render and layout stays put', async ({ page }, testInfo) => {
  await openNative(page);
  const trace = await recordStreamTrace(page, { mode: 'paragraphs', gap: 65, chunks: 24, finish: false });
  const metrics = summarizeStreamTrace(trace);
  await testInfo.attach('capped-motion-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  const panel = page.locator('#text-panel');
  await expect.poll(() => panel.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(2);
  expect(await panel.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  // Track every visible paragraph, including older ones outside the renderer's
  // tail. Smooth growth and smooth scrolling add together at the height cap;
  // bound each component and reject an extra text jump beyond their common motion.
  expect.soft(Math.abs(metrics.scrollMotion.deltaPer16ms)).toBeLessThanOrEqual(12);
  expect.soft(Math.abs(metrics.surfaceMotion.deltaPer16ms)).toBeLessThanOrEqual(12);
  expect.soft(Math.abs(metrics.capResidualMotion.delta)).toBeLessThanOrEqual(2);
  expect.soft(metrics.transientScroll).toEqual([]);
  await page.evaluate(() => {
    const panel = document.querySelector('#text-panel');
    const text = document.querySelector('#text-content');
    window.__manualScrollTop = null;
    const observer = new MutationObserver(() => {
      observer.disconnect();
      panel.scrollTo({ top: Math.max(0, panel.scrollTop - 80), behavior: 'instant' });
      panel.dispatchEvent(new Event('scroll'));
      window.__manualScrollTop = panel.scrollTop;
    });
    observer.observe(text, { childList: true, characterData: true, subtree: true });
    window.__nativeContract.emit('assistant:chunk', { text: 'Дополнение после ручной прокрутки.\n\n' });
  });
  await expect(page.locator('#text-content')).toContainText('Дополнение после ручной прокрутки.');
  await expect.poll(() => page.evaluate(() => window.__manualScrollTop)).not.toBeNull();
  await page.waitForTimeout(300);
  const manualTop = await page.evaluate(() => window.__manualScrollTop);
  expect(await panel.evaluate(node => node.scrollTop)).toBeCloseTo(manualTop, 0);
  await page.evaluate(() => {
    window.__nativeContract.emit('assistant:chunk', { text: '</text>' });
    window.__nativeContract.emit('assistant:turn-end', {});
  });
  await page.waitForTimeout(300);
  expect(await panel.evaluate(node => node.scrollTop)).toBeCloseTo(manualTop, 0);
  expect(await panel.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThan(50);
});
