/**
 * Общая механика хуков: чтение payload и определение корня проекта.
 *
 * Вынесено в один модуль намеренно: обработка BOM и выбор корня должны быть
 * ОДИНАКОВЫМИ у всех хуков. Скопированная в два места, эта логика разъезжается
 * при первой же правке — ровно тот дефект, который плагин ищет в чужом коде.
 */

import { readFileSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
import { resolveProjectRoot } from '../tools/project-root.mjs';

const BOM_CODE = 0xfeff;

/**
 * Читает payload хука со stdin.
 *
 * BOM снимается обязательно: некоторые оболочки (PowerShell при передаче через pipe)
 * добавляют его в начало потока, и JSON.parse на нём падает — хук молча перестаёт
 * работать, что неотличимо от «нечего делать». Проверяем код символа, а не литерал:
 * невидимый символ в исходнике сам по себе источник ошибок.
 */
export function readPayload() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return null;
  }
  if (raw.charCodeAt(0) === BOM_CODE) raw = raw.slice(1);
  raw = raw.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Корень проекта: переменная харнесса, иначе подъём по маркерам от cwd сессии.
 *
 * Разрешение общее с инструментами (`tools/project-root.mjs`) — иначе хук взводит гейт в
 * одном каталоге состояния, а утилита снимает в другом, и оба сообщают об успехе.
 */
export function projectRoot(payload) {
  return resolveProjectRoot(payload?.cwd || process.cwd(), process.env).root;
}

/**
 * Путь относительно корня проекта — для читаемых сообщений.
 * Если файл вне корня (или пути несопоставимы), возвращает исходный:
 * полный путь честнее, чем неверный относительный.
 */
export function toProjectRelative(root, filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  try {
    if (!isAbsolute(filePath)) return normalized;
    const rel = relative(root, filePath);
    if (!rel) return normalized;
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) return normalized;
    return rel.replace(/\\/g, '/');
  } catch {
    return normalized;
  }
}
