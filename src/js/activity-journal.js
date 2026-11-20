/** A bounded in-memory journal shared with the settings window.
 * Clearing affects records only; task state and pending approvals stay intact.
 */
const clean = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const limits = {
  title: 256, detail: 8000, command: 8000, path: 2048, diff: 12000,
  task_id: 256, thread_id: 256, item_id: 256, kind: 64, status: 64,
};

function normalize(activity, timestamp) {
  const item = {};
  for (const [key, limit] of Object.entries(limits)) item[key] = clean(activity?.[key], limit);
  item.title ||= item.kind || 'Событие';
  let budget = 24000;
  item.changes = [];
  for (const change of Array.isArray(activity?.changes) ? activity.changes.slice(0, 12) : []) {
    if (!change || typeof change !== 'object' || budget <= 0) continue;
    const path = clean(change.path, Math.min(2048, budget)); budget -= path.length;
    const diff = clean(change.diff, Math.min(12000, budget)); budget -= diff.length;
    if (path || diff) item.changes.push({ path, diff });
  }
  item.timestamp = timestamp;
  item.updated_at = timestamp;
  return item;
}

export function createActivityJournal({ limit = 80, clock = Date.now } = {}) {
  let records = [];
  let sequence = 0;
  const seen = new Map();
  const hidden = new Set();
  const snapshot = () => records.map(item => ({ ...item, changes: item.changes.map(change => ({ ...change })) }));
  function remember(key) {
    if (!key) return;
    seen.delete(key);
    seen.set(key, true);
    while (seen.size > 512) seen.delete(seen.keys().next().value);
  }
  return {
    record(activity, scope = 0) {
      const timestamp = clock();
      const next = normalize(activity, timestamp);
      const merge = Boolean(next.item_id || next.task_id);
      const key = merge ? JSON.stringify([scope, next.task_id, next.item_id || next.title]) : null;
      if (key && hidden.has(key)) return snapshot();
      const existing = key ? records.findIndex(item => item.journal_id === key) : -1;
      if (existing >= 0) {
        const previous = records[existing];
        // Partial progress events must preserve the earlier command/path/diff.
        for (const field of Object.keys(limits)) {
          if (!(field in activity)) next[field] = previous[field];
        }
        if (!('changes' in activity)) next.changes = previous.changes;
        records[existing] = { ...previous, ...next, timestamp: previous.timestamp, journal_id: key };
      } else {
        records.push({ ...next, journal_id: key || JSON.stringify([scope, 'event', ++sequence]) });
        records = records.slice(-limit);
      }
      remember(key);
      return snapshot();
    },
    clear() {
      const count = records.length;
      for (const key of seen.keys()) hidden.add(key);
      while (hidden.size > 512) hidden.delete(hidden.values().next().value);
      records = [];
      return count;
    },
    entries: snapshot,
  };
}

export function formatJournal(records = []) {
  if (!records.length) return '';
  const fields = [
    ['kind', 'Категория'], ['status', 'Статус'], ['task_id', 'Задача'],
    ['thread_id', 'Диалог'], ['item_id', 'Шаг'], ['path', 'Путь'],
    ['command', 'Команда'], ['detail', 'Подробности'], ['diff', 'Изменения'],
  ];
  return 'OpenAssistant — журнал\n\n' + records.map(record => {
    const date = new Date(record.timestamp);
    const time = Number.isFinite(date.getTime()) ? date.toISOString() : '';
    const lines = [(time ? '[' + time + '] ' : '') + (record.title || 'Событие')];
    for (const [key, label] of fields) {
      if (record[key]) lines.push(label + ': ' + record[key]);
    }
    for (const change of Array.isArray(record.changes) ? record.changes : []) {
      if (change.path) lines.push('Файл: ' + change.path);
      if (change.diff) lines.push('Изменения файла:\n' + change.diff);
    }
    return lines.join('\n');
  }).join('\n\n────────────────────\n\n');
}
