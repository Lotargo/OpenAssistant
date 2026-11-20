import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AGENT, normalizeAgent, validateCustomSettings, usesMeetingAudio, modeLabel } from '../src/js/agent-config.js';

test('custom limits count characters, allow multiline instructions and reject control characters', () => {
  assert.deepEqual(normalizeAgent(), DEFAULT_AGENT);
  const valid = normalizeAgent({
    scenario: 'custom', custom_name: '🙂'.repeat(64),
    custom_instructions: '\tAnswer briefly.\n' + 'x'.repeat(11980),
    custom_behavior: 'selective', realtime: false,
  });
  assert.doesNotThrow(() => validateCustomSettings(valid));
  for (const patch of [
    { custom_name: '🙂'.repeat(65) },
    { custom_name: 'Hidden\u0001control' },
    { custom_instructions: 'x'.repeat(12001) },
    { custom_instructions: 'Hidden\u000bcontrol' },
  ]) {
    assert.throws(() => validateCustomSettings({ ...valid, ...patch }));
  }
});

test('mode routing preserves an explicit disabled voice preference for every behavior', () => {
  const cases = [
    ['assistant', 'dialogue', false], ['assistant', 'on_request', false],
    ['interview', 'dialogue', true], ['custom', 'dialogue', false],
    ['custom', 'selective', true], ['custom', 'on_request', true],
  ];
  for (const [scenario, custom_behavior, meeting] of cases) {
    const config = normalizeAgent({ scenario, custom_behavior, realtime: false });
    assert.equal(config.realtime, false);
    assert.equal(usesMeetingAudio(config), meeting, scenario + '/' + custom_behavior);
  }
  assert.equal(modeLabel(normalizeAgent({ scenario: 'custom', custom_name: '  Code reviewer  ' })), 'Code reviewer');
});

test('switching to a preset retains the custom draft without activating its behavior', () => {
  const draft = normalizeAgent({
    scenario: 'custom', custom_name: 'Reviewer', custom_instructions: 'Explain trade-offs.\nUse Russian.',
    custom_behavior: 'on_request',
  });
  const preset = normalizeAgent({ ...draft, scenario: 'assistant' });
  assert.equal(preset.custom_instructions, draft.custom_instructions);
  assert.equal(preset.custom_name, 'Reviewer');
  assert.equal(usesMeetingAudio(preset), false);
  assert.equal(normalizeAgent({ ...draft, scenario: 'unknown' }).scenario, 'assistant');
  assert.equal(normalizeAgent({ ...draft, custom_behavior: 'unknown' }).custom_behavior, 'dialogue');
});

test('broadcast preferences migrate safely and retain explicit silence and semantic-end choices', () => {
  const defaults = normalizeAgent({ scenario: 'assistant', realtime: false });
  assert.equal(defaults.silence_timeout_secs, 300);
  assert.equal(defaults.agent_auto_end, true);
  for (const seconds of [0, 30, 300, 3600]) {
    const config = normalizeAgent({ scenario: 'custom', silence_timeout_secs: seconds, agent_auto_end: false });
    assert.equal(config.silence_timeout_secs, seconds);
    assert.equal(config.agent_auto_end, false);
    assert.equal(normalizeAgent({ ...config, scenario: 'interview' }).silence_timeout_secs, seconds);
  }
  for (const invalid of [-1, 29, 3601, 60.5, NaN, Infinity, '300', null]) {
    assert.equal(normalizeAgent({ silence_timeout_secs: invalid }).silence_timeout_secs, 300);
  }
  for (const invalid of ['false', 0, null]) assert.equal(normalizeAgent({ agent_auto_end: invalid }).agent_auto_end, true);
});
