#!/usr/bin/env node
/**
 * Лексические проверки кода BSL — то, что видно по тексту модуля и его пути.
 *
 * Проверки две:
 *   - `qg:BSL-TXN-IN-HANDLER` — собственная транзакция внутри обработчика события объекта,
 *     который платформа и так выполняет в транзакции;
 *   - `qg:BSL-ENUM-STRING-ASSIGN` — присваивание примитива ("", 0, Ложь, Истина) полю,
 *     которое по XML объекта метаданных имеет строго ссылочный тип (EnumRef, CatalogRef…).
 *     Сборка на такое молчит — тела модулей не компилируются, — а падение приходит при
 *     записи, часто в редко исполняемой ветке. Пустое значение ссылки — `ПустаяСсылка()`.
 *
 * Зачем отдельный инструмент, а не правило в своде. Правило «не открывай транзакцию в
 * обработчике» формулируется одной строкой и ровно поэтому его легко не применить: проверка
 * «посмотри внимательно» неотличима от непроведённой. Условие срабатывания здесь текстовое —
 * имя обработчика из закрытого списка, модуль объекта или набора записей, вызов
 * `НачатьТранзакцию` в теле, — и потому считается механически.
 *
 * Почему не в `query-lint.mjs`: у того контракт — строковые литералы текстов запросов, это
 * записано в его шапке. Проверки уровня модуля живут здесь.
 *
 * Приближения заявлены прямо:
 *   - логика, вынесенная из обработчика в общий модуль, инструменту не видна: он читает один
 *     файл и графа вызовов не строит;
 *   - модуль определяется по имени файла (`ObjectModule.bsl`, `RecordSetModule.bsl`);
 *     переименованный или собранный на лету модуль в проверку не попадёт;
 *   - для присваиваний приёмник НЕ разрешается: `Запись.Статус = ""` даёт находку и тогда,
 *     когда «Запись» — структура со строковым полем того же имени. Поэтому находка —
 *     предупреждение, а не ошибка, и это сказано в её тексте;
 *   - XML объекта ищется вверх от модуля (`<Вид>/<Имя>/Ext/*.bsl` → `<Вид>/<Имя>.xml`);
 *     модуль вне выгрузки метаданных проверяется только на транзакции;
 *   - имена обработчиков только русские: английские идентификаторы платформа понимает, но в
 *     прикладном коде они не встречаются.
 *
 * Использование:
 *   node bsl-lint.mjs <файл.bsl> [<файл.bsl> ...] [--json]
 *
 * Коды возврата: 0 — чисто, 1 — есть предупреждения, 2 — есть ошибки либо ошибка вызова.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { recordRun } from './run-journal.mjs';
import { versionSuffix } from './config.mjs';

/** Символы идентификатора 1С: кириллица делает `\b` в JS бесполезной. */
const W = 'A-Za-zА-Яа-яЁё0-9_';
const IDENT = `[A-Za-zА-Яа-яЁё_][${W}]*`;

function word(w, flags = 'gi') {
  return new RegExp(`(?<![${W}])(?:${w})(?![${W}])`, flags);
}

/**
 * Модули, где платформа открывает транзакцию сама.
 *
 * Модуль менеджера сюда не входит: его методы вызываются вне неявной транзакции, и
 * `НачатьТранзакцию` в них — штатная форма. Модуль формы тем более: обработчик `ПередЗаписью`
 * формы — другое событие, к транзакции записи объекта отношения не имеющее. Без этого
 * различения проверка давала бы находку на каждой форме с таким обработчиком.
 */
const IMPLICIT_TRANSACTION_MODULES = new Set(['ObjectModule.bsl', 'RecordSetModule.bsl']);

/**
 * Обработчики, тело которых исполняется внутри транзакции, открытой платформой.
 *
 * `ПередЗаписью`, `ПриЗаписи`, `ПередУдалением` — вокруг записи и удаления ссылочного объекта;
 * `ОбработкаПроведения` и `ОбработкаУдаленияПроведения` — вокруг проведения и отмены.
 */
const TRANSACTIONAL_HANDLERS = new Set([
  'передзаписью',
  'призаписи',
  'передудалением',
  'обработкапроведения',
  'обработкаудаленияпроведения',
]);

/**
 * Гасит комментарии и строковые литералы, сохраняя длину текста.
 *
 * Длина важна: позиция находки в маске равна позиции в исходном файле, иначе пришлось бы
 * вести карту смещений — а она разъезжается первой.
 */
export function maskModule(source) {
  const chars = source.split('');
  let i = 0;
  let inString = false;
  while (i < chars.length) {
    if (!inString && chars[i] === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }
    if (chars[i] === '"') {
      // Удвоенная кавычка внутри литерала — экранирование, а не его конец.
      if (inString && chars[i + 1] === '"') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        continue;
      }
      chars[i] = ' ';
      inString = !inString;
      i++;
      continue;
    }
    if (inString && chars[i] !== '\n') chars[i] = ' ';
    i++;
  }
  return chars.join('');
}

/** Тела процедур и функций модуля: имя, границы, смещение начала тела. */
export function parseRoutines(masked) {
  const routines = [];
  const header = new RegExp(`(?<![${W}])(Процедура|Функция)\\s+(${IDENT})\\s*\\(`, 'giu');
  const ends = { Процедура: word('КонецПроцедуры'), Функция: word('КонецФункции') };

  let m;
  while ((m = header.exec(masked)) !== null) {
    const kind = m[1];
    const name = m[2];
    const endRe = ends[kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase()] || ends['Процедура'];
    endRe.lastIndex = m.index;
    const end = endRe.exec(masked);
    routines.push({
      name,
      start: m.index,
      bodyStart: m.index + m[0].length,
      end: end ? end.index : masked.length,
    });
  }
  return routines;
}

function lineAt(source, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/**
 * Своя транзакция внутри неявной.
 *
 * Платформа открывает транзакцию вокруг записи, удаления и проведения объекта. Вложенных
 * транзакций она не поддерживает: `НачатьТранзакцию` внутри обработчика создаёт видимость
 * точки сохранения, а `ОтменитьТранзакцию` в нём отменяет ВНЕШНЮЮ транзакцию целиком.
 * Дальше внешний код продолжает работу с уже отменённой транзакцией и получает
 * «В этой транзакции уже происходили ошибки» — в месте, не связанном с причиной.
 *
 * Якорь: #std783 п. 1.4 и 1.4.1.
 */
export function lintSource(source, fileName) {
  if (!IMPLICIT_TRANSACTION_MODULES.has(fileName)) return [];

  const masked = maskModule(source);
  const findings = [];
  const beginRe = word('НачатьТранзакцию');

  for (const routine of parseRoutines(masked)) {
    if (!TRANSACTIONAL_HANDLERS.has(routine.name.toLowerCase())) continue;

    const body = masked.slice(routine.bodyStart, routine.end);
    beginRe.lastIndex = 0;
    let hit;
    while ((hit = beginRe.exec(body)) !== null) {
      const pos = routine.bodyStart + hit.index;
      findings.push({
        severity: 'warn',
        rule: 'qg:BSL-TXN-IN-HANDLER',
        line: lineAt(source, pos),
        handler: routine.name,
        message:
          `«НачатьТранзакцию» внутри обработчика «${routine.name}»: платформа уже открыла транзакцию, ` +
          'вложенные не поддерживаются — «ОтменитьТранзакцию» здесь отменит внешнюю целиком (#std783 п.1.4)',
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Присваивание примитива ссылочному полю

/**
 * Ссылочные типы конфигурации и менеджеры, дающие `ПустаяСсылка()` для каждого.
 */
const REF_MANAGERS = {
  EnumRef: 'Перечисления',
  CatalogRef: 'Справочники',
  DocumentRef: 'Документы',
  ChartOfCharacteristicTypesRef: 'ПланыВидовХарактеристик',
  ChartOfAccountsRef: 'ПланыСчетов',
  ChartOfCalculationTypesRef: 'ПланыВидовРасчета',
  BusinessProcessRef: 'БизнесПроцессы',
  TaskRef: 'Задачи',
  ExchangePlanRef: 'ПланыОбмена',
};
const REF_TYPE_RE = new RegExp(`cfg:(${Object.keys(REF_MANAGERS).join('|')})\\.([\\w\\u0400-\\u04FF]+)`, 'u');

/**
 * XML объекта метаданных для модуля: ближайший предок каталога, рядом с которым лежит
 * одноимённый .xml. Для `Documents/Заказ/Ext/ObjectModule.bsl` это `Documents/Заказ.xml`.
 */
export function findObjectXml(bslPath) {
  let dir = dirname(bslPath);
  for (let depth = 0; depth < 6 && dir && dir !== dirname(dir); depth++) {
    const candidate = `${dir}.xml`;
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/**
 * Поля СТРОГО ссылочного типа из XML объекта: имя → тип.
 *
 * Составные типы пропускаются намеренно: у поля «Строка или Ссылка» присваивание "" законно,
 * а ложная находка дороже пропущенной.
 */
export function refTypedFields(xml) {
  const out = new Map();
  const blockRe = /<(Attribute|Resource|Dimension|AddressingAttribute)[\s>][\s\S]*?<\/\1>/g;
  let b;
  while ((b = blockRe.exec(xml)) !== null) {
    const name = b[0].match(/<Name>([\wЀ-ӿ]+)<\/Name>/u);
    const typeBlock = b[0].match(/<Type>([\s\S]*?)<\/Type>/);
    if (!name || !typeBlock) continue;
    const types = [...typeBlock[1].matchAll(/<v8:Type>([^<]+)<\/v8:Type>/g)].map((m) => m[1].trim());
    if (types.length !== 1) continue;
    if (!REF_TYPE_RE.test(types[0])) continue;
    out.set(name[1], types[0]);
  }
  return out;
}

/**
 * Присваивания вида `<Приёмник>.<Поле> = ""` (и 0, Ложь, Истина) для ссылочных полей.
 *
 * Присваивание отличается от сравнения по позиции: оператор начинает строку. Сравнение
 * `Если Запись.Статус = "" Тогда` стоит после «Если» и находкой не является — оно всегда
 * ложно, но не роняет запись, и это другой класс.
 */
export function lintRefAssignments(source, fields) {
  if (!fields || fields.size === 0) return [];
  const masked = maskModule(source);
  const findings = [];

  for (const [name, type] of fields) {
    const re = new RegExp(`(?<![${W}.])(${IDENT})\\s*\\.\\s*${name}\\s*=(?!=)`, 'giu');
    let m;
    while ((m = re.exec(masked)) !== null) {
      const lineStart = masked.lastIndexOf('\n', m.index) + 1;
      if (masked.slice(lineStart, m.index).trim() !== '') continue;

      // Правая часть читается из ИСХОДНИКА: маска гасит содержимое литералов вместе с
      // кавычками, и `""` в ней уже не виден.
      const rhs = source.slice(m.index + m[0].length, m.index + m[0].length + 40).match(/^[ \t]*(""|0|Ложь|Истина)[ \t]*;/iu);
      if (!rhs) continue;

      const refMatch = type.match(REF_TYPE_RE);
      const empty = refMatch ? `${REF_MANAGERS[refMatch[1]]}.${refMatch[2]}.ПустаяСсылка()` : 'ПустаяСсылка()';
      findings.push({
        severity: 'warn',
        rule: 'qg:BSL-ENUM-STRING-ASSIGN',
        line: lineAt(source, m.index),
        field: name,
        type,
        message:
          `«${m[1]}.${name} = ${rhs[1]}»: поле «${name}» по XML объекта имеет строго ссылочный тип ` +
          `${type} — примитив вместо ссылки молчит на сборке и падает при записи. Пустое значение: ` +
          `${empty}. Приёмник не разрешается: если «${m[1]}» — не объект с этим реквизитом, находка ложная`,
      });
    }
  }
  return findings;
}

function checkFile(path) {
  if (!existsSync(path)) {
    return { findings: [{ severity: 'error', rule: 'file-missing', line: 0, message: 'файл не найден' }], metaResolved: false };
  }
  const source = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const findings = lintSource(source, basename(path));
  const objectXml = findObjectXml(path);
  let metaResolved = false;
  if (objectXml) {
    metaResolved = true;
    const fields = refTypedFields(readFileSync(objectXml, 'utf8').replace(/^﻿/, ''));
    findings.push(...lintRefAssignments(source, fields));
  }
  return { findings, metaResolved };
}

function evidenceBlock(findings, modulesSeen, metaResolved, files = []) {
  const lines = [];

  const hitTxn = modulesSeen && findings.some((f) => f.rule === 'qg:BSL-TXN-IN-HANDLER');
  // Отмечается любой исход. Проверка применима лишь к модулям объекта и набора записей, но
  // «инструмент посмотрел файлы и не нашёл среди них таких» — это работа, а не её отсутствие;
  // без отметки такой `not_applicable` неотличим от строки, написанной вместо запуска.
  recordRun({
    scope: 'transaction-nesting',
    tool: 'tools/bsl-lint.mjs',
    verdict: !modulesSeen ? 'not_applicable' : hitTxn ? 'violation' : 'clean',
    files,
  });
  lines.push(
    !modulesSeen
      ? '[qg skipped: layer=code, scope=transaction-nesting, reason=not_applicable]'
      : '[qg applied: layer=code, scope=transaction-nesting, ids=[qg:BSL-TXN-IN-HANDLER], ' +
        `verdict=${hitTxn ? 'violation:qg:BSL-TXN-IN-HANDLER' : 'clean'}]`
  );

  // Своя запись на каждое правило: вердикт по транзакциям ничего не говорит о ссылочных
  // присваиваниях. Модуль вне выгрузки метаданных (XML объекта не найден) даёт пропуск с
  // причиной: «не смог проверить» и «проверил, чисто» — разные утверждения.
  const hitRef = metaResolved && findings.some((f) => f.rule === 'qg:BSL-ENUM-STRING-ASSIGN');
  recordRun({
    scope: 'enum-string-assign',
    tool: 'tools/bsl-lint.mjs',
    verdict: !metaResolved ? 'no_metadata_resolved' : hitRef ? 'violation' : 'clean',
    files,
  });
  lines.push(
    !metaResolved
      ? '[qg skipped: layer=code, scope=enum-string-assign, reason=no_metadata_resolved]'
      : '[qg applied: layer=code, scope=enum-string-assign, ids=[qg:BSL-ENUM-STRING-ASSIGN], ' +
        `verdict=${hitRef ? 'violation:qg:BSL-ENUM-STRING-ASSIGN' : 'clean'}]`
  );

  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    process.stderr.write('Использование: node bsl-lint.mjs <файл.bsl> [<файл.bsl> ...] [--json]\n');
    return 2;
  }

  const report = files.map((f) => ({ file: f, ...checkFile(f) }));
  const findings = report.flatMap((r) => r.findings);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;

  // Проверка применима не ко всякому файлу: модуль формы, общий модуль и модуль менеджера
  // неявной транзакции не имеют. Если таких файлов не было вовсе — это `not_applicable`,
  // а не «чисто»: молчание об области применения читается как проведённая проверка.
  const modulesSeen = files.some((f) => IMPLICIT_TRANSACTION_MODULES.has(basename(f)));
  const metaResolved = report.some((r) => r.metaResolved);
  const evidence = evidenceBlock(findings, modulesSeen, metaResolved, files);

  if (asJson) {
    process.stdout.write(JSON.stringify({ files: report, errors, warns, evidence }, null, 2) + '\n');
    return errors ? 2 : warns ? 1 : 0;
  }

  for (const r of report) {
    if (r.findings.length === 0) continue;
    process.stdout.write(`${r.file}\n`);
    for (const f of r.findings) {
      const where = f.line ? `:${f.line}` : '';
      process.stdout.write(`  ${f.severity === 'error' ? 'ОШИБКА' : 'ВНИМАНИЕ'}${where} [${f.rule}] ${f.message}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(
    `Проверено файлов: ${files.length}, из них модулей с неявной транзакцией: ` +
      `${files.filter((f) => IMPLICIT_TRANSACTION_MODULES.has(basename(f))).length}. ` +
      `Ошибок: ${errors}, предупреждений: ${warns}.${versionSuffix()}\n`
  );
  process.stdout.write('\n## quality evidence\n\n' + evidence + '\n');

  return errors ? 2 : warns ? 1 : 0;
}

process.exit(main(process.argv));
