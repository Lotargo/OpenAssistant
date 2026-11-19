/**
 * Incremental parser for the overlay's small, explicit output protocol.
 *
 * Exact protocol tags are reserved delimiters, including inside source code.
 * Ordinary HTML is preserved; a future transport must escape reserved literal
 * tags or send structured parts when code needs to contain those exact strings.
 * Text outside a channel is ignored rather than guessed to be source code.
 */
const CHANNELS = ['mode', 'text', 'code_meta', 'code', 'notes'];
const TOKENS = CHANNELS.flatMap((name) => [`<${name}>`, `</${name}>`]);
const DEFAULT_META = Object.freeze({ filename: 'untitled.txt', lang: 'text' });
const MAX_CHARACTERS = 512 * 1024;

function trailingTokenPrefix(value) {
  const maximum = Math.min(value.length, 11);
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (TOKENS.some((token) => token.startsWith(suffix))) return length;
  }
  return 0;
}

/** Remove only a wrapper fence, preserving fences embedded in the source. */
export function stripOuterCodeFence(value, closed = false) {
  const opening = value.match(/^\s*(`{3,}|~{3,})[a-zA-Z0-9_+.-]*[^\S\r\n]*\r?\n/);
  if (!opening) {
    // Do not briefly flash an opening fence while its first line is streaming.
    if (!closed && /^\s*(?:`{1,}|~{1,})[a-zA-Z0-9_+.-]*[^\S\r\n]*$/.test(value)) return '';
    return value;
  }
  let result = value.slice(opening[0].length);
  if (closed) {
    const marker = opening[1];
    const escaped = marker[0] === '`' ? '`' : '~';
    const closing = new RegExp(`(?:\\r?\\n)?[\\t ]*${escaped}{${marker.length},}[\\t ]*(?:\\r?\\n)?$`);
    result = result.replace(closing, '');
  }
  return result;
}

export function createStreamParser({ onUpdate, onError, maxCharacters = MAX_CHARACTERS } = {}) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) {
    throw new RangeError('maxCharacters must be a safe integer of at least 32.');
  }

  let state;
  let pending = '';
  let active = null;
  let buffers;
  let characters = 0;
  let codeClosed = false;
  let replaceCodeOnOpen = false;

  function report(message) {
    if (state.errors.length >= 8) return;
    state.errors.push(message);
    onError?.(message);
  }

  function snapshot() {
    return {
      mode: state.mode,
      text: buffers.text,
      code: stripOuterCodeFence(buffers.code, codeClosed || state.complete),
      notes: buffers.notes,
      codeMeta: { ...state.codeMeta },
      complete: state.complete,
      errors: [...state.errors],
    };
  }

  function notify() {
    const result = snapshot();
    onUpdate?.(result);
    return result;
  }

  function closeChannel(name) {
    if (name === 'mode') {
      const mode = buffers.mode.trim();
      if (['text', 'code', 'correction'].includes(mode)) state.mode = mode;
      else report(`Unsupported response mode: ${mode.slice(0, 40) || '(empty)'}.`);
    } else if (name === 'code_meta') {
      try {
        const metadata = JSON.parse(buffers.code_meta);
        if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') throw new Error();
        const filename = metadata.filename;
        const lang = metadata.lang;
        if (typeof filename !== 'string' || !filename.trim() || filename.length > 240
          || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(filename)
          || typeof lang !== 'string' || !/^[a-z][a-z0-9_+-]{0,29}$/i.test(lang)) throw new Error();
        state.codeMeta = { filename: filename.trim(), lang: lang.toLowerCase() };
      } catch {
        report('Invalid code metadata; keeping the previous safe filename and language.');
      }
    } else if (name === 'code') {
      codeClosed = true;
    }
  }

  function handleToken(token) {
    const closing = token.startsWith('</');
    const name = token.slice(closing ? 2 : 1, -1);
    if (closing) {
      if (name === active) {
        closeChannel(name);
        active = null;
      } else {
        report(`Unexpected closing tag: ${token}.`);
      }
      return;
    }
    if (active) {
      // Recover before notes can accidentally become source code.
      report(`Missing closing tag for <${active}> before ${token}.`);
      closeChannel(active);
    }
    active = name;
    if (name === 'mode' || name === 'code_meta') buffers[name] = '';
    if (name === 'code') {
      if (replaceCodeOnOpen) {
        buffers.code = '';
        replaceCodeOnOpen = false;
      }
      codeClosed = false;
      if (state.mode === 'text') state.mode = 'code';
    }
  }

  function append(value) {
    if (!active || !value) return;
    const limit = active === 'mode' ? 64 : active === 'code_meta' ? 2048 : maxCharacters;
    if (buffers[active].length + value.length > limit) {
      buffers[active] = buffers[active].slice(0, limit);
      report(`The <${active}> channel exceeded its size limit.`);
      active = null;
      return;
    }
    buffers[active] += value;
  }

  function consume() {
    while (pending) {
      let nextPosition = -1;
      let nextToken = null;
      for (const token of TOKENS) {
        const position = pending.indexOf(token);
        if (position !== -1 && (nextPosition === -1 || position < nextPosition)) {
          nextPosition = position;
          nextToken = token;
        }
      }
      if (nextToken) {
        append(pending.slice(0, nextPosition));
        pending = pending.slice(nextPosition + nextToken.length);
        handleToken(nextToken);
      } else {
        const held = trailingTokenPrefix(pending);
        append(held ? pending.slice(0, -held) : pending);
        pending = held ? pending.slice(-held) : '';
        break;
      }
    }
  }

  function feed(chunk) {
    if (typeof chunk !== 'string') throw new TypeError('Stream chunks must be strings.');
    if (state.complete || !chunk) return snapshot();
    const remaining = Math.max(0, maxCharacters - characters);
    pending += chunk.slice(0, remaining);
    characters += Math.min(chunk.length, remaining);
    consume();
    if (chunk.length > remaining) {
      report('Response exceeded the maximum size; further fragments were ignored.');
      state.complete = true;
      pending = '';
    }
    return notify();
  }

  function finish() {
    if (state.complete) return snapshot();
    // A withheld suffix can only be an incomplete control tag. Never show it.
    if (pending) report('Response ended inside a protocol tag.');
    pending = '';
    if (active) {
      report(`Response ended before </${active}>.`);
      closeChannel(active);
      active = null;
    }
    state.complete = true;
    return notify();
  }

  function reset({ preserveCode = false } = {}) {
    const code = preserveCode && buffers ? buffers.code : '';
    const codeMeta = preserveCode && state ? state.codeMeta : DEFAULT_META;
    state = { mode: preserveCode && code ? 'code' : 'text', codeMeta: { ...codeMeta }, complete: false, errors: [] };
    buffers = { mode: '', text: '', code_meta: '', code, notes: '' };
    pending = '';
    active = null;
    characters = code.length;
    codeClosed = Boolean(code);
    replaceCodeOnOpen = preserveCode;
    return notify();
  }

  // Do not emit during construction: callers may still be assigning the parser.
  state = { mode: 'text', codeMeta: { ...DEFAULT_META }, complete: false, errors: [] };
  buffers = { mode: '', text: '', code_meta: '', code: '', notes: '' };
  return { feed, finish, reset, snapshot };
}
