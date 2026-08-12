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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
section('Запросы — псевдоним источника, затеняющий колонку временной таблицы');

// Класс дефекта, который не ловится ничем до продуктива: текст запроса — строковый литерал,
// его не разбирает ни анализатор, ни валидаторы XML, ни сборка бинарника. Падает в рантайме
// сообщением «Неоднозначное поле».
const bsl = (name, body) => writeBytes(name, `Функция Т()\n\n\tЗапрос = Новый Запрос;\n\tЗапрос.Текст =\n\t"${body}";\n\n\tВозврат Запрос.Выполнить();\n\nКонецФункции\n`);

{
  // Канонический случай: колонка ВТ названа так же, как источник соседнего запроса пакета.
  const f = bsl('qry-shadow.bsl', [
    'ВЫБРАТЬ',
    '|	Перемещение.Ссылка КАК Перемещение',
    '|ПОМЕСТИТЬ ВТ_Связи',
    '|ИЗ',
    '|	Документ.ПеремещениеТоваров КАК Перемещение',
    '|;',
    '|',
    '|ВЫБРАТЬ',
    '|	Связи.Перемещение КАК Перемещение',
    '|ИЗ',
    '|	ВТ_Связи КАК Связи',
    '|		ВНУТРЕННЕЕ СОЕДИНЕНИЕ Документ.ПеремещениеТоваров КАК Перемещение',
    '|		ПО Связи.Перемещение = Перемещение.Ссылка',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('затенение колонки ВТ — находка', r.out.includes('QRY-ALIAS-SHADOWS-FIELD'), r.out.trim().slice(0, 140));
  check('затенение с разыменованием даёт код 2', r.code === 2, `код ${r.code}`);
  check('названы и псевдоним, и таблица', r.out.includes('«Перемещение»') && r.out.includes('ВТ_Связи'));
}
{
  // Колонка ВТ получает имя не только из КАК: `Связи.Перемещение` — тоже колонка
  // «Перемещение». Собирать одну форму значит не видеть половину коллизий.
  const f = bsl('qry-shadow-bare.bsl', [
    'ВЫБРАТЬ',
    '|	Связи.Перемещение',
    '|ПОМЕСТИТЬ ВТ_Связи',
    '|ИЗ',
    '|	РегистрСведений.Связи КАК Связи',
    '|;',
    '|',
    '|ВЫБРАТЬ',
    '|	Перемещение.Номер КАК Номер',
    '|ИЗ',
    '|	ВТ_Связи КАК Связи',
    '|		ВНУТРЕННЕЕ СОЕДИНЕНИЕ Документ.ПеремещениеТоваров КАК Перемещение',
    '|		ПО Связи.Перемещение = Перемещение.Ссылка',
  ].join('\n\t'));
  check('колонка без КАК тоже участвует', run('tools/query-lint.mjs', [f]).code === 2);
}
{
  // Теневое перекрытие в неголовной ветке ОБЪЕДИНИТЬ — дефект выполнения, в отличие от
  // отсутствия псевдонимов в той же ветке (см. блок про ложные срабатывания).
  const f = bsl('qry-shadow-union.bsl', [
    'ВЫБРАТЬ',
    '|	Расход.Регистратор КАК Регистратор',
    '|ПОМЕСТИТЬ ВТ_Движения',
    '|ИЗ',
    '|	РегистрНакопления.Расходы КАК Расход',
    '|;',
    '|',
    '|ВЫБРАТЬ',
    '|	Движения.Регистратор КАК Регистратор',
    '|ИЗ',
    '|	ВТ_Движения КАК Движения',
    '|',
    '|ОБЪЕДИНИТЬ ВСЕ',
    '|',
    '|ВЫБРАТЬ',
    '|	Регистратор.Ссылка',
    '|ИЗ',
    '|	ВТ_Движения КАК Движения',
    '|		ВНУТРЕННЕЕ СОЕДИНЕНИЕ Документ.РеализацияТоваровУслуг КАК Регистратор',
    '|		ПО Движения.Регистратор = Регистратор.Ссылка',
  ].join('\n\t'));
  check('перекрытие в ветке ОБЪЕДИНИТЬ найдено', run('tools/query-lint.mjs', [f]).code === 2);
}
{
  // Без обращения через точку запрос выполнится: имя заминировано, но ещё не подорвано.
  // Блокировать такое как ошибку значило бы требовать переименования в работающем коде.
  const f = bsl('qry-shadow-latent.bsl', [
    'ВЫБРАТЬ',
    '|	Док.Ссылка КАК Заказ',
    '|ПОМЕСТИТЬ ВТ_Заказы',
    '|ИЗ',
    '|	Документ.ЗаказКлиента КАК Док',
    '|;',
    '|',
    '|ВЫБРАТЬ',
    '|	Заказы.Заказ КАК Заказ',
    '|ИЗ',
    '|	ВТ_Заказы КАК Заказы',
    '|		ЛЕВОЕ СОЕДИНЕНИЕ Документ.ЗаказКлиента КАК Заказ',
    '|		ПО Заказы.Заказ = Заказ',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('коллизия без разыменования — предупреждение, не ошибка', r.code === 1, `код ${r.code}: ${r.out.trim().slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
section('Запросы — НЕ придирается к корректным (ложные срабатывания)');

{
  // `КАК` в ВЫРАЗИТЬ — приведение типа, а не псевдоним источника. Конструкция стоит в
  // условии соединения, то есть ровно там, где наивный поиск «имя после КАК» и промахнётся.
  const f = bsl('qry-cast.bsl', [
    'ВЫБРАТЬ',
    '|	Товары.Ссылка КАК Номенклатура',
    '|ПОМЕСТИТЬ ВТ_Товары',
    '|ИЗ',
    '|	Справочник.Номенклатура КАК Товары',
    '|;',
    '|',
    '|ВЫБРАТЬ',
    '|	ВЫРАЗИТЬ(Остатки.Регистратор КАК Документ.РеализацияТоваровУслуг).Дата КАК Дата',
    '|ИЗ',
    '|	РегистрНакопления.ОстаткиТоваров КАК Остатки',
    '|		ВНУТРЕННЕЕ СОЕДИНЕНИЕ ВТ_Товары КАК Товары',
    '|		ПО Остатки.Номенклатура = Товары.Номенклатура',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('приведение типа не считается псевдонимом', r.code === 0, r.out.trim().slice(0, 140));
}
{
  // Имена колонок объединения берутся из первой выборки — псевдонимы в последующих ветках не
  // нужны и их отсутствие дефектом не является. Проверка, ругающаяся на это, обучает
  // дописывать псевдонимы там, где они ничего не меняют.
  const f = bsl('qry-union-noalias.bsl', [
    'ВЫБРАТЬ',
    '|	Док.Ссылка КАК Ссылка,',
    '|	Док.Дата КАК Дата',
    '|ИЗ',
    '|	Документ.РеализацияТоваровУслуг КАК Док',
    '|',
    '|ОБЪЕДИНИТЬ ВСЕ',
    '|',
    '|ВЫБРАТЬ',
    '|	Ссылка,',
    '|	Дата',
    '|ИЗ',
    '|	Документ.ВозвратТоваровОтКлиента',
  ].join('\n\t'));
  check('ветка ОБЪЕДИНИТЬ без псевдонимов — молчание', run('tools/query-lint.mjs', [f]).code === 0);
}
{
  // Совпадение имён само по себе безвредно: если временная таблица в запросе не участвует,
  // разночтения не возникает.
  const f = bsl('qry-unused-temp.bsl', [
    'ВЫБРАТЬ',
    '|	Связи.Перемещение КАК Перемещение',
    '|ПОМЕСТИТЬ ВТ_Связи',
    '|ИЗ',
    '|	РегистрСведений.Связи КАК Связи',
    '|;',
    '|',
    '|ВЫБРАТЬ',
    '|	Перемещение.Номер КАК Номер',
    '|ИЗ',
    '|	Документ.ПеремещениеТоваров КАК Перемещение',
  ].join('\n\t'));
  check('незадействованная ВТ не порождает находку', run('tools/query-lint.mjs', [f]).code === 0);
}
{
  // Точка с запятой внутри литерала SDBL не разделяет пакет. Разорвись он здесь — колонки
  // временной таблицы потерялись бы, и настоящая коллизия во втором запросе исчезла бы из
  // вида: пропуск, замаскированный под чистый прогон.
  const f = bsl('qry-literal-semicolon.bsl', [
    'ВЫБРАТЬ',
    '|	Связи.Перемещение КАК Перемещение',
    '|ПОМЕСТИТЬ ВТ_Связи',
    '|ИЗ',
    '|	РегистрСведений.Связи КАК Связи',
    '|ГДЕ',
    '|	Связи.Комментарий = ""раз;два""',
    '|;',
    '|',
    '|ВЫБРАТЬ',
    '|	Перемещение.Номер КАК Номер',
    '|ИЗ',
    '|	ВТ_Связи КАК Связи',
    '|		ВНУТРЕННЕЕ СОЕДИНЕНИЕ Документ.ПеремещениеТоваров КАК Перемещение',
    '|		ПО Связи.Перемещение = Перемещение.Ссылка',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('литерал с «;» не рвёт пакет', r.code === 2, r.out.trim().slice(0, 120));
}
{
  const f = writeBytes('qry-none.bsl', 'Процедура Т()\n\tА = 1;\nКонецПроцедуры\n');
  const r = run('tools/query-lint.mjs', [f]);
  check('файл без запросов — чисто', r.code === 0);
  // Инструмент, промолчавший о том, что проверять было нечего, неотличим от прогнавшего проверку.
  check('отсутствие запросов заявлено записью следа', r.out.includes('[qg skipped: layer=code, scope=query-alias-shadowing, reason=not_applicable]'),
    r.out.trim().slice(0, 160));
}
{
  // Запись следа печатает инструмент, а принимает валидатор. Разъедься эти два места — строку
  // начнут сочинять руками, ровно как раньше сочиняли пороги настройки.
  const f = bsl('qry-evidence.bsl', [
    'ВЫБРАТЬ',
    '|	Товары.Ссылка КАК Номенклатура',
    '|ПОМЕСТИТЬ ВТ_Товары',
    '|ИЗ',
    '|	Справочник.Номенклатура КАК Товары',
  ].join('\n\t'));
  const printed = run('tools/query-lint.mjs', [f]).out.split('## quality evidence')[1]?.trim() || '';
  const report = writeBytes('ev-from-query-lint.md',
    '## quality evidence\n\n' +
    '[qg scope: volume=C2, files=1, archetypes=[query], driver=archetype:query, resolved=code:L2, config=default]\n' +
    '[qg sentinel: target=v8std, id=std454, status=found]\n' +
    printed + '\n' +
    '[qg not_verified: dimension=compilation, reason=no_platform]\n' +
    '[qg not_verified: dimension=query-execution, reason=no_platform]\n');
  const r = run('tools/evidence-validator.mjs', [report, '--gate']);
  check('запись следа из query-lint проходит валидатор', r.code === 0, `${printed} → ${r.out.trim().slice(0, 140)}`);
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
section('Валидаторы XML — контракт вызова');

// Десять валидаторов в tools/xml/ портированы из cc-1c-skills и до сих пор проверялись
// только через роль — да и та попала под тест как побочный эффект починки ложной ошибки
// версии 0.4.3. Между тем контур xml опирается на них целиком, а SKILL.md обещает
// пользователю единый способ вызова. Обещание, которое никто не проверяет, живёт до
// первого обновления порта.
const PY_VALIDATORS = ['cf', 'cfe', 'epf', 'form', 'interface', 'meta', 'mxl', 'role', 'skd', 'subsystem'];
const pyTool = (name) => join(ROOT, 'tools', 'xml', `${name}-validate.py`);

/** Запускает python-валидатор, возвращает код возврата и объединённый вывод. */
function runPy(script, args) {
  try {
    const out = execFileSync('python', [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// Доступность определяется ОДИН раз и в одном месте. Иначе каждый блок вынес бы свой
// вердикт: десять одинаковых провалов вместо одного внятного — или, того хуже, guard
// остался бы только у первого блока, и остальные молча пропускались бы в CI.
const python = (() => {
  try {
    execFileSync('python', ['-c', 'import lxml.etree'], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    // Нет интерпретатора и нет зависимости — разные диагнозы: во втором случае python
    // отвечает кодом 1, а причина видна только в тексте traceback.
    const missing = /ENOENT/.test(String(e.code || e.message));
    return { ok: false, reason: missing ? 'python недоступен' : 'библиотека lxml недоступна' };
  }
})();

if (!python.ok) {
  // В CI пропуск запрещён: зелёный прогон без проверки неотличим от проверенного.
  // Это же ловит удаление шага установки зависимостей из workflow.
  if (process.env.CI) {
    check('валидаторы XML прогнаны', false, `${python.reason} — в CI зависимости валидаторов обязаны быть установлены`);
  } else {
    process.stdout.write(`  (пропуск валидаторов XML: ${python.reason})\n`);
  }
}

if (python.ok) {
  // SKILL.md обещает: «-Path принимается всеми валидаторами без исключения». У каждого
  // скрипта своё второе имя параметра (-ObjectPath, -FormPath, -RightsPath…), а
  // allow_abbrev=False превращает промах в отказ разбора аргументов. Проверено это было
  // ровно для одного валидатора из десяти.
  for (const name of PY_VALIDATORS) {
    const r = runPy(pyTool(name), ['-Path', join(WORK, 'нет-такого-файла.xml')]);
    check(`${name}: принимает -Path`, !/unrecognized arguments|error: the following arguments/.test(r.out), r.out.trim().slice(0, 100));
    // Отсутствующий файл — штатная ситуация, а не сбой инструмента. Traceback здесь читается
    // как находка в проверяемом XML: та же подмена, что дал ModuleNotFoundError без lxml.
    check(`${name}: отсутствующий путь назван, а не свален в traceback`,
      /not found|не найден/i.test(r.out) && !/Traceback/.test(r.out), r.out.trim().slice(0, 100));
  }

  // Пара на каждый валидатор: заведомо корректный файл обязан пройти чисто, заведомо
  // дефектный — дать именно ту ошибку, ради которой фикстура написана. Проверка «нашёл
  // хоть что-то» бесполезна: она зелёная и когда валидатор ругается не на то.
  //
  // Половина про «корректный» — якорь регрессии, а не независимая истина: фикстуры
  // доводились до Validation OK по выводу самих валидаторов. Ценность в том, что молчание
  // зафиксировано: после правки порта ложная находка на исправном файле станет видна.
  // Дефекты во всех фикстурах — well-formed XML, нарушающий правило 1С, а не битая разметка:
  // сломанный XML проверял бы парсер lxml, а не валидатор.
  const xml = (...parts) => join(FIXTURES, 'xml', ...parts);
  const VALIDATOR_CASES = [
    ['cf', xml('cf', 'valid'), xml('cf', 'broken'), 'DefaultLanguage "Language.Английский" not found', 'язык по умолчанию не зарегистрирован в составе'],
    ['cfe', xml('cfe', 'valid'), xml('cfe', 'broken'), "ObjectBelonging must be 'Adopted'", 'объект расширения не помечен заимствованным'],
    ['epf', xml('epf', 'valid'), xml('epf', 'broken'), "expected 'c3831ec8-d8d5-4f93-8a22-f9bfae07327f'", 'ClassId отчёта в обработке'],
    ['form', xml('form', 'valid.xml'), xml('form', 'broken.xml'), "attribute 'НетТакогоРеквизита' not found", 'поле связано с несуществующим реквизитом'],
    ['interface', xml('interface', 'valid.xml'), xml('interface', 'broken.xml'), 'Section order', 'секции командного интерфейса переставлены'],
    ['meta', xml('meta', 'valid.xml'), xml('meta', 'broken.xml'), 'Type block has no v8:Type', 'тип реквизита задан скаляром'],
    ['mxl', xml('mxl', 'valid.xml'), xml('mxl', 'broken.xml'), 'height=1 but max row index=1', 'высота макета меньше числа строк'],
    ['role', join(FIXTURES, 'role-min', 'Roles', 'QG_ТестоваяРоль'), xml('role', 'QG_БитаяРоль'), "right 'ThinClient' has invalid value", 'право без значения'],
    ['skd', xml('skd', 'valid.xml'), xml('skd', 'broken.xml'), 'references unknown dataSource', 'набор данных ссылается на несуществующий источник'],
    ['subsystem', xml('subsystem', 'valid.xml'), xml('subsystem', 'broken.xml'), 'invalid format (expected Type.Name or UUID)', 'ссылка в составе не разрешается'],
  ];
  for (const [name, validPath, brokenPath, marker, defect] of VALIDATOR_CASES) {
    const good = runPy(pyTool(name), ['-Path', validPath]);
    check(`${name}: корректный файл проходит чисто`, good.code === 0 && /Validation OK/.test(good.out), good.out.trim().slice(0, 110));
    const bad = runPy(pyTool(name), ['-Path', brokenPath]);
    check(`${name}: найден дефект — ${defect}`, bad.code === 1 && bad.out.includes(marker), bad.out.trim().slice(0, 110));
  }

  // Валидатор роли проверяет Rights.xml, а путь ему дают тремя разными способами. Раньше файл
  // метаданных роли разбирался как Rights.xml и давал ЛОЖНУЮ ошибку при меньшем числе проверок:
  // не отказ, а находка, которой нет в чужом коде. Три формы обязаны давать один результат.
  const roleDir = join(FIXTURES, 'role-min', 'Roles', 'QG_ТестоваяРоль');
  const forms = [`${roleDir}.xml`, roleDir, join(roleDir, 'Ext', 'Rights.xml')];
  const outs = forms.map((p) => runPy(pyTool('role'), ['-Path', p]).out);
  const counts = outs.map((o) => (o.match(/\((\d+) checks\)/) || [])[1]);
  check('все три формы пути к роли дают один результат', new Set(counts).size === 1 && counts[0], counts.join(' / '));
  check('роль признана валидной', outs.every((o) => o.includes('Validation OK')), outs[0].trim().slice(0, 100));

  // Право точки вызова сервиса — Use. Валидатор разбирал такой путь как вложенный реквизит и
  // требовал View/Edit, то есть выдавал находку на единственно верной форме записи прав.
  // Модель прав по типам объектов — skills/xml-structure-review/references/role-rights-model.md.
  const endpoint = runPy(pyTool('role'), ['-Path', join(FIXTURES, 'xml', 'role', 'QG_РольТочекСервиса')]);
  check('право Use у метода сервиса и операции веб-сервиса проходит чисто',
    endpoint.code === 0 && /Validation OK/.test(endpoint.out), endpoint.out.trim().slice(0, 140));

  // У перечисления объектных прав не существует. Дефект — сама запись в роли, а не «неизвестный
  // тип»: вторая формулировка читается как пробел валидатора и провоцирует искать способ выдать
  // право, которого нет в модели прав платформы.
  const rightless = runPy(pyTool('role'), ['-Path', join(FIXTURES, 'xml', 'role', 'QG_РольПравПеречисления')]);
  check('право на перечисление названо несуществующим, а не неизвестным типом',
    rightless.out.includes('has no object rights'), rightless.out.trim().slice(0, 140));
}

// ---------------------------------------------------------------------------
section('Валидатор следа — отвергает недобросовестный прогон');

const ev = (name) => join(FIXTURES, 'evidence', name);

// Отметка о настройке в следе сверяется с фактической настройкой проекта, поэтому фикстуре с
// переопределёнными порогами нужен проект, к которому она относится.
const CUSTOM_PROJ = join(WORK, 'ev-custom-proj');
mkdirSync(CUSTOM_PROJ, { recursive: true });
writeFileSync(
  join(CUSTOM_PROJ, '.1c-quality-gate.json'),
  JSON.stringify({ volume: { c1MaxLines: 15 }, sentinel: { id: 'std783' } }),
  'utf8'
);
const customProj = { env: { CLAUDE_PROJECT_DIR: CUSTOM_PROJ } };
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
  const r = run('tools/evidence-validator.mjs', [ev('multiline-scope.md'), '--gate'], customProj);
  check('многострочная запись scope разбирается', r.code === 0, r.out.trim().slice(0, 120));
}

// Отметка о настройке проекта. Без неё «C1» из одного отчёта не означает того же, что «C1»
// из другого, а прогон, не заглянувший в настройку, неотличим от учтившего её.
{
  const body =
    '[qg sentinel: target=v8std, id=std454, status=found]\n' +
    '[qg applied: layer=hygiene, scope=file-encoding, ids=[qg:HYG-BOM], verdict=clean]\n' +
    '[qg not_verified: dimension=compilation, reason=no_platform]\n';
  const scoped = (extra) =>
    `## quality evidence\n\n[qg scope: volume=C1, files=1, archetypes=[none], driver=volume, resolved=code:L1${extra}]\n`;

  const without = writeBytes('ev-no-config.md', scoped('') + body);
  const gated = run('tools/evidence-validator.mjs', [without, '--gate']);
  check('снятие гейта без отметки о настройке запрещено', gated.code === 2 && gated.out.includes('config'), gated.out.trim().slice(0, 140));

  // Отчёты, собранные до появления поля, читать и линтовать по-прежнему можно.
  const linted = run('tools/evidence-validator.mjs', [without]);
  check('в нестрогом режиме отсутствие отметки — предупреждение', linted.code === 1, linted.out.trim().slice(0, 140));

  const bogus = writeBytes('ev-bad-config.md', scoped(', config=custom:вымысел') + body);
  const rb = run('tools/evidence-validator.mjs', [bogus, '--gate']);
  check('выдуманная секция настройки отвергается', rb.code === 2 && rb.out.includes('config='), rb.out.trim().slice(0, 140));

  const good = writeBytes('ev-custom-config.md', scoped(', config=custom:volume+sentinel') + body);
  const rg = run('tools/evidence-validator.mjs', [good, '--gate'], customProj);
  check('перечень переопределённых секций принимается', rg.code === 0, rg.out.trim().slice(0, 140));

  // Отметка не принимается на слово. Приписать «пороги умолчаний» в проекте, где они задраны,
  // не сложнее, чем забыть посмотреть настройку, — и последствия те же.
  const lie = run('tools/evidence-validator.mjs', [ev('valid.md'), '--gate'], customProj);
  check('заявленный default в проекте с переопределениями отвергнут', lie.code === 2 && lie.out.includes('расходится'), lie.out.trim().slice(0, 160));

  const stale = writeBytes('ev-stale-config.md', scoped(', config=custom:volume') + body);
  const rs = run('tools/evidence-validator.mjs', [stale, '--gate'], customProj);
  check('усечённый перечень секций отвергнут', rs.code === 2 && rs.out.includes('расходится'), rs.out.trim().slice(0, 160));
}

// Исполнение запроса. Текст запроса — строковый литерал: его не разбирает ни анализатор, ни
// сборка бинарника, и ошибка вроде «Неоднозначное поле» доживает до первого выполнения.
// Прогон вправе запрос не выполнять, но не вправе об этом промолчать.
{
  const head = (archetypes) =>
    '## quality evidence\n\n' +
    `[qg scope: volume=C2, files=1, archetypes=[${archetypes}], driver=archetype:query, resolved=code:L2, config=default]\n` +
    '[qg sentinel: target=v8std, id=std454, status=found]\n';
  const compilation = '[qg not_verified: dimension=compilation, reason=no_platform]\n';
  const violation = '[qg applied: layer=code, scope=query-in-loop, ids=[std436], verdict=violation:std436]\n';

  const silent = writeBytes('ev-query-silent.md', head('query') + violation + compilation);
  const rSilent = run('tools/evidence-validator.mjs', [silent, '--gate']);
  check('архетип query без отчёта об исполнении — отклонён', rSilent.code === 2 && rSilent.out.includes('query-execution'),
    rSilent.out.trim().slice(0, 160));

  // В нестрогом режиме — предупреждение: отчёты, собранные до появления правила, читаются.
  const rLint = run('tools/evidence-validator.mjs', [silent]);
  check('в нестрогом режиме молчание об исполнении — предупреждение', rLint.code === 1, rLint.out.trim().slice(0, 140));

  const declared = writeBytes('ev-query-declared.md',
    head('query') + violation + compilation + '[qg not_verified: dimension=query-execution, reason=no_platform]\n');
  check('заявленная непроверяемость исполнения принимается',
    run('tools/evidence-validator.mjs', [declared, '--gate']).code === 0);

  const executed = writeBytes('ev-query-executed.md',
    head('query') + violation + compilation +
    '[qg applied: layer=code, scope=query-execution, ids=[qg:QRY-EXECUTED], verdict=clean]\n');
  check('фактическое исполнение запроса закрывает требование',
    run('tools/evidence-validator.mjs', [executed, '--gate']).code === 0);

  // Требование адресное: без архетипа query отчитываться об исполнении не с чего.
  const noQuery = writeBytes('ev-no-query.md', head('transaction') + violation + compilation);
  check('без архетипа query требование не предъявляется',
    run('tools/evidence-validator.mjs', [noQuery, '--gate']).code === 0);

  // Второе измерение не должно ослаблять первое: заявить непроверяемым исполнение запроса и
  // промолчать о компилируемости — снова полностью зелёный отчёт, который проходит.
  const masked = writeBytes('ev-dimension-masking.md',
    head('query') +
    '[qg applied: layer=code, scope=query-alias-shadowing, ids=[qg:QRY-ALIAS-SHADOWS-FIELD], verdict=clean]\n' +
    '[qg not_verified: dimension=query-execution, reason=no_platform]\n');
  const rMasked = run('tools/evidence-validator.mjs', [masked, '--gate']);
  check('чужое измерение не закрывает компилируемость', rMasked.code === 2 && rMasked.out.includes('compilation'),
    rMasked.out.trim().slice(0, 160));

  // Опечатка в имени измерения оставляет запись, которая выглядит заполненной.
  const typo = writeBytes('ev-dimension-typo.md',
    head('query') + violation + compilation + '[qg not_verified: dimension=query_execution, reason=no_platform]\n');
  const rTypo = run('tools/evidence-validator.mjs', [typo]);
  check('незнакомое измерение названо', rTypo.out.includes('query_execution'), rTypo.out.trim().slice(0, 160));

  // Метка архетипа — единственное поле, от которого зависит требование и которое пишет
  // модель, а не инструмент. Опечатка не давала бы ни ошибки, ни находки: правило просто не
  // предъявлялось бы, и гейт снимался на полном молчании.
  const typoArch = writeBytes('ev-archetype-typo.md',
    '## quality evidence\n\n' +
    '[qg scope: volume=C2, files=1, archetypes=[queries], driver=archetype:queries, resolved=code:L2, config=default]\n' +
    '[qg sentinel: target=v8std, id=std454, status=found]\n' + violation + compilation);
  const rArch = run('tools/evidence-validator.mjs', [typoArch, '--gate']);
  check('незнакомая метка архетипа не пропускается', rArch.code === 2 && rArch.out.includes('queries'), rArch.out.trim().slice(0, 160));

  // Проектный архетип — законная метка: иначе `archetypes.custom` пришлось бы выбирать между
  // работающей настройкой и проходящим следом.
  const archProj = join(WORK, 'ev-archetype-proj');
  mkdirSync(archProj, { recursive: true });
  writeFileSync(join(archProj, '.1c-quality-gate.json'),
    JSON.stringify({ archetypes: { custom: [{ name: 'exchange', markers: ['ПланОбмена'], minCode: 'L2' }] } }), 'utf8');
  const customArch = writeBytes('ev-archetype-custom.md',
    '## quality evidence\n\n' +
    '[qg scope: volume=C2, files=1, archetypes=[exchange], driver=archetype:exchange, resolved=code:L2, config=custom:archetypes]\n' +
    '[qg sentinel: target=v8std, id=std454, status=found]\n' + violation + compilation);
  const rCustom = run('tools/evidence-validator.mjs', [customArch, '--gate'], { env: { CLAUDE_PROJECT_DIR: archProj } });
  check('проектный архетип принимается как метка', rCustom.code === 0, rCustom.out.trim().slice(0, 160));

  // Список меток в валидаторе и таблица архетипов в навыке обязаны сходиться: разъедься они —
  // модель пишет метку из таблицы, а валидатор её отвергает.
  const skill = readFileSync(join(ROOT, 'skills/quality-gate/SKILL.md'), 'utf8');
  const validatorSrc = readFileSync(join(ROOT, 'tools', 'evidence-validator.mjs'), 'utf8');
  const tableLabels = [...skill.matchAll(/^\|[^|]+\|\s*`([a-z][a-z-]*)`\s*\|/gm)].map((m) => m[1]);
  const validatorLabels = ((validatorSrc.match(/const ARCHETYPES = \[([^\]]+)\]/s) || [, ''])[1].match(/'([^']+)'/g) || [])
    .map((s) => s.slice(1, -1));
  check('таблица архетипов даёт хотя бы десять меток', tableLabels.length >= 10, `${tableLabels.length}`);
  check('метки навыка и валидатора совпадают',
    tableLabels.every((l) => validatorLabels.includes(l)) && validatorLabels.filter((l) => l !== 'none').every((l) => tableLabels.includes(l)),
    `навык: ${tableLabels.join(',')} | валидатор: ${validatorLabels.join(',')}`);

  // Закрытый список измерений и инструменты, которые их печатают, обязаны сходиться. Иначе
  // валидатор ругается на собственный вывод плагина, и предупреждению перестают верить.
  const printed = new Set();
  for (const tool of ['tools/analyzer-run.mjs', 'tools/query-lint.mjs', 'tools/hygiene-check.mjs', 'tools/gate.mjs']) {
    const src = readFileSync(join(ROOT, tool), 'utf8');
    for (const m of src.matchAll(/not_verified:\s*dimension=([\w-]+)/g)) printed.add(m[1]);
  }
  const known = (validatorSrc.match(/const DIMENSIONS = \[([^\]]+)\]/) || [, ''])[1];
  const unknown = [...printed].filter((d) => !known.includes(`'${d}'`));
  check('валидатор знает все измерения, которые печатают инструменты', unknown.length === 0, unknown.join(', '));
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
section('Переиспользование доказательств и формат вывода хука');

{
  const proj = join(WORK, 'verify-proj');
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(join(proj, 'src', 'cf', 'CommonModules', 'V', 'Ext'), { recursive: true });
  const env = { CLAUDE_PROJECT_DIR: proj };
  const rel = 'src/cf/CommonModules/V/Ext/Module.bsl';
  const file = join(proj, ...rel.split('/'));

  const arm = () => {
    try {
      return execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], {
        input: JSON.stringify({ session_id: 'V1', cwd: proj, tool_input: { file_path: file } }),
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    } catch {
      return '';
    }
  };
  const readState = () => {
    const p = join(proj, '.claude', '.state', 'qg-pending.json');
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Object.values(j.sessions?.V1?.files || {})[0] || null;
  };

  // Простой текст из PostToolUse до модели не доходит — нужен JSON с hookSpecificOutput.
  const out = arm();
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    /* останется null */
  }
  check('хук взвода отдаёт валидный JSON', parsed !== null, out.slice(0, 60));
  check('в JSON есть additionalContext', Boolean(parsed?.hookSpecificOutput?.additionalContext));
  check('hookEventName корректен', parsed?.hookSpecificOutput?.hookEventName === 'PostToolUse');

  const v = run('tools/gate.mjs', ['verify', '--layer', 'code', rel, '--session', 'V1'], { env });
  check('verify отмечает файл проверенным', v.code === 0, v.out.trim().slice(0, 80));
  check('отметка записана в состояние', Boolean(readState()?.verified?.code));

  arm();
  check('правка снимает отметку (инвалидация)', !readState()?.verified, JSON.stringify(readState()?.verified));
  check('счётчик правок растёт', readState()?.edits === 2);

  const vBad = run('tools/gate.mjs', ['verify', '--layer', 'code', 'нет-такого-файла.bsl', '--session', 'V1'], { env });
  check('verify по чужому файлу не отмечает', vBad.code === 1);
}

// ---------------------------------------------------------------------------
section('Проектная настройка — создание, разрешение, приоритет');

{
  const config = await import(pathToFileURL(join(ROOT, 'tools', 'config.mjs')).href);
  const proj = join(WORK, 'cfg-proj');
  const reset = () => {
    rmSync(proj, { recursive: true, force: true });
    mkdirSync(proj, { recursive: true });
  };
  const file = join(proj, config.CONFIG_FILE);
  const write = (obj) => writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');

  // --- создание -------------------------------------------------------------
  reset();
  const first = config.ensureConfig(proj);
  check('настройка создаётся сама', first.created === true && existsSync(file));
  check('созданный файл — валидный JSON', (() => {
    try { JSON.parse(readFileSync(file, 'utf8')); return true; } catch { return false; }
  })());

  // Ключевой случай: чужие значения не должны исчезнуть. Настройка, которую плагин способен
  // переписать, хуже отсутствующей — правку в неё делают один раз.
  //
  // Проверяется на ЧИСТОМ проекте, без маркера создания: именно так выглядит свежий клон
  // репозитория, где настройку закоммитил коллега. Маркер лежит в .claude/.state и в клон не
  // попадает, поэтому проверка «файл существует» здесь единственная защита.
  reset();
  write({ volume: { c1MaxLines: 999 } });
  const before = readFileSync(file, 'utf8');
  const second = config.ensureConfig(proj);
  check(
    'чужой файл настройки не перезаписывается',
    second.created === false && second.reason === 'exists' && readFileSync(file, 'utf8') === before
  );

  // И то же самое после собственного создания — здесь дополнительно работает маркер.
  reset();
  config.ensureConfig(proj);
  write({ volume: { c1MaxLines: 777 } });
  const beforeOwn = readFileSync(file, 'utf8');
  check('созданный файл не перезаписывается на следующем взводе',
    config.ensureConfig(proj).created === false && readFileSync(file, 'utf8') === beforeOwn);

  // Удаление — отказ от настройки, а не просьба заводить её заново на каждой правке.
  rmSync(file, { force: true });
  const third = config.ensureConfig(proj);
  check('удалённая настройка повторно не создаётся', third.created === false && third.reason === 'declined' && !existsSync(file));

  // --- разрешение значений --------------------------------------------------
  reset();
  const bare = config.resolve(proj, {});
  check('без файла действуют умолчания', bare.values.volume.c1MaxLines === 40 && bare.sources.volume.c1MaxLines === 'умолчание');
  check('умолчание часового — std454', bare.values.sentinel.id === 'std454');

  // Шаблон намеренно не проставляет значения: иначе умолчание закрепляется навсегда и
  // обновление плагина до такого проекта не доезжает.
  write(config.template());
  const fromTemplate = config.resolve(proj, {});
  check('созданный файл ничего не закрепляет', JSON.stringify(fromTemplate.values) === JSON.stringify(bare.values));
  // И это должно быть видно: значение, пришедшее «из файла», читается как решение проекта,
  // даже если совпало с умолчанием.
  check('в созданном файле всё числится умолчанием',
    Object.values(fromTemplate.sources).every((s) => Object.values(s).every((v) => v === 'умолчание')),
    JSON.stringify(fromTemplate.sources));
  check('ключи-комментарии не доходят до потребителя', !JSON.stringify(fromTemplate.values).includes('//'));
  check('комментарии снимаются на любой глубине', JSON.stringify(config.stripDocs({ a: { '//': 'x', b: [{ '//': 'y', c: 1 }] } })) === '{"a":{"b":[{"c":1}]}}');

  // Отсутствующая, пустая и явно пустая секции — одно и то же.
  write({});
  const empty1 = config.resolve(proj, {}).values;
  write({ archetypes: {} });
  const empty2 = config.resolve(proj, {}).values;
  write({ archetypes: { custom: [] } });
  const empty3 = config.resolve(proj, {}).values;
  check('пустая секция равна отсутствующей', JSON.stringify(empty1) === JSON.stringify(empty2) && JSON.stringify(empty2) === JSON.stringify(empty3));

  write({ volume: { c1MaxLines: 5 }, sentinel: { id: 'std777' }, archetypes: { custom: [{ name: 'exchange', markers: ['ПланОбмена'], minCode: 'L2' }] } });
  const fromFile = config.resolve(proj, {});
  check('порог из файла применён', fromFile.values.volume.c1MaxLines === 5 && fromFile.sources.volume.c1MaxLines === 'файл');
  check('номер часового из файла применён', fromFile.values.sentinel.id === 'std777');
  check('проектный архетип прочитан', fromFile.values.archetypes.custom[0]?.name === 'exchange');
  check('незаданный ключ остался умолчанием', fromFile.values.volume.c1MaxFiles === 1 && fromFile.sources.volume.c1MaxFiles === 'умолчание');

  write({ analyzer: { engine: 'bsl-ls', required: true } });
  const withEnv = config.resolve(proj, { QG_ANALYZER_ENGINE: 'bsl-analyzer' });
  check('окружение перекрывает файл', withEnv.values.analyzer.engine === 'bsl-analyzer' && withEnv.sources.analyzer.engine === 'окружение');
  check('неперекрытое значение файла остаётся', withEnv.values.analyzer.required === true);

  // --- ошибки в файле -------------------------------------------------------
  write('{ это не json');
  const broken = config.resolve(proj, {});
  check('повреждённый файл не роняет разбор', broken.values.volume.c1MaxLines === 40 && Boolean(broken.broken));

  write({ volume: { c1MaxLine: 10 }, вулюм: {} });
  const unknown = config.resolve(proj, {});
  check('опечатка в ключе названа, а не проглочена', unknown.unknown.includes('volume.c1MaxLine') && unknown.unknown.includes('вулюм'));
  check('неизвестный ключ не применяется', unknown.values.volume.c1MaxLines === 40);

  // --- вывод для человека и для модели --------------------------------------
  write({ volume: { c1MaxLines: 7 } });
  const show = run('tools/config.mjs', ['show'], { env: { CLAUDE_PROJECT_DIR: proj } });
  check('show печатает значение и источник', show.code === 0 && /volume\.c1MaxLines\s+7\s+файл/.test(show.out), show.out.trim().slice(0, 160));
  const showJson = run('tools/config.mjs', ['show', '--json'], { env: { CLAUDE_PROJECT_DIR: proj } });
  let parsedShow = null;
  try { parsedShow = JSON.parse(showJson.out); } catch { /* останется null */ }
  check('show --json машиночитаем', parsedShow?.values?.volume?.c1MaxLines === 7);

  // --- контур анализатора читает ту же настройку ----------------------------
  const analyzerCfg = await import(pathToFileURL(join(ROOT, 'tools', 'analyzer-run.mjs')).href);
  write({ analyzer: { required: true } });
  // Окружение передаётся явно: иначе экспортированная в оболочке разработчика переменная
  // QG_ANALYZER_* меняет результат теста — ровно та зависимость от машины, из-за которой
  // прогон бывает зелёным локально и красным в CI.
  check('контур анализатора читает общий разрешитель', analyzerCfg.readAnalyzerConfig(proj, {}).required === true);

  // --- отметка о настройке в следе прогона ----------------------------------
  // Строку печатает инструмент, а валидатор её принимает. Разъедься эти два места — поле
  // начнут сочинять по памяти, ровно как раньше сочиняли пороги.
  write({ volume: { c1MaxLines: 15 }, sentinel: { id: 'std783' } });
  const overridden = config.resolve(proj, {});
  check('строка следа перечисляет переопределённые секции', config.evidenceField(overridden) === 'config=custom:volume+sentinel', config.evidenceField(overridden));
  check('без переопределений строка следа — default', config.evidenceField(config.resolve(join(WORK, 'нет-такого-проекта'), {})) === 'config=default');
  const showEv = run('tools/config.mjs', ['show'], { env: { CLAUDE_PROJECT_DIR: proj } });
  check('show печатает готовую строку следа', showEv.out.includes('config=custom:volume+sentinel'), showEv.out.trim().slice(-140));

  const pasted = writeBytes(
    'ev-from-config-tool.md',
    `## quality evidence\n\n[qg scope: volume=C1, files=1, archetypes=[none], driver=volume, resolved=code:L1, ${config.evidenceField(overridden)}]\n` +
      '[qg sentinel: target=v8std, id=std454, status=found]\n' +
      '[qg applied: layer=hygiene, scope=file-encoding, ids=[qg:HYG-BOM], verdict=clean]\n' +
      '[qg not_verified: dimension=compilation, reason=no_platform]\n'
  );
  const pastedR = run('tools/evidence-validator.mjs', [pasted, '--gate'], { env: { CLAUDE_PROJECT_DIR: proj } });
  check('напечатанная инструментом строка проходит валидатор', pastedR.code === 0, pastedR.out.trim().slice(0, 140));

  // --- создание при взводе гейта --------------------------------------------
  const armProj = join(WORK, 'cfg-arm');
  rmSync(armProj, { recursive: true, force: true });
  mkdirSync(join(armProj, 'src', 'cf', 'CommonModules', 'К', 'Ext'), { recursive: true });
  const armFile = join(armProj, 'src', 'cf', 'CommonModules', 'К', 'Ext', 'Module.bsl');
  const armOut = (() => {
    try {
      return execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], {
        input: JSON.stringify({ session_id: 'CFG', cwd: armProj, tool_input: { file_path: armFile } }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: armProj },
      });
    } catch {
      return '';
    }
  })();
  check('первый взвод создаёт настройку', existsSync(join(armProj, config.CONFIG_FILE)));
  // Файл, о котором не сказали, для пользователя не существует. Каналов два, и оба нужны:
  // additionalContext доходит до модели, systemMessage — до человека.
  let armParsed = null;
  try { armParsed = JSON.parse(armOut); } catch { /* останется null */ }
  check('создание объявлено модели', String(armParsed?.hookSpecificOutput?.additionalContext).includes(config.CONFIG_FILE), armOut.slice(0, 200));
  check('создание объявлено пользователю', String(armParsed?.systemMessage).includes(config.CONFIG_FILE), armOut.slice(0, 200));

  const armOut2 = (() => {
    try {
      return execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], {
        input: JSON.stringify({ session_id: 'CFG', cwd: armProj, tool_input: { file_path: armFile } }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: armProj },
      });
    } catch {
      return '';
    }
  })();
  check('на следующих правках о настройке не напоминают', !armOut2.includes(config.CONFIG_FILE), armOut2.slice(0, 200));
}

// ---------------------------------------------------------------------------
section('Полнота правил (контуры code и arch выполняет модель — проверяем, что правила на месте)');

const mustContain = [
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'Запрос в цикле', 'антипаттерн «запрос в цикле»'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-01', 'запись набора с неполным отбором'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-04', 'отчёт о непрогнанной проверке'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-05', 'зелёная сборка вместо компиляции'],
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'Коррелированный подзапрос', 'коррелированный подзапрос в условии'],
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'ИНДЕКСИРОВАТЬ ПО', 'временная таблица без индекса'],
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'СообщитьПользователю', 'Сообщить() как уведомление'],
  ['skills/quality-gate/references/adversarial-audit.md', 'опроверг', 'состязательный аудит: обратная постановка'],
  ['skills/bsl-architecture-review/references/ai-antipatterns-arch.md', 'ARCH-AI-05', 'параллельная коллекция вместо поля'],
  ['skills/xml-structure-review/SKILL.md', 'ChildObjects', 'проверка регистрации в составе'],
  ['shared/routing-contract.md', 'радиус', 'граница контуров по радиусу правки'],
  ['skills/bsl-code-review/SKILL.md', 'НЕ РАЗОБРАНО', 'неразобранные файлы называются явно'],
  ['skills/xml-structure-review/SKILL.md', '-Path', 'универсальное имя параметра валидаторов XML'],
  ['skills/xml-structure-review/SKILL.md', 'reason=lxml_unavailable', 'падение валидатора без lxml — не находка в XML'],
  // Контр-сигналы прав и семантика заимствования: без них контур выпускает находки на файлах,
  // где «дефект» — свойство модели прав платформы, а не упущение автора.
  ['skills/xml-structure-review/references/role-rights-model.md', 'URLTemplate', 'право Use выдаётся точке вызова сервиса'],
  ['skills/xml-structure-review/references/role-rights-model.md', 'ScheduledJob', 'типы без объектных прав названы'],
  ['skills/xml-structure-review/references/cfe-object-belonging.md', 'ObjectBelonging', 'принадлежность элемента расширения задана отсутствием тега'],
  ['skills/xml-structure-review/SKILL.md', 'role-rights-model.md', 'контур ссылается на модель прав'],
  ['skills/xml-structure-review/SKILL.md', 'cfe-object-belonging.md', 'контур ссылается на семантику заимствования'],
  // Дефект, проходящий валидацию: «OK» валидатора здесь не вердикт о работоспособности.
  ['skills/xml-structure-review/SKILL.md', 'AutoCommandBar', 'зависание загрузки на командной панели таблицы'],
  ['skills/bsl-code-review/references/checklist-code.md', '#std659', 'избыточные блокировки'],
  ['skills/bsl-code-review/references/checklist-code.md', '#std661', 'блокирующее чтение остатков в начале транзакции'],
  ['skills/bsl-code-review/references/checklist-code.md', '#std450', 'порядок записи движений'],
  ['skills/bsl-code-review/references/checklist-code.md', '#std748', 'таймаут при обращении к внешнему ресурсу'],
  // #std415: РАЗРЕШЕННЫЕ отбрасывает недоступные строки молча. В расчётном или проводящем
  // запросе это меняет результат в зависимости от прав пользователя, а справка контура до
  // этой правки советовала применять ключевое слово по умолчанию — ровно то, что запрещает
  // стандарт, на который контур же и ссылается.
  ['skills/bsl-code-review/references/bsl-query-optimization.md', '#std415', 'ограничение на РАЗРЕШЕННЫЕ разобрано'],
  ['skills/bsl-code-review/references/bsl-query-optimization.md', 'Контр-сигнал', 'у ограничения на РАЗРЕШЕННЫЕ есть законная форма'],
  ['skills/bsl-code-review/references/checklist-code.md', '#std415', 'РАЗРЕШЕННЫЕ в расчётном запросе — пункт чеклиста'],
  ['skills/bsl-code-review/references/bsl-query-reference.md', '#std415', 'справочник языка называет ограничение применимости'],
  // Имя реквизита формы в области видимости модуля: присваивание пишет реквизит, а не
  // заводит локальную переменную. Ошибка молчит и всплывает в другом методе, поэтому важны
  // обе половины — механизм и контр-сигнал про методы без контекста формы.
  ['skills/bsl-code-review/references/bsl-form-module-rules.md', 'Локальная переменная с именем реквизита формы', 'коллизия имени с реквизитом формы разобрана'],
  ['skills/bsl-code-review/references/bsl-form-module-rules.md', '&НаКлиентеНаСервереБезКонтекста`)', 'методы без контекста формы названы контр-сигналом'],
  ['skills/bsl-code-review/references/bsl-form-module-rules.md', 'непроверенный', 'без состава реквизитов признак не выпускается'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'ЗаполнитьЗначенияСвойств(Приёмник', 'копия структуры не делается заполнением свойств'],
  // Настройка, которую никто не читает, неотличима от «правило не сработало»: у каждой оси
  // должно быть место в навыке, где сказано, откуда берётся её порог.
  ['skills/quality-gate/SKILL.md', 'tools/config.mjs" show', 'пороги берутся из проектной настройки, а не по памяти'],
  ['skills/quality-gate/SKILL.md', 'sentinel.id', 'номер часового задаётся проектом'],
  ['skills/quality-gate/SKILL.md', 'archetypes.custom', 'архетипы проекта участвуют в выборе глубины'],
  ['skills/quality-gate/SKILL.md', 'volume.c1MaxLines', 'порог объёма назван ключом настройки'],
  ['skills/quality-gate/SKILL.md', 'complexity.maxNesting', 'порог сложности назван ключом настройки'],
  ['skills/quality-gate/SKILL.md', 'config=', 'отметка о настройке переносится в след'],
  ['skills/quality-gate/references/evidence-format.md', 'custom:volume+sentinel', 'формат отметки о настройке описан'],
  // Затенение колонки псевдонимом источника: ошибка выполнения, которую до продуктива не
  // ловит ничто — текст запроса для всех инструментов остаётся строковым литералом.
  ['skills/bsl-code-review/references/bsl-coding-standards.md', 'Неоднозначное поле', 'затенение колонки псевдонимом разобрано в стандартах'],
  ['skills/bsl-code-review/references/bsl-query-reference.md', 'qg:QRY-ALIAS-SHADOWS-FIELD', 'справочник языка называет эвристику затенения'],
  ['skills/bsl-code-review/references/checklist-code.md', 'QRY-ALIAS-SHADOWS-FIELD', 'затенение псевдонимом — пункт чеклиста'],
  ['skills/bsl-code-review/SKILL.md', 'tools/query-lint.mjs', 'контур кода прогоняет лексическую проверку запросов'],
  // Обратная половина: строгость к ОБЪЕДИНИТЬ не должна уходить в ложные находки. Отсутствие
  // псевдонимов в неголовной ветке — законная форма, и это сказано прямо.
  ['skills/bsl-code-review/references/bsl-query-reference.md', 'Имена колонок результата берутся из', 'имена колонок ОБЪЕДИНИТЬ берутся из первой выборки'],
  ['skills/bsl-code-review/references/bsl-coding-standards.md', 'ложная находка', 'требование псевдонимов в ветке ОБЪЕДИНИТЬ названо ложной находкой'],
  // Архетип «запрос» обязан отчитаться об исполнении: лексический разбор его не заменяет.
  ['skills/quality-gate/SKILL.md', 'query-execution', 'оркестратор требует отчёта об исполнении запроса'],
  ['skills/quality-gate/references/evidence-format.md', 'dimension=query-execution', 'измерение «исполнение запроса» описано в формате следа'],
  // Верификатор в живом прогоне выдал Critical на законную форму и пропустил настоящий
  // дефект по соседству. Обе половины должны остаться в его карте проверок.
  ['agents/bsl-verifier.md', 'query-lint.mjs', 'верификатор прогоняет проверку текстов запросов'],
  ['agents/bsl-verifier.md', 'ОБЪЕДИНИТЬ', 'верификатору названа законная форма ветки объединения'],
];
for (const [file, needle, label] of mustContain) {
  const p = join(ROOT, file);
  check(`правило на месте: ${label}`, existsSync(p) && readFileSync(p, 'utf8').includes(needle));
}

// Регрессия, которая в репозитории уже была: справочник языка подавал РАЗРЕШЕННЫЕ как выбор
// по умолчанию. Проверяем не наличие правильной строки, а отсутствие неправильной — иначе
// совет вернётся рядом с оговоркой и снова разойдётся с #std415.
{
  const ref = readFileSync(join(ROOT, 'skills/bsl-code-review/references/bsl-query-reference.md'), 'utf8');
  const badRow = ref.split('\n').find((l) => l.includes('РАЗРЕШЕННЫЕ') && /по умолчанию/.test(l));
  check('РАЗРЕШЕННЫЕ не подаётся как выбор по умолчанию', !badRow, badRow || '');
}

// у каждого признака архитектуры обязан быть контр-сигнал
{
  const map = JSON.parse(readFileSync(join(ROOT, 'skills/bsl-architecture-review/references/signs-map.json'), 'utf8'));
  const without = (map.signs || []).filter((s) => !s.counter || s.counter.trim().length < 10);
  check('у каждого признака есть контр-сигнал', without.length === 0, without.map((s) => s.id).join(', '));
  const noPrinciple = (map.signs || []).filter((s) => !s.principles?.length);
  check('у каждого признака есть ссылка на принцип', noPrinciple.length === 0);

  // Признаки, которым нужен граф вызовов, обязаны быть помечены машиночитаемо: без индекса
  // кода они не «чисто», а `skipped`. Иначе контур молча не проверит треть карты, а отчёт
  // будет выглядеть полным — тот же ложный зелёный, который он ищет в чужом коде.
  const needGraph = (map.signs || []).filter((s) => s.requires?.includes('call-graph')).map((s) => s.id).sort();
  check('признаки по графу вызовов размечены', needGraph.join(',') === 'ARCH-A1,ARCH-A11,ARCH-A7,ARCH-A9', needGraph.join(',') || 'ни одного');

  const skill = readFileSync(join(ROOT, 'skills/bsl-architecture-review/SKILL.md'), 'utf8');
  check('правило пропуска при отсутствии индекса описано', skill.includes('reason=rlm_unavailable') && skill.includes('call-graph-signs'));
  for (const id of needGraph) {
    check(`пропуск называет ${id}`, skill.includes(id));
  }
}

// ---------------------------------------------------------------------------
section('Статический анализатор — нормализация вывода и поиск корня конфигурации');

{
  const analyzer = await import(pathToFileURL(join(ROOT, 'tools', 'analyzer-run.mjs')).href);

  // Синтетическое дерево: корень конфигурации определяется наличием Configuration.xml.
  const proj = join(WORK, 'proj');
  const cfRoot = join(proj, 'src', 'cf');
  const modDir = join(cfRoot, 'CommonModules', 'Тест', 'Ext');
  mkdirSync(modDir, { recursive: true });
  writeFileSync(join(cfRoot, 'Configuration.xml'), '<xml/>', 'utf8');
  const modFile = join(modDir, 'Module.bsl');
  writeFileSync(modFile, 'Процедура П() КонецПроцедуры', 'utf8');
  const outside = join(proj, 'scripts', 'tool.bsl');
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, '// вне конфигурации', 'utf8');

  check('корень конфигурации найден по Configuration.xml', analyzer.findConfigRoot(modFile, proj) === cfRoot);
  const grouped = analyzer.groupByConfigRoot([modFile, outside], proj);
  check('файлы сгруппированы по корню', grouped.groups.get(cfRoot)?.length === 1);
  check('файл вне конфигурации попал в сироты', grouped.orphans.length === 1);

  // Пути в отчётах: bsl-analyzer отдаёт `\\?\`-форму, BSL LS — file:// URI. Разбор обеих
  // обязателен: иначе фильтр по изменённым файлам не находит совпадений и контур
  // отчитывается «чисто» на пустом множестве. Это ровно тот отказ, что был найден живьём.
  const jsonl = [
    JSON.stringify({ type: 'start', total_files: 1, version: '0.0.0' }),
    JSON.stringify({
      type: 'file',
      path: '\\\\?\\' + modFile,
      diagnostics: [
        { code: 'CommonModuleInvalidType', message: 'тест', severity: 'Major', start_line: 0, start_column: 0 },
        { code: 'MagicNumber', message: 'тест', severity: 'Information', start_line: 41, start_column: 3 },
      ],
      metrics: { functions: 1, complexity: 2, cognitive_complexity: 3 },
    }),
    JSON.stringify({ type: 'done', elapsed_secs: 0.01, total_files: 1, total_diagnostics: 2 }),
  ].join('\n');

  const na = analyzer.normalizeBslAnalyzer(jsonl, { root: cfRoot, base: proj });
  check('bsl-analyzer: путь приведён к проектному', na.findings[0]?.file === 'src/cf/CommonModules/Тест/Ext/Module.bsl');
  check('bsl-analyzer: нумерация строк приведена к человеческой', na.findings[1]?.line === 42);
  check('bsl-analyzer: серьёзность отображена', na.findings[0]?.severity === 'major' && na.findings[1]?.severity === 'info');
  check('bsl-analyzer: метрики собраны', na.metrics.get('src/cf/CommonModules/Тест/Ext/Module.bsl')?.functions === 1);

  const lsReport = JSON.stringify({
    fileinfos: [
      {
        path: pathToFileURL(modFile).href,
        diagnostics: [{ code: { value: 'CommonModuleInvalidType' }, message: 'тест', severity: 'Major', range: { start: { line: 0, character: 0 } } }],
      },
      {
        path: pathToFileURL(join(cfRoot, 'CommonModules', 'Другой', 'Ext', 'Module.bsl')).href,
        diagnostics: [{ code: { value: 'LineLength' }, message: 'тест', severity: 'Minor', range: { start: { line: 7, character: 0 } } }],
      },
    ],
  });
  const nl = analyzer.normalizeBslLs(lsReport, { root: cfRoot, base: proj });
  check('BSL LS: file:// URI разобран', nl.findings[0]?.file === 'src/cf/CommonModules/Тест/Ext/Module.bsl');
  check('BSL LS: код диагностики извлечён из объекта', nl.findings[0]?.code === 'CommonModuleInvalidType');
  const nlFiltered = analyzer.normalizeBslLs(lsReport, { root: cfRoot, base: proj, only: [modFile] });
  check('BSL LS: фильтр по изменённым файлам работает', nlFiltered.findings.length === 1);

  // След: чистый прогон отчитывается за весь набор, нарушения — по записи на код.
  const evClean = analyzer.toEvidence({ findings: [], sentinelResult: { status: 'found' }, engine: 'bsl-analyzer', version: '1.2.3' });
  check('чистый прогон помечен идентификатором набора', evClean.some((l) => l.includes('ids=[bslls:*]') && l.includes('verdict=clean')));
  check('версия движка попала в след', evClean.some((l) => l.includes('engine=bsl-analyzer@1.2.3')));
  const evDirty = analyzer.toEvidence({ findings: na.findings, sentinelResult: { status: 'found' }, engine: 'bsl-analyzer', version: '1.2.3' });
  check('нарушения выведены по коду', evDirty.filter((l) => l.startsWith('[qg applied')).length === 2);

  // Раскладка проекта: расширение отличается от основной конфигурации назначением в корневом
  // XML. Без этого различения анализ идёт по расширению в одиночку, имена БСП неразрешимы, и
  // треть находок становится ложной — измерено на боевом коде.
  const proj2 = join(WORK, 'layout');
  const mainRoot = join(proj2, 'src', 'cf');
  const extRoot = join(proj2, 'src', 'cfe', 'Расш');
  mkdirSync(mainRoot, { recursive: true });
  mkdirSync(extRoot, { recursive: true });
  writeFileSync(join(mainRoot, 'Configuration.xml'), '<Configuration><Name>Основная</Name></Configuration>', 'utf8');
  writeFileSync(join(extRoot, 'Configuration.xml'), '<Configuration><ConfigurationExtensionPurpose>AddOn</ConfigurationExtensionPurpose></Configuration>', 'utf8');

  const layout = analyzer.discoverLayout(proj2);
  check('основная конфигурация опознана', layout.main === mainRoot, layout.main);
  check('расширение опознано по назначению', layout.extensions.length === 1 && layout.extensions[0] === extRoot);

  const toml = analyzer.buildProjectConfig({ layout, root: proj2 });
  check('в конфиг попал корень основной конфигурации', toml.includes('[source]') && toml.includes('root = "src/cf"'));
  check('в конфиг попало расширение', /extensions = \[\s*\n\s*"src\/cfe\/Расш",/.test(toml), toml.split('\n').slice(0, 6).join(' | '));

  // Неразобранный файл: сотни ParseError — это не сотни проблем, а отсутствие анализа.
  const parseFail = [
    JSON.stringify({
      type: 'file',
      path: '\\\\?\\' + modFile,
      diagnostics: [
        { code: 'ParseError', message: 'x', severity: 'Major', start_line: 1 },
        { code: 'ParseError', message: 'x', severity: 'Major', start_line: 2 },
        { code: 'MagicNumber', message: 'x', severity: 'Information', start_line: 3 },
      ],
    }),
  ].join('\n');
  const np = analyzer.normalizeBslAnalyzer(parseFail, { root: cfRoot, base: proj });
  check('ошибки разбора вынесены из находок', np.findings.length === 0, JSON.stringify(np.findings));
  check('файл помечен неразобранным', np.unparsed.get('src/cf/CommonModules/Тест/Ext/Module.bsl') === 2);

  const evUnparsed = analyzer.toEvidence({
    findings: [], sentinelResult: { status: 'found' }, engine: 'bsl-analyzer', version: '1.0.0', unparsed: np.unparsed,
  });
  check('неразобранное попало в след как not_verified', evUnparsed.some((l) => l.includes('reason=parse_failed')));

  const evExtOnly = analyzer.toEvidence({
    findings: [], sentinelResult: { status: 'found' }, engine: 'bsl-analyzer', version: '1.0.0', resolution: 'extension-only',
  });
  check('разбор без основной конфигурации отмечен в следе', evExtOnly.some((l) => l.includes('main_configuration_absent')));
  check('семейство неразрешимого перечислено', analyzer.UNRESOLVED_WITHOUT_MAIN.has('UnresolvedMethodCall') && analyzer.UNRESOLVED_WITHOUT_MAIN.has('UnknownFieldInQuery'));

  // Фикстура часового обязана оставаться НЕВАЛИДНОЙ по сочетанию флагов: валидное сочетание
  // погасит диагностику, и часовой начнёт считать недостоверным любой прогон.
  const fixture = readFileSync(join(ROOT, 'assets/analyzer/sentinel-fixture/CommonModules/QG_SentinelModule.xml'), 'utf8');
  const allFalse = ['Server', 'ServerCall', 'ClientManagedApplication', 'ClientOrdinaryApplication', 'ExternalConnection'].every(
    (flag) => fixture.includes(`<${flag}>false</${flag}>`)
  );
  check('фикстура часового осталась невалидной по типу модуля', allFalse);
  check('фикстура зарегистрирована в составе конфигурации',
    readFileSync(join(ROOT, 'assets/analyzer/sentinel-fixture/Configuration.xml'), 'utf8').includes('<CommonModule>QG_SentinelModule</CommonModule>'));
}

// ---------------------------------------------------------------------------
section('Установка анализатора — манифест и состояние установки');

{
  const boot = await import(pathToFileURL(join(ROOT, 'tools', 'analyzer-bootstrap.mjs')).href);
  const manifest = boot.readManifest();

  check('манифест закрепляет версию', /^\d+\.\d+\.\d+$/.test(manifest.version || ''), manifest.version);
  check('манифест называет источник', manifest.repo === 'itrous/bsl-analyzer' && manifest.urlTemplate.includes('{version}'));
  const targets = Object.entries(manifest.targets || {});
  check('поддержаны основные платформы', targets.length >= 3, targets.map(([k]) => k).join(', '));
  const badSums = targets.filter(([, t]) => !/^[0-9a-f]{64}$/.test(t.sha256 || '') || !(t.size > 0));
  check('у каждой платформы валидная сумма и размер', badSums.length === 0, badSums.map(([k]) => k).join(', '));

  const url = boot.assetUrl(manifest, manifest.targets[targets[0][0]]);
  check('ссылка собирается из шаблона', url.startsWith('https://github.com/itrous/bsl-analyzer/releases/download/v') && url.endsWith(targets[0][1].asset), url);

  // Состояние установки проверяется без сети: подкладываем свой «бинарник» и синтетический
  // манифест под него. Маркер готовности обязан отражать РЕАЛЬНЫЙ файл, иначе испорченная
  // загрузка выглядела бы рабочей установкой.
  const fakeRoot = join(WORK, 'plugin-data');
  const fake = { engine: 'test-engine', version: '9.9.9', repo: 'x/y', urlTemplate: 'https://example/{asset}', targets: {} };
  const dir = boot.installDir(fake, fakeRoot);
  mkdirSync(dir, { recursive: true });
  const binPath = boot.binaryPath(fake, fakeRoot);
  writeFileSync(binPath, 'не настоящий бинарник', 'utf8');
  const realSha = await boot.sha256(binPath);
  const realSize = readFileSync(binPath).length;
  fake.targets[boot.targetKey()] = { asset: 'fake', sha256: realSha, size: realSize };
  writeFileSync(join(dir, '.ready'), JSON.stringify({ version: fake.version, sha256: realSha, size: realSize }), 'utf8');

  check('корректная установка распознаётся', boot.installed(fake, fakeRoot) === binPath);

  writeFileSync(binPath, 'не настоящий бинарник, но длиннее', 'utf8');
  check('изменённый размер обесценивает установку', boot.installed(fake, fakeRoot) === null);

  const v = await boot.verifyInstalled(fake, fakeRoot);
  check('проверка отличает испорченное от неустановленного', v.reason === 'corrupted_or_stale', v.reason);
}

// ---------------------------------------------------------------------------
section('Часовой проверяется по целям, а не «хотя бы один живой»');

{
  const head = '## quality evidence\n\n[qg scope: volume=C1, files=1, archetypes=[none], driver=volume, resolved=code:L1, config=default]\n';
  const clean = '[qg applied: layer=code, scope=static-analysis, ids=[bslls:*], verdict=clean]\n';
  const notVerified = '[qg not_verified: dimension=compilation, reason=no_platform]\n';
  const v8 = '[qg sentinel: target=v8std, id=std454, status=found]\n';
  const bslls = '[qg sentinel: target=bslls, id=CommonModuleInvalidType, status=found]\n';

  const masked = writeBytes('ev-masked.md', head + v8 + clean + notVerified);
  const r1 = run('tools/evidence-validator.mjs', [masked, '--gate']);
  check('живой v8std НЕ маскирует отсутствие часового по анализатору', r1.code === 2, r1.out.trim().slice(0, 120));

  const ok = writeBytes('ev-both.md', head + v8 + bslls + clean + notVerified);
  const r2 = run('tools/evidence-validator.mjs', [ok, '--gate']);
  check('оба часовых подтверждены — след принят', r2.code === 0, r2.out.trim().slice(0, 120));

  const dead = writeBytes('ev-dead.md', head + v8 + '[qg sentinel: target=bslls, id=CommonModuleInvalidType, status=not_found]\n' + clean + notVerified);
  const r3 = run('tools/evidence-validator.mjs', [dead, '--gate']);
  check('часовой по анализатору не подтверждён — след отвергнут', r3.code === 2);

  // Идентификатор нашей эвристики бывает составным: qg:AI-CONTRACT-RECHECK, не только qg:ARCH-A1.
  const compound = writeBytes(
    'ev-compound.md',
    head + v8 + '[qg applied: layer=code, scope=t, ids=[qg:AI-CONTRACT-RECHECK], verdict=clean]\n' + notVerified
  );
  const rc = run('tools/evidence-validator.mjs', [compound]);
  check('составной идентификатор эвристики принимается', !rc.out.includes('непохож'), rc.out.trim().slice(0, 120));

  const bogus = writeBytes(
    'ev-bogus.md',
    head + v8 + '[qg applied: layer=code, scope=t, ids=[qg:X], verdict=clean]\n' + notVerified
  );
  const rb = run('tools/evidence-validator.mjs', [bogus]);
  check('односегментный идентификатор по-прежнему отвергается', rb.out.includes('непохож'));

  // Нарушения не требуют часового: «нашли» самодостаточно, недостоверно только «не нашли».
  const onlyViolations = writeBytes('ev-viol.md', head + v8 + '[qg applied: layer=code, scope=static-analysis, ids=[bslls:MagicNumber], verdict=violation:bslls:MagicNumber]\n');
  const r4 = run('tools/evidence-validator.mjs', [onlyViolations, '--gate']);
  check('вердикт с нарушениями не требует часового по анализатору', r4.code === 0, r4.out.trim().slice(0, 120));
}

// ---------------------------------------------------------------------------
process.stdout.write(`\n${'='.repeat(60)}\nПройдено: ${passed}, провалено: ${failures.length}\n`);
if (failures.length) {
  process.stdout.write('\nПровалившиеся проверки:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}\n`);
}
rmSync(WORK, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
