import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMarkdownStream, markdownSnapshot } from '../src/js/markdown-stream.js';
import { createRenderer } from '../src/js/renderer.js';

const tick = String.fromCharCode(96);
const fence = tick.repeat(3);
const answer = '# Изменения\n\n**src/main.rs**\n' + fence + 'rust\nfn main() {\n    println!("Привет");\n}\n' + fence + '\n\n## Проверка\nЗапусти ' + tick + 'cargo run' + tick + '.';

test('ordinary Markdown reaches text rendering and code fences become a separate code panel', () => {
  const plain = '# Привет\n\n**Ответ** и ' + tick + 'код' + tick + '.';
  const text = markdownSnapshot(plain, true);
  assert.equal(text.mode, 'text');
  assert.equal(text.text, plain);
  const result = markdownSnapshot(answer, true);
  assert.equal(result.mode, 'code');
  assert.equal(result.codeMeta.filename, 'src/main.rs');
  assert.equal(result.codeMeta.lang, 'rust');
  assert.match(result.code, /println!\("Привет"\)/);
  assert.match(result.notes, /## Проверка/);
  assert.doesNotMatch(result.notes, /fn main/);
  assert.doesNotMatch(result.code, /Проверка/);
});

test('every transport split preserves code and guidance without requiring model-specific tags', () => {
  const expected = markdownSnapshot(answer, true);
  for (let split = 0; split <= answer.length; split += 1) {
    const parser = createMarkdownStream();
    parser.feed(answer.slice(0, split));
    parser.feed(answer.slice(split));
    assert.deepEqual(parser.finish(), expected);
  }
});

test('multiple files remain available in the left code panel and markup is sanitized', async () => {
  const payload = '# Готово\n' + fence + 'sql filename=users.sql\nSELECT 1;\n' + fence +
    '\n' + fence + 'rust filename=main.rs\nfn main() {}\n' + fence + '\n<script>window.bad=1</script>\nПроверь оба файла.';
  const snapshot = markdownSnapshot(payload, true);
  assert.equal(snapshot.codeBlocks.length, 2);
  const dom = new JSDOM('<div data-scroll-panel><div id="text"></div></div><div data-scroll-panel><div id="code"></div></div><div data-scroll-panel><div id="notes"></div></div><span id="filename"></span>');
  const document = dom.window.document;
  const renderer = createRenderer({
    textContent: document.getElementById('text'), codeContent: document.getElementById('code'),
    notesContent: document.getElementById('notes'), codeFilename: document.getElementById('filename'),
  });
  renderer.update(snapshot);
  await renderer.flush();
  assert.equal(document.querySelectorAll('#code pre').length, 2);
  assert.match(document.getElementById('code').textContent, /SELECT 1/);
  assert.match(document.getElementById('code').textContent, /fn main/);
  assert.match(document.getElementById('notes').textContent, /Проверь оба файла/);
  assert.equal(document.querySelectorAll('script').length, 0);
  renderer.destroy();
  dom.window.close();
});
