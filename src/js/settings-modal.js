import { createColorPicker } from './color-picker.js';
import { getIcon } from './icons.js';
import { normalizeSettings } from './settings.js';
import { createAgentSettings } from './agent-settings.js';

const TABS = ['appearance', 'modes', 'agent', 'workspace', 'audio', 'screen', 'behavior', 'journal'];

/** The same settings form runs embedded in preview or in its own native window. */
export function createSettingsModal({ getSettings, onChange, onOpenChange, getRuntimeState = () => ({}), bridge, standalone = false }) {
  const host = document.getElementById('settings-root');
  const overlay = document.getElementById('overlay');
  const settingsButton = document.querySelector('[data-action="settings"]');
  const abort = new AbortController();
  let opened = false;
  let visibilityVersion = 0;
  let activeTab = 'appearance';
  let colorTarget = 'panelColor';
  let previousFocus = null;
  let current = normalizeSettings(getSettings());

  host.innerHTML = `
    <div id="settings-backdrop" class="settings-backdrop" hidden>
      <section id="settings-dialog" class="settings-dialog" role="dialog" aria-modal="${!standalone}" aria-labelledby="settings-title" tabindex="-1">
        <header class="settings-header" data-window-drag="handle">
          ${getIcon('settings')}<h1 id="settings-title">Настройки</h1>
          <button class="icon-button" type="button" data-close-settings aria-label="Закрыть настройки">${getIcon('close')}</button>
        </header>
        <div class="settings-body">
          <nav class="settings-nav" role="tablist" aria-label="Разделы настроек" aria-orientation="vertical">
            <button id="tab-appearance" class="settings-tab" type="button" role="tab" aria-selected="true" aria-controls="section-appearance" data-tab="appearance">${getIcon('appearance')}<span>Внешний вид</span></button>
            <button id="tab-modes" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-modes" tabindex="-1" data-tab="modes">${getIcon('modes')}<span>Режимы</span></button>
            <button id="tab-agent" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-agent" tabindex="-1" data-tab="agent">${getIcon('agent')}<span>Агенты</span></button>
            <button id="tab-workspace" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-workspace" tabindex="-1" data-tab="workspace">${getIcon('workspace')}<span>Рабочая область</span></button>
            <button id="tab-audio" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-audio" tabindex="-1" data-tab="audio">${getIcon('audio')}<span>Аудио</span></button>
            <button id="tab-screen" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-screen" tabindex="-1" data-tab="screen">${getIcon('screen')}<span>Захват экрана</span></button>
            <button id="tab-behavior" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-behavior" tabindex="-1" data-tab="behavior">${getIcon('behavior')}<span>Поведение</span></button>
            <button id="tab-journal" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-journal" tabindex="-1" data-tab="journal">${getIcon('journal')}<span>Журнал</span></button>
          </nav>
          <div class="settings-main">
            <section id="section-appearance" class="settings-section" role="tabpanel" aria-labelledby="tab-appearance">
              <h2>Внешний вид</h2>
              <p class="settings-description">Изменения сразу видны на панели ассистента.</p>
              <div class="color-targets" role="group" aria-label="Изменяемый цвет">
                <button class="color-target" type="button" data-color-target="panelColor" aria-pressed="true"><span class="color-target-dot" data-swatch="panelColor"></span>Цвет панели</button>
                <button class="color-target" type="button" data-color-target="textColor" aria-pressed="false"><span class="color-target-dot" data-swatch="textColor"></span>Цвет текста</button>
                <button class="color-target" type="button" data-color-target="accentColor" aria-pressed="false"><span class="color-target-dot" data-swatch="accentColor"></span>Акцентный цвет</button>
              </div>
              <div id="appearance-color-picker" class="color-picker"></div>
              <div class="settings-row">
                <div class="field-copy"><label for="setting-opacity">Непрозрачность</label><small>0% — прозрачная, 100% — плотная панель.</small></div>
                <div class="settings-control"><input id="setting-opacity" data-setting="opacity" type="range" min="0" max="100" step="1"/><output for="setting-opacity" data-value="opacity"></output></div>
              </div>
              <div class="settings-row">
                <div class="field-copy"><label for="setting-font-size">Размер шрифта</label><small>Текст ответов и пояснений.</small></div>
                <div class="settings-control"><input id="setting-font-size" data-setting="fontSize" type="range" min="12" max="22" step="1"/><output for="setting-font-size" data-value="fontSize"></output></div>
              </div>
            </section>
            <section id="section-modes" class="settings-section" role="tabpanel" aria-labelledby="tab-modes" hidden>
              <h2>Режимы</h2>
              <p class="settings-description">Выберите задачу ассистента и момент, когда ему нужно отвечать.</p>
              <div class="agent-field"><label for="agent-scenario">Режим</label><select id="agent-scenario" data-agent-setting="scenario"><option value="assistant">Голосовой помощник</option><option value="interview">Совещание и собеседование</option><option value="custom">Свой режим</option></select></div>
              <p id="mode-description" class="agent-field-note mode-description"></p>
              <div id="agent-custom-fields" class="agent-custom-fields" hidden>
                <div class="agent-field"><label for="agent-custom-name">Название режима</label><input id="agent-custom-name" data-agent-setting="custom_name" data-max-codepoints="64" type="text" maxlength="128" placeholder="Свой режим" aria-describedby="agent-custom-name-hint"/><p id="agent-custom-name-hint" class="agent-field-note">До 64 символов.</p></div>
                <div class="agent-field"><label for="agent-custom-instructions">Инструкция для ассистента</label><textarea id="agent-custom-instructions" data-agent-setting="custom_instructions" data-max-codepoints="12000" rows="5" maxlength="24000" placeholder="Какую роль выполнять и чем помогать?" aria-describedby="agent-custom-instructions-hint"></textarea><p id="agent-custom-instructions-hint" class="agent-field-note">До 12 000 символов. Можно использовать несколько строк.</p></div>
                <div class="agent-field"><label for="agent-custom-behavior">Когда отвечать</label><select id="agent-custom-behavior" data-agent-setting="custom_behavior"><option value="dialogue">После моей реплики</option><option value="selective">Когда нужна подсказка</option><option value="on_request">Только по моей просьбе</option></select></div>
              </div>
              <p id="mode-config-status" class="agent-field-note mode-config-status" role="status"></p>
              <section id="voice-panel" class="agent-scenario-card" aria-labelledby="voice-state">
                <div class="agent-listening-heading"><span class="agent-listening-dot" aria-hidden="true"></span><strong id="voice-state" role="status">Микрофон выключен</strong></div>
                <p id="voice-detail" class="agent-field-note">Ответы на ваши реплики появляются в основной панели.</p>
                <div class="agent-actions"><button id="voice-start" class="action-button" type="button">Включить эфир</button><button id="voice-stop" class="action-button secondary" type="button">Завершить эфир</button></div>
                <p id="voice-error" class="settings-message" role="status" hidden></p>
              </section>
              <section id="interview-panel" class="agent-scenario-card" aria-labelledby="interview-state" hidden>
                <div class="agent-listening-heading"><span class="agent-listening-dot" aria-hidden="true"></span><strong id="interview-state" role="status">Не слушаю</strong></div>
                <p id="interview-detail" class="agent-field-note">Подсказки по вопросам и задачам, обращённым к вам.</p>
                <p id="interview-source" class="agent-source-attribution"></p>
                <p id="interview-speaker-status" class="agent-field-note"></p>
                <div class="agent-actions"><button id="interview-start" class="action-button" type="button">Включить эфир</button><button id="interview-stop" class="action-button secondary" type="button">Завершить эфир</button></div>
                <p id="interview-error" class="settings-message" role="status" hidden></p>
              </section>
            </section>
            <section id="section-agent" class="settings-section" role="tabpanel" aria-labelledby="tab-agent" hidden>
              <h2>Агенты</h2>
              <p class="settings-description">Модели, возможности и задачи Codex. Ответы и код появляются в основной панели.</p>
              <div class="agent-field-grid">
                <div class="agent-field">
                  <div class="agent-field-heading"><label for="agent-model">Модель Codex</label><button id="agent-model-refresh" class="icon-button source-refresh" type="button" aria-label="Обновить модели Codex">${getIcon('reconnect')}</button></div>
                  <select id="agent-model" data-agent-setting="model" aria-describedby="agent-model-description agent-catalog-status"><option value="">По умолчанию Codex</option></select>
                  <p id="agent-model-description" class="agent-field-note"></p>
                </div>
                <div class="agent-field">
                  <label for="agent-effort">Глубина рассуждений</label><select id="agent-effort" data-agent-setting="effort" aria-describedby="agent-effort-description"><option value="">По умолчанию модели</option></select>
                  <p id="agent-effort-description" class="agent-field-note"></p>
                </div>
              </div>
              <p id="agent-catalog-status" class="agent-field-note agent-catalog-status" role="status"></p>
              <p id="agent-runtime" class="agent-runtime" role="status"></p>
              <p id="agent-error" class="settings-message" role="alert" hidden></p>
              <div class="agent-options">
                <button id="agent-web-search" class="setting-toggle" data-agent-setting="web_search" type="button" aria-pressed="true">Поиск в интернете</button>
                <button id="agent-parallel" class="setting-toggle" data-agent-setting="parallel" type="button" aria-pressed="true">Параллельные задачи</button>
                <button id="agent-realtime" class="setting-toggle" data-agent-setting="realtime" type="button" aria-pressed="true">Голос через Realtime</button>
              </div>
              <div class="agent-field"><label for="realtime-model">Модель Realtime</label><select id="realtime-model" aria-describedby="agent-realtime-status"><option value="gpt-realtime-2.1">gpt-realtime-2.1</option><option value="gpt-realtime-1.5">gpt-realtime-1.5</option></select><p id="agent-realtime-status" class="agent-field-note" role="status"></p></div>
              <div class="agent-actions"><button id="agent-connect" class="action-button" type="button">Подключить</button><button id="agent-disconnect" class="action-button secondary" type="button">Отключить</button></div>
              <form id="agent-task-form" class="agent-task-form">
                <label for="agent-prompt">Задача Codex</label>
                <textarea id="agent-prompt" rows="3" maxlength="16000" placeholder="Что нужно сделать в проекте?"></textarea>
                <div class="agent-actions"><button id="agent-send" class="action-button" type="submit">Отправить</button><button id="agent-interrupt" class="action-button secondary" type="button">Остановить</button></div>
              </form>
              <div id="agent-approvals" class="agent-requests" aria-live="polite"></div>
              <div id="agent-inputs" class="agent-requests" aria-live="polite"></div>
              <div id="agent-tasks" class="agent-tasks"></div>
            </section>
            <section id="section-workspace" class="settings-section" role="tabpanel" aria-labelledby="tab-workspace" hidden>
              <h2>Рабочая область</h2>
              <p class="settings-description">Codex работает в выбранной папке. Для временного сеанса создаётся отдельное пустое пространство.</p>
              <div class="agent-field"><label for="agent-workspace-mode">Рабочее пространство</label><select id="agent-workspace-mode" data-agent-setting="workspace_mode"><option value="temporary">Пустая временная папка</option><option value="project">Папка проекта</option></select></div>
              <div id="agent-project-field" class="agent-field">
                <label for="agent-workspace">Папка проекта</label>
                <div class="agent-path-control"><input id="agent-workspace" data-agent-setting="workspace" type="text" spellcheck="false" placeholder="Выберите папку проекта" /><button id="agent-workspace-choose" class="action-button secondary" type="button">Выбрать папку</button></div>
              </div>
              <div class="agent-workspace-state">
                <p id="agent-workspace-status" class="agent-field-note" role="status"></p>
                <p id="agent-workspace-current" class="agent-workspace-current" hidden><span id="agent-workspace-path-label"></span><code id="agent-workspace-path"></code></p>
                <button id="agent-workspace-clear" class="action-button secondary small" type="button">Удалить временные файлы</button>
              </div>
            </section>
            <section id="section-audio" class="settings-section" role="tabpanel" aria-labelledby="tab-audio" hidden>
              <h2>Аудио</h2>
              <p class="settings-description">Устройства, уровень звука и локальная проверка микрофона.</p>
              <p id="settings-runtime-error" class="settings-message" role="status" hidden></p>
              <div class="source-card microphone-card">
                <div class="source-card-heading"><div><h3>Мой микрофон</h3><p>Ваш голос учитывается отдельно от звука встречи. Устройство можно менять во время разговора.</p></div><button id="mic-refresh" class="icon-button source-refresh" type="button" aria-label="Обновить список микрофонов">${getIcon('reconnect')}</button></div>
                <label class="source-device-label" for="mic-device">Устройство ввода</label><select id="mic-device" aria-label="Микрофон"><option value="">Системный по умолчанию</option></select>
                <p id="mic-runtime" class="source-detail"></p>
                <div id="mic-monitor" class="mic-monitor" data-active="false" data-clipped="false">
                  <div class="mic-level-heading"><span id="mic-level-label">Микрофон выключен</span><output id="mic-level-value" aria-hidden="true">−60 дБ</output></div>
                  <div id="mic-level" class="mic-level" role="meter" aria-label="Уровень входящего звука" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60"><span id="mic-level-fill" class="mic-level-fill"></span></div>
                  <div class="mic-waveform" aria-hidden="true"><svg viewBox="0 0 480 64" preserveAspectRatio="none"><path class="mic-wave-center" d="M0 32H480"/><path id="mic-wave-path" class="mic-wave-path" d="M0 32H480"/></svg></div>
                </div>
                <div class="mic-test-row"><button id="mic-test" class="action-button secondary" type="button"><span id="mic-test-icon" aria-hidden="true">${getIcon('play')}</span><span id="mic-test-label">Проверить микрофон</span></button><p id="mic-test-status" class="mic-test-status" role="status">Локальная проверка на 20 секунд.</p></div>
                <div class="mic-noise-row"><div class="mic-noise-copy"><label for="mic-noise-suppression">Шумоподавление</label><small>Убирает постоянный фоновый шум. По умолчанию выключено.</small></div><button id="mic-noise-suppression" class="setting-toggle" type="button" aria-label="Шумоподавление" aria-pressed="false"><span data-toggle-state>Выключено</span></button></div>
                <p id="mic-error" class="mic-error" role="status" hidden></p>
              </div>
              <div class="source-card system-audio-card">
                <div class="source-card-heading"><div><h3>Звук встречи</h3><p>Устройство, через которое слышны участники. Учитывается весь звук этого устройства, включая другие приложения.</p></div><button id="system-audio-refresh" class="icon-button source-refresh" type="button" aria-label="Обновить список устройств вывода">${getIcon('reconnect')}</button></div>
                <label class="source-device-label" for="system-audio-device">Устройство воспроизведения</label><select id="system-audio-device" aria-label="Устройство звука встречи"><option value="">Системный по умолчанию</option></select>
                <p id="system-audio-runtime" class="source-detail" role="status"></p>
                <div id="system-audio-monitor" class="mic-monitor" data-active="false" data-clipped="false">
                  <div class="mic-level-heading"><span id="system-audio-level-label">Звук встречи выключен</span><output id="system-audio-level-value" aria-hidden="true">−60 дБ</output></div>
                  <div id="system-audio-level" class="mic-level" role="meter" aria-label="Уровень звука встречи" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60"><span id="system-audio-level-fill" class="mic-level-fill"></span></div>
                  <div class="mic-waveform" aria-hidden="true"><svg viewBox="0 0 480 64" preserveAspectRatio="none"><path class="mic-wave-center" d="M0 32H480"/><path id="system-audio-wave-path" class="mic-wave-path" d="M0 32H480"/></svg></div>
                </div>
                <p id="system-audio-error" class="mic-error" role="status" hidden></p>
              </div>
            </section>
            <section id="section-screen" class="settings-section" role="tabpanel" aria-labelledby="tab-screen" hidden>
              <h2>Захват экрана</h2>
              <p class="settings-description">Видимость окна при демонстрации и передача изображения ассистенту.</p>
              <div class="source-card">
                <h3>Видимость окна</h3><p>Обычный режим показывает окно в демонстрации экрана и на панели задач.</p>
                <div class="screen-mode-control"><button id="screen-window-mode" class="setting-toggle" type="button" aria-pressed="false">${getIcon('window-standard')}Обычное окно</button></div>
                <p id="screen-window-status" class="source-detail" role="status"></p>
              </div>
              <div class="source-card">
                <h3>Изображение для ассистента</h3><p id="screen-capture-status">Передача изображения экрана пока не подключена.</p>
                <div class="screen-mode-control"><button id="screen-capture" class="setting-toggle" type="button" aria-pressed="false" aria-describedby="screen-capture-status" disabled>${getIcon('screen')}Передавать экран</button></div>
              </div>
            </section>
            <section id="section-behavior" class="settings-section" role="tabpanel" aria-labelledby="tab-behavior" hidden>
              <h2>Поведение</h2>
              <p class="settings-description">Прокрутка и размер панели во время ответа.</p>
              <div class="settings-row">
                <div class="field-copy"><label for="setting-scroll-lock">Блокировка прокрутки</label><small>Колёсико не перемещает текст в оверлее.</small></div>
                <button id="setting-scroll-lock" class="setting-toggle" data-setting="scrollLocked" type="button" aria-label="Блокировка прокрутки" aria-pressed="false"><span data-toggle-state>Выключено</span></button>
              </div>
              <div class="settings-row">
                <div class="field-copy"><label for="setting-auto-scroll">Следовать за ответом</label><small>После ручной прокрутки вверх позиция сохраняется.</small></div>
                <button id="setting-auto-scroll" class="setting-toggle" data-setting="autoScroll" type="button" aria-label="Следовать за ответом" aria-pressed="false"><span data-toggle-state>Выключено</span></button>
              </div>
              <div class="settings-row">
                <div class="field-copy"><label for="setting-max-height">Максимальная высота</label><small>Доля доступной высоты экрана.</small></div>
                <div class="settings-control"><input id="setting-max-height" data-setting="maxHeightPercent" type="range" min="40" max="85" step="1"/><output for="setting-max-height" data-value="maxHeightPercent"></output></div>
              </div>
              <p class="settings-hint">Нижняя граница остаётся на месте: панель растёт вверх. Код и пояснения прокручиваются независимо.</p>
              <section class="behavior-broadcast" aria-labelledby="behavior-broadcast-title">
                <h3 id="behavior-broadcast-title">Эфир</h3>
                <p class="agent-field-note">После завершения эфир включается вручную.</p>
                <div class="agent-field"><label for="agent-silence-timeout">Завершать после тишины</label><select id="agent-silence-timeout" data-agent-setting="silence_timeout_secs"><option value="0">Не завершать</option><option value="60">1 минута</option><option value="180">3 минуты</option><option value="300">5 минут</option><option value="600">10 минут</option><option value="900">15 минут</option><option value="1800">30 минут</option><option value="3600">1 час</option></select></div>
                <div class="settings-row"><div class="field-copy"><label for="agent-auto-end">Завершение ассистентом</label><small>Ассистент может закончить эфир, когда разговор завершён.</small></div><button id="agent-auto-end" class="setting-toggle" data-agent-setting="agent_auto_end" type="button" aria-label="Завершение эфира ассистентом" aria-pressed="true"><span data-toggle-state>Включено</span></button></div>
              </section>
            </section>
            <section id="section-journal" class="settings-section" role="tabpanel" aria-labelledby="tab-journal" hidden>
              <h2>Журнал</h2>
              <p class="settings-description">Действия агента, состояние подключения и сообщения.</p>
              <div class="agent-actions journal-actions"><button id="journal-copy" class="action-button secondary" type="button">Копировать</button><button id="journal-clear" class="action-button secondary" type="button">Очистить</button></div>
              <p id="journal-status" class="agent-field-note journal-status" role="status"></p>
              <p id="journal-empty" class="settings-hint">В журнале пока нет записей.</p>
              <div id="agent-log" class="agent-log" role="log" aria-label="Ход работы" aria-live="polite"></div>
            </section>
          </div>
        </div>
      </section>
    </div>
  `;
  const backdrop = host.querySelector('#settings-backdrop');
  const dialog = host.querySelector('#settings-dialog');
  const runtimeError = host.querySelector('#settings-runtime-error');
  const agentSettings = createAgentSettings({ host, bridge, getRuntimeState, closeModal: () => close() });
  const picker = createColorPicker(host.querySelector('#appearance-color-picker'), {
    value: current.panelColor,
    onChange(hex) { update({ [colorTarget]: hex }, false); },
  });

  function renderValues(refreshPicker = true) {
    for (const input of host.querySelectorAll('[data-setting]')) {
      const key = input.dataset.setting;
      if (input.matches('button[aria-pressed]')) {
        input.setAttribute('aria-pressed', String(Boolean(current[key])));
        input.querySelector('[data-toggle-state]').textContent = current[key] ? 'Включено' : 'Выключено';
      } else input.value = current[key];
    }
    for (const output of host.querySelectorAll('[data-value]')) {
      const key = output.dataset.value;
      output.value = `${current[key]}${key === 'fontSize' ? ' px' : '%'}`;
      output.textContent = output.value;
    }
    for (const swatch of host.querySelectorAll('[data-swatch]')) swatch.style.backgroundColor = current[swatch.dataset.swatch];
    for (const target of host.querySelectorAll('[data-color-target]')) target.setAttribute('aria-pressed', String(target.dataset.colorTarget === colorTarget));
    if (refreshPicker) picker.setValue(current[colorTarget]);
    const runtime = getRuntimeState() || {};
    const message = runtime.lastError || runtime.message || '';
    runtimeError.textContent = typeof message === 'string' ? message : '';
    runtimeError.hidden = !runtimeError.textContent;
    agentSettings.refresh();
  }

  function update(patch, refreshPicker = true) {
    current = normalizeSettings({ ...current, ...patch });
    renderValues(refreshPicker);
    // Updates can persist asynchronously; surface failures inside settings only.
    Promise.resolve(onChange?.({ ...current })).catch((error) => {
      runtimeError.textContent = `Не удалось сохранить настройки: ${error instanceof Error ? error.message : String(error)}`;
      runtimeError.hidden = false;
    });
  }

  function selectTab(tab, focus = false) {
    const nextTab = TABS.includes(tab) ? tab : 'appearance';
    if (activeTab === 'audio' && nextTab !== 'audio') void agentSettings.stopMicrophoneTest();
    activeTab = nextTab;
    for (const button of host.querySelectorAll('[data-tab]')) {
      const active = button.dataset.tab === activeTab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    for (const tabName of TABS) host.querySelector(`#section-${tabName}`).hidden = tabName !== activeTab;
    host.querySelector('.settings-main').scrollTop = 0;
    agentSettings.setAudioVisible(opened && activeTab === 'audio');
    if (activeTab === 'appearance') requestAnimationFrame(() => picker.refresh());
  }

  async function open(tab = 'appearance', request = null) {
    ++visibilityVersion;
    current = normalizeSettings(getSettings());
    renderValues();
    selectTab(tab);
    if (!opened) {
      opened = true;
      previousFocus = standalone ? null : document.activeElement;
      backdrop.hidden = false;
      agentSettings.setAudioVisible(activeTab === 'audio');
      if (!standalone && overlay) overlay.inert = true;
      document.body.classList.add('settings-open');
      settingsButton?.setAttribute('aria-expanded', 'true');
      await onOpenChange?.(true);
      if (!opened) return;
    }
    requestAnimationFrame(() => {
      if (!opened) return;
      const container = request?.kind === 'approval' ? '#agent-approvals' : request?.kind === 'input' ? '#agent-inputs' : null;
      const card = activeTab === 'agent' && container
        ? [...host.querySelector(container).children].find(item => item.dataset.requestId === String(request.id))
        : null;
      if (card) {
        // Reveal a new blocking request without focusing a consent button.
        card.tabIndex = -1;
        card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        card.focus({ preventScroll: true });
      } else host.querySelector(`[data-tab="${activeTab}"]`).focus({ preventScroll: true });
      picker.refresh();
    });
  }

  async function close({ notify = true } = {}) {
    if (!opened) return;
    const version = ++visibilityVersion;
    void agentSettings.stopMicrophoneTest();
    // Keep the independent form usable if a native close request fails. A later
    // open/close event supersedes this request while it crosses the window bridge.
    if (standalone && notify) {
      await onOpenChange?.(false);
      if (visibilityVersion !== version) return;
    }
    opened = false;
    backdrop.hidden = true;
    agentSettings.setAudioVisible(false);
    if (!standalone && overlay) overlay.inert = false;
    document.body.classList.remove('settings-open');
    settingsButton?.setAttribute('aria-expanded', 'false');
    if (!standalone && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    if (!standalone && notify) await onOpenChange?.(false);
  }

  host.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    const colorButton = event.target.closest('[data-color-target]');
    const toggle = event.target.closest('button[data-setting][aria-pressed]');
    if (toggle && !toggle.disabled) update({ [toggle.dataset.setting]: !current[toggle.dataset.setting] }, false);
    if (tab) selectTab(tab.dataset.tab);
    if (colorButton) { colorTarget = colorButton.dataset.colorTarget; renderValues(); }
    if (event.target.closest('[data-close-settings]') || (!standalone && event.target === backdrop)) {
      void close().catch(error => bridge?.reportError(error));
    }
  }, { signal: abort.signal });

  host.addEventListener('input', (event) => {
    const key = event.target.dataset.setting;
    if (key && event.target.type === 'range') update({ [key]: Number(event.target.value) }, false);
  }, { signal: abort.signal });

  host.querySelector('.settings-nav').addEventListener('keydown', (event) => {
    const index = TABS.indexOf(activeTab);
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault(); selectTab(TABS[(index + 1) % TABS.length], true);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault(); selectTab(TABS[(index + TABS.length - 1) % TABS.length], true);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); selectTab(event.key === 'Home' ? TABS[0] : TABS.at(-1), true);
    }
  }, { signal: abort.signal });

  document.addEventListener('keydown', (event) => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close().catch(error => bridge?.reportError(error)); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, a[href], [tabindex="0"]')]
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, { signal: abort.signal });

  renderValues();
  return {
    open,
    close,
    refresh() { current = normalizeSettings(getSettings()); renderValues(); },
    updateAudioLevels(levels) { agentSettings.updateAudioLevels(levels); },
    get isOpen() { return opened; },
    destroy() { void close({ notify: !standalone }).catch(() => {}); abort.abort(); picker.destroy(); agentSettings.destroy(); host.replaceChildren(); },
  };
}
