import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamParser, stripOuterCodeFence } from '../src/js/stream-parser.js';

const SAMPLE = '<mode>code</mode><text>Краткое объяснение.</text><code_meta>{"filename":"users.sql","lang":"sql"}</code_meta><code>SELECT id, name\nFROM users\nWHERE active = true;</code><notes>1. Создайте `users.sql`.\n2. Запустите запрос.</notes>';

function parse(chunks, options) {
  const parser = createStreamParser(options);
  for (const chunk of chunks) parser.feed(chunk);
  return parser.finish();
}

test('every split point and single-character transport preserve response channels', () => {
  const expected = parse([SAMPLE]);
  for (let split = 0; split <= SAMPLE.length; split += 1) {
    assert.deepEqual(parse([SAMPLE.slice(0, split), SAMPLE.slice(split)]), expected, `split ${split}`);
  }
  assert.deepEqual(parse([...SAMPLE]), expected);
  assert.equal(expected.code, 'SELECT id, name\nFROM users\nWHERE active = true;');
  assert.equal(expected.notes, '1. Создайте `users.sql`.\n2. Запустите запрос.');
  assert.deepEqual(expected.codeMeta, { filename: 'users.sql', lang: 'sql' });
  assert.equal(expected.errors.length, 0);
});

test('unframed prose cannot enter code, including fragmented channel transitions', () => {
  const parser = createStreamParser();
  parser.feed('Here is the answer. <mode>code</mode><co');
  assert.equal(parser.snapshot().code, '');
  parser.feed('de>const answer = 42;</co');
  assert.equal(parser.snapshot().code, 'const answer = 42;');
  parser.feed('de>Do not copy this. <notes>Now run the file.</notes>Some trailing prose.');
  const result = parser.finish();
  assert.equal(result.code, 'const answer = 42;');
  assert.equal(result.notes, 'Now run the file.');
  assert.equal(result.text, '');
});

test('malformed missing code close recovers at notes without mixing instructions into code', () => {
  const result = parse(['<mode>code</mode><code>print(42)\n<notes>Create main.py.</notes>']);
  assert.equal(result.code, 'print(42)\n');
  assert.equal(result.notes, 'Create main.py.');
  assert.match(result.errors.join(' '), /Missing closing tag/);
});

test('ordinary HTML, comparisons and partial angle brackets remain literal source', () => {
  const code = '<div class="result">Hello & goodbye</div>\nif (a < b && b > c) return "<svg />";';
  const result = parse([...`<mode>code</mode><code>${code}</code>`]);
  assert.equal(result.code, code);
});

test('wrapper fences are stripped without deleting embedded backticks', () => {
  const source = 'const example = "```";\nconsole.log(example);';
  const result = parse([...`<mode>code</mode><code>\n\`\`\`javascript\n${source}\n\`\`\`\n</code>`]);
  assert.equal(result.code, source);
  assert.equal(stripOuterCodeFence('const a = "```";', true), 'const a = "```";');
  assert.equal(stripOuterCodeFence('~~~python\nprint(42)\n~~~', true), 'print(42)');
  assert.equal(stripOuterCodeFence('``'), '');
});

test('corrections keep earlier code and metadata while replacing guidance', () => {
  const parser = createStreamParser();
  parser.feed(SAMPLE);
  parser.finish();
  const original = parser.snapshot();
  parser.reset({ preserveCode: true });
  parser.feed('<mode>correction</mode><notes>Исправьте имя таблицы в редакторе.</notes>');
  let result = parser.finish();
  assert.equal(result.mode, 'correction');
  assert.equal(result.code, original.code);
  assert.deepEqual(result.codeMeta, original.codeMeta);
  assert.equal(result.notes, 'Исправьте имя таблицы в редакторе.');
  parser.reset({ preserveCode: true });
  parser.feed('<mode>correction</mode><code>SELECT 1;</code><notes>Обновлённый запрос.</notes>');
  result = parser.finish();
  assert.equal(result.code, 'SELECT 1;');
  parser.reset();
  parser.feed('<mode>text</mode><text>Новый ответ.</text>');
  result = parser.finish();
  assert.equal(result.mode, 'text');
  assert.equal(result.code, '');
  assert.equal(result.notes, '');
});

test('invalid metadata and unknown modes do not corrupt safe state', () => {
  for (const metadata of ['null', '[]', '{bad', '{"filename":"test.py"}', '{"filename":"bad\\u0000.py","lang":"python"}', '{"filename":"test.py","lang":"javascript:alert(1)"}']) {
    const result = parse([`<mode>bogus</mode><code_meta>${metadata}</code_meta><code>x = 1</code>`]);
    assert.deepEqual(result.codeMeta, { filename: 'untitled.txt', lang: 'text' });
    assert.ok(result.errors.length >= 2);
  }
});

test('truncated tags never flash into content; finish is idempotent', () => {
  const parser = createStreamParser();
  parser.feed('<text>Hello</tex');
  assert.equal(parser.snapshot().text, 'Hello');
  const result = parser.finish();
  assert.equal(result.text, 'Hello');
  assert.ok(result.errors.length > 0);
  assert.deepEqual(parser.finish(), result);
  assert.deepEqual(parser.feed('more tokens'), result);
});

test('response size limit bounds retained content and ends the stream', () => {
  const result = parse(['<text>' + 'x'.repeat(1000)], { maxCharacters: 128 });
  assert.ok(result.text.length <= 128);
  assert.ok(result.complete);
  assert.match(result.errors.join(' '), /maximum size/);
});

test('malformed responses cannot flood the error callback', () => {
  let errorEvents = 0;
  const result = parse(['</notes>'.repeat(1000)], { onError: () => { errorEvents += 1; } });
  assert.equal(result.errors.length, 8);
  assert.equal(errorEvents, 8);
  assert.equal(result.code, '');
});

test('snapshots cannot mutate internal metadata or errors and callbacks fire once per fragment', () => {
  let updates = 0;
  const parser = createStreamParser({ onUpdate: () => { updates += 1; } });
  parser.feed(SAMPLE);
  const snapshot = parser.snapshot();
  snapshot.codeMeta.filename = 'changed.txt';
  snapshot.errors.push('injected');
  assert.equal(parser.snapshot().codeMeta.filename, 'users.sql');
  assert.deepEqual(parser.snapshot().errors, []);
  assert.equal(updates, 1);
  assert.throws(() => parser.feed({ text: 'not a string' }), TypeError);
});
