import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSettingsModal } from '../src/js/settings-modal.js';
import { DEFAULT_SETTINGS } from '../src/js/settings.js';
import { modelControls, workspaceStatus } from '../src/js/agent-settings-view.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const models = [
  { id: 'focused', display_name: 'Focused', description: 'A focused model', reasoning_efforts: ['low', 'high'], default_effort: 'high' },
  { id: 'default', display_name: 'Default', is_default: true, reasoning_efforts: ['medium'], default_effort: 'medium' },
];
function formFixture(t, patch = {}) {
  const dom = new JSDOM('<div id="settings-root"></div>', { pretendToBeVisual: true });
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    AbortController: dom.window.AbortController,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { queueMicrotask(callback); return 1; },
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const state = {
    nativeWindow: true, agentConfig: { model: 'focused', effort: 'high', workspace_mode: 'temporary', workspace: 'F:\\saved-project', scenario: 'assistant' },
    models, modelCatalog: { status: 'ready', error: '' }, workspaceState: { mode: 'temporary', path: '', cleanupStatus: '' },
    interviewState: { stage: 'idle' }, broadcastState: { stage: 'idle' }, agentStage: 'idle', connectionStatus: 'idle',
    microphoneMuted: true, microphoneTesting: false, audioAvailable: true, microphoneDevices: [],
    systemAudioDevices: [{ deviceId: '', label: 'System default' }, { deviceId: 'speakers', label: 'Meeting speakers' }],
    systemAudioAvailable: true, tasks: [], activities: [], approvals: [], inputs: [], ...patch,
  };
  const calls = [];
  const changes = [];
  const failures = [];
  const handlers = new Map();
  let form;
  const bridge = {
    getAgentSettings: () => state.agentConfig,
    reportError: error => failures.push(String(error)),
    async setAgentSettings(next) {
      changes.push({ ...next });
      state.agentConfig = { ...state.agentConfig, ...next };
      form.refresh();
    },
    async command(name, args = {}) {
      calls.push({ name, args });
      if (handlers.has(name)) await handlers.get(name)(args);
      if (name === 'set_scenario') {
        state.agentConfig = { ...state.agentConfig, scenario: args.scenario };
        form.refresh();
      }
    },
  };
  form = createSettingsModal({
    standalone: true, bridge, getSettings: () => DEFAULT_SETTINGS, onChange() {},
    getRuntimeState: () => state,
  });
  t.after(() => {
    form.destroy();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const byId = id => dom.window.document.getElementById(id);
  const change = (id, value) => {
    const input = byId(id);
    input.value = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, state, form, byId, change, calls, changes, failures, handlers };
}

test('catalog uses the selected or declared default model and retains unavailable saved choices', () => {
  const selected = modelControls(models, { model: 'focused', effort: 'high' }, { status: 'ready' });
  assert.deepEqual(selected.effortOptions.map(option => option.value), ['', 'low', 'high']);
  assert.match(selected.effortOptions[0].label, /Высокая/);
  assert.deepEqual(modelControls(models, {}).effortOptions.map(option => option.value), ['', 'medium']);
  assert.deepEqual(modelControls([{ id: 'not-default', reasoning_efforts: ['high'] }], {}).effortOptions.map(option => option.value), ['']);
  const missing = modelControls(models, { model: 'removed', effort: 'xhigh' }, { status: 'ready' });
  assert.equal(missing.modelOptions.at(-1).value, 'removed');
  assert.equal(missing.modelOptions.at(-1).disabled, true);
  assert.match(missing.modelOptions.at(-1).label, /недоступна/);
  assert.equal(missing.effortOptions.at(-1).disabled, true);
  const unsupported = modelControls(models, { model: 'default', effort: 'high' });
  assert.equal(unsupported.missingEffort, true);
  assert.equal(unsupported.effortOptions.at(-1).disabled, true);
  assert.equal(modelControls([{ id: 'a', is_default: true, reasoning_efforts: {} }]).effortEnabled, false);
});

test('model refresh never connects; changing model resets effort to its own default', async t => {
  const f = formFixture(t);
  assert.deepEqual([...f.byId('agent-effort').options].map(option => option.value), ['', 'low', 'high']);
  f.byId('agent-model-refresh').click();
  await turn();
  assert.deepEqual(f.calls.map(call => call.name), ['refresh_models']);
  f.change('agent-model', 'default');
  await turn();
  assert.deepEqual(f.changes.at(-1), { model: 'default', effort: '' });
  assert.deepEqual([...f.byId('agent-effort').options].map(option => option.value), ['', 'medium']);
  assert.equal(f.byId('agent-effort').value, '');
  f.state.agentConfig.model = 'removed';
  f.form.refresh();
  assert.equal(f.byId('agent-model').value, 'removed');
  assert.equal(f.byId('agent-model').selectedOptions[0].disabled, true);
  f.state.modelCatalog = { status: 'error', error: 'Catalog unavailable' };
  f.form.refresh();
  assert.equal(f.byId('agent-catalog-status').textContent, 'Catalog unavailable');
  assert.equal(f.calls.some(call => call.name.includes('connect')), false);
});

test('workspace choice waits for its native result, keeps project path, and reports cleanup failures', async t => {
  const f = formFixture(t);
  assert.equal(f.byId('agent-project-field').hidden, true);
  f.change('agent-workspace-mode', 'project');
  await turn();
  assert.equal(f.byId('agent-project-field').hidden, false);
  assert.equal(f.byId('agent-workspace').value, 'F:\\saved-project');
  let finish;
  f.handlers.set('choose_workspace', () => new Promise(resolve => { finish = resolve; }));
  f.byId('agent-workspace-choose').click();
  f.form.refresh();
  assert.equal(f.byId('agent-workspace-choose').disabled, true);
  assert.equal(f.byId('agent-workspace').value, 'F:\\saved-project');
  finish(); // Picker cancel: no invented path or settings change.
  await turn();
  assert.equal(f.byId('agent-workspace-choose').disabled, false);
  assert.equal(f.state.agentConfig.workspace, 'F:\\saved-project');
  f.change('agent-workspace-mode', 'temporary');
  f.state.workspaceState = { mode: 'temporary', path: 'F:\\owned-temp', cleanupStatus: 'failed', detail: 'File is still locked' };
  f.form.refresh();
  assert.equal(f.state.agentConfig.workspace, 'F:\\saved-project');
  assert.equal(f.byId('agent-workspace-status').textContent, 'File is still locked');
  assert.equal(f.byId('agent-workspace-current').hidden, false);
  f.byId('agent-workspace-clear').click();
  await turn();
  assert.equal(f.calls.at(-1).name, 'clear_temporary_workspace');
  assert.equal(f.byId('agent-workspace-status').textContent, 'File is still locked');
});

test('scenario selection does not start listening; pending start can stop and source meters stay separate', async t => {
  const f = formFixture(t);
  f.change('agent-scenario', 'interview');
  await turn();
  assert.equal(f.byId('interview-panel').hidden, false);
  assert.deepEqual(f.calls, [{ name: 'set_scenario', args: { scenario: 'interview' } }]);
  assert.equal(f.byId('interview-state').textContent, 'Эфир выключен');
  let finish;
  f.handlers.set('start_broadcast', () => new Promise(resolve => { finish = resolve; }));
  f.byId('interview-start').click();
  assert.equal(f.byId('interview-start').disabled, true);
  assert.equal(f.byId('interview-stop').disabled, false);
  assert.equal(f.byId('interview-state').textContent, 'Эфир выключен');
  f.byId('interview-stop').click();
  await turn();
  assert.equal(f.calls.at(-1).name, 'stop_broadcast');
  finish();
  await turn();
  f.state.broadcastState = { stage: 'live' };
  f.state.systemAudioActive = true;
  f.state.interviewState = { stage: 'evaluating', source: 'system', speaker: 'unknown', detail: 'Question received' };
  f.form.refresh();
  assert.equal(f.byId('interview-source').textContent, 'Звук встречи');
  assert.equal(f.byId('interview-state').textContent, 'Определяю, нужна ли подсказка');
  await f.form.open('audio');
  const prompt = f.byId('agent-prompt');
  prompt.value = 'Keep my unfinished task';
  const sourceSelect = f.byId('system-audio-device');
  sourceSelect.focus();
  f.form.updateAudioLevels({ source: 'system', active: true, at: Date.now(), rawRms: .1, waveform: [0, .3, -.2, 0] });
  assert.equal(f.byId('system-audio-monitor').dataset.active, 'true');
  assert.equal(f.byId('mic-monitor').dataset.active, 'false');
  assert.equal(prompt.value, 'Keep my unfinished task');
  assert.equal(f.dom.window.document.activeElement, sourceSelect);
  f.state.microphoneMuted = false;
  f.form.updateAudioLevels({ active: true, at: Date.now(), rawRms: .05, waveform: [0, -.2, .1, 0] });
  assert.equal(f.byId('mic-monitor').dataset.active, 'true');
  assert.equal(f.byId('system-audio-monitor').dataset.active, 'true');
  f.form.updateAudioLevels({ source: 'system', active: false, at: Date.now() });
  assert.equal(f.byId('system-audio-monitor').dataset.active, 'false');
  assert.equal(f.byId('mic-monitor').dataset.active, 'true');
  f.change('agent-scenario', 'assistant');
  await turn();
  assert.equal(f.byId('interview-panel').hidden, false); // An active capture must always retain Stop.
});

test('workspace status distinguishes an active project from a preserved or cleaned lease', () => {
  const config = { workspace_mode: 'project', workspace: 'F:\\project' };
  assert.equal(workspaceStatus(config, { mode: 'project', cleanupStatus: 'active' }).statusText, 'Codex работает в папке проекта.');
  const preserved = workspaceStatus(config, { mode: 'project', cleanupStatus: 'preserved', path: config.workspace });
  assert.equal(preserved.pathLabel, 'Папка проекта');
  assert.equal(preserved.statusText, 'Папка проекта сохранена.');
  assert.equal(workspaceStatus({}, { mode: 'temporary', cleanupStatus: 'cleaned' }).statusText, 'Временная папка удалена.');
});
