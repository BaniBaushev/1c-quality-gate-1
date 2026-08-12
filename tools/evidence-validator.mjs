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
import { resolve as resolveConfig, evidenceValue } from './config.mjs';

export const SECTION = '## quality evidence';

const LAYERS = ['code', 'arch', 'xml', 'hygiene'];
const VOLUMES = ['C0', 'C1', 'C2', 'C3'];

/**
 * Измерения, которые доступными средствами не проверяются, и потому обязаны быть заявлены.
 *
 * `compilation` — тела модулей: ни выгрузка, ни валидаторы XML их не компилируют.
 * `query-execution` — текст запроса: он строковый литерал, его не разбирает ни анализатор,
 * ни сборка бинарника. Ошибка вроде «Неоднозначное поле» доживает до первого выполнения.
 * `static-analysis` и `cross-config-resolution` печатает `analyzer-run.mjs`, когда файл не
 * разобран или основной конфигурации нет.
 *
 * Список закрытый: опечатка в имени измерения оставила бы запись, которая выглядит
 * заполненной, но ничего не закрывает. Пополнять его нужно вместе с инструментом, который
 * новое имя печатает, — иначе валидатор ругается на собственный вывод плагина.
 */
const DIMENSIONS = ['compilation', 'query-execution', 'static-analysis', 'cross-config-resolution'];

/**
 * Метки архетипов из таблицы `quality-gate/SKILL.md`.
 *
 * Поле `archetypes` пишет модель, инструмент его не печатает — и на нём завязано требование
 * об исполнении запроса. Метка `queries` вместо `query` не сработала бы ничем: требование
 * молча не предъявляется, гейт снимается, а в отчёте всё выглядит заполненным. Поэтому
 * список закрытый, а проектные архетипы добавляются к нему из `archetypes.custom`.
 *
 * `none` — законная форма «ни одна метка не сработала»: пустой список запрещён отдельно.
 */
const ARCHETYPES = [
  'none',
  'query',
  'transaction',
  'record-set',
  'object-event',
  'integration',
  'rights',
  'cfe-patch',
  'scheduled-job',
  'client-server',
  'user-dialog',
  'form-module',
  'async-client',
  'new-common-module',
  'new-metadata-object',
];

/** Поля, без которых запись бессмысленна. Пустое значение приравнивается к отсутствию. */
const REQUIRED = {
  scope: ['volume', 'files', 'archetypes', 'driver', 'resolved'],
  applied: ['layer', 'scope', 'ids', 'verdict'],
  skipped: ['layer', 'reason'],
  not_verified: ['dimension', 'reason'],
  sentinel: ['target', 'status'],
};

// `bslls:*` — законный идентификатор «весь набор правил анализатора»: перечислять полторы
// сотни проверенных кодов в чистом прогоне бессмысленно, а формат уже использует эту форму
// в поле `planned` записи skipped.
// Идентификатор нашей эвристики — из двух и БОЛЕЕ сегментов: `qg:ARCH-A1`, но и
// `qg:AI-CONTRACT-RECHECK`. Прежний шаблон допускал ровно два сегмента и ругался на
// составные имена, которые сам же плагин и порождает.
const ID_PATTERN = /^(std\d{3,4}|bslls:(\*|[A-Za-z][\w-]*)|acc:\d{3,4}|v8cs:[\w-]+|qg:[A-Z][A-Z0-9]*(-[A-Z0-9]+)+|patterns:[\w:-]+)$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Настройка, применённая к прогону: `default` либо `custom:<секция>[+<секция>]`. Печатает её
// `tools/config.mjs show`, откуда она и переносится в след. Список секций закрытый: выдуманное
// имя означает, что строку сочинили, а не скопировали из вывода инструмента.
const CONFIG_SECTIONS = ['analyzer', 'volume', 'complexity', 'archetypes', 'sentinel'];
const CONFIG_PATTERN = new RegExp(`^(default|custom:(${CONFIG_SECTIONS.join('|')})(\\+(${CONFIG_SECTIONS.join('|')}))*)$`);

/**
 * Внешний источник, которым подтверждается идентификатор.
 *
 * Наши собственные эвристики (`qg:`, `patterns:`) внешнего источника не имеют — часового по
 * ним требовать не с кого. Всё остальное опирается на живой сервис или на живой анализатор,
 * и «нарушений нет» по такому идентификатору достоверно лишь тогда, когда источник отвечал.
 */
function sentinelTarget(id) {
  if (id.startsWith('bslls:')) return 'bslls';
  if (/^std\d/.test(id) || id.startsWith('acc:') || id.startsWith('v8cs:')) return 'v8std';
  return null;
}

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
    if (rec.type === 'scope' && rec.fields.config && !CONFIG_PATTERN.test(String(rec.fields.config))) {
      add(
        'error',
        rec.line,
        `config="${rec.fields.config}": ожидается default либо custom:<секция>[+<секция>] ` +
          `(${CONFIG_SECTIONS.join(', ')}) — строку печатает config.mjs show`
      );
    }
    // В нестрогом режиме отсутствие поля — предупреждение: отчёты, собранные до появления
    // этого поля, читать и линтовать по-прежнему можно. Снятие гейта его требует.
    if (rec.type === 'scope' && !gate && isEmpty(rec.fields.config)) {
      add('warn', rec.line, 'в записи scope нет поля config: неизвестно, по чьим порогам выбрана глубина');
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
    if (rec.type === 'not_verified' && rec.fields.dimension && !DIMENSIONS.includes(String(rec.fields.dimension))) {
      add(
        'warn',
        rec.line,
        `dimension="${rec.fields.dimension}" вне списка ${DIMENSIONS.join('|')}: ` +
          'запись выглядит заполненной, но требуемое измерение не закрывает'
      );
    }
  }

  // Измерение считается закрытым, если о нём заявлено: либо оно проверено (запись applied с
  // тем же именем в scope), либо признано непроверяемым (not_verified). Молчание — нет.
  //
  // Два пространства имён здесь намеренно сведены в одно, и это накладывает ограничение на
  // будущие требования: имя измерения не должно совпадать с распространённым `scope` записи
  // applied, иначе требование удовлетворялось бы само собой. Так, `static-analysis` —
  // одновременно измерение и scope, которые печатает `analyzer-run.mjs`; сегодня закрывать
  // его никто не требует, но новое требование по такому имени было бы пустым.
  const closes = new Set();
  for (const rec of records) {
    if (rec.type === 'not_verified' && rec.fields.dimension) closes.add(String(rec.fields.dimension).trim());
    if (rec.type === 'applied' && rec.fields.scope) closes.add(String(rec.fields.scope).trim());
  }

  // Настройка проекта нужна дважды: для сверки поля `config` и для списка проектных
  // архетипов. Читается один раз; если не читается — сверять не с чем, и требования,
  // опирающиеся на неё, смягчаются до предупреждения.
  let project = null;
  try {
    project = resolveConfig();
  } catch {
    /* настройка недоступна */
  }
  const knownArchetypes = new Set([
    ...ARCHETYPES,
    ...(project?.values?.archetypes?.custom || []).map((a) => String(a?.name ?? '').trim()).filter(Boolean),
  ]);

  const archetypesOf = (rec) => (Array.isArray(rec.fields.archetypes) ? rec.fields.archetypes : []);

  // Метка архетипа — единственное поле следа, от которого зависит требование и которое при
  // этом пишет модель, а не инструмент. Опечатка здесь не даёт ни ошибки, ни находки: правило
  // просто не предъявляется, и гейт снимается на полном молчании.
  for (const rec of records.filter((r) => r.type === 'scope')) {
    for (const label of archetypesOf(rec)) {
      if (knownArchetypes.has(label)) continue;
      add(
        project && gate ? 'error' : 'warn',
        rec.line,
        `архетип "${label}" не из таблицы quality-gate и не объявлен в archetypes.custom: ` +
          'требования, привязанные к архетипам, по такой метке не сработают'
      );
    }
  }

  // Архетип «запрос» обязывает отчитаться о выполнении запроса. Прогон, который его ни разу
  // не выполнил, вправе так и написать — но не вправе промолчать: статический разбор текста
  // запроса не заменяет попытки его выполнить.
  const queryArchetype = records.some((r) => r.type === 'scope' && archetypesOf(r).includes('query'));
  if (queryArchetype && !closes.has('query-execution')) {
    add(
      gate ? 'error' : 'warn',
      records.find((r) => r.type === 'scope')?.line || 0,
      'сработал архетип query, но об исполнении запроса не заявлено: нужна запись ' +
        '[qg applied: layer=code, scope=query-execution, ...] либо ' +
        '[qg not_verified: dimension=query-execution, reason=no_platform]'
    );
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

  // Настройка проекта меняет пороги, по которым выбран класс. Без этой отметки «C1» в одном
  // отчёте не означает того же, что «C1» в другом, а прогон, не заглянувший в настройку,
  // неотличим от прогона, который её учёл.
  //
  // Отметка не принимается на слово, а СВЕРЯЕТСЯ с фактической настройкой проекта. Заявление,
  // которое никто не проверяет, — это ровно та подпись под непрогнанной проверкой, против
  // которой написан весь формат: приписать `config=default` в проекте с задранными порогами
  // не сложнее, чем забыть посмотреть настройку.
  // Настройка прочитана выше — сверять не с чем только тогда, когда её не удалось прочесть.
  const actual = project ? evidenceValue(project) : null;
  for (const s of scopes) {
    if (isEmpty(s.fields.config)) {
      add(
        'error',
        s.line,
        'в записи scope нет поля config: неизвестно, по чьим порогам выбрана глубина — ' +
          'строку печатает `node tools/config.mjs show`'
      );
    } else if (actual && String(s.fields.config) !== actual) {
      add(
        'error',
        s.line,
        `config="${s.fields.config}" расходится с настройкой проекта (сейчас "${actual}"): ` +
          'след относится к другим порогам — перепроверь профиль и перенеси строку из `config.mjs show`'
      );
    }
  }

  const checks = records.filter((r) => r.type === 'applied' || r.type === 'skipped');
  if (checks.length === 0) add('error', 0, 'нет ни одной записи applied/skipped: ни один контур не отчитался');

  const sentinels = records.filter((r) => r.type === 'sentinel');
  if (sentinels.length === 0) {
    add('error', 0, 'нет записи sentinel: невозможно отличить «нарушений нет» от «источник стандартов недоступен»');
  } else if (!sentinels.some((s) => s.fields.status === 'found')) {
    add('error', sentinels[0].line, 'sentinel не подтверждён (status=not_found): результат прогона недостоверен');
  }

  const applied = records.filter((r) => r.type === 'applied');

  // Часовой проверяется ПО ЦЕЛЯМ, а не «хотя бы один живой».
  //
  // Иначе подтверждённый v8std маскирует мёртвый анализатор: в следе стоит `bslls:...` с
  // вердиктом clean, рядом `sentinel target=v8std status=found` — и правило выполнено, хотя
  // про анализатор неизвестно ничего. Каждое «нарушений нет» обязано опираться на источник,
  // который в этом прогоне доказал, что жив.
  const neededTargets = new Set();
  for (const rec of applied) {
    if (rec.fields.verdict !== 'clean') continue;
    const ids = Array.isArray(rec.fields.ids) ? rec.fields.ids : [];
    for (const id of ids) {
      const target = sentinelTarget(id);
      if (target) neededTargets.add(target);
    }
  }
  for (const target of [...neededTargets].sort()) {
    const confirmed = sentinels.some((s) => s.fields.target === target && s.fields.status === 'found');
    if (!confirmed) {
      add(
        'error',
        0,
        `вердикт «clean» опирается на источник "${target}", но подтверждённого часового по нему нет ` +
          `(нужна запись sentinel с target=${target} и status=found)`
      );
    }
  }

  // Вердикт «чисто» обязан признавать то, что проверить было нечем.
  //
  // Требование именно по измерению `compilation`, а не «хотя бы одна запись not_verified».
  // Иначе появление второго измерения ослабляет проверку: прогон заявляет непроверенным
  // что-нибудь одно, о компилируемости молчит — и полностью зелёный отчёт снова проходит.
  const allClean = applied.length > 0 && applied.every((r) => r.fields.verdict === 'clean');
  if (allClean && !closes.has('compilation')) {
    add(
      'error',
      0,
      'все проверки «clean», но компилируемость тел модулей не заявлена. Её не проверяет ни выгрузка ' +
        'конфигурации, ни валидаторы XML — если /CheckConfig не запускался, нужна запись ' +
        '[qg not_verified: dimension=compilation, reason=no_platform]'
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
