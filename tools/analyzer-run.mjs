#!/usr/bin/env node
/**
 * Запуск статического анализатора BSL и нормализация его вывода.
 *
 * Зачем отдельный слой. Гейту нужен воспроизводимый вердикт, а не ответ на вопрос модели:
 * что не спросили у MCP — того нет в отчёте, и отличить «проверено и чисто» от «не спросили»
 * нечем. Поэтому анализатор запускается консольно, а этот модуль превращает его вывод в
 * единый вид находки и в записи следа, одинаковые для всех поддержанных движков.
 *
 * Поддержаны два бэкенда:
 *   bsl-analyzer  — по умолчанию: умеет `--incremental --changed-files`, то есть сужает
 *                   вывод до изменённых файлов, не теряя контекста конфигурации;
 *   bsl-ls        — запасной: сужать область нельзя (диагностики по метаданным молча гаснут),
 *                   поэтому гоняем от корня конфигурации и фильтруем отчёт здесь.
 *
 * Использование:
 *   node analyzer-run.mjs --changed <файл> [--changed <файл> ...] [--engine <имя>] [--json]
 *   node analyzer-run.mjs --sentinel
 *
 * Коды выхода: 0 — прогон состоялся, 1 — анализатор недоступен и не обязателен,
 * 2 — обязателен и недоступен, либо часовой не подтверждён.
 */

import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = dirname(HERE);

const IS_WINDOWS = process.platform === 'win32';
const CONFIG_MARKER = 'Configuration.xml';

/** Часовой требует диагностику, ЗАВИСЯЩУЮ ОТ МЕТАДАННЫХ, — см. sentinel() ниже. */
export const SENTINEL_CODE = 'CommonModuleInvalidType';

export const DEFAULT_ANALYZER = {
  engine: 'bsl-analyzer',
  binary: null,
  jar: null,
  version: null,
  required: false,
  config: null,
};

/**
 * Серьёзность движка → наша шкала.
 * Неизвестное значение осознанно падает в 'minor', а не отбрасывается: находка без понятной
 * серьёзности всё равно находка, а молчаливая потеря — тот самый ложный зелёный.
 */
const SEVERITY_MAP = {
  blocker: 'critical',
  critical: 'critical',
  major: 'major',
  minor: 'minor',
  warning: 'minor',
  information: 'info',
  info: 'info',
  hint: 'info',
};

export function projectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** Читает проектный `.1c-quality-gate.json`; переменные окружения перекрывают файл. */
export function readAnalyzerConfig(root = projectRoot()) {
  const cfg = { ...DEFAULT_ANALYZER };
  const file = join(root, '.1c-quality-gate.json');
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      Object.assign(cfg, raw?.analyzer || {});
    } catch {
      /* повреждённый проектный конфиг не должен ронять прогон — работаем на умолчаниях */
    }
  }
  const env = process.env;
  if (env.QG_ANALYZER_ENGINE) cfg.engine = env.QG_ANALYZER_ENGINE;
  if (env.QG_ANALYZER_BIN) cfg.binary = env.QG_ANALYZER_BIN;
  if (env.QG_ANALYZER_JAR) cfg.jar = env.QG_ANALYZER_JAR;
  if (env.QG_ANALYZER_VERSION) cfg.version = env.QG_ANALYZER_VERSION;
  if (env.QG_ANALYZER_REQUIRED) cfg.required = env.QG_ANALYZER_REQUIRED === 'true';
  return cfg;
}

/**
 * Ищет корень конфигурации 1С — каталог с `Configuration.xml`.
 *
 * Анализировать нужно именно от него: у bsl-analyzer сужение делается флагом, а у BSL LS
 * попытка указать более узкий каталог молча гасит диагностики по метаданным. Поиск идёт
 * вверх от файла и не выходит за пределы проекта.
 */
export function findConfigRoot(file, stopAt = projectRoot()) {
  let dir = dirname(resolve(file));
  const stop = resolve(stopAt);
  for (;;) {
    if (existsSync(join(dir, CONFIG_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (!dir.startsWith(stop)) return null;
    dir = parent;
  }
}

/** Группирует изменённые файлы по корням конфигураций: в проекте их может быть несколько. */
export function groupByConfigRoot(files, stopAt = projectRoot()) {
  const groups = new Map();
  const orphans = [];
  for (const f of files) {
    const root = findConfigRoot(f, stopAt);
    if (!root) {
      orphans.push(f);
      continue;
    }
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(resolve(f));
  }
  return { groups, orphans };
}

/**
 * Находит исполняемый файл bsl-analyzer.
 *
 * Версионированный файл (`bsl-analyzer-0.2.66`) на Windows лежит БЕЗ расширения и через
 * spawn не запускается — CreateProcess его не видит (проверено: ENOENT). Поэтому берём
 * рабочий бинарник, а версию не угадываем по имени, а СПРАШИВАЕМ у него самого и сверяем
 * с закреплённой. Лаунчер (`bsl-analyzer.exe` рядом с местом установки) не используем
 * никогда: он умеет молча обновиться посреди задачи, и гейт перестаёт быть воспроизводимым.
 */
export function resolveBslAnalyzer(cfg) {
  if (cfg.binary) return existsSync(cfg.binary) ? cfg.binary : null;
  const dir = join(homedir(), '.bsl-analyzer', 'bin');
  if (!existsSync(dir)) return null;
  const app = join(dir, IS_WINDOWS ? 'bsl-analyzer-app.exe' : 'bsl-analyzer-app');
  if (existsSync(app)) return app;
  // На не-Windows версионированный файл запускается напрямую — там он и есть лучший выбор.
  const versioned = readdirSync(dir)
    .filter((n) => /^bsl-analyzer-\d/.test(n))
    .sort()
    .pop();
  return versioned ? join(dir, versioned) : null;
}

export function engineVersion(binary) {
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0) return null;
  const m = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** Нормализует jsonl bsl-analyzer. Нумерация строк у него нулевая — приводим к человеческой. */
export function normalizeBslAnalyzer(stdout, { root, base = projectRoot() } = {}) {
  const findings = [];
  const metrics = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'file') continue;
    const file = toRelative(rec.path, base, root);
    if (rec.metrics) metrics.set(file, rec.metrics);
    for (const d of rec.diagnostics || []) {
      findings.push({
        file,
        line: (d.start_line ?? 0) + 1,
        column: (d.start_column ?? 0) + 1,
        code: d.code,
        severity: SEVERITY_MAP[String(d.severity || '').toLowerCase()] || 'minor',
        message: d.message || '',
      });
    }
  }
  return { findings, metrics };
}

/** Нормализует JSON-отчёт BSL Language Server (`-r json`). У него нумерация тоже нулевая. */
export function normalizeBslLs(jsonText, { root, base = projectRoot(), only = null } = {}) {
  const findings = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { findings, metrics: new Map() };
  }
  const keep = only ? new Set(only.map((f) => toRelative(f, base, root))) : null;
  for (const f of parsed.fileinfos || []) {
    const file = toRelative(f.path, base, root);
    if (keep && !keep.has(file)) continue;
    for (const d of f.diagnostics || []) {
      const code = typeof d.code === 'object' ? d.code?.value : d.code;
      findings.push({
        file,
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        code: String(code || ''),
        severity: SEVERITY_MAP[String(d.severity || '').toLowerCase()] || 'minor',
        message: d.message || '',
      });
    }
  }
  return { findings, metrics: new Map() };
}

/**
 * Приводит путь из отчёта к проектному.
 *
 * Движки отдают пути по-разному: bsl-analyzer — абсолютный windows-путь с префиксом
 * длинных имён `\\?\`, BSL Language Server — URI вида `file:///H:/...`. Без разбора обеих
 * форм фильтр по изменённым файлам молча не находит ни одного совпадения, и контур
 * отчитывается вердиктом «чисто» на пустом множестве.
 */
function toRelative(p, base, root) {
  let s = String(p);
  if (s.startsWith('file:')) {
    try {
      s = fileURLToPath(s);
    } catch {
      s = decodeURIComponent(s.replace(/^file:\/*/, ''));
    }
  }
  s = s.replace(/^\\\\\?\\/, '');
  const candidates = [base, root].filter(Boolean);
  for (const c of candidates) {
    const rel = relative(resolve(c), resolve(s));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return s.split(sep).join('/');
}

/** Гейтовый конфиг движка из состава плагина; проектный конфиг правит IDE, этот — гейтом. */
export function gateConfigPath(engine, cfg) {
  if (cfg.config) return cfg.config;
  const name = engine === 'bsl-ls' ? 'bsl-language-server.json' : 'bsl-analyzer.toml';
  const p = join(PLUGIN_ROOT, 'assets', 'analyzer', name);
  return existsSync(p) ? p : null;
}

export function runBslAnalyzer({ binary, root, changed, configPath }) {
  const args = ['analyze', '--incremental', '-s', root, '--format', 'jsonl', '-q'];
  for (const f of changed) {
    args.push('--changed-files', relative(root, f).split(sep).join('/'));
  }
  if (configPath) args.push('-c', configPath);
  // Рабочий каталог — корень конфигурации: у BSL LS иной диск в cwd даёт падение
  // `'other' has different root`, и одинаковое поведение обоих бэкендов дешевле, чем разное.
  const r = spawnSync(binary, args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 900_000 });
  return { ok: !r.error && r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', args };
}

export function runBslLs({ jar, root, configPath }) {
  // Каталог отчёта обязан лежать на том же диске, что и исходники: системный TEMP на
  // Windows живёт на C:, и при проекте на другом диске BSL LS падает с невнятным
  // `'other' has different root`. Кладём рядом с исходниками — совпадение диска
  // обеспечено по построению.
  const stage = join(root, '.qg-analyzer');
  mkdirSync(stage, { recursive: true });
  const out = mkdtempSync(join(stage, 'run-'));
  const args = ['-jar', jar, 'analyze', '-s', root, '-r', 'json', '-o', out, '-q'];
  if (configPath) args.splice(2, 0, '-c', configPath);
  const r = spawnSync('java', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000 });
  const report = join(out, 'bsl-json.json');
  const text = existsSync(report) ? readFileSync(report, 'utf8') : '';
  try {
    rmSync(out, { recursive: true, force: true });
    rmSync(stage, { recursive: false, force: true });
  } catch {
    /* уборка не критична: каталог пустой и безобиден */
  }
  return { ok: !r.error && Boolean(text), stdout: text, stderr: r.stderr || '', args };
}

/**
 * Часовой: прогоняет фикстуру с заведомым нарушением тем же вызовом и тем же конфигом.
 *
 * Требуется диагностика, ЗАВИСЯЩАЯ ОТ МЕТАДАННЫХ. Часовой, доказывающий лишь «хоть что-то
 * сработало», пропустит самый опасный отказ: при потере контекста конфигурации гаснет именно
 * класс метаданных, а прочие замечания остаются на месте — отчёт выглядит содержательным.
 * В бою сравнивать не с чем: базовой линии у гейта нет.
 */
export function sentinel({ engine, binary, jar, configPath }) {
  const root = join(PLUGIN_ROOT, 'assets', 'analyzer', 'sentinel-fixture');
  if (!existsSync(join(root, CONFIG_MARKER))) {
    return { status: 'not_found', reason: 'fixture_missing' };
  }
  let raw;
  if (engine === 'bsl-ls') {
    raw = runBslLs({ jar, root, configPath });
    if (!raw.ok) return { status: 'not_found', reason: 'engine_failed' };
    const { findings } = normalizeBslLs(raw.stdout, { root, base: root });
    return verdict(findings);
  }
  const changed = collectBsl(root);
  raw = runBslAnalyzer({ binary, root, changed, configPath });
  if (!raw.ok) return { status: 'not_found', reason: 'engine_failed' };
  const { findings } = normalizeBslAnalyzer(raw.stdout, { root, base: root });
  return verdict(findings);

  function verdict(findings) {
    const hit = findings.some((f) => f.code === SENTINEL_CODE);
    return hit ? { status: 'found' } : { status: 'not_found', reason: 'diagnostic_absent' };
  }
}

function collectBsl(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectBsl(p, acc);
    else if (/\.(bsl|os)$/i.test(entry.name)) acc.push(p);
  }
  return acc;
}

/**
 * Строит записи следа.
 *
 * Чистый прогон отчитывается идентификатором всего набора (`bslls:*`) — перечислять полторы
 * сотни проверенных кодов бессмысленно. Нарушения выводятся по одной записи на код: так в
 * следе видно, ЧТО именно сработало, а не только что «что-то нашли».
 */
export function toEvidence({ findings, sentinelResult, engine, version }) {
  const lines = [];
  const stamp = version ? `${engine}@${version}` : engine;
  lines.push(
    `[qg sentinel: target=bslls, id=${SENTINEL_CODE}, status=${sentinelResult.status}, engine=${stamp}]`
  );
  const codes = [...new Set(findings.map((f) => f.code))].sort();
  if (codes.length === 0) {
    lines.push('[qg applied: layer=code, scope=static-analysis, ids=[bslls:*], verdict=clean]');
  } else {
    for (const c of codes) {
      lines.push(
        `[qg applied: layer=code, scope=static-analysis, ids=[bslls:${c}], verdict=violation:bslls:${c}]`
      );
    }
  }
  return lines;
}

export function skipEvidence(reason) {
  return [`[qg skipped: layer=code, scope=static-analysis, planned=[bslls:*], reason=${reason}]`];
}

function parseArgs(argv) {
  const out = { changed: [], engine: null, json: false, sentinel: false, evidenceOnly: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--changed') out.changed.push(argv[++i]);
    else if (a === '--engine') out.engine = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--sentinel') out.sentinel = true;
    else if (a === '--evidence') out.evidenceOnly = true;
    else if (a === '--all') out.all = true;
    else if (!a.startsWith('--')) out.changed.push(a);
  }
  return out;
}

const SEVERITY_MARK = { critical: '🔴', major: '🟠', minor: '🟡', info: '·' };
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, info: 3 };

/**
 * Печатает находки, сворачивая информационные в одну строку.
 *
 * Причина не в том, что они не важны, а в том, что на реальном модуле их вдесятеро больше
 * содержательных: `MagicNumber`, смешение латиницы и кириллицы в идентификаторах вида
 * `ВызватьHTTPМетод` (для 1С это норма, а диагностика отличить не может). Утопленная в них
 * находка 🟠 не будет прочитана. Ничего не скрывается: количество названо, коды попадают в
 * след, полный список доступен по `--all`.
 */
function report(findings, out, { all = false } = {}) {
  const shown = all ? findings : findings.filter((f) => f.severity !== 'info');
  const hidden = findings.length - shown.length;

  const byFile = new Map();
  for (const f of shown) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, list] of [...byFile.entries()].sort()) {
    out(`\n${file}`);
    for (const f of list.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line)) {
      out(`  ${SEVERITY_MARK[f.severity]} :${f.line} — ${f.code}: ${f.message}`);
    }
  }
  if (hidden) {
    const codes = [...new Set(findings.filter((f) => f.severity === 'info').map((f) => f.code))].sort();
    out(`\nЕщё ${hidden} информационных: ${codes.join(', ')} (полный список — флаг --all)`);
  }
}

function main(argv) {
  const args = parseArgs(argv.slice(2));
  const out = (s) => process.stdout.write(s + '\n');
  const root = projectRoot();
  const cfg = readAnalyzerConfig(root);
  const engine = args.engine || cfg.engine;
  const configPath = gateConfigPath(engine, cfg);

  let binary = null;
  let jar = null;
  if (engine === 'bsl-ls') {
    jar = cfg.jar;
    if (!jar || !existsSync(jar)) return unavailable('analyzer_unavailable');
  } else {
    binary = resolveBslAnalyzer(cfg);
    if (!binary) return unavailable('analyzer_unavailable');
  }

  const version = engine === 'bsl-ls' ? null : engineVersion(binary);
  if (cfg.version && version && version !== cfg.version) {
    process.stderr.write(
      `Версия анализатора ${version} не совпадает с закреплённой ${cfg.version}.\n` +
        'Гейт с плавающей версией движка невоспроизводим: закрепите или обновите analyzer.version.\n'
    );
    return 2;
  }

  const sentinelResult = sentinel({ engine, binary, jar, configPath });

  if (args.sentinel) {
    out(`Часовой (${engine}${version ? '@' + version : ''}): ${sentinelResult.status}` +
      (sentinelResult.reason ? ` — ${sentinelResult.reason}` : ''));
    return sentinelResult.status === 'found' ? 0 : 2;
  }

  if (args.changed.length === 0) {
    process.stderr.write('Нечего проверять: не передан ни один --changed <файл>.\n');
    return 2;
  }

  const { groups, orphans } = groupByConfigRoot(args.changed, root);
  const findings = [];
  const metrics = new Map();

  for (const [cfgRoot, files] of groups) {
    const raw =
      engine === 'bsl-ls'
        ? runBslLs({ jar, root: cfgRoot, configPath })
        : runBslAnalyzer({ binary, root: cfgRoot, changed: files, configPath });
    if (!raw.ok) {
      process.stderr.write(`Анализатор завершился неуспешно на ${cfgRoot}\n${raw.stderr.slice(0, 500)}\n`);
      return cfg.required ? 2 : 1;
    }
    const norm =
      engine === 'bsl-ls'
        ? normalizeBslLs(raw.stdout, { root: cfgRoot, base: root, only: files })
        : normalizeBslAnalyzer(raw.stdout, { root: cfgRoot, base: root });
    findings.push(...norm.findings);
    for (const [k, v] of norm.metrics) metrics.set(k, v);
  }

  const evidence = toEvidence({ findings, sentinelResult, engine, version });

  if (args.json) {
    out(JSON.stringify({ engine, version, sentinel: sentinelResult, findings, metrics: Object.fromEntries(metrics), evidence, orphans }, null, 2));
    return sentinelResult.status === 'found' ? 0 : 2;
  }

  if (!args.evidenceOnly) {
    if (orphans.length) {
      out(`Вне корня конфигурации (не анализировались): ${orphans.join(', ')}`);
    }
    out(`Движок: ${engine}${version ? ' ' + version : ''} | часовой: ${sentinelResult.status} | находок: ${findings.length}`);
    report(findings, out, { all: args.all });
  }
  out('\n## quality evidence\n');
  for (const l of evidence) out(l);

  return sentinelResult.status === 'found' ? 0 : 2;

  function unavailable(reason) {
    for (const l of skipEvidence(reason)) out(l);
    if (cfg.required) {
      process.stderr.write(
        'Анализатор не найден, а analyzer.required=true: контур кода не может быть закрыт.\n'
      );
      return 2;
    }
    process.stderr.write('Анализатор не найден — контур кода пропущен с отметкой в следе.\n');
    return 1;
  }
}

if (process.argv[1]?.endsWith('analyzer-run.mjs')) {
  process.exit(main(process.argv));
}
