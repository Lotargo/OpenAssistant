export const DEFAULT_SETTINGS = Object.freeze({
  panelColor: '#202329',
  textColor: '#F5F7FA',
  accentColor: '#C0392B',
  opacity: 50,
  fontSize: 15,
  maxHeightPercent: 70,
  autoScroll: true,
  scrollLocked: false,
});

export function normalizeHex(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const hex = value.trim().replace(/^#/, '');
  if (/^[\da-f]{6}$/i.test(hex)) return `#${hex.toUpperCase()}`;
  if (/^[\da-f]{3}$/i.test(hex)) return `#${[...hex].map((digit) => digit.repeat(2)).join('').toUpperCase()}`;
  return fallback;
}

function numberWithin(value, fallback, min, max) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

export function normalizeSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    panelColor: normalizeHex(source.panelColor, DEFAULT_SETTINGS.panelColor),
    textColor: normalizeHex(source.textColor, DEFAULT_SETTINGS.textColor),
    accentColor: normalizeHex(source.accentColor, DEFAULT_SETTINGS.accentColor),
    opacity: numberWithin(source.opacity, DEFAULT_SETTINGS.opacity, 0, 100),
    fontSize: numberWithin(source.fontSize, DEFAULT_SETTINGS.fontSize, 12, 22),
    maxHeightPercent: numberWithin(source.maxHeightPercent, DEFAULT_SETTINGS.maxHeightPercent, 40, 85),
    autoScroll: typeof source.autoScroll === 'boolean' ? source.autoScroll : DEFAULT_SETTINGS.autoScroll,
    scrollLocked: typeof source.scrollLocked === 'boolean' ? source.scrollLocked : DEFAULT_SETTINGS.scrollLocked,
  };
}

const DEFAULT_ACCENT_PALETTE = Object.freeze({
  accent: '#C0392B', focus: '#E37A6C', 'accent-text': '#EF9589', 'accent-wash': '#2E2422',
  'accent-selected-text': '#F5E8E4', 'accent-button-bg': '#3B2E2B', 'accent-button-hover': '#4A3630',
  'accent-button-border': '#514542', 'accent-button-hover-border': '#705047', 'accent-button-text': '#F3E8E4',
  'accent-switch-bg': '#74423B', 'accent-switch-border': '#9F5A4D', 'accent-switch-thumb': '#F4E5DF',
  'accent-option-hover': '#3A3533', 'accent-option-selected': '#342321', 'accent-option-text': '#FFF0EC',
  'accent-target-border': '#62504A', 'accent-popup-border': '#494340',
});

const rgb = hex => hex.slice(1).match(/.{2}/g).map(channel => Number.parseInt(channel, 16));
function mixColor(from, to, amount) {
  const end = rgb(to);
  return '#' + rgb(from).map((channel, index) => Math.round(channel + (end[index] - channel) * amount)
    .toString(16).padStart(2, '0')).join('').toUpperCase();
}
function luminance(hex) {
  const linear = rgb(hex).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function readableColor(color, background, minimum) {
  if (contrast(color, background) >= minimum) return color;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 16; step++) {
    const amount = (low + high) / 2;
    if (contrast(mixColor(color, '#FFFFFF', amount), background) >= minimum) high = amount;
    else low = amount;
  }
  return mixColor(color, '#FFFFFF', high);
}

/** Keep the existing coral palette as the default. Custom accents retain their
 * hue while text/focus remain legible, including black, white and deep colors.
 */
export function createAccentPalette(value = DEFAULT_SETTINGS.accentColor) {
  const accent = normalizeHex(value, DEFAULT_SETTINGS.accentColor);
  if (accent === DEFAULT_SETTINGS.accentColor) return { ...DEFAULT_ACCENT_PALETTE };
  const surface = '#18181B';
  const wash = mixColor(surface, accent, 0.14);
  const button = mixColor(surface, accent, 0.2);
  const hover = mixColor(surface, accent, 0.3);
  const switchBackground = mixColor(surface, accent, 0.5);
  const focus = readableColor(mixColor(accent, '#FFFFFF', 0.36), '#303034', 3);
  const text = readableColor(mixColor(accent, '#FFFFFF', 0.45), '#29292D', 4.5);
  return {
    accent, focus, 'accent-text': text, 'accent-wash': wash,
    'accent-selected-text': readableColor(mixColor(accent, '#FFFFFF', 0.9), wash, 4.5),
    'accent-button-bg': button, 'accent-button-hover': hover,
    'accent-button-border': mixColor('#343438', accent, 0.32),
    'accent-button-hover-border': mixColor('#343438', accent, 0.52),
    'accent-button-text': readableColor(mixColor(accent, '#FFFFFF', 0.9), hover, 4.5),
    'accent-switch-bg': switchBackground,
    'accent-switch-border': mixColor(surface, focus, 0.6),
    'accent-switch-thumb': readableColor(mixColor(accent, '#FFFFFF', 0.9), switchBackground, 3),
    'accent-option-hover': mixColor(surface, accent, 0.19),
    'accent-option-selected': mixColor(surface, accent, 0.15),
    'accent-option-text': readableColor(mixColor(accent, '#FFFFFF', 0.94), wash, 4.5),
    'accent-target-border': mixColor('#343438', accent, 0.42),
    'accent-popup-border': mixColor('#343438', accent, 0.18),
  };
}

export function applyTheme(settings, target = document.documentElement) {
  const value = normalizeSettings(settings);
  const channels = value.panelColor.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16));
  target.style.setProperty('--panel-rgb', channels.join(', '));
  target.style.setProperty('--panel-opacity', String(value.opacity / 100));
  target.style.setProperty('--text-color', value.textColor);
  target.style.setProperty('--font-size', `${value.fontSize}px`);
  target.style.setProperty('--code-font-size', `${Math.max(12, value.fontSize - 1)}px`);
  target.style.setProperty('--max-height-percent', `${value.maxHeightPercent}vh`);
  for (const [name, color] of Object.entries(createAccentPalette(value.accentColor))) {
    target.style.setProperty('--settings-' + name, color);
  }
  return value;
}
