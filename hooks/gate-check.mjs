#!/usr/bin/env node
/**
 * Stop-хук: блокирует завершение, пока взведённый гейт качества не снят.
 *
 * exit 2 + сообщение в stderr — единственный механизм, который делает пропуск проверки
 * ОТЛИЧИМЫМ от её выполнения. Без него весь остальной плагин остаётся рекомендацией.
 *
 * Снять гейт может только `tools/gate.mjs release` — он требует непустой evidence,
 * поэтому «снял и забыл» не проходит.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPayload, projectRoot } from './_shared.mjs';

const STATE_DIR = ['.claude', '.state'];
const PENDING = 'qg-pending.json';

function main() {
  const payload = readPayload();

  // Защита от петли: если завершение уже остановлено этим хуком, второй раз не блокируем.
  if (payload?.stop_hook_active) return 0;

  const pendingPath = join(projectRoot(payload), ...STATE_DIR, PENDING);
  if (!existsSync(pendingPath)) return 0;

  let state;
  try {
    state = JSON.parse(readFileSync(pendingPath, 'utf8'));
  } catch {
    // Повреждённый маркер — блокируем: неизвестное состояние безопаснее считать непроверенным.
    process.stderr.write(
      '[ГЕЙТ КАЧЕСТВА 1С — ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО]\n' +
        'Маркер .claude/.state/qg-pending.json повреждён и не читается.\n' +
        'Прогони Skill: quality-gate заново либо удали маркер вручную, если правки не требуют проверки.\n'
    );
    return 2;
  }

  const files = Object.entries(state.files || {});
  if (files.length === 0) return 0;

  const bsl = files.filter(([, v]) => v.kind === 'bsl').map(([k]) => k);
  const xml = files.filter(([, v]) => v.kind === 'metadata-xml').map(([k]) => k);

  const lines = [
    '[ГЕЙТ КАЧЕСТВА 1С — ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО]',
    '',
    `В этой работе изменены файлы 1С (${files.length}), но Skill: quality-gate не прогонялся.`,
  ];

  if (bsl.length) {
    lines.push('', `BSL (${bsl.length}):`);
    lines.push(...bsl.slice(0, 10).map((f) => `  - ${f}`));
    if (bsl.length > 10) lines.push(`  … и ещё ${bsl.length - 10}`);
  }
  if (xml.length) {
    lines.push('', `XML метаданных (${xml.length}):`);
    lines.push(...xml.slice(0, 10).map((f) => `  - ${f}`));
    if (xml.length > 10) lines.push(`  … и ещё ${xml.length - 10}`);
  }

  lines.push(
    '',
    'Прогони Skill: quality-gate. Он определит глубину сам — по объёму правки,',
    'архетипам кода и сложности — и запустит только нужные контуры.',
    'Косметическая правка закрывается за секунды: класс C0 требует лишь гигиены файлов.',
    '',
    'Если правка действительно не требует проверки — сними гейт явно, с указанием причины:',
    '  node "${CLAUDE_PLUGIN_ROOT}/tools/gate.mjs" release --class C0 --reason "<почему>"',
    'Причина попадёт в след прогона: пропуск фиксируется, а не замалчивается.'
  );

  process.stderr.write(lines.join('\n') + '\n');
  return 2;
}

let code = 0;
try {
  code = main();
} catch {
  // Сбой самого хука не должен запирать пользователя в сессии.
  code = 0;
}
process.exit(code);
