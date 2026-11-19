import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOverlaySize } from '../src/js/geometry.js';

test('text grows to its height cap without changing width', () => {
  const short = calculateOverlaySize({ contentHeight: 160, availableHeight: 900 });
  const long = calculateOverlaySize({ contentHeight: 5000, availableHeight: 900 });
  assert.equal(short.height, 160);
  assert.equal(long.height, 630);
  assert.equal(short.width, long.width);
});

test('split view stays within a small monitor and keeps a positive size', () => {
  const size = calculateOverlaySize({ mode: 'code', contentHeight: 2000, availableWidth: 800, availableHeight: 600 });
  assert.equal(size.width, 752);
  assert.equal(size.height, 420);
  const tiny = calculateOverlaySize({ availableWidth: 1, availableHeight: 1 });
  assert.deepEqual(tiny, { width: 1, height: 1, maxHeight: 1 });
});

test('opening settings can grow beyond the content cap but stays on the monitor', () => {
  const size = calculateOverlaySize({ contentHeight: 150, availableWidth: 900, availableHeight: 600, modalOpen: true });
  assert.equal(size.height, 564);
  assert.equal(size.width, 846);
});

test('the height preference has bounds and large displays do not create enormous windows', () => {
  assert.equal(calculateOverlaySize({ availableHeight: 1000, contentHeight: 5000, maxHeightPercent: -1 }).height, 400);
  assert.equal(calculateOverlaySize({ availableHeight: 1000, contentHeight: 5000, maxHeightPercent: 99 }).height, 760);
  assert.equal(calculateOverlaySize({ mode: 'code', availableHeight: 4000, contentHeight: 5000 }).height, 820);
});
