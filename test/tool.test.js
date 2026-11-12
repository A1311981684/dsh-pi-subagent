/**
 * Unit tests for the `pi` tool and its session projection.
 *
 * Every delegation spawns a real child process — `test/fake-pi-dev.mjs`, copied
 * into the scratch root and executed as the configured `command`. The fixture
 * reads the brief for its `FIXTURE`/`RECORD` directives, so one generic script
 * covers structured runs, plain-text runs, failures, slow runs, and SIGTERM-
 * ignoring runs while every test can inspect the exact argv the plugin built.
 *
 * DSH is never loaded: the fake `ctx` below records what the plugin asks of
 * `tools`, `sessions`, and `sessionPersistence`, and the assertions check the
 * payloads against the 0.2.2-rc.1 event shapes by hand (no `@deepseek-ai/*`
 * import, exactly like the plugin).
 *
 * `HOME` is redirected at module scope, *before* the plugin is imported, so the
 * HOME-derived defaults (`$HOME/.dsh/bin/pi-dev`, `$HOME/.dsh/pi-logs`) point
 * into the scratch root and a default-command test can never execute the real
 * wrapper.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

const homeRoot = await mkdtemp(join(tmpdir(), 'dsh-subagent-pi-home-'));
const previousHome = process.env.HOME;
process.env.HOME = homeRoot;

const { apply, inject, name } = await import('../lib/index.js');

/** The default command the plugin resolves from the redirected HOME. */
const DEFAULT_COMMAND = join(homeRoot, '.dsh', 'bin', 'pi-dev');

/** The test-owned wrapper, copied from the repository fixture in `before`. */
let FAKE_PI = '';

/** Scratch root for fixtures, logs, and the copied wrapper. */
let root = '';

let sequence = 0;

/** One fake DSH session: an id, a header, and the appended events in order. */
function fakeSession(id, meta, log, owner, appendError) {
  const events = [];
  const header = { version: 4, id, createdAt: 1_760_000_000_000, isSeeded: false, ...meta };
  return {
    id,
    header,
    events,
    snapshotEvents() {
      // The constructor boundary marker a real Session holds before publication.
      return [{ type: 'session/end-seed', data: {}, seq: 0 }];
    },
    append(type, data, opts) {
      log.push(`append:${owner}:${type}`);
      if (appendError !== undefined && appendError.type === type) throw appendError.error;
      events.push({
        type,
        data: structuredClone(data),
        ...(opts === undefined ? {} : { opts: structuredClone(opts) }),
      });
      return { type, data, seq: events.length - 1 };
    },
  };
}

/** The injected session store, recording every call in the shared order log. */
class FakeSessions {
  constructor(options = {}) {
    this.log = options.log ?? [];
    this.prepareError = options.prepareError;
    this.enterError = options.enterError;
    this.appendError = options.appendError;
    this.flushes = [];
    this.prepared = [];
    this.entered = [];
    this.announced = [];
    this.detached = [];
  }

  prepare(id, options) {
    this.log.push('sessions:prepare');
    if (this.prepareError !== undefined) throw this.prepareError;
    const session = fakeSession(id, options?.meta, this.log, 'child', this.appendError);
    this.prepared.push({ id, options, session });
    return session;
  }

  enter(session) {
    this.log.push('sessions:enter');
    if (this.enterError !== undefined) throw this.enterError;
    this.entered.push(session);
    return () => {
      this.log.push('sessions:detach');
      this.detached.push(session);
    };
  }

  announce(session) {
    this.log.push('sessions:announce');
    this.announced.push(session);
  }

  async flush(session) {
    this.log.push(`sessions:flush:${session.id}`);
    this.flushes.push(session);
    return true;
  }
}

/** The injected persistence service: `create` hands back an appendable handle. */
class FakePersistence {
  constructor(options = {}) {
    this.log = options.log ?? [];
    this.createError = options.createError;
    this.created = [];
    this.appended = [];
    this.closed = [];
  }

  async create(header, options) {
    this.log.push('persistence:create');
    if (this.createError !== undefined) throw this.createError;
    this.created.push({ header, options });
    const log = this.log;
    const appended = this.appended;
    const closed = this.closed;
    return {
      id: header.id,
      header,
      inheritedEventCount: 0,
      access: 'write',
      async append(events) {
        log.push('persistence:append');
        appended.push(events.map((event) => structuredClone(event)));
      },
      async flush() {},
      async read() {
        return { eventState: 'detached', events: [] };
      },
      async close() {
        log.push('persistence:close');
        closed.push(header.id);
      },
    };
  }
}

/**
 * Mount the plugin on a fake context.
 * @param options - `config` overrides, `noSessions`/`noPersistence` to omit a
 *   service, and `sessionsOptions`/`persistenceOptions` for the fakes.
 */
function mount(options = {}) {
  const log = [];
  const sessions = options.noSessions === true
    ? null
    : new FakeSessions({ log, ...(options.sessionsOptions ?? {}) });
  const persistence = options.noPersistence === true
    ? null
    : new FakePersistence({ log, ...(options.persistenceOptions ?? {}) });
  const warned = [];
  const registered = [];
  const ctx = {
    logger: { warn: (...parts) => warned.push(parts.join(' ')) },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    ...(sessions === null ? {} : { sessions }),
    ...(persistence === null ? {} : { sessionPersistence: persistence }),
  };
  apply(ctx, { command: FAKE_PI, logDir: join(root, 'logs'), ...(options.config ?? {}) });
  assert.equal(registered.length, 1, 'apply must register exactly one tool');
  return { definition: registered[0], ctx, sessions, persistence, warned, log };
}

/** The parent session the fake agent drives. */
function fakeParent(meta = { cwd: root, delegationDepth: 2 }, log = []) {
  return fakeSession('parent-1', meta, log, 'parent');
}

/** A parent agent exposing what the plugin reads from `exec.agent`. */
function fakeAgent(parent, options = {}) {
  return { id: parent.id, session: parent, options };
}

/** Write one fixture file. */
async function writeFixture(fixture) {
  sequence += 1;
  const path = join(root, `fixture-${sequence}.json`);
  await writeFile(path, JSON.stringify(fixture), 'utf8');
  return path;
}

/** Reserve a record-file path. */
function recordPath() {
  sequence += 1;
  return join(root, `record-${sequence}.json`);
}

/** A brief carrying the test directives the fake wrapper reads. */
function briefWith(prompt, fixturePath, recorded) {
  return `${prompt}\n\nFIXTURE ${fixturePath}\nRECORD ${recorded}`;
}

/** JSONL framing for a list of records. */
function ndjson(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

/** Invoke the registered tool with a parent agent and a fresh signal. */
async function runTool(mounted, parent, args, execOptions = {}) {
  const controller = new AbortController();
  return mounted.definition.execute(args, {
    agent: execOptions.agent ?? fakeAgent(parent, execOptions.agentOptions ?? {}),
    signal: execOptions.signal ?? controller.signal,
    callId: 'call-1',
  });
}

/** Wait until `path` exists (the fake wrapper writes its record on startup). */
async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

/** Records for one structured run: a thinking-only message, a tool call, and text. */
function structuredRecords({ text = '改完了：lib/index.js' } = {}) {
  return [
    { type: 'session', version: 3, id: 'pi-session-1', cwd: root },
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'user', content: '任务', timestamp: 1_700_000_000_001 } },
    { type: 'message_end', message: { role: 'user', content: '任务', timestamp: 1_700_000_000_001 } },
    { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending', timestamp: 1_700_000_000_002 } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '想' } },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '先看看文件' }],
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
        stopReason: 'toolUse',
        timestamp: 1_700_000_000_003,
      },
    },
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
    { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: {}, isError: false },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 4, reasoning: 1, totalTokens: 25 },
        stopReason: 'stop',
        timestamp: 1_700_000_000_004,
      },
    },
    { type: 'turn_end', message: {}, toolResults: [] },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled', aborted: false },
  ];
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-subagent-pi-test-'));
  FAKE_PI = join(root, 'fake-pi-dev.mjs');
  const fixture = await readFile(new URL('./fake-pi-dev.mjs', import.meta.url), 'utf8');
  await writeFile(FAKE_PI, fixture, 'utf8');
  await chmod(FAKE_PI, 0o755);
});

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
  await rm(homeRoot, { recursive: true, force: true });
});

test('导出契约：name 与 inject', () => {
  assert.equal(name, 'subagent-pi');
  assert.deepEqual(inject, ['tools', 'sessions', 'sessionPersistence']);
});

test('工具注册：名字、面向模型的描述、参数与输出声明', () => {
  const { definition } = mount();
  assert.equal(definition.name, 'pi');
  assert.match(definition.description, /Pi coding agent/);
  assert.match(definition.description, /child session/);
  assert.deepEqual(Object.keys(definition.parameters.properties), ['prompt', 'cwd', 'label']);
  assert.deepEqual(definition.parameters.required, ['prompt']);
  assert.equal(definition.parameters.properties.prompt.type, 'string');
  assert.equal(definition.parameters.properties.cwd.type, 'string');
  assert.equal(definition.parameters.properties.label.type, 'string');
  assert.deepEqual(definition.output.schema.required, ['output', 'childSessionId', 'logPath', 'stopReason']);
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
});

test('默认投影开启：argv 带 --mode json，brief / cwd / log 齐全', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();
  const prompt = briefWith('修一个 bug', fixturePath, recorded);

  const value = await runTool(mounted, parent, { prompt });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  assert.equal(record.cwd, root);
  assert.equal(record.brief, prompt);
  assert.ok(record.argv.includes('--mode'));
  assert.equal(record.argv[record.argv.indexOf('--mode') + 1], 'json');
  assert.equal(record.argv[0], '--brief');
  assert.equal(dirname(record.argv[record.argv.indexOf('--log') + 1]), join(root, 'logs'));
  assert.match(value.logPath, /\d{8}-\d{6}-[0-9a-f]{8}\.log$/);
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了：lib/index.js');
});

test('projection=false：不传 --mode、不碰 sessions，结果照常返回', async () => {
  const fixturePath = await writeFixture({ stdout: '改完了' });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({
    noSessions: true,
    noPersistence: true,
    config: { projection: false, model: 'deepseek-flash', thinking: 'low', tools: 'read,bash', approve: true, args: ['--extra', '1'] },
  });

  const value = await runTool(mounted, parent, { prompt: briefWith('任务', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  assert.equal(record.argv.includes('--mode'), false);
  assert.deepEqual(record.argv.slice(record.argv.indexOf('--model')), [
    '--model', 'deepseek-flash',
    '--thinking', 'low',
    '--tools', 'read,bash',
    '--approve',
    '--extra', '1',
  ]);
  assert.equal(value.output, '改完了');
  assert.equal(value.childSessionId, '');
  assert.deepEqual(mounted.warned, []);

  const rendered = mounted.definition.output.render({ prompt: '任务' }, value);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /subagent session: \(not projected\)/);
  assert.match(rendered[0].text, new RegExp(`full output: ${value.logPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('参数校验：prompt 必填、cwd/label 必须是字符串、缺 exec.agent 报清楚', async () => {
  const { definition } = mount();
  const parent = fakeParent();
  const exec = { agent: fakeAgent(parent), signal: new AbortController().signal };

  await assert.rejects(() => definition.execute({}, exec), /`prompt` is required/);
  await assert.rejects(() => definition.execute({ prompt: '   ' }, exec), /`prompt` is required/);
  await assert.rejects(() => definition.execute({ prompt: 'x', cwd: 1 }, exec), /`cwd` must be a string/);
  await assert.rejects(() => definition.execute({ prompt: 'x', label: 1 }, exec), /`label` must be a string/);
  await assert.rejects(
    () => definition.execute({ prompt: 'x' }, { signal: new AbortController().signal }),
    /needs the calling parent agent \(exec\.agent\)/,
  );
});

test('cwd 校验：相对路径 / 不存在的目录都在 spawn 之前失败', async () => {
  const mounted = mount();
  const parent = fakeParent();
  await assert.rejects(
    () => runTool(mounted, parent, { prompt: 'x', cwd: 'relative/dir' }),
    /child cwd must be absolute/,
  );
  await assert.rejects(
    () => runTool(mounted, parent, { prompt: 'x', cwd: join(root, 'nope') }),
    /child cwd is not accessible/,
  );
  assert.deepEqual(mounted.sessions.prepared, []);
});

test('完成的运行：prepare meta、事件序列、flush、返回值与模型文本', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const mounted = mount();
  const parent = fakeParent(undefined, mounted.log);
  const prompt = briefWith('修一个 bug', fixturePath, recorded);

  const value = await runTool(mounted, parent, { prompt });
  const [{ id, options, session }] = mounted.sessions.prepared;

  // prepare: the child's durable identity, parent lineage, and depth.
  assert.deepEqual(options.meta, {
    cwd: root,
    parentSession: 'parent-1',
    origin: 'subagent',
    delegationDepth: 3,
  });
  assert.equal(mounted.persistence.created.length, 1);
  assert.deepEqual(mounted.persistence.created[0].options, { inheritedEventCount: 0 });
  assert.equal(mounted.persistence.created[0].header, session.header);
  assert.equal(value.childSessionId, id);

  // Event sequence: descriptor inside turn 1, then the prompt, one step-wrapped
  // reply, and the turn end (the durable log is relationship-checked on read).
  assert.deepEqual(session.events.map((event) => event.type), [
    'subagent/descriptor',
    'turn/start',
    'user/message',
    'step/start',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);

  // Order around the projection: create → persist the pre-publication marker
  // → enter → announce → append → flush.
  assert.equal(mounted.persistence.appended.length, 1, 'the constructor marker must be persisted first');
  assert.deepEqual(mounted.persistence.appended[0].map((event) => event.type), ['session/end-seed']);
  const position = (entry) => mounted.log.indexOf(entry);
  assert.ok(position('persistence:create') < position('persistence:append'));
  assert.ok(position('persistence:append') < position('sessions:enter'));
  assert.ok(position('persistence:create') < position('sessions:enter'));
  assert.ok(position('sessions:enter') < position('sessions:announce'));
  assert.ok(position('sessions:announce') < position('append:child:subagent/descriptor'));
  assert.ok(position('append:child:turn/end') < position('append:parent:subagent/catalog'));
  assert.ok(position('append:parent:subagent/catalog') < position(`sessions:flush:${id}`));
  assert.ok(position(`sessions:flush:${id}`) < position('sessions:flush:parent-1'));
  assert.ok(position('sessions:flush:parent-1') < position('sessions:detach'));
  assert.ok(position('sessions:detach') < position('persistence:close'));
  assert.equal(mounted.sessions.detached.length, 1, 'the synthetic child must not stay live');
  assert.deepEqual(mounted.persistence.closed, [id]);

  // Model-facing text: answer first, the two pointers last.
  assert.deepEqual(mounted.definition.output.render({ prompt }, value), [{
    type: 'text',
    text: ['改完了：lib/index.js', `subagent session: ${id}`, `full output: ${value.logPath}`].join('\n'),
  }]);
});

test('payload：descriptor v3、目录 v0 严格字段、user/message、assistant/message 的 usage 与 stream', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();
  const prompt = briefWith('修一个 bug', fixturePath, recorded);

  const value = await runTool(mounted, parent, { prompt });
  const session = mounted.sessions.prepared[0].session;
  const [descriptor, turnStart, userEvent, stepStart, assistantEvent, stepEnd, turnEnd] = session.events;

  // subagent/descriptor: exactly the v3 one-shot keys.
  assert.deepEqual(Object.keys(descriptor.data).sort(), ['label', 'mode', 'provider', 'version']);
  assert.deepEqual(descriptor.data, { version: 3, mode: 'one-shot', provider: 'pi', label: '修一个 bug' });
  assert.equal(descriptor.opts, undefined, 'log-only events carry no surfaceOp');

  assert.deepEqual(turnStart.data, { turn: 1 });
  assert.equal(turnStart.opts, undefined);

  // Each assistant message sits in its own step: the durable log rejects an
  // assistant/message outside an open turn and step.
  assert.deepEqual(stepStart.data, { turn: 1, step: 1 });
  assert.deepEqual(stepEnd.data, { turn: 1, step: 1 });
  assert.equal(stepStart.opts, undefined);
  assert.equal(stepEnd.opts, undefined);

  // user/message: the task text itself, appended to the surface.
  assert.deepEqual(userEvent.data, {
    id: userEvent.data.id,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  });
  assert.equal(typeof userEvent.data.id, 'string');
  assert.ok(userEvent.data.id.length > 0);
  assert.deepEqual(userEvent.opts, { surfaceOp: 'append' });

  // assistant/message: text only, Pi's route, mapped usage, empty stream.
  assert.deepEqual(Object.keys(assistantEvent.data).sort(), ['message', 'step', 'stream', 'turn', 'usage']);
  assert.equal(assistantEvent.data.turn, 1);
  assert.equal(assistantEvent.data.step, 1);
  assert.deepEqual(assistantEvent.data.stream, []);
  assert.deepEqual(assistantEvent.data.usage, {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    reasoningTokens: 1,
  });
  assert.deepEqual(assistantEvent.data.message, {
    id: assistantEvent.data.message.id,
    role: 'assistant',
    content: [{ type: 'text', text: '改完了：lib/index.js' }],
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
  });
  assert.deepEqual(assistantEvent.opts, { surfaceOp: 'append' });

  assert.deepEqual(turnEnd.data, { turn: 1, reason: { kind: 'completed' } });
  assert.equal(turnEnd.opts, undefined);

  // Parent catalog v0: the strict key set the runtime schema accepts.
  assert.equal(parent.events.length, 1);
  const catalog = parent.events[0];
  assert.equal(catalog.type, 'subagent/catalog');
  assert.deepEqual(Object.keys(catalog.data).sort(), ['childCreatedAt', 'childId', 'label', 'mode', 'version']);
  assert.deepEqual(catalog.data, {
    version: 0,
    childId: value.childSessionId,
    childCreatedAt: session.header.createdAt,
    mode: 'one-shot',
    label: '修一个 bug',
  });
  assert.equal(catalog.opts, undefined);
});

test('多轮与步序：turn 按 turn_start 计数，step 每轮从 1 递增，thinking/toolCall 丢弃', async () => {
  const fixturePath = await writeFixture({
    stdout: ndjson([
      { type: 'turn_start' },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '第一步' }], provider: 'p', model: 'm', usage: { input: 1, output: 1 } },
      },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: '第二步' }], provider: 'p', model: 'm' },
      },
      { type: 'turn_end' },
      { type: 'turn_start' },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '第三轮' }], provider: 'p', model: 'm' },
      },
      { type: 'turn_end' },
      { type: 'agent_settled', aborted: false },
    ]),
  });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('多轮', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;
  const assistants = session.events.filter((event) => event.type === 'assistant/message');

  assert.deepEqual(assistants.map((event) => [event.data.turn, event.data.step, event.data.message.content[0].text]), [
    [1, 1, '第一步'],
    [1, 2, '第二步'],
    [2, 1, '第三轮'],
  ]);
  assert.deepEqual(
    session.events.map((event) => event.type),
    [
      'subagent/descriptor',
      'turn/start', 'user/message',
      'step/start', 'assistant/message', 'step/end',
      'step/start', 'assistant/message', 'step/end',
      'turn/end',
      'turn/start',
      'step/start', 'assistant/message', 'step/end',
      'turn/end',
    ],
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === 'step/start').map((event) => event.data),
    [{ turn: 1, step: 1 }, { turn: 1, step: 2 }, { turn: 2, step: 1 }],
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === 'turn/start').map((event) => event.data),
    [{ turn: 1 }, { turn: 2 }],
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === 'turn/end').map((event) => event.data),
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'completed' } }],
  );
  assert.equal(session.events.filter((event) => event.type === 'user/message').length, 1, '任务只投影一次');
  const usageOfFirst = assistants[0].data.usage;
  assert.deepEqual(usageOfFirst, { inputTokens: 1, outputTokens: 1 });
  assert.equal(assistants[1].data.usage, undefined, '没有 usage 的那条不带 usage 字段');
  assert.equal(value.output, '第三轮', '最终回答取最后一条非空文本');
});

test('降级：stdout 不是 NDJSON → 全部当最终文本，只有一条助手消息', async () => {
  const text = '改完了\n加了一行注释\n';
  const fixturePath = await writeFixture({ stdout: text });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('纯文本', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;

  assert.equal(value.output, '改完了\n加了一行注释');
  assert.equal(value.stopReason, 'completed');
  assert.deepEqual(session.events.map((event) => event.type), [
    'subagent/descriptor',
    'turn/start',
    'user/message',
    'step/start',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);
  const assistant = session.events[4];
  assert.deepEqual(assistant.data.message.content, [{ type: 'text', text: '改完了\n加了一行注释' }]);
  assert.equal(assistant.data.usage, undefined);
  assert.deepEqual(assistant.data.message.source, { kind: 'model', provider: 'pi', model: 'pi' });
});

test('降级：stdout 为空 → 没有助手消息，提示与结束状态照样记录', async () => {
  const fixturePath = await writeFixture({ stdout: '' });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('空输出', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;

  assert.equal(value.output, '');
  assert.deepEqual(session.events.map((event) => event.type), [
    'subagent/descriptor',
    'turn/start',
    'user/message',
    'turn/end',
  ]);
  assert.match(mounted.definition.output.render({}, value)[0].text, /^\(pi produced no text\)/);
});

test('失败：非零退出 → stopReason error，turn/end error，诊断带 stderr', async () => {
  const fixturePath = await writeFixture({
    stdout: '半截输出\n',
    stderr: 'pi-dev: 找不到固定规矩',
    exitCode: 2,
  });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('失败', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;

  assert.equal(value.stopReason, 'error');
  assert.equal(value.output, '半截输出');
  assert.match(value.diagnostic, /^pi-dev exit code 2\n/);
  assert.match(value.diagnostic, /找不到固定规矩/);

  const turnEnd = session.events.find((event) => event.type === 'turn/end');
  assert.deepEqual(turnEnd.data, { turn: 1, reason: { kind: 'error', error: { message: 'pi-dev exit code 2', code: 'UNKNOWN' } } });

  const rendered = mounted.definition.output.render({}, value)[0].text;
  assert.match(rendered, /半截输出/);
  assert.match(rendered, /pi-dev exit code 2/);
  assert.match(rendered, /pi run status: error/);
  assert.match(rendered, /subagent session: [0-9a-f-]{36}/);
});

test('诊断截断：stderr 超长时保留退出码并截到 4096 字节以内', async () => {
  const fixturePath = await writeFixture({ stderr: 'x'.repeat(10_000), exitCode: 1 });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('截断', fixturePath, recorded) });
  assert.equal(value.stopReason, 'error');
  assert.match(value.diagnostic, /^pi-dev exit code 1\n/);
  assert.ok(Buffer.byteLength(value.diagnostic, 'utf8') <= 4096);
});

test('spawn 失败：command 不存在 → stopReason error，不抛出', async () => {
  const parent = fakeParent();
  const mounted = mount({ config: { command: join(root, 'missing-pi-dev') } });

  const value = await runTool(mounted, parent, { prompt: '任务' });
  assert.equal(value.stopReason, 'error');
  assert.match(value.diagnostic, /could not start the pi-dev child/);
  assert.match(value.diagnostic, /missing-pi-dev/);

  const session = mounted.sessions.prepared[0].session;
  const turnEnd = session.events.find((event) => event.type === 'turn/end');
  assert.equal(turnEnd.data.reason.kind, 'error');
});

test('取消：signal abort 终止子进程，turn/end 是 aborted', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()), delayMs: 5_000 });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();
  const controller = new AbortController();

  const running = runTool(mounted, parent, { prompt: briefWith('长任务', fixturePath, recorded) }, {
    signal: controller.signal,
  });
  await waitForFile(recorded);
  controller.abort();
  const value = await running;

  assert.equal(value.stopReason, 'aborted');
  const session = mounted.sessions.prepared[0].session;
  const turnEnd = session.events.find((event) => event.type === 'turn/end');
  assert.deepEqual(turnEnd.data, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
});

test('取消升级：忽略 SIGTERM 的子进程在 graceMs 后被 SIGKILL', async () => {
  const fixturePath = await writeFixture({ delayMs: 30_000, ignoreTerm: true });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({ config: { graceMs: 100 } });
  const controller = new AbortController();

  const startedAt = Date.now();
  const running = runTool(mounted, parent, { prompt: briefWith('顽固任务', fixturePath, recorded) }, {
    signal: controller.signal,
  });
  await waitForFile(recorded);
  controller.abort();
  const value = await running;
  const elapsed = Date.now() - startedAt;

  assert.equal(value.stopReason, 'aborted');
  assert.ok(elapsed < 5_000, `SIGKILL escalation should end the run quickly, took ${elapsed}ms`);
});

test('降级：老封装不认 --mode → 自动退回文本模式，派活照常，投影降级为文本', async () => {
  const fixturePath = await writeFixture({ stdout: '改完了\n', rejectMode: true });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('老封装', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了');
  assert.equal(record.argv.includes('--mode'), false, '第二次调用不带 --mode');
  assert.match(mounted.warned[0], /rejected --mode; retrying in text mode/);

  const session = mounted.sessions.prepared[0].session;
  assert.deepEqual(session.events.map((event) => event.type), [
    'subagent/descriptor',
    'turn/start',
    'user/message',
    'step/start',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);
  assert.deepEqual(session.events[4].data.message.content, [{ type: 'text', text: '改完了' }]);
});

test('降级：sessions.prepare 抛错 → 派活结果照常返回，只 warn', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({
    sessionsOptions: { prepareError: new Error('store is closed') },
  });

  const value = await runTool(mounted, parent, { prompt: briefWith('任务', fixturePath, recorded) });
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了：lib/index.js');
  assert.equal(value.childSessionId, '');
  assert.equal(mounted.warned.length, 1);
  assert.match(mounted.warned[0], /session projection failed; the delegation result is unaffected: store is closed/);
});

test('降级：sessionPersistence 缺失 → 结果照常，不建子会话', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({ noPersistence: true });

  const value = await runTool(mounted, parent, { prompt: briefWith('任务', fixturePath, recorded) });
  assert.equal(value.output, '改完了：lib/index.js');
  assert.equal(value.childSessionId, '');
  assert.match(mounted.warned[0], /sessionPersistence service is unavailable/);
});

test('降级：append 被拒 → 子会话被释放，父会话没有目录行，结果照常', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({
    sessionsOptions: { appendError: { type: 'assistant/message', error: new Error('surface append rejected') } },
  });

  const value = await runTool(mounted, parent, { prompt: briefWith('任务', fixturePath, recorded) });
  assert.equal(value.output, '改完了：lib/index.js');
  assert.equal(value.childSessionId, '');
  assert.match(mounted.warned[0], /surface append rejected/);
  assert.equal(parent.events.length, 0, 'a failed projection leaves no dangling catalog row');
  assert.equal(mounted.sessions.detached.length, 1);
  assert.equal(mounted.persistence.closed.length, 1);
});

test('并发 run：不同 fixture 的结果与子会话互不串', async () => {
  const fixtureA = await writeFixture({ stdout: ndjson(structuredRecords({ text: 'run-A' })), delayMs: 50 });
  const fixtureB = await writeFixture({ stdout: ndjson(structuredRecords({ text: 'run-B' })), delayMs: 50 });
  const recordA = recordPath();
  const recordB = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const [valueA, valueB] = await Promise.all([
    runTool(mounted, parent, { prompt: briefWith('A', fixtureA, recordA) }),
    runTool(mounted, parent, { prompt: briefWith('B', fixtureB, recordB) }),
  ]);

  assert.equal(valueA.output, 'run-A');
  assert.equal(valueB.output, 'run-B');
  assert.notEqual(valueA.childSessionId, valueB.childSessionId);
  const sessions = mounted.sessions.prepared.map((entry) => entry.session);
  assert.equal(sessions.length, 2);
  const texts = sessions.map((session) => session.events.find((event) => event.type === 'assistant/message').data.message.content[0].text);
  assert.deepEqual(texts.sort(), ['run-A', 'run-B']);
  assert.equal(parent.events.length, 2, 'each run appends its own catalog row');
});

test('默认值：command 指向 $HOME/.dsh/bin/pi-dev，logDir 是 $HOME/.dsh/pi-logs', async () => {
  // The default command does not exist under the redirected HOME, so the spawn
  // failure names it and the real wrapper is never executed.
  const registered = [];
  const ctx = {
    logger: { warn: () => {} },
    tools: { register(definition) { registered.push(definition); } },
    sessions: new FakeSessions({}),
    sessionPersistence: new FakePersistence({}),
  };
  apply(ctx, {});
  assert.equal(registered.length, 1);
  const value = await registered[0].execute({ prompt: '任务' }, {
    agent: fakeAgent(fakeParent()),
    signal: new AbortController().signal,
  });
  assert.equal(value.stopReason, 'error');
  assert.match(value.diagnostic, new RegExp(DEFAULT_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // Default logDir under the same HOME, with an explicit command so the run works.
  const fixturePath = await writeFixture({ stdout: 'ok' });
  const recorded = recordPath();
  const mounted = mount({ config: { logDir: undefined } });
  await runTool(mounted, fakeParent(), { prompt: briefWith('默认日志', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));
  const logPath = record.argv[record.argv.indexOf('--log') + 1];
  assert.equal(dirname(logPath), join(homeRoot, '.dsh', 'pi-logs'));
});

test('配置校验：数值项必须正有限、command 非空、projection 必须布尔', () => {
  const logDir = join(root, 'logs');
  assert.throws(() => mount({ config: { logDir, graceMs: 0 } }), /graceMs must be a positive finite number/);
  assert.throws(
    () => mount({ config: { logDir, maxOutputBytes: Number.POSITIVE_INFINITY } }),
    /maxOutputBytes must be a positive finite number/,
  );
  assert.throws(() => mount({ config: { logDir, command: '' } }), /command must be a non-empty string/);
  assert.throws(() => mount({ config: { logDir, projection: 'yes' } }), /projection must be a boolean/);
  assert.throws(() => mount({ config: { logDir, args: [1] } }), /args\[0\] must be a string/);
  assert.throws(() => mount({ config: { logDir, approve: 'yes' } }), /approve must be a boolean/);
});

test('临时目录清理：brief 目录在 run 结束后不存在', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  await runTool(mounted, parent, { prompt: briefWith('清理', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));
  const briefPath = record.argv[record.argv.indexOf('--brief') + 1];
  assert.equal(existsSync(dirname(briefPath)), false, 'brief 写在独立临时目录里，run 结束后删除');
});
