import { createMicrophoneMeter } from './microphone-meter.js';
import { setButtonIcon } from './icons.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function fillOptions(select, options, selected) {
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...options.map(option => {
      const node = element('option', '', option.label);
      node.value = option.value;
      return node;
    }));
    select.dataset.options = signature;
  }
  if (document.activeElement !== select) select.value = selected || '';
}
function safeDetail(value) {
  if (typeof value === 'string') return value.slice(0, 12000);
  if (Array.isArray(value)) return value.map(String).join(' ').slice(0, 12000);
  return value == null ? '' : JSON.stringify(value).slice(0, 12000);
}

export function createAgentSettings({ host, bridge, getRuntimeState, closeModal }) {
  const abort = new AbortController();
  const byId = id => host.querySelector('#' + id);
  const microphoneMeter = createMicrophoneMeter(host);
  microphoneMeter.setVisible(false);
  let testRequested = false;
  let testEpoch = 0;
  let noiseIntent = null;
  let destroyed = false;
  let busy = false;
  let logSignature = '';
  let approvalSignature = '';
  let taskSignature = '';

  function error(message) { bridge?.reportError(message); }
  async function action(button, command, args = {}, close = false) {
    if (!bridge || button?.disabled) return;
    if (button) button.disabled = true;
    try {
      await bridge.command(command, args);
      if (close) await closeModal();
    } catch (failure) { error(failure); }
    finally { if (button) button.disabled = false; refresh(); }
  }
  async function setNoiseSuppression(enabled) {
    if (!bridge || noiseIntent !== null) return;
    noiseIntent = Boolean(enabled);
    refresh();
    try { await bridge.command('set_microphone_noise_suppression', { enabled: noiseIntent }); }
    catch (failure) { error(failure); }
    finally { noiseIntent = null; refresh(); }
  }
  async function startMicrophoneTest() {
    if (!bridge || byId('mic-test').disabled) return;
    const epoch = ++testEpoch;
    testRequested = true;
    refresh();
    try { await bridge.command('start_microphone_test'); }
    catch (failure) { error(failure); }
    finally {
      if (testEpoch === epoch) testRequested = false;
      refresh();
    }
  }
  async function stopMicrophoneTest() {
    if (!bridge || (!testRequested && !getRuntimeState()?.microphoneTesting)) return;
    ++testEpoch;
    testRequested = false;
    try { await bridge.command('stop_microphone_test'); }
    catch (failure) { error(failure); }
    finally { refresh(); }
  }
  async function submitTask(event) {
    event?.preventDefault();
    if (busy) return;
    const prompt = byId('agent-prompt');
    const task = prompt.value.trim();
    if (!task) { prompt.focus(); return; }
    busy = true;
    refresh();
    try {
      await bridge.command('agent_task', { task });
      prompt.value = '';
      await closeModal();
    } catch (failure) { error(failure); }
    finally { busy = false; refresh(); }
  }

  host.addEventListener('change', event => {
    const target = event.target;
    const key = target.dataset.agentSetting;
    if (key) {
      const value = target.type === 'checkbox' ? target.checked : target.value;
      const patch = { [key]: value };
      if (key === 'model') patch.effort = '';
      void bridge.setAgentSettings(patch).catch(error);
    }
    if (target.id === 'realtime-model') void bridge.setAgentSettings({ realtime_model: target.value }).catch(error);
    if (target.id === 'mic-device') void action(null, 'set_microphone_device', { deviceId: target.value });
    if (target.id === 'mic-noise-suppression') void setNoiseSuppression(target.checked);
    if (target.matches('[data-answer-choice]')) {
      const other = target.closest('fieldset').querySelector('[data-answer-other]');
      if (other) { other.hidden = target.value !== '__other__'; other.required = !other.hidden; }
    }
  }, { signal: abort.signal });

  host.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.id === 'agent-connect') void action(button, 'reconnect_session');
    if (button.id === 'agent-disconnect') void action(button, 'disconnect_session');
    if (button.id === 'agent-interrupt') void action(button, 'agent_interrupt');
    if (button.id === 'mic-refresh') void action(button, 'refresh_microphones');
    if (button.id === 'mic-test') {
      if (testRequested || getRuntimeState()?.microphoneTesting) void stopMicrophoneTest();
      else void startMicrophoneTest();
    }
    if (button.dataset.approvalDecision) {
      const pending = getRuntimeState().approvals?.find(item => String(item.request_id) === button.dataset.requestId);
      if (pending) void action(button, 'agent_approval', { request_id: pending.request_id, decision: button.dataset.approvalDecision });
    }
    if (button.dataset.selectTask) void action(button, 'select_agent_task', { task_id: button.dataset.selectTask }, true);
    if (button.dataset.interruptTask) void action(button, 'agent_interrupt', { task_id: button.dataset.interruptTask });
  }, { signal: abort.signal });

  byId('agent-task-form').addEventListener('submit', submitTask, { signal: abort.signal });
  byId('agent-prompt').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitTask();
    }
  }, { signal: abort.signal });

  function renderApprovals(requests) {
    const signature = JSON.stringify(requests);
    if (approvalSignature === signature) return;
    approvalSignature = signature;
    byId('agent-approvals').replaceChildren(...requests.map(request => {
      const card = element('section', 'request-card approval-card');
      card.dataset.requestId = String(request.request_id);
      card.append(element('h3', '', request.title || 'Подтверждение действия'));
      if (request.reason) card.append(element('p', '', request.reason));
      if (request.message && request.message !== request.reason) card.append(element('p', '', request.message));
      if (request.command) card.append(element('pre', 'request-command', safeDetail(request.command)));
      if (request.cwd) card.append(element('p', 'request-context', request.cwd));
      if (request.permissions && typeof request.permissions === 'object') {
        card.append(element('p', 'request-scope-label', 'Запрашиваемый доступ · только на текущий ход Codex'));
        card.append(element('pre', 'request-permissions', JSON.stringify(request.permissions, null, 2)));
      }
      if (request.url) {
        try {
          const url = new URL(request.url);
          if (['http:', 'https:'].includes(url.protocol)) {
            const link = element('a', 'request-link', url.href);
            link.href = url.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            card.append(link);
          } else card.append(element('p', '', 'Инструмент передал ссылку с неподдерживаемым протоколом.'));
        } catch { card.append(element('p', '', 'Инструмент передал некорректную ссылку.')); }
      }
      if (request.requires_content) card.append(element('p', '', 'Для подтверждения нужны данные формы. Сейчас доступны отклонение и отмена.'));
      const controls = element('div', 'agent-actions');
      const choices = Array.isArray(request.choices) && request.choices.length ? request.choices : ['accept', 'decline', 'cancel'];
      for (const [decision, label] of [['accept', 'Разрешить'], ['decline', 'Отклонить'], ['cancel', 'Отменить']]) {
        if (!choices.includes(decision)) continue;
        const button = element('button', 'action-button' + (decision === 'accept' ? '' : ' secondary'), label);
        button.type = 'button';
        button.disabled = decision === 'accept' && Boolean(request.requires_content);
        button.dataset.approvalDecision = decision;
        button.dataset.requestId = String(request.request_id);
        controls.append(button);
      }
      card.append(controls);
      return card;
    }));
  }

  function renderInputs(requests) {
    const container = byId('agent-inputs');
    for (const card of [...container.children]) {
      if (!requests.some(request => String(request.request_id) === card.dataset.requestId)) card.remove();
    }
    for (const request of requests) {
      if ([...container.children].some(card => card.dataset.requestId === String(request.request_id))) continue;
      const form = element('form', 'request-card input-card');
      form.dataset.requestId = String(request.request_id);
      form.append(element('h3', '', 'Уточнение от Codex'));
      const questions = Array.isArray(request.questions) ? request.questions : [];
      for (const question of questions) {
        const field = element('fieldset', 'question-field');
        field.dataset.questionId = String(question.id);
        field.append(element('legend', '', question.header || question.question || 'Вопрос'));
        if (question.header && question.question) field.append(element('p', '', question.question));
        const options = Array.isArray(question.options) ? question.options : [];
        if (options.length) {
          const select = element('select', 'question-select');
          select.dataset.answerChoice = 'true';
          select.required = true;
          select.setAttribute('aria-label', question.question || question.header || 'Ответ');
          const placeholder = element('option', '', 'Выбери ответ');
          placeholder.value = '';
          select.append(placeholder);
          for (const option of options) {
            const choice = element('option', '', option.label || option.value);
            choice.value = option.label || option.value;
            select.append(choice);
          }
          if (question.isOther || question.isOtherAllowed || question.is_other_allowed) {
            const choice = element('option', '', 'Свой ответ');
            choice.value = '__other__';
            select.append(choice);
            const input = element('input');
            input.type = question.isSecret || question.is_secret ? 'password' : 'text';
            input.dataset.answerOther = 'true';
            input.hidden = true;
            input.placeholder = 'Свой ответ';
            field.append(select, input);
          } else field.append(select);
          const descriptions = options.filter(option => option.description);
          if (descriptions.length) {
            const list = element('ul', 'question-options');
            for (const option of descriptions) list.append(element('li', '', option.label + ' — ' + option.description));
            field.append(list);
          }
        } else {
          const input = element('input');
          input.type = question.isSecret || question.is_secret ? 'password' : 'text';
          input.dataset.answerOther = 'true';
          input.required = true;
          input.setAttribute('aria-label', question.question || question.header || 'Ответ');
          field.append(input);
        }
        form.append(field);
      }
      const button = element('button', 'action-button', 'Ответить');
      button.type = 'submit';
      form.append(button);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const answers = {};
        for (const field of form.querySelectorAll('[data-question-id]')) {
          const select = field.querySelector('[data-answer-choice]');
          const input = field.querySelector('[data-answer-other]');
          const answer = select && select.value !== '__other__' ? select.value : input?.value.trim();
          if (!answer) return;
          answers[field.dataset.questionId] = { answers: [answer] };
        }
        await action(button, 'agent_input', { request_id: request.request_id, answers });
      }, { signal: abort.signal });
      container.append(form);
    }
  }

  function refresh() {
    if (destroyed) return;
    const runtime = getRuntimeState() || {};
    const config = runtime.agentConfig || bridge?.getAgentSettings?.() || {};
    for (const input of host.querySelectorAll('[data-agent-setting]')) {
      if (input.tagName === 'SELECT' || document.activeElement === input) continue;
      if (input.type === 'checkbox') input.checked = Boolean(config[input.dataset.agentSetting]);
      else input.value = config[input.dataset.agentSetting] || '';
    }
    const models = runtime.models || [];
    fillOptions(byId('agent-model'), [{ value: '', label: 'По умолчанию Codex' },
      ...models.map(model => ({ value: model.id, label: model.display_name || model.id }))], config.model);
    const model = models.find(item => item.id === config.model) || models.find(item => item.is_default) || models[0];
    const efforts = model?.reasoning_efforts || [];
    fillOptions(byId('agent-effort'), [{ value: '', label: 'По умолчанию модели' },
      ...efforts.map(effort => ({ value: typeof effort === 'string' ? effort : effort.reasoningEffort || effort.effort, label: typeof effort === 'string' ? effort : effort.reasoningEffort || effort.effort }))], config.effort);
    const microphoneDevices = runtime.microphoneDevices?.length ? runtime.microphoneDevices
      : [{ deviceId: '', label: 'Системный по умолчанию' }];
    fillOptions(byId('mic-device'), microphoneDevices.map(device => ({ value: device.deviceId, label: device.label })), runtime.microphoneDevice);
    if (document.activeElement !== byId('realtime-model')) byId('realtime-model').value = config.realtime_model || 'gpt-realtime-2.1';
    const testing = Boolean(runtime.microphoneTesting || testRequested);
    const dictating = runtime.microphoneMuted === false && !runtime.microphoneTesting;
    const audioBusy = Boolean(runtime.microphoneBusy);
    byId('mic-device').disabled = !runtime.nativeWindow || audioBusy;
    byId('mic-refresh').disabled = !runtime.nativeWindow || audioBusy;
    byId('mic-runtime').textContent = !runtime.nativeWindow ? 'Микрофон доступен в приложении OpenAssistant.'
      : runtime.microphoneStatus || (runtime.microphoneMuted ? 'Микрофон выключен' : runtime.micDetail || 'Микрофон включён');
    byId('mic-test').disabled = !testing && (!runtime.audioAvailable || audioBusy || dictating);
    byId('mic-test').setAttribute('aria-pressed', String(testing));
    byId('mic-test-label').textContent = testing ? 'Остановить проверку' : 'Проверить микрофон';
    setButtonIcon(byId('mic-test-icon'), testing ? 'stop' : 'play');
    const remaining = Number(runtime.microphoneTestRemaining);
    byId('mic-test-status').textContent = testing
      ? (runtime.microphoneTesting ? 'Говорите обычным голосом' + (remaining > 0 ? ' · ' + Math.ceil(remaining) + ' с' : '') : 'Открываем микрофон…')
      : dictating ? 'Уровень текущего голосового ввода.' : 'Локальная проверка на 20 секунд. Звук не отправляется.';
    byId('mic-noise-suppression').checked = noiseIntent ?? Boolean(runtime.microphoneNoiseSuppression);
    byId('mic-noise-suppression').disabled = !runtime.nativeWindow || audioBusy || noiseIntent !== null;
    byId('mic-error').textContent = runtime.microphoneError || '';
    byId('mic-error').hidden = !runtime.microphoneError;
    microphoneMeter.update(runtime.microphoneLevels, runtime);
    byId('agent-runtime').textContent = runtime.agentDetail || (runtime.agentStage === 'ready' ? 'Codex подключён' : 'Подключение создаётся при отправке задачи или включении микрофона.');
    byId('agent-error').textContent = runtime.lastError || '';
    byId('agent-error').hidden = !runtime.lastError;
    const connecting = ['starting', 'connecting'].includes(runtime.agentStage) || runtime.connectionStatus === 'connecting';
    const connected = ['ready', 'running'].includes(runtime.agentStage);
    byId('agent-connect').textContent = connecting ? 'Подключение…' : runtime.configDirty && connected ? 'Применить и переподключить' : connected ? 'Переподключить' : 'Подключить';
    byId('agent-connect').disabled = connecting;
    byId('agent-disconnect').disabled = runtime.agentStage === 'idle' && runtime.connectionStatus === 'idle';
    byId('agent-send').disabled = busy;
    byId('agent-send').textContent = busy ? 'Отправляю…' : 'Отправить';
    const tasks = runtime.tasks || [];
    byId('agent-interrupt').disabled = !tasks.some(task => task.status === 'running');
    renderApprovals(runtime.approvals || []);
    renderInputs(runtime.inputs || []);

    const nextTasks = JSON.stringify(tasks.map(task => [task.task_id, task.status, task.task, runtime.visibleTaskId === task.task_id]));
    if (taskSignature !== nextTasks) {
      taskSignature = nextTasks;
      byId('agent-tasks').replaceChildren(...tasks.slice(-8).reverse().map(task => {
        const row = element('div', 'agent-task-row');
        const select = element('button', 'task-result', task.task || 'Задача Codex');
        select.type = 'button';
        select.dataset.selectTask = task.task_id;
        select.setAttribute('aria-pressed', String(runtime.visibleTaskId === task.task_id));
        row.append(select, element('span', 'task-status', ({ running: 'В работе', completed: 'Готово', failed: 'Ошибка', cancelled: 'Остановлено', interrupted: 'Остановлено' })[task.status] || task.status));
        if (task.status === 'running') {
          const stop = element('button', 'action-button secondary small', 'Стоп');
          stop.type = 'button';
          stop.dataset.interruptTask = task.task_id;
          row.append(stop);
        }
        return row;
      }));
    }

    const activities = runtime.activities || [];
    const nextLog = JSON.stringify(activities);
    if (logSignature !== nextLog) {
      logSignature = nextLog;
      const log = byId('agent-log');
      const pinned = log.scrollHeight - log.clientHeight - log.scrollTop < 20;
      log.replaceChildren(...activities.slice(-60).map(activity => {
        const item = element('article', 'activity-item');
        item.dataset.kind = activity.kind || '';
        item.dataset.status = activity.status || '';
        const heading = element('div', 'activity-heading');
        heading.append(element('strong', '', activity.title || activity.kind || 'Действие'),
          element('span', '', ({ running: 'В работе', completed: 'Готово', failed: 'Ошибка' })[activity.status] || ''));
        item.append(heading);
        if (activity.detail) item.append(element('pre', 'activity-detail', safeDetail(activity.detail)));
        if (activity.diff) item.append(element('pre', 'activity-diff', safeDetail(activity.diff)));
        if (activity.path) item.append(element('p', 'activity-path', activity.path));
        for (const change of Array.isArray(activity.changes) ? activity.changes : []) {
          if (change.path) item.append(element('p', 'activity-path', change.path));
          if (change.diff) item.append(element('pre', 'activity-diff', safeDetail(change.diff)));
        }
        return item;
      }));
      if (pinned) log.scrollTop = log.scrollHeight;
    }
  }
  return {
    refresh,
    stopMicrophoneTest,
    updateAudioLevels(levels) { if (!destroyed) microphoneMeter.update(levels, getRuntimeState() || {}); },
    setAudioVisible(visible) { microphoneMeter.setVisible(visible); },
    destroy() { destroyed = true; microphoneMeter.destroy(); void stopMicrophoneTest(); abort.abort(); },
  };
}
