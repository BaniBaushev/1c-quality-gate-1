# 1c-quality-gate в OpenCode

Плагин работает в двух харнесса: Claude Code (хуки `hooks/gate-arm.mjs` +
`hooks/gate-check.mjs`) и OpenCode (плагин `opencode/plugin/quality-gate.js`). Механика
гейта одна и та же — общее ядро `hooks/gate-core.mjs`, общие инструменты `tools/`, общий
skill `skills/quality-gate`. Различаются способ взвода, поведение при завершении сессии и
каталог состояния.

## Установка

Одна строка в `opencode.json` проекта (или в `~/.config/opencode/opencode.json`). Ключ
зависит от версии OpenCode:

```json
// OpenCode 2.x
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["1c-quality-gate@git+https://github.com/Romandredan/1c-quality-gate.git#v3.0.0"]
}
```

```json
// OpenCode 1.x (>= 1.18.29)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["1c-quality-gate@git+https://github.com/Romandredan/1c-quality-gate.git#v3.0.0"]
}
```

Перезапустите OpenCode — пакет установится сам и попадёт в кэш
`~/.cache/opencode/packages/`. Проверка: `/gate-status` отвечает «Гейт не взведён».

**Тег закрепляйте.** Без `#v3.0.0` установка тянет текущее состояние ветки `main`, а не
выпущенную версию, и два харнесса разъезжаются: Claude Code ставится по тому же тегу через
`marketplace.json`. Обновление — смена тега в этой строке и перезапуск. Если новая версия
не подхватилась, очистите кэш пакета: Bun кэширует установленное по спецификации.

**Две версии — один плагин.** Точка входа `opencode/plugin/quality-gate.js` экспортирует
определение сразу для обеих линеек: V2 вызывает `setup(ctx)`, V1 — `server()` (объектные
точки входа V1 понимает начиная с 1.18.29; на более ранних V1 обновите OpenCode).
Механика гейта общая, различаются только способы регистрации и события жизненного цикла.

Копировать в проект нечего: состав объявляется самим плагином, а инструменты находит агент
по переменной `QG_ROOT`, которую плагин подставляет в окружение оболочки.

| Что регистрируется | OpenCode 1.x | OpenCode 2.x |
|---|---|---|
| пять навыков контура и `shared/` | `config.skills.paths` — каталог `skills/` внутри пакета | `ctx.skill.transform` — каждый навык с абсолютным путём и содержимым |
| команды `/gate`, `/gate-status` | `config.command`, тело файла становится `template` | `ctx.command.transform`, `execute` шлёт шаблон через `ctx.session.prompt` |
| субагенты `bsl-verifier`, `bsl-scout`, `xml-runner` | `config.agent` из общего каталога `agents/`, тело становится `prompt` | `ctx.agent.transform` (update upsert'ит), тело становится `system`, права — `permissions` с учётом last-match-wins |
| MCP-сервер стандартов `v8std` | `config.mcp` | `ctx.mcp.transform`, тип `remote` |
| окружение оболочки (`QG_ROOT` и др.) | хук `shell.env` | `ctx.shell.hook('create.before')` |
| взвод гейта | `tool.execute.before/after` | `ctx.tool.hook('execute.before'/'execute.after')` |

Своё имя всегда сильнее: запись пользователя с тем же именем плагин не перекрывает.

**Единственный ручной шаг** — рабочее состояние сессий не коммитить. Добавьте в
`.gitignore` проекта:

```gitignore
.opencode/.state/
.qg-analyzer/
```

**Статический анализатор.** Ставится сам при первом прогоне и живёт в каталоге, общем для
обоих харнессов: по умолчанию `~/.claude/plugins/data/1c-quality-gate-1c-quality-gate/`.
Имя историческое, каталог общий намеренно — бинарник закреплён по версии и SHA-256, для
Claude Code и OpenCode он побайтово один, а своя копия на харнесс стоила бы вторых
шестидесяти мегабайт. Если каталог с чужим именем на диске не нужен, задайте `QG_DATA_DIR` —
она перекрывает путь целиком. Разбор — [INSTALL.md](INSTALL.md).

## Отличия от Claude Code

| Аспект | Claude Code | OpenCode |
|---|---|---|
| Взвод гейта | хук PostToolUse (matcher Write/Edit/…) | `tool.execute.before/after` (V2: `ctx.tool.hook`) на write/edit/multiedit/patch/notebookedit |
| Подсказка о взводе | `additionalContext` хука | дописывается в результат инструмента (строка или последняя текстовая часть) |
| Контроль завершения | Stop-хук отказывает в завершении (exit 2) — **жёсткий гейт** | V1: `session.idle`; V2: durable-событие `session.execution.succeeded` (`failed`/`interrupted` — не пауза) — плагин отправляет агенту сообщение и возвращает его к работе, **мягкий гейт** |
| Состояние | `.claude/.state/` | `.opencode/.state/` (через `QG_STATE_DIR`) |
| Корень проекта | `CLAUDE_PROJECT_DIR` | `QG_PROJECT_DIR` из хука `shell.env` |
| Путь к инструментам | разрешается перебором в навыке | `QG_ROOT` из хука `shell.env` |
| Снятие гейта | `node "$QG/tools/gate.mjs" release …` | то же самое, без изменений |

## Почему гейт в OpenCode мягкий

У OpenCode нет механизма, которым плагин мог бы запретить завершение сессии. Вместо
блокировки плагин ловит паузу агента — в V1 потоковое `session.idle`, в V2 durable-событие
`session.execution.succeeded` (потокового idle в V2 нет; `failed` и `interrupted` паузой
не считаются — прерванный прогон означает, что пользователь сам остановил работу) — и
отправляет агенту новое сообщение со списком непроверенных правок: агент продолжает работу
и прогоняет проверку. Пользователь всегда может прервать сессию вручную: гейт настойчив,
но не запирает.

Чтобы цикл «idle → возврат» не превращался в бесконечный спам, на неизменный состав правок
даётся не более трёх автоматических возвратов (`MAX_REPROMPTS` в
`opencode/plugin/quality-gate.js`). Счётчик ведётся по сессии, любая новая правка меняет
отпечаток состава и сбрасывает его: пока работа идёт, возвраты продолжаются. Исчерпание
лимита фиксируется записью `gate-surrendered` в журнале прогонов
(`.opencode/.state/qg-runs.jsonl`) — отказ от проверки остаётся наблюдаемым фактом,
а не тихим умолчанием. Запись намеренно без поля `scope`, поэтому валидатор охвата
не засчитывает её как прогон.

Требования к снятию гейта не смягчаются: `gate.mjs release` по-прежнему требует
машиночитаемый след прогона, валидатор следа общий для обоих харнессов.
