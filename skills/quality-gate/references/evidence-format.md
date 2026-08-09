# Формат следа проверок (evidence)

Машиночитаемый след прогона. Живёт в отчёте, в секции `## quality evidence`, по одной
строке на проверку. Проверяется `tools/evidence-validator.mjs`.

## Зачем он нужен

Невыполненная проверка неотличима от выполненной, если после неё ничего не остаётся.
Отчёт «нарушений не найдено» одинаково выглядит и когда всё проверено и чисто, и когда
инструмент не запустился, и когда слой просто забыли. След делает разницу видимой:
каждая проверка оставляет запись, **включая обоснованный пропуск**.

Валидатор отвергает записи, которые лишь выглядят заполненными: пустое обязательное поле
или пустой список идентификаторов — это не «проверил ничего», а отсутствие проверки.

## Грамматика

```
[qg <тип>: <ключ>=<значение>, <ключ>=[<элемент>,<элемент>], ...]
```

Значение — либо скаляр без запятых и скобок, либо список в квадратных скобках.

## Типы записей

### `scope` — профиль изменения (ровно одна за прогон)

```
[qg scope: volume=C2, files=3, loc=+87/-12, archetypes=[query,transaction],
           complexity=[nesting:4], driver=archetype:transaction,
           resolved=code:L2|arch:skip|xml:n/a|hygiene:full]
```

Обязательные поля: `volume`, `files`, `archetypes`, `driver`, `resolved`.

`volume` — один из `C0`, `C1`, `C2`, `C3`. `archetypes` — список сработавших меток, либо
`[none]`, если ни одна не сработала (пустой список запрещён — он неотличим от «не считали»).
`driver` — что подняло глубину: `volume`, `archetype:<имя>` или `complexity:<метрика>`.

### `applied` — проверка выполнена

```
[qg applied: layer=code, scope=query-in-loop, ids=[std436,bslls:QueryInLoop], verdict=clean]
[qg applied: layer=arch, scope=module-responsibility, ids=[qg:ARCH-A1], verdict=violation:qg:ARCH-A1]
```

Обязательные поля: `layer`, `scope`, `ids`, `verdict`.

`layer` — `code`, `arch`, `xml` или `hygiene`. `scope` — kebab-case, что именно проверялось.
`ids` — непустой список идентификаторов: `stdNNN`, `bslls:<Код>`, `acc:NNN`, `v8cs:<код>`,
`qg:<ЭВРИСТИКА>`, `patterns:<путь>`. `verdict` — `clean` либо `violation:<id>`.

### `skipped` — проверка не выполнялась, и это заявлено

```
[qg skipped: layer=arch, reason=volume_below_threshold]
[qg skipped: layer=code, scope=lsp-diagnostics, planned=[bslls:*], reason=lsp_unavailable]
```

Обязательные поля: `layer`, `reason`.

Типовые причины: `volume_below_threshold`, `not_applicable`, `contour_not_installed`,
`lsp_unavailable`, `rlm_unavailable`, `platform_unavailable`, `stale_or_unavailable_index`.

### `not_verified` — измерение непроверяемо доступными средствами

```
[qg not_verified: dimension=compilation, reason=no_platform]
```

Обязательные поля: `dimension`, `reason`.

Отличие от `skipped`: `skipped` — «слой можно было прогнать, но не требовалось или инструмент
лежал»; `not_verified` — «этого в принципе нельзя проверить тем, что есть».

Главный случай — **компилируемость тел модулей**. Ни загрузка конфигурации из файлов, ни
выгрузка, ни валидаторы XML не компилируют тела: они разбирают структуру. Синтаксическая
ошибка внутри процедуры проходит их все и всплывает лишь при инициализации модуля в базе.
Ловит только проверка конфигурации платформой или реальный запуск.

Поэтому валидатор в строгом режиме **отклоняет прогон, где все проверки `clean`, но нет ни
одной записи `not_verified`**: полностью зелёный отчёт, умалчивающий о непроверяемом, — это
и есть та ложная зелень, против которой существует весь механизм.

### `sentinel` — источник стандартов жив

```
[qg sentinel: target=v8std, id=std454, status=found]
```

Обязательные поля: `target`, `status` (`found` либо `not_found`).

Без этой записи «нарушений стандартов не найдено» неотличимо от «сервис стандартов
недоступен». Прогон с `status=not_found` считается недостоверным.

## Переиспользование доказательств

Гейт — требование к **текущему состоянию артефакта**, а не просьба ещё раз позвать тот же
инструмент. Если слой уже отработал по этому содержимому файла, повторный прогон ничего не
добавляет, кроме расхода времени.

Отметить проверенное:

```bash
node "$QG/tools/gate.mjs" verify --layer code <файл> [<файл> ...]
```

Отметка хранится в состоянии гейта по паре файл × слой. Перед повторным прогоном слоя
загляни в `gate.mjs status`: файлы с уже проставленной отметкой можно пропустить, записав
`skipped` с причиной `verified_earlier`.

**Инвалидация автоматическая.** Любая правка файла снимает все его отметки — это делает хук
взвода. Устаревшее доказательство переиспользовано быть не может по построению: оно относится
к другому содержимому.

Это единственный случай, когда пропуск слоя не требует отдельного обоснования: причина
объективна и проверяема по состоянию.

## Режимы валидатора

```bash
node tools/evidence-validator.mjs <файл>          # lint: только оформление
node tools/evidence-validator.mjs <файл> --gate   # строгий, для снятия гейта
```

Строгий режим дополнительно требует: ровно одну запись `scope`, хотя бы одну
`applied`/`skipped`, подтверждённый `sentinel` и `not_verified` при полностью чистом вердикте.

Коды выхода: `0` — чисто, `1` — предупреждения, `2` — блокирующие нарушения.

## Пример полного следа

```markdown
## quality evidence

[qg scope: volume=C1, files=1, loc=+18/-3, archetypes=[query], complexity=[none], driver=archetype:query, resolved=code:L2|arch:skip|xml:n/a|hygiene:full]
[qg sentinel: target=v8std, id=std454, status=found]
[qg applied: layer=hygiene, scope=file-encoding, ids=[qg:HYG-BOM,qg:HYG-DASH], verdict=clean]
[qg applied: layer=code, scope=query-in-loop, ids=[std436,bslls:QueryInLoop], verdict=clean]
[qg applied: layer=code, scope=attribute-access, ids=[std437], verdict=violation:std437]
[qg skipped: layer=arch, reason=volume_below_threshold]
[qg skipped: layer=xml, reason=not_applicable]
[qg not_verified: dimension=compilation, reason=no_platform]
```

Здесь видно не только что нашли, но и почему архитектурный контур не гонялся, почему XML
неприменим и что компилируемость осталась непроверенной. Именно это отличает след от
подписи «проверено».
