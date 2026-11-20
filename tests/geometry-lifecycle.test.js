import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createGeometrySync } from '../src/js/geometry.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const limit = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < limit, message);
    await pause(5);
  }
}

function fixture(t) {
  const dom = new JSDOM('<div id="overlay" data-mode="text"><div id="drag-region"></div><div id="text-panel"><div id="text-layout" data-window-drag="background"><div id="text-content"><p>Stable response.</p></div></div></div><div id="split-view"><div id="code-panel"><div id="code-content"><pre>code</pre></div></div><div id="notes-panel"><div id="notes-content"></div></div></div><div id="toolbar"></div></div>', { pretendToBeVisual: true });
  const view = dom.window;
  const document = view.document;
  const names = ['window', 'document', 'screen', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(view.screen, {
    availWidth: { configurable: true, value: 1440 },
    availHeight: { configurable: true, value: 1000 },
  });
  Object.defineProperties(view, {
    innerWidth: { configurable: true, value: 900 },
    innerHeight: { configurable: true, value: 144 },
  });
  const metrics = { height: 180, scrollHeight: null };
  for (const element of document.querySelectorAll('div, p, pre')) {
    const toolbar = element.id === 'toolbar';
    const height = toolbar ? 56 : element.id === 'overlay' ? 144 : 88;
    element.getBoundingClientRect = () => new view.DOMRect(0, toolbar ? 88 : 0, 900,
      element.id === 'text-content' ? metrics.height : height);
    element.getClientRects = () => [element.getBoundingClientRect()];
  }
  for (const id of ['text-panel', 'code-panel', 'notes-panel']) {
    document.getElementById(id).style.padding = '24px';
  }
  Object.defineProperty(document.getElementById('text-content'), 'scrollHeight', { get: () => metrics.scrollHeight ?? metrics.height });
  const noopObserver = class { observe() {} disconnect() {} };
  for (const [name, value] of Object.entries({
    window: view, document, screen: view.screen, ResizeObserver: noopObserver,
    getComputedStyle: view.getComputedStyle.bind(view),
    requestAnimationFrame: view.requestAnimationFrame.bind(view),
    cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
  })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  const pending = [], resizes = [], rects = [], errors = [];
  const geometry = createGeometrySync({
    bridge: {
      native: true,
      resize(width, height) {
        resizes.push({ width, height });
        return new Promise(resolve => pending.push({ width, height, resolve }));
      },
      updateHitRects(value) { rects.push(value); return Promise.resolve(); },
      reportError(error) { errors.push(error); },
    },
    overlay: document.getElementById('overlay'),
    getSettings: () => ({ maxHeightPercent: 70, scrollLocked: false }),
    isModalOpen: () => false,
  });
  t.after(() => {
    geometry.destroy();
    for (const entry of pending) entry.resolve({ width: entry.width, height: entry.height, applied: false });
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  function complete(index, applied) {
    const entry = pending[index];
    entry.resolve({ width: entry.width, height: entry.height, applied });
  }
  return { geometry, resizes, pending, rects, errors, complete, metrics, document, view };
}

test('a native resize ignored while inactive is retried after restore and only a successful acknowledgement is cached', async t => {
  const f = fixture(t);
  await until(() => f.pending.length === 1, 'initial resize was not requested');
  f.geometry.setActive(false);
  f.complete(0, false);
  await pause(25);
  const inactiveRects = f.rects.length;
  f.geometry.schedule();
  await pause(25);
  assert.equal(f.resizes.length, 1);
  assert.equal(f.rects.length, inactiveRects);
  f.geometry.setActive(true);
  await until(() => f.pending.length === 2, 'ignored native resize was cached instead of retried');
  assert.deepEqual(f.resizes[1], f.resizes[0]);
  f.complete(1, true);
  await pause(25);
  f.geometry.schedule();
  await pause(120);
  assert.equal(f.resizes.length, 2);
  assert.deepEqual(f.errors, []);
});

test('a resize acknowledgement from before deactivate cannot suppress a fresh same-size request after restore', async t => {
  const f = fixture(t);
  await until(() => f.pending.length === 1, 'initial resize was not requested');
  f.geometry.setActive(false);
  f.geometry.setActive(true);
  f.geometry.schedule();
  await pause(25);
  assert.equal(f.resizes.length, 1, 'native resize operations must not overlap');
  f.complete(0, true);
  await until(() => f.pending.length === 2, 'stale activity acknowledgement was accepted as the restored size');
  assert.deepEqual(f.resizes[1], f.resizes[0]);
  f.complete(1, true);
  await pause(25);
  f.geometry.schedule();
  await pause(120);
  assert.equal(f.resizes.length, 2);
  assert.deepEqual(f.errors, []);
});


test('animated descendant overflow does not inflate native sizing while real text layout growth still does', async t => {
  const f = fixture(t);
  await until(() => f.pending.length === 1, 'initial resize was not requested');
  const first = { ...f.resizes[0] };
  f.complete(0, true);
  await pause(25);
  // A FLIP translation can enlarge scrollHeight without changing text layout.
  f.metrics.scrollHeight = 4000;
  f.geometry.schedule();
  await pause(120);
  assert.deepEqual(f.resizes, [first]);
  f.metrics.height += 80;
  f.geometry.schedule();
  await until(() => f.pending.length === 2, 'real layout growth did not resize the window');
  assert.ok(f.resizes[1].height > first.height);
  assert.ok(f.resizes[1].height < 700, 'visual overflow must not force the height cap');
  f.complete(1, true);
  assert.deepEqual(f.errors, []);
});


test('hit areas and scrollbars are clipped to the visible surface while the text layout is larger', async t => {
  const f = fixture(t);
  const setRect = (id, x, y, width, height) => {
    f.document.getElementById(id).getBoundingClientRect = () => new f.view.DOMRect(x, y, width, height);
  };
  setRect('overlay', 0, 20, 900, 100);
  setRect('text-panel', 0, -60, 900, 300);
  setRect('text-layout', -30, -90, 960, 600);
  setRect('text-content', 50, 60, 800, f.metrics.height);
  const panel = f.document.getElementById('text-panel');
  panel.style.overflow = 'auto';
  Object.defineProperties(f.document.getElementById('text-layout'), {
    clientWidth: { configurable: true, value: 960 }, clientHeight: { configurable: true, value: 600 },
    offsetWidth: { configurable: true, value: 960 }, offsetHeight: { configurable: true, value: 600 },
  });
  Object.defineProperties(panel, {
    offsetHeight: { configurable: true, value: 300 },
    offsetWidth: { configurable: true, value: 900 },
    scrollHeight: { configurable: true, value: 800 },
    scrollWidth: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 288 },
    clientWidth: { configurable: true, value: 888 },
  });
  f.geometry.schedule();
  await until(() => f.rects.length > 0, 'visible hit areas were not published');
  const state = f.rects.at(-1);
  assert.ok(state.scrollbars.length > 0, 'the test must exercise a real overflowing panel');
  assert.ok(state.dragAreas.length > 0, 'the larger background must still expose visible free space');
  const areas = [state.toolbar, state.drag, state.text, state.code, state.notes, ...state.dragAreas, ...state.scrollbars].filter(Boolean);
  for (const area of areas) {
    assert.ok(area.x >= 0 && area.y >= 20, JSON.stringify(area));
    assert.ok(area.x + area.width <= 900 && area.y + area.height <= 120, JSON.stringify(area));
    assert.ok(area.width > 0 && area.height > 0);
  }
});
