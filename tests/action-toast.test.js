import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionToast } from '../src/js/action-toast.js';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = new JSDOM('<main id="overlay"><div id="toast" hidden><span class="action-toast-message"></span></div><footer id="toolbar"></footer></main><div id="announcer"></div>');
  const doc = dom.window.document;
  const overlay = doc.querySelector('#overlay');
  const toolbar = doc.querySelector('#toolbar');
  const element = doc.querySelector('#toast');
  const announcer = doc.querySelector('#announcer');
  overlay.getBoundingClientRect = () => ({ height: 200 });
  toolbar.getBoundingClientRect = () => ({ height: 88 });
  let enabled = true;
  let disconnects = 0;
  dom.window.ResizeObserver = class {
    observe() {}
    disconnect() { disconnects++; }
  };
  const toast = createActionToast({ element, overlay, toolbar, announcer, isEnabled: () => enabled });
  t.after(() => { toast.destroy(); dom.window.close(); });
  return { element, announcer, toast, setEnabled(value) { enabled = value; }, disconnects: () => disconnects };
}

test('a newer action message keeps its own deadline and renders model text as plain text', t => {
  const f = fixture(t);
  assert.equal(f.toast.show('First action'), true);
  t.mock.timers.tick(2000);
  assert.equal(f.toast.show('  Finished\n<img src=x onerror=alert(1)>  ', { kind: 'farewell', timeout: 4500 }), true);
  assert.equal(f.element.querySelector('.action-toast-message').textContent, 'Finished <img src=x onerror=alert(1)>');
  assert.equal(f.element.querySelector('img'), null);
  assert.equal(f.element.style.bottom, '94px');
  assert.equal(f.element.dataset.kind, 'farewell');
  t.mock.timers.tick(800); // The first message's old deadline must not hide its replacement.
  assert.equal(f.element.hidden, false);
  t.mock.timers.tick(3699);
  assert.equal(f.element.hidden, false);
  t.mock.timers.tick(1);
  assert.equal(f.element.hidden, true);
  assert.equal(f.element.dataset.visible, 'false');
});

test('disabled, hidden and destroyed notifications never revive a dismissed message', t => {
  const f = fixture(t);
  f.toast.show('Pending action');
  f.setEnabled(false);
  f.toast.dismiss();
  assert.equal(f.toast.show('Disabled action'), false);
  t.mock.timers.tick(5000);
  assert.equal(f.element.hidden, true);
  assert.equal(f.announcer.textContent, 'Pending action');
  f.setEnabled(true);
  f.toast.setVisible(false);
  assert.equal(f.toast.show('Hidden action'), false);
  f.toast.setVisible(true);
  assert.equal(f.element.hidden, true);
  assert.equal(f.toast.show('Fresh action'), true);
  f.toast.destroy();
  assert.equal(f.element.hidden, true);
  assert.equal(f.toast.show('After destroy'), false);
  assert.equal(f.disconnects(), 1);
  t.mock.timers.tick(10000);
  assert.equal(f.element.hidden, true);
});
