import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createToolbarAudioIndicator } from '../src/js/microphone-meter.js';

function fixture(t) {
  const dom = new JSDOM(readFileSync(new URL('../src/index.html', import.meta.url), 'utf8'), { pretendToBeVisual: true });
  const document = dom.window.document;
  const toolbar = document.querySelector('#toolbar');
  const display = createToolbarAudioIndicator(toolbar);
  const sides = [...toolbar.querySelectorAll('[data-toolbar-audio]')];
  t.after(() => { display.destroy(); dom.window.close(); });
  return { dom, document, display, sides };
}
const frame = (patch = {}) => ({
  active: true, at: Date.now(), rawRms: .1, inputPeak: .4, waveform: [0, .4, -.2, 0], ...patch,
});
function assertIdle(sides) {
  for (const side of sides) {
    assert.equal(side.dataset.active, 'false');
    assert.equal(Number(side.style.opacity), 0);
    assert.equal(side.querySelector('.toolbar-audio-wave').getAttribute('d'), 'M0 32H480');
    assert.equal(side.querySelector('.toolbar-audio-level').getAttribute('x1'), '240.0');
    assert.equal(side.querySelector('.toolbar-audio-level').getAttribute('x2'), '240.0');
  }
}

test('both decorative toolbar signals follow the same real frame and clear for mute or silence', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const { display, sides } = fixture(t);
  assert.equal(sides.length, 2);
  for (const side of sides) {
    assert.equal(side.getAttribute('aria-hidden'), 'true');
    assert.equal(side.getAttribute('focusable'), 'false');
    assert.equal(side.hasAttribute('data-window-drag-ignore'), true);
  }
  display.update(frame({ inputPeak: 1 }), { microphoneMuted: false });
  const first = sides[0].querySelector('.toolbar-audio-wave').getAttribute('d');
  assert.notEqual(first, 'M0 32H480');
  for (const side of sides) {
    assert.equal(side.dataset.active, 'true');
    assert.equal(side.dataset.clipped, 'true');
    assert.ok(Number(side.style.opacity) > 0 && Number(side.style.opacity) < 1);
    assert.equal(side.querySelector('.toolbar-audio-wave').getAttribute('d'), first);
    assert.ok(Number(side.querySelector('.toolbar-audio-level').getAttribute('x1')) < 240);
    assert.ok(Number(side.querySelector('.toolbar-audio-level').getAttribute('x2')) > 240);
  }
  display.update(frame({ waveform: [0, -.1, .3, 0] }), { microphoneMuted: false });
  assert.notEqual(sides[0].querySelector('.toolbar-audio-wave').getAttribute('d'), first);
  display.update(frame(), { microphoneMuted: true });
  assertIdle(sides);
  display.update(frame({ rawRms: 0, inputPeak: 0, waveform: [0, 0, 0] }), { microphoneMuted: false });
  assertIdle(sides);
  display.update(frame(), { microphoneMuted: true, microphoneTesting: true });
  assert.equal(sides[0].dataset.active, 'true', 'a local test displays its actual captured signal');
});

test('toolbar signals do not invent intermediate frames and expire or hide with their audio source', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2000 });
  const { dom, document, display, sides } = fixture(t);
  const latest = frame();
  display.update(latest, { microphoneMuted: false });
  const path = sides[0].querySelector('.toolbar-audio-wave').getAttribute('d');
  t.mock.timers.tick(300);
  assert.equal(sides[0].querySelector('.toolbar-audio-wave').getAttribute('d'), path);
  t.mock.timers.tick(500);
  assertIdle(sides);
  display.update(latest, { microphoneMuted: false });
  assertIdle(sides);
  display.update(frame(), { microphoneMuted: false });
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assertIdle(sides);
  t.mock.timers.tick(1000);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assertIdle(sides);
  display.destroy();
  display.update(frame(), { microphoneMuted: false });
  assertIdle(sides);
});
