#!/usr/bin/env node
/**
 * Управление гейтом качества: показать состояние, снять после прогона.
 *
 * Гейт снимается ТОЛЬКО отсюда, а не удалением файла руками, потому что снятие обязано
 * оставить след: чем закончился прогон, какой класс правки, что не проверялось и почему.
 * Иначе гейт вырождается в формальность, которую снимают не глядя.
 *
 * Использование:
 *   node gate.mjs status
 *   node gate.mjs release --evidence <файл>            # снять по результатам прогона
 *   node gate.mjs release --class C0 --reason "<...>"  # снять как не требующий проверки
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './evidence-validator.mjs';

const STATE_DIR = ['.claude', '.state'];
const PENDING = 'qg-pending.json';
const DONE = 'qg-done.json';

function root() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function paths() {
  const dir = join(root(), ...STATE_DIR);
  return { dir, pending: join(dir, PENDING), done: join(dir, DONE) };
}

function readPending() {
  const { pending } = paths();
  if (!existsSync(pending)) return null;
  try {
    return JSON.parse(readFileSync(pending, 'utf8'));
  } catch {
    return { corrupt: true, files: {} };
  }
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function cmdStatus() {
  const state = readPending();
  if (!state) {
    process.stdout.write('Гейт не взведён: изменений в файлах 1С не зафиксировано.\n');
    return 0;
  }
  if (state.corrupt) {
    process.stdout.write('Гейт взведён, но маркер повреждён и не читается.\n');
    return 1;
  }
  const files = Object.entries(state.files || {});
  process.stdout.write(`Гейт взведён с ${state.armedAt}. Файлов: ${files.length}.\n\n`);
  for (const [path, meta] of files) {
    process.stdout.write(`  ${meta.kind.padEnd(13)} ${path}  (правок: ${meta.edits})\n`);
  }
  process.stdout.write('\nСнять: node gate.mjs release --evidence <файл отчёта>\n');
  return 0;
}

function cmdRelease(args) {
  const state = readPending();
  if (!state) {
    process.stdout.write('Гейт не взведён — снимать нечего.\n');
    return 0;
  }

  const { dir, pending, done } = paths();
  const evidenceFile = typeof args.evidence === 'string' ? args.evidence : null;
  const cls = typeof args.class === 'string' ? args.class : null;
  const reason = typeof args.reason === 'string' ? args.reason : null;

  let evidenceText = null;

  if (evidenceFile) {
    if (!existsSync(evidenceFile)) {
      process.stderr.write(`Файл следа не найден: ${evidenceFile}\n`);
      return 2;
    }
    evidenceText = readFileSync(evidenceFile, 'utf8');
    const { problems, exitCode } = validate(evidenceText, { gate: true });
    if (exitCode === 2) {
      process.stderr.write('След прогона не прошёл проверку — гейт НЕ снят:\n\n');
      for (const p of problems.filter((x) => x.severity === 'error')) {
        process.stderr.write(`  ОШИБКА ${evidenceFile}:${p.line || '?'} — ${p.message}\n`);
      }
      process.stderr.write('\nИсправь след и повтори снятие.\n');
      return 2;
    }
  } else if (cls && reason) {
    if (!['C0', 'C1'].includes(cls)) {
      process.stderr.write(
        `Снятие без следа допустимо только для класса C0/C1 (получено: ${cls}).\n` +
          'Для C2/C3 нужен полноценный прогон: --evidence <файл>.\n'
      );
      return 2;
    }
    if (reason.trim().length < 10) {
      process.stderr.write('Причина слишком короткая: напиши, почему проверка не требуется.\n');
      return 2;
    }
  } else {
    process.stderr.write(
      'Нужен либо --evidence <файл>, либо пара --class C0|C1 --reason "<почему проверка не требуется>".\n'
    );
    return 2;
  }

  mkdirSync(dir, { recursive: true });
  const record = {
    releasedAt: new Date().toISOString(),
    armedAt: state.armedAt,
    files: state.files,
    mode: evidenceFile ? 'evidence' : 'declared',
    evidenceFile: evidenceFile || null,
    class: cls || null,
    reason: reason || null,
  };
  writeFileSync(done, JSON.stringify(record, null, 2), 'utf8');
  rmSync(pending, { force: true });

  const count = Object.keys(state.files || {}).length;
  process.stdout.write(
    evidenceFile
      ? `Гейт снят по следу прогона (${evidenceFile}). Файлов в охвате: ${count}.\n`
      : `Гейт снят как ${cls} без прогона. Причина: ${reason}\nФайлов в охвате: ${count}.\n`
  );
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'release':
      return cmdRelease(args);
    default:
      process.stderr.write(
        'Использование:\n' +
          '  node gate.mjs status\n' +
          '  node gate.mjs release --evidence <файл>\n' +
          '  node gate.mjs release --class C0 --reason "<почему>"\n'
      );
      return 2;
  }
}

process.exit(main(process.argv));
