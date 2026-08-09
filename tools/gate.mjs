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
    const raw = JSON.parse(readFileSync(pending, 'utf8'));
    if (raw?.sessions) return raw;
    // Состояние старого формата (один набор файлов на проект) — поднимаем до сессионного.
    if (raw?.files) return { version: 2, sessions: { legacy: { armedAt: raw.armedAt, files: raw.files } } };
    return { version: 2, sessions: {} };
  } catch {
    return { corrupt: true, sessions: {} };
  }
}

/**
 * Выбирает сессию, с которой работаем.
 *
 * Явный --session надёжнее всего: его печатает сообщение блокировки. Без него берём
 * единственную (обычный случай) либо самую свежую. Наугад по нескольким сессиям не
 * работаем: снять чужой гейт значит объявить проверенной чужую работу.
 */
function pickSession(state, explicit) {
  const ids = Object.keys(state.sessions || {});
  if (explicit) return ids.includes(explicit) ? explicit : null;
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  return ids.sort((a, b) => String(state.sessions[b].updatedAt || '').localeCompare(String(state.sessions[a].updatedAt || '')))[0];
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

  const ids = Object.keys(state.sessions || {});
  if (ids.length === 0) {
    process.stdout.write('Гейт не взведён: изменений в файлах 1С не зафиксировано.\n');
    return 0;
  }

  for (const id of ids) {
    const s = state.sessions[id];
    const files = Object.entries(s.files || {});
    process.stdout.write(`Сессия ${id} — взведена ${s.armedAt}, файлов: ${files.length}\n`);
    for (const [path, meta] of files) {
      process.stdout.write(`  ${String(meta.kind).padEnd(13)} ${path}  (правок: ${meta.edits})\n`);
    }
    process.stdout.write('\n');
  }

  if (ids.length > 1) {
    process.stdout.write(
      'Сессий несколько: снимай гейт только своей — укажи --session <id>.\n' +
        'Снятие чужого гейта объявляет проверенной чужую работу.\n'
    );
  }
  process.stdout.write('Снять: node gate.mjs release --evidence <файл отчёта> [--session <id>]\n');
  return 0;
}

function cmdRelease(args) {
  const state = readPending();
  if (!state || Object.keys(state.sessions || {}).length === 0) {
    process.stdout.write('Гейт не взведён — снимать нечего.\n');
    return 0;
  }

  const explicit = typeof args.session === 'string' ? args.session : null;
  const sessionId = pickSession(state, explicit);
  if (!sessionId) {
    process.stderr.write(
      explicit
        ? `Сессия "${explicit}" в состоянии гейта не найдена. Доступны: ${Object.keys(state.sessions).join(', ')}\n`
        : 'Не удалось определить сессию — укажи --session <id>.\n'
    );
    return 2;
  }
  const sessionState = state.sessions[sessionId];

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
    // Заявленный класс сверяется с реальным охватом: иначе сорок изменённых модулей
    // закрываются десятисимвольной причиной, и дешёвый путь превращается в лазейку.
    const scope = Object.entries(sessionState.files || {});
    if (scope.length > 2) {
      process.stderr.write(
        `Заявлен класс ${cls}, но в охвате ${scope.length} файлов — это не точечная правка.\n` +
          'Нужен полноценный прогон: --evidence <файл>.\n'
      );
      return 2;
    }
    const heavilyEdited = scope.filter(([, meta]) => (meta.edits || 0) > 5);
    if (heavilyEdited.length) {
      process.stderr.write(
        `Заявлен класс ${cls}, но файл правился многократно (${heavilyEdited[0][1].edits} раз): ` +
          `${heavilyEdited[0][0]}\nЭто непохоже на косметику — нужен прогон: --evidence <файл>.\n`
      );
      return 2;
    }
  } else {
    process.stderr.write(
      'Нужен либо --evidence <файл>, либо пара --class C0|C1 --reason "<почему проверка не требуется>".\n'
    );
    return 2;
  }

  mkdirSync(dir, { recursive: true });

  // Снимаем ТОЛЬКО свою сессию: записи остальных остаются взведёнными, за них отвечают
  // их владельцы. Если своя была последней — файл состояния удаляется целиком.
  delete state.sessions[sessionId];
  if (Object.keys(state.sessions).length) {
    writeFileSync(pending, JSON.stringify(state, null, 2), 'utf8');
  } else {
    rmSync(pending, { force: true });
  }

  let doneState = { version: 2, sessions: {} };
  if (existsSync(done)) {
    try {
      const prev = JSON.parse(readFileSync(done, 'utf8'));
      if (prev?.sessions) doneState = prev;
    } catch {
      /* повреждённый журнал снятий перезаписываем */
    }
  }
  doneState.sessions[sessionId] = {
    releasedAt: new Date().toISOString(),
    armedAt: sessionState.armedAt,
    files: sessionState.files,
    mode: evidenceFile ? 'evidence' : 'declared',
    evidenceFile: evidenceFile || null,
    class: cls || null,
    reason: reason || null,
  };
  writeFileSync(done, JSON.stringify(doneState, null, 2), 'utf8');

  const count = Object.keys(sessionState.files || {}).length;
  const rest = Object.keys(state.sessions).length;
  process.stdout.write(
    (evidenceFile
      ? `Гейт сессии ${sessionId} снят по следу прогона (${evidenceFile}). Файлов в охвате: ${count}.\n`
      : `Гейт сессии ${sessionId} снят как ${cls} без прогона. Причина: ${reason}\nФайлов в охвате: ${count}.\n`) +
      (rest ? `Остаются взведёнными гейты других сессий: ${rest}. Их не трогаем.\n` : '')
  );
  return 0;
}

/**
 * Отмечает файлы проверенными на их текущем содержимом.
 *
 * Гейт — требование к СОСТОЯНИЮ артефакта, а не просьба ещё раз позвать тот же инструмент.
 * Если слой уже отработал по этому содержимому, повторный прогон — трата времени. Отметку
 * снимает хук взвода при любой правке файла, поэтому устаревшее доказательство
 * переиспользовано быть не может.
 */
function cmdVerify(args) {
  const state = readPending();
  if (!state || state.corrupt) {
    process.stdout.write('Гейт не взведён — отмечать нечего.\n');
    return 0;
  }

  const layer = typeof args.layer === 'string' ? args.layer : null;
  const files = args._ || [];
  if (!layer || files.length === 0) {
    process.stderr.write('Использование: node gate.mjs verify --layer <code|arch|xml|hygiene> <файл> [...]\n');
    return 2;
  }

  const sessionId = pickSession(state, typeof args.session === 'string' ? args.session : null);
  if (!sessionId) {
    process.stderr.write('Не удалось определить сессию — укажи --session <id> из сообщения о блокировке.\n');
    return 2;
  }

  const session = state.sessions[sessionId];
  const now = new Date().toISOString();
  let marked = 0;

  for (const rel of Object.keys(session.files || {})) {
    if (!files.some((f) => rel.endsWith(String(f).replace(/\\/g, '/')))) continue;
    const entry = session.files[rel];
    entry.verified = entry.verified || {};
    entry.verified[layer] = now;
    marked++;
  }

  if (marked === 0) {
    process.stdout.write('Ни один из указанных файлов не найден в охвате гейта этой сессии.\n');
    return 1;
  }

  writeFileSync(paths().pending, JSON.stringify(state, null, 2), 'utf8');
  process.stdout.write(`Отмечено проверенным на слое ${layer}: ${marked} файл(ов).\n`);
  process.stdout.write('Отметка снимается автоматически при следующей правке файла.\n');
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'verify':
      return cmdVerify(args);
    case 'release':
      return cmdRelease(args);
    default:
      process.stderr.write(
        'Использование:\n' +
          '  node gate.mjs status\n' +
          '  node gate.mjs verify --layer <code|arch|xml|hygiene> <файл> [...]\n' +
          '  node gate.mjs release --evidence <файл>\n' +
          '  node gate.mjs release --class C0 --reason "<почему>"\n'
      );
      return 2;
  }
}

process.exit(main(process.argv));
