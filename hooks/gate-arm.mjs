#!/usr/bin/env node
/**
 * PostToolUse-хук: взводит гейт качества при правке файлов 1С.
 *
 * Гейт взводится ВСЕГДА, когда затронут файл 1С, — хук видит одну правку и не может
 * оценить её масштаб. Градация работает не здесь, а на снятии: прогон класса C0/C1
 * занимает секунды и снимает маркер так же законно, как полный. Тем самым молчаливый
 * пропуск невозможен, но дешёвый честный путь есть.
 *
 * Любая внутренняя ошибка — молча exit 0: хук качества не имеет права ломать работу.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readPayload, projectRoot, toProjectRelative } from './_shared.mjs';

const STATE_DIR = ['.claude', '.state'];
const PENDING = 'qg-pending.json';
const DONE = 'qg-done.json';

/**
 * Определяет, файл какого рода затронут.
 * Возвращает null для всего, что не относится к 1С, — в не-1С проектах плагин молчит.
 */
function classifyFile(filePath) {
  const p = filePath.replace(/\\/g, '/');
  const lower = p.toLowerCase();

  if (lower.endsWith('.bsl') || lower.endsWith('.os')) return 'bsl';

  if (lower.endsWith('.xml')) {
    // XML метаданных 1С лежит в дереве исходников конфигурации или расширения.
    if (/(^|\/)(src|cf|cfe)\//.test(lower)) return 'metadata-xml';
    // Configuration.xml — корень выгрузки, может лежать и вне src/.
    if (/(^|\/)configuration\.xml$/.test(lower)) return 'metadata-xml';
    return null;
  }

  return null;
}

const HINTS = {
  'bsl': [
    '[1C QUALITY GATE — взведён: BSL]',
    'Файл: %FILE%',
    '',
    'Перед завершением работы прогони Skill: quality-gate.',
    'Он сам определит глубину по трём осям (объём правки, архетипы кода, сложность)',
    'и запустит только нужные контуры. Мелкая правка проверяется за секунды.',
    '',
    'Завершение сессии заблокировано, пока гейт не снят.',
  ],
  'metadata-xml': [
    '[1C QUALITY GATE — взведён: XML метаданных]',
    'Файл: %FILE%',
    '',
    'Перед завершением работы прогони Skill: quality-gate.',
    'Для нового объекта критична проверка регистрации в Configuration.xml:',
    'файл-сирота вне <ChildObjects> не попадает в сборку, при этом конфигуратор',
    'её не диагностирует — ошибка всплывает только в рантайме.',
    '',
    'Завершение сессии заблокировано, пока гейт не снят.',
  ],
};

function main() {
  const payload = readPayload();
  if (!payload) return;

  const filePath = payload?.tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') return;

  const kind = classifyFile(filePath);
  if (!kind) return;

  const root = projectRoot(payload);
  const stateDir = join(root, ...STATE_DIR);
  const pendingPath = join(stateDir, PENDING);
  const donePath = join(stateDir, DONE);

  mkdirSync(stateDir, { recursive: true });

  let state = { armedAt: new Date().toISOString(), files: {} };
  if (existsSync(pendingPath)) {
    try {
      const prev = JSON.parse(readFileSync(pendingPath, 'utf8'));
      if (prev && typeof prev === 'object' && prev.files) state = prev;
    } catch {
      /* повреждённый маркер перезаписываем свежим */
    }
  }

  const rel = toProjectRelative(root, filePath);
  const entry = state.files[rel] || { kind, edits: 0 };
  entry.kind = kind;
  entry.edits += 1;
  entry.lastEdit = new Date().toISOString();
  state.files[rel] = entry;
  state.updatedAt = entry.lastEdit;

  writeFileSync(pendingPath, JSON.stringify(state, null, 2), 'utf8');

  // Новая правка обесценивает прошлый прогон: снятый ранее гейт больше не действителен.
  if (existsSync(donePath)) {
    try {
      rmSync(donePath, { force: true });
    } catch {
      /* не критично */
    }
  }

  process.stdout.write(HINTS[kind].join('\n').replace('%FILE%', rel) + '\n');
}

try {
  main();
} catch {
  /* хук качества никогда не ломает работу пользователя */
}
process.exit(0);
