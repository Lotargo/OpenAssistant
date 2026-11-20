import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { createOutputReveal, createWordMotion, createScrollFollow } from './output-motion.js';

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

const PROSE_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const MAX_WORDS_PER_BLOCK = 384;
const MAX_WORDS_PER_RESPONSE = 2048;

/** Trusted wrappers are added after sanitization; whitespace and inline markup stay intact. */
function createProseDecorator() {
  let cache = new WeakMap();
  let total = 0;
  function wrap(block, budget) {
    let count = 0;
    const document = block.ownerDocument;
    function walk(parent) {
      for (const node of [...parent.childNodes]) {
        if (count >= budget) break;
        if (node.nodeType === 3) {
          const parts = node.data.match(/\S+|\s+/gu) || [];
          const fragment = document.createDocumentFragment();
          for (const part of parts) {
            if (!/\s/u.test(part) && count < budget) {
              const word = document.createElement('span');
              word.className = 'output-word';
              word.textContent = part;
              fragment.append(word);
              count++;
            } else fragment.append(document.createTextNode(part));
          }
          node.replaceWith(fragment);
        } else if (node.nodeType === 1 && !['CODE', 'PRE'].includes(node.nodeName)) walk(node);
      }
    }
    walk(block);
    if (count) block.classList.add('output-prose');
    return count;
  }
  return {
    prepare(current, next) {
      if (next.nodeType !== 1 || !PROSE_TAGS.has(next.nodeName)) return null;
      const source = next.innerHTML;
      const old = current && cache.get(current);
      if (current?.nodeName === next.nodeName && old?.source === source) return { skip: true };
      const budget = Math.max(0, Math.min(MAX_WORDS_PER_BLOCK, MAX_WORDS_PER_RESPONSE - total + (old?.count || 0)));
      return { source, count: wrap(next, budget) };
    },
    commit(retained, old, prepared) {
      if (old && cache.has(old)) { total -= cache.get(old).count; cache.delete(old); }
      if (prepared) { cache.set(retained, prepared); total += prepared.count; }
    },
    remove(node) {
      if (cache.has(node)) { total -= cache.get(node).count; cache.delete(node); }
    },
    reset() { cache = new WeakMap(); total = 0; },
  };
}

// Incoming nodes have already passed the Markdown sanitizer. Keep unchanged
// blocks and text nodes in place so streaming does not reset selection or links.
function reconcileMarkdown(parent, incoming, prose = null) {
  let current = parent.firstChild;
  for (const next of [...incoming.childNodes]) {
    const prepared = prose?.prepare(current, next);
    if (prepared?.skip) { current = current.nextSibling; continue; }
    if (!current) {
      parent.append(next);
      prose?.commit(next, null, prepared);
      continue;
    }
    const old = current;
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
    prose?.commit(retained, old, prepared);
    current = retained.nextSibling;
  }
  while (current) {
    const next = current.nextSibling;
    prose?.remove(current);
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
  const prose = createProseDecorator();
  const textPanel = scrollContainer(textContent);
  const overlay = textContent.closest('#overlay');
  if (overlay && textContent.parentElement.id !== 'text-layout') {
    const layout = document.createElement('div');
    layout.id = 'text-layout';
    layout.className = 'output-layout';
    layout.dataset.windowDrag = 'background';
    textContent.before(layout);
    layout.append(textContent);
  }
  const wordMotion = createWordMotion(textContent);
  let pendingScroll = null;
  let layoutBefore = null;
  let responseReset = false;
  const scrollFollow = createScrollFollow(textPanel, () => {
    if (pendingScroll) pendingScroll = {
      follow: false, top: textPanel.scrollTop, left: textPanel.scrollLeft, scrollRevision: scrollFollow.revision,
    };
  });
  const naturalScrollHeight = () => {
    const style = window.getComputedStyle(textPanel);
    return textContent.getBoundingClientRect().height + parseFloat(style.paddingTop || 0) + parseFloat(style.paddingBottom || 0);
  };
  const targetPanelHeight = () => Math.max(textPanel.clientHeight,
    (parseFloat(overlay?.style.getPropertyValue('--output-target-height')) || 0)
    - (parseFloat(overlay?.style.getPropertyValue('--output-toolbar-height')) || 0) - 2);
  function respectUserScroll() {
    if (pendingScroll && Math.abs(textPanel.scrollTop - pendingScroll.top) > 2
      && !scrollFollow.ownsPositionSince(pendingScroll.scrollRevision)) scrollFollow.interrupt();
  }
  const beforeLayout = () => {
    respectUserScroll();
    layoutBefore = { words: wordMotion.capture(), height: parseFloat(overlay.style.getPropertyValue('--output-target-height')) || 0 };
  };
  const afterLayout = () => {
    // At the height cap geometry still commits, but does not emit beforelayout.
    // A user's wheel/scrollbar movement between render and this pass wins.
    if (!layoutBefore) respectUserScroll();
    if (pendingScroll) {
      const { follow, top, left } = pendingScroll;
      if (follow && overlay.dataset.outputAtCap === 'true') {
        scrollFollow.follow(Math.max(0, naturalScrollHeight() - targetPanelHeight()));
      } else {
        scrollFollow.cancel();
        textPanel.scrollTop = follow ? 0 : top;
      }
      textPanel.scrollLeft = left;
      pendingScroll = null;
    }
    if (layoutBefore) {
      const height = parseFloat(overlay.style.getPropertyValue('--output-target-height')) || 0;
      if (height < layoutBefore.height) wordMotion.cancel();
      else wordMotion.play(layoutBefore.words);
    }
    layoutBefore = null;
  };
  overlay?.addEventListener('output:beforelayout', beforeLayout);
  overlay?.addEventListener('output:layout', afterLayout);
  function renderText(render, autoScroll) {
    if (overlay?.dataset.outputLayout !== 'target') {
      preserveScroll(textContent, render, autoScroll);
      return;
    }
    const top = textPanel.scrollTop, left = textPanel.scrollLeft;
    const following = scrollFollow.active || (overlay.dataset.outputAtCap !== 'true'
      ? top <= 2 : naturalScrollHeight() - targetPanelHeight() - top <= 2);
    const carriedFollow = pendingScroll?.follow && (Math.abs(top - pendingScroll.top) <= 2
      || scrollFollow.ownsPositionSince(pendingScroll.scrollRevision));
    pendingScroll = { follow: autoScroll && (following || carriedFollow), top, left, scrollRevision: scrollFollow.revision };
    render();
    // Target layout is published on the next geometry pass. Never jump to the
    // bottom of the temporarily smaller visual viewport in between.
    textPanel.scrollTop = top;
    textPanel.scrollLeft = left;
  }
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
      if (value !== previous[key] || key === 'text' && responseReset) {
        const firstText = key === 'text' && (responseReset || !previous.text?.trim()) && Boolean(value.trim());
        if (key === 'text') {
          if (!value.trim()) { outputReveal.cancel(); wordMotion.cancel(); }
          const before = responseReset ? new Map() : wordMotion.capture();
          renderText(() => reconcileMarkdown(element, renderMarkdown(value), prose), autoScroll);
          wordMotion.play(before);
          responseReset = false;
        } else preserveScroll(element, () => reconcileMarkdown(element, renderMarkdown(value)), autoScroll);
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
    if (value.text === '' && latest?.text) {
      responseReset = true;
      outputReveal.cancel();
      wordMotion.cancel();
      scrollFollow.cancel();
      prose.reset();
      pendingScroll = null;
      layoutBefore = null;
    }
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
    wordMotion.destroy();
    scrollFollow.destroy();
    overlay?.removeEventListener('output:beforelayout', beforeLayout);
    overlay?.removeEventListener('output:layout', afterLayout);
    latest = null;
  }

  return { update, flush, destroy, noteUserScroll: scrollFollow.interrupt };
}
