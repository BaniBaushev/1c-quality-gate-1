#!/usr/bin/env node
/**
 * Гигиена файлов 1С: кодировка, BOM, недопустимые символы, переводы строк.
 *
 * Дешёвая проверка на уровне байтов. Ловит класс дефектов, который проявляется позже всего и
 * объясняется хуже всего: файл выглядит правильно в редакторе, а платформа его не принимает
 * либо принимает не так.
 *
 * Работает ТОЛЬКО по явному списку файлов (обычно из диффа). Обход всего дерева выгрузки
 * занимает минуты и в гейте недопустим.
 *
 * Использование:
 *   node hygiene-check.mjs <файл> [<файл> ...] [--json]
 */

import { readFileSync, existsSync } from 'node:fs';
import { recordRun } from './run-journal.mjs';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Тире, которые платформа считает недопустимым символом в тексте модуля. */
const DASHES = [
  { ch: '—', name: 'длинное тире' },
  { ch: '–', name: 'короткое тире' },
  { ch: '−', name: 'математический минус' },
  { ch: '‑', name: 'неразрывный дефис' },
];

/**
 * Вырезает содержимое строковых литералов, оставляя код и комментарии.
 *
 * Нужно, чтобы не ругаться на тире в текстах, предназначенных пользователю: там оно уместно и
 * встречается даже в типовых модулях. Проверять надо код и комментарии, а не сообщения.
 *
 * Приближение намеренное: полноценный разбор BSL здесь избыточен, а цена ошибки низкая —
 * находка этого уровня не блокирует.
 */
function stripStringLiterals(line) {
  const trimmed = line.trimStart();
  // Продолжение многострочного литерала — целиком текст, пропускаем.
  if (trimmed.startsWith('|')) return '';

  let out = '';
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      // Удвоенная кавычка внутри литерала — не выход из него.
      if (inString && line[i + 1] === '"') {
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString) out += c;
  }
  return out;
}

function checkFile(path) {
  const findings = [];
  if (!existsSync(path)) {
    return [{ severity: 'error', rule: 'file-missing', line: 0, message: 'файл не найден' }];
  }

  const buf = readFileSync(path);
  const isBsl = /\.(bsl|os)$/i.test(path);
  const isXml = /\.xml$/i.test(path);

  // 1. Кодировка: файл обязан быть валидным UTF-8.
  const text = buf.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), buf) !== 0) {
    findings.push({
      severity: 'error',
      rule: 'encoding',
      line: 0,
      message: 'файл не является валидным UTF-8 — вероятна запись в однобайтовой кодировке',
    });
  }

  // 2. BOM: выгрузка 1С хранит модули и XML метаданных с BOM.
  const hasBom = buf.length >= 3 && Buffer.compare(buf.subarray(0, 3), BOM) === 0;
  if ((isBsl || isXml) && !hasBom) {
    findings.push({
      severity: 'warn',
      rule: 'bom-missing',
      line: 0,
      message: 'нет BOM: платформа ожидает UTF-8 с BOM, иначе возможны проблемы с кириллицей',
    });
  }

  const body = hasBom ? text.slice(1) : text;
  const lines = body.split(/\r\n|\r|\n/);

  // 3. Управляющие символы: попадают в файл при программной записи и невидимы в редакторе.
  lines.forEach((line, idx) => {
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      const isControl = (code >= 0x00 && code <= 0x08) || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f);
      if (isControl) {
        findings.push({
          severity: 'error',
          rule: 'control-char',
          line: idx + 1,
          message: `управляющий символ U+${code.toString(16).toUpperCase().padStart(4, '0')} в позиции ${i + 1}`,
        });
        break;
      }
    }
  });

  // 4. Тире вне строковых литералов — только для модулей.
  if (isBsl) {
    lines.forEach((line, idx) => {
      const code = stripStringLiterals(line);
      for (const d of DASHES) {
        if (code.includes(d.ch)) {
          findings.push({
            severity: 'warn',
            rule: 'invalid-dash',
            line: idx + 1,
            message: `${d.name} в коде или комментарии — платформа требует ASCII-дефис`,
          });
          break;
        }
      }
    });
  }

  // 5. Смешанные переводы строк: дают шумные диффы и ломают сравнение версий.
  const crlf = (body.match(/\r\n/g) || []).length;
  const loneLf = (body.match(/(?<!\r)\n/g) || []).length;
  if (crlf > 0 && loneLf > 0) {
    findings.push({
      severity: 'warn',
      rule: 'mixed-eol',
      line: 0,
      message: `смешанные переводы строк: CRLF ${crlf}, LF ${loneLf}`,
    });
  }

  return findings;
}

/**
 * Внутренний код правила → идентификатор следа.
 *
 * Соответствие вынесено в инструмент, а не оставлено читателю. Пока его не было, инструмент
 * печатал `invalid-dash`, навык требовал `qg:HYG-DASH`, и перевод одного в другое делала
 * модель — то есть строку следа всё равно писали руками, даже прогнав проверку.
 */
const EVIDENCE_IDS = {
  'bom-missing': 'qg:HYG-BOM',
  encoding: 'qg:HYG-ENCODING',
  'control-char': 'qg:HYG-CTRL',
  'invalid-dash': 'qg:HYG-DASH',
  'mixed-eol': 'qg:HYG-EOL',
};

/**
 * Строит след: при находках — по записи на сработавшее правило, иначе одна запись со всем
 * набором. Перечислять пять идентификаторов в чистом прогоне уместно: их пять, а не полторы
 * сотни, и видно, что именно проверено.
 */
function evidenceBlock(findings, filesCount) {
  const hit = [...new Set(findings.map((f) => EVIDENCE_IDS[f.rule]).filter(Boolean))].sort();
  recordRun({
    scope: 'file-encoding',
    tool: 'tools/hygiene-check.mjs',
    verdict: hit.length ? 'violation' : 'clean',
    files: filesCount,
  });
  if (hit.length === 0) {
    const all = Object.values(EVIDENCE_IDS).sort().join(',');
    return `[qg applied: layer=hygiene, scope=file-encoding, ids=[${all}], verdict=clean]`;
  }
  return hit
    .map((id) => `[qg applied: layer=hygiene, scope=file-encoding, ids=[${id}], verdict=violation:${id}]`)
    .join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    process.stderr.write('Использование: node hygiene-check.mjs <файл> [<файл> ...] [--json]\n');
    return 2;
  }

  const report = files.map((f) => ({ file: f, findings: checkFile(f) }));
  const errors = report.reduce((n, r) => n + r.findings.filter((x) => x.severity === 'error').length, 0);
  const warns = report.reduce((n, r) => n + r.findings.filter((x) => x.severity === 'warn').length, 0);

  const evidence = evidenceBlock(report.flatMap((r) => r.findings), files.length);

  if (asJson) {
    process.stdout.write(JSON.stringify({ files: report, errors, warns, evidence }, null, 2) + '\n');
  } else {
    for (const r of report) {
      if (r.findings.length === 0) continue;
      process.stdout.write(`${r.file}\n`);
      for (const f of r.findings) {
        const where = f.line ? `:${f.line}` : '';
        process.stdout.write(`  ${f.severity === 'error' ? 'ОШИБКА' : 'ВНИМАНИЕ'}${where} [${f.rule}] ${f.message}\n`);
      }
      process.stdout.write('\n');
    }
    process.stdout.write(`Проверено файлов: ${files.length}. Ошибок: ${errors}, предупреждений: ${warns}.\n`);
    process.stdout.write('\n## quality evidence\n\n' + evidence + '\n');
  }

  return errors ? 2 : warns ? 1 : 0;
}

process.exit(main(process.argv));
