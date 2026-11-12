/**
 * Opt-in end-to-end check: one real `pi-dev` child, driven through the plugin.
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
 * This script needs a minimal stand-in for `ctx.subprocess` because a bare
 * script has no Cordis container. The stand-in uses `node:child_process`; the
 * plugin itself never does — it always goes through `ctx.subprocess.spawn`.
 */

import { spawn as spawnChild } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

/** The whole point of the run: a one-line answer, no file access. */
const BRIEF = [
  '这是一次端到端自测，不要读文件、不要改文件、不要运行 bash。',
  '只回复一行文字：pi-subagent-ok',
].join('\n');

/** Keep at most `maxBytes` of `text` (the tail), without splitting a character. */
function tail(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/** The smallest `ctx.subprocess` that satisfies the seam for one sink. */
function nodeSubprocess() {
  return {
    spawn(spec) {
      const [program, ...args] = spec.argv;
      const child = spawnChild(program, args, {
        cwd: spec.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      const chunks = { stdout: [], stderr: [] };
      const caps = {
        stdout: typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 262_144,
        stderr: typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : 262_144,
      };
      child.stdout.on('data', (chunk) => chunks.stdout.push(chunk));
      child.stderr.on('data', (chunk) => chunks.stderr.push(chunk));

      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });

      const text = (stream) => tail(Buffer.concat(chunks[stream]).toString('utf8'), caps[stream]);
      const reader = (stream) => ({
        readFrom: () => ({ text: text(stream), nextOffset: 0, lossy: false }),
      });

      let killTimer;
      const terminate = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, spec.graceMs));
        killTimer.unref?.();
      };
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) terminate();
        else spec.signal.addEventListener('abort', terminate, { once: true });
      }
      done.then(
        () => clearTimeout(killTimer),
        () => clearTimeout(killTimer),
      );

      return {
        done,
        terminate,
        async waitForExit() {
          try {
            await done;
          } catch {
            /* the range is already gone */
          }
          return true;
        },
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
      };
    },
  };
}

async function main() {
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    console.log('real-pi: 当前在 node --test 下运行，跳过（直接跑 node test/real-pi.mjs）');
    return;
  }

  const cwd = process.cwd();
  const logDir = await mkdtemp(join(tmpdir(), 'dsh-subagent-pi-real-'));
  /** @type {any} */
  let provider;
  const ctx = {
    logger: { warn: (...parts) => console.error('[logger]', ...parts) },
    subprocess: nodeSubprocess(),
    subagents: {
      registerProvider(candidate) {
        provider = candidate;
      },
    },
  };

  apply(ctx, { logDir, tools: 'read' });
  if (provider === undefined) throw new Error('apply 没有注册 provider');

  const started = Date.now();
  const run = await provider.start({
    cwd,
    prompt: [{ type: 'text', text: BRIEF }],
    parent: {},
    signal: new AbortController().signal,
  });
  console.log(`run id: ${run.id}`);
  let result;
  try {
    result = await run.result;
  } finally {
    await run.dispose();
  }
  console.log(`耗时: ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`stopReason: ${result.stopReason}`);
  for (const block of result.output) console.log(`--- ${block.type} ---\n${block.text}`);
  if (result.diagnostic !== undefined) console.log(`diagnostic: ${result.diagnostic}`);
  console.log(`日志目录: ${logDir}`);

  if (result.stopReason !== 'completed') {
    process.exitCode = 1;
    return;
  }
  const transcript = result.output.map((block) => block.text).join('\n');
  if (!transcript.includes('pi-subagent-ok')) {
    console.error('real-pi: 输出里没有 pi-subagent-ok，端到端未通过');
    process.exitCode = 1;
    return;
  }
  console.log('real-pi: OK');
}

await main();
