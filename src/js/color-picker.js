import { normalizeHex } from './settings.js';

export function hexToRgb(hex) {
  const normalized = normalizeHex(hex, '#000000');
  return normalized.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16));
}

export function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
  }
  return { h: (hue + 360) % 360, s: max ? delta / max : 0, v: max };
}

export function hsvToHex({ h, s, v }) {
  const hue = ((h % 360) + 360) % 360;
  const saturation = Math.max(0, Math.min(1, s));
  const value = Math.max(0, Math.min(1, v));
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const base = value - chroma;
  const components = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0]
    : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma]
      : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${components.map((channel) => Math.round((channel + base) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function hslDescription(hsv) {
  const lightness = hsv.v * (1 - hsv.s / 2);
  const saturation = lightness === 0 || lightness === 1 ? 0 : (hsv.v - lightness) / Math.min(lightness, 1 - lightness);
  return `${Math.round(hsv.h)}°, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%`;
}

/** Canvas is visual; HEX and arrow keys provide equivalent keyboard controls. */
export function createColorPicker(container, { value = '#202329', onChange }) {
  container.innerHTML = `
    <div class="color-picker-square-row">
      <div class="color-preview" aria-hidden="true"></div>
      <div class="color-square-wrap">
        <canvas class="color-square" tabindex="0" role="slider" aria-label="Насыщенность и яркость цвета. Стрелки меняют значение." aria-valuemin="0" aria-valuemax="100"></canvas>
        <span class="color-cursor" aria-hidden="true"></span>
      </div>
    </div>
    <input class="color-hue" type="range" min="0" max="359" step="1" aria-label="Оттенок цвета" />
    <div class="hex-field"><label for="picker-hex">HEX</label><input id="picker-hex" type="text" spellcheck="false" autocomplete="off" maxlength="7" aria-describedby="picker-hex-error" /></div>
    <p id="picker-hex-error" class="field-error" hidden>Введите цвет в формате #RRGGBB.</p>
    <div class="color-readout"><span class="rgb-readout"></span><span class="hsl-readout"></span></div>
  `;
  const canvas = container.querySelector('canvas');
  const context = canvas.getContext('2d');
  const cursor = container.querySelector('.color-cursor');
  const hueInput = container.querySelector('.color-hue');
  const hexInput = container.querySelector('#picker-hex');
  const preview = container.querySelector('.color-preview');
  const error = container.querySelector('.field-error');
  const abort = new AbortController();
  let hsv = rgbToHsv(hexToRgb(value));
  let dragging = false;

  function paint() {
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
    context.fillStyle = `hsl(${hsv.h} 100% 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const horizontal = context.createLinearGradient(0, 0, canvas.width, 0);
    horizontal.addColorStop(0, '#fff'); horizontal.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = horizontal; context.fillRect(0, 0, canvas.width, canvas.height);
    const vertical = context.createLinearGradient(0, 0, 0, canvas.height);
    vertical.addColorStop(0, 'rgba(0,0,0,0)'); vertical.addColorStop(1, '#000');
    context.fillStyle = vertical; context.fillRect(0, 0, canvas.width, canvas.height);
  }

  function sync({ notify = false, repaint = true } = {}) {
    const hex = hsvToHex(hsv);
    if (repaint) paint();
    cursor.style.left = `${hsv.s * 100}%`;
    cursor.style.top = `${(1 - hsv.v) * 100}%`;
    hueInput.value = Math.round(hsv.h);
    hueInput.style.setProperty('--hue-thumb', `hsl(${hsv.h} 100% 50%)`);
    hexInput.value = hex;
    hexInput.setAttribute('aria-invalid', 'false');
    error.hidden = true;
    preview.style.backgroundColor = hex;
    canvas.setAttribute('aria-valuenow', String(Math.round(hsv.s * 100)));
    canvas.setAttribute('aria-valuetext', `Насыщенность ${Math.round(hsv.s * 100)}%, яркость ${Math.round(hsv.v * 100)}%`);
    container.querySelector('.rgb-readout').textContent = `RGB ${hexToRgb(hex).join(', ')}`;
    container.querySelector('.hsl-readout').textContent = `HSL ${hslDescription(hsv)}`;
    if (notify) onChange?.(hex);
  }

  function selectAt(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    hsv.s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    hsv.v = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    sync({ notify: true, repaint: false });
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
    selectAt(event);
  }, { signal: abort.signal });
  canvas.addEventListener('pointermove', (event) => { if (dragging) selectAt(event); }, { signal: abort.signal });
  canvas.addEventListener('pointerup', () => { dragging = false; }, { signal: abort.signal });
  canvas.addEventListener('pointercancel', () => { dragging = false; }, { signal: abort.signal });
  canvas.addEventListener('lostpointercapture', () => { dragging = false; }, { signal: abort.signal });
  canvas.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? .1 : .01;
    if (event.key === 'ArrowRight') hsv.s = Math.min(1, hsv.s + step);
    if (event.key === 'ArrowLeft') hsv.s = Math.max(0, hsv.s - step);
    if (event.key === 'ArrowUp') hsv.v = Math.min(1, hsv.v + step);
    if (event.key === 'ArrowDown') hsv.v = Math.max(0, hsv.v - step);
    sync({ notify: true, repaint: false });
  }, { signal: abort.signal });
  hueInput.addEventListener('input', () => { hsv.h = Number(hueInput.value); sync({ notify: true }); }, { signal: abort.signal });

  function acceptHex() {
    const hex = normalizeHex(hexInput.value);
    if (!hex) {
      hexInput.setAttribute('aria-invalid', 'true');
      error.hidden = false;
      return;
    }
    hsv = rgbToHsv(hexToRgb(hex));
    sync({ notify: true });
  }
  hexInput.addEventListener('change', acceptHex, { signal: abort.signal });
  hexInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); acceptHex(); } }, { signal: abort.signal });
  const observer = new ResizeObserver(() => paint());
  observer.observe(canvas);
  sync();
  return {
    setValue(hex) { hsv = rgbToHsv(hexToRgb(hex)); sync(); },
    refresh() { paint(); },
    destroy() { abort.abort(); observer.disconnect(); container.replaceChildren(); },
  };
}
