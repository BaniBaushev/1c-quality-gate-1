#!/usr/bin/env node
/**
 * Голый вызов метода, объявление которого исчезло из модуля в этой правке.
 *
 * Зачем именно так. Класс дефектов «код зовёт то, чего нет» статический анализатор
 * пропускает: `bsl-analyzer` 0.2.73 связывает голый локальный вызов с объявлением (иначе не
 * работал бы `MismatchedArgCount`), но об ОТКАЗЕ связывания молчит. Своя диагностика на этот
 * случай у движка с 0.2.67 есть — `UnresolvedName`, — и он сам держит её выключенной; замер
 * показывает почему: на 416 модулях боевых расширений она даёт 400 находок уровня major, а
 * первыми же идут реквизиты формы `Объект` и `Список`. Прямая проверка «имя не
 * разрешается» требует словаря глобального контекста платформы — замер на живом коде дал
 * 281 различное имя в одном проекте, и каждое пропущенное имя словаря стало бы взрывом
 * ложных находок уровня «блокирует». Вдобавок модуль расширения сливается с расширяемым:
 * 1 837 голых вызовов разрешаются только через него, а в репозитории без основной
 * конфигурации не разрешаются вовсе.
 *
 * Инверсия снимает обе проблемы. Сравниваем объявления файла с его же версией в HEAD: имя,
 * которое ЭТОТ модуль объявлял до правки, платформенным глобальным быть не могло. Остаётся
 * убедиться, что вызовы исчезнувшего имени ушли вместе с объявлением.
 *
 * Чего проверка не ловит: вызов имени, которого не было никогда (опечатка в новом коде), и
 * протухший вызов из коммита трёхдневной давности — сравнение идёт с HEAD, а не по истории.
 * Это цена отказа от словаря, и она названа здесь, а не спрятана в вердикте.
 *
 * Использование:
 *   node rename-check.mjs <файл.bsl> [<файл.bsl> ...] [--json]
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { maskModule, parseRoutines } from './bsl-lint.mjs';
import { recordRun } from './run-journal.mjs';
import { resolveProjectRoot } from './project-root.mjs';
import { versionSuffix } from './config.mjs';

const W = 'A-Za-zА-Яа-яЁё0-9_';

/** BSL регистронезависим; «ё» и «е» — разные буквы, подменять их нельзя. */
const norm = (name) => String(name).toLowerCase();

function projectRoot() {
  return resolveProjectRoot(process.cwd(), process.env).root;
}

/** Текст файла в HEAD либо null: нет git, нет истории, файл новый — всё это «сравнивать не с чем». */
export function headVersion(file, root = projectRoot()) {
  const rel = relative(resolve(root), resolve(file)).split(sep).join('/');
  if (!rel || rel.startsWith('..')) return null;
  const r = spawnSync('git', ['show', `HEAD:${rel}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').replace(/^﻿/, '');
}

/** Имена процедур и функций модуля. */
export function declaredNames(source) {
  return new Set(parseRoutines(maskModule(source)).map((r) => norm(r.name)));
}

/**
 * Позиции голых вызовов имени: идентификатор перед скобкой, без точки слева и без `Новый`.
 *
 * Вызов через точку сюда не попадает намеренно — это зона `UnresolvedMethodCall` движка, и
 * она работает. Текст на вход подаётся уже с погашенными комментариями и литералами: иначе
 * кандидатом становится слово из русского текста сообщения, стоящее перед скобкой.
 */
export function bareCalls(masked, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![${W}.])(${escaped})\\s*\\(`, 'giu');
  const hits = [];
  let m;
  while ((m = re.exec(masked)) !== null) {
    const before = masked.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:^|[^A-Za-zА-Яа-яЁё_0-9])[Нн]овый\s+$/u.test(before)) continue;
    hits.push(m.index);
  }
  return hits;
}

const CONFIG_MARKER = 'Configuration.xml';
const EXTENSION_MARKER = '<ConfigurationExtensionPurpose';
const SKIP_DIRS = new Set(['.git', '.claude', 'node_modules', 'build', 'out', 'dist', '.qg-analyzer']);

function isExtensionRoot(dir) {
  try {
    return readFileSync(join(dir, CONFIG_MARKER), 'utf8').slice(0, 8192).includes(EXTENSION_MARKER);
  } catch {
    return false;
  }
}

/** Корень конфигурации над файлом; `wantExtension` отбирает расширение либо основную. */
function configRootAbove(file, stopAt, wantExtension) {
  let dir = dirname(resolve(file));
  const stop = resolve(stopAt);
  for (;;) {
    if (existsSync(join(dir, CONFIG_MARKER))) {
      return isExtensionRoot(dir) === wantExtension ? dir : null;
    }
    const parent = dirname(dir);
    if (parent === dir || !dir.startsWith(stop)) return null;
    dir = parent;
  }
}

/** Корень основной конфигурации в проекте — обход сверху, как в `analyzer-run.mjs`. */
function mainConfigRoot(root, maxDepth = 4) {
  const walk = (dir, depth) => {
    if (depth > maxDepth) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    if (entries.some((e) => e.isFile() && e.name === CONFIG_MARKER)) {
      return isExtensionRoot(dir) ? null : dir;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const hit = walk(join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(resolve(root), 0);
}

/**
 * Объявления модуля-близнеца из основной конфигурации.
 *
 * Модуль расширения сливается с расширяемым: метод, удалённый из расширения, может остаться
 * в базовом модуле, и голый вызов после этого законен. Без этой сверки правка расширения
 * давала бы ложные находки — тот самый класс, из-за которого не делается прямая проверка
 * разрешения имён.
 *
 * `state`: `not_extension` | `resolved` | `no_main_configuration`.
 */
export function twinDeclarations(file, root = projectRoot()) {
  const extRoot = configRootAbove(file, root, true);
  if (!extRoot) return { names: new Set(), state: 'not_extension' };
  const main = mainConfigRoot(root);
  if (!main) return { names: new Set(), state: 'no_main_configuration' };
  const twin = join(main, relative(extRoot, resolve(file)));
  if (!existsSync(twin)) return { names: new Set(), state: 'resolved' };
  return { names: declaredNames(readFileSync(twin, 'utf8').replace(/^﻿/, '')), state: 'resolved' };
}

function lineAt(source, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/** `state`: `checked` | `no_history` | `missing` | `extension_without_main`. */
export function checkFile(file, root = projectRoot()) {
  if (!existsSync(file)) return { state: 'missing', findings: [] };
  const head = headVersion(file, root);
  if (head === null) return { state: 'no_history', findings: [] };

  const current = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const now = declaredNames(current);
  const twin = twinDeclarations(file, root);
  const masked = maskModule(current);
  const findings = [];
  const seen = new Set();

  for (const routine of parseRoutines(maskModule(head))) {
    const key = norm(routine.name);
    if (now.has(key) || seen.has(key)) continue;
    seen.add(key);
    // Метод, оставшийся в базовом модуле расширения, вызывается голым именем законно.
    if (twin.names.has(key)) continue;
    for (const pos of bareCalls(masked, routine.name)) {
      findings.push({
        severity: 'error',
        rule: 'qg:BSL-STALE-LOCAL-CALL',
        line: lineAt(current, pos),
        message:
          `вызов «${routine.name}»: до правки этот метод объявлял сам модуль, сейчас объявления ` +
          'нет — переименование или удаление не доведено до всех точек вызова',
      });
    }
  }

  return {
    state: twin.state === 'no_main_configuration' ? 'extension_without_main' : 'checked',
    findings,
  };
}

/**
 * Записи следа.
 *
 * Три исхода различаются намеренно. `clean` — сравнили с HEAD и вызовов исчезнувших имён нет.
 * `no_git_history` — сравнивать было не с чем (нет git, файл новый): это пропуск, а не
 * чистый результат. `extension_without_main` — правка расширения при отсутствующей основной
 * конфигурации: метод мог остаться в базовом модуле, проверить это нечем.
 */
export function evidenceBlock(report, files = []) {
  const findings = report.flatMap((r) => r.findings);
  const hit = findings.some((f) => f.rule === 'qg:BSL-STALE-LOCAL-CALL');
  const compared = report.filter((r) => r.state === 'checked');
  const skipped = report.filter((r) => r.state !== 'checked');

  recordRun({
    scope: 'stale-local-calls',
    tool: 'tools/rename-check.mjs',
    verdict: compared.length ? (hit ? 'violation' : 'clean') : 'not_applicable',
    files,
    // То же поле и тот же смысл, что у анализатора: сколько переданных файлов инструмент
    // проверить не смог. Живёт в журнале, а не только в отчёте, потому что отчёт пишет
    // модель — заявление о полноте, взятое из проверяемого документа, ничего не подтверждает.
    unanalyzed: skipped.length,
  });

  const lines = [];
  // Вердикт считается по находкам, а не по худшему состоянию файлов: файл, который не с чем
  // сравнить, не отменяет находку в соседнем. Иначе рядом с напечатанными ошибками стояла бы
  // запись `skipped` — отчёт, который нечем опровергнуть.
  if (compared.length) {
    lines.push(
      '[qg applied: layer=code, scope=stale-local-calls, ids=[qg:BSL-STALE-LOCAL-CALL], ' +
        `verdict=${hit ? 'violation:qg:BSL-STALE-LOCAL-CALL' : 'clean'}]`
    );
  }
  // Непроверенные файлы заявляются отдельной строкой с их числом. Молчать о них нельзя:
  // «находок нет» по файлу, который не с чем было сравнить, — ложная зелёная отметка.
  for (const reason of [...new Set(skipped.map((r) => r.state))].sort()) {
    const count = skipped.filter((r) => r.state === reason).length;
    lines.push(
      '[qg skipped: layer=code, scope=stale-local-calls, planned=[qg:BSL-STALE-LOCAL-CALL], ' +
        `reason=${reason}, files=${count}]`
    );
  }
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    process.stderr.write('Использование: node rename-check.mjs <файл.bsl> [<файл.bsl> ...] [--json]\n');
    return 2;
  }

  const root = projectRoot();
  const report = files.map((f) => ({ file: f, ...checkFile(f, root) }));
  const findings = report.flatMap((r) => r.findings);
  const errors = findings.length;

  const evidence = evidenceBlock(report, files);

  if (asJson) {
    process.stdout.write(JSON.stringify({ files: report, errors, evidence }, null, 2) + '\n');
    return errors ? 2 : 0;
  }

  for (const r of report) {
    if (r.findings.length === 0) continue;
    process.stdout.write(`${r.file}\n`);
    for (const f of r.findings) {
      process.stdout.write(`  ОШИБКА:${f.line} [${f.rule}] ${f.message}\n`);
    }
    process.stdout.write('\n');
  }

  const uncompared = report.filter((r) => r.state !== 'checked').length;
  process.stdout.write(
    `Проверено файлов: ${files.length - uncompared} из ${files.length}` +
      (uncompared ? `, не с чем сравнить: ${uncompared}` : '') +
      `. Находок: ${errors}.${versionSuffix()}\n`
  );
  process.stdout.write('\n## quality evidence\n\n' + evidence + '\n');

  return errors ? 2 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('rename-check.mjs')) {
  process.exit(main(process.argv));
}
