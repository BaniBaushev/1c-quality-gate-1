#!/usr/bin/env node
/**
 * Лексические проверки текстов запросов, встроенных в BSL.
 *
 * Проверок две:
 *   - `qg:QRY-ALIAS-SHADOWS-FIELD` — псевдоним источника, совпадающий с именем колонки
 *     временной таблицы того же пакета;
 *   - `qg:QRY-TOP-WITHOUT-ORDER` — `ПЕРВЫЕ N` без `УПОРЯДОЧИТЬ ПО`.
 *
 * Зачем отдельный инструмент. Текст запроса — строковый литерал. Его не разбирает ни
 * статический анализатор, ни валидаторы XML, ни сборка бинарника: тела модулей
 * компилируются, литерал остаётся литералом. Класс дефекта доживает до продуктива и падает
 * в рантайме сообщением «Неоднозначное поле».
 *
 * Почему код, а не правило для модели. Правило про совпадение псевдонима с именем поля в
 * своде было и раньше — и не сработало: оно называет не ту пару (поле таблицы-источника
 * вместо колонки временной таблицы), а проверка «посмотри внимательно» неотличима от
 * непроведённой. Пересечение двух множеств имён считается механически и потому детерминировано.
 *
 * Приближения заявлены прямо, потому что от них зависит доверие к вердикту:
 *   - разбираются только литералы внутри `.bsl`; тексты запросов в XML (СКД, компоновщики
 *     формы) не читаются;
 *   - запрос, собранный конкатенацией или через `СтрШаблон`, виден лишь частями и потому
 *     пропускается — коллизия между частями не найдётся;
 *   - колонки известны только у временных таблиц пакета. Та же коллизия с именем реквизита
 *     реальной таблицы требует метаданных и здесь не ловится;
 *   - ключевые слова только русские: английский вариант языка запросов платформа понимает,
 *     но в прикладном коде он не встречается.
 *
 * Использование:
 *   node query-lint.mjs <файл.bsl> [<файл.bsl> ...] [--json]
 */

import { readFileSync, existsSync } from 'node:fs';

/** Символы, из которых состоит идентификатор 1С. Кириллица делает `\b` в JS бесполезной. */
const W = 'A-Za-zА-Яа-яЁё0-9_';
const IDENT = `[A-Za-zА-Яа-яЁё_][${W}]*`;

/** Слово целиком, с границами по правилам 1С, а не по `\w`. */
function word(w, flags = 'gi') {
  return new RegExp(`(?<![${W}])(?:${w})(?![${W}])`, flags);
}

/**
 * Проверка вхождения слова.
 *
 * Отдельной функцией, потому что `test()` глобальной регулярки продолжает поиск с прошлого
 * места: общий на модуль объект молча возвращал бы то `true`, то `false` на одном и том же
 * тексте — дефект, который проявляется только на втором вызове.
 */
function hasWord(text, re) {
  re.lastIndex = 0;
  return re.test(text);
}

const RE_SELECT = word('ВЫБРАТЬ');
const RE_FROM = word('ИЗ');
const RE_INTO = word('ПОМЕСТИТЬ');
const RE_AS = word('КАК');
const RE_UNION = word('ОБЪЕДИНИТЬ(?:\\s+ВСЕ)?');
/** Слова, за которыми секция источников заканчивается. */
const RE_AFTER_SOURCES = word('ГДЕ|СГРУППИРОВАТЬ|ИМЕЮЩИЕ|УПОРЯДОЧИТЬ|ИТОГИ|ИНДЕКСИРОВАТЬ|АВТОУПОРЯДОЧИВАНИЕ|ДЛЯ');
/** Модификаторы между `ВЫБРАТЬ` и списком полей. */
const RE_SELECT_MODIFIERS = new RegExp(`^\\s*(?:(?:${['РАЗРЕШЕННЫЕ', 'РАЗЛИЧНЫЕ'].join('|')})\\s+)*(?:ПЕРВЫЕ\\s+\\d+\\s+)?`, 'iu');
const RE_TOP = word('ПЕРВЫЕ');
const RE_ORDER = word('УПОРЯДОЧИТЬ');
const RE_AUTOORDER = word('АВТОУПОРЯДОЧИВАНИЕ');

/**
 * Глубина вложенности скобок для каждой позиции текста.
 *
 * Нужна, чтобы отличить псевдоним источника от подделок: `ВЫРАЗИТЬ(Поле КАК Документ.Х)`
 * содержит `КАК`, но это приведение типа, и живёт оно внутри скобок. Псевдоним источника
 * всегда на нулевой глубине секции `ИЗ`. Тот же приём отсекает вложенные запросы в
 * параметрах виртуальных таблиц.
 */
function depthMap(text) {
  const depth = new Int32Array(text.length);
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      depth[i] = d;
      d++;
      continue;
    }
    if (c === ')') d = Math.max(0, d - 1);
    depth[i] = d;
  }
  return depth;
}

/** Совпадения регулярки, лежащие на нулевой глубине скобок. */
function matchesAtTopLevel(text, re, depth) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (depth[m.index] === 0) out.push({ index: m.index, text: m[0] });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/**
 * Вырезает из BSL строковые литералы, похожие на текст запроса.
 *
 * Возвращает позицию начала литерала в файле — по ней потом считается номер строки находки.
 * Комментарии BSL пропускаются: закомментированный запрос проверять не за чем.
 */
export function extractQueryLiterals(source) {
  const found = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c !== '"') {
      i++;
      continue;
    }
    const start = i + 1;
    let j = start;
    while (j < source.length) {
      if (source[j] === '"') {
        // Удвоенная кавычка — литерал внутри текста запроса, а не конец BSL-строки.
        if (source[j + 1] === '"') {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    const raw = source.slice(start, j);
    if (hasWord(raw, RE_SELECT) && (hasWord(raw, RE_FROM) || hasWord(raw, RE_INTO))) {
      found.push({ raw, start });
    }
    i = j + 1;
  }
  return found;
}

/**
 * Гасит всё, что не является кодом запроса: продолжения `|`, строковые литералы SDBL и
 * комментарии внутри текста запроса.
 *
 * Замена посимвольная — длина сохраняется, поэтому позиция находки в маске равна позиции в
 * исходном файле. Без этого пришлось бы вести карту смещений, а она разъезжается первой.
 */
export function maskLiteral(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    const chars = line.split('');
    // Вертикальная черта продолжения — часть синтаксиса BSL, для запроса её нет.
    const bar = line.search(/\S/);
    if (bar !== -1 && line[bar] === '|') chars[bar] = ' ';

    let inString = false;
    for (let k = 0; k < chars.length; k++) {
      if (!inString && chars[k] === '/' && chars[k + 1] === '/') {
        for (let m = k; m < chars.length; m++) chars[m] = ' ';
        break;
      }
      if (chars[k] === '"' && chars[k + 1] === '"') {
        chars[k] = ' ';
        chars[k + 1] = ' ';
        k++;
        inString = !inString;
        continue;
      }
      if (inString) chars[k] = ' ';
    }
    out.push(chars.join(''));
  }
  return out.join('\n');
}

/** Разбивает пакет по `;`. Разделители внутри литералов SDBL уже погашены маской. */
function splitBatch(masked) {
  const parts = [];
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ';') continue;
    parts.push({ text: masked.slice(from, i), offset: from });
    from = i + 1;
  }
  if (from < masked.length) parts.push({ text: masked.slice(from), offset: from });
  return parts.filter((p) => hasWord(p.text, RE_SELECT));
}

/** Ветви `ОБЪЕДИНИТЬ [ВСЕ]` внутри одного запроса пакета — у каждой своя секция источников. */
function splitUnionBranches(query) {
  const depth = depthMap(query.text);
  const cuts = matchesAtTopLevel(query.text, RE_UNION, depth);
  const branches = [];
  let from = 0;
  for (const cut of cuts) {
    branches.push({ text: query.text.slice(from, cut.index), offset: query.offset + from });
    from = cut.index + cut.text.length;
  }
  branches.push({ text: query.text.slice(from), offset: query.offset + from });
  return branches;
}

/** Имя временной таблицы, создаваемой веткой, и имена её колонок. */
function parseInto(branch) {
  const depth = depthMap(branch.text);
  const into = matchesAtTopLevel(branch.text, RE_INTO, depth)[0];
  if (!into) return null;

  const tail = branch.text.slice(into.index + into.text.length);
  const name = tail.match(new RegExp(`^\\s*(${IDENT})`, 'u'));
  if (!name) return null;

  const select = matchesAtTopLevel(branch.text, RE_SELECT, depth)[0];
  if (!select || select.index > into.index) return { name: name[1], columns: [] };

  const list = branch.text.slice(select.index + select.text.length, into.index).replace(RE_SELECT_MODIFIERS, '');
  return { name: name[1], columns: selectListColumns(list) };
}

/**
 * Имена колонок по списку полей выборки.
 *
 * Форм ровно две, и обе обязательны: `Перемещение.Ссылка КАК Перемещение` даёт колонку по
 * псевдониму, а `Связи.Перемещение` — по имени поля. Собрать только первую значит не увидеть
 * половину коллизий.
 */
export function selectListColumns(list) {
  const depth = depthMap(list);
  const items = [];
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === ',' && depth[i] === 0) {
      items.push(list.slice(from, i));
      from = i + 1;
    }
  }
  items.push(list.slice(from));

  const columns = [];
  for (const item of items) {
    const itemDepth = depthMap(item);
    const aliases = matchesAtTopLevel(item, RE_AS, itemDepth);
    const last = aliases[aliases.length - 1];
    if (last) {
      const named = item.slice(last.index + last.text.length).match(new RegExp(`^\\s*(${IDENT})`, 'u'));
      if (named) columns.push(named[1]);
      continue;
    }
    // Без псевдонима колонку именует последний сегмент поля: `Связи.Перемещение` → `Перемещение`.
    const bare = item.trim().match(new RegExp(`(?:^|\\.)(${IDENT})$`, 'u'));
    if (bare) columns.push(bare[1]);
  }
  return columns;
}

/** Псевдонимы источников ветки и текст её секции `ИЗ` — по нему видно, какие ВТ задействованы. */
function parseSources(branch) {
  const depth = depthMap(branch.text);
  const from = matchesAtTopLevel(branch.text, RE_FROM, depth)[0];
  if (!from) return { aliases: [], sourcesText: '', sourcesStart: 0 };

  const start = from.index + from.text.length;
  const stop = matchesAtTopLevel(branch.text, RE_AFTER_SOURCES, depth).find((m) => m.index > start);
  const end = stop ? stop.index : branch.text.length;
  const sourcesText = branch.text.slice(start, end);

  const sourcesDepth = depthMap(sourcesText);
  const aliases = [];
  for (const as of matchesAtTopLevel(sourcesText, RE_AS, sourcesDepth)) {
    const named = sourcesText.slice(as.index + as.text.length).match(new RegExp(`^\\s*(${IDENT})`, 'u'));
    if (named) aliases.push({ name: named[1], index: start + as.index });
  }
  return { aliases, sourcesText, sourcesStart: start };
}

/**
 * `ПЕРВЫЕ N` без `УПОРЯДОЧИТЬ ПО`.
 *
 * Какие именно N строк вернёт платформа, не определено: порядок задаёт СУБД, и он меняется
 * между прогонами, между версиями и между движками. Код, отобравший «первые 10 договоров»,
 * на тестовой базе работает, а в продуктиве начинает выдавать другие десять.
 *
 * Проверка на уровне запроса пакета, а не ветки: в объединении `УПОРЯДОЧИТЬ ПО` относится ко
 * всему результату и стоит в конце последней ветки.
 *
 * Законные формы, на которых правило молчит:
 *   - `ПЕРВЫЕ 1` — проверка существования: результат используется как «пусто или нет», и
 *     какая именно строка пришла, значения не имеет;
 *   - `АВТОУПОРЯДОЧИВАНИЕ` — порядок задан, пусть и неявно.
 *
 * `ПОМЕСТИТЬ` законной формой НЕ является, хотя выглядит похоже: порядок строк внутри
 * временной таблицы потребителю действительно не виден, но отбор N строк произошёл раньше
 * помещения — недетерминирован уже он. Это самый частый реальный случай: предварительный
 * отбор в `ВТ_*` перед соединением.
 */
function checkTopWithoutOrder(source, literal, query) {
  const depth = depthMap(query.text);
  if (matchesAtTopLevel(query.text, RE_ORDER, depth).length > 0) return [];
  if (matchesAtTopLevel(query.text, RE_AUTOORDER, depth).length > 0) return [];

  const findings = [];
  for (const top of matchesAtTopLevel(query.text, RE_TOP, depth)) {
    const limit = query.text.slice(top.index + top.text.length).match(/^\s*(\d+)/u);
    if (!limit) continue;
    if (Number(limit[1]) <= 1) continue;

    const pos = literal.start + query.offset + top.index;
    findings.push({
      severity: 'warn',
      rule: 'qg:QRY-TOP-WITHOUT-ORDER',
      line: lineAt(source, pos),
      limit: Number(limit[1]),
      message:
        `«ПЕРВЫЕ ${limit[1]}» без «УПОРЯДОЧИТЬ ПО»: какие именно ${limit[1]} строк вернутся, ` +
        'не определено — набор меняется между прогонами и между СУБД',
    });
  }
  return findings;
}

/** Номер строки в файле по абсолютному смещению. */
function lineAt(source, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/**
 * Ищет коллизии «псевдоним источника = колонка временной таблицы» во всех запросах файла.
 *
 * Экспортируется отдельно от чтения файла, чтобы проверку можно было прогнать на строке.
 */
export function lintSource(source) {
  const findings = [];

  for (const literal of extractQueryLiterals(source)) {
    const masked = maskLiteral(literal.raw);
    const temps = new Map(); // имя ВТ в нижнем регистре → { name, columns }

    for (const query of splitBatch(masked)) {
      findings.push(...checkTopWithoutOrder(source, literal, query));

      const branches = splitUnionBranches(query);

      for (const branch of branches) {
        const { aliases, sourcesText } = parseSources(branch);
        if (aliases.length === 0) continue;

        // Какие временные таблицы пакета участвуют в этой ветке.
        const used = [];
        for (const temp of temps.values()) {
          if (word(temp.name, 'iu').test(sourcesText)) used.push(temp);
        }
        if (used.length === 0) continue;

        for (const alias of aliases) {
          const key = alias.name.toLowerCase();
          for (const temp of used) {
            const column = temp.columns.find((c) => c.toLowerCase() === key);
            if (!column) continue;

            // Падает платформа не на самой коллизии, а на обращении к имени через точку:
            // именно там `Перемещение.Ссылка` читается и как поле источника, и как
            // разыменование колонки. Без такого обращения запрос выполнится — но имя уже
            // заминировано, и первое же добавленное поле его подорвёт.
            const deref = new RegExp(`(?<![${W}.])${alias.name}\\s*\\.`, 'iu').exec(branch.text);
            const pos = literal.start + branch.offset + (deref ? deref.index : alias.index);

            findings.push({
              severity: deref ? 'error' : 'warn',
              rule: 'qg:QRY-ALIAS-SHADOWS-FIELD',
              line: lineAt(source, pos),
              alias: alias.name,
              temp: temp.name,
              column,
              dereferenced: Boolean(deref),
              message: deref
                ? `псевдоним источника «${alias.name}» совпадает с колонкой «${column}» временной таблицы ${temp.name}; ` +
                  `обращение «${alias.name}.…» неоднозначно — платформа откажется выполнять запрос`
                : `псевдоним источника «${alias.name}» совпадает с колонкой «${column}» временной таблицы ${temp.name}; ` +
                  'обращения через точку сейчас нет, но любое добавленное поле сделает запрос неоднозначным',
            });
          }
        }
      }

      // Временная таблица объявляется головной веткой и видна дальше по пакету.
      const into = parseInto(branches[0]);
      if (into) temps.set(into.name.toLowerCase(), into);
    }
  }

  return findings;
}

function checkFile(path) {
  if (!existsSync(path)) {
    return [{ severity: 'error', rule: 'file-missing', line: 0, message: 'файл не найден' }];
  }
  return lintSource(readFileSync(path, 'utf8').replace(/^﻿/, ''));
}

/**
 * По записи следа на каждое правило.
 *
 * Одной строкой на весь инструмент обойтись нельзя: `scope` в следе — это «что именно
 * проверялось», и вердикт по одному правилу ничего не говорит о другом. Общая строка про
 * затенение псевдонима, выставленная по находке о `ПЕРВЫЕ N`, — ровно тот отчёт о
 * непроведённой проверке, против которого написан весь формат следа.
 */
const EVIDENCE_SCOPES = [
  { scope: 'query-alias-shadowing', id: 'qg:QRY-ALIAS-SHADOWS-FIELD' },
  { scope: 'query-top-order', id: 'qg:QRY-TOP-WITHOUT-ORDER' },
];

function evidenceBlock(findings, queriesSeen) {
  return EVIDENCE_SCOPES.map(({ scope, id }) => {
    if (!queriesSeen) return `[qg skipped: layer=code, scope=${scope}, reason=not_applicable]`;
    const hit = findings.some((f) => f.rule === id);
    return `[qg applied: layer=code, scope=${scope}, ids=[${id}], verdict=${hit ? `violation:${id}` : 'clean'}]`;
  }).join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    process.stderr.write('Использование: node query-lint.mjs <файл.bsl> [<файл.bsl> ...] [--json]\n');
    return 2;
  }

  const report = files.map((f) => ({ file: f, findings: checkFile(f) }));
  const errors = report.reduce((n, r) => n + r.findings.filter((x) => x.severity === 'error').length, 0);
  const warns = report.reduce((n, r) => n + r.findings.filter((x) => x.severity === 'warn').length, 0);
  const queriesSeen = files.some((f) => existsSync(f) && extractQueryLiterals(readFileSync(f, 'utf8')).length > 0);
  const evidence = evidenceBlock(report.flatMap((r) => r.findings), queriesSeen);

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
  process.stdout.write(`Проверено файлов: ${files.length}. Ошибок: ${errors}, предупреждений: ${warns}.\n`);
  process.stdout.write('\n## quality evidence\n\n' + evidence + '\n');

  // Проверка лексическая и заведомо неполная: тексты запросов из XML и собранные
  // конкатенацией она не видит. Молчание инструмента не означает, что запрос исполним.
  if (!errors && !warns && queriesSeen) {
    process.stdout.write(
      '\nПроверены только литералы в .bsl. Выполнимость запроса не проверяется — это делает платформа.\n'
    );
  }

  return errors ? 2 : warns ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('query-lint.mjs')) {
  process.exit(main(process.argv));
}
