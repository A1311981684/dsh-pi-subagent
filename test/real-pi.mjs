/**
 * Opt-in end-to-end check: one real `pi-dev` child, driven through the plugin's
 * `pi` tool.
 *
 * Run it directly — `node test/real-pi.mjs`. It is NOT part of `node --test`:
 * the guard below exits as a no-op when the Node test runner is the parent
 * (`NODE_TEST_CONTEXT` is set for every test child), so a bare `node --test`
 * never spends a model call.
 *
 * The run uses `--tools read` and a brief that forbids touching files, so the
 * only side effects are the ones `pi-dev` owns by design: its own throwaway Pi
 * state directory, the tee'd log (path printed below), and one line in
 * `~/.dsh/pi-delegations.log`.
 *
 * There is no Cordis container in a bare script, so this stand-in context
 * registers the tool and omits `sessions`/`sessionPersistence`. The plugin then
 * degrades the session projection with one `logger.warn` and still returns the
 * delegation result — the script prints both, so the degradation path is
 * exercised as well.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

/** The whole point of the run: a one-line answer, no file access. */
const BRIEF = [
  '这是一次端到端自测，不要读文件、不要改文件、不要运行 bash。',
  '只回复一行文字：pi-subagent-ok',
].join('\n');

async function main() {
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    console.log('real-pi: 当前在 node --test 下运行，跳过（直接跑 node test/real-pi.mjs）');
    return;
  }

  const cwd = process.cwd();
  const logDir = await mkdtemp(join(tmpdir(), 'dsh-subagent-pi-real-'));
  /** @type {any} */
  let definition;
  const warnings = [];
  const ctx = {
    logger: { warn: (...parts) => warnings.push(parts.join(' ')) },
    tools: {
      register(candidate) {
        definition = candidate;
      },
    },
  };

  apply(ctx, { logDir, tools: 'read' });
  if (definition === undefined) throw new Error('apply 没有注册 pi 工具');

  const started = Date.now();
  const value = await definition.execute({ prompt: BRIEF }, {
    agent: {
      id: 'real-pi-check',
      options: {},
      session: { id: 'real-pi-check', header: { cwd, isSeeded: false } },
    },
    signal: new AbortController().signal,
    callId: 'real-pi-check',
  });
  console.log(`耗时: ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`stopReason: ${value.stopReason}`);
  console.log(`childSessionId: ${value.childSessionId === '' ? '(not projected)' : value.childSessionId}`);
  for (const block of definition.output.render({ prompt: BRIEF }, value)) {
    console.log(`--- ${block.type} ---\n${block.text}`);
  }
  if (value.diagnostic !== undefined) console.log(`diagnostic: ${value.diagnostic}`);
  for (const warning of warnings) console.log(`[logger] ${warning}`);
  console.log(`日志目录: ${logDir}`);

  if (value.stopReason !== 'completed') {
    process.exitCode = 1;
    return;
  }
  if (!value.output.includes('pi-subagent-ok')) {
    console.error('real-pi: 输出里没有 pi-subagent-ok，端到端未通过');
    process.exitCode = 1;
    return;
  }
  console.log('real-pi: OK');
}

await main();
