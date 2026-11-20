import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsWindowHost, createSettingsProxy } from '../src/js/settings-window-bridge.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await turn();
  }
  assert.fail('Expected an IPC event to arrive');
}
function busFixture() {
  const listeners = new Map();
  const records = [];
  const held = [];
  const errors = [];
  let hold = () => false;
  function deliver(packet) {
    queueMicrotask(() => {
      for (const callback of listeners.get(packet.target + ':' + packet.event) || []) {
        try { Promise.resolve(callback({ event: packet.event, payload: structuredClone(packet.payload) })).catch(error => errors.push(error)); }
        catch (error) { errors.push(error); }
      }
    });
  }
  return {
    records, held, errors,
    hold(predicate) { hold = predicate; },
    deliver,
    events(label) {
      return {
        async listen(event, callback) {
          const key = label + ':' + event;
          const set = listeners.get(key) || new Set();
          set.add(callback);
          listeners.set(key, set);
          return () => set.delete(callback);
        },
        async emitTo(target, event, payload) {
          const packet = { source: label, target, event, payload: structuredClone(payload) };
          records.push(packet);
          if (hold(packet)) held.push(packet);
          else deliver(packet);
        },
      };
    },
  };
}
async function ownerFixture() {
  const bus = busFixture();
  let runtime = {
    settingsOpen: false, nativeWindow: true, agentStage: 'ready', agentDetail: 'Initial',
    connectionStatus: 'ready', agentConfig: { workspace: 'F:\\fixture', realtime: true },
    microphoneMuted: true, microphoneTesting: false, microphoneLevels: null,
    approvals: [{ request_id: 'approval-1', title: 'Confirm', choices: ['accept', 'decline'] }],
    inputs: [], tasks: [{ task_id: 'running-1', status: 'running' }],
  };
  let settings = { opacity: 50, fontSize: 15, panelColor: '#202329', textColor: '#FFFFFF' };
  let generation = 7;
  let host;
  const calls = [];
  const changes = [];
  const handlers = new Map();
  const bridge = {
    native: true,
    getRuntimeState: () => structuredClone(runtime),
    getAgentSettings: () => structuredClone(runtime.agentConfig),
    getSessionGeneration: () => generation,
    async setAgentSettings(patch) {
      calls.push({ method: 'setAgentSettings', args: structuredClone(patch) });
      runtime.agentConfig = { ...runtime.agentConfig, ...patch };
      host.refresh();
      return structuredClone(runtime);
    },
    reportError(error) {
      runtime.lastError = String(error);
      host.refresh();
      return runtime.lastError;
    },
    async command(name, args = {}) {
      calls.push({ name, args: structuredClone(args) });
      if (handlers.has(name)) return handlers.get(name)(args);
      if (name === 'set_settings_open') {
        runtime.settingsOpen = Boolean(args.open);
        if (!args.open) runtime.microphoneTesting = false;
      }
      if (name === 'start_microphone_test') runtime.microphoneTesting = true;
      if (name === 'stop_microphone_test') runtime.microphoneTesting = false;
      if (name === 'agent_approval') runtime.approvals = runtime.approvals.filter(item => item.request_id !== args.request_id);
      if (name === 'agent_input') runtime.inputs = runtime.inputs.filter(item => item.request_id !== args.request_id);
      host.refresh();
      return structuredClone(runtime);
    },
    destroy() { calls.push({ name: 'destroy' }); },
  };
  host = await createSettingsWindowHost({
    bridge, getSettings: () => structuredClone(settings),
    onChange: async next => { settings = structuredClone(next); changes.push(settings); host.refresh(); },
    events: bus.events('main'),
  });
  return {
    bus, bridge, calls, changes, handlers,
    get host() { return host; },
    async restart() {
      host.destroy();
      host = await createSettingsWindowHost({
        bridge, getSettings: () => structuredClone(settings),
        onChange: async next => { settings = structuredClone(next); changes.push(settings); host.refresh(); },
        events: bus.events('main'),
      });
    },
    state: () => runtime,
    publish(patch) { runtime = { ...runtime, ...patch }; host.refresh(); },
    setGeneration(next) { generation = next; },
    async proxy(options = {}) {
      return createSettingsProxy({
        events: bus.events('settings'), nativeInvoke: async name => {
          if (name === 'get_window_activity') return { active: true };
          calls.push({ directNative: name });
        },
        readyTimeout: 1000, requestTimeout: 1000, ...options,
      });
    },
  };
}
function cleanup(t, owner, ...proxies) {
  t.after(async () => {
    for (const proxy of proxies) proxy?.destroy();
    await turn();
    owner.host.destroy();
    assert.deepEqual(owner.bus.errors, []);
  });
}

test('opening before the settings view boots replays the exact approval and all actions stay with the main owner', async t => {
  const owner = await ownerFixture();
  await owner.host.open('agent', { kind: 'approval', id: 'approval-1' });
  const opened = [];
  const proxy = await owner.proxy({ onOpen: (...args) => opened.push(args) });
  cleanup(t, owner, proxy);
  assert.equal(proxy.native, true);
  assert.deepEqual(proxy.getOpenRequest().request, { kind: 'approval', id: 'approval-1' });
  assert.deepEqual(opened, [['agent', { kind: 'approval', id: 'approval-1' }]]);
  assert.equal(owner.calls.filter(call => call.name === 'agent_approval').length, 0);
  await proxy.command('agent_approval', { request_id: 'approval-1', decision: 'accept' });
  assert.deepEqual(owner.calls.find(call => call.name === 'agent_approval').args, { request_id: 'approval-1', decision: 'accept' });
  assert.deepEqual(proxy.getRuntimeState().approvals, []);
  await proxy.setAgentSettings({ model: 'fixture-model' });
  assert.equal(proxy.getAgentSettings().model, 'fixture-model');
  const appearance = { ...(await proxy.loadSettings()), opacity: 82 };
  await proxy.saveSettings(appearance);
  assert.deepEqual(owner.changes, [appearance]);
  assert.equal((await proxy.loadSettings()).opacity, 82);
  await assert.rejects(proxy.command('assistant_connect'), /недоступна/);
  assert.equal(owner.calls.some(call => ['assistant_connect', 'audio_start', 'destroy'].includes(call.name)), false);
});

test('a late initial snapshot cannot replace newer state or audio and levels use the lightweight callback', async t => {
  const owner = await ownerFixture();
  await owner.host.open('sources');
  owner.bus.hold(packet => packet.event === 'settings:response');
  const states = [];
  const levels = [];
  const opening = owner.proxy({ onState: state => states.push(state), onAudioLevels: value => levels.push(value) });
  await until(() => owner.bus.held.length === 1);
  owner.publish({ agentDetail: 'Newer state' });
  await until(() => states.some(state => state.agentDetail === 'Newer state'));
  const count = states.length;
  const sample = { active: true, at: Date.now(), rms: .1, waveform: [0, .1, -.1] };
  owner.state().microphoneLevels = sample;
  owner.host.updateAudioLevels(sample);
  await until(() => levels.length === 1);
  assert.equal(states.length, count);
  owner.bus.hold(() => false);
  owner.bus.deliver(owner.bus.held.shift());
  const proxy = await opening;
  cleanup(t, owner, proxy);
  assert.equal(proxy.getRuntimeState().agentDetail, 'Newer state');
  assert.deepEqual(proxy.getRuntimeState().microphoneLevels, sample);
});

test('closing and reloading settings stops only the local check and retains the main session and pending work', async t => {
  const owner = await ownerFixture();
  await owner.host.open('sources');
  let closed = 0;
  const first = await owner.proxy({ onClose: () => closed++ });
  await first.command('start_microphone_test');
  assert.equal(first.getRuntimeState().microphoneTesting, true);
  await owner.host.close();
  await until(() => closed === 1);
  assert.equal(first.getRuntimeState().microphoneTesting, false);
  assert.equal(first.getRuntimeState().tasks[0].status, 'running');
  first.destroy();
  await turn();
  await owner.host.open('agent');
  const second = await owner.proxy();
  cleanup(t, owner, first, second);
  assert.equal(second.getRuntimeState().agentStage, 'ready');
  assert.equal(second.getRuntimeState().tasks[0].task_id, 'running-1');
  assert.equal(owner.calls.some(call => ['disconnect_session', 'assistant_disconnect', 'destroy'].includes(call.name)), false);
  await second.command('start_window_drag');
  assert.equal(owner.calls.at(-1).directNative, 'start_window_drag');
  assert.equal(owner.calls.some(call => call.name === 'start_window_drag'), false);
});

test('side-effect RPC timeout is not retried and disposing the view rejects pending work', async t => {
  const owner = await ownerFixture();
  const proxy = await owner.proxy({ requestTimeout: 20 });
  cleanup(t, owner, proxy);
  let finish;
  owner.handlers.set('agent_task', () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(proxy.command('agent_task', { task: 'A single task' }), /не ответила/);
  assert.equal(owner.calls.filter(call => call.name === 'agent_task').length, 1);
  finish(owner.state());
  await turn();
  let finishSecond;
  owner.handlers.set('agent_task', () => new Promise(resolve => { finishSecond = resolve; }));
  const pending = proxy.command('agent_task', { task: 'Pending on close' });
  const rejected = assert.rejects(pending, /закрыто/);
  await until(() => typeof finishSecond === 'function');
  proxy.destroy();
  await rejected;
  finishSecond(owner.state());
  assert.equal(owner.calls.filter(call => call.name === 'agent_task').length, 2);
});

test('a rejected native close leaves the settings form open and recoverable', async t => {
  const owner = await ownerFixture();
  await owner.host.open('agent', { kind: 'approval', id: 'approval-1' });
  let closes = 0;
  const proxy = await owner.proxy({ onClose: () => closes++ });
  cleanup(t, owner, proxy);
  owner.handlers.set('set_settings_open', () => { throw new Error('Fixture hide rejected'); });
  await assert.rejects(proxy.command('set_settings_open', { open: false }), /hide rejected/);
  assert.equal(proxy.getRuntimeState().settingsOpen, true);
  assert.equal(proxy.getOpenRequest().open, true);
  assert.equal(closes, 0);
  owner.handlers.delete('set_settings_open');
  await proxy.command('set_settings_open', { open: false });
  assert.equal(proxy.getOpenRequest().open, false);
  assert.equal(closes, 1);
});

test('stale approval or input actions cannot cross a session generation even when request IDs are reused', async t => {
  const owner = await ownerFixture();
  await owner.host.open('agent');
  const proxy = await owner.proxy();
  cleanup(t, owner, proxy);
  owner.setGeneration(8); // Deliberately keep the old view snapshot and the same request ID.
  await assert.rejects(proxy.command('agent_approval', { request_id: 'approval-1', decision: 'accept' }), /прежней сессии/);
  assert.equal(owner.calls.some(call => call.name === 'agent_approval'), false);
  owner.publish({ inputs: [{ request_id: 'input-1', questions: [] }] });
  await turn();
  owner.setGeneration(9);
  await assert.rejects(proxy.command('agent_input', { request_id: 'input-1', answers: { q: { answers: ['Yes'] } } }), /прежней сессии/);
  assert.equal(owner.calls.some(call => call.name === 'agent_input'), false);
  await assert.rejects(proxy.command('agent_approval', { request_id: 'already-resolved', decision: 'accept' }), /уже завершён/);
});

test('main owner replacement refreshes the existing view and rejects old calls without replaying them', async t => {
  const owner = await ownerFixture();
  await owner.host.open('agent');
  const proxy = await owner.proxy();
  cleanup(t, owner, proxy);
  owner.bus.hold(packet => packet.event === 'settings:response' && packet.payload.result?.agentStage === 'ready');
  const previous = proxy.command('agent_task', { task: 'Only once' });
  const rejected = assert.rejects(previous, /перезапущена/);
  await until(() => owner.bus.held.length > 0);
  const oldReply = owner.bus.held.shift();
  owner.bus.hold(() => false);
  owner.state().agentDetail = 'Replacement owner';
  await owner.restart();
  await rejected;
  await until(() => proxy.getRuntimeState().agentDetail === 'Replacement owner');
  owner.bus.deliver(oldReply);
  await turn();
  assert.equal(proxy.getRuntimeState().agentDetail, 'Replacement owner');
  assert.equal(owner.calls.filter(call => call.name === 'agent_task').length, 1);
  await proxy.setAgentSettings({ model: 'after-restart' });
  assert.equal(proxy.getAgentSettings().model, 'after-restart');
});

test('native settings hide is observed once and stops the local check without echoing a close command', async t => {
  const owner = await ownerFixture();
  await owner.host.open('sources');
  const closed = [];
  const proxy = await owner.proxy({ onClose: () => closed.push(true) });
  cleanup(t, owner, proxy);
  await proxy.command('start_microphone_test');
  const nativeTransitions = owner.calls.filter(call => call.name === 'set_settings_open').length;
  const testStops = owner.calls.filter(call => call.name === 'stop_microphone_test').length;
  owner.publish({ settingsOpen: false });
  await until(() => closed.length === 1 && proxy.getRuntimeState().microphoneTesting === false);
  assert.equal(owner.calls.filter(call => call.name === 'set_settings_open').length, nativeTransitions);
  assert.equal(owner.calls.filter(call => call.name === 'stop_microphone_test').length, testStops + 1);
  assert.deepEqual(proxy.getRuntimeState().tasks, [{ task_id: 'running-1', status: 'running' }]);
  await owner.host.open('agent', { kind: 'approval', id: 'approval-1' });
  await until(() => proxy.getOpenRequest().open);
  assert.equal(proxy.getOpenRequest().tab, 'agent');
  assert.deepEqual(proxy.getOpenRequest().request, { kind: 'approval', id: 'approval-1' });
  assert.equal(closed.length, 1);
});

test('settings activity is scoped to its own native event and a late initial query cannot overwrite it', async t => {
  const owner = await ownerFixture();
  let resolveActivity;
  const activity = [];
  const opening = owner.proxy({
    onWindowActivity: ({ active }) => activity.push(active),
    nativeInvoke: name => {
      assert.equal(name, 'get_window_activity');
      return new Promise(resolve => { resolveActivity = resolve; });
    },
  });
  await until(() => typeof resolveActivity === 'function');
  const native = owner.bus.events('native');
  await native.emitTo('main', 'overlay:window-activity', { active: true });
  await turn();
  assert.deepEqual(activity, [], 'main-window activity must not affect the settings view');
  await native.emitTo('settings', 'overlay:window-activity', { active: false });
  await until(() => activity.length === 1);
  resolveActivity({ active: true });
  const proxy = await opening;
  cleanup(t, owner, proxy);
  await turn();
  assert.deepEqual(activity, [false], 'a late initial active snapshot loses to the native transition');
  await native.emitTo('settings', 'overlay:window-activity', { active: true });
  await until(() => activity.length === 2);
  assert.deepEqual(activity, [false, true]);
  proxy.destroy();
  await native.emitTo('settings', 'overlay:window-activity', { active: false });
  await turn();
  assert.deepEqual(activity, [false, true], 'disposing the secondary view removes the native listener');
});


test('microphone and system frames keep independent ordering through delayed snapshots', async t => {
  const owner = await ownerFixture();
  await owner.host.open('sources');
  const frames = [];
  const proxy = await owner.proxy({ onAudioLevels: value => frames.push(value) });
  cleanup(t, owner, proxy);
  owner.bus.hold(packet => packet.event === 'settings:audio' || packet.event === 'settings:snapshot');
  const microphone = { active: true, at: 1000, rawRms: .1 };
  const system = { source: 'system', active: true, at: 1000, rawRms: .2 };
  owner.state().microphoneLevels = microphone;
  owner.host.updateAudioLevels(microphone);
  owner.publish({ agentDetail: 'Snapshot between source frames' });
  owner.state().systemAudioLevels = system;
  owner.host.updateAudioLevels(system);
  await until(() => owner.bus.held.length === 3);
  owner.bus.hold(() => false);
  const [micPacket, snapshot, systemPacket] = owner.bus.held.splice(0);
  owner.bus.deliver(systemPacket);
  owner.bus.deliver(micPacket); // Lower global sequence, but a newer microphone frame.
  await until(() => frames.length === 2);
  assert.deepEqual(proxy.getRuntimeState().microphoneLevels, microphone);
  assert.deepEqual(proxy.getRuntimeState().systemAudioLevels, system);
  owner.bus.deliver(snapshot);
  await until(() => proxy.getRuntimeState().agentDetail === 'Snapshot between source frames');
  assert.deepEqual(proxy.getRuntimeState().microphoneLevels, microphone);
  assert.deepEqual(proxy.getRuntimeState().systemAudioLevels, system);
  owner.bus.deliver(systemPacket);
  owner.bus.deliver(micPacket);
  await turn();
  assert.equal(frames.length, 2);
});
