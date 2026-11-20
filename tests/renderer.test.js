import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer, createRenderer, resolveLanguage } from '../src/js/renderer.js';

function fixture() {
  const dom = new JSDOM('<div data-scroll-panel id="text-panel"><div id="text"></div></div><span id="filename"></span><div data-scroll-panel id="code-panel"><div id="code"></div></div><div data-scroll-panel id="notes-panel"><div id="notes"></div></div>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const elements = {
    textContent: document.querySelector('#text'),
    codeContent: document.querySelector('#code'),
    notesContent: document.querySelector('#notes'),
    codeFilename: document.querySelector('#filename'),
  };
  return { dom, document, elements };
}

test('Markdown is formatted and strips executable markup, remote images and unsafe navigation', () => {
  const { dom, document } = fixture();
  const render = createMarkdownRenderer(document);
  const result = render('# Answer\n\n**Safe** and `inline`.\n\n<script>window.pwned = true</script><img src="https://tracker.invalid/pixel" onerror="alert(1)"><svg onload="alert(1)"></svg><p style="position:fixed" onclick="alert(1)">Text</p>\n\n[bad](javascript:alert(1)) [relative](/settings) [good](https://example.org)');
  assert.equal(result.querySelector('h1').textContent, 'Answer');
  assert.equal(result.querySelector('strong').textContent, 'Safe');
  assert.equal(result.querySelector('code').textContent, 'inline');
  assert.equal(result.querySelector('script, img, svg, [onerror], [onclick], [style]'), null);
  for (const link of result.querySelectorAll('a')) {
    if (link.textContent === 'good') {
      assert.equal(link.getAttribute('href'), 'https://example.org');
      assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    } else assert.equal(link.hasAttribute('href'), false);
  }
  dom.window.close();
});

test('highlighted code and malicious-looking filenames are rendered only as text', async () => {
  const { dom, elements } = fixture();
  const renderer = createRenderer(elements);
  const source = '<script>alert("hello")</script>\n<div>ordinary HTML</div>';
  renderer.update({ text: '**Hello**', code: source, notes: '1. Create a file.', codeMeta: { filename: '<img src=x onerror=alert(1)>', lang: 'html' } });
  await renderer.flush();
  assert.equal(elements.codeContent.querySelector('script, img'), null);
  assert.deepEqual([...elements.codeContent.querySelectorAll('.line')].map((line) => line.textContent), source.split('\n'));
  assert.equal(elements.codeContent.querySelectorAll('.line').length, 2);
  assert.ok(elements.codeContent.querySelector('.line span[style]'));
  assert.equal(elements.codeFilename.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(elements.codeFilename.querySelector('img'), null);
  assert.equal(elements.textContent.querySelector('strong').textContent, 'Hello');
  renderer.destroy();
  dom.window.close();
});

test('the newest pending response wins when grammar loading overlaps updates', async () => {
  const { dom, elements } = fixture();
  const renderer = createRenderer(elements);
  renderer.update({ code: 'SELECT 1;', notes: 'Old notes', codeMeta: { filename: 'old.sql', lang: 'sql' } });
  const first = renderer.flush();
  renderer.update({ text: 'Latest answer', code: 'print(42)', notes: 'New notes', codeMeta: { filename: 'main.py', lang: 'python' } });
  await first;
  await renderer.flush();
  assert.equal(elements.codeContent.textContent, 'print(42)');
  assert.equal(elements.codeFilename.textContent, 'main.py');
  assert.equal(elements.notesContent.textContent.trim(), 'New notes');
  renderer.destroy();
  dom.window.close();
});

test('separate panels retain manual scroll positions and only tailing panels follow output', async () => {
  const { dom, document, elements } = fixture();
  const panels = [...document.querySelectorAll('[data-scroll-panel]')];
  for (const panel of panels) {
    Object.defineProperties(panel, { scrollHeight: { get: () => 1000 }, clientHeight: { get: () => 100 } });
  }
  // Only 20px above the end is still a deliberate manual scroll position.
  panels[0].scrollTop = 880;
  panels[1].scrollTop = 280;
  panels[1].scrollLeft = 47;
  panels[2].scrollTop = 900;
  const renderer = createRenderer(elements);
  renderer.update({ text: 'More text', code: 'source', notes: 'More notes', codeMeta: { lang: 'text' } });
  await renderer.flush();
  assert.equal(panels[0].scrollTop, 880);
  assert.equal(panels[1].scrollTop, 280);
  assert.equal(panels[1].scrollLeft, 47);
  assert.equal(panels[2].scrollTop, 1000);
  renderer.destroy();
  dom.window.close();
});

test('auto-scroll can be disabled and unknown grammars retain safe source and blank lines', async () => {
  const { dom, document, elements } = fixture();
  const panel = document.querySelector('#code-panel');
  Object.defineProperties(panel, { scrollHeight: { get: () => 500 }, clientHeight: { get: () => 100 } });
  panel.scrollTop = 400;
  const renderer = createRenderer({ ...elements, getAutoScroll: () => false });
  renderer.update({ code: '<unsafe>\n\n', codeMeta: { filename: 'file.unknown', lang: 'unknown' } });
  await renderer.flush();
  assert.equal(panel.scrollTop, 400);
  assert.equal(elements.codeContent.querySelector('unsafe'), null);
  assert.equal(elements.codeContent.querySelectorAll('.line').length, 3);
  assert.equal(resolveLanguage('js'), 'javascript');
  assert.equal(resolveLanguage('unknown'), 'text');
  renderer.destroy();
  dom.window.close();
});

test('destroy cancels pending writes', async () => {
  const { dom, elements } = fixture();
  const renderer = createRenderer(elements);
  renderer.update({ text: 'Should not be rendered', codeMeta: {} });
  renderer.destroy();
  await renderer.flush();
  assert.equal(elements.textContent.textContent, '');
  dom.window.close();
});

test('stream append preserves an earlier paragraph, its text node and the reader selection', async () => {
  const { dom, document, elements } = fixture();
  const renderer = createRenderer(elements);
  const first = 'Сохраняем выбранный фрагмент.';
  renderer.update({ text: first + '\n\nНовый ответ', codeMeta: {} });
  await renderer.flush();
  const paragraph = elements.textContent.querySelector('p');
  const walker = document.createTreeWalker(paragraph, dom.window.NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode()) && !textNode.data.includes('выбранный')) {}
  assert.ok(textNode, 'the selected word must remain real selectable text');
  const offset = textNode.data.indexOf('выбранный');
  const range = document.createRange();
  range.setStart(textNode, offset);
  range.setEnd(textNode, offset + 'выбранный'.length);
  const selection = dom.window.getSelection();
  selection.addRange(range);
  const selected = selection.toString();
  for (const ending of [' продолжается', ' продолжается **постепенно**.']) {
    renderer.update({ text: first + '\n\nНовый ответ' + ending, codeMeta: {} });
    await renderer.flush();
    assert.equal(elements.textContent.firstElementChild, paragraph);
    assert.equal(paragraph.contains(textNode), true);
    assert.equal(selection.toString(), selected);
  }
  assert.equal(elements.textContent.querySelector('strong').textContent, 'постепенно');
  renderer.destroy();
  dom.window.close();
});

test('stream layout preserves exact copy text, spaces and inline Markdown semantics', async () => {
  const { dom, document, elements } = fixture();
  const renderer = createRenderer(elements);
  const source = 'Обычный **жирный** и _курсив_ — [ссылка](https://example.org).';
  renderer.update({ text: source + '\n\nНовый абзац', codeMeta: {} });
  await renderer.flush();
  const paragraph = elements.textContent.querySelector('p');
  const expected = 'Обычный жирный и курсив — ссылка.';
  const copied = document.createRange();
  copied.selectNodeContents(paragraph);
  assert.equal(copied.toString(), expected);
  assert.equal(paragraph.querySelector('strong').textContent, 'жирный');
  assert.equal(paragraph.querySelector('em').textContent, 'курсив');
  assert.equal(paragraph.querySelector('a').getAttribute('href'), 'https://example.org');
  renderer.update({ text: source + '\n\nНовый абзац дополняется.', codeMeta: {} });
  await renderer.flush();
  assert.equal(paragraph.textContent, expected);
  assert.equal(copied.toString(), expected);
  assert.equal(paragraph.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  renderer.destroy();
  dom.window.close();
});
