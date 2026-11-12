import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { apply, inject, name } from '../lib/index.js';

/**
 * The plugin's default `command`, built the same way the plugin builds it. The
 * module-scope value is captured before any test rewrites `HOME`, so it matches
 * the constant the plugin resolved at import time.
 */
const DEFAULT_COMMAND = join(homedir(), '.dsh', 'bin', 'pi-dev');

/**
 * A fake `ctx.subprocess`: records every spawn spec and hands back a handle
 * whose exit facts and collected output the test decides.
 */
class FakeSubprocess {
  /**
   * @param options.exitCode - the child's exit code.
   * @param options.signal - the terminating signal, when it died from one.
   * @param options.stdout - collected stdout text.
   * @param options.stderr - collected stderr text.
   * @param options.settle - `immediate`, `never`, or `on-terminate`.
   * @param options.spawnError - throw this instead of spawning.
   * @param options.perSpawn - per-spawn overrides, by spawn index.
   */
  constructor(options = {}) {
    const { perSpawn = [], ...rest } = options;
    this.defaults = { exitCode: 0, signal: null, stdout: '', stderr: '', settle: 'immediate', ...rest };
    this.perSpawn = perSpawn;
    this.specs = [];
    this.handles = [];
  }

  /** Options for the spawn at `index`, with the per-spawn override applied. */
  #optionsFor(index) {
    return { ...this.defaults, ...(this.perSpawn[index] ?? {}) };
  }

  /** Spawn one fake child. */
  spawn(spec) {
    const index = this.specs.length;
    const options = this.#optionsFor(index);
    if (options.spawnError !== undefined) throw options.spawnError;
    this.specs.push(spec);

    let settleDone;
    const done = new Promise((resolve) => {
      settleDone = resolve;
    });
    const finish = (exitCode, signal) => settleDone({ exitCode, signal });
    const reader = (text) => ({
      readFrom: () => ({ text, nextOffset: 0, lossy: false }),
    });
    const handle = {
      done,
      terminateCalls: 0,
      waitForExitCalls: 0,
      terminate() {
        handle.terminateCalls += 1;
        if (options.settle === 'on-terminate') finish(options.exitCode, options.signal);
      },
      async waitForExit() {
        handle.waitForExitCalls += 1;
        return true;
      },
      collected: {
        stdout: reader(options.stdout),
        stderr: reader(options.stderr),
      },
      /** Test-side exit, for the `settle: 'never'` runs. */
      settle(exitCode = 0, signal = null) {
        finish(exitCode, signal);
      },
    };
    if (options.settle === 'immediate') finish(options.exitCode, options.signal);
    this.handles.push(handle);
    return handle;
  }
}

/** A minimal plugin context: the two injected services plus a silent logger. */
function fakeContext(subprocess) {
  const providers = [];
  const warned = [];
  return {
    providers,
    warned,
    ctx: {
      logger: { warn: (...args) => warned.push(args.join(' ')) },
      subprocess,
      subagents: {
        registerProvider(provider) {
          providers.push(provider);
        },
      },
    },
  };
}

/** Mount the plugin on a fake context and return the registered provider. */
function mount(config = {}, options = {}) {
  const subprocess = new FakeSubprocess(options);
  const { ctx, providers, warned } = fakeContext(subprocess);
  apply(ctx, { command: '/fake/pi-dev', logDir: join(root, 'logs'), ...config });
  assert.equal(providers.length, 1, 'apply must register exactly one provider');
  return { subprocess, provider: providers[0], warned };
}

/** A start request whose cwd is the shared scratch root. */
function textRequest(text = '修一个 bug', signal = new AbortController().signal) {
  return {
    cwd: root,
    prompt: [{ type: 'text', text }],
    parent: {},
    signal,
  };
}

/** The value following `flag` in `argv`. */
function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  assert.notEqual(index, -1, `argv must carry ${flag}`);
  return argv[index + 1];
}

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-subagent-pi-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('导出契约：name 与 inject', () => {
  assert.equal(name, 'subagent-pi');
  assert.deepEqual(inject, ['subagents', 'subprocess']);
});

test('provider 声明：capabilities 全 false，不继承父上下文', () => {
  const { provider } = mount();
  assert.equal(provider.name, 'pi');
  assert.equal(provider.inheritsParentContext, false);
  assert.deepEqual(provider.capabilities, {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  });
});

test('argv 拼装：--brief / --cwd / --log / 可选参数 / config.args 齐全', async () => {
  const { subprocess, provider } = mount({
    model: 'deepseek-flash',
    thinking: 'low',
    tools: 'read,bash',
    approve: true,
    args: ['--extra', '1'],
    graceMs: 1234,
    maxOutputBytes: 4096,
  });
  const run = await provider.start(textRequest('任务正文'));
  try {
    const [spec] = subprocess.specs;
    const briefPath = flagValue(spec.argv, '--brief');
    const logPath = flagValue(spec.argv, '--log');

    assert.deepEqual(spec.argv, [
      '/fake/pi-dev',
      '--brief', briefPath,
      '--cwd', root,
      '--log', logPath,
      '--model', 'deepseek-flash',
      '--thinking', 'low',
      '--tools', 'read,bash',
      '--approve',
      '--extra', '1',
    ]);
    assert.equal(await readFile(briefPath, 'utf8'), '任务正文');
    assert.equal(spec.cwd, root);
    assert.equal(spec.graceMs, 1234);
    assert.deepEqual(spec.stdio, {
      stdin: 'ignore',
      stdout: { maxBytes: 4096 },
      stderr: { maxBytes: 4096 },
    });
    assert.ok(spec.signal instanceof AbortSignal);
    assert.ok(logPath.startsWith(join(root, 'logs')), '日志落在 logDir 下');
    assert.match(logPath, /\d{8}-\d{6}-[0-9a-f]{8}\.log$/);
    assert.notEqual(dirname(briefPath), root, 'brief 写在独立临时目录里');
  } finally {
    await run.dispose();
  }
  assert.equal(existsSync(dirname(flagValue(subprocess.specs[0].argv, '--brief'))), false, 'dispose 删掉临时目录');
});

test('多段 text 用空行拼接；未给可选参数时不传', async () => {
  const { subprocess, provider } = mount();
  const request = {
    ...textRequest(),
    prompt: [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ],
  };
  const run = await provider.start(request);
  try {
    const spec = subprocess.specs[0];
    assert.equal(await readFile(flagValue(spec.argv, '--brief'), 'utf8'), '第一段\n\n第二段');
    for (const flag of ['--model', '--thinking', '--tools', '--approve']) {
      assert.equal(spec.argv.includes(flag), false, `未配置时不应带 ${flag}`);
    }
  } finally {
    await run.dispose();
  }
});

test('退出码 0 → completed，output 带 Pi 输出与日志路径', async () => {
  const stdout = '改完了：lib/index.js 加了一行注释';
  const { subprocess, provider } = mount({}, { exitCode: 0, stdout });
  const run = await provider.start(textRequest());
  try {
    const result = await run.result;
    const logPath = flagValue(subprocess.specs[0].argv, '--log');
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.diagnostic, undefined);
    assert.equal(result.output.length, 2);
    assert.deepEqual(result.output[0], { type: 'text', text: stdout });
    assert.deepEqual(result.output[1], { type: 'text', text: `[full pi-dev output] ${logPath}` });
  } finally {
    await run.dispose();
  }
});

test('退出码 2 → error，diagnostic 带退出码与 stderr', async () => {
  const { provider } = mount({}, { exitCode: 2, stdout: '半截输出', stderr: 'pi-dev: 找不到固定规矩' });
  const run = await provider.start(textRequest());
  try {
    const result = await run.result;
    assert.equal(result.stopReason, 'error');
    assert.equal(result.output[0].text, '半截输出');
    assert.match(result.diagnostic, /^pi-dev exit code 2\n/);
    assert.match(result.diagnostic, /找不到固定规矩/);
    assert.ok(Buffer.byteLength(result.diagnostic, 'utf8') <= 4096);
  } finally {
    await run.dispose();
  }
});

test('diagnostic 超长时保留退出码并截到 4096 字节以内', async () => {
  const { provider } = mount({}, { exitCode: 1, stderr: 'x'.repeat(10_000) });
  const run = await provider.start(textRequest());
  try {
    const result = await run.result;
    assert.equal(result.stopReason, 'error');
    assert.match(result.diagnostic, /^pi-dev exit code 1\n/);
    assert.ok(Buffer.byteLength(result.diagnostic, 'utf8') <= 4096);
  } finally {
    await run.dispose();
  }
});

test('取消信号 → terminate 被调用，stopReason 为 aborted', async () => {
  const { subprocess, provider } = mount({}, { settle: 'on-terminate', exitCode: null, signal: 'SIGTERM', stdout: '做到一半' });
  const controller = new AbortController();
  const run = await provider.start(textRequest('长任务', controller.signal));
  try {
    controller.abort();
    const result = await run.result;
    assert.equal(result.stopReason, 'aborted');
    assert.ok(subprocess.handles[0].terminateCalls >= 1, 'abort 必须触发 terminate');
    assert.equal(result.output[0].text, '做到一半');
    assert.equal(result.output[1].text, `[full pi-dev output] ${flagValue(subprocess.specs[0].argv, '--log')}`);
    assert.equal(result.diagnostic, undefined);
  } finally {
    await run.dispose();
  }
});

test('已 abort 的请求不进 spawn', async () => {
  const { subprocess, provider } = mount();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => provider.start(textRequest('晚了', controller.signal)), /aborted/);
  assert.equal(subprocess.specs.length, 0);
});

test('dispose 先到 → aborted，且 dispose 幂等', async () => {
  const { subprocess, provider } = mount({}, { settle: 'never' });
  const run = await provider.start(textRequest());
  await run.dispose();
  await run.dispose();
  const result = await run.result;
  assert.equal(result.stopReason, 'aborted');
  assert.equal(subprocess.handles[0].terminateCalls, 1, 'terminate 只发生一次');
  assert.equal(subprocess.handles[0].waitForExitCalls, 1, 'teardown 记忆化');
});

test('非 text 的 prompt 块 → start 抛错且不 spawn', async () => {
  const { subprocess, provider } = mount();
  const request = {
    ...textRequest(),
    prompt: [
      { type: 'text', text: '看看这张图' },
      { type: 'image', data: 'AAAA' },
    ],
  };
  await assert.rejects(() => provider.start(request), /"image" is not supported/);
  assert.equal(subprocess.specs.length, 0);
});

test('cwd 不是绝对路径 / 目录不存在 → start 抛清楚错误', async () => {
  const { subprocess, provider } = mount();
  await assert.rejects(
    () => provider.start({ ...textRequest(), cwd: 'relative/dir' }),
    /child cwd must be absolute/,
  );
  await assert.rejects(
    () => provider.start({ ...textRequest(), cwd: join(root, 'nope') }),
    /child cwd is not accessible/,
  );
  assert.equal(subprocess.specs.length, 0);
});

test('spawn 抛错 → start 拒绝并清掉临时目录', async () => {
  const ours = async () =>
    (await readdir(tmpdir())).filter((entry) => entry.startsWith('dsh-subagent-pi-') && !entry.startsWith('dsh-subagent-pi-test-')).sort();
  const before = await ours();
  const { provider } = mount({}, { spawnError: new Error('ENOENT: pi-dev 不存在') });
  await assert.rejects(() => provider.start(textRequest()), /could not start the pi-dev child: ENOENT/);
  assert.deepEqual(await ours(), before, 'setup 失败后不留临时目录');
});

test('child 的 done 拒绝 → error（result 不 reject）', async () => {
  let rejectDone;
  const broken = {
    spawn(spec) {
      return {
        done: new Promise((resolve, reject) => {
          rejectDone = reject;
        }),
        terminate() {},
        async waitForExit() {
          return true;
        },
        collected: { stdout: { readFrom: () => ({ text: '部分', nextOffset: 0, lossy: false }) } },
      };
    },
  };
  const { ctx, providers } = fakeContext(broken);
  apply(ctx, { command: '/fake/pi-dev', logDir: join(root, 'logs') });
  const run = await providers[0].start(textRequest());
  rejectDone(new Error('provider cannot observe the range'));
  const result = await run.result;
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /pi-dev run failed: provider cannot observe the range/);
  assert.equal(result.output[0].text, '部分');
  await run.dispose();
});

test('并发 run 状态互不串', async () => {
  const { subprocess, provider } = mount(
    {},
    { settle: 'never', perSpawn: [{ stdout: 'run-A' }, { stdout: 'run-B' }] },
  );
  const runA = await provider.start(textRequest('A'));
  const runB = await provider.start(textRequest('B'));
  subprocess.handles[1].settle(0);
  subprocess.handles[0].settle(2);
  const resultB = await runB.result;
  const resultA = await runA.result;
  assert.equal(resultB.stopReason, 'completed');
  assert.equal(resultB.output[0].text, 'run-B');
  assert.equal(resultA.stopReason, 'error');
  assert.equal(resultA.output[0].text, 'run-A');
  await Promise.all([runA.dispose(), runB.dispose()]);
});

test('配置校验：数值项必须正有限，command 非空', () => {
  const { ctx } = fakeContext(new FakeSubprocess());
  const logDir = join(root, 'logs');
  assert.throws(() => apply(ctx, { command: '/fake/pi-dev', logDir, graceMs: 0 }), /graceMs must be a positive finite number/);
  assert.throws(
    () => apply(ctx, { command: '/fake/pi-dev', logDir, maxOutputBytes: Number.POSITIVE_INFINITY }),
    /maxOutputBytes must be a positive finite number/,
  );
  assert.throws(() => apply(ctx, { command: '', logDir }), /command must be a non-empty string/);
});

test('默认值：providerName=pi、command 指向 pi-dev、graceMs=5000、maxOutputBytes=262144', async () => {
  // The default logDir is `$HOME/.dsh/pi-logs`; point HOME at the scratch root so
  // the test never writes into the real home directory.
  const previousHome = process.env.HOME;
  const fakeHome = join(root, 'home');
  process.env.HOME = fakeHome;
  const subprocess = new FakeSubprocess();
  const { ctx, providers } = fakeContext(subprocess);
  let run;
  try {
    apply(ctx, {});
    const provider = providers[0];
    assert.equal(provider.name, 'pi');
    run = await provider.start(textRequest());
    const spec = subprocess.specs[0];
    assert.equal(spec.argv[0], DEFAULT_COMMAND);
    assert.equal(spec.graceMs, 5000);
    assert.deepEqual(spec.stdio.stdout, { maxBytes: 262144 });
    const logPath = flagValue(spec.argv, '--log');
    assert.equal(dirname(logPath), join(fakeHome, '.dsh', 'pi-logs'));
  } finally {
    await run?.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('所有测试跑完不留临时目录', async () => {
  const { subprocess, provider } = mount();
  const runs = [
    await provider.start(textRequest('一')),
    await provider.start(textRequest('二')),
  ];
  const briefDirs = [...new Set(subprocess.specs.map((spec) => dirname(flagValue(spec.argv, '--brief'))))];
  assert.equal(briefDirs.length, 2, '每个 run 一个独立临时目录');
  for (const dir of briefDirs) assert.equal(existsSync(dir), true);
  await Promise.all(runs.map((run) => run.dispose()));
  for (const dir of briefDirs) assert.equal(existsSync(dir), false, `临时目录没删：${dir}`);
});
