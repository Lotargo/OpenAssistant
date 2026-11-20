import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityJournal, formatJournal } from '../src/js/activity-journal.js';

test('partial progress preserves original command, file changes and creation time', () => {
  let now = 1700000000000;
  const journal = createActivityJournal({ clock: () => now });
  const first = journal.record({
    task_id: 'task-a', item_id: 'step-a', thread_id: 'thread-a', kind: 'file', title: 'Update example',
    status: 'running', command: 'fixture check', path: 'example.rs', diff: '+first',
    changes: [{ path: 'one.rs', diff: '+one' }, { path: 'two.rs', diff: '+two' }],
  }, 7);
  now += 300;
  const [completed] = journal.record({ task_id: 'task-a', item_id: 'step-a', status: 'completed', detail: 'Verified' }, 7);
  assert.equal(journal.entries().length, 1);
  assert.equal(completed.timestamp, first[0].timestamp);
  assert.equal(completed.updated_at, now);
  assert.equal(completed.title, 'Update example');
  assert.equal(completed.command, 'fixture check');
  assert.equal(completed.path, 'example.rs');
  assert.equal(completed.diff, '+first');
  assert.deepEqual(completed.changes, [{ path: 'one.rs', diff: '+one' }, { path: 'two.rs', diff: '+two' }]);
  const copied = formatJournal(journal.entries());
  for (const text of ['Update example', 'completed', 'task-a', 'step-a', 'thread-a',
    'fixture check', 'Verified', 'example.rs', '+first', 'one.rs', '+one', 'two.rs', '+two']) {
    assert.ok(copied.includes(text), text + ' must be copied');
  }
});

test('clear suppresses late updates including evicted steps while a new item and a new session remain visible', () => {
  const journal = createActivityJournal({ limit: 2, clock: () => 1 });
  const step = item_id => ({ task_id: 'running-task', item_id, title: item_id, status: 'running' });
  journal.record(step('old-evicted'), 1);
  journal.record(step('old-a'), 1);
  journal.record(step('old-b'), 1);
  assert.equal(journal.entries().length, 2);
  assert.equal(journal.clear(), 2);
  for (const id of ['old-evicted', 'old-a', 'old-b']) {
    assert.deepEqual(journal.record({ ...step(id), status: 'completed' }, 1), []);
  }
  assert.equal(formatJournal(journal.entries()), '');
  assert.equal(journal.record(step('new-step'), 1).length, 1);
  const nextSession = journal.record(step('old-a'), 2);
  assert.deepEqual(nextSession.map(item => item.item_id), ['new-step', 'old-a']);
  assert.equal(journal.record({ ...step('old-a'), task_id: 'another-task' }, 2).length, 2);
});

test('copy represents the retained records and bounds oversized file-change payloads', () => {
  const journal = createActivityJournal({ limit: 80, clock: () => 0 });
  for (let i = 0; i < 85; i++) {
    journal.record({ task_id: 't', item_id: String(i), title: 'Record ' + String(i).padStart(2, '0'), status: 'completed' }, 1);
  }
  const records = journal.entries();
  assert.equal(records.length, 80);
  const text = formatJournal(records);
  assert.ok(!text.includes('Record 04'));
  for (const record of records) assert.ok(text.includes(record.title));
  const bounded = createActivityJournal({ clock: () => 0 }).record({
    task_id: 'large', item_id: 'large', title: 'Large changes',
    changes: Array.from({ length: 100 }, (_, i) => ({ path: 'file-' + i, diff: 'x'.repeat(15000) })),
  })[0];
  assert.ok(formatJournal([bounded]).length < 30000, 'copy must share the bounded per-record payload');
});
