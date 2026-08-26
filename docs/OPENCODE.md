# 1c-quality-gate в OpenCode

Плагин работает в двух харнесса: Claude Code (хуки `hooks/gate-arm.mjs` +
`hooks/gate-check.mjs`) и OpenCode (плагин `opencode/plugin/quality-gate.js`). Механика
гейта одна и та же — общее ядро `hooks/gate-core.mjs`, общие инструменты `tools/`, общий
skill `skills/quality-gate`. Различаются способ взвода, поведение при завершении сессии и
каталог состояния.

## Установка

```bash
git clone https://github.com/Romandredan/1c-quality-gate.git
cd 1c-quality-gate
./install-opencode.sh /путь/к/проекту
```

Скрипт раскладывает пакет в проект:

```text
.opencode/plugin/quality-gate.js   — плагин OpenCode
.opencode/plugin/package.json      — type: module (ESM-плагин под Node 20)
.opencode/skills/                  — все пять навыков контура (quality-gate,
                                     bsl-code-review, bsl-architecture-review,
                                     xml-structure-review, file-hygiene) и shared/
.opencode/commands/                — команды /gate и /gate-status
.opencode/agents/                  — субагенты контуров (mode: subagent)
.opencode/1c-quality-gate/         — механика: hooks/, tools/, assets/, docs/
opencode.json                      — MCP v8std (создаётся из «opencode.json.example»
                                     в каталоге opencode/, если файла не было)
```

После установки перезапустите OpenCode. Проверка: `/gate-status` отвечает «Гейт не взведён».

## Отличия от Claude Code

| Аспект | Claude Code | OpenCode |
|---|---|---|
| Взвод гейта | хук PostToolUse (matcher Write/Edit/…) | `tool.execute.before/after` (write/edit/multiedit/patch/notebookedit) |
| Подсказка о взводе | `additionalContext` хука | дописывается в результат инструмента |
| Контроль завершения | Stop-хук отказывает в завершении (exit 2) — **жёсткий гейт** | `session.idle`: плагин отправляет агенту сообщение и возвращает его к работе — **мягкий гейт** |
| Состояние | `.claude/.state/` | `.opencode/.state/` (через `QG_STATE_DIR`) |
| Корень проекта | `CLAUDE_PROJECT_DIR` | `QG_PROJECT_DIR` (выставляет плагин) |
| Снятие гейта | `node "$QG/tools/gate.mjs" release …` | то же самое, без изменений |

## Почему гейт в OpenCode мягкий

У OpenCode нет механизма, которым плагин мог бы запретить завершение сессии. Вместо
блокировки плагин ловит событие `session.idle` и отправляет агенту новое сообщение со
списком непроверенных правок — агент продолжает работу и прогоняет проверку. Пользователь
всегда может прервать сессию вручную: гейт настойчив, но не запирает.

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
