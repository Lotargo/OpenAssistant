// Explicit visual fixtures: only used when ?demo=... is supplied.
export const TEXT_DEMO = `<mode>text</mode><text># Найти два числа с заданной суммой

Верните индексы двух элементов массива, сумма которых равна \`target\`.

## Подход
Пройдите по массиву один раз. Храните уже просмотренные числа и их индексы в хеш-таблице.

## Последовательность
1. Для текущего \`x\` вычислите \`target − x\`.
2. Если дополнение уже есть в таблице, верните пару индексов.
3. Иначе сохраните \`x → i\` и переходите к следующему элементу.

## Сложность
- **Время:** \`O(n)\`.
- **Память:** \`O(n)\`.</text>`;

export const CODE_DEMO = `<mode>code</mode><code_meta>{"filename":"users.sql","lang":"sql"}</code_meta><code>-- users.sql
-- Последние 10 активных пользователей

SELECT
    id,
    name,
    email,
    created_at
FROM users
WHERE status = 'active'
ORDER BY created_at DESC
LIMIT 10;

-- Следующая страница:
-- LIMIT 10 OFFSET 10;
</code><notes># Что делать

Получите до 10 активных пользователей, начиная с недавно зарегистрированных.

## Шаги
1. Создайте файл **users.sql**.
2. Вставьте запрос из левой панели.
3. Откройте подключение к своей БД в SQL-клиенте.
4. Выполните запрос и проверьте результат.

## Пояснения
- \`WHERE\` оставляет активных пользователей.
- \`ORDER BY created_at DESC\` ставит новые записи первыми.
- \`LIMIT 10\` ограничивает число строк.</notes>`;

export async function playDemo(parser, mode, { signal } = {}) {
  const data = mode === 'code' || mode === 'stream' ? CODE_DEMO : TEXT_DEMO;
  parser.reset();
  if (mode !== 'stream') {
    parser.feed(data);
    parser.finish();
    return;
  }
  for (let offset = 0; offset < data.length && !signal?.aborted; offset += 13) {
    parser.feed(data.slice(offset, offset + 13));
    await new Promise(resolve => setTimeout(resolve, 18));
  }
  if (!signal?.aborted) parser.finish();
}
