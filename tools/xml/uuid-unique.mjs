#!/usr/bin/env node
/**
 * Уникальность UUID объектов метаданных в пределах одной выгрузки.
 *
 * Зачем: объект, скопированный вместе со своим `uuid` (или заведённый с UUID-заглушкой вида
 * `a1b2c3d4-…`), даёт два разных объекта с одним идентификатором. Платформа при загрузке
 * либо отвергает выгрузку, либо оставляет один из них — и второй исчезает бесшумно.
 * Валидаторы структуры этого не видят: каждый разбирает СВОЙ файл и проверяет формат GUID,
 * а совпадение с чужим файлом за пределами их области зрения.
 *
 * Область — одно дерево. Совпадение UUID заимствованного объекта расширения с UUID объекта
 * основной конфигурации сюда не попадает: это разные выгрузки, и там совпадение — механизм
 * заимствования, а не дефект.
 *
 * Читаются только файлы с корневым элементом `MetaDataObject`. Это не приближение, а
 * измерение: на полной выгрузке УТ (19 693 файла метаданных, 63 897 идентификаторов) дублей
 * между ними ноль, а все найденные повторы пришлись на `Ext/Flowchart.xml` — точки карты
 * маршрута бизнес-процесса (`GraphicalSchema`), которые платформа копирует между процессами
 * и глобально уникальными не считает. Скан графических схем дал бы находку на каждой типовой
 * конфигурации.
 *
 * Повтор внутри одного файла проверяется наравне с межфайловым: продублированный блок
 * реквизита уносит с собой и `uuid` родителя.
 *
 * Использование:
 *   node uuid-unique.mjs <каталог выгрузки> [--json]
 *
 * Коды возврата: 0 — дублей нет, 2 — есть дубли либо инструмент не смог отработать.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { recordRun } from '../run-journal.mjs';

/** Корневой элемент файла метаданных 1С — единственный, чьи UUID обязаны быть уникальны. */
const METADATA_ROOT = 'MetaDataObject';

/** Первый настоящий тег документа: пролог, комментарии и BOM пропускаются. */
function rootElement(text) {
  const m = text.match(/<([A-Za-z_][\w.-]*)(?:[\s>/])/);
  if (!m) return '';
  if (m[1] === '?xml') {
    const rest = text.slice(m.index + m[0].length);
    return rootElement(rest);
  }
  const name = m[1];
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function walkXml(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkXml(path, acc);
    else if (entry.toLowerCase().endsWith('.xml')) acc.push(path);
  }
  return acc;
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const root = args.find((a) => !a.startsWith('--'));

  if (!root) {
    process.stderr.write('Использование: node uuid-unique.mjs <каталог выгрузки> [--json]\n');
    return 2;
  }
  if (!existsSync(root)) {
    process.stderr.write(`Каталог не найден: ${root}\n`);
    return 2;
  }

  const files = walkXml(root);
  if (files.length === 0) {
    process.stderr.write(`В каталоге нет XML-файлов: ${root}\n`);
    return 2;
  }

  /** uuid → [{ file, times }] */
  const places = new Map();
  let scanned = 0;
  const skippedRoots = new Map();

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('uuid="')) continue;

    const rootEl = rootElement(text);
    if (rootEl !== METADATA_ROOT) {
      skippedRoots.set(rootEl || '?', (skippedRoots.get(rootEl || '?') || 0) + 1);
      continue;
    }
    scanned++;

    const counts = new Map();
    const re = /uuid="([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const uuid = m[1].toLowerCase();
      counts.set(uuid, (counts.get(uuid) || 0) + 1);
    }
    for (const [uuid, times] of counts) {
      if (!places.has(uuid)) places.set(uuid, []);
      places.get(uuid).push({ file: relative(root, file).split('\\').join('/'), times });
    }
  }

  const duplicates = [...places]
    .filter(([, where]) => where.length > 1 || where[0].times > 1)
    .map(([uuid, where]) => ({ uuid, where }));

  // Готовая строка следа и отметка о прогоне. Раньше инструмент возвращал только вердикт
  // человеку, а запись в отчёт составляла модель — то есть проверка, оставляющая машинный
  // след, заканчивалась строкой, написанной от руки.
  const verdict = duplicates.length ? 'violation:qg:XML-UUID-DUP' : 'clean';
  const evidence = `[qg applied: layer=xml, scope=uuid-uniqueness, ids=[qg:XML-UUID-DUP], verdict=${verdict}]`;
  recordRun({
    scope: 'uuid-uniqueness',
    tool: 'tools/xml/uuid-unique.mjs',
    verdict: duplicates.length ? 'violation' : 'clean',
    files: scanned,
  });

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          root,
          scanned,
          uuids: places.size,
          duplicates,
          skipped: [...skippedRoots].map(([element, files]) => ({ element, files })),
          evidence,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write(`Проверено файлов метаданных: ${scanned}, идентификаторов: ${places.size}\n`);
    if (skippedRoots.size) {
      const list = [...skippedRoots].map(([el, n]) => `${el} — ${n}`).join(', ');
      process.stdout.write(`Не проверялись (корень не ${METADATA_ROOT}): ${list}\n`);
    }
    process.stdout.write('\n');

    if (duplicates.length) {
      process.stdout.write(`ДУБЛИ UUID (${duplicates.length}) — два объекта с одним идентификатором.\n`);
      process.stdout.write('Загрузка отвергнет выгрузку либо оставит один объект из двух:\n');
      for (const d of duplicates) {
        const where = d.where.map((w) => (w.times > 1 ? `${w.file} ×${w.times}` : w.file)).join(' | ');
        process.stdout.write(`  ${d.uuid}  ←  ${where}\n`);
      }
      process.stdout.write('\nНовый UUID генерируется отдельно на каждый объект и реквизит; копия чужого недопустима.\n');
    } else {
      process.stdout.write('Дублей UUID не найдено.\n');
    }
    process.stdout.write('\n## quality evidence\n\n' + evidence + '\n');
  }

  return duplicates.length ? 2 : 0;
}

process.exit(main(process.argv));
