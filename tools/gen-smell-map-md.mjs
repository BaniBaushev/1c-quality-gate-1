#!/usr/bin/env node
/**
 * Генерирует человекочитаемую карту запахов из источника истины smell-map.json.
 *
 * Зачем скрипт, а не ручная синхронизация: две вручную поддерживаемые копии одного знания
 * расходятся при первой же правке — ровно тот дефект, который ищет запах ARCH-A3.
 *
 * Использование:
 *   node tools/gen-smell-map-md.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const refs = join(here, '..', 'skills', 'bsl-architecture-review', 'references');
const src = join(refs, 'smell-map.json');
const dst = join(refs, 'smell-map.md');

const map = JSON.parse(readFileSync(src, 'utf8'));

const head = [
  '# Карта архитектурных запахов',
  '',
  'Производный файл — **источник истины `smell-map.json`**. Правки вносить туда, эту страницу',
  'перегенерировать: `node tools/gen-smell-map-md.mjs`.',
  '',
  'Тексты принципов здесь не хранятся — запрашиваются по URL через MCP `v8std`.',
  '',
  'Порядок работы с каждым запахом: измерить сигнал → проверить контр-сигнал → запросить',
  'принцип по ссылке → сформулировать целевую структуру. Ложноположительная архитектурная',
  'находка дороже пропущенной, поэтому контр-сигнал проверяется всегда.',
  '',
];

const body = map.smells.flatMap((s) => [
  `## ${s.id} · ${s.smell}`,
  '',
  `**Сигнал:** ${s.signal}`,
  '',
  `**Порог:** ${s.threshold}`,
  '',
  `**Контр-сигнал (когда это НЕ дефект):** ${s.counter}`,
  '',
  '**Принципы:**',
  '',
  ...s.principles.map((p) => `- [${p.title}](${p.url})`),
  ...(s.std.length ? ['', `**Стандарты:** ${s.std.map((x) => '#' + x).join(', ')}`] : []),
  '',
]);

writeFileSync(dst, [...head, ...body].join('\n'), 'utf8');
process.stdout.write(`Записано запахов: ${map.smells.length} → ${dst}\n`);
