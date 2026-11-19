import { marked } from 'marked';
import createDOMPurify from 'dompurify';

const LANGUAGE_LOADERS = {
  sql: () => import('@shikijs/langs/sql'),
  python: () => import('@shikijs/langs/python'),
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  bash: () => import('@shikijs/langs/bash'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  cpp: () => import('@shikijs/langs/cpp'),
  json: () => import('@shikijs/langs/json'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
};
const ALIASES = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', rs: 'rust', 'c++': 'cpp', htm: 'html' };
const MARKDOWN_TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 's', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
let highlighterPromise;
const languagePromises = new Map();

async function highlighterFor(language) {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('@shikijs/core'),
      import('@shikijs/engine-javascript'),
      import('@shikijs/themes/dark-plus'),
    ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme]) => createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }));
  }
  const highlighter = await highlighterPromise;
  if (!languagePromises.has(language)) {
    languagePromises.set(language, highlighter.loadLanguage(LANGUAGE_LOADERS[language]()));
  }
  await languagePromises.get(language);
  return highlighter;
}

export function resolveLanguage(language, filename = '') {
  const candidate = String(language || filename.split('.').pop() || '').toLowerCase();
  const resolved = ALIASES[candidate] || candidate;
  return Object.hasOwn(LANGUAGE_LOADERS, resolved) ? resolved : 'text';
}

export function createMarkdownRenderer(document) {
  const purifier = createDOMPurify(document.defaultView);
  return (markdown) => {
    const html = marked.parse(String(markdown || ''), { async: false, gfm: true, breaks: false });
    const fragment = purifier.sanitize(html, {
      ALLOWED_TAGS: MARKDOWN_TAGS,
      ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    });
    for (const link of fragment.querySelectorAll('a')) {
      const href = link.getAttribute('href') || '';
      // Reject relative, protocol-relative, data and command navigation in a WebView.
      if (!/^(?:https?:\/\/|mailto:)/i.test(href)) link.removeAttribute('href');
      else {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return fragment;
  };
}

function scrollContainer(element) {
  return element.closest('[data-scroll-panel]') || element.parentElement || element;
}

function preserveScroll(element, render, autoScroll) {
  const panel = scrollContainer(element);
  const top = panel.scrollTop;
  const left = panel.scrollLeft;
  // Allow only rounding tolerance: even a short intentional upward scroll
  // should pause following, rather than snapping back on the next fragment.
  const atBottom = panel.scrollHeight - panel.clientHeight - top <= 2;
  render();
  panel.scrollTop = autoScroll && atBottom ? panel.scrollHeight : top;
  panel.scrollLeft = left;
}

function codeFragment(document, source, tokens) {
  const pre = document.createElement('pre');
  pre.className = tokens ? 'shiki' : 'shiki plaintext';
  const code = document.createElement('code');
  const lines = source.split(/\r?\n/);
  lines.forEach((text, index) => {
    const line = document.createElement('span');
    line.className = 'line';
    line.dataset.line = String(index + 1);
    const indent = (text.match(/^[\t ]*/)?.[0] || '').replace(/\t/g, '    ').length;
    line.style.setProperty('--indent-columns', String(indent));
    if (tokens?.[index]) {
      for (const token of tokens[index]) {
        const span = document.createElement('span');
        span.textContent = token.content;
        if (token.color) span.style.color = token.color;
        if (token.fontStyle & 1) span.style.fontStyle = 'italic';
        if (token.fontStyle & 2) span.style.fontWeight = 'bold';
        if (token.fontStyle & 4) span.style.textDecoration = 'underline';
        line.append(span);
      }
    } else line.textContent = text;
    code.append(line);
  });
  pre.append(code);
  return pre;
}

/**
 * Batches stream updates and only replaces changed panels. Async highlighting
 * never overwrites a newer response, and each pane retains its own scroll.
 */
export function createRenderer({ textContent, codeContent, notesContent, codeFilename, onRender, getAutoScroll = () => true } = {}) {
  if (!textContent || !codeContent || !notesContent || !codeFilename) {
    throw new TypeError('Renderer requires text, code, notes and filename elements.');
  }
  const document = textContent.ownerDocument;
  const window = document.defaultView;
  const renderMarkdown = createMarkdownRenderer(document);
  let latest = null;
  let revision = 0;
  let renderedRevision = 0;
  let timeout = null;
  let animationFrame = null;
  let running = null;
  let destroyed = false;
  const previous = { text: null, notes: null, code: null, language: null };

  function cancelScheduled() {
    if (timeout !== null) clearTimeout(timeout);
    if (animationFrame !== null) window.cancelAnimationFrame?.(animationFrame);
    timeout = null;
    animationFrame = null;
  }

  async function renderCurrent() {
    if (destroyed || !latest) return;
    const current = latest;
    const currentRevision = revision;
    const autoScroll = Boolean(getAutoScroll());
    for (const [key, element] of [['text', textContent], ['notes', notesContent]]) {
      const value = current[key] || '';
      if (value !== previous[key]) {
        preserveScroll(element, () => element.replaceChildren(renderMarkdown(value)), autoScroll);
        previous[key] = value;
      }
    }
    codeFilename.textContent = current.codeMeta?.filename || 'untitled.txt';
    const source = current.code || '';
    const language = resolveLanguage(current.codeMeta?.lang, current.codeMeta?.filename);
    if (source !== previous.code || language !== previous.language) {
      // Paint immediately; slow grammar loading must not stall live text updates.
      preserveScroll(codeContent, () => codeContent.replaceChildren(codeFragment(document, source)), autoScroll);
      previous.code = source;
      previous.language = language;
      const lines = source.split('\n');
      if (source && language !== 'text' && source.length <= 60_000
        && lines.length <= 2000 && lines.every((line) => line.length <= 2000)) {
        try {
          const highlighter = await highlighterFor(language);
          if (destroyed || source !== latest.code
            || language !== resolveLanguage(latest.codeMeta?.lang, latest.codeMeta?.filename)) return;
          const { tokens } = highlighter.codeToTokens(source, { lang: language, theme: 'dark-plus' });
          preserveScroll(codeContent, () => codeContent.replaceChildren(codeFragment(document, source, tokens)), Boolean(getAutoScroll()));
        } catch {
          // A missing/unsupported grammar leaves the already rendered safe text.
        }
      }
    }
    if (!destroyed && currentRevision === revision) {
      renderedRevision = currentRevision;
      onRender?.(current);
    }
  }

  function run() {
    if (running) return running;
    running = (async () => {
      while (!destroyed && latest && renderedRevision < revision) await renderCurrent();
    })().finally(() => { running = null; });
    return running;
  }

  function update(value) {
    if (destroyed) return;
    latest = { ...value, codeMeta: { ...value.codeMeta } };
    revision += 1;
    if (timeout !== null || animationFrame !== null || running) return;
    timeout = setTimeout(() => {
      timeout = null;
      if (typeof window.requestAnimationFrame === 'function') {
        animationFrame = window.requestAnimationFrame(() => {
          animationFrame = null;
          void run();
        });
      } else void run();
    }, 70);
  }

  async function flush() {
    cancelScheduled();
    await run();
  }

  function destroy() {
    destroyed = true;
    cancelScheduled();
    latest = null;
  }

  return { update, flush, destroy };
}
