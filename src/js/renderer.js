import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { createOutputReveal } from './output-motion.js';

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

// Incoming nodes have already passed the Markdown sanitizer. Keep unchanged
// blocks and text nodes in place so streaming does not reset selection or links.
function reconcileMarkdown(parent, incoming) {
  let current = parent.firstChild;
  for (const next of [...incoming.childNodes]) {
    if (!current) { parent.append(next); continue; }
    let retained = current;
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      parent.replaceChild(next, current);
      retained = next;
    } else if (!current.isEqualNode(next)) {
      if (current.nodeType === 3) {
        if (next.data.startsWith(current.data)) current.appendData(next.data.slice(current.data.length));
        else current.data = next.data;
      } else if (current.nodeType === 1) {
        for (const { name } of [...current.attributes]) {
          if (!next.hasAttribute(name)) current.removeAttribute(name);
        }
        for (const { name, value } of [...next.attributes]) {
          if (current.getAttribute(name) !== value) current.setAttribute(name, value);
        }
        reconcileMarkdown(current, next);
      } else {
        parent.replaceChild(next, current);
        retained = next;
      }
    }
    current = retained.nextSibling;
  }
  while (current) {
    const next = current.nextSibling;
    current.remove();
    current = next;
  }
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
 * Batches stream updates and reconciles changed Markdown. Async highlighting
 * never overwrites a newer response, and each pane retains its own scroll.
 */
export function createRenderer({ textContent, codeContent, notesContent, codeFilename, onRender, getAutoScroll = () => true } = {}) {
  if (!textContent || !codeContent || !notesContent || !codeFilename) {
    throw new TypeError('Renderer requires text, code, notes and filename elements.');
  }
  const document = textContent.ownerDocument;
  const window = document.defaultView;
  const renderMarkdown = createMarkdownRenderer(document);
  const outputReveal = createOutputReveal(textContent);
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
        const firstText = key === 'text' && !previous.text?.trim() && Boolean(value.trim());
        if (key === 'text' && !value.trim()) outputReveal.cancel();
        preserveScroll(element, () => reconcileMarkdown(element, renderMarkdown(value)), autoScroll);
        previous[key] = value;
        if (firstText) outputReveal.start();
      }
    }
    const blocksFor = value => value.codeBlocks?.length ? value.codeBlocks : [{
      code: value.code || '', filename: value.codeMeta?.filename || 'untitled.txt', lang: value.codeMeta?.lang || 'text',
    }];
    const blocks = blocksFor(current);
    const signature = JSON.stringify(blocks);
    codeFilename.textContent = blocks.length > 1 ? blocks.length + ' фрагмента кода' : blocks[0].filename;
    function blockFragment(tokens = []) {
      const fragment = document.createDocumentFragment();
      blocks.forEach((block, index) => {
        if (blocks.length > 1) {
          const heading = document.createElement('div');
          heading.className = 'code-fragment-heading';
          heading.textContent = block.filename;
          fragment.append(heading);
        }
        fragment.append(codeFragment(document, block.code, tokens[index]));
      });
      return fragment;
    }
    if (signature !== previous.code) {
      preserveScroll(codeContent, () => codeContent.replaceChildren(blockFragment()), autoScroll);
      previous.code = signature;
      const tokens = await Promise.all(blocks.map(async block => {
        const source = block.code;
        const language = resolveLanguage(block.lang, block.filename);
        const lines = source.split('\n');
        if (!source || language === 'text' || source.length > 60_000 || lines.length > 2000
          || lines.some(line => line.length > 2000)) return null;
        try {
          const highlighter = await highlighterFor(language);
          return highlighter.codeToTokens(source, { lang: language, theme: 'dark-plus' }).tokens;
        } catch { return null; }
      }));
      if (destroyed || signature !== JSON.stringify(blocksFor(latest))) return;
      if (tokens.some(Boolean)) {
        preserveScroll(codeContent, () => codeContent.replaceChildren(blockFragment(tokens)), Boolean(getAutoScroll()));
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
    outputReveal.destroy();
    latest = null;
  }

  return { update, flush, destroy };
}
