import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createActionToast } from '../src/js/action-toast.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const initialTheme = { panelColor: '#102030', textColor: '#E1E2E3', accentColor: '#C0392B', opacity: 24, fontSize: 17 };

function fixture(t, { native = true } = {}) {
  const dom = new JSDOM('<main id="overlay"></main><div id="announcer"></div>', { pretendToBeVisual: true });
  let enabled = true;
  let settings = { ...initialTheme, actionNotifications: true, autoScroll: false };
  const calls = [];
  const handlers = new Map();
  const bridge = { native, async command(name, args) {
    calls.push({ name, args: structuredClone(args) });
    if (handlers.has(name)) return handlers.get(name)(args);
  } };
  const announcer = dom.window.document.querySelector('#announcer');
  const toast = createActionToast({
    announcer, document: dom.window.document, getBridge: () => bridge,
    isEnabled: () => enabled, getTheme: () => settings,
  });
  t.after(() => { toast.destroy(); dom.window.close(); });
  return { dom, toast, calls, handlers, announcer, setEnabled(value) { enabled = value; }, setTheme(patch) { settings = { ...settings, ...patch }; } };
}

test('native notifications forward only the latest queued payload and stay independent of main activity', async t => {
  const f = fixture(t);
  assert.equal(f.toast.show('Obsolete queued message'), true);
  assert.equal(f.toast.show('  Current\n<img src=x onerror=alert(1)>  ', { kind: 'error', timeout: 4500 }), true);
  await turn();
  assert.equal(f.calls.length, 1);
  const payload = f.calls[0];
  assert.equal(payload.name, 'notification_show');
  assert.match(payload.args.notification.id, /^notice-.+/);
  assert.deepEqual({ ...payload.args.notification, id: 'id' }, {
    id: 'id', message: 'Current <img src=x onerror=alert(1)>', kind: 'error', timeout: 4500, theme: initialTheme,
  });
  assert.equal(f.dom.window.document.querySelector('#action-toast'), null);
  f.toast.setVisible(false); // Main minimize / settings focus cannot hide the native popup.
  assert.equal(f.toast.show('While the main panel is inactive'), true);
  await turn();
  assert.equal(f.calls.filter(call => call.name === 'notification_hide').length, 0);
  assert.notEqual(f.calls[1].args.notification.id, payload.args.notification.id);
  f.setTheme({ opacity: 0, fontSize: 19 });
  f.toast.updateTheme();
  await turn();
  assert.deepEqual(f.calls.at(-1), { name: 'notification_theme', args: { theme: { ...initialTheme, opacity: 0, fontSize: 19 } } });
});

test('turning notifications off discards queued shows and a failed command cannot revive them or block later messages', async t => {
  const f = fixture(t);
  let rejectFirst;
  f.handlers.set('notification_show', () => new Promise((_, reject) => { rejectFirst = reject; }));
  f.toast.show('In-flight message');
  await turn();
  f.toast.show('Queued replacement');
  f.setEnabled(false);
  f.toast.dismiss();
  assert.equal(f.toast.show('Disabled message'), false);
  rejectFirst(new Error('Fixture native rejection'));
  await turn();
  assert.deepEqual(f.calls.map(call => call.name), ['notification_show', 'notification_hide']);
  assert.deepEqual(f.calls.at(-1).args, {});
  f.handlers.delete('notification_show');
  f.setEnabled(true);
  assert.equal(f.toast.show('Fresh message after recovery'), true);
  await turn();
  assert.equal(f.calls.at(-1).args.notification.message, 'Fresh message after recovery');
  f.toast.destroy();
  await turn();
  assert.equal(f.calls.at(-1).name, 'notification_hide');
  assert.equal(f.toast.show('After destroy'), false);
});

test('browser preview places its plain-text notification outside the overlay without native commands', async t => {
  const f = fixture(t, { native: false });
  assert.equal(f.toast.show('Preview <b>text</b>'), true);
  await turn();
  const card = f.dom.window.document.querySelector('#action-toast');
  assert.ok(card);
  assert.equal(card.parentElement, f.dom.window.document.body);
  assert.equal(card.closest('#overlay'), null);
  assert.equal(card.querySelector('b'), null);
  assert.equal(card.textContent, 'Preview <b>text</b>');
  assert.deepEqual(f.calls, []);
  f.toast.destroy();
  assert.equal(f.dom.window.document.querySelector('#action-toast'), null);
});
