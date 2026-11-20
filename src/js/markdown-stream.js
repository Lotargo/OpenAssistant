// Convert normal streamed Markdown to the overlay's text/code+guidance layout.
const MAX_CHARACTERS = 512 * 1024;
const EXTENSIONS = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', rust: 'rs', rs: 'rs', sql: 'sql', bash: 'sh', shell: 'sh', sh: 'sh', json: 'json', html: 'html', css: 'css', go: 'go', java: 'java', cpp: 'cpp' };

function metadata(info, number, preceding) {
  const language = (info.trim().split(/\s+/)[0] || 'text').toLowerCase();
  const explicit = info.match(/(?:file(?:name)?|title)\s*[:=]\s*["']?([^"'\s]+)/i)?.[1];
  const path = explicit || preceding.match(/(?:^|\n)(?:#{1,6}\s+)?(?:\*\*|\x60)?([A-Za-z0-9_.@/\\-]+\.[A-Za-z0-9]{1,8})(?:\*\*|\x60)?[:\s]*$/)?.[1];
  const safe = typeof path === 'string' && path.length <= 240 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(path);
  return { filename: safe ? path : 'fragment-' + number + '.' + (EXTENSIONS[language] || 'txt'), lang: /^[a-z][a-z0-9_+-]{0,29}$/i.test(language) ? language : 'text' };
}

export function markdownSnapshot(markdown, complete = false) {
  const lines = markdown.split('\n');
  const notes = [];
  const blocks = [];
  let active = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (active) {
      const trimmed = line.trim();
      const marker = active.marker;
      if (trimmed.length >= marker.length && [...trimmed].every(char => char === marker[0])) {
        active = null;
      } else if (!(!complete && index === lines.length - 1 && trimmed.length < marker.length && [...trimmed].every(char => char === marker[0]))) {
        active.lines.push(line);
      }
      continue;
    }
    const opening = line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
    if (opening) {
      const meta = metadata(opening[2], blocks.length + 1, notes.slice(-2).join('\n'));
      active = { marker: opening[1], lines: [], ...meta };
      blocks.push(active);
    } else {
      // An incomplete opening fence is held until the next streamed token.
      if (!complete && index === lines.length - 1 && /^ {0,3}(?:\x60{1,2}|~{1,2})[a-z0-9_+-]*$/i.test(line)) continue;
      notes.push(line);
    }
  }
  const codeBlocks = blocks.map(block => ({
    code: block.lines.join('\n').replace(/\n$/, ''),
    filename: block.filename, lang: block.lang,
  }));
  const first = codeBlocks[0];
  return {
    mode: first ? 'code' : 'text',
    text: first ? '' : notes.join('\n'),
    notes: first ? notes.join('\n').trim() : '',
    code: first?.code || '',
    codeMeta: first ? { filename: first.filename, lang: first.lang } : { filename: 'untitled.txt', lang: 'text' },
    codeBlocks, complete, errors: [],
  };
}

export function createMarkdownStream({ onUpdate, onError } = {}) {
  let text = '';
  let complete = false;
  const snapshot = () => markdownSnapshot(text, complete);
  function notify() { const value = snapshot(); onUpdate?.(value); return value; }
  return {
    reset() { text = ''; complete = false; return notify(); },
    feed(chunk) {
      if (complete || typeof chunk !== 'string') return snapshot();
      const left = MAX_CHARACTERS - text.length;
      text += chunk.slice(0, left);
      if (chunk.length > left) { complete = true; onError?.('Ответ превысил предел отображения.'); }
      return notify();
    },
    finish() { complete = true; return notify(); },
    snapshot,
  };
}
