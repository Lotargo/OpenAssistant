import { modeLabel, usesMeetingAudio } from './agent-config.js';

export function modeSettings(config = {}) {
  const custom = config.scenario === 'custom';
  const meeting = usesMeetingAudio(config);
  const descriptions = {
    dialogue: 'Слушает ваш микрофон и отвечает после каждой реплики по вашей инструкции.',
    selective: 'Учитывает микрофон и звук встречи. Подсказывает, когда помощь нужна по вашей инструкции.',
    on_request: 'Учитывает микрофон и звук встречи. Отвечает только на вашу явную просьбу о помощи.',
  };
  const description = custom ? descriptions[config.custom_behavior] || descriptions.dialogue
    : meeting ? 'Слушает ваш голос и звук встречи. Подсказывает по вопросам и задачам, обращённым к вам.'
      : 'Слушает ваш микрофон. Ответы на ваши реплики появляются в основной панели.';
  return { custom, meeting, label: modeLabel(config), description };
}

export function broadcastStatus(state = {}, transition = null) {
  if (transition?.resumeBroadcast) {
    return { stage: 'starting', label: 'Подготавливаю эфир',
      detail: typeof transition.detail === 'string' ? transition.detail : 'Переключаю режим и подключаю эфир.',
      active: true, live: false, stopping: false,
      error: state.reason === 'error' ? state.detail || 'Не удалось подготовить эфир.' : '' };
  }
  const labels = { idle: 'Эфир выключен', starting: 'Подключаю эфир', live: 'В эфире', stopping: 'Завершаю эфир', ended: 'Эфир завершён' };
  const stage = Object.hasOwn(labels, state.stage) ? state.stage : 'idle';
  return { stage, label: labels[stage], detail: typeof state.detail === 'string' ? state.detail : '',
    active: ['starting', 'live', 'stopping'].includes(stage), live: stage === 'live', stopping: stage === 'stopping',
    error: state.reason === 'error' ? state.detail || 'Эфир остановлен из-за ошибки.' : '' };
}

const effortNames = {
  none: 'Без рассуждений', minimal: 'Минимальная', low: 'Низкая', medium: 'Средняя',
  high: 'Высокая', xhigh: 'Очень высокая', max: 'Максимальная', ultra: 'Ультра',
};
const text = value => typeof value === 'string' ? value : '';

/** Options reflect the live catalog. Saved, unavailable choices stay visible
 * until the user chooses another value; they are never silently substituted.
 */
export function modelControls(models = [], config = {}, catalog = {}) {
  const entries = [];
  const seen = new Set();
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    entries.push(model);
  }
  const selected = text(config.model);
  const defaultModel = entries.find(model => model.is_default);
  const current = selected ? entries.find(model => model.id === selected) : defaultModel;
  const modelOptions = [{
    value: '', label: defaultModel ? 'По умолчанию · ' + (defaultModel.display_name || defaultModel.id) : 'По умолчанию Codex',
  }, ...entries.map(model => ({
    value: model.id, label: model.display_name || model.id, title: text(model.description),
  }))];
  const missingModel = Boolean(selected && !current);
  if (missingModel) modelOptions.push({
    value: selected, label: selected + (catalog.status === 'ready' ? ' · недоступна' : ' · сохранено'),
    disabled: true,
  });
  const efforts = [];
  const effortSet = new Set();
  for (const entry of Array.isArray(current?.reasoning_efforts) ? current.reasoning_efforts : []) {
    const value = typeof entry === 'string' ? entry : text(entry?.reasoningEffort || entry?.effort);
    if (!value || effortSet.has(value)) continue;
    effortSet.add(value);
    efforts.push({ value, label: effortNames[value] || value, title: text(entry?.description) });
  }
  const defaultEffort = text(current?.default_effort);
  const effortOptions = [{
    value: '', label: defaultEffort ? 'По умолчанию · ' + (effortNames[defaultEffort] || defaultEffort) : 'По умолчанию модели',
  }, ...efforts];
  const selectedEffort = text(config.effort);
  const missingEffort = Boolean(selectedEffort && !effortSet.has(selectedEffort));
  if (missingEffort) effortOptions.push({
    value: selectedEffort,
    label: (effortNames[selectedEffort] || selectedEffort) + (current ? ' · недоступна для модели' : ' · сохранено'),
    disabled: true,
  });
  return {
    modelOptions, effortOptions, missingModel, missingEffort,
    description: missingModel && catalog.status === 'ready'
      ? 'Сохранённой модели нет в каталоге. Выберите доступную модель или обновите список.'
      : text(current?.description),
    effortDescription: missingEffort && current
      ? 'Эта глубина не поддерживается выбранной моделью. Выберите другое значение.'
      : efforts.find(effort => effort.value === (selectedEffort || defaultEffort))?.title || '',
    effortEnabled: efforts.length > 0,
  };
}

export function catalogStatus(catalog = {}, models = [], native = false) {
  if (!native) return 'Каталог моделей доступен в приложении OpenAssistant.';
  if (catalog.status === 'loading') return 'Обновляем каталог Codex…';
  if (catalog.status === 'error') return text(catalog.error) || 'Не удалось загрузить каталог Codex.';
  if (catalog.status === 'ready') return models.length
    ? 'Модели и глубина рассуждений получены из Codex.' : 'Codex не вернул доступных моделей.';
  return 'Каталог загружается отдельно от подключения сессии.';
}

export function workspaceStatus(config = {}, state = {}) {
  const mode = config.workspace_mode === 'project' ? 'project' : 'temporary';
  const statuses = {
    creating: 'Создаём пустую временную папку…',
    active: state.mode === 'project' ? 'Codex работает в папке проекта.' : 'Временная папка используется текущей сессией.',
    cleaning: 'Удаляем временные файлы…',
    cleaned: 'Временная папка удалена.',
    preserved: 'Папка проекта сохранена.',
    pending: 'Очистка временных файлов ожидает завершения сессии.',
    error: 'Временные файлы пока не удалены.',
    failed: 'Временные файлы пока не удалены.',
  };
  const status = text(state.cleanupStatus);
  const detail = text(state.detail);
  const statusText = detail || statuses[status] || (mode === 'project'
    ? (config.workspace ? 'Codex будет работать в выбранном проекте.' : 'Выберите папку проекта.')
    : 'Для каждого подключения создаётся новая пустая папка.');
  return {
    mode, status, statusText, path: text(state.path),
    pathLabel: state.mode === 'project' ? (status === 'active' ? 'Активный проект' : 'Папка проекта') : 'Временная папка',
    busy: status === 'creating' || status === 'cleaning',
    failed: status === 'error' || status === 'failed',
  };
}

export function interviewStatus(state = {}) {
  const labels = {
    idle: 'Не слушаю', starting: 'Подключаю источники', connecting: 'Подключаю источники',
    listening: 'Слушаю', deciding: 'Определяю, нужна ли подсказка', evaluating: 'Определяю, нужна ли подсказка',
    helping: 'Готовлю подсказку', responding: 'Готовлю подсказку',
    stopping: 'Останавливаю прослушивание', error: 'Прослушивание остановлено',
    unavailable: 'Прослушивание недоступно',
  };
  const stage = text(state.stage) || 'idle';
  const source = state.source === 'system' ? 'Звук встречи'
    : ['microphone', 'mic'].includes(state.source) ? 'Мой микрофон' : '';
  const speaker = text(state.speaker_label) || text(state.speaker);
  return {
    stage, label: labels[stage] || 'Не слушаю',
    detail: text(state.detail) || 'Подсказки появляются по вопросам и задачам, обращённым к вам.',
    source, speaker: speaker.toLowerCase() === 'unknown' ? '' : speaker, error: text(state.error),
    active: ['starting', 'connecting', 'listening', 'deciding', 'evaluating', 'helping', 'responding', 'stopping'].includes(stage),
    stopping: stage === 'stopping',
  };
}
