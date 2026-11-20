// Local 24px geometric outline set; one stroke system, no external font or CDN.
const paths = {
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  'screen-active': '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4m-4-11 3 3 5-5"/>',
  microphone: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M9 21h6"/>',
  'microphone-muted': '<path d="m3 3 18 18M9 9v2a3 3 0 0 0 5.1 2.1M9.2 5a3 3 0 0 1 5.8 1v4M6 10v2a6 6 0 0 0 10.2 4.3M18 10v2c0 .5-.1 1-.2 1.5M12 18v3M9 21h6"/>',
  reconnect: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  'mode-assistant': '<path d="M7 18l-4 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7Z"/><path d="M7 8h10M7 12h7"/>',
  'mode-meeting': '<circle cx="8.5" cy="8" r="3"/><path d="M3 20v-2a5.5 5.5 0 0 1 11 0v2M16 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 4v2"/>',
  'mode-custom': '<path d="M6 3v3m0 4v11M12 3v11m0 4v3M18 3v5m0 4v9"/><rect x="4" y="6" width="4" height="4" rx="1"/><rect x="10" y="14" width="4" height="4" rx="1"/><rect x="16" y="8" width="4" height="4" rx="1"/>',
  'mode-cycle': '<path d="M5 7h14m-4-4 4 4-4 4M19 17H5m4-4-4 4 4 4"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M7.1 7.1a7 7 0 0 0 0 9.8m9.8-9.8a7 7 0 0 1 0 9.8M4.3 4.3a11 11 0 0 0 0 15.4M19.7 4.3a11 11 0 0 1 0 15.4"/>',
  notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  'notifications-off': '<path d="m3 3 18 18M6 8c0 7-3 7-3 9h12M9 3a6 6 0 0 1 9 5c0 2 .3 3.5 .8 4.7M10 21h4"/>',
  settings: '<path d="M10 3h4l.5 2.2 1.7 1 2.1-.6 2 3.4-1.6 1.6v2.8l1.6 1.6-2 3.4-2.1-.6-1.7 1L14 21h-4l-.5-2.2-1.7-1-2.1.6-2-3.4 1.6-1.6v-2.8L3.7 9l2-3.4 2.1.6 1.7-1Z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0"/>',
  'window-standard': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  'window-overlay': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m-9 2-3 1v2.5c0 1.5 1.2 2.8 3 3.5 1.8-.7 3-2 3-3.5V12Z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  appearance: '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-.4a1.5 1.5 0 0 1 0-3H16a5 5 0 0 0 5-5c0-3.3-4-6-9-6Z"/><path d="M7 9h.01M10 6h.01M15 7h.01M6 13h.01"/>',
  behavior: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M12 8h6M12 12h4"/>',
  modes: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><path d="M14 7h7M17.5 3.5v7M3 17h7"/>',
  workspace: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  audio: '<path d="M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4"/>',
  journal: '<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M3 7h4M3 12h4M3 17h4M10 7h6M10 12h6M10 17h4"/>',
  agent: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
};

/** Only locally defined SVG is inserted. Never pass model output into this helper. */
export function getIcon(name) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (paths[name] ?? paths.settings) + '</svg>';
}

export function setButtonIcon(button, name) {
  if (!button || (button.dataset.icon === name && button.querySelector('svg'))) return;
  button.innerHTML = getIcon(name);
  button.dataset.icon = name;
}

/** Two glyphs, one control: the whole wide button cycles the current mode. */
export function setModeButtonIcon(button, name) {
  if (!button || (button.dataset.icon === name && button.querySelector('.mode-cycle-icon'))) return;
  button.innerHTML = '<span class="mode-current-icon" aria-hidden="true">' + getIcon(name)
    + '</span><span class="mode-cycle-icon" aria-hidden="true">' + getIcon('mode-cycle') + '</span>';
  button.dataset.icon = name;
}
