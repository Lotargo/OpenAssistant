import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DEFAULT_SETTINGS, normalizeSettings, createAccentPalette, applyTheme } from '../src/js/settings.js';

function contrastRatio(a, b) {
  const light = hex => {
    const values = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return values.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  };
  const values = [light(a), light(b)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}

test('stored appearance migrates its accent and rejects malformed or injectable colors', () => {
  assert.equal(normalizeSettings({ panelColor: '#123456' }).accentColor, '#C0392B');
  for (const invalid of [null, undefined, 42, {}, '#12', '#12345678', 'red', 'var(--x)', '#fff; color:red', '#GG00FF']) {
    assert.equal(normalizeSettings({ accentColor: invalid }).accentColor, DEFAULT_SETTINGS.accentColor);
  }
  const appearance = normalizeSettings({ accentColor: ' #0aF ', panelColor: '#abc', textColor: '#abcdef', opacity: 17 });
  assert.equal(appearance.accentColor, '#00AAFF');
  assert.equal(appearance.panelColor, '#AABBCC');
  assert.equal(appearance.textColor, '#ABCDEF');
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(appearance))), appearance);
});

test('the default accent preserves the established coral controls', () => {
  const palette = createAccentPalette();
  assert.equal(palette.accent, '#C0392B');
  assert.equal(palette.focus, '#E37A6C');
  assert.equal(palette['accent-text'], '#EF9589');
  assert.equal(palette['accent-wash'], '#2E2422');
  assert.equal(palette['accent-button-bg'], '#3B2E2B');
  assert.equal(palette['accent-switch-bg'], '#74423B');
  assert.deepEqual(createAccentPalette('invalid'), palette);
});

test('custom dark, bright and saturated accents retain readable text and focus', () => {
  for (const accent of ['#000000', '#FFFFFF', '#0000FF', '#00FF00', '#FFFF00', '#FF00FF', '#010011', '#167DA1', '#C0392B']) {
    const p = createAccentPalette(accent);
    assert.equal(p.accent, accent);
    for (const color of Object.values(p)) assert.match(color, /^#[0-9A-F]{6}$/);
    const pairs = [
      [p.focus, '#303034', 3],
      [p['accent-text'], '#29292D', 4.5],
      [p['accent-selected-text'], p['accent-wash'], 4.5],
      [p['accent-button-text'], p['accent-button-hover'], 4.5],
      [p['accent-option-text'], p['accent-option-selected'], 4.5],
      [p['accent-switch-thumb'], p['accent-switch-bg'], 3],
    ];
    for (const [foreground, background, minimum] of pairs) {
      assert.ok(contrastRatio(foreground, background) >= minimum,
        `${accent}: ${foreground} on ${background} must meet ${minimum}:1`);
    }
  }
});

test('main and independent settings apply identical accents without changing solid surfaces', t => {
  const main = new JSDOM('<html><body></body></html>');
  const child = new JSDOM('<html><body style="background:#18181b"></body></html>');
  t.after(() => { main.window.close(); child.window.close(); });
  const appearance = normalizeSettings({ accentColor: '#579', opacity: 0 });
  const roots = [main.window.document.documentElement, child.window.document.documentElement];
  for (const target of roots) applyTheme(appearance, target);
  for (const [name, color] of Object.entries(createAccentPalette('#557799'))) {
    for (const target of roots) assert.equal(target.style.getPropertyValue('--settings-' + name), color);
  }
  assert.equal(child.window.getComputedStyle(child.window.document.body).backgroundColor, 'rgb(24, 24, 27)');
  assert.equal(child.window.document.documentElement.style.getPropertyValue('--settings-bg'), '');
  assert.equal(main.window.document.documentElement.style.getPropertyValue('--panel-opacity'), '0');
});
