"""Отметка о прогоне валидатора в журнале плагина.

Тот же журнал, что пишут инструменты на Node (`tools/run-journal.mjs`), и та же цель:
вердикт `[qg applied: ... verdict=clean]` пишет в отчёт модель, и написанный по прочтении
кода он неотличим от полученного прогоном. Журнал делает обнаружимым молчание — заявлено
`applied` по проверке, у которой есть инструмент, а инструмент не запускался.

Модуль отдельный и подключается через try/except: валидаторы XML запускаются и поодиночке,
скопированными в чужой проект, и падение импорта не должно лишать пользователя проверки.

Формат строки согласован с `run-journal.mjs`: JSON Lines,
`{"ts": ..., "scope": ..., "tool": ..., "verdict": ..., "files": ...}`.
"""

import json
import os
from datetime import datetime, timezone

CONFIG_MARKER = ".1c-quality-gate.json"
GIT_MARKER = ".git"
STATE_DIR = os.path.join(".claude", ".state")
JOURNAL_FILE = "qg-runs.jsonl"
KEEP = 500


def project_root(start=None):
    """Корень проекта: переменная харнесса, иначе подъём по маркерам, иначе исходный каталог.

    Порядок повторяет `tools/project-root.mjs`. Разойдясь, два разрешителя писали бы журнал
    в разные каталоги, и валидатор следа не нашёл бы записей питоновского валидатора.
    """
    from_env = os.environ.get("CLAUDE_PROJECT_DIR")
    if from_env:
        return from_env

    here = os.path.abspath(start or os.getcwd())
    for marker in (CONFIG_MARKER, GIT_MARKER):
        current = here
        while True:
            if os.path.exists(os.path.join(current, marker)):
                return current
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
    return here


def record_run(scope, tool, verdict=None, files=None, root=None):
    """Дописывает запись о прогоне. Ошибка записи проглатывается: проверка важнее учёта."""
    if not scope or not tool:
        return None

    entry = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z",
        "scope": scope,
        "tool": tool,
    }
    if verdict:
        entry["verdict"] = verdict
    if files is not None:
        entry["files"] = files

    try:
        base = root or project_root()
        path = os.path.join(base, STATE_DIR, JOURNAL_FILE)
        os.makedirs(os.path.dirname(path), exist_ok=True)

        lines = []
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        lines.append(json.dumps(entry, ensure_ascii=False))

        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines[-KEEP:]) + "\n")
    except OSError:
        return entry
    return entry
