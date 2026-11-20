import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantTransport } from '../src/js/session-transport.js';

class Channel { onmessage = () => {}; }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native transport orders microphone start, PCM packets and microphone stop', async () => {
  const gate = deferred();
  const calls = [];
  const transport = createAssistantTransport({
    Channel,
    async invoke(command, args) {
      if (command === 'assistant_connect') return 1;
      calls.push({ command, args });
      if (args.message?.type === 'mic_start') await gate.promise;
    },
  });
  await transport.connect({});
  const start = transport.send({ type: 'mic_start', broadcast_id: 'broadcast-one' });
  assert.equal(transport.audio(new Uint8Array([1, 2, 3, 4]).buffer, 'microphone', 'broadcast-one'), true);
  const stop = transport.send({ type: 'mic_stop', broadcast_id: 'broadcast-one' });
  await tick();
  assert.deepEqual(calls.map(call => call.args.message?.type || 'pcm'), ['mic_start']);
  gate.resolve();
  await Promise.all([start, stop]);
  assert.deepEqual(calls.map(call => call.args.message?.type || 'pcm'), ['mic_start', 'pcm', 'mic_stop']);
  assert.deepEqual(calls[1].args, { sessionId: 1, source: 'microphone', broadcastId: 'broadcast-one', audio: [1, 2, 3, 4] });
  assert.equal(transport.bufferedAmount, 0);
  await transport.destroy();
});

test('late native connect and stale channel events cannot replace the current session', async () => {
  const connects = [deferred(), deferred()];
  const channels = [];
  const disconnected = [];
  const messages = [];
  const events = [];
  const transport = createAssistantTransport({
    Channel, onEvent: event => events.push(event),
    async invoke(command, args) {
      if (command === 'assistant_connect') {
        channels.push(args.onEvent);
        return connects[channels.length - 1].promise;
      }
      if (command === 'assistant_disconnect') disconnected.push(args.sessionId);
      if (command === 'assistant_send') messages.push(args);
    },
  });
  assert.equal(transport.sessionId, null);
  const first = transport.connect({ model: 'first' });
  const second = transport.connect({ model: 'second' });
  connects[1].resolve(2);
  assert.equal(await second, 2);
  assert.equal(transport.sessionId, 2);
  channels[0].onmessage({ type: 'old' });
  channels[1].onmessage({ type: 'current' });
  connects[0].resolve(1);
  assert.equal(await first, null);
  await transport.send({ type: 'agent_task', task: 'current' });
  assert.deepEqual(disconnected, [1]);
  assert.deepEqual(events, [{ type: 'current' }]);
  assert.equal(messages[0].sessionId, 2);
  await transport.destroy();
  channels[1].onmessage({ type: 'after-destroy' });
  assert.equal(events.length, 1);
  assert.deepEqual(disconnected, [1, 2]);
  assert.equal(transport.sessionId, null);
});

test('audio backpressure bounds memory and reports failure without an unhandled rejection', async () => {
  const gate = deferred();
  const errors = [];
  const transport = createAssistantTransport({
    Channel, onError: error => errors.push(error.message),
    async invoke(command) {
      if (command === 'assistant_connect') return 1;
      if (command === 'assistant_audio') await gate.promise;
    },
  });
  await transport.connect({});
  for (let packet = 0; packet < 25; packet++) assert.equal(transport.audio(new ArrayBuffer(9600), 'system', 'broadcast-current'), true);
  assert.equal(transport.bufferedAmount, 240_000);
  assert.equal(transport.audio(new ArrayBuffer(9600), 'system', 'broadcast-current'), false);
  assert.equal(errors.length, 1);
  await transport.disconnect();
  gate.resolve();
  await tick();
  assert.equal(transport.bufferedAmount, 0);
  assert.equal(transport.audio(new ArrayBuffer(4800), 'system', 'broadcast-current'), false);
});

test('a rejected command does not wedge later commands and queued old input is discarded', async () => {
  const gate = deferred();
  const sent = [];
  const transport = createAssistantTransport({
    Channel,
    async invoke(command, args) {
      if (command === 'assistant_connect') return 1;
      if (command !== 'assistant_send') return;
      sent.push(args.message.type);
      if (args.message.type === 'bad') throw new Error('rejected');
      if (args.message.type === 'blocked') await gate.promise;
    },
  });
  await transport.connect({});
  await assert.rejects(transport.send({ type: 'bad' }), /rejected/);
  assert.equal(await transport.send({ type: 'good' }), true);
  const active = transport.send({ type: 'blocked' });
  const queued = transport.send({ type: 'stale' });
  await tick();
  await transport.disconnect();
  gate.resolve();
  await active;
  assert.equal(await queued, false);
  assert.deepEqual(sent, ['bad', 'good', 'blocked']);
  await assert.rejects(transport.send({ type: 'closed' }), /закрыто/);
});

test('unbound or malformed audio never reaches native IPC', async () => {
  const calls = [];
  const transport = createAssistantTransport({
    Channel,
    async invoke(name, args) {
      if (name === 'assistant_connect') return 17;
      calls.push({ name, args });
    },
  });
  await transport.connect({});
  const pcm = new ArrayBuffer(4);
  for (const id of [null, undefined, '', 'x'.repeat(81), 42]) assert.equal(transport.audio(pcm, 'microphone', id), false);
  assert.equal(transport.audio(pcm, 'unknown', 'current'), false);
  assert.equal(transport.bufferedAmount, 0);
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(transport.audio(pcm, 'system', 'current'), true);
  await tick();
  assert.deepEqual(calls, [{ name: 'assistant_audio', args: { sessionId: 17, source: 'system', broadcastId: 'current', audio: [0, 0, 0, 0] } }]);
  await transport.destroy();
});
