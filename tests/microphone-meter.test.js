import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { audioLevelView, createMicrophoneMeter, createMicrophoneIndicator } from '../src/js/microphone-meter.js';

test('meters hold clipping briefly, expire frozen samples and clean up when hidden or destroyed', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const dom = new JSDOM('<div id="host"><div id="mic-monitor"><div id="mic-level"><span id="mic-level-fill"></span></div><output id="mic-level-value"></output><span id="mic-level-label"></span><svg><path id="mic-wave-path"></path></svg></div></div><button id="mic"></button>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const meter = createMicrophoneMeter(document.querySelector('#host'));
  const button = document.querySelector('#mic');
  const indicator = createMicrophoneIndicator(button);
  t.after(() => { meter.destroy(); indicator.destroy(); dom.window.close(); });
  const panel = document.querySelector('#mic-monitor');
  const label = document.querySelector('#mic-level-label');
  const runtime = { microphoneMuted: false };
  let latest;
  function signal(peak = .5) {
    latest = { active: true, at: Date.now(), rawRms: .125, inputPeak: peak, waveform: [0, .4, -.2, 0] };
    meter.update(latest, runtime);
    indicator.update(latest, runtime);
  }

  signal(1);
  assert.equal(panel.dataset.clipped, 'true');
  t.mock.timers.tick(200);
  signal();
  assert.equal(button.dataset.audioClipped, 'true');
  t.mock.timers.tick(299);
  assert.equal(panel.dataset.clipped, 'true');
  t.mock.timers.tick(1);
  assert.equal(panel.dataset.clipped, 'false');
  assert.equal(button.dataset.audioClipped, 'false');
  t.mock.timers.tick(499);
  assert.equal(panel.dataset.active, 'true');
  t.mock.timers.tick(1);
  assert.equal(panel.dataset.active, 'false');
  assert.equal(button.dataset.audioActive, 'false');
  assert.equal(label.textContent, 'Нет сигнала');
  assert.equal(document.querySelector('#mic-level').getAttribute('aria-valuenow'), '-60');
  assert.equal(document.querySelector('#mic-wave-path').getAttribute('d'), 'M0 32H480');
  meter.update(latest, runtime); // Lifecycle refresh must not revive an old frame.
  assert.equal(panel.dataset.active, 'false');

  signal();
  meter.setVisible(false);
  label.textContent = 'hidden';
  t.mock.timers.tick(1000);
  assert.equal(label.textContent, 'hidden');
  meter.setVisible(true);
  assert.equal(label.textContent, 'Нет сигнала');

  signal(1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(panel.dataset.active, 'false');
  assert.equal(button.dataset.audioActive, 'false');
  label.textContent = 'background';
  t.mock.timers.tick(1000);
  assert.equal(label.textContent, 'background');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(label.textContent, 'Нет сигнала');
  signal();
  meter.destroy();
  indicator.destroy();
  label.textContent = 'destroyed';
  button.dataset.audioActive = 'destroyed';
  t.mock.timers.tick(1000);
  assert.equal(label.textContent, 'destroyed');
  assert.equal(button.dataset.audioActive, 'destroyed');
});

test('quiet speech keeps its raw dB level while its real waveform is readable; ambient noise stays small', () => {
  const samples = view => [...view.path.matchAll(/[ML][\d.]+ (-?[\d.]+)/g)].map(match => Number(match[1]));
  const speech = audioLevelView({
    active: true, at: 1000, rawRms: .02, inputPeak: .05, waveform: [0, .05, -.025, 0],
  }, true, 1000);
  const speechY = samples(speech);
  assert.equal(speech.db, -34);
  assert.equal(speech.clipped, false);
  assert.equal(speech.label, 'Входящий звук');
  assert.equal(speechY[0], 32);
  assert.equal(speechY[3], 32);
  assert.ok(32 - speechY[1] > 10); // Speech was only 1.4 pixels at a fixed unity scale.
  assert.ok(Math.abs((32 - speechY[1]) / (speechY[2] - 32) - 2) < .02); // Preserve sample shape and sign.
  const ambient = audioLevelView({
    active: true, at: 1000, rawRms: .001, inputPeak: .002, waveform: [0, .002, -.002, 0],
  }, true, 1000);
  assert.equal(ambient.label, 'Тишина');
  assert.ok(samples(ambient).every(y => Math.abs(y - 32) <= .11));
  const faint = audioLevelView({
    active: true, at: 1000, rawRms: .005, inputPeak: .006, waveform: [0, .006, -.006, 0],
  }, true, 1000);
  assert.ok(samples(faint).every(y => Math.abs(y - 32) <= 2.8)); // Gain remains capped for a very quiet frame.
  const silence = audioLevelView({ active: true, at: 1000, rawRms: 0, waveform: [0, 0, 0] }, true, 1000);
  assert.ok(samples(silence).every(y => y === 32));
});
