const STALE_MS = 800;
const CLIPPING_HOLD_MS = 500;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const amplitude = value => typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : 0;

/** Real input samples only: no idle animation, generated bars or AGC display. */
export function audioLevelView(levels = {}, enabled = true, now = Date.now()) {
  const stale = Boolean(enabled && levels?.active && (!Number.isFinite(levels.at) || now - levels.at >= STALE_MS));
  const active = Boolean(enabled && levels?.active === true && !stale);
  const rms = active ? amplitude(levels.rawRms ?? levels.rms) : 0;
  const peak = active ? amplitude(levels.inputPeak ?? levels.peak) : 0;
  const db = Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(rms, 0.000001))));
  const percent = active ? (db + 60) / 60 * 100 : 0;
  const clipped = active && (peak >= 0.985 || amplitude(levels.clippedRatio) > 0.01);
  const waveform = active && Array.isArray(levels.waveform)
    ? levels.waveform.slice(0, 160).map(value => Number.isFinite(value) ? clamp(value, -1, 1) : 0)
    : [];
  // Magnify the shape of quiet speech, while the dB meter keeps its raw scale.
  // Ambient input below the silence floor is never visually amplified.
  const waveformPeak = waveform.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const waveformGain = rms >= 0.004 ? clamp(0.65 / Math.max(waveformPeak, 0.000001), 1, 16) : 1;
  const path = waveform.length > 1
    ? waveform.map((value, index) => (index ? 'L' : 'M') + (index * 480 / (waveform.length - 1)).toFixed(1) + ' ' + (32 - value * waveformGain * 28).toFixed(1)).join(' ')
    : 'M0 32H480';
  return {
    active, stale, clipped, percent, db: Math.round(db),
    value: active && rms > 0.001 ? Math.round(db) + ' дБ' : '−60 дБ',
    label: stale ? 'Нет сигнала' : !active ? 'Микрофон выключен' : clipped ? 'Слишком громко' : rms < 0.004 ? 'Тишина' : 'Входящий звук',
    path,
  };
}

/** One timeout per visible display; only these few meter nodes are updated. */
function createAudioDisplay(render, document) {
  let levels = null;
  let enabled = false;
  let visible = true;
  let destroyed = false;
  let timer;
  let clippingUntil = 0;
  function clearTimer() { clearTimeout(timer); timer = undefined; }
  function draw() {
    clearTimer();
    if (destroyed || !visible || document.hidden) return;
    const now = Date.now();
    const view = audioLevelView(levels, enabled, now);
    if (!view.active) clippingUntil = 0;
    else if (clippingUntil > now) { view.clipped = true; view.label = 'Слишком громко'; }
    render(view);
    if (view.active) {
      const due = Math.min(levels.at + STALE_MS, clippingUntil > now ? clippingUntil : Infinity);
      timer = setTimeout(draw, Math.max(1, due - now));
    }
  }
  function visibilityChanged() {
    clearTimer();
    if (document.hidden) {
      clippingUntil = 0;
      if (visible) render(audioLevelView(null, false));
    } else draw();
  }
  document.addEventListener('visibilitychange', visibilityChanged);
  return {
    update(next, runtime = {}) {
      if (destroyed) return;
      levels = next;
      enabled = Boolean(runtime.microphoneTesting || !runtime.microphoneMuted);
      const now = Date.now();
      const view = audioLevelView(levels, enabled, now);
      if (!view.active || !visible || document.hidden) clippingUntil = 0;
      else if (view.clipped) clippingUntil = Math.max(clippingUntil, Math.min(levels.at, now) + CLIPPING_HOLD_MS);
      draw();
    },
    setVisible(value) {
      visible = Boolean(value);
      if (!visible) { clearTimer(); clippingUntil = 0; }
      else draw();
    },
    destroy() {
      destroyed = true;
      clearTimer();
      document.removeEventListener('visibilitychange', visibilityChanged);
    },
  };
}

export function createMicrophoneMeter(host, { prefix = 'mic', idleLabel = 'Микрофон выключен' } = {}) {
  const find = suffix => host.querySelector('#' + prefix + '-' + suffix);
  const meter = find('level');
  const fill = find('level-fill');
  const value = find('level-value');
  const label = find('level-label');
  const wave = find('wave-path');
  const panel = find('monitor');
  return createAudioDisplay(view => {
    if (!meter) return;
    const labelText = !view.active && !view.stale ? idleLabel : view.label;
    meter.setAttribute('aria-valuenow', String(view.db));
    meter.setAttribute('aria-valuetext', view.value + '. ' + labelText);
    fill.style.transform = 'scaleX(' + (view.percent / 100).toFixed(3) + ')';
    value.textContent = view.value;
    label.textContent = labelText;
    wave.setAttribute('d', view.path);
    panel.dataset.active = String(view.active);
    panel.dataset.clipped = String(view.clipped);
  }, host.ownerDocument);
}

export function createMicrophoneIndicator(button) {
  return createAudioDisplay(view => {
    let indicator = button.querySelector('.microphone-indicator');
    if (!indicator) {
      indicator = button.ownerDocument.createElement('span');
      indicator.className = 'microphone-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      indicator.append(button.ownerDocument.createElement('span'));
      button.append(indicator);
    }
    button.dataset.audioActive = String(view.active);
    button.dataset.audioClipped = String(view.clipped);
    indicator.firstElementChild.style.transform = 'scaleX(' + (view.percent / 100).toFixed(3) + ')';
  }, button.ownerDocument);
}


/** Normal mode mirrors the mic; interview mode keeps mic left, meeting right.
 * Displays consume existing frames only and have bounded stale-frame timers.
 */
/** The toolbar shows the freshest usable source with the louder input level.
 * Muting the microphone never hides meeting audio; the mic button stays separate.
 */
export function selectToolbarAudio(runtime = {}, now = Date.now()) {
  let chosen = null;
  let strength = -1;
  let source = '';
  for (const [name, levels, enabled] of [
    ['microphone', runtime.microphoneLevels, Boolean(runtime.microphoneTesting || !runtime.microphoneMuted)],
    ['system', runtime.systemAudioLevels, Boolean(runtime.systemAudioActive)],
  ]) {
    const view = audioLevelView(levels, enabled, now);
    if (view.active && (view.percent > strength || view.percent === strength && levels.at > (chosen?.at ?? 0))) {
      chosen = levels; strength = view.percent; source = name;
    }
  }
  return { levels: chosen, source, microphoneMuted: !chosen, toolbarSharedAudio: true };
}

export function createToolbarAudioIndicator(toolbar) {
  const sides = [...toolbar.querySelectorAll('[data-toolbar-audio]')].map(panel => {
    const wave = panel.querySelector('.toolbar-audio-wave');
    const level = panel.querySelector('.toolbar-audio-level');
    return createAudioDisplay(view => {
      const signal = view.active && view.percent > 0;
      const strength = signal ? view.percent / 100 : 0;
      panel.dataset.active = String(signal);
      panel.dataset.clipped = String(signal && view.clipped);
      panel.style.opacity = signal ? (0.25 + 0.45 * Math.sqrt(strength)).toFixed(3) : '0';
      wave.setAttribute('d', signal ? view.path : 'M0 32H480');
      level.setAttribute('x1', (240 - strength * 228).toFixed(1));
      level.setAttribute('x2', (240 + strength * 228).toFixed(1));
    }, toolbar.ownerDocument);
  });
  return {
    update(levels, runtime = {}) {
      if (runtime.toolbarSharedAudio) {
        for (const side of sides) side.update(levels, runtime);
        return;
      }
      sides[0]?.update(levels, runtime);
      const separate = runtime.systemAudioActive || ['starting', 'listening', 'evaluating', 'helping'].includes(runtime.interviewState?.stage);
      sides[1]?.update(separate ? runtime.systemAudioLevels : levels, separate
        ? { microphoneMuted: !runtime.systemAudioActive } : runtime);
    },
    setVisible(visible) { for (const side of sides) side.setVisible(visible); },
    destroy() { for (const side of sides) side.destroy(); },
  };
}
