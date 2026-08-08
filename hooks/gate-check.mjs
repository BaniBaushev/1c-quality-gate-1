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

  // stop_hook_active НЕ является основанием пропустить блок. Иначе гейт обходится второй
  // попыткой завершения: первый Stop блокирует, второй проходит с непроверенным кодом —
  // и весь механизм вырождается в разовое предупреждение. Зацикливания здесь нет по
  // построению: выход из блока всегда доступен (прогон навыка либо явное снятие с
  // указанием причины), а на повторной попытке сообщение дополняется прямым путём.
  const repeated = Boolean(payload?.stop_hook_active);

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

  // Блокируем ТОЛЬКО за правки этой сессии. Чужие остаются в состоянии нетронутыми:
  // параллельная сессия отвечает за свой гейт сама, а перехватывать её работу нельзя.
  const sessionId = String(payload?.session_id || 'unknown-session');
  const sessions = state.sessions || (state.files ? { legacy: { files: state.files } } : {});
  const mine = sessions[sessionId]?.files || {};
  const files = Object.entries(mine);

  const foreign = Object.entries(sessions)
    .filter(([id]) => id !== sessionId)
    .reduce((sum, [, s]) => sum + Object.keys(s.files || {}).length, 0);

  if (files.length === 0) {
    if (foreign > 0) {
      // Не блокируем, но и не скрываем: пусть видно, что в проекте есть непроверенные
      // правки другой сессии — их владелец разберётся с ними сам.
      process.stderr.write(
        `[гейт качества] В проекте есть непроверенные правки другой сессии (${foreign}). ` +
          'Эта сессия их не касалась — завершение не блокируется.\n'
      );
    }
    return 0;
  }

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
    '  node "<каталог плагина>/tools/gate.mjs" release --class C0 --reason "<почему>"',
    'Причина сохраняется в состоянии: пропуск фиксируется, а не замалчивается.'
  );

  lines.push('', `Сессия: ${sessionId}`);
  if (foreign > 0) {
    lines.push(
      `В проекте есть также правки другой сессии (${foreign}) — их НЕ трогай:`,
      'за них отвечает та сессия, снятие чужого гейта перехватывает чужую работу.'
    );
  }

  if (repeated) {
    // Повторная попытка завершения: гейт не пропускает по-прежнему, но если снятие
    // штатным путём почему-то недоступно, показываем точную команду отказа.
    lines.push(
      '',
      'Это повторная попытка завершения — блокировка не снимается сама.',
      `Крайний случай: node "<каталог плагина>/tools/gate.mjs" release --session ${sessionId} --class C0 --reason "<почему>"`
    );
  }

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
