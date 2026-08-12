#!/usr/bin/env node
/**
 * Сверка «файлы на диске ↔ состав конфигурации» в ОБЕ стороны.
 *
 * Зачем: объект метаданных, лежащий на диске, но не внесённый в ChildObjects файла
 * Configuration.xml, НЕ попадает в собранный артефакт. При этом загрузка конфигурации из
 * файлов такие файлы молча игнорирует и не разрешает ссылки на них вглубь BSL — сборка
 * проходит «успешно», лог пуст, а объект отсутствует и падение случается в рантайме.
 * Валидаторы структуры это тоже не ловят: они проверяют порядок УЖЕ зарегистрированных
 * объектов и про файл вне состава ничего не знают.
 *
 * Обратное направление не менее важно: имя в составе без файла на диске ломает саму сборку.
 *
 * Реализация на Node, а не на Python, намеренно: это единственная проверка контура, которая
 * ничем не заменяется, и она обязана работать всюду, где работает сам плагин.
 *
 * Использование:
 *   node orphan-check.mjs <путь к каталогу выгрузки> [--json]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { recordRun } from '../run-journal.mjs';

/**
 * Каталог на диске → тег в составе конфигурации.
 *
 * Правило «отбросить окончание множественного числа» работает не всегда, поэтому карта
 * задана явно и выверена по реальным выгрузкам. Неизвестный каталог не додумывается:
 * он попадает в отчёт как непроверенный — молчаливый пропуск здесь означал бы ровно ту
 * дыру, ради которой написан весь скрипт.
 */
const DIR_TO_TAG = {
  Catalogs: 'Catalog',
  Documents: 'Document',
  DocumentJournals: 'DocumentJournal',
  Enums: 'Enum',
  Reports: 'Report',
  DataProcessors: 'DataProcessor',
  InformationRegisters: 'InformationRegister',
  AccumulationRegisters: 'AccumulationRegister',
  AccountingRegisters: 'AccountingRegister',
  CalculationRegisters: 'CalculationRegister',
  ChartsOfCharacteristicTypes: 'ChartOfCharacteristicTypes',
  ChartsOfAccounts: 'ChartOfAccounts',
  ChartsOfCalculationTypes: 'ChartOfCalculationTypes',
  BusinessProcesses: 'BusinessProcess',
  Tasks: 'Task',
  ExchangePlans: 'ExchangePlan',
  FilterCriteria: 'FilterCriterion',
  SettingsStorages: 'SettingsStorage',
  CommonModules: 'CommonModule',
  CommonForms: 'CommonForm',
  CommonCommands: 'CommonCommand',
  CommonPictures: 'CommonPicture',
  CommonTemplates: 'CommonTemplate',
  CommonAttributes: 'CommonAttribute',
  DefinedTypes: 'DefinedType',
  FunctionalOptions: 'FunctionalOption',
  FunctionalOptionsParameters: 'FunctionalOptionsParameter',
  Constants: 'Constant',
  Roles: 'Role',
  Subsystems: 'Subsystem',
  ScheduledJobs: 'ScheduledJob',
  EventSubscriptions: 'EventSubscription',
  HTTPServices: 'HTTPService',
  WebServices: 'WebService',
  WSReferences: 'WSReference',
  Languages: 'Language',
  Sequences: 'Sequence',
  Enums_: 'Enum',
  StyleItems: 'StyleItem',
  Styles: 'Style',
  SessionParameters: 'SessionParameter',
  XDTOPackages: 'XDTOPackage',
  ExternalDataSources: 'ExternalDataSource',
};

/** Извлекает пары «тег → имя» из секции ChildObjects. */
function readRegistered(configXml) {
  const text = readFileSync(configXml, 'utf8');
  const start = text.indexOf('<ChildObjects>');
  const end = text.lastIndexOf('</ChildObjects>');
  if (start === -1 || end === -1) return null;

  const section = text.slice(start, end);
  const registered = new Set();
  const re = /<([A-Za-z][A-Za-z0-9]*)>([^<>]+)<\/\1>/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    registered.add(`${m[1]}.${m[2].trim()}`);
  }
  return registered;
}

/** Сканирует каталоги объектов: <Каталог>/<Имя>/<Имя>.xml либо <Каталог>/<Имя>.xml. */
function readOnDisk(root) {
  const found = [];
  const unknownDirs = [];

  for (const entry of readdirSync(root)) {
    const dirPath = join(root, entry);
    let st;
    try {
      st = statSync(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const tag = DIR_TO_TAG[entry];
    if (!tag) {
      unknownDirs.push(entry);
      continue;
    }

    for (const item of readdirSync(dirPath)) {
      const itemPath = join(dirPath, item);
      let ist;
      try {
        ist = statSync(itemPath);
      } catch {
        continue;
      }
      if (ist.isDirectory()) {
        if (existsSync(join(itemPath, `${item}.xml`))) {
          found.push({ tag, name: item, path: `${entry}/${item}/${item}.xml` });
        }
      } else if (item.endsWith('.xml')) {
        const name = item.slice(0, -4);
        found.push({ tag, name, path: `${entry}/${item}` });
      }
    }
  }
  return { found, unknownDirs };
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const root = args.find((a) => !a.startsWith('--'));

  if (!root) {
    process.stderr.write('Использование: node orphan-check.mjs <каталог выгрузки> [--json]\n');
    return 2;
  }

  const configXml = join(root, 'Configuration.xml');
  if (!existsSync(configXml)) {
    process.stderr.write(`Не найден Configuration.xml в ${root}\n`);
    return 2;
  }

  const registered = readRegistered(configXml);
  if (!registered) {
    process.stderr.write('В Configuration.xml не найдена секция ChildObjects\n');
    return 2;
  }

  const { found, unknownDirs } = readOnDisk(root);

  // На диске есть, в составе нет — объект не попадёт в сборку.
  const orphans = found.filter((f) => !registered.has(`${f.tag}.${f.name}`));

  // В составе есть, на диске нет — сборка упадёт.
  const onDiskKeys = new Set(found.map((f) => `${f.tag}.${f.name}`));
  const missing = [...registered].filter((key) => {
    const tag = key.slice(0, key.indexOf('.'));
    return Object.values(DIR_TO_TAG).includes(tag) && !onDiskKeys.has(key);
  });

  // Готовая строка следа и отметка о прогоне: вердикт, составленный по выводу инструмента
  // от руки, неотличим от вердикта, составленного без прогона.
  const hit = orphans.length || missing.length;
  const evidence =
    `[qg applied: layer=xml, scope=registration-check, ids=[qg:XML-ORPHAN], ` +
    `verdict=${hit ? 'violation:qg:XML-ORPHAN' : 'clean'}]`;
  recordRun({
    scope: 'registration-check',
    tool: 'tools/xml/orphan-check.mjs',
    verdict: hit ? 'violation' : 'clean',
    files: found.length,
  });

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ root, orphans, missing, unknownDirs, checked: found.length, evidence }, null, 2) + '\n'
    );
  } else {
    process.stdout.write(`Проверено объектов на диске: ${found.length}\n`);
    process.stdout.write(`Зарегистрировано в составе: ${registered.size}\n\n`);

    if (orphans.length) {
      process.stdout.write(`ФАЙЛЫ-СИРОТЫ (${orphans.length}) — на диске есть, в составе нет.\n`);
      process.stdout.write('Не попадут в сборку; загрузка конфигурации это не диагностирует:\n');
      for (const o of orphans) process.stdout.write(`  ${o.tag}.${o.name}  ←  ${o.path}\n`);
      process.stdout.write('\n');
    }
    if (missing.length) {
      process.stdout.write(`ОТСУТСТВУЮТ ФАЙЛЫ (${missing.length}) — в составе есть, на диске нет.\n`);
      process.stdout.write('Сборка завершится ошибкой:\n');
      for (const key of missing) process.stdout.write(`  ${key}\n`);
      process.stdout.write('\n');
    }
    if (unknownDirs.length) {
      process.stdout.write(
        `НЕ ПРОВЕРЕНО: каталоги вне карты типов — ${unknownDirs.join(', ')}\n` +
          'Добавь их в DIR_TO_TAG, иначе объекты в них остаются вне сверки.\n\n'
      );
    }
    if (!orphans.length && !missing.length) {
      process.stdout.write('Расхождений диск↔состав не найдено.\n');
    }
    process.stdout.write('\n## quality evidence\n\n' + evidence + '\n');
  }

  return orphans.length || missing.length ? 2 : 0;
}

process.exit(main(process.argv));
