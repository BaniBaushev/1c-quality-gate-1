#!/usr/bin/env node
/**
 * Тесты программных проверок плагина.
 *
 * Что покрывается: инструменты, которые являются КОДОМ — гигиена файлов, сверка
 * «диск ↔ состав», валидатор следа, механика гейта.
 *
 * Что НЕ покрывается и почему: контуры code и arch — это инструкции для модели, а не
 * программы. CI не может прогнать модель, поэтому для них проверяется только полнота
 * правил (что строка про конкретный антипаттерн не исчезла из таблицы). Это ловит
 * регрессию удаления, но не качество применения.
 *
 * Отдельный акцент на ложных срабатываниях: заведомо корректный код обязан давать ноль
 * находок. Ложная находка вреднее пропущенной — она провоцирует переделку рабочего кода,
 * и после двух-трёх таких проверку отключают целиком.
 *
 * Использование:
 *   node tests/run-tests.mjs [--verbose]
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const WORK = join(tmpdir(), 'qg-tests');
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    if (VERBOSE) process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures.push({ name, detail });
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

/** Запускает инструмент плагина, возвращает код возврата и вывод. */
function run(script, args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, script), ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// Байтовые фикстуры генерируются, а не хранятся: git нормализует переводы строк и может
// снять BOM, из-за чего тест проверял бы не то, что задумано.
// Невидимые символы задаются кодом, а не литералом — литерал в исходнике сам источник ошибок.
const BOM = String.fromCharCode(0xfeff);
const GROUP_SEPARATOR = String.fromCharCode(0x1d);
function writeBytes(name, content) {
  mkdirSync(WORK, { recursive: true });
  const p = join(WORK, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ---------------------------------------------------------------------------
section('Гигиена файлов — находит настоящие дефекты');

{
  const f = writeBytes('no-bom.bsl', 'Процедура Тест()\nКонецПроцедуры\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('нет BOM — предупреждение', r.out.includes('bom-missing'), r.out.trim().slice(0, 80));
}
{
  const f = writeBytes('dash-comment.bsl', BOM + '// Комментарий с тире — вот так\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('тире в комментарии — находка', r.out.includes('invalid-dash'));
}
{
  // Разделитель группы попадает в файл при программной записи и невидим в редакторе.
  const f = writeBytes('control.bsl', BOM + `Процедура Тест()
	А = "X${GROUP_SEPARATOR}Y";
КонецПроцедуры
`);
  const r = run('tools/hygiene-check.mjs', [f]);
  check('управляющий символ — ошибка', r.out.includes('control-char'));
  check('управляющий символ даёт код 2', r.code === 2, `код ${r.code}`);
}
{
  const f = writeBytes('mixed-eol.bsl', BOM + 'Процедура Тест()\r\n\tА = 1;\nКонецПроцедуры\r\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('смешанные переводы строк — находка', r.out.includes('mixed-eol'));
}

// ---------------------------------------------------------------------------
section('Гигиена файлов — НЕ придирается к корректному коду (ложные срабатывания)');

{
  // Длинное тире в тексте для пользователя — норма, встречается в типовых модулях.
  const f = writeBytes('dash-literal.bsl', BOM + 'Процедура Т()\n\tСообщить("Заказ — оплачен");\nКонецПроцедуры\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('тире в строковом литерале — молчание', !r.out.includes('invalid-dash'), r.out.trim().slice(0, 100));
}
{
  const f = writeBytes('dash-multiline.bsl', BOM + 'Процедура Т()\n\tТ = "Строка\n\t|продолжение — с тире";\nКонецПроцедуры\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('тире в продолжении литерала — молчание', !r.out.includes('invalid-dash'));
}
{
  const f = writeBytes('clean.bsl', BOM + 'Процедура Тест()\n\tА = 1; // обычный дефис - тут\nКонецПроцедуры\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('чистый файл — ноль находок', r.code === 0, `код ${r.code}: ${r.out.trim().slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
section('Сверка «диск ↔ состав»');

{
  const r = run('tools/xml/orphan-check.mjs', [join(FIXTURES, 'config-clean')]);
  check('чистая выгрузка — расхождений нет', r.code === 0, `код ${r.code}: ${r.out.trim().slice(0, 120)}`);
}
{
  const r = run('tools/xml/orphan-check.mjs', [join(FIXTURES, 'config-orphan')]);
  check('файл-сирота найден', r.out.includes('СИРОТЫ') || r.out.includes('сирот'), r.out.trim().slice(0, 120));
  check('сирота даёт код 2', r.code === 2, `код ${r.code}`);
  check('назван конкретный объект', r.out.includes('ЗабытыйСправочник'));
}
{
  const r = run('tools/xml/orphan-check.mjs', [join(FIXTURES, 'config-missing')]);
  check('отсутствующий файл найден', r.out.includes('ОТСУТСТВУЮТ'), r.out.trim().slice(0, 120));
  check('отсутствующий файл даёт код 2', r.code === 2);
}

// ---------------------------------------------------------------------------
section('Валидатор следа — отвергает недобросовестный прогон');

const ev = (name) => join(FIXTURES, 'evidence', name);
{
  const r = run('tools/evidence-validator.mjs', [ev('valid.md'), '--gate']);
  check('полный корректный след принимается', r.code === 0, r.out.trim().slice(0, 120));
}
{
  const r = run('tools/evidence-validator.mjs', [ev('no-sentinel.md'), '--gate']);
  check('без sentinel — отклонён', r.code === 2);
  check('причина названа', r.out.includes('sentinel'));
}
{
  const r = run('tools/evidence-validator.mjs', [ev('all-clean.md'), '--gate']);
  check('всё «чисто» без not_verified — отклонён', r.code === 2, r.out.trim().slice(0, 120));
}
{
  const r = run('tools/evidence-validator.mjs', [ev('empty-ids.md'), '--gate']);
  check('пустой список идентификаторов — отклонён', r.code === 2);
}
{
  const r = run('tools/evidence-validator.mjs', [ev('malformed.md'), '--gate']);
  check('незакрытая запись — отклонена', r.out.includes('не разобрана'));
}
{
  const r = run('tools/evidence-validator.mjs', [ev('multiline-scope.md'), '--gate']);
  check('многострочная запись scope разбирается', r.code === 0, r.out.trim().slice(0, 120));
}

// ---------------------------------------------------------------------------
section('Механика гейта');

{
  const proj = join(WORK, 'proj');
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(join(proj, 'src', 'cf', 'CommonModules', 'М', 'Ext'), { recursive: true });
  const env = { CLAUDE_PROJECT_DIR: proj };
  const file = join(proj, 'src', 'cf', 'CommonModules', 'М', 'Ext', 'Module.bsl');

  const arm = (sessionId, path = file) => {
    const payload = JSON.stringify({ session_id: sessionId, cwd: proj, tool_input: { file_path: path } });
    try {
      return execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    } catch {
      return '';
    }
  };
  const stop = (sessionId, extra = {}) => {
    const payload = JSON.stringify({ session_id: sessionId, cwd: proj, ...extra });
    try {
      execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-check.mjs')], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: 'pipe',
      });
      return 0;
    } catch (e) {
      return e.status ?? 1;
    }
  };

  check('правка .bsl взводит гейт', arm('S1').includes('взведён'));
  check('Stop блокирует свою сессию', stop('S1') === 2);
  check('Stop чужой сессии не блокирует', stop('S2') === 0);

  // Повторная попытка завершения не должна открывать обход.
  check('повторный Stop тоже блокирует', stop('S1', { stop_hook_active: true }) === 2);

  // Не-1С файлы игнорируются: в чужих проектах плагин обязан молчать.
  check('README не взводит гейт', arm('S3', join(proj, 'README.md')) === '');
  check('XML вне выгрузки 1С не взводит', arm('S3', join(proj, 'src', 'main', 'beans.xml')) === '');

  const rel = run('tools/gate.mjs', ['release', '--class', 'C3', '--reason', 'просто не хочу проверять'], { env });
  check('снятие C3 без следа запрещено', rel.code === 2, rel.out.trim().slice(0, 100));

  const relOk = run('tools/gate.mjs', ['release', '--evidence', ev('valid.md'), '--session', 'S1'], { env });
  check('снятие по валидному следу проходит', relOk.code === 0, relOk.out.trim().slice(0, 120));
  check('после снятия Stop пропускает', stop('S1') === 0);
}

// ---------------------------------------------------------------------------
section('Полнота правил (контуры code и arch выполняет модель — проверяем, что правила на месте)');

const mustContain = [
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'Запрос в цикле', 'антипаттерн «запрос в цикле»'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-01', 'запись набора с неполным отбором'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-04', 'отчёт о непрогнанной проверке'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-05', 'зелёная сборка вместо компиляции'],
  ['skills/bsl-architecture-review/references/ai-antipatterns-arch.md', 'ARCH-AI-05', 'параллельная коллекция вместо поля'],
  ['skills/xml-structure-review/SKILL.md', 'ChildObjects', 'проверка регистрации в составе'],
  ['shared/routing-contract.md', 'радиус', 'граница контуров по радиусу правки'],
];
for (const [file, needle, label] of mustContain) {
  const p = join(ROOT, file);
  check(`правило на месте: ${label}`, existsSync(p) && readFileSync(p, 'utf8').includes(needle));
}

// у каждого признака архитектуры обязан быть контр-сигнал
{
  const map = JSON.parse(readFileSync(join(ROOT, 'skills/bsl-architecture-review/references/signs-map.json'), 'utf8'));
  const without = (map.signs || []).filter((s) => !s.counter || s.counter.trim().length < 10);
  check('у каждого признака есть контр-сигнал', without.length === 0, without.map((s) => s.id).join(', '));
  const noPrinciple = (map.signs || []).filter((s) => !s.principles?.length);
  check('у каждого признака есть ссылка на принцип', noPrinciple.length === 0);
}

// ---------------------------------------------------------------------------
process.stdout.write(`\n${'='.repeat(60)}\nПройдено: ${passed}, провалено: ${failures.length}\n`);
if (failures.length) {
  process.stdout.write('\nПровалившиеся проверки:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}\n`);
}
rmSync(WORK, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
