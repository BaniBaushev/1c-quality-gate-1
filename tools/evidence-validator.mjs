#!/usr/bin/env node
/**
 * Валидатор следа проверок (evidence).
 *
 * Зачем: невыполненная проверка неотличима от выполненной, если после неё ничего не
 * остаётся. Каждая проверка обязана оставить одну машиночитаемую строку — включая
 * ОБОСНОВАННЫЙ пропуск. Валидатор отвергает записи, которые лишь выглядят заполненными.
 *
 * Использование:
 *   node evidence-validator.mjs <файл> [--gate]
 *
 * Режимы:
 *   lint  (по умолчанию) — только оформление; ноль записей = чисто.
 *   gate  (--gate)       — строгий: нужны scope, sentinel=found и хотя бы одна проверка;
 *                          вердикт «чисто» без отметки о непроверенных измерениях отвергается.
 *
 * Коды выхода: 0 — чисто, 1 — предупреждения, 2 — блокирующие нарушения.
 */

import { readFileSync, existsSync } from 'node:fs';

export const SECTION = '## quality evidence';

const LAYERS = ['code', 'arch', 'xml', 'hygiene'];
const VOLUMES = ['C0', 'C1', 'C2', 'C3'];

/** Поля, без которых запись бессмысленна. Пустое значение приравнивается к отсутствию. */
const REQUIRED = {
  scope: ['volume', 'files', 'archetypes', 'driver', 'resolved'],
  applied: ['layer', 'scope', 'ids', 'verdict'],
  skipped: ['layer', 'reason'],
  not_verified: ['dimension', 'reason'],
  sentinel: ['target', 'status'],
};

const ID_PATTERN = /^(std\d{3,4}|bslls:[A-Za-z][\w-]*|acc:\d{3,4}|v8cs:[\w-]+|qg:[A-Z]+-[A-Z0-9]+|patterns:[\w:-]+)$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Разбирает `k=v, k=[a,b]` в объект. Списки отличаются от скаляров по квадратным скобкам. */
function parseFields(body) {
  const fields = {};
  let i = 0;
  while (i < body.length) {
    const eq = body.indexOf('=', i);
    if (eq === -1) break;
    const key = body.slice(i, eq).trim().replace(/^,\s*/, '');
    let value;
    let j = eq + 1;
    while (j < body.length && body[j] === ' ') j++;
    if (body[j] === '[') {
      const close = body.indexOf(']', j);
      if (close === -1) {
        value = body.slice(j).trim();
        i = body.length;
      } else {
        value = body
          .slice(j + 1, close)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        i = close + 1;
      }
    } else {
      let comma = body.indexOf(',', j);
      if (comma === -1) comma = body.length;
      value = body.slice(j, comma).trim();
      i = comma;
    }
    if (key) fields[key] = value;
    while (i < body.length && (body[i] === ',' || body[i] === ' ')) i++;
  }
  return fields;
}

/**
 * Вытаскивает записи вида `[qg <тип>: ...]` из секции evidence.
 *
 * Запись может занимать несколько строк: длинный `scope` естественно переносится, и
 * отвергать его за перенос значило бы наказывать за форматирование. Незакрытая запись
 * склеивается со следующими строками до закрывающей скобки.
 */
export function extractRecords(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === SECTION);
  const offset = start === -1 ? 0 : start + 1;
  const scan = start === -1 ? lines : lines.slice(start + 1);

  const records = [];
  for (let i = 0; i < scan.length; i++) {
    if (!/^\s*\[qg\s/.test(scan[i])) continue;

    let buffer = scan[i].trim();
    let consumed = 0;
    // Собираем продолжение, пока запись не закрыта. Пустая строка и начало новой записи
    // прерывают сбор: незакрытая запись должна упасть как дефект, а не съесть соседей.
    while (!buffer.endsWith(']') && i + consumed + 1 < scan.length) {
      const next = scan[i + consumed + 1];
      if (!next.trim() || /^\s*\[qg\s/.test(next)) break;
      buffer += ' ' + next.trim();
      consumed++;
    }

    const m = buffer.match(/^\[qg\s+([a-z_]+)\s*:\s*(.*)\]$/);
    if (m) {
      records.push({
        type: m[1],
        fields: parseFields(m[2]),
        line: offset + i + 1,
        raw: buffer,
      });
    } else {
      records.push({ type: '__malformed__', fields: {}, line: offset + i + 1, raw: buffer });
    }
    i += consumed;
  }
  return records;
}

function isEmpty(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim().length === 0;
}

export function validate(text, { gate = false } = {}) {
  const problems = [];
  const add = (severity, line, message) => problems.push({ severity, line, message });

  const records = extractRecords(text);

  for (const rec of records) {
    if (rec.type === '__malformed__') {
      add('error', rec.line, `запись не разобрана (не закрыта скобка или сломан формат): ${rec.raw.slice(0, 80)}`);
      continue;
    }
    const required = REQUIRED[rec.type];
    if (!required) {
      add('error', rec.line, `неизвестный тип записи "${rec.type}" (ожидались: ${Object.keys(REQUIRED).join(', ')})`);
      continue;
    }

    for (const field of required) {
      if (isEmpty(rec.fields[field])) {
        // Пустой обязательный список — не «проверил ничего», а отсутствие проверки.
        add('error', rec.line, `поле "${field}" отсутствует или пустое`);
      }
    }

    if (rec.fields.layer && !LAYERS.includes(rec.fields.layer)) {
      add('error', rec.line, `layer="${rec.fields.layer}" вне списка ${LAYERS.join('|')}`);
    }
    if (rec.type === 'scope' && rec.fields.volume && !VOLUMES.includes(rec.fields.volume)) {
      add('error', rec.line, `volume="${rec.fields.volume}" вне списка ${VOLUMES.join('|')}`);
    }
    if (rec.type === 'applied') {
      const v = rec.fields.verdict;
      if (v && v !== 'clean' && !/^violation:.+/.test(v)) {
        add('error', rec.line, `verdict="${v}": ожидается clean либо violation:<id>`);
      }
      if (rec.fields.scope && !KEBAB.test(rec.fields.scope)) {
        add('warn', rec.line, `scope="${rec.fields.scope}" не в kebab-case`);
      }
      const ids = Array.isArray(rec.fields.ids) ? rec.fields.ids : [];
      for (const id of ids) {
        if (!ID_PATTERN.test(id)) add('warn', rec.line, `идентификатор "${id}" непохож на stdNNN / bslls:X / acc:NNN / qg:X`);
      }
    }
    if (rec.type === 'sentinel' && rec.fields.status && !['found', 'not_found'].includes(rec.fields.status)) {
      add('error', rec.line, `status="${rec.fields.status}": ожидается found|not_found`);
    }
  }

  if (!gate) {
    return { records, problems, exitCode: problems.some((p) => p.severity === 'error') ? 2 : problems.length ? 1 : 0 };
  }

  // --- строгий режим ---------------------------------------------------------
  if (records.length === 0) {
    add('error', 0, 'нет ни одной записи: прогон без следа не считается выполненным');
  }

  const scopes = records.filter((r) => r.type === 'scope');
  if (scopes.length === 0) add('error', 0, 'нет записи scope: неизвестно, как выбиралась глубина проверки');
  if (scopes.length > 1) add('error', scopes[1].line, 'записей scope больше одной: профиль изменения определяется один раз');

  const checks = records.filter((r) => r.type === 'applied' || r.type === 'skipped');
  if (checks.length === 0) add('error', 0, 'нет ни одной записи applied/skipped: ни один контур не отчитался');

  const sentinels = records.filter((r) => r.type === 'sentinel');
  if (sentinels.length === 0) {
    add('error', 0, 'нет записи sentinel: невозможно отличить «нарушений нет» от «источник стандартов недоступен»');
  } else if (!sentinels.some((s) => s.fields.status === 'found')) {
    add('error', sentinels[0].line, 'sentinel не подтверждён (status=not_found): результат прогона недостоверен');
  }

  // Вердикт «чисто» обязан признавать то, что проверить было нечем.
  const applied = records.filter((r) => r.type === 'applied');
  const allClean = applied.length > 0 && applied.every((r) => r.fields.verdict === 'clean');
  const hasNotVerified = records.some((r) => r.type === 'not_verified');
  if (allClean && !hasNotVerified) {
    add(
      'error',
      0,
      'все проверки «clean», но нет ни одной записи not_verified. Компилируемость тел модулей не проверяется ' +
        'ни выгрузкой конфигурации, ни валидаторами XML — если /CheckConfig не запускался, это должно быть заявлено'
    );
  }

  const errors = problems.filter((p) => p.severity === 'error').length;
  return { records, problems, exitCode: errors ? 2 : problems.length ? 1 : 0 };
}

function main(argv) {
  const args = argv.slice(2);
  const gate = args.includes('--gate');
  const file = args.find((a) => !a.startsWith('--'));

  if (!file) {
    process.stderr.write('Использование: node evidence-validator.mjs <файл> [--gate]\n');
    return 2;
  }
  if (!existsSync(file)) {
    process.stderr.write(`Файл не найден: ${file}\n`);
    return 2;
  }

  const { records, problems, exitCode } = validate(readFileSync(file, 'utf8'), { gate });

  for (const p of problems) {
    const where = p.line ? `${file}:${p.line}` : file;
    process.stdout.write(`${p.severity === 'error' ? 'ОШИБКА' : 'ПРЕДУПРЕЖДЕНИЕ'} ${where} — ${p.message}\n`);
  }

  const errors = problems.filter((p) => p.severity === 'error').length;
  const warns = problems.length - errors;
  process.stdout.write(
    `\nЗаписей: ${records.length}. Ошибок: ${errors}, предупреждений: ${warns}. Режим: ${gate ? 'gate' : 'lint'}.\n`
  );
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('evidence-validator.mjs')) {
  process.exit(main(process.argv));
}
