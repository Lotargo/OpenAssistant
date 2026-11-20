// Local 24px outline set. Settings, terminal and control shapes follow the
// user-owned antigravity_engine_sdk desktop reference; no external font or CDN.
const paths = {
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  'screen-active': '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4m-4-11 3 3 5-5"/>',
  microphone: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  'microphone-muted': '<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5.1 2.1M9 5V4a3 3 0 0 1 6 0v6M5 10v2a7 7 0 0 0 12 4.9M19 10v2a7 7 0 0 1-.5 2.6M12 19v3M8 22h8"/>',
  reconnect: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  'notifications-off': '<path d="m3 3 18 18M6 8c0 7-3 7-3 9h12M9 3a6 6 0 0 1 9 5c0 2 .3 3.5 .8 4.7M10 21h4"/>',
  settings: '<path d="M4 6h2m4 0h10M4 12h10m4 0h2M4 18h4m4 0h8"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  lock: '<rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0"/>',
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
