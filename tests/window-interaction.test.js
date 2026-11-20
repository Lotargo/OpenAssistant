import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createWindowInteraction, getBackgroundDragRects, getScrollbarRects } from '../src/js/window-interaction.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function box(element, geometry) {
  const value = { x: 0, y: 0, width: 100, height: 100, ...geometry };
  const rect = () => ({ ...value, left: value.x, top: value.y, right: value.x + value.width, bottom: value.y + value.height });
  element.getClientRects = () => [rect()];
  element.getBoundingClientRect = rect;
  for (const [key, initial] of Object.entries({
    offsetWidth: value.width, offsetHeight: value.height, clientLeft: 0, clientTop: 0,
    clientWidth: value.width, clientHeight: value.height,
  })) Object.defineProperty(element, key, { configurable: true, value: value[key] ?? initial });
  return value;
}

function fixture(t, startDrag = () => {}) {
  const dom = new JSDOM(`<section id="panel" data-window-drag="background"><div id="answer"><p>Selectable answer</p></div></section>
    <header id="header" data-window-drag="handle"><h1 id="title">Settings</h1><button id="close">Close</button><a id="link" href="#">Link</a><input id="input"></header>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const panel = doc.getElementById('panel');
  const answer = doc.getElementById('answer');
  const header = doc.getElementById('header');
  box(panel, { clientWidth: 90 });
  const answerBox = box(answer, { x: 20, y: 20, width: 50, height: 60 });
  box(header, { x: 0, y: 120, width: 200, height: 60 });
  const errors = [];
  const controller = createWindowInteraction({ document: doc, startDrag, onError: error => errors.push(error.message) });
  const pointer = (type, target = panel, options = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 30, button: 0, buttons: 1, ...options });
    for (const [key, value] of Object.entries({ pointerId: 1, isPrimary: true, pointerType: 'mouse', ...options })) {
      if (['pointerId', 'isPrimary', 'pointerType'].includes(key)) Object.defineProperty(event, key, { value });
    }
    target.dispatchEvent(event);
    return event;
  };
  t.after(() => { controller.destroy(); dom.window.close(); });
  return { doc, panel, answer, header, answerBox, errors, pointer, controller };
}

test('window dragging requires six pixels, uses one native drag and cancels a released pointer', async t => {
  let calls = 0;
  let complete;
  const f = fixture(t, () => { calls += 1; return new Promise(resolve => { complete = resolve; }); });
  assert.equal(f.pointer('pointerdown').defaultPrevented, true);
  f.pointer('pointermove', f.panel, { clientX: 15 });
  assert.equal(calls, 0);
  f.pointer('pointerup', f.panel, { buttons: 0 });
  f.pointer('pointermove', f.panel, { clientX: 25 });
  assert.equal(calls, 0);
  f.pointer('pointerdown');
  f.pointer('pointermove', f.panel, { clientX: 16 });
  f.pointer('pointermove', f.panel, { clientX: 30 });
  assert.equal(calls, 1);
  assert.equal(f.doc.documentElement.classList.contains('window-dragging'), true);
  complete();
  await tick();
  assert.equal(f.doc.documentElement.classList.contains('window-dragging'), false);
});

test('controls, answer text, scrollbar gutters, selection and non-left pointers never begin a window drag', async t => {
  let calls = 0;
  const f = fixture(t, () => { calls += 1; });
  const attempt = (target, options) => {
    assert.equal(f.pointer('pointerdown', target, options).defaultPrevented, false);
    f.pointer('pointermove', target, { ...options, clientX: (options?.clientX ?? 10) + 20 });
    f.pointer('pointerup', target, { buttons: 0 });
  };
  attempt(f.answer, { clientX: 25 });
  attempt(f.panel, { clientX: 95 });
  for (const id of ['close', 'link', 'input']) attempt(f.doc.getElementById(id), { clientX: 30, clientY: 140 });
  attempt(f.panel, { button: 2, buttons: 2 });
  attempt(f.panel, { isPrimary: false });
  attempt(f.panel, { pointerType: 'touch' });
  attempt(f.panel, { shiftKey: true });
  const range = f.doc.createRange();
  range.selectNodeContents(f.answer);
  f.doc.getSelection().addRange(range);
  attempt(f.panel);
  f.doc.getSelection().removeAllRanges();
  assert.equal(calls, 0);
  const title = f.doc.getElementById('title');
  f.pointer('pointerdown', title, { clientX: 30, clientY: 140 });
  f.pointer('pointermove', title, { clientX: 36, clientY: 140 });
  assert.equal(calls, 1, 'the settings title is an explicit handle');
  await tick();
});

test('native drag hit areas contain only visible blank space and follow scrolled content', t => {
  const f = fixture(t);
  const areas = getBackgroundDragRects(f.panel);
  const hit = (rects, x, y) => rects.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  assert.equal(hit(areas, 10, 30), true);
  assert.equal(hit(areas, 30, 10), true);
  assert.equal(hit(areas, 30, 30), false);
  assert.equal(hit(areas, 95, 30), false, 'the client box excludes the scrollbar gutter');
  f.answerBox.y = -30;
  f.answerBox.height = 180;
  const scrolled = getBackgroundDragRects(f.panel);
  assert.equal(hit(scrolled, 30, 10), false, 'scrolled text has occupied the former top padding');
  assert.equal(hit(scrolled, 30, 95), false);
  assert.equal(hit(scrolled, 10, 30), true);
});

test('drag cancellation and native errors release the gesture without unhandled rejection', async t => {
  const f = fixture(t, () => Promise.reject(new Error('Native drag unavailable')));
  f.pointer('pointerdown');
  f.pointer('pointercancel');
  f.pointer('pointermove', f.panel, { clientX: 30 });
  assert.deepEqual(f.errors, []);
  f.pointer('pointerdown');
  f.pointer('pointermove', f.panel, { clientX: 20 });
  await tick();
  assert.deepEqual(f.errors, ['Native drag unavailable']);
  assert.equal(f.doc.documentElement.classList.contains('window-dragging'), false);
  f.controller.destroy();
  f.pointer('pointerdown');
  f.pointer('pointermove', f.panel, { clientX: 20 });
  await tick();
  assert.deepEqual(f.errors, ['Native drag unavailable']);
});


test('zero-layout overlay scrollbars exclude both edges from dragging and supply native hit areas', async t => {
  let calls = 0;
  const f = fixture(t, () => { calls += 1; });
  box(f.panel, { width: 100, height: 100, clientWidth: 100, clientHeight: 100 });
  Object.defineProperties(f.panel, {
    scrollHeight: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 200 },
  });
  f.panel.style.overflow = 'scroll';
  const hit = (rects, x, y) => rects.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  const scrollbarAreas = getScrollbarRects(f.panel);
  const dragAreas = getBackgroundDragRects(f.panel);
  for (const [x, y] of [[98, 15], [15, 98], [98, 98]]) {
    assert.equal(hit(scrollbarAreas, x, y), true, 'native hit testing includes an overlay scrollbar');
    assert.equal(hit(dragAreas, x, y), false, 'the same geometry is excluded from window dragging');
    assert.equal(f.pointer('pointerdown', f.panel, { clientX: x, clientY: y }).defaultPrevented, false);
    f.pointer('pointermove', f.panel, { clientX: x - 90, clientY: y });
    f.pointer('pointerup', f.panel, { buttons: 0 });
  }
  assert.equal(calls, 0);
  assert.equal(hit(dragAreas, 75, 15), true, 'padding outside the gutter remains draggable');
  f.pointer('pointerdown', f.panel, { clientX: 75, clientY: 15 });
  f.pointer('pointermove', f.panel, { clientX: 69, clientY: 15 });
  assert.equal(calls, 1);
  await tick();
  f.panel.style.overflow = 'hidden';
  assert.deepEqual(getScrollbarRects(f.panel), []);
});
