import { createMicrophoneMeter } from './microphone-meter.js';
import { setButtonIcon } from './icons.js';
import { modelControls, catalogStatus, workspaceStatus, interviewStatus } from './agent-settings-view.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function fillOptions(select, options, selected) {
  const signature = JSON.stringify(options);
  const value = selected || '';
  const changed = select.dataset.options !== signature;
  if (changed) {
    select.replaceChildren(...options.map(option => {
      const node = element('option', '', option.label);
      node.value = option.value;
      node.disabled = Boolean(option.disabled);
      if (option.title) node.title = option.title;
      return node;
    }));
    select.dataset.options = signature;
  }
  // Focus alone cannot preserve a choice that the authoritative configuration
  // changed, or a selection erased when a live catalog replaced its options.
  if (changed || select.dataset.selected !== value || document.activeElement !== select) select.value = value;
  select.dataset.selected = value;
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
  const systemAudioMeter = createMicrophoneMeter(host, { prefix: 'system-audio', idleLabel: 'Звук встречи выключен' });
  microphoneMeter.setVisible(false);
  systemAudioMeter.setVisible(false);
  const pendingActions = new Set();
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
    if (!bridge || button?.disabled || (button && pendingActions.has(command))) return;
    pendingActions.add(command);
    if (button) button.disabled = true;
    refresh();
    try {
      await bridge.command(command, args);
      if (close) await closeModal();
    } catch (failure) { error(failure); }
    finally { pendingActions.delete(command); if (button) button.disabled = false; refresh(); }
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
    if (target.id === 'system-audio-device') void action(null, 'set_system_audio_device', { deviceId: target.value });
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
    if (button.id === 'mic-refresh' || button.id === 'system-audio-refresh') void action(button, 'refresh_microphones');
    if (button.id === 'agent-model-refresh') void action(button, 'refresh_models');
    if (button.id === 'agent-workspace-choose') void action(button, 'choose_workspace');
    if (button.id === 'agent-workspace-clear') void action(button, 'clear_temporary_workspace');
    if (button.id === 'interview-start') void action(button, 'start_interview');
    if (button.id === 'interview-stop') void action(button, 'stop_interview');
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
    const catalog = runtime.modelCatalog || {};
    const controls = modelControls(models, config, catalog);
    fillOptions(byId('agent-model'), controls.modelOptions, config.model);
    fillOptions(byId('agent-effort'), controls.effortOptions, config.effort);
    byId('agent-model').disabled = !runtime.nativeWindow || (catalog.status === 'loading' && !models.length);
    byId('agent-effort').disabled = !runtime.nativeWindow || !controls.effortEnabled;
    byId('agent-model-refresh').disabled = !runtime.nativeWindow || catalog.status === 'loading' || pendingActions.has('refresh_models');
    byId('agent-catalog-status').textContent = catalogStatus(catalog, models, runtime.nativeWindow);
    byId('agent-catalog-status').classList.toggle('agent-inline-error', catalog.status === 'error');
    byId('agent-model-description').textContent = controls.description;
    byId('agent-effort-description').textContent = controls.effortDescription;
    byId('agent-effort-description').classList.toggle('agent-inline-error', controls.missingEffort);
    fillOptions(byId('agent-scenario'), [{ value: 'assistant', label: 'Обычные задачи' }, { value: 'interview', label: 'Собеседование' }], config.scenario || 'assistant');
    const workspace = workspaceStatus(config, runtime.workspaceState);
    fillOptions(byId('agent-workspace-mode'), [{ value: 'temporary', label: 'Пустая временная папка' }, { value: 'project', label: 'Папка проекта' }], workspace.mode);
    byId('agent-project-field').hidden = workspace.mode !== 'project';
    byId('agent-workspace').disabled = workspace.mode !== 'project';
    byId('agent-workspace-choose').disabled = !runtime.nativeWindow || workspace.busy || pendingActions.has('choose_workspace');
    byId('agent-workspace-status').textContent = workspace.statusText;
    byId('agent-workspace-status').dataset.status = workspace.status;
    byId('agent-workspace-status').classList.toggle('agent-inline-error', workspace.failed);
    byId('agent-workspace-current').hidden = !workspace.path;
    byId('agent-workspace-path-label').textContent = workspace.pathLabel;
    byId('agent-workspace-path').textContent = workspace.path;
    const sessionActive = ['starting', 'connecting', 'ready', 'running'].includes(runtime.agentStage)
      || runtime.connectionStatus === 'connecting';
    byId('agent-workspace-clear').hidden = workspace.mode !== 'temporary' && runtime.workspaceState?.mode !== 'temporary';
    byId('agent-workspace-clear').disabled = !runtime.nativeWindow || workspace.busy || sessionActive || pendingActions.has('clear_temporary_workspace');
    const interview = interviewStatus(runtime.interviewState);
    byId('interview-panel').hidden = config.scenario !== 'interview' && !interview.active;
    byId('interview-panel').dataset.stage = interview.stage;
    byId('interview-state').textContent = interview.label;
    byId('interview-detail').textContent = interview.detail;
    byId('interview-source').textContent = [interview.source, interview.speaker].filter(Boolean).join(' · ');
    byId('interview-speaker-status').textContent = typeof runtime.speakerState?.detail === 'string' ? runtime.speakerState.detail : '';
    byId('interview-start').disabled = !runtime.nativeWindow || interview.active || pendingActions.has('start_interview');
    byId('interview-stop').disabled = (!interview.active && !pendingActions.has('start_interview')) || interview.stopping || pendingActions.has('stop_interview');
    byId('interview-error').textContent = interview.error;
    byId('interview-error').hidden = !interview.error;
    byId('agent-prompt').placeholder = config.scenario === 'interview' ? 'Дополнительный вопрос или задача'
      : workspace.mode === 'project' ? 'Что нужно сделать в проекте?' : 'Чем помочь?';
    const microphoneDevices = runtime.microphoneDevices?.length ? runtime.microphoneDevices
      : [{ deviceId: '', label: 'Системный по умолчанию' }];
    fillOptions(byId('mic-device'), microphoneDevices.map(device => ({ value: device.deviceId, label: device.label })), runtime.microphoneDevice);
    if (document.activeElement !== byId('realtime-model')) byId('realtime-model').value = config.realtime_model || 'gpt-realtime-2.1';
    const testing = Boolean(runtime.microphoneTesting || testRequested);
    const dictating = runtime.microphoneMuted === false && !runtime.microphoneTesting;
    const audioBusy = Boolean(runtime.microphoneBusy);
    byId('mic-device').disabled = !runtime.nativeWindow || audioBusy;
    byId('mic-refresh').disabled = !runtime.nativeWindow || audioBusy || pendingActions.has('refresh_microphones');
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
    const systemDevices = runtime.systemAudioDevices?.length ? runtime.systemAudioDevices
      : [{ deviceId: '', label: 'Системный по умолчанию' }];
    const systemOptions = systemDevices.map(device => ({ value: device.deviceId ?? device.id ?? '', label: device.label || device.name || 'Устройство вывода' }));
    if (runtime.systemAudioDevice && !systemOptions.some(option => option.value === runtime.systemAudioDevice)) {
      systemOptions.push({ value: runtime.systemAudioDevice, label: runtime.systemAudioDevice + ' · недоступно', disabled: true });
    }
    fillOptions(byId('system-audio-device'), systemOptions, runtime.systemAudioDevice);
    byId('system-audio-device').disabled = !runtime.nativeWindow || Boolean(runtime.systemAudioBusy);
    byId('system-audio-refresh').disabled = !runtime.nativeWindow || Boolean(runtime.systemAudioBusy) || pendingActions.has('refresh_microphones');
    byId('system-audio-runtime').textContent = !runtime.nativeWindow ? 'Звук встречи доступен в приложении OpenAssistant.'
      : runtime.systemAudioStatus || (runtime.systemAudioAvailable ? 'Включается вместе с режимом собеседования.' : 'Устройство вывода пока недоступно.');
    byId('system-audio-error').textContent = runtime.systemAudioError || '';
    byId('system-audio-error').hidden = !runtime.systemAudioError;
    systemAudioMeter.update(runtime.systemAudioLevels, { microphoneMuted: !runtime.systemAudioLevels?.active });
    byId('agent-runtime').textContent = runtime.agentDetail || (runtime.agentStage === 'ready' ? 'Codex подключён' : 'Подключение создаётся при отправке задачи или включении микрофона.');
    byId('agent-error').textContent = runtime.lastError || '';
    byId('agent-error').hidden = !runtime.lastError;
    const connecting = ['starting', 'connecting'].includes(runtime.agentStage) || runtime.connectionStatus === 'connecting';
    const connected = ['ready', 'running'].includes(runtime.agentStage);
    byId('agent-connect').textContent = connecting ? 'Подключение…' : runtime.configDirty && connected ? 'Применить и переподключить' : connected ? 'Переподключить' : 'Подключить';
    byId('agent-connect').disabled = connecting || pendingActions.has('reconnect_session');
    byId('agent-disconnect').disabled = (runtime.agentStage === 'idle' && runtime.connectionStatus === 'idle') || pendingActions.has('disconnect_session');
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
    updateAudioLevels(levels) {
      if (destroyed) return;
      if (levels?.source === 'system') systemAudioMeter.update(levels, { microphoneMuted: !levels.active });
      else microphoneMeter.update(levels, getRuntimeState() || {});
    },
    setAudioVisible(visible) { microphoneMeter.setVisible(visible); systemAudioMeter.setVisible(visible); },
    destroy() { destroyed = true; microphoneMeter.destroy(); systemAudioMeter.destroy(); void stopMicrophoneTest(); abort.abort(); },
  };
}
