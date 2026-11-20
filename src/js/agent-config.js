/** Persisted configuration and mode routing shared by both app windows. */
export const DEFAULT_AGENT = Object.freeze({
  workspace: '', workspace_mode: 'temporary', scenario: 'assistant',
  custom_name: 'Свой режим', custom_instructions: '', custom_behavior: 'dialogue',
  model: '', effort: '', web_search: true, parallel: true,
  realtime: true, realtime_model: 'gpt-realtime-2.1',
  silence_timeout_secs: 300, agent_auto_end: true,
});

export function normalizeAgent(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    workspace: typeof source.workspace === 'string' ? source.workspace.trim() : '',
    workspace_mode: source.workspace_mode === 'project' ? 'project' : 'temporary',
    scenario: ['assistant', 'interview', 'custom'].includes(source.scenario) ? source.scenario : 'assistant',
    custom_name: typeof source.custom_name === 'string' && source.custom_name.trim() ? source.custom_name.trim() : 'Свой режим',
    custom_instructions: typeof source.custom_instructions === 'string' ? source.custom_instructions : '',
    custom_behavior: ['dialogue', 'selective', 'on_request'].includes(source.custom_behavior) ? source.custom_behavior : 'dialogue',
    model: typeof source.model === 'string' ? source.model : '',
    effort: typeof source.effort === 'string' ? source.effort : '',
    web_search: typeof source.web_search === 'boolean' ? source.web_search : true,
    parallel: typeof source.parallel === 'boolean' ? source.parallel : true,
    realtime: typeof source.realtime === 'boolean' ? source.realtime : true,
    silence_timeout_secs: Number.isInteger(source.silence_timeout_secs)
      && (source.silence_timeout_secs === 0 || source.silence_timeout_secs >= 30 && source.silence_timeout_secs <= 3600)
      ? source.silence_timeout_secs : DEFAULT_AGENT.silence_timeout_secs,
    agent_auto_end: typeof source.agent_auto_end === 'boolean' ? source.agent_auto_end : true,
    realtime_model: ['gpt-realtime-2.1', 'gpt-realtime-1.5'].includes(source.realtime_model) ? source.realtime_model : 'gpt-realtime-2.1',
  };
}

export function validateCustomSettings(config) {
  if ([...config.custom_name].length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(config.custom_name)) {
    throw new Error('Название режима должно содержать до 64 символов без управляющих знаков.');
  }
  if ([...config.custom_instructions].length > 12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(config.custom_instructions)) {
    throw new Error('Инструкция должна содержать до 12 000 символов. Разрешены переносы строк и табуляция.');
  }
}

export function usesMeetingAudio(config = {}) {
  return config?.scenario === 'interview' || config?.scenario === 'custom'
    && ['selective', 'on_request'].includes(config.custom_behavior);
}

export function modeLabel(config = {}) {
  if (config?.scenario === 'custom') return config.custom_name?.trim() || 'Свой режим';
  return config?.scenario === 'interview' ? 'Помощь на совещании' : 'Голосовой помощник';
}