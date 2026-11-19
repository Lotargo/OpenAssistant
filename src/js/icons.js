const paths = {
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  'screen-active': '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4m-4-11 3 3 5-5"/>',
  microphone: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  'microphone-muted': '<path d="m2 2 20 20M9 9v3a3 3 0 0 0 5.1 2.1M9 5V4a3 3 0 0 1 6 0v6M5 10v2a7 7 0 0 0 12 4.9M19 10v2a7 7 0 0 1-.5 2.6M12 19v3M8 22h8"/>',
  reconnect: '<path d="M21 3v6h-6M20.5 9a9 9 0 1 0 .2 6"/>',
  settings: '<path d="m9.2 3 .6-2h4.4l.6 2 1.6.9 2-.5 2.2 3.8-1.4 1.5v1.9l1.4 1.5-2.2 3.8-2-.5-1.6.9-.6 2H9.8l-.6-2-1.6-.9-2 .5-2.2-3.8 1.4-1.5V8.7L3.4 7.2l2.2-3.8 2 .5Z" transform="translate(0 1.5)"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  appearance: '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-.4a1.5 1.5 0 0 1 0-3H16a5 5 0 0 0 5-5c0-3.3-4-6-9-6Z"/><path d="M7 9h.01M10 6h.01M15 7h.01M6 13h.01"/>',
  behavior: '<path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  sources: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
};

/** Only locally defined SVG is inserted. Never pass model output into this helper. */
export function getIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] ?? paths.settings}</svg>`;
}

export function setButtonIcon(button, name) {
  if (button) button.innerHTML = getIcon(name);
}
