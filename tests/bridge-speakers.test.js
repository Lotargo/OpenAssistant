import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/js/bridge.js';

async function fixture(t, scenario = 'interview') {
  const previous = new Map(['window', 'isTauri'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const callbacks = new Map();
  const sessions = new Map();
  const captures = new Map();
  const values = new Map([['agent', { scenario, workspace_mode: 'temporary', realtime: true }]]);
  const calls = [];
  const messages = [];
  let nextCallback = 1, nextSession = 1, nextCapture = 1;
  function emit(owner, message) { callbacks.get(owner.channel.id)?.({ message, index: owner.index++ }); }
  async function invoke(name, args = {}) {
    calls.push(name);
    switch (name) {
      case 'plugin:store|load': return 1;
      case 'plugin:store|get': return [values.get(args.key) ?? null, values.has(args.key)];
      case 'plugin:store|set': values.set(args.key, structuredClone(args.value)); return null;
      case 'plugin:store|save': return null;
      case 'plugin:event|listen': return args.handler;
      case 'plugin:event|unlisten': return null;
      case 'get_window_activity': return { active: true };
      case 'get_runtime_state': case 'sync_audio_state':
        return { revision: 1, nativeWindow: true, platform: 'windows', settingsOpen: false };
      case 'assistant_status': return { codex_available: true, oauth: 'available', mode: 'real' };
      case 'assistant_models': return { models: [{ id: 'fixture', is_default: true, reasoning_efforts: ['medium'] }] };
      case 'assistant_workspace_state': return null;
      case 'audio_input_state': case 'system_audio_state':
        return { available: true, devices: [{ id: name, name: 'Fixture only', is_default: true }] };
      case 'assistant_connect': {
        const id = nextSession++;
        const owner = { channel: args.onEvent, index: 0 };
        sessions.set(id, owner);
        queueMicrotask(() => {
          emit(owner, { type: 'interview_state', stage: 'idle' });
          emit(owner, { type: 'speaker_state', status: 'loading', detail: 'Starting local grouping' });
          emit(owner, { type: 'agent_state', stage: 'ready', detail: 'Ready' });
          emit(owner, { type: 'status', stage: 'ready', realtime: true });
        });
        return id;
      }
      case 'assistant_send': messages.push(args.message); return null;
      case 'assistant_audio': throw new Error('Speaker metadata tests must never send PCM');
      case 'assistant_disconnect': return null;
      case 'audio_start': case 'system_audio_start': {
        const id = nextCapture++;
        const owner = { channel: args.onEvent, index: 0 };
        captures.set(id, owner);
        queueMicrotask(() => emit(owner, { type: 'started', capture_id: id, device_id: name, device_name: 'Fixture only' }));
        return id;
      }
      case 'audio_stop': case 'system_audio_stop':
        emit(captures.get(args.captureId), { type: 'stopped', capture_id: args.captureId, reason: 'stopped' });
        return null;
      default: throw new Error('Unexpected fixture command: ' + name);
    }
  }
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, writable: true, value: true });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback, once = false) {
        const id = nextCallback++;
        callbacks.set(id, value => { if (once) callbacks.delete(id); callback(value); });
        return id;
      },
      unregisterCallback: id => callbacks.delete(id),
      invoke,
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event, id) => callbacks.delete(id) },
  } });
  let bridge;
  t.after(async () => {
    await bridge?.destroy();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  bridge = await createBridge();
  return {
    bridge, calls, messages,
    emit: event => emit([...sessions.values()].at(-1), event),
    state: () => bridge.getRuntimeState(),
  };
}

test('speaker attribution updates only matching remote history and the current label only for the latest utterance', async t => {
  const f = await fixture(t);
  await f.bridge.command('start_interview');
  assert.equal(f.state().interviewState.stage, 'listening');
  assert.equal(f.state().speakerState.status, 'loading');
  f.emit({ type: 'transcript', utterance_id: 10, source: 'system', text: 'Earlier remote question' });
  f.emit({ type: 'transcript', utterance_id: 11, source: 'microphone', text: 'My reply' });
  f.emit({ type: 'speaker_attribution', utterance_id: 10, speaker: 'remote-a', speaker_label: 'Участник A' });
  assert.equal(f.state().transcriptHistory[0].speaker_label, 'Участник A');
  assert.equal(f.state().transcript, 'Мой микрофон: My reply');
  assert.equal(f.state().interviewState.speaker_label, 'Мой микрофон');
  f.emit({ type: 'transcript', utterance_id: 12, source: 'system', text: 'Latest remote question' });
  f.emit({ type: 'speaker_attribution', utterance_id: 12, speaker: 'remote-b', speaker_label: 'Участник B' });
  assert.equal(f.state().transcript, 'Участник B: Latest remote question');
  assert.equal(f.state().interviewState.speaker_label, 'Участник B');
  assert.equal(f.state().transcriptHistory.at(-1).speaker, 'remote-b');
  f.emit({ type: 'speaker_attribution', utterance_id: 11, speaker_label: 'Must not rename microphone' });
  f.emit({ type: 'speaker_attribution', utterance_id: '12', speaker_label: 'Invalid ID' });
  f.emit({ type: 'speaker_attribution', utterance_id: 99, speaker_label: 'Unknown ID' });
  assert.equal(f.state().transcriptHistory[1].speaker_label, 'Мой микрофон');
  assert.equal(f.state().transcriptHistory.length, 3);
  assert.equal(f.state().interviewState.speaker_label, 'Участник B');
});

test('explicit interview stop clears context and late same-channel events cannot revive listening or speaker state', async t => {
  const f = await fixture(t);
  await f.bridge.command('start_interview');
  f.emit({ type: 'transcript', utterance_id: 21, source: 'system', text: 'A meeting question' });
  f.emit({ type: 'speaker_state', status: 'ready', detail: 'Grouping ready' });
  await f.bridge.command('stop_interview');
  assert.equal(f.state().transcript, '');
  assert.deepEqual(f.state().transcriptHistory, []);
  assert.equal(f.state().speakerState.status, 'idle');
  const connects = f.calls.filter(name => name === 'assistant_connect').length;
  f.emit({ type: 'transcript', utterance_id: 22, source: 'system', text: 'Queued before stop' });
  f.emit({ type: 'speaker_attribution', utterance_id: 21, speaker_label: 'Old speaker' });
  f.emit({ type: 'speaker_state', status: 'ready', detail: 'Queued ready event' });
  f.emit({ type: 'interview_state', stage: 'listening', detail: 'Queued active event' });
  assert.equal(f.state().interviewState.stage, 'idle');
  assert.equal(f.state().transcript, '');
  assert.deepEqual(f.state().transcriptHistory, []);
  assert.equal(f.state().speakerState.status, 'idle');
  f.emit({ type: 'interview_state', stage: 'error', detail: 'A useful failure status' });
  assert.equal(f.state().interviewState.stage, 'error');
  f.emit({ type: 'interview_state', stage: 'idle' });
  await f.bridge.command('start_interview');
  f.emit({ type: 'speaker_state', status: 'loading', detail: 'Restarting grouping' });
  f.emit({ type: 'transcript', utterance_id: 23, source: 'system', text: 'A new meeting turn' });
  assert.equal(f.state().speakerState.status, 'loading');
  assert.equal(f.state().transcriptHistory.at(-1).utterance_id, 23);
  assert.equal(f.calls.filter(name => name === 'assistant_connect').length, connects);
});

test('ordinary assistant transcripts remain available without interview listening intent', async t => {
  const f = await fixture(t, 'assistant');
  await f.bridge.command('reconnect_session');
  f.emit({ type: 'transcript', text: 'Ordinary dictation', source: 'microphone' });
  assert.equal(f.state().transcript, 'Ordinary dictation');
  assert.equal(f.state().transcriptHistory.length, 1);
});
