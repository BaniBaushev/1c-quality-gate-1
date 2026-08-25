/**
 * 1c-quality-gate — механика гейта качества 1С для OpenCode.
 *
 * Адаптация двух хуков Claude Code (gate-arm/gate-check) на плагинный API OpenCode:
 *
 *   - "tool.execute.before/after" — взвод гейта при правке .bsl/.os/XML метаданных
 *     (аналог PostToolUse). Подсказка дописывается в результат инструмента, чтобы
 *     модель увидела взвод немедленно, а не при попытке завершить работу.
 *   - "event: session.idle" — возврат агента к работе, пока гейт не снят
 *     (аналог Stop-хука).
 *
 * ВАЖНОЕ ОТЛИЧИЕ ОТ ХУКОВ CLAUDE CODE. В Claude Code Stop-хук жёстко отказывает
 * в завершении сессии (exit 2). У OpenCode такого механизма нет: плагин не может
 * запретить завершение, он отправляет агенту новое сообщение, и тот продолжает
 * работу. Это настойчивый, но мягкий гейт: пользователь всегда может прервать
 * сессию вручную. Чтобы цикл «idle → возврат» не был бесконечным спамом, на
 * неизменный состав правок даётся не более MAX_REPROMPTS автоматических возвратов;
 * счётчик сбрасывает любая новая правка.
 *
 * Логика взвода, формат состояния и тексты — в hooks/gate-core.mjs (единый источник,
 * общий с stdin-обёртками хуков Claude Code). Снятие гейта — только через
 * `tools/gate.mjs release`, он требует машиночитаемый след прогона.
 *
 * Любая внутренняя ошибка плагина гасится: гейт качества не имеет права ломать работу.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Максимум автоматических возвратов на неизменный состав правок. */
const MAX_REPROMPTS = 3;

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Корень пакета: из установленной раскладки install-opencode.sh плагин лежит в
 * <корень>/opencode/plugin/, значит пакет — два уровня вверх; из раскладки
 * «плагин рядом с пакетом» — ../1c-quality-gate. Проверяем по hooks/gate-core.mjs.
 */
function resolvePackageRoot() {
  for (const candidate of [
    resolve(PLUGIN_DIR, '..', '1c-quality-gate'),
    resolve(PLUGIN_DIR, '..', '..'),
  ]) {
    if (existsSync(join(candidate, 'hooks', 'gate-core.mjs'))) return candidate;
  }
  return null;
}

/** Файл, который правил инструмент: из аргументов вызова. */
function fileOfArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const p = args.filePath ?? args.file_path ?? args.path ?? args.file;
  return typeof p === 'string' && p ? p : null;
}

export const QualityGatePlugin = async ({ project, client, directory, worktree }) => {
  // Корень проекта: рабочее дерево точнее (git worktree), иначе каталог запуска.
  const root = worktree || directory || process.cwd();

  // Дочерние процессы (bash-инструмент агента) наследуют окружение процесса OpenCode:
  // инструменты пакета (gate.mjs, config.mjs, …) резолвят корень по QG_PROJECT_DIR даже
  // при запуске из подкаталога — тот же смысл, что у CLAUDE_PROJECT_DIR в исходнике.
  if (!process.env.QG_PROJECT_DIR) process.env.QG_PROJECT_DIR = root;

  // Состояние гейта OpenCode хранит отдельно от Claude Code: .opencode/.state
  // вместо .claude/.state. Инструменты пакета читают QG_STATE_DIR (tools/state-dir.mjs).
  if (!process.env.QG_STATE_DIR) process.env.QG_STATE_DIR = '.opencode/.state';
  // Одно значение на весь плагин: иначе при пользовательском QG_STATE_DIR взвод шёл бы
  // в .opencode/.state, а снятие через gate.mjs из оболочки — в каталог пользователя,
  // и гейт не снимался бы никогда.
  const stateEnv = { QG_STATE_DIR: process.env.QG_STATE_DIR };

  // Корень пакета и ядро механики гейта. Если импорт не удался (пакет установлен
  // частично), плагин молчит — ложный гейт хуже отсутствующего.
  const packageRoot = resolvePackageRoot();
  if (!packageRoot) return {};

  let core = null;
  let ensureConfig = null;
  try {
    // file-URL, а не путь: динамический import() по голому пути на Windows
    // падает с ERR_UNSUPPORTED_ESM_URL_SCHEME, и плагин молча не работал бы вообще.
    core = await import(pathToFileURL(join(packageRoot, 'hooks', 'gate-core.mjs')).href);
    ({ ensureConfig } = await import(pathToFileURL(join(packageRoot, 'tools', 'config.mjs')).href));
  } catch {
    return {};
  }

  // Карта callID → путь файла: аргументы известны на before, взводим на after,
  // когда правка фактически состоялась.
  const pendingCalls = new Map();

  // Защита от бесконечного цикла возвратов: ключ — отпечаток состава правок сессии.
  const reprompts = new Map();

  return {
    'tool.execute.before': async (input, output) => {
      try {
        const file = fileOfArgs(output?.args);
        if (file) pendingCalls.set(input.callID, file);
      } catch {
        /* никогда не ломаем вызов инструмента */
      }
    },

    'tool.execute.after': async (input, output) => {
      try {
        const file = pendingCalls.get(input.callID) || fileOfArgs(output?.args);
        pendingCalls.delete(input.callID);
        if (!file) return;

        // Реагируем только на инструменты правки, как matcher исходного хука.
        const tool = String(input.tool || '').toLowerCase();
        if (!['write', 'edit', 'multiedit', 'patch', 'notebookedit'].includes(tool)) return;

        const abs = isAbsolute(file) ? file : resolve(root, file);
        const armed = core.armGate({
          root,
          filePath: abs,
          sessionId: String(input.sessionID || 'unknown-session'),
          ensureConfig,
          env: stateEnv,
        });
        if (!armed) return;

        const hint = core.gateHint({ ...armed, packageRoot, mode: 'opencode' });
        // Аналог additionalContext хука Claude Code: подсказка уходит модели вместе
        // с результатом инструмента — о взводе узнают немедленно, а не на паузе.
        if (output && typeof output.output === 'string') {
          output.output += '\n\n' + hint;
        }
      } catch {
        /* гейт качества никогда не ломает работу пользователя */
      }
    },

    event: async ({ event }) => {
      try {
        if (event?.type !== 'session.idle') return;
        const sessionId = String(event?.properties?.sessionID || '');
        if (!sessionId) return;

        const state = core.readPendingState(root, stateEnv);
        if (!state) return;

        if (state.corrupt) {
          await client.session
            .prompt({
              path: { id: sessionId },
              body: {
                parts: [
                  {
                    type: 'text',
                    text:
                      `[ГЕЙТ КАЧЕСТВА 1С]\nМаркер ${stateEnv.QG_STATE_DIR}/qg-pending.json повреждён и не читается.\n` +
                      'Прогони skill quality-gate заново либо удали маркер вручную, если правки не требуют проверки.',
                  },
                ],
              },
            })
            .catch(() => {});
          return;
        }

        const mine = state.sessions?.[sessionId]?.files || {};
        const files = Object.entries(mine);
        if (files.length === 0) return;

        // Отпечаток состава правок: новая правка меняет его и сбрасывает счётчик
        // возвратов. На неизменный состав — не более MAX_REPROMPTS попыток.
        const fingerprint = JSON.stringify(
          files.map(([f, v]) => [f, v.edits, v.lastEdit]).sort()
        );
        const key = `${sessionId}:${fingerprint}`;
        const count = (reprompts.get(key) || 0) + 1;
        reprompts.set(key, count);
        if (reprompts.size > 200) reprompts.clear(); // долгоживущий процесс, карта не должна расти

        if (count > MAX_REPROMPTS) return;

        const foreign = Object.entries(state.sessions || {})
          .filter(([id]) => id !== sessionId)
          .reduce((sum, [, s]) => sum + Object.keys(s.files || {}).length, 0);

        await client.session
          .prompt({
            path: { id: sessionId },
            body: {
              parts: [
                {
                  type: 'text',
                  text: core.blockMessage({
                    sessionId,
                    files,
                    foreign,
                    packageRoot,
                    mode: 'opencode',
                    repeated: count,
                    maxReprompts: MAX_REPROMPTS,
                  }),
                },
              ],
            },
          })
          .catch(() => {});
      } catch {
        /* сбой плагина не должен запирать пользователя в сессии */
      }
    },
  };
};

export default QualityGatePlugin;
