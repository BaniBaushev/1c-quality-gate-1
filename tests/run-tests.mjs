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
  const p = join(WORK, name);
  // Подкаталог в имени — способ задать фикстуре нужное ИМЯ ФАЙЛА: проверка транзакций в
  // обработчике смотрит на него (ObjectModule.bsl против модуля формы), и два таких файла
  // обязаны уживаться рядом.
  mkdirSync(dirname(p), { recursive: true });
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
section('Запросы — ПЕРВЫЕ N без УПОРЯДОЧИТЬ ПО');

// Порядок строк без явной сортировки задаёт СУБД: набор из N строк меняется между прогонами
// и между движками. На тестовой базе выборка «первых десяти» стабильна, в продуктиве — нет.
{
  const f = bsl('qry-top-plain.bsl', [
    'ВЫБРАТЬ ПЕРВЫЕ 10',
    '|	Контрагенты.Ссылка КАК Ссылка',
    '|ИЗ',
    '|	Справочник.Контрагенты КАК Контрагенты',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('ПЕРВЫЕ без порядка — находка', r.out.includes('QRY-TOP-WITHOUT-ORDER'), r.out.trim().slice(0, 140));
  check('находка не блокирующая (код 1)', r.code === 1, `код ${r.code}`);
  check('в записи следа свой scope', r.out.includes('scope=query-top-order'), r.out.trim().slice(0, 200));
}
{
  const f = bsl('qry-top-ordered.bsl', [
    'ВЫБРАТЬ ПЕРВЫЕ 10',
    '|	Контрагенты.Ссылка КАК Ссылка',
    '|ИЗ',
    '|	Справочник.Контрагенты КАК Контрагенты',
    '|УПОРЯДОЧИТЬ ПО',
    '|	Контрагенты.Наименование',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('порядок задан — не придирается', r.code === 0, r.out.trim().slice(0, 140));
}
{
  // Законная форма: результат используется как «пусто или нет», какая строка пришла — неважно.
  const f = bsl('qry-top-one.bsl', [
    'ВЫБРАТЬ ПЕРВЫЕ 1',
    '|	Заказы.Ссылка КАК Ссылка',
    '|ИЗ',
    '|	Документ.ЗаказКлиента КАК Заказы',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('ПЕРВЫЕ 1 — проверка существования, не находка', r.code === 0, r.out.trim().slice(0, 140));
}
{
  const f = bsl('qry-top-auto.bsl', [
    'ВЫБРАТЬ ПЕРВЫЕ 5',
    '|	Заказы.Ссылка КАК Ссылка',
    '|ИЗ',
    '|	Документ.ЗаказКлиента КАК Заказы',
    '|АВТОУПОРЯДОЧИВАНИЕ',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('АВТОУПОРЯДОЧИВАНИЕ — не находка', r.code === 0, r.out.trim().slice(0, 140));
}
{
  // ПОМЕСТИТЬ законной формой не является: отбор N строк произошёл ДО помещения. Это самый
  // частый реальный случай — предварительный отбор в ВТ перед соединением.
  const f = bsl('qry-top-into.bsl', [
    'ВЫБРАТЬ ПЕРВЫЕ 100',
    '|	Товары.Ссылка КАК Номенклатура',
    '|ПОМЕСТИТЬ ВТ_Ключи',
    '|ИЗ',
    '|	Справочник.Номенклатура КАК Товары',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('ПЕРВЫЕ N с ПОМЕСТИТЬ — всё равно находка', r.out.includes('QRY-TOP-WITHOUT-ORDER'), r.out.trim().slice(0, 140));
}
{
  // В объединении УПОРЯДОЧИТЬ ПО относится ко всему результату и стоит в конце последней
  // ветки: проверка на уровне ветки дала бы ложную находку на каждом таком запросе.
  const f = bsl('qry-top-union.bsl', [
    'ВЫБРАТЬ ПЕРВЫЕ 10',
    '|	Товары.Ссылка КАК Ссылка',
    '|ИЗ',
    '|	Справочник.Номенклатура КАК Товары',
    '|ОБЪЕДИНИТЬ ВСЕ',
    '|ВЫБРАТЬ',
    '|	Услуги.Ссылка',
    '|ИЗ',
    '|	Справочник.Услуги КАК Услуги',
    '|УПОРЯДОЧИТЬ ПО',
    '|	Ссылка',
  ].join('\n\t'));
  const r = run('tools/query-lint.mjs', [f]);
  check('порядок в конце объединения — не находка', r.code === 0, r.out.trim().slice(0, 140));
}

// ---------------------------------------------------------------------------
section('Транзакция внутри обработчика с неявной транзакцией');

// Платформа открывает транзакцию вокруг записи, удаления и проведения. Вложенных не
// поддерживает: ОтменитьТранзакцию внутри обработчика отменяет ВНЕШНЮЮ целиком, и падение
// случается в месте, не связанном с причиной (#std783 п.1.4).
{
  const f = writeBytes('txn-nested/ObjectModule.bsl', [
    'Процедура ОбработкаПроведения(Отказ, РежимПроведения)',
    '\tНачатьТранзакцию();',
    '\tПопытка',
    '\t\tДвижения.Записать();',
    '\t\tЗафиксироватьТранзакцию();',
    '\tИсключение',
    '\t\tОтменитьТранзакцию();',
    '\tКонецПопытки;',
    'КонецПроцедуры',
  ].join('\n'));
  const r = run('tools/bsl-lint.mjs', [f]);
  check('транзакция в ОбработкаПроведения — находка', r.out.includes('BSL-TXN-IN-HANDLER'), r.out.trim().slice(0, 160));
  check('назван обработчик и стандарт', r.out.includes('ОбработкаПроведения') && r.out.includes('#std783'));
  check('находка не блокирующая (код 1)', r.code === 1, `код ${r.code}`);
}
{
  // Комментарий и строковый литерал маскируются: иначе закомментированный вызов и текст
  // сообщения давали бы находку — ложную и потому дорогую.
  const f = writeBytes('txn-masked/ObjectModule.bsl', [
    'Процедура ПриЗаписи(Отказ)',
    '\t// НачатьТранзакцию();',
    '\tТекст = "НачатьТранзакцию() в тексте сообщения";',
    'КонецПроцедуры',
  ].join('\n'));
  const r = run('tools/bsl-lint.mjs', [f]);
  check('комментарий и литерал не дают находки', r.code === 0, r.out.trim().slice(0, 160));
}
{
  // Метод, который не является обработчиком события, открывает транзакцию штатно.
  const f = writeBytes('txn-plain/ObjectModule.bsl', [
    'Функция ЗаписатьПорцию() Экспорт',
    '\tНачатьТранзакцию();',
    '\tВозврат Истина;',
    'КонецФункции',
  ].join('\n'));
  const r = run('tools/bsl-lint.mjs', [f]);
  check('обычный метод модуля — не находка', r.code === 0, r.out.trim().slice(0, 160));
}
{
  // ПередЗаписью формы — другое событие, транзакции вокруг него нет. Без различения модулей
  // проверка срабатывала бы на каждой форме с таким обработчиком.
  const f = writeBytes('txn-form/Form/Ext/Form/Module.bsl', [
    '&НаКлиенте',
    'Процедура ПередЗаписью(Отказ, ПараметрыЗаписи)',
    '\tНачатьТранзакцию();',
    'КонецПроцедуры',
  ].join('\n'));
  const r = run('tools/bsl-lint.mjs', [f]);
  check('модуль формы — вне области проверки', r.code === 0, r.out.trim().slice(0, 160));
  check('неприменимость заявлена записью следа',
    r.out.includes('[qg skipped: layer=code, scope=transaction-nesting, reason=not_applicable]'),
    r.out.trim().slice(0, 200));
}
{
  // Набор записей регистра пишется в собственной транзакции платформы так же, как объект.
  const f = writeBytes('txn-recordset/RecordSetModule.bsl', [
    'Процедура ПередЗаписью(Отказ, Замещение)',
    '\tНачатьТранзакцию();',
    'КонецПроцедуры',
  ].join('\n'));
  const r = run('tools/bsl-lint.mjs', [f]);
  check('модуль набора записей проверяется наравне с модулем объекта', r.out.includes('BSL-TXN-IN-HANDLER'),
    r.out.trim().slice(0, 160));
}
{
  // Запись следа печатает инструмент, а принимает валидатор: разъедься эти два места —
  // строку начнут сочинять руками.
  const f = writeBytes('txn-evidence/ObjectModule.bsl', 'Процедура ПриЗаписи(Отказ)\n\tА = 1;\nКонецПроцедуры\n');
  const printed = run('tools/bsl-lint.mjs', [f]).out.split('## quality evidence')[1]?.trim() || '';
  const report = writeBytes('ev-from-bsl-lint.md',
    '## quality evidence\n\n' +
    '[qg scope: volume=C1, files=1, archetypes=[object-event], driver=archetype:object-event, resolved=code:L1, config=default]\n' +
    '[qg sentinel: target=v8std, id=std454, status=found]\n' +
    printed + '\n' +
    '[qg not_verified: dimension=compilation, reason=no_platform]\n');
  const r = run('tools/evidence-validator.mjs', [report, '--gate']);
  check('запись следа из bsl-lint проходит валидатор', r.code === 0, `${printed} → ${r.out.trim().slice(0, 140)}`);
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
section('Валидатор пакета — состав компонентов');

// Раньше проверялись только навыки. Субагент с испорченным frontmatter не поднимается, а
// контуры трактуют «субагента нет в среде» как законную деградацию с записью skipped: дефект
// пакета выглядит как штатное окружение пользователя и никем не расследуется.
{
  const pkg = join(WORK, 'pkg-broken');
  writeBytes('pkg-broken/agents/разведчик.md', '---\nname: другое-имя\ndescription: тест\nmodel: gpt\n---\n\nтело\n');
  writeBytes('pkg-broken/commands/проба.md', '---\nargumentHint: подсказка\n---\n\nтело\n');
  writeBytes('pkg-broken/skills/big-skill/SKILL.md', `---\nname: big-skill\ndescription: тест\n---\n\n${'т'.repeat(40000)}\n`);
  writeBytes('pkg-broken/skills/big-skill/references/anchors.md', 'раздел «Нет такого» навыка `big-skill`\n');
  writeBytes('pkg-broken/skills/big-skill/references/links.md', 'см. `references/no-such.md`\n');

  const r = run('tools/validate-package.mjs', ['--root', pkg]);
  check('имя агента сверяется с именем файла', r.out.includes('не совпадает с именем файла'), r.out.trim().slice(0, 200));
  check('модель агента вне набора — ошибка', r.out.includes('model "gpt"'), r.out.trim().slice(0, 200));
  check('у агента требуется tools', /нет поля tools/.test(r.out), r.out.trim().slice(0, 200));
  check('camelCase-поле команды названо с исправлением',
    r.out.includes('"argumentHint" не читается') && r.out.includes('argument-hint'), r.out.trim().slice(0, 200));
  check('навык сверх предела размера — ошибка', /при пределе \d+/.test(r.out), r.out.trim().slice(0, 200));
  check('ссылка на несуществующий раздел навыка найдена', r.out.includes('нет раздела «Нет такого»'), r.out.trim().slice(0, 200));
  // Битая ссылка была предупреждением, а предупреждения не влияли на код возврата: проверка
  // существовала и ничего не запрещала.
  check('битая ссылка на файл — ошибка, а не предупреждение',
    r.out.includes('ссылка на несуществующий файл') && r.out.includes('ОШИБКА'), r.out.trim().slice(0, 200));
  check('испорченный пакет даёт ненулевой код', r.code === 1, `код ${r.code}`);
}
{
  // Ложное срабатывание, которое проверка уже один раз дала: ссылка внутри цитаты переносится
  // на следующую строку, и та начинается с «> ».
  const pkg = join(WORK, 'pkg-quote');
  writeBytes('pkg-quote/skills/orchestrator/SKILL.md', '---\nname: orchestrator\ndescription: тест\n---\n\n## Путь к инструментам плагина (`$QG`)\n\nтело\n');
  writeBytes('pkg-quote/skills/orchestrator/references/quote.md',
    '> подробности — см. раздел «Путь к инструментам\n> плагина» навыка `orchestrator`.\n');
  const r = run('tools/validate-package.mjs', ['--root', pkg]);
  check('перенос ссылки в цитате не даёт ложной находки', !r.out.includes('нет раздела'), r.out.trim().slice(0, 200));
}
{
  const r = run('tools/validate-package.mjs', []);
  check('собственный пакет проходит валидатор', r.code === 0, r.out.trim().slice(0, 200));
}

// ---------------------------------------------------------------------------
section('Уникальность UUID объектов метаданных');

// Скопированный вместе с uuid объект платформа при загрузке либо отвергает, либо оставляет
// один из двух — второй исчезает бесшумно. Валидаторы структуры разбирают каждый файл
// поодиночке и совпадения с соседним файлом не видят в принципе.
{
  const r = run('tools/xml/uuid-unique.mjs', [join(FIXTURES, 'config-clean')]);
  check('чистая выгрузка — дублей нет', r.code === 0, `код ${r.code}: ${r.out.trim().slice(0, 120)}`);
}
{
  const r = run('tools/xml/uuid-unique.mjs', [join(FIXTURES, 'config-dup-uuid')]);
  check('дубль между файлами найден', r.out.includes('Товары.xml | Catalogs/Услуги.xml'), r.out.trim().slice(0, 160));
  check('дубль внутри одного файла найден', /Товары\.xml ×2/.test(r.out), r.out.trim().slice(0, 160));
  check('дубль даёт код 2', r.code === 2, `код ${r.code}`);

  // Контр-сигнал, измеренный на полной выгрузке УТ: единственные законные повторы uuid
  // живут в картах маршрута бизнес-процессов. Без этого исключения проверка давала бы
  // находку на каждой типовой конфигурации.
  check('карта маршрута не даёт находки', !r.out.includes('0000000000aa'), r.out.trim().slice(0, 160));
  check('пропущенные схемы названы явно', r.out.includes('GraphicalSchema'), r.out.trim().slice(0, 160));
}
{
  const r = run('tools/xml/uuid-unique.mjs', [join(WORK, 'нет-такого-каталога')]);
  check('несуществующий каталог назван, а не свален в traceback',
    /не найден/i.test(r.out) && !/at .*uuid-unique/.test(r.out), r.out.trim().slice(0, 120));
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
function runPy(script, args, opts = {}) {
  try {
    const out = execFileSync('python', [script, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...(opts.env || {}) },
    });
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

  // Дубль структурного узла. Разборщики (включая сам валидатор: `find()` возвращает первый
  // элемент) читают только первый ChildObjects, поэтому до появления проверки сломанный и
  // целый файл давали ОДИН вердикт «Validation OK» — тот случай, когда молчание инструмента
  // означает не «дефекта нет», а «дефект этого класса не ищется».
  const dupNode = runPy(pyTool('meta'), ['-Path', xml('meta', 'dup-childobjects.xml')]);
  check('дубль ChildObjects найден', dupNode.code === 1 && dupNode.out.includes('Duplicate structural node'), dupNode.out.trim().slice(0, 140));
  const intactNode = runPy(pyTool('meta'), ['-Path', xml('meta', 'valid.xml')]);
  check('на целом файле дубля не находит', !intactNode.out.includes('Duplicate structural node'), intactNode.out.trim().slice(0, 120));

  // Валидатор структуры печатает готовую строку следа: пока её не было, вердикт в отчёт
  // переносила модель — то есть проверка с инструментом заканчивалась записью от руки.
  check('валидатор печатает запись следа', intactNode.out.includes('scope=structure-validation'), intactNode.out.trim().slice(-140));
  check('вердикт следа отражает находки', dupNode.out.includes('verdict=violation:qg:XML-STRUCT'), dupNode.out.trim().slice(-140));

  // Отчитываются ВСЕ валидаторы, а не один. Контур называет проверку структуры любого файла
  // метаданных одним именем `structure-validation`, и валидатор следа сверяет по имени: если
  // бы отмечался только meta-validate, след после проверки формы или роли отвергался бы как
  // «инструмент не запускался» — ложная находка на добросовестно выполненной работе.
  const pyProj = join(WORK, 'py-journal');
  rmSync(pyProj, { recursive: true, force: true });
  mkdirSync(pyProj, { recursive: true });
  for (const [name, path] of [
    ['form', xml('form', 'valid.xml')],
    ['role', join(FIXTURES, 'role-min', 'Roles', 'QG_ТестоваяРоль')],
    ['skd', xml('skd', 'valid.xml')],
    ['epf', xml('epf', 'valid')],
    ['mxl', xml('mxl', 'valid.xml')],
    ['cf', xml('cf', 'valid')],
    ['cfe', xml('cfe', 'valid')],
    ['interface', xml('interface', 'valid.xml')],
    ['subsystem', xml('subsystem', 'valid.xml')],
  ]) {
    const r = runPy(pyTool(name), ['-Path', path], { env: { CLAUDE_PROJECT_DIR: pyProj } });
    check(`${name}: печатает запись следа`, r.out.includes('scope=structure-validation'), r.out.trim().slice(-120));
  }

  // Импорт журнала защищён try/except — молча проглоченный сбой дал бы ровно тот отказ,
  // ради предотвращения которого всё это писалось. Проверяем не печать, а сам файл.
  const pyJournal = join(pyProj, '.claude', '.state', 'qg-runs.jsonl');
  check('валидаторы XML отмечаются в журнале', existsSync(pyJournal), pyJournal);
  if (existsSync(pyJournal)) {
    const tools = new Set(
      readFileSync(pyJournal, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l).tool)
    );
    check('в журнале отметился каждый из девяти', tools.size === 9, [...tools].join(', '));
  }
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

/**
 * Заводит журнал прогонов НАСТОЯЩИМ запуском инструмента.
 *
 * Позитивные фикстуры содержат `scope=file-encoding` — проверку, у которой есть инструмент,
 * и валидатор требует для неё отметку о прогоне. Записать отметку в журнал напрямую было бы
 * проще, но тогда тест перестал бы падать, если инструмент однажды перестанет отмечаться, —
 * то есть проверял бы сам себя.
 */
function seedJournal(projDir) {
  mkdirSync(projDir, { recursive: true });
  const sample = join(projDir, 'seed.bsl');
  writeFileSync(sample, BOM + 'Процедура Пример()\r\nКонецПроцедуры\r\n', 'utf8');
  run('tools/hygiene-check.mjs', [sample], { env: { CLAUDE_PROJECT_DIR: projDir } });
}

const EV_PROJ = join(WORK, 'ev-journal-proj');
seedJournal(EV_PROJ);
seedJournal(CUSTOM_PROJ);
const evProj = { env: { CLAUDE_PROJECT_DIR: EV_PROJ } };
{
  const r = run('tools/evidence-validator.mjs', [ev('valid.md'), '--gate'], evProj);
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

  // След содержит проверку с инструментом — прогоняем его после взвода гейта по ТОМУ ЖЕ
  // файлу, что в составе правки. Доказательство обязано быть и не старше последней правки,
  // и покрывать её состав: прогон по постороннему файлу больше не закрывает заявление.
  writeFileSync(file, BOM + 'Процедура Пример()\r\nКонецПроцедуры\r\n', 'utf8');
  run('tools/hygiene-check.mjs', [file], { env });
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
  // Проверка гигиены в следе есть — значит инструмент обязан быть прогнан по-настоящему.
  seedJournal(proj);
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
  ['skills/xml-structure-review/SKILL.md', 'uuid-unique.mjs', 'контур прогоняет проверку уникальности UUID'],
  ['skills/xml-structure-review/SKILL.md', 'Графические схемы не читаются', 'исключение для карт маршрута названо, а не подразумевается'],
  ['agents/xml-runner.md', 'uuid-unique.mjs', 'субагент знает про проверку UUID'],
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
  // Транзакция внутри неявной транзакции обработчика: отменяется ВНЕШНЯЯ, и падает потом
  // не то место, где ошибка. Правило и инструмент обязаны быть названы вместе — иначе
  // находка инструмента остаётся без объяснения «как чинить».
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'qg:BSL-TXN-IN-HANDLER', 'транзакция в обработчике — пункт каталога'],
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', '#std783 п. 1.4', 'у пункта про вложенную транзакцию есть якорь стандарта'],
  ['skills/bsl-code-review/references/checklist-code.md', 'qg:BSL-TXN-IN-HANDLER', 'вложенная транзакция — пункт чеклиста'],
  ['skills/bsl-code-review/SKILL.md', 'bsl-lint.mjs', 'контур прогоняет проверку транзакций'],
  ['agents/bsl-verifier.md', 'bsl-lint.mjs', 'верификатор прогоняет проверку транзакций'],
  // ПЕРВЫЕ N без порядка: набор строк меняется между прогонами и СУБД. Обе половины важны —
  // и правило, и его законные формы, иначе проверка начнёт ругаться на проверку существования.
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'qg:QRY-TOP-WITHOUT-ORDER', 'ПЕРВЫЕ N без порядка — пункт каталога'],
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'Законные формы', 'у правила про ПЕРВЫЕ N названы контр-сигналы'],
  ['skills/bsl-code-review/references/checklist-code.md', 'qg:QRY-TOP-WITHOUT-ORDER', 'ПЕРВЫЕ N без порядка — пункт чеклиста'],
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
  // Причина, по которой контур исполняли руками: оркестратор называл навыки, но не
  // инструменты, и перечень выглядел самодостаточным. Таблица и правило про журнал —
  // единственное, что отличает «проверено» от «прочитано глазами».
  ['skills/quality-gate/SKILL.md', 'Контур исполняется вызовом навыка', 'оркестратор запрещает исполнять контур по памяти'],
  ['skills/quality-gate/SKILL.md', 'qg-runs.jsonl', 'оркестратор называет журнал прогонов'],
  ['skills/quality-gate/SKILL.md', 'tools/query-lint.mjs', 'оркестратор называет инструменты проверок поимённо'],
  ['skills/quality-gate/references/evidence-format.md', 'не старше последней правки', 'срок годности доказательства назван'],
  ['skills/quality-gate/references/evidence-format.md', 'дописанной в журнал вручную', 'граница гарантии журнала заявлена прямо'],
  ['skills/file-hygiene/SKILL.md', 'печатает сам', 'контур гигиены переносит вывод инструмента, а не сочиняет запись'],
  ['skills/xml-structure-review/SKILL.md', 'печатают сами инструменты', 'контур XML переносит вывод инструментов'],
  // Файл, до которого анализатор не добрался, раньше исчезал из отчёта бесследно.
  ['skills/quality-gate/references/evidence-format.md', 'not_in_analyzer_report', 'непроверенные анализатором файлы заявляются'],
  ['skills/quality-gate/SKILL.md', 'не встреченный в', 'оркестратор объясняет, когда файл считается непроверенным'],
  ['README.md', 'qg-runs.jsonl', 'README называет журнал прогонов'],
  // Покрытие и «не применимо»: прогон по одному файлу закрывал заявление обо всех, а
  // not_applicable закрывал любую проверку без единого запуска.
  ['skills/quality-gate/references/evidence-format.md', 'Сверяется и покрытие', 'сверка покрытия описана'],
  ['skills/quality-gate/references/evidence-format.md', 'тоже требует отметки', 'not_applicable требует прогона'],
  ['skills/quality-gate/SKILL.md', 'весь** состав правки', 'оркестратор требует прогона по всему составу'],
  ['README.md', 'Сверяется и покрытие', 'README описывает сверку покрытия'],
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

  // Предмет этой секции — часовой, а не журнал прогонов. Отметку о прогоне анализатора
  // пишем напрямую: запустить настоящий bsl-analyzer в тестах нельзя (его может не быть на
  // машине), а без отметки все следы со `static-analysis` отвергались бы по другой причине,
  // и секция проверяла бы не то, ради чего написана. Сам механизм журнала проверяется
  // отдельной секцией — там отметка появляется настоящим прогоном.
  const sentinelProj = join(WORK, 'sentinel-proj');
  rmSync(sentinelProj, { recursive: true, force: true });
  mkdirSync(join(sentinelProj, '.claude', '.state'), { recursive: true });
  writeFileSync(
    join(sentinelProj, '.claude', '.state', 'qg-runs.jsonl'),
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', scope: 'static-analysis', tool: 'tools/analyzer-run.mjs', verdict: 'clean', unanalyzed: 0 }) + '\n',
    'utf8'
  );
  const sp = { env: { CLAUDE_PROJECT_DIR: sentinelProj } };

  const masked = writeBytes('ev-masked.md', head + v8 + clean + notVerified);
  const r1 = run('tools/evidence-validator.mjs', [masked, '--gate'], sp);
  check('живой v8std НЕ маскирует отсутствие часового по анализатору', r1.code === 2, r1.out.trim().slice(0, 120));

  const ok = writeBytes('ev-both.md', head + v8 + bslls + clean + notVerified);
  const r2 = run('tools/evidence-validator.mjs', [ok, '--gate'], sp);
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
  const r4 = run('tools/evidence-validator.mjs', [onlyViolations, '--gate'], sp);
  check('вердикт с нарушениями не требует часового по анализатору', r4.code === 0, r4.out.trim().slice(0, 120));
}

// ---------------------------------------------------------------------------
section('Корень проекта — один разрешитель на все инструменты');

{
  const pr = await import(pathToFileURL(join(ROOT, 'tools', 'project-root.mjs')).href);

  const tree = join(WORK, 'root-probe');
  rmSync(tree, { recursive: true, force: true });
  const deep = join(tree, 'src', 'cf', 'CommonModules');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(tree, '.1c-quality-gate.json'), '{}', 'utf8');

  const fromDeep = pr.resolveProjectRoot(deep, {});
  check('из подкаталога поднимается до настройки', fromDeep.root === tree, `${fromDeep.root} / ${fromDeep.via}`);
  check('способ опознания назван', fromDeep.via === 'marker' && fromDeep.marker === '.1c-quality-gate.json', fromDeep.via);

  // Настройка важнее .git: в репозитории с несколькими выгрузками корнем гейта может быть
  // подкаталог, и тогда настройка лежит там, а .git — выше.
  const gitOnly = join(WORK, 'root-git');
  rmSync(gitOnly, { recursive: true, force: true });
  mkdirSync(join(gitOnly, 'nested', 'deeper'), { recursive: true });
  mkdirSync(join(gitOnly, '.git'), { recursive: true });
  writeFileSync(join(gitOnly, 'nested', '.1c-quality-gate.json'), '{}', 'utf8');
  check('настройка перевешивает .git', pr.resolveProjectRoot(join(gitOnly, 'nested', 'deeper'), {}).root === join(gitOnly, 'nested'));

  const noConfig = join(WORK, 'root-git-only');
  rmSync(noConfig, { recursive: true, force: true });
  mkdirSync(join(noConfig, 'a', 'b'), { recursive: true });
  mkdirSync(join(noConfig, '.git'), { recursive: true });
  check('.git — запасной маркер', pr.resolveProjectRoot(join(noConfig, 'a', 'b'), {}).root === noConfig);

  // Переменная харнесса точнее любых маркеров: он знает, какой каталог открыт.
  check('CLAUDE_PROJECT_DIR перекрывает маркеры',
    pr.resolveProjectRoot(deep, { CLAUDE_PROJECT_DIR: 'X:/задано/снаружи' }).root === 'X:/задано/снаружи');

  // Маркеров нет вовсе — работаем от исходного каталога, но говорим об этом: «настройки нет»
  // и «искали не там» иначе неотличимы.
  const bare = join(WORK, 'root-bare', 'x');
  mkdirSync(bare, { recursive: true });
  check('без маркеров — исходный каталог и отметка via=start', pr.resolveProjectRoot(bare, {}).via === 'start');

  // --- сквозная проверка: инструменты не зависят от рабочего каталога --------
  // Ровно тот сценарий, на котором дефект и всплыл: одна и та же настройка читалась
  // по-разному из корня и из подкаталога, а `gate status` из подкаталога отвечал
  // «гейт не взведён» при взведённом гейте.
  const proj = join(WORK, 'cwd-probe');
  rmSync(proj, { recursive: true, force: true });
  const sub = join(proj, 'src', 'cf');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(proj, '.1c-quality-gate.json'), JSON.stringify({ volume: { c1MaxLines: 99 } }), 'utf8');
  mkdirSync(join(proj, '.claude', '.state'), { recursive: true });
  writeFileSync(
    join(proj, '.claude', '.state', 'qg-pending.json'),
    JSON.stringify({ version: 2, sessions: { S: { armedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', files: { 'src/cf/a.bsl': { kind: 'bsl', edits: 1 } } } } }),
    'utf8'
  );

  const runIn = (cwd, script, args) => {
    try {
      // Переменную харнесса гасим намеренно: в оболочке она пуста, и проверять надо именно
      // тот путь, по которому инструменты работают на самом деле.
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      return execFileSync(process.execPath, [join(ROOT, script), ...args], { cwd, encoding: 'utf8', stdio: 'pipe', env });
    } catch (e) {
      return `${e.stdout || ''}${e.stderr || ''}`;
    }
  };

  const cfgTop = runIn(proj, 'tools/config.mjs', ['show']);
  const cfgSub = runIn(sub, 'tools/config.mjs', ['show']);
  check('config: из корня видит настройку', cfgTop.includes('config=custom:volume'), cfgTop.trim().slice(-90));
  check('config: из подкаталога та же строка следа', cfgSub.includes('config=custom:volume'), cfgSub.trim().slice(-90));
  check('config: печатает, чем опознан корень', cfgSub.includes('Корень проекта:'), cfgSub.trim().slice(0, 90));

  const gateTop = runIn(proj, 'tools/gate.mjs', ['status']);
  const gateSub = runIn(sub, 'tools/gate.mjs', ['status']);
  check('gate: из корня видит взведённый гейт', gateTop.includes('Сессия S'), gateTop.trim().slice(0, 90));
  check('gate: из подкаталога видит тот же гейт', gateSub.includes('Сессия S'), gateSub.trim().slice(0, 90));
}

// ---------------------------------------------------------------------------
section('Журнал прогонов — вердикт без прогона инструмента не принимается');

{
  const head =
    '## quality evidence\n\n' +
    '[qg scope: volume=C1, files=1, archetypes=[none], driver=volume, resolved=code:L1, config=default]\n' +
    '[qg sentinel: target=v8std, id=std454, status=found]\n';
  const tail = '[qg not_verified: dimension=compilation, reason=no_platform]\n';

  const proj = join(WORK, 'journal-proj');
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(proj, { recursive: true });
  const env = { CLAUDE_PROJECT_DIR: proj };

  const withHygiene = writeBytes(
    'ev-journal-hygiene.md',
    head + '[qg applied: layer=hygiene, scope=file-encoding, ids=[qg:HYG-BOM], verdict=clean]\n' + tail
  );

  const before = run('tools/evidence-validator.mjs', [withHygiene, '--gate'], { env });
  check('вердикт по проверке с инструментом без прогона отклонён', before.code === 2, before.out.trim().slice(0, 130));
  check('названы и проверка, и инструмент',
    before.out.includes('file-encoding') && before.out.includes('hygiene-check.mjs'), before.out.trim().slice(0, 160));

  seedJournal(proj);
  const after = run('tools/evidence-validator.mjs', [withHygiene, '--gate'], { env });
  check('после прогона инструмента тот же след принят', after.code === 0, after.out.trim().slice(0, 130));

  // Доказательство обязано быть не старше последней правки: прогон до правки описывает
  // состояние, которого уже нет. Тот же принцип, по которому гейт снимает отметки
  // проверенного при изменении файла.
  mkdirSync(join(proj, '.claude', '.state'), { recursive: true });
  writeFileSync(
    join(proj, '.claude', '.state', 'qg-pending.json'),
    JSON.stringify({ version: 2, sessions: { S: { armedAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z', files: {} } } }),
    'utf8'
  );
  const stale = run('tools/evidence-validator.mjs', [withHygiene, '--gate'], { env });
  check('прогон старше последней правки не засчитывается', stale.code === 2, stale.out.trim().slice(0, 130));
  check('сказано, что доказательство устарело', stale.out.includes('старше'), stale.out.trim().slice(0, 160));
  rmSync(join(proj, '.claude', '.state', 'qg-pending.json'), { force: true });

  // Правка в СОСЕДНЕЙ сессии не обесценивает свой прогон. Состояние гейта разделено по
  // сессиям намеренно, и требование свежести не должно возвращать общий на проект замок
  // через чёрный ход: иначе чужая правка в 14:00 отменяет честный прогон в 13:00.
  writeFileSync(
    join(proj, '.claude', '.state', 'qg-pending.json'),
    JSON.stringify({
      version: 2,
      sessions: {
        MINE: { armedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', files: {} },
        OTHER: { armedAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z', files: {} },
      },
    }),
    'utf8'
  );
  const twoSessions = run('tools/evidence-validator.mjs', [withHygiene, '--gate'], { env });
  check('чужая сессия не обесценивает свой прогон', twoSessions.code === 0, twoSessions.out.trim().slice(0, 150));
  rmSync(join(proj, '.claude', '.state', 'qg-pending.json'), { force: true });

  // Проверки без инструмента журнала не требуют: требовать не с кого, и молчание здесь —
  // единственная возможная форма.
  const modelOnly = writeBytes(
    'ev-journal-model.md',
    head + '[qg applied: layer=arch, scope=module-responsibility, ids=[qg:ARCH-A1], verdict=clean]\n' + tail
  );
  const mo = run('tools/evidence-validator.mjs', [modelOnly, '--gate'], { env: { CLAUDE_PROJECT_DIR: join(WORK, 'journal-empty') } });
  check('проверка без инструмента журнала не требует', mo.code === 0, mo.out.trim().slice(0, 130));

  // Пропуск заявлен с причиной — доказывать нечего.
  const skipped = writeBytes(
    'ev-journal-skipped.md',
    head + '[qg skipped: layer=hygiene, scope=file-encoding, reason=contour_not_installed]\n' + tail
  );
  const sk = run('tools/evidence-validator.mjs', [skipped, '--gate'], { env: { CLAUDE_PROJECT_DIR: join(WORK, 'journal-empty') } });
  check('пропуск с причиной журнала не требует', sk.code === 0, sk.out.trim().slice(0, 130));

  // --- инструменты печатают след и отмечаются сами ---------------------------
  const hyProj = join(WORK, 'journal-tools');
  rmSync(hyProj, { recursive: true, force: true });
  mkdirSync(hyProj, { recursive: true });
  const hyFile = join(hyProj, 'Module.bsl');
  writeFileSync(hyFile, BOM + 'Процедура Пример()\r\nКонецПроцедуры\r\n', 'utf8');
  const hy = run('tools/hygiene-check.mjs', [hyFile], { env: { CLAUDE_PROJECT_DIR: hyProj } });
  check('hygiene-check печатает готовую запись следа', hy.out.includes('scope=file-encoding') && hy.out.includes('verdict=clean'), hy.out.trim().slice(-160));

  const journalFile = join(hyProj, '.claude', '.state', 'qg-runs.jsonl');
  check('hygiene-check отмечается в журнале', existsSync(journalFile), journalFile);
  const rec = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8').trim().split('\n').pop()) : {};
  check('в записи журнала есть проверка и инструмент', rec.scope === 'file-encoding' && rec.tool === 'tools/hygiene-check.mjs', JSON.stringify(rec));

  // Находка обязана менять вердикт в напечатанной строке, иначе след не зависит от результата.
  const dashFile = join(hyProj, 'Тире.bsl');
  writeFileSync(dashFile, BOM + 'Процедура Пример() // длинное \u2014 тире\r\nКонецПроцедуры\r\n', 'utf8');
  const hyBad = run('tools/hygiene-check.mjs', [dashFile], { env: { CLAUDE_PROJECT_DIR: hyProj } });
  check('находка отражена в вердикте следа', hyBad.out.includes('verdict=violation:qg:HYG-DASH'), hyBad.out.trim().slice(-160));

  const uu = run('tools/xml/uuid-unique.mjs', [join(FIXTURES, 'config-dup-uuid')], { env: { CLAUDE_PROJECT_DIR: hyProj } });
  check('uuid-unique печатает запись следа', uu.out.includes('scope=uuid-uniqueness'), uu.out.trim().slice(-160));
  check('uuid-unique: вердикт по находкам', uu.out.includes('verdict=violation:qg:XML-UUID-DUP'), uu.out.trim().slice(-160));

  const oc = run('tools/xml/orphan-check.mjs', [join(FIXTURES, 'config-clean')], { env: { CLAUDE_PROJECT_DIR: hyProj } });
  check('orphan-check печатает запись следа', oc.out.includes('scope=registration-check'), oc.out.trim().slice(-160));
}

// ---------------------------------------------------------------------------
section('Покрытие: прогон по одному файлу не закрывает заявление обо всех');

{
  const journal = await import(pathToFileURL(join(ROOT, 'tools', 'run-journal.mjs')).href);

  const proj = join(WORK, 'coverage-proj');
  rmSync(proj, { recursive: true, force: true });
  const dir = join(proj, 'src', 'cf', 'CommonModules', 'М', 'Ext');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(proj, '.claude', '.state'), { recursive: true });
  const first = join(dir, 'Module.bsl');
  const second = join(dir, 'ManagerModule.bsl');
  for (const f of [first, second]) writeFileSync(f, BOM + 'Процедура Пример()\r\nКонецПроцедуры\r\n', 'utf8');

  // Состав правки — два файла. Гейт хранит их относительными путями, журнал получает
  // абсолютные: сверка обязана работать поверх этой разницы, иначе она бесполезна.
  const armed = (files) =>
    writeFileSync(
      join(proj, '.claude', '.state', 'qg-pending.json'),
      JSON.stringify({
        version: 2,
        sessions: {
          S: {
            armedAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            files: Object.fromEntries(files.map((f) => [f, { kind: 'bsl', edits: 1 }])),
          },
        },
      }),
      'utf8'
    );
  armed(['src/cf/CommonModules/М/Ext/Module.bsl', 'src/cf/CommonModules/М/Ext/ManagerModule.bsl']);

  const env = { CLAUDE_PROJECT_DIR: proj };
  const head =
    '## quality evidence\n\n' +
    '[qg scope: volume=C2, files=2, archetypes=[none], driver=volume, resolved=code:L1, config=default]\n' +
    '[qg sentinel: target=v8std, id=std454, status=found]\n';
  const tail = '[qg not_verified: dimension=compilation, reason=no_platform]\n';
  const evFile = writeBytes(
    'ev-coverage.md',
    head + '[qg applied: layer=hygiene, scope=file-encoding, ids=[qg:HYG-BOM], verdict=clean]\n' + tail
  );

  run('tools/hygiene-check.mjs', [first], { env });
  const partial = run('tools/evidence-validator.mjs', [evFile, '--gate'], { env });
  check('прогон по одному файлу из двух отклонён', partial.code === 2, partial.out.trim().slice(0, 170));
  check('назван непокрытый файл', partial.out.includes('ManagerModule.bsl'.toLowerCase()), partial.out.trim().slice(0, 200));

  run('tools/hygiene-check.mjs', [second], { env });
  const full = run('tools/evidence-validator.mjs', [evFile, '--gate'], { env });
  check('после прогона по обоим файлам след принят', full.code === 0, full.out.trim().slice(0, 170));

  // Разные вызовы одного инструмента складываются: контур законно гоняет его по частям, и
  // требовать один вызов на всё значило бы предписывать способ работы вместо результата.
  const cov = journal.coveredFiles(proj, 'file-encoding');
  check('покрытие складывается по всем прогонам', cov.files.size === 2, [...cov.files].join(', '));

  // Маска применимости: от проверки текстов запросов не требуется покрытие XML.
  armed(['src/cf/Catalogs/Товары.xml']);
  const xmlOnly = writeBytes(
    'ev-coverage-xml.md',
    head + '[qg applied: layer=code, scope=query-top-order, ids=[qg:QRY-TOP-WITHOUT-ORDER], verdict=clean]\n' + tail
  );
  run('tools/query-lint.mjs', [first], { env });
  const masked = run('tools/evidence-validator.mjs', [xmlOnly, '--gate'], { env });
  check('XML не требует покрытия проверкой запросов', masked.code === 0, masked.out.trim().slice(0, 170));

  // Каталог объекта покрывает файлы внутри: валидаторам XML путь дают и так, и так.
  armed(['src/cf/Roles/QG_Роль/Ext/Rights.xml']);
  const roleEv = writeBytes(
    'ev-coverage-role.md',
    head + '[qg applied: layer=xml, scope=structure-validation, ids=[qg:XML-STRUCT], verdict=clean]\n' + tail
  );
  writeFileSync(
    join(proj, '.claude', '.state', 'qg-runs.jsonl'),
    JSON.stringify({
      ts: '2026-06-01T00:00:00.000Z',
      scope: 'structure-validation',
      tool: 'tools/xml/role-validate.py',
      verdict: 'clean',
      files: ['src/cf/roles/qg_роль'],
    }) + '\n',
    'utf8'
  );
  const byDir = run('tools/evidence-validator.mjs', [roleEv, '--gate'], { env });
  check('каталог объекта покрывает файл внутри него', byDir.code === 0, byDir.out.trim().slice(0, 170));

  // Не у всякого XML выгрузки есть свой валидатор (служебные вроде Ext/Predefined.xml не
  // проверяет никто), поэтому непокрытый XML — предупреждение, а не отказ: ошибка на нём была
  // бы находкой за отсутствующий инструмент. Для .bsl такой оговорки нет, там строго.
  armed(['src/cf/Catalogs/Товары.xml', 'src/cf/Catalogs/Товары/Ext/Predefined.xml']);
  writeFileSync(
    join(proj, '.claude', '.state', 'qg-runs.jsonl'),
    JSON.stringify({
      ts: '2026-06-01T00:00:00.000Z',
      scope: 'structure-validation',
      tool: 'tools/xml/meta-validate.py',
      verdict: 'clean',
      files: ['src/cf/catalogs/товары.xml'],
    }) + '\n',
    'utf8'
  );
  const advisory = run('tools/evidence-validator.mjs', [roleEv, '--gate'], { env });
  check('непокрытый служебный XML не блокирует', advisory.code !== 2, advisory.out.trim().slice(0, 170));
  check('но о нём сказано', advisory.out.includes('predefined.xml'), advisory.out.trim().slice(0, 200));

  // Записи прежнего формата хранили количество: сверять нечем, но прогон был — предупреждение,
  // а не отказ. Иначе журнал, созданный прошлой версией, читался бы как доказательство пропуска.
  writeFileSync(
    join(proj, '.claude', '.state', 'qg-runs.jsonl'),
    JSON.stringify({ ts: '2026-06-01T00:00:00.000Z', scope: 'structure-validation', tool: 'tools/xml/meta-validate.py', verdict: 'clean', files: 3 }) + '\n',
    'utf8'
  );
  const oldFormat = run('tools/evidence-validator.mjs', [roleEv, '--gate'], { env });
  check('запись прежнего формата не блокирует', oldFormat.code !== 2, oldFormat.out.trim().slice(0, 170));
  check('о несверенном покрытии сказано', oldFormat.out.includes('покрытие не сверено'), oldFormat.out.trim().slice(0, 200));
}

// ---------------------------------------------------------------------------
section('«Не применимо» — тоже утверждение о прогоне');

{
  const proj = join(WORK, 'na-proj');
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(proj, { recursive: true });
  const env = { CLAUDE_PROJECT_DIR: proj };
  const head =
    '## quality evidence\n\n' +
    '[qg scope: volume=C1, files=1, archetypes=[none], driver=volume, resolved=code:L1, config=default]\n' +
    '[qg sentinel: target=v8std, id=std454, status=found]\n';
  const tail = '[qg not_verified: dimension=compilation, reason=no_platform]\n';

  const na = writeBytes(
    'ev-not-applicable.md',
    head + '[qg skipped: layer=code, scope=transaction-nesting, reason=not_applicable]\n' + tail
  );
  const before = run('tools/evidence-validator.mjs', [na, '--gate'], { env });
  check('«не применимо» без прогона отклонено', before.code === 2, before.out.trim().slice(0, 170));

  // Инструмент, посмотревший файл и заключивший, что правило к нему не относится, сделал
  // работу — и отмечается в журнале наравне с находкой.
  const module = join(proj, 'CommonModule.bsl');
  writeFileSync(module, BOM + 'Процедура Пример()\r\nКонецПроцедуры\r\n', 'utf8');
  const lint = run('tools/bsl-lint.mjs', [module], { env });
  check('bsl-lint печатает not_applicable', lint.out.includes('reason=not_applicable'), lint.out.trim().slice(-140));

  const after = run('tools/evidence-validator.mjs', [na, '--gate'], { env });
  check('после прогона «не применимо» принято', after.code === 0, after.out.trim().slice(0, 170));

  // Недоступность инструмента отметки не требует: ставить её некому.
  const unavailable = writeBytes(
    'ev-unavailable.md',
    head + '[qg skipped: layer=code, scope=static-analysis, planned=[bslls:*], reason=analyzer_unavailable]\n' + tail
  );
  const un = run('tools/evidence-validator.mjs', [unavailable, '--gate'], { env: { CLAUDE_PROJECT_DIR: join(WORK, 'na-empty') } });
  check('недоступность инструмента журнала не требует', un.code === 0, un.out.trim().slice(0, 170));
}

// ---------------------------------------------------------------------------
section('Словарь проверок — закрытый список scope');

{
  const scopes = await import(pathToFileURL(join(ROOT, 'tools', 'evidence-scopes.mjs')).href);
  const head =
    '## quality evidence\n\n' +
    '[qg scope: volume=C1, files=1, archetypes=[none], driver=volume, resolved=code:L1, config=default]\n' +
    '[qg sentinel: target=v8std, id=std454, status=found]\n';
  const tail = '[qg not_verified: dimension=compilation, reason=no_platform]\n';
  const env = { CLAUDE_PROJECT_DIR: join(WORK, 'journal-empty') };

  // Имя вне словаря принималось, пока проверялся только kebab-case. Так в отчёты попадали
  // `static-diagnostics` и `lsp-diagnostics` — прямо из примеров в документации.
  const unknown = writeBytes('ev-scope-unknown.md', head + '[qg applied: layer=code, scope=выдуманная-проверка, ids=[std454], verdict=clean]\n' + tail);
  const ru = run('tools/evidence-validator.mjs', [unknown, '--gate'], { env });
  check('имя вне словаря отклонено', ru.code === 2, ru.out.trim().slice(0, 130));

  const renamed = writeBytes('ev-scope-renamed.md', head + '[qg applied: layer=code, scope=lsp-diagnostics, ids=[bslls:*], verdict=violation:bslls:X]\n');
  const rr = run('tools/evidence-validator.mjs', [renamed, '--gate'], { env });
  check('переименованное имя отклонено', rr.code === 2, rr.out.trim().slice(0, 130));
  check('названо, как правильно', rr.out.includes('static-analysis'), rr.out.trim().slice(0, 160));

  // Слой у проверки один. Запись с чужим слоем читается как проверка другого контура —
  // и закрывает требование, которого не выполняла.
  const wrongLayer = writeBytes('ev-scope-layer.md', head + '[qg applied: layer=arch, scope=file-encoding, ids=[qg:HYG-BOM], verdict=clean]\n' + tail);
  const wl = run('tools/evidence-validator.mjs', [wrongLayer], { env });
  check('несовпадение слоя названо', wl.out.includes('относится к слою hygiene'), wl.out.trim().slice(0, 160));

  // Словарь — единственный источник: у каждой проверки с инструментом инструмент существует.
  for (const [scope, tool] of Object.entries(scopes.TOOL_BACKED)) {
    check(`инструмент проверки ${scope} на месте`, existsSync(join(ROOT, tool)), tool);
  }
  check('переименования ведут на существующие имена',
    Object.values(scopes.RENAMED).every((v) => scopes.isKnownScope(v)), Object.values(scopes.RENAMED).join(', '));
}

// ---------------------------------------------------------------------------
section('Непроанализированные файлы не выдаются за проверенные');

{
  const analyzer = await import(pathToFileURL(join(ROOT, 'tools', 'analyzer-run.mjs')).href);

  // Движок отчитывается по файлам, которые видел. Файл, не встреченный в отчёте, не проверен
  // ничем — раньше он просто исчезал, и общий вердикт выходил «clean».
  const stdout = [
    JSON.stringify({ type: 'file', path: 'src/cf/A.bsl', metrics: { functions: 2 }, diagnostics: [] }),
  ].join('\n');
  const norm = analyzer.normalizeBslAnalyzer(stdout, { root: '.', base: '.' });
  check('разобранные файлы перечислены', norm.seen.has('src/cf/A.bsl'), [...norm.seen].join(', '));
  check('чужих файлов в перечне нет', !norm.seen.has('src/cf/B.bsl'));

  const ev = analyzer.toEvidence({
    findings: [],
    sentinelResult: { status: 'found' },
    engine: 'bsl-analyzer',
    version: '0.2.66',
    unanalyzed: ['src/cf/B.bsl'],
  });
  check('непроверенные файлы заявлены записью not_verified',
    ev.some((l) => l.includes('dimension=static-analysis') && l.includes('not_in_analyzer_report')), ev.join(' | ').slice(0, 200));

  // Число непроверенных живёт в журнале, а не только в отчёте: заявление о полноте, взятое
  // из проверяемого документа, ничего не подтверждает.
  const proj = join(WORK, 'unanalyzed-proj');
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(join(proj, '.claude', '.state'), { recursive: true });
  writeFileSync(
    join(proj, '.claude', '.state', 'qg-runs.jsonl'),
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', scope: 'static-analysis', tool: 'tools/analyzer-run.mjs', verdict: 'clean', unanalyzed: 2 }) + '\n',
    'utf8'
  );
  const env = { CLAUDE_PROJECT_DIR: proj };
  const head =
    '## quality evidence\n\n' +
    '[qg scope: volume=C1, files=2, archetypes=[none], driver=volume, resolved=code:L1, config=default]\n' +
    '[qg sentinel: target=bslls, id=CommonModuleInvalidType, status=found]\n' +
    '[qg applied: layer=code, scope=static-analysis, ids=[bslls:*], verdict=clean]\n';
  const silent = writeBytes('ev-unanalyzed-silent.md', head + '[qg not_verified: dimension=compilation, reason=no_platform]\n');
  const rs = run('tools/evidence-validator.mjs', [silent, '--gate'], { env });
  check('молчание о непроверенных файлах отклонено', rs.code === 2, rs.out.trim().slice(0, 150));
  check('названо, сколько файлов не смотрели', rs.out.includes('2 из изменённых'), rs.out.trim().slice(0, 200));

  const declared = writeBytes(
    'ev-unanalyzed-declared.md',
    head +
      '[qg not_verified: dimension=static-analysis, reason=not_in_analyzer_report, files=2]\n' +
      '[qg not_verified: dimension=compilation, reason=no_platform]\n'
  );
  const rd = run('tools/evidence-validator.mjs', [declared, '--gate'], { env });
  check('заявленные непроверенные файлы принимаются', rd.code === 0, rd.out.trim().slice(0, 150));
}

// ---------------------------------------------------------------------------
process.stdout.write(`\n${'='.repeat(60)}\nПройдено: ${passed}, провалено: ${failures.length}\n`);
if (failures.length) {
  process.stdout.write('\nПровалившиеся проверки:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}\n`);
}
rmSync(WORK, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
