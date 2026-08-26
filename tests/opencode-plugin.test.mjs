#!/usr/bin/env node
/**
 * Тесты плагина OpenCode (opencode/plugin/quality-gate.js): взвод гейта на правку,
 * подсказка в результате инструмента, мягкий гейт на session.idle с пределом возвратов.
 * Запуск: node tests/opencode-plugin.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const PLUGIN_URL = pathToFileURL(join(import.meta.dirname, '..', 'opencode', 'plugin', 'quality-gate.js')).href;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`ok — ${name}`); }
  else { failed++; console.error(`FAIL — ${name}`); }
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'qg-oc-test-'));
  return root;
}

function makeClient() {
  const prompts = [];
  return {
    prompts,
    session: {
      prompt: async (req) => { prompts.push(req); return {}; },
    },
  };
}

async function makePlugin(root, client) {
  const mod = await import(PLUGIN_URL);
  const factory = mod.QualityGatePlugin || mod.default;
  return await factory({ project: {}, client, directory: root, worktree: root });
}

const root = makeProject();
const client = makeClient();
const plugin = await makePlugin(root, client);

check('плагин возвращает обработчики', typeof plugin['tool.execute.after'] === 'function' && typeof plugin.event === 'function');
check('плагин выставляет QG_PROJECT_DIR', process.env.QG_PROJECT_DIR === root);
check('плагин выставляет QG_STATE_DIR', process.env.QG_STATE_DIR === '.opencode/.state');

// Правка .bsl взводит гейт и дописывает подсказку в результат инструмента.
const bslPath = join(root, 'CommonModules', 'Модуль', 'Module.bsl');
mkdirSync(join(root, 'CommonModules', 'Модуль'), { recursive: true });
writeFileSync(bslPath, 'Процедура Тест() КонецПроцедуры\n', 'utf8');

const out = { output: 'файл записан' };
await plugin['tool.execute.before']({ callID: 'c1', sessionID: 's1' }, { args: { filePath: bslPath } });
await plugin['tool.execute.after']({ callID: 'c1', sessionID: 's1', tool: 'write' }, out);

const pendingPath = join(root, '.opencode', '.state', 'qg-pending.json');
check('правка .bsl взвела гейт в .opencode/.state', existsSync(pendingPath));
check('подсказка дописана в результат инструмента', out.output.includes('файл записан') && out.output.length > 'файл записан'.length + 10);

// Правка нецелевого файла гейт не трогает: нового взвода не происходит.
const mdPath = join(root, 'README.md');
writeFileSync(mdPath, '# test\n', 'utf8');
const before = readFileSync(pendingPath, 'utf8');
await plugin['tool.execute.after']({ callID: 'c2', sessionID: 's1', tool: 'write' }, { args: { filePath: mdPath }, output: 'ok' });
check('правка .md не меняет маркер', readFileSync(pendingPath, 'utf8') === before);

// Инструмент чтения не взводит гейт даже на .bsl.
const before2 = readFileSync(pendingPath, 'utf8');
await plugin['tool.execute.after']({ callID: 'c3', sessionID: 's1', tool: 'read' }, { args: { filePath: bslPath }, output: 'ok' });
check('read на .bsl не взводит гейт', readFileSync(pendingPath, 'utf8') === before2);

// session.idle: плагин возвращает агента к работе.
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
check('session.idle отправляет возврат агенту', client.prompts.length === 1);
check('возврат уходит в нужную сессию', client.prompts[0]?.path?.id === 's1');
check('текст возврата честный для мягкого гейта', /качеств/i.test(client.prompts[0]?.body?.parts?.[0]?.text || ''));

// Предел возвратов: на неизменный состав правок — не более MAX_REPROMPTS.
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
check('возвратов не более MAX_REPROMPTS на неизменный состав', client.prompts.length === 3);

// Исчерпание лимита фиксируется в журнале прогонов записью без scope — наблюдаемой,
// но не засчитываемой валидатором охвата.
const journalPath = join(root, '.opencode', '.state', 'qg-runs.jsonl');
check('сдача мягкого гейта записана в журнал', existsSync(journalPath));
const surrender = existsSync(journalPath)
  ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.event === 'gate-surrendered')
  : null;
check('запись сдачи без scope (инертна для валидатора)', surrender && !('scope' in surrender) && surrender.sessionId === 's1');

// Новая правка сбрасывает счётчик возвратов.
writeFileSync(bslPath, 'Процедура Тест2() КонецПроцедуры\n', 'utf8');
await plugin['tool.execute.after']({ callID: 'c4', sessionID: 's1', tool: 'edit' }, { args: { filePath: bslPath }, output: 'ok' });
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
check('новая правка сбрасывает счётчик возвратов', client.prompts.length === 4);

// Чужая сессия без своих правок не получает возвратов.
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's2' } } });
check('чужая сессия без правок не получает возврат', client.prompts.length === 4);

// События других типов игнорируются.
await plugin.event({ event: { type: 'session.error', properties: { sessionID: 's1' } } });
check('прочие события игнорируются', client.prompts.length === 4);

// Повреждённый маркер: сообщение о повреждении, без падения.
writeFileSync(pendingPath, '{не json', 'utf8');
const plugin2 = await makePlugin(root, client);
await plugin2.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
check('повреждённый маркер даёт сообщение, а не сбой', client.prompts.length === 5 && /поврежд/i.test(client.prompts[4]?.body?.parts?.[0]?.text || ''));

// Ошибки клиента гасятся.
const badClient = { session: { prompt: async () => { throw new Error('network'); } } };
rmSync(pendingPath, { force: true });
const plugin3 = await makePlugin(root, badClient);
await plugin3['tool.execute.after']({ callID: 'c9', sessionID: 's9', tool: 'write' }, { args: { filePath: bslPath }, output: 'ok' });
let survived = true;
try {
  await plugin3.event({ event: { type: 'session.idle', properties: { sessionID: 's9' } } });
} catch { survived = false; }
check('ошибка клиента гасится', survived);

rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
