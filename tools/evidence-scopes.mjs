/**
 * Словарь `scope` записей следа — закрытый список того, что вообще бывает проверено.
 *
 * Зачем понадобился. Одну и ту же проверку документация называла тремя именами:
 * `static-diagnostics` в навыке контура кода, `lsp-diagnostics` в описании формата, а
 * инструмент печатал `static-analysis`. Валидатор проверял `scope` только на kebab-case и
 * принимал все три. Это не опечатка в тексте, а документированное приглашение написать
 * строку следа, которую ни один инструмент плагина не печатает: модель добросовестно
 * копирует пример из навыка и получает запись, неотличимую от полученной прогоном.
 *
 * Поле `tool` — вторая причина списка. У проверки либо есть исполняемый инструмент, либо
 * её выполняет модель. Для первых строка следа обязана происходить из прогона, и это
 * теперь проверяется журналом (`run-journal.mjs`): заявить `verdict=clean` по чтению кода
 * там, где есть инструмент, больше нельзя. Для вторых (архитектурные признаки, разбор
 * стандартов) инструмента нет и требовать нечего — они и остаются на совести прогона.
 *
 * Список закрытый намеренно. Новое имя, которого здесь нет, — либо опечатка, либо проверка,
 * о которой не знает ни валидатор, ни `validate-package.mjs`; в обоих случаях запись
 * выглядит заполненной, а закрывает пустоту.
 */

/** @type {Record<string, { layer: string, tool: string|null, about: string }>} */
export const SCOPES = {
  // --- контур code ---------------------------------------------------------
  'static-analysis': {
    layer: 'code',
    tool: 'tools/analyzer-run.mjs',
    about: 'диагностики статического анализатора (bsl-analyzer / BSL LS)',
  },
  'query-alias-shadowing': {
    layer: 'code',
    tool: 'tools/query-lint.mjs',
    about: 'псевдоним источника затеняет колонку временной таблицы',
  },
  'query-top-order': {
    layer: 'code',
    tool: 'tools/query-lint.mjs',
    about: '«ПЕРВЫЕ N» без «УПОРЯДОЧИТЬ ПО»',
  },
  'transaction-nesting': {
    layer: 'code',
    tool: 'tools/bsl-lint.mjs',
    about: 'своя транзакция внутри неявной транзакции обработчика',
  },
  'query-in-loop': {
    layer: 'code',
    tool: null,
    about: 'запрос внутри цикла, N+1 (#std436)',
  },
  'attribute-access': {
    layer: 'code',
    tool: null,
    about: 'обращение к реквизитам через точку в цикле (#std437)',
  },
  'api-verification': {
    layer: 'code',
    tool: null,
    about: 'сигнатуры платформы, существование и экспортность общих модулей',
  },
  'naming-std454': {
    layer: 'code',
    tool: null,
    about: 'именование по #std454',
  },
  'query-execution': {
    layer: 'code',
    tool: null,
    about: 'попытка выполнить запрос на живой платформе',
  },
  'adversarial-audit': {
    layer: 'code',
    tool: null,
    about: 'состязательный аудит слоя 3 (запускается только по согласию пользователя)',
  },

  // --- контур arch ---------------------------------------------------------
  'module-responsibility': {
    layer: 'arch',
    tool: null,
    about: 'границы ответственности модуля, модуль-комбайн',
  },
  'branching-dispatch': {
    layer: 'arch',
    tool: null,
    about: 'ветвление вместо диспетчеризации',
  },
  'call-graph-signs': {
    layer: 'arch',
    tool: null,
    about: 'признаки по графу вызовов (вызывающие, мёртвые экспорты)',
  },

  // --- контур xml ----------------------------------------------------------
  'structure-validation': {
    layer: 'xml',
    tool: 'tools/xml/meta-validate.py',
    about: 'структура файла метаданных: обязательные узлы, порядок, типы',
  },
  'registration-check': {
    layer: 'xml',
    tool: 'tools/xml/orphan-check.mjs',
    about: 'сверка «диск ↔ состав»: файл вне состава и состав без файла',
  },
  'uuid-uniqueness': {
    layer: 'xml',
    tool: 'tools/xml/uuid-unique.mjs',
    about: 'дубли UUID объектов метаданных в пределах выгрузки',
  },

  // --- контур hygiene ------------------------------------------------------
  'file-encoding': {
    layer: 'hygiene',
    tool: 'tools/hygiene-check.mjs',
    about: 'кодировка, BOM, переводы строк, недопустимые символы',
  },
};

/** Имена, у которых есть исполняемый инструмент: их нельзя заявить без прогона. */
export const TOOL_BACKED = Object.fromEntries(
  Object.entries(SCOPES)
    .filter(([, v]) => v.tool)
    .map(([k, v]) => [k, v.tool])
);

/**
 * Имена, встречавшиеся в документации до сведения словаря.
 *
 * Нужны не для совместимости, а для сообщения: «неизвестный scope» на `lsp-diagnostics`
 * оставляет читателя гадать, как правильно, а прежние отчёты ещё существуют.
 */
export const RENAMED = {
  'lsp-diagnostics': 'static-analysis',
  'static-diagnostics': 'static-analysis',
  branching: 'branching-dispatch',
  'api-signatures': 'api-verification',
  'common-modules': 'api-verification',
  'object-structure': 'structure-validation',
};

export function isKnownScope(scope) {
  return Object.prototype.hasOwnProperty.call(SCOPES, scope);
}
