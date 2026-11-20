import { createColorPicker } from './color-picker.js';
import { getIcon } from './icons.js';
import { normalizeSettings } from './settings.js';
import { createAgentSettings } from './agent-settings.js';

const TABS = ['appearance', 'behavior', 'sources', 'agent'];

/** Settings and agent controls share the native overlay modal. */
export function createSettingsModal({ getSettings, onChange, onOpenChange, getRuntimeState = () => ({}), bridge }) {
  const host = document.getElementById('settings-root');
  const overlay = document.getElementById('overlay');
  const settingsButton = document.querySelector('[data-action="settings"]');
  const abort = new AbortController();
  let opened = false;
  let activeTab = 'appearance';
  let colorTarget = 'panelColor';
  let previousFocus = null;
  let current = normalizeSettings(getSettings());

  host.innerHTML = `
    <div id="settings-backdrop" class="settings-backdrop" hidden>
      <section id="settings-dialog" class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1">
        <header class="settings-header">
          ${getIcon('settings')}<h1 id="settings-title">Настройки</h1>
          <button class="icon-button" type="button" data-close-settings aria-label="Закрыть настройки">${getIcon('close')}</button>
        </header>
        <div class="settings-body">
          <nav class="settings-nav" role="tablist" aria-label="Разделы настроек" aria-orientation="vertical">
            <button id="tab-appearance" class="settings-tab" type="button" role="tab" aria-selected="true" aria-controls="section-appearance" data-tab="appearance">${getIcon('appearance')}<span>Внешний вид</span></button>
            <button id="tab-behavior" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-behavior" tabindex="-1" data-tab="behavior">${getIcon('behavior')}<span>Поведение</span></button>
            <button id="tab-sources" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-sources" tabindex="-1" data-tab="sources">${getIcon('sources')}<span>Источники</span></button>
            <button id="tab-agent" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="section-agent" tabindex="-1" data-tab="agent">${getIcon('behavior')}<span>Агент</span></button>
          </nav>
          <div class="settings-main">
            <section id="section-appearance" class="settings-section" role="tabpanel" aria-labelledby="tab-appearance">
              <h2>Внешний вид</h2>
              <p class="settings-description">Изменения сразу видны на панели ассистента.</p>
              <div class="color-targets" role="group" aria-label="Изменяемый цвет">
                <button class="color-target" type="button" data-color-target="panelColor" aria-pressed="true"><span class="color-target-dot" data-swatch="panelColor"></span>Цвет панели</button>
                <button class="color-target" type="button" data-color-target="textColor" aria-pressed="false"><span class="color-target-dot" data-swatch="textColor"></span>Цвет текста</button>
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
            <section id="section-behavior" class="settings-section" role="tabpanel" aria-labelledby="tab-behavior" hidden>
              <h2>Поведение</h2>
              <p class="settings-description">Прокрутка и размер панели во время ответа.</p>
              <div class="settings-row">
                <div class="field-copy"><label for="setting-scroll-lock">Блокировка прокрутки</label><small>Колёсико не перемещает текст в оверлее.</small></div>
                <label class="switch"><input id="setting-scroll-lock" data-setting="scrollLocked" type="checkbox"/><span class="switch-track" aria-hidden="true"></span></label>
              </div>
              <div class="settings-row">
                <div class="field-copy"><label for="setting-auto-scroll">Следовать за ответом</label><small>После ручной прокрутки вверх позиция сохраняется.</small></div>
                <label class="switch"><input id="setting-auto-scroll" data-setting="autoScroll" type="checkbox"/><span class="switch-track" aria-hidden="true"></span></label>
              </div>
              <div class="settings-row">
                <div class="field-copy"><label for="setting-max-height">Максимальная высота</label><small>Доля доступной высоты экрана.</small></div>
                <div class="settings-control"><input id="setting-max-height" data-setting="maxHeightPercent" type="range" min="40" max="85" step="1"/><output for="setting-max-height" data-value="maxHeightPercent"></output></div>
              </div>
              <p class="settings-hint">Нижняя граница остаётся на месте: панель растёт вверх. Код и пояснения прокручиваются независимо.</p>
            </section>
            <section id="section-sources" class="settings-section" role="tabpanel" aria-labelledby="tab-sources" hidden>
              <h2>Источники</h2>
              <p class="settings-description">Аудио, экран и подключение модели.</p>
              <p id="settings-runtime-error" class="settings-message" role="status" hidden></p>
              <div class="source-card"><h3>Микрофон</h3><p>Системный источник выбирается по умолчанию. Устройство можно менять во время разговора.</p><select id="mic-device" aria-label="Микрофон"><option value="">Системный по умолчанию</option></select><p id="mic-runtime" class="source-detail"></p></div>
              <div class="source-card"><h3>Realtime</h3><p>Речь и ответы после естественной паузы. Микрофон остаётся включённым.</p><select id="realtime-model" aria-label="Модель Realtime"><option value="gpt-realtime-2.1">gpt-realtime-2.1</option><option value="gpt-realtime-1.5">gpt-realtime-1.5</option></select></div>
              <div class="source-card"><h3>Системный звук и экран</h3><p>Сейчас используется выбранный микрофон. Захват системного звука и изображения ещё не подключён.</p></div>
            </section>
            <section id="section-agent" class="settings-section" role="tabpanel" aria-labelledby="tab-agent" hidden>
              <h2>Агент</h2>
              <p class="settings-description">Codex работает в указанном проекте через вход в ChatGPT. Ответы и код появляются в основной панели.</p>
              <p id="agent-runtime" class="agent-runtime" role="status"></p>
              <p id="agent-error" class="settings-message" role="alert" hidden></p>
              <div class="agent-field"><label for="agent-workspace">Рабочая папка</label><input id="agent-workspace" data-agent-setting="workspace" type="text" spellcheck="false" placeholder="F:\\project" /></div>
              <div class="agent-field-grid">
                <div class="agent-field"><label for="agent-model">Модель Codex</label><select id="agent-model" data-agent-setting="model"><option value="">По умолчанию Codex</option></select></div>
                <div class="agent-field"><label for="agent-effort">Глубина рассуждений</label><select id="agent-effort" data-agent-setting="effort"><option value="">По умолчанию модели</option></select></div>
              </div>
              <div class="agent-options">
                <label><input id="agent-web-search" data-agent-setting="web_search" type="checkbox" checked /> Поиск в интернете</label>
                <label><input id="agent-parallel" data-agent-setting="parallel" type="checkbox" checked /> Параллельные задачи</label>
                <label><input id="agent-realtime" data-agent-setting="realtime" type="checkbox" checked /> Голос через Realtime</label>
              </div>
              <div class="agent-actions"><button id="agent-connect" class="action-button" type="button">Подключить</button><button id="agent-disconnect" class="action-button secondary" type="button">Отключить</button></div>
              <form id="agent-task-form" class="agent-task-form">
                <label for="agent-prompt">Задача Codex</label>
                <textarea id="agent-prompt" rows="3" maxlength="16000" placeholder="Что нужно сделать в проекте?"></textarea>
                <div class="agent-actions"><button id="agent-send" class="action-button" type="submit">Отправить</button><button id="agent-interrupt" class="action-button secondary" type="button">Остановить</button></div>
              </form>
              <div id="agent-approvals" class="agent-requests" aria-live="polite"></div>
              <div id="agent-inputs" class="agent-requests" aria-live="polite"></div>
              <div id="agent-tasks" class="agent-tasks"></div>
              <details class="agent-history"><summary>Ход работы</summary><div id="agent-log" class="agent-log" role="log" aria-live="polite"></div></details>
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
      if (input.type === 'checkbox') input.checked = current[key];
      else input.value = current[key];
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
    activeTab = TABS.includes(tab) ? tab : 'appearance';
    for (const button of host.querySelectorAll('[data-tab]')) {
      const active = button.dataset.tab === activeTab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    for (const tabName of TABS) host.querySelector(`#section-${tabName}`).hidden = tabName !== activeTab;
    host.querySelector('.settings-main').scrollTop = 0;
    if (activeTab === 'appearance') requestAnimationFrame(() => picker.refresh());
  }

  async function open(tab = 'appearance', request = null) {
    current = normalizeSettings(getSettings());
    renderValues();
    selectTab(tab);
    if (!opened) {
      opened = true;
      previousFocus = document.activeElement;
      backdrop.hidden = false;
      overlay.inert = true;
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

  async function close() {
    if (!opened) return;
    opened = false;
    backdrop.hidden = true;
    overlay.inert = false;
    document.body.classList.remove('settings-open');
    settingsButton?.setAttribute('aria-expanded', 'false');
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    await onOpenChange?.(false);
  }

  host.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    const colorButton = event.target.closest('[data-color-target]');
    if (tab) selectTab(tab.dataset.tab);
    if (colorButton) { colorTarget = colorButton.dataset.colorTarget; renderValues(); }
    if (event.target.closest('[data-close-settings]') || event.target === backdrop) void close();
  }, { signal: abort.signal });

  host.addEventListener('input', (event) => {
    const key = event.target.dataset.setting;
    if (key) update({ [key]: event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value) }, false);
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
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close(); return; }
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
    get isOpen() { return opened; },
    destroy() { void close(); abort.abort(); picker.destroy(); agentSettings.destroy(); host.replaceChildren(); },
  };
}
