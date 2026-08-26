#!/usr/bin/env bash
# Установка 1c-quality-gate для OpenCode в проект 1С.
# Из каталога репозитория: ./install-opencode.sh /путь/к/проекту
#
# Раскладка после установки (в проекте):
#   .opencode/plugin/quality-gate.js     — плагин (взвод гейта + мягкий гейт на session.idle)
#   .opencode/plugin/package.json        — type: module (ESM-плагин под Node 20)
#   .opencode/skills/<пять навыков>/     — quality-gate, bsl-code-review, bsl-architecture-review,
#                                          xml-structure-review, file-hygiene
#   .opencode/skills/shared/             — общий контракт маршрутизации навыков
#   .opencode/commands/                  — /gate и /gate-status
#   .opencode/agents/                    — субагенты контуров
#   .opencode/1c-quality-gate/           — механика: hooks/, tools/, assets/, docs/
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="${1:-}"

if [ -z "$DST" ]; then
  echo "Использование: ./install-opencode.sh /путь/к/проекту" >&2
  exit 1
fi
if [ ! -d "$DST" ]; then
  echo "Каталог проекта не существует: $DST" >&2
  exit 1
fi
for required in hooks/gate-core.mjs tools/gate.mjs skills/quality-gate/SKILL.md opencode/plugin/quality-gate.js opencode/plugin/package.json; do
  if [ ! -e "$SRC/$required" ]; then
    echo "Запустите скрипт из корня репозитория 1c-quality-gate: не найден $required" >&2
    exit 1
  fi
done

mkdir -p "$DST/.opencode/plugin" "$DST/.opencode/skills" "$DST/.opencode/commands" "$DST/.opencode/agents"
cp "$SRC/opencode/plugin/quality-gate.js" "$DST/.opencode/plugin/"
# package.json рядом с плагином: без него .js-плагин — не ESM, и на Node 20 загрузка
# падает с SyntaxError ещё до первого вызова (Node ≥22.12 терпит, 20.x — нет).
cp "$SRC/opencode/plugin/package.json" "$DST/.opencode/plugin/"

# ВСЕ навыки контура, а не только точка входа: quality-gate маршрутизирует прогон на
# остальные четыре, и без них маршрут ведёт в никуда — прогон объявлен, но не выполняется.
for skill in quality-gate bsl-code-review bsl-architecture-review xml-structure-review file-hygiene; do
  cp -r "$SRC/skills/$skill" "$DST/.opencode/skills/"
done
# Общий контракт маршрутизации, на который ссылаются навыки.
[ -d "$SRC/shared" ] && cp -r "$SRC/shared" "$DST/.opencode/skills/"

cp "$SRC/opencode/commands/"*.md "$DST/.opencode/commands/"
cp "$SRC/opencode/agents/"*.md "$DST/.opencode/agents/"

# Механика гейта: плагин ищет пакет как ../1c-quality-gate относительно себя.
mkdir -p "$DST/.opencode/1c-quality-gate"
for d in hooks tools assets docs; do
  [ -d "$SRC/$d" ] && cp -r "$SRC/$d" "$DST/.opencode/1c-quality-gate/"
done

# MCP v8std — обязательная зависимость: без него прогон недостоверен (часовой не подтверждён).
if [ -f "$DST/opencode.json" ]; then
  if ! grep -q '"v8std"' "$DST/opencode.json"; then
    echo "ВНИМАНИЕ: добавьте в $DST/opencode.json секцию mcp из opencode/opencode.json.example —" >&2
    echo "без MCP v8std гейт не снимается (часовой источника стандартов не подтверждён)." >&2
  fi
else
  cp "$SRC/opencode/opencode.json.example" "$DST/opencode.json"
  echo "Создан $DST/opencode.json с MCP v8std."
fi

# .gitignore: рабочее состояние сессий не коммитим.
GITIGNORE="$DST/.gitignore"
touch "$GITIGNORE"
grep -qxF '.opencode/.state/' "$GITIGNORE" || echo '.opencode/.state/' >> "$GITIGNORE"
grep -qxF '.qg-analyzer/' "$GITIGNORE" || echo '.qg-analyzer/' >> "$GITIGNORE"

echo "Установлено в $DST/.opencode/"
echo "Перезапустите OpenCode и проверьте: /gate-status должен ответить «Гейт не взведён»."
