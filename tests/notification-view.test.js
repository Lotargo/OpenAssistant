import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createNotificationView } from '../src/js/notification-view.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const notice = (id, patch = {}) => ({ id, message: id, kind: 'info', timeout: 1000, theme: { opacity: 50 }, ...patch });

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = new JSDOM('<div id="card" hidden><span id="message"></span></div>', { pretendToBeVisual: true });
  const element = dom.window.document.querySelector('#card');
  const text = dom.window.document.querySelector('#message');
  const frames = new Map();
  let nextFrame = 1;
  dom.window.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
  dom.window.cancelAnimationFrame = id => frames.delete(id);
  const presentations = [], dismissals = [], themes = [];
  const view = createNotificationView({
    element, text, measure: () => 112, reducedMotion: () => false,
    applyTheme: theme => themes.push(structuredClone(theme)),
    onPresent: async args => { presentations.push(args); return { shown: true, width: 360, height: args.height }; },
    onDismissed: async args => { dismissals.push(args); },
    ...options,
  });
  t.after(() => { view.destroy(); dom.window.close(); });
  return { view, element, text, presentations, dismissals, themes,
    frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); },
    frameCount: () => frames.size,
  };
}

test('replacement uses its own deadline, theme changes do not extend it and message markup stays inert', async t => {
  const f = fixture(t);
  await f.view.show(notice('old'));
  f.frame();
  t.mock.timers.tick(700);
  await f.view.show(notice('new', { message: 'Hello <img src=x onerror=alert(1)>', timeout: 2000 }));
  f.frame();
  assert.equal(f.element.dataset.phase, 'visible');
  assert.equal(f.text.querySelector('img'), null);
  assert.equal(f.text.textContent, 'Hello <img src=x onerror=alert(1)>');
  t.mock.timers.tick(300); // Old notice would have expired now.
  assert.equal(f.element.dataset.phase, 'visible');
  await f.view.updateTheme({ opacity: 0 });
  assert.deepEqual(f.themes.at(-1), { opacity: 0 });
  t.mock.timers.tick(1699);
  assert.equal(f.element.dataset.phase, 'visible');
  t.mock.timers.tick(1);
  assert.equal(f.element.dataset.phase, 'exiting');
  assert.equal(f.element.hidden, false);
  t.mock.timers.tick(200);
  await turn();
  assert.equal(f.element.hidden, true);
  assert.equal(f.element.dataset.phase, 'hidden');
  assert.deepEqual(f.dismissals, [{ id: 'new' }]);
});

test('a replacement cancels an older exit and stale hide IDs cannot dismiss the current notification', async t => {
  const f = fixture(t);
  await f.view.show(notice('old'));
  f.frame();
  const oldExit = f.view.hide({ id: 'old' });
  assert.equal(f.element.dataset.phase, 'exiting');
  t.mock.timers.tick(100);
  await f.view.show(notice('current', { timeout: 2000 }));
  f.frame();
  assert.equal(await oldExit, false);
  assert.equal(await f.view.hide({ id: 'old' }), false);
  t.mock.timers.tick(100);
  await turn();
  assert.equal(f.element.dataset.id, 'current');
  assert.equal(f.element.dataset.phase, 'visible');
  assert.equal(f.element.hidden, false);
  assert.deepEqual(f.dismissals, []);
});

test('late present acknowledgements cannot replace the current view and a rejected native present DTO stays hidden', async t => {
  let acknowledgeOld;
  const f = fixture(t, { reducedMotion: () => true, onPresent: args => args.id === 'old'
    ? new Promise(resolve => { acknowledgeOld = resolve; })
    : Promise.resolve({ shown: args.id !== 'rejected', width: 360, height: 112 }) });
  const oldShow = f.view.show(notice('old'));
  await turn();
  await f.view.show(notice('current'));
  f.frame();
  acknowledgeOld({ shown: true, width: 360, height: 112 });
  assert.equal(await oldShow, false);
  assert.equal(f.element.dataset.id, 'current');
  assert.equal(f.element.dataset.phase, 'visible');
  const rejected = f.view.show(notice('rejected'));
  await turn();
  t.mock.timers.tick(0);
  assert.equal(await rejected, false);
  assert.equal(f.element.hidden, true);
  assert.equal(f.element.dataset.phase, 'hidden');
  assert.equal(f.frameCount(), 0);
});

test('destroy while presentation is pending cannot revive a window or leave a frame scheduled', async t => {
  let acknowledge;
  const f = fixture(t, { onPresent: () => new Promise(resolve => { acknowledge = resolve; }) });
  const showing = f.view.show(notice('pending'));
  await turn();
  f.view.destroy();
  acknowledge({ shown: true, width: 360, height: 112 });
  assert.equal(await showing, false);
  f.frame();
  t.mock.timers.tick(30000);
  await turn();
  assert.equal(f.element.hidden, true);
  assert.equal(f.element.dataset.phase, 'hidden');
  assert.equal(f.frameCount(), 0);
  assert.deepEqual(f.dismissals, []);
});
