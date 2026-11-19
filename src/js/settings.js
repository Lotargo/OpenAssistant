export const DEFAULT_SETTINGS = Object.freeze({
  panelColor: '#202329',
  textColor: '#F5F7FA',
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
    opacity: numberWithin(source.opacity, DEFAULT_SETTINGS.opacity, 0, 100),
    fontSize: numberWithin(source.fontSize, DEFAULT_SETTINGS.fontSize, 12, 22),
    maxHeightPercent: numberWithin(source.maxHeightPercent, DEFAULT_SETTINGS.maxHeightPercent, 40, 85),
    autoScroll: typeof source.autoScroll === 'boolean' ? source.autoScroll : DEFAULT_SETTINGS.autoScroll,
    scrollLocked: typeof source.scrollLocked === 'boolean' ? source.scrollLocked : DEFAULT_SETTINGS.scrollLocked,
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
  return value;
}
