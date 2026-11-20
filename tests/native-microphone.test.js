import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeMicrophone } from '../src/js/native-microphone.js';
import { microphoneLevels } from '../src/js/microphone-levels.js';

class Channel { onmessage = () => {}; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function harness(t, initialSettings = {}) {
  const h = {
    calls: [], events: [], pcm: [], states: [], levels: [], options: [], errors: [], preferences: [],
    devices: [{ id: 'input-a', name: 'Built-in', is_default: true }, { id: 'input-b', name: 'USB', is_default: false }],
    ready: true, sessions: new Map(), activeId: null, nextId: 1, failStart: false, inventoryError: false,
    startGate: null, tail: false, earlyPcm: false, micStartGate: null,
  };
  h.emit = (id, value) => h.sessions.get(id).onEvent.onmessage({ capture_id: id, ...value });
  const invoke = async (command, args = {}) => {
    h.calls.push({ command, args });
    if (command === 'audio_input_state') {
      if (h.inventoryError) throw new Error('inventory unavailable');
      return { devices: h.devices, available: h.devices.length > 0 };
    }
    if (command === 'audio_start') {
      if (h.failStart) throw new Error('Cannot open selected device');
      const id = h.nextId++;
      h.sessions.set(id, args);
      if (!h.deferStarted) h.emit(id, { type: 'started', device_id: args.deviceId || 'input-a', device_name: 'Fixture microphone' });
      if (h.earlyPcm) h.emit(id, { type: 'pcm', data: [1, 0, 2, 0] });
      if (h.startGate) await h.startGate.promise;
      if (h.activeId !== null) h.emit(h.activeId, { type: 'stopped', reason: 'replaced' });
      h.activeId = id;
      return id;
    }
    if (command === 'audio_set_noise_suppression') {
      if (h.failNoise) throw new Error('DSP update rejected');
      h.sessions.get(args.captureId).noiseSuppression = args.enabled;
      return;
    }
    if (command === 'audio_stop') {
      if (h.sessions.has(args.captureId)) {
        if (h.tail && h.sessions.get(args.captureId).mode === 'stream') h.emit(args.captureId, { type: 'pcm', data: [3, 0] });
        h.emit(args.captureId, { type: 'stopped', reason: 'stopped' });
      }
      if (h.activeId === args.captureId) h.activeId = null;
    }
  };
  h.mic = createNativeMicrophone({
    nativeAudio: { invoke, Channel }, initialSettings, isReady: () => h.ready,
    async sendEvent(type) {
      h.events.push(type);
      if (type === 'mic_start' && h.micStartGate) await h.micStartGate.promise;
      return true;
    },
    sendAudio(buffer) { h.pcm.push([...new Uint8Array(buffer)]); h.events.push('pcm'); return true; },
    onState: state => h.states.push(state), onDevices: (devices, selected) => h.options.push({ devices, selected }),
    onLevels: value => h.levels.push(value), onError: error => h.errors.push(error),
    onSettings: value => h.preferences.push(value),
  });
  h.state = () => h.states.at(-1);
  t.after(() => h.mic.destroy());
  return h;
}

test('device enumeration needs no WebView permission and inventory errors do not reject startup', async t => {
  const h = harness(t);
  await h.mic.refresh();
  assert.equal(h.state().audioAvailable, true);
  assert.equal(h.options.at(-1).devices[0].label, 'Системный · Built-in');
  assert.equal(h.calls.some(call => call.command === 'audio_start'), false);
  h.inventoryError = true;
  await assert.doesNotReject(h.mic.refresh());
  assert.equal(h.state().audioAvailable, false);
  assert.match(h.state().microphoneError, /inventory unavailable/);
  assert.deepEqual(h.errors, []);
});

test('local test emits levels, never sends PCM or mic commands, and survives a remote disconnect', async t => {
  const h = harness(t);
  h.ready = false;
  await h.mic.refresh();
  await h.mic.startTest();
  const id = h.activeId;
  assert.equal(h.state().microphoneTesting, true);
  assert.equal(h.state().microphoneMuted, true);
  assert.ok(h.state().microphoneTestRemaining <= 20);
  h.emit(id, { type: 'levels', rms: .1, raw_rms: .3, input_peak: .9, waveform: [-.2, 0, .4] });
  h.emit(id, { type: 'pcm', data: [1, 0, 2, 0] });
  assert.equal(h.levels.at(-1).testing, true);
  assert.equal(h.levels.at(-1).rawRms, .3);
  assert.deepEqual(h.levels.at(-1).waveform, [-.2, 0, .4]);
  await h.mic.stop(false);
  assert.equal(h.mic.testing, true);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.pcm, []);
  await h.mic.stopTest();
  assert.equal(h.mic.testing, false);
  assert.equal(h.levels.at(-1).active, false);
});

test('closing the local check while native start is pending cancels and disposes the late capture', async t => {
  const h = harness(t);
  await h.mic.refresh();
  h.startGate = deferred();
  const start = h.mic.startTest();
  await tick();
  await h.mic.stopTest();
  h.startGate.resolve();
  assert.equal(await start, false);
  assert.equal(h.mic.testing, false);
  assert.equal(h.activeId, null);
  assert.equal(h.state().microphoneBusy, false);
  assert.deepEqual(h.events, []);
});

test('early PCM waits for mic_start and normal stop preserves the final PCM before mic_stop', async t => {
  const h = harness(t);
  await h.mic.refresh();
  h.earlyPcm = true;
  h.tail = true;
  await h.mic.start();
  assert.deepEqual(h.events, ['mic_start', 'pcm']);
  await h.mic.stop(true);
  assert.deepEqual(h.events, ['mic_start', 'pcm', 'pcm', 'mic_stop']);
  assert.deepEqual(h.pcm, [[1, 0, 2, 0], [3, 0]]);
  assert.equal(h.mic.active, false);
});

test('hot swap and denoiser changes keep one remote microphone interval; failed swap preserves previous capture', async t => {
  const h = harness(t);
  await h.mic.refresh();
  await h.mic.start();
  const oldId = h.activeId;
  await h.mic.select('input-b');
  assert.equal(h.state().microphoneDevice, 'input-b');
  assert.deepEqual(h.events, ['mic_start']);
  h.emit(oldId, { type: 'levels', rms: 1 });
  assert.notEqual(h.levels.at(-1).rms, 1);
  const startsBeforeNoise = h.calls.filter(call => call.command === 'audio_start').length;
  await h.mic.setNoiseSuppression(true);
  assert.equal(h.calls.filter(call => call.command === 'audio_start').length, startsBeforeNoise);
  assert.deepEqual(h.calls.filter(call => call.command === 'audio_set_noise_suppression').at(-1).args,
    { captureId: h.activeId, enabled: true });
  assert.equal(h.state().microphoneNoiseSuppression, true);
  h.failStart = true;
  const workingId = h.activeId;
  await assert.rejects(h.mic.select('input-a'), /Cannot open/);
  assert.equal(h.activeId, workingId);
  assert.equal(h.mic.active, true);
  assert.equal(h.state().microphoneDevice, 'input-b');
  assert.deepEqual(h.events, ['mic_start']);
});

test('an unplugged explicitly selected microphone remains selected and never falls back silently', async t => {
  const h = harness(t, { deviceId: 'input-b', noiseSuppression: false });
  await h.mic.refresh();
  await h.mic.start();
  const starts = h.calls.filter(call => call.command === 'audio_start').length;
  h.devices = h.devices.filter(device => device.id !== 'input-b');
  await h.mic.refresh();
  assert.equal(h.mic.active, false);
  assert.equal(h.state().microphoneDevice, 'input-b');
  assert.equal(h.state().audioAvailable, false);
  assert.match(h.state().microphoneError, /отключён/);
  assert.equal(h.calls.filter(call => call.command === 'audio_start').length, starts);
  assert.equal(h.options.at(-1).devices.at(-1).unavailable, true);
});

test('signal normalization clamps invalid data and preserves signed real waveform samples', () => {
  const raw = { rms: NaN, raw_rms: .2, peak: Infinity, input_peak: 2, clipped_ratio: -1, waveform: [-3, -.5, 0, .5, 3, NaN] };
  const level = microphoneLevels(raw, { active: true, testing: true, at: 42 });
  assert.deepEqual(level.waveform, [-1, -.5, 0, .5, 1, 0]);
  assert.equal(level.rms, 0);
  assert.equal(level.rawRms, .2);
  assert.equal(level.inputPeak, 1);
  assert.equal(level.peak, 0);
  assert.equal(level.clippedRatio, 0);
  assert.equal(level.at, 42);
  assert.ok(Number.isNaN(raw.waveform.at(-1)));
});

test('a failed system-default hot swap preserves inventory availability and the running microphone', async t => {
  const h = harness(t);
  await h.mic.refresh();
  await h.mic.start();
  const previous = h.activeId;
  h.devices = h.devices.map(device => ({ ...device, is_default: device.id === 'input-b' }));
  h.failStart = true;
  await h.mic.refresh({ checkDefault: true });
  assert.equal(h.activeId, previous);
  assert.equal(h.state().audioAvailable, true);
  assert.equal(h.mic.active, true);
  assert.match(h.state().microphoneError, /Cannot open selected device/);
  assert.doesNotMatch(h.state().microphoneStatus, /Список/);
});

test('system default and its explicit endpoint share a capture while noise changes only native DSP', async t => {
  const h = harness(t);
  await h.mic.refresh();
  await h.mic.startTest();
  const id = h.activeId;
  await h.mic.select('input-a');
  assert.equal(h.state().microphoneDevice, 'input-a');
  assert.equal(h.activeId, id);
  assert.equal(h.calls.filter(call => call.command === 'audio_start').length, 1);
  await h.mic.setNoiseSuppression(true);
  await h.mic.select('');
  assert.equal(h.activeId, id);
  assert.equal(h.calls.filter(call => call.command === 'audio_start').length, 1);
  assert.equal(h.state().microphoneNoiseSuppression, true);
  assert.deepEqual(h.events, []);
  h.failNoise = true;
  await assert.rejects(h.mic.setNoiseSuppression(false), /DSP update rejected/);
  assert.equal(h.state().microphoneNoiseSuppression, true);
  assert.equal(h.mic.testing, true);
  assert.equal(h.activeId, id);
});

test('a capture failure stays visible after successful automatic inventory refresh until a user configuration succeeds', async t => {
  const h = harness(t);
  await h.mic.refresh();
  await h.mic.startTest();
  h.emit(h.activeId, { type: 'stopped', reason: 'device_lost', error: 'Hardware stream failed' });
  await tick();
  await h.mic.refresh();
  assert.equal(h.mic.testing, false);
  assert.equal(h.state().audioAvailable, true);
  assert.equal(h.state().microphoneError, 'Hardware stream failed');
  assert.equal(h.state().microphoneStatus, 'Проверка прервана');
  await h.mic.setNoiseSuppression(true);
  assert.equal(h.state().microphoneError, '');
});


test('noise toggling before Started updates DSP without reopening hardware', async t => {
  const h = harness(t);
  h.deferStarted = true;
  await h.mic.refresh();
  await h.mic.startTest();
  const id = h.activeId;
  await h.mic.setNoiseSuppression(true);
  assert.equal(h.activeId, id);
  assert.equal(h.calls.filter(call => call.command === 'audio_start').length, 1);
  assert.deepEqual(h.calls.filter(call => call.command === 'audio_set_noise_suppression').at(-1).args,
    { captureId: id, enabled: true });
  assert.equal(h.state().microphoneNoiseSuppression, true);
  await assert.rejects(h.mic.select('input-a'), /определения активного микрофона/);
  assert.equal(h.state().microphoneDevice, '');
  assert.equal(h.calls.filter(call => call.command === 'audio_start').length, 1);
  h.emit(id, { type: 'started', device_id: 'input-a', device_name: 'Fixture microphone' });
  await h.mic.select('input-a');
  assert.equal(h.state().microphoneDevice, 'input-a');
  assert.equal(h.activeId, id);
  assert.equal(h.calls.filter(call => call.command === 'audio_start').length, 1);
});
