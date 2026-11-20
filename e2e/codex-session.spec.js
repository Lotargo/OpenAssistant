import { test, expect } from '@playwright/test';
import { openNative, openAgent, connectAgent, sendTask, emitSession, settingsPage } from './helpers/native.js';

test('Codex connects without keys and streams tool activity, code and guidance through native Channel', async ({ page }, testInfo) => {
  let settings;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openNative(page);
  const sessionId = await connectAgent(page);
  settings = await settingsPage(page);
  const config = await page.evaluate(() => window.__nativeContract.calls.find(call => call.name === 'assistant_connect').args.config);
  expect(config).toMatchObject({ workspace: 'F:\\fixture-workspace', realtime: false });
  expect(Object.keys(config).some(key => /api.?key|token/i.test(key))).toBe(false);
  expect(await settings.locator('input[type="password"]').count()).toBe(0);

  const task = await sendTask(page, 'Проверь проект и покажи Rust-код');
  await expect(page.locator('#text-content')).toContainText('Codex выполняет задачу');
  await emitSession(page, sessionId, {
    type: 'agent_activity', task_id: task.task_id, item_id: task.task_id + '-command',
    kind: 'command', title: 'Проверка проекта', detail: '42\n', status: 'completed',
  });
  await emitSession(page, sessionId, {
    type: 'agent_activity', task_id: task.task_id, item_id: 'file-1', kind: 'file',
    title: 'Изменение файла', status: 'completed',
    changes: [{ path: 'answer.rs', diff: '+fn main() { println!("42"); }' }],
  });
  await emitSession(page, sessionId, {
    type: 'agent_activity', task_id: task.task_id, item_id: 'web-1', kind: 'web',
    title: 'Документация Rust', status: 'completed',
  });
  const fence = String.fromCharCode(96).repeat(3);
  const answer = '## Готово\n\n' + fence + 'rust filename="answer.rs"\nfn main() { println!("42"); }\n' + fence + '\n\nПроверка завершилась с кодом 0.';
  await page.evaluate(({ sessionId, taskId, answer }) => {
    const h = window.__nativeContract;
    for (let offset = 0; offset < answer.length; offset += 9) {
      h.emitSession(sessionId, { type: 'agent_delta', task_id: taskId, text: answer.slice(offset, offset + 9) });
    }
    h.finishTask(taskId, answer);
  }, { sessionId, taskId: task.task_id, answer });
  await expect(page.locator('#code-filename')).toHaveText('answer.rs');
  await expect(page.locator('#code-content')).toContainText('println!("42")');
  await expect(page.locator('#notes-content')).toContainText('Проверка завершилась с кодом 0.');
  await expect(page.locator('#code-content .line > span[style]')).not.toHaveCount(0);
  await expect(page.locator('#toolbar > button')).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath('codex-result.png'), animations: 'disabled' });

  settings = await openAgent(page);
  await settings.locator('.agent-history summary').click();
  await expect(settings.locator('#agent-log [data-kind="command"]')).toHaveCount(1);
  await expect(settings.locator('#agent-log [data-kind="command"]')).toContainText('42');
  await expect(settings.locator('#agent-log [data-kind="file"]')).toContainText('+fn main()');
  await expect(settings.locator('#agent-log [data-kind="web"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('native approval and clarification wait for user decisions and preserve in-progress answers', async ({ page }, testInfo) => {
  let settings;
  await openNative(page);
  const sessionId = await connectAgent(page);
  settings = await settingsPage(page);
  const task = await sendTask(page, 'Задача с подтверждением');
  await emitSession(page, sessionId, {
    type: 'agent_approval', task_id: task.task_id, request_id: 'approval-1',
    command: 'fixture command', reason: 'Требуется подтверждение действия', cwd: 'F:\\fixture-workspace',
    choices: ['accept', 'decline', 'cancel'],
  });
  await expect(settings.locator('#section-agent')).toBeVisible();
  await expect(settings.locator('.approval-card')).toContainText('fixture command');
  expect(await page.evaluate(() => window.__nativeContract.messages.filter(message => message.type === 'agent_approval'))).toEqual([]);
  expect(await settings.evaluate(() => Boolean(document.activeElement?.matches('[data-approval-decision]')))).toBe(false);
  await settings.screenshot({ path: testInfo.outputPath('codex-approval.png'), animations: 'disabled' });
  await settings.locator('[data-approval-decision="decline"]').click();
  await expect(settings.locator('.approval-card')).toHaveCount(0);
  expect(await page.evaluate(() => window.__nativeContract.messages.find(message => message.type === 'agent_approval')))
    .toMatchObject({ sessionId, request_id: 'approval-1', decision: 'decline' });

  await emitSession(page, sessionId, {
    type: 'agent_input', task_id: task.task_id, request_id: 'input-1',
    questions: [{
      id: 'destination', header: 'Файл', question: 'Куда записать результат?', isOther: true,
      options: [{ label: 'answer.rs', description: 'Rust' }, { label: 'answer.py', description: 'Python' }],
    }],
  });
  const form = settings.locator('.input-card');
  await expect(form).toBeVisible();
  await form.locator('[data-answer-choice]').selectOption('__other__');
  await form.locator('[data-answer-other]').fill('custom.rs');
  await emitSession(page, sessionId, { type: 'agent_activity', task_id: task.task_id, item_id: 'wait', kind: 'agent', title: 'Ожидаю ответ', status: 'running' });
  await expect(form.locator('[data-answer-other]')).toHaveValue('custom.rs');
  expect(await page.evaluate(() => window.__nativeContract.messages.filter(message => message.type === 'agent_input'))).toEqual([]);
  await form.getByRole('button', { name: 'Ответить', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__nativeContract.messages.find(message => message.type === 'agent_input')))
    .toMatchObject({ sessionId, request_id: 'input-1', answers: { destination: { answers: ['custom.rs'] } } });
  await page.evaluate(taskId => window.__nativeContract.finishTask(taskId, 'Результат принят.'), task.task_id);
});

test('parallel tasks share a session, keep separate results and interruption targets the selected task', async ({ page }) => {
  let settings;
  await openNative(page);
  const sessionId = await connectAgent(page);
  settings = await settingsPage(page);
  const first = await sendTask(page, 'Первая параллельная задача');
  const second = await sendTask(page, 'Вторая параллельная задача');
  expect(first.task_id).not.toBe(second.task_id);
  expect(await page.evaluate(() => window.__nativeContract.sessionIds)).toEqual([sessionId]);
  await page.evaluate(({ firstId, secondId }) => {
    window.__nativeContract.finishTask(firstId, 'Результат alpha');
    window.__nativeContract.finishTask(secondId, 'Результат beta');
  }, { firstId: first.task_id, secondId: second.task_id });
  await expect(page.locator('#text-content')).toHaveText('Результат beta');
  settings = await openAgent(page);
  await settings.locator('[data-select-task="' + first.task_id + '"]').click();
  await expect(settings.locator('#settings-dialog')).toBeHidden();
  await expect(page.locator('#text-content')).toHaveText('Результат alpha');

  const pending = await sendTask(page, 'Долгая задача для отмены');
  settings = await openAgent(page);
  await settings.locator('[data-interrupt-task="' + pending.task_id + '"]').click();
  expect(await page.evaluate(() => window.__nativeContract.messages.find(message => message.type === 'agent_interrupt')))
    .toMatchObject({ sessionId, task_id: pending.task_id });
  await expect(settings.locator('[data-interrupt-task]')).toHaveCount(0);
  await expect(settings.locator('#agent-tasks')).toContainText('Остановлено');
  await settings.locator('#agent-disconnect').click();
  expect(await page.evaluate(() => window.__nativeContract.calls.filter(call => call.name === 'assistant_disconnect').at(-1)?.args.sessionId)).toBe(sessionId);
});

test('Realtime startup failure leaves text tasks available on the same Codex session', async ({ page }) => {
  let settings;
  await openNative(page, { autoReady: false });
  settings = await openAgent(page);
  await settings.locator('#agent-realtime').check();
  await settings.locator('#agent-connect').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(1);
  const sessionId = await page.evaluate(() => window.__nativeContract.sessionIds[0]);
  await emitSession(page, sessionId, { type: 'status', stage: 'voice_error', detail: 'Голосовой канал временно недоступен', realtime: false, agent_available: true });
  await emitSession(page, sessionId, { type: 'agent_state', stage: 'ready', detail: 'Codex подключён' });
  await expect(settings.locator('#agent-connect')).toHaveText('Переподключить');
  await expect(settings.locator('#agent-error')).toContainText('Голосовой канал временно недоступен');
  const task = await sendTask(page, 'Продолжить без голоса');
  expect(await page.evaluate(() => window.__nativeContract.sessionIds)).toEqual([sessionId]);
  await page.evaluate(taskId => window.__nativeContract.finishTask(taskId, 'Текстовая задача выполнена.'), task.task_id);
  await expect(page.locator('#text-content')).toHaveText('Текстовая задача выполнена.');
  await expect(page.locator('[data-action="microphone"]')).toHaveAttribute('aria-pressed', 'true');
});

test('reconnecting fences late events from the old session', async ({ page }) => {
  let settings;
  await openNative(page);
  const oldSessionId = await connectAgent(page);
  settings = await settingsPage(page);
  await settings.locator('#agent-connect').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(2);
  const sessionId = await page.evaluate(() => window.__nativeContract.sessionIds.at(-1));
  await expect(settings.locator('#agent-connect')).toHaveText('Переподключить');
  const task = await sendTask(page, 'Текущая задача');
  await page.evaluate(taskId => window.__nativeContract.finishTask(taskId, 'Текущий ответ сохранён.'), task.task_id);
  await expect(page.locator('#text-content')).toHaveText('Текущий ответ сохранён.');
  for (const event of [
    { type: 'agent_task_started', task_id: 'obsolete', task: 'Старая задача' },
    { type: 'agent_delta', task_id: 'obsolete', text: 'Устаревший ответ' },
    { type: 'agent_error', message: 'Устаревшая ошибка' },
    { type: 'agent_state', stage: 'idle', detail: 'Устаревший статус' },
  ]) await emitSession(page, oldSessionId, event);
  await expect(page.locator('#text-content')).toHaveText('Текущий ответ сохранён.');
  await expect(settings.locator('#settings-dialog')).toBeHidden();
  settings = await openAgent(page);
  await expect(settings.locator('#agent-connect')).toHaveText('Переподключить');
  await expect(settings.locator('#agent-tasks')).not.toContainText('Старая задача');
  await expect(settings.locator('#agent-error')).toBeHidden();
  expect(sessionId).not.toBe(oldSessionId);
});

test('disconnect during a pending native connect disposes the late session without reviving it', async ({ page }) => {
  let settings;
  await openNative(page, { autoReady: false });
  settings = await openAgent(page);
  await settings.locator('#agent-realtime').uncheck();
  await page.evaluate(() => window.__nativeContract.delayNext('assistant_connect'));
  await settings.locator('#agent-connect').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.pending.filter(item => item.name === 'assistant_connect').length)).toBe(1);
  const sessionId = await page.evaluate(() => window.__nativeContract.sessionIds.at(-1));
  await settings.locator('#agent-disconnect').click();
  await page.evaluate(() => window.__nativeContract.release('assistant_connect'));
  await emitSession(page, sessionId, { type: 'agent_state', stage: 'ready', detail: 'Запоздавшее подключение' });
  await expect(settings.locator('#agent-connect')).toHaveText('Подключить');
  await expect.poll(() => page.evaluate(id => window.__nativeContract.calls.some(call => call.name === 'assistant_disconnect' && call.args.sessionId === id), sessionId)).toBe(true);
  expect(await page.evaluate(() => window.__nativeContract.messages.filter(message => message.type === 'agent_task'))).toEqual([]);
});

test('startup agent error releases connecting controls and permits a clean retry', async ({ page }) => {
  let settings;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openNative(page, { autoReady: false });
  settings = await openAgent(page);
  await settings.locator('#agent-realtime').check();
  await settings.locator('#agent-connect').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(1);
  const failedId = await page.evaluate(() => window.__nativeContract.sessionIds[0]);
  await emitSession(page, failedId, { type: 'status', stage: 'connecting', detail: 'Подключение Codex', realtime: false });
  await emitSession(page, failedId, { type: 'agent_state', stage: 'starting', detail: 'Запуск Codex' });
  const message = 'Codex rejected the request (code -32603).';
  await emitSession(page, failedId, { type: 'agent_error', message });

  await expect(settings.locator('#agent-connect')).toBeEnabled();
  await expect(settings.locator('#agent-connect')).toHaveText('Подключить');
  await expect(settings.locator('#agent-runtime')).toHaveText(message);
  await expect(settings.locator('#agent-error')).toHaveText(message);
  await expect(page.locator('[data-action="reconnect"]')).toHaveAttribute('data-state', 'error');
  await expect.poll(() => page.evaluate(id => window.__nativeContract.calls.some(call =>
    call.name === 'assistant_disconnect' && call.args.sessionId === id), failedId)).toBe(true);
  await emitSession(page, failedId, { type: 'session_closed', message: 'Позднее закрытие старой сессии.' });
  await expect(settings.locator('#agent-runtime')).toHaveText(message);

  await settings.locator('#agent-connect').click();
  await expect.poll(() => page.evaluate(() => window.__nativeContract.sessionIds.length)).toBe(2);
  const nextId = await page.evaluate(() => window.__nativeContract.sessionIds.at(-1));
  await emitSession(page, nextId, { type: 'agent_state', stage: 'ready', detail: 'Codex подключён' });
  await emitSession(page, nextId, { type: 'status', stage: 'ready', detail: 'Realtime подключён', realtime: true });
  await expect(settings.locator('#agent-connect')).toBeEnabled();
  await expect(settings.locator('#agent-connect')).toHaveText('Переподключить');
  await expect(settings.locator('#agent-error')).toBeHidden();
  await expect(settings.locator('#agent-runtime')).toHaveText('Codex подключён');
  expect(await page.evaluate(() => window.__nativeContract.messages.filter(message => message.type === 'agent_task'))).toEqual([]);
  expect(errors).toEqual([]);
});
