/**
 * Unit tests for the `pi` tool and its live session projection.
 *
 * Every delegation spawns a real child process — `test/fake-pi-dev.mjs`, copied
 * into the scratch root and executed as the configured `command`. The fixture
 * reads the brief for its `FIXTURE`/`RECORD` directives, so one generic script
 * covers structured runs, early partial output, plain-text runs, failures, slow
 * runs, and SIGTERM-ignoring runs while every test can inspect the exact argv
 * the plugin built. Its own file name decides whether `--help` advertises
 * `--mode`, which is how the JSON/text probe is exercised.
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

/** The test-owned wrapper that advertises `--mode` in `--help`. */
let FAKE_PI = '';

/** A wrapper whose `--help` does not mention `--mode` (text-mode degradation). */
let FAKE_PI_OLD = '';

/** Scratch root for fixtures, logs, and the copied wrappers. */
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
  const disposers = [];
  const ctx = {
    logger: { warn: (...parts) => warned.push(parts.join(' ')) },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    effect(callback) {
      disposers.push(callback());
    },
    ...(sessions === null ? {} : { sessions }),
    ...(persistence === null ? {} : { sessionPersistence: persistence }),
  };
  apply(ctx, { command: FAKE_PI, logDir: join(root, 'logs'), ...(options.config ?? {}) });
  assert.equal(registered.length, 1, 'apply must register exactly one tool');
  return { definition: registered[0], ctx, sessions, persistence, warned, log, disposers };
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

/** Wait until `predicate()` is truthy (a streamed event has landed). */
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the projection to reach a state');
}

/** The message_end record for one assistant message. */
function assistantEnd({ content, usage, provider = 'deepseek', model = 'deepseek-flash', stopReason = 'stop' }) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      provider,
      model,
      ...(usage === undefined ? {} : { usage }),
      stopReason,
      timestamp: 1_700_000_000_000,
    },
  };
}

/**
 * Records for the canonical run: one tool-calling step, then a final text step.
 * The first assistant message carries both a thinking block and a tool call.
 */
function structuredRecords({ text = '改完了：lib/index.js' } = {}) {
  return [
    { type: 'session', version: 3, id: 'pi-session-1', cwd: root },
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'user', content: '任务', timestamp: 1_700_000_000_001 } },
    { type: 'message_end', message: { role: 'user', content: '任务', timestamp: 1_700_000_000_001 } },
    assistantEnd({
      content: [
        { type: 'thinking', thinking: '先看看文件' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
      ],
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'toolUse',
    }),
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'lib/index.js' }], structuredContent: { entries: ['lib/index.js'] } },
      isError: false,
      durationMs: 12,
    },
    { type: 'turn_end', message: {}, toolResults: [] },
    { type: 'turn_start' },
    assistantEnd({
      content: [{ type: 'text', text }],
      usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 4, reasoning: 1 },
    }),
    { type: 'turn_end', message: {}, toolResults: [] },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled', aborted: false },
  ];
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-subagent-pi-test-'));
  FAKE_PI = join(root, 'fake-pi-dev.mjs');
  FAKE_PI_OLD = join(root, 'fake-pi-dev-old.mjs');
  const fixture = await readFile(new URL('./fake-pi-dev.mjs', import.meta.url), 'utf8');
  await writeFile(FAKE_PI, fixture, 'utf8');
  await writeFile(FAKE_PI_OLD, fixture, 'utf8');
  await chmod(FAKE_PI, 0o755);
  await chmod(FAKE_PI_OLD, 0o755);
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
  assert.match(definition.description, /tool calls/);
  assert.match(definition.description, /pass the id back as `session`/);
  assert.deepEqual(Object.keys(definition.parameters.properties), ['prompt', 'cwd', 'label', 'session']);
  assert.deepEqual(definition.parameters.required, ['prompt']);
  assert.equal(definition.parameters.properties.prompt.type, 'string');
  assert.equal(definition.parameters.properties.cwd.type, 'string');
  assert.equal(definition.parameters.properties.label.type, 'string');
  assert.equal(definition.parameters.properties.session.type, 'string');
  assert.deepEqual(definition.output.schema.required, ['output', 'childSessionId', 'session', 'logPath', 'stopReason']);
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
});

test('探测：--help 广告 --mode → 走 JSON 流，argv 带 --mode json', async () => {
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
  assert.equal(record.argv.includes('--log'), false, 'summary mode must not ask the wrapper to tee the JSON stream');
  assert.match(value.logPath, /\d{8}-\d{6}-[0-9a-f]{8}\.log$/);
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了：lib/index.js');
  assert.deepEqual(mounted.warned, []);
});

test('探测：--help 不提 --mode → 文本模式，不重试、不带 --mode', async () => {
  const fixturePath = await writeFixture({ stdout: '改完了\n' });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({ config: { command: FAKE_PI_OLD } });

  const value = await runTool(mounted, parent, { prompt: briefWith('老封装', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  assert.equal(record.argv.includes('--mode'), false);
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了');
  assert.match(mounted.warned[0], /does not advertise --mode/);
  const events = mounted.sessions.prepared[0].session.events;
  assert.deepEqual(events.map((event) => event.type), [
    'turn/start',
    'subagent/descriptor',
    'user/message',
    'step/start',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);
  assert.deepEqual(events[4].data.message.content, [{ type: 'text', text: '改完了' }]);
});

test('projection=false：不探测、不传 --mode、不碰 sessions，结果照常返回', async () => {
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

test('cwd 校验：相对路径 / 不存在的目录都在建会话和 spawn 之前失败', async () => {
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

test('完成的运行：会话先建后跑，事件序列、flush 顺序、返回值与模型文本', async () => {
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

  // Event sequence: the turn opens, the descriptor sits inside it, the prompt
  // lands, then one step per Pi turn (step 1 carries the tool call and step 2
  // the final text), and the turn closes.
  assert.deepEqual(session.events.map((event) => event.type), [
    'turn/start',
    'subagent/descriptor',
    'user/message',
    'step/start',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
    'step/start',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);

  // Order around the projection: create → persist the pre-publication marker
  // → enter → announce → append. The opening events and the parent catalog row
  // exist before the child process starts; flush/detach/close come last.
  assert.equal(mounted.persistence.appended.length, 1, 'the constructor marker must be persisted first');
  assert.deepEqual(mounted.persistence.appended[0].map((event) => event.type), ['session/end-seed']);
  const position = (entry) => mounted.log.indexOf(entry);
  assert.ok(position('persistence:create') < position('persistence:append'));
  assert.ok(position('persistence:append') < position('sessions:enter'));
  assert.ok(position('persistence:create') < position('sessions:enter'));
  assert.ok(position('sessions:enter') < position('sessions:announce'));
  assert.ok(position('sessions:announce') < position('append:child:turn/start'));
  assert.ok(position('append:child:user/message') < position('append:parent:subagent/catalog'));
  assert.ok(position('append:parent:subagent/catalog') < position('append:child:step/start'));
  assert.ok(position('append:child:turn/end') < position(`sessions:flush:${id}`));
  assert.ok(position(`sessions:flush:${id}`) < position('sessions:flush:parent-1'));
  // Retained for reuse: no detach and no close after the run, only a flush.
  assert.equal(mounted.sessions.detached.length, 0, 'the projected child stays live so a later call can continue it');
  assert.deepEqual(mounted.persistence.closed, []);

  // Model-facing text: answer first, then the session, the continuation hint,
  // and the log pointer.
  assert.deepEqual(mounted.definition.output.render({ prompt }, value), [{
    type: 'text',
    text: [
      '改完了：lib/index.js',
      `subagent session: ${id}`,
      `to continue this delegation, pass session: ${id}`,
      `full output: ${value.logPath}`,
    ].join('\n'),
  }]);
});

test('完整工具调用流：turn/start、descriptor、user/message、step、assistant、tool/call、tool/result、turn/end', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('修一个 bug', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;
  const events = session.events;
  const types = events.map((event) => event.type);

  // Opening order on the surface.
  assert.equal(types[0], 'turn/start');
  assert.equal(types[1], 'subagent/descriptor');
  assert.equal(types[2], 'user/message');
  assert.deepEqual(events[0].data, { turn: 1 });
  assert.deepEqual(events[1].data, { version: 3, mode: 'one-shot', provider: 'pi', label: '修一个 bug' });
  assert.equal(events[2].data.content[0].type, 'text');
  assert.match(events[2].data.content[0].text, /^修一个 bug/);
  assert.deepEqual(events[2].opts, { surfaceOp: 'append' });

  // One step per Pi turn, brackets balanced and every in-step event carrying
  // its open step's number.
  const steps = events.filter((event) => event.type === 'step/start');
  const stepEnds = events.filter((event) => event.type === 'step/end');
  assert.deepEqual(steps.map((event) => event.data), [{ turn: 1, step: 1 }, { turn: 1, step: 2 }]);
  assert.deepEqual(stepEnds.map((event) => event.data), [{ turn: 1, step: 1 }, { turn: 1, step: 2 }]);
  let openStep = null;
  for (const event of events) {
    if (event.type === 'step/start') {
      assert.equal(openStep, null, 'a step must not open inside another step');
      openStep = event.data.step;
      continue;
    }
    if (event.type === 'step/end') {
      assert.equal(openStep, event.data.step, 'a step must close the one it opened');
      openStep = null;
      continue;
    }
    if (openStep !== null && ['assistant/message', 'tool/call', 'tool/result'].includes(event.type)) {
      assert.equal(event.data.turn, 1);
      assert.equal(event.data.step, openStep);
    }
  }
  assert.equal(openStep, null, 'every step must be closed');

  // Assistant message 1: reasoning + tool-call, the tool-call arguments being
  // the raw JSON string DSH stores.
  const assistants = events.filter((event) => event.type === 'assistant/message');
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants[0].data.message.content, [
    { type: 'reasoning', text: '先看看文件' },
    { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
  ]);
  assert.deepEqual(assistants[0].data.message.source, { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' });
  assert.equal(assistants[0].data.turn, 1);
  assert.equal(assistants[0].data.step, 1);
  assert.deepEqual(assistants[0].opts, { surfaceOp: 'append' });
  assert.deepEqual(assistants[1].data.message.content, [{ type: 'text', text: '改完了：lib/index.js' }]);
  assert.equal(assistants[1].data.step, 2);

  // The advertised call is answered: exact arguments, same call id, the tool
  // result on the surface.
  const call = events.find((event) => event.type === 'tool/call');
  assert.deepEqual(call.data, {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'bash',
    arguments: '{"command":"ls"}',
  });
  assert.equal(call.opts, undefined);
  const block = assistants[0].data.message.content.find((item) => item.type === 'tool-call');
  assert.equal(call.data.arguments, block.arguments);

  const result = events.find((event) => event.type === 'tool/result');
  assert.deepEqual(result.data, {
    turn: 1,
    step: 1,
    message: {
      id: result.data.message.id,
      role: 'tool',
      content: [{ type: 'text', text: 'lib/index.js' }],
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
    },
  });
  assert.equal(result.data.message.isError, undefined);
  assert.deepEqual(result.opts, { surfaceOp: 'append' });

  // Every advertised call has exactly one result and is resolved before its
  // step closes (the durable log rejects an unresolved call).
  const advertised = assistants.flatMap((event) => event.data.message.content.filter((item) => item.type === 'tool-call'));
  const resolved = events.filter((event) => event.type === 'tool/result').map((event) => event.data.message.toolCallId);
  assert.deepEqual(advertised.map((item) => item.id), resolved);
  const resultIndex = types.indexOf('tool/result');
  assert.ok(types.indexOf('tool/call') < resultIndex);
  assert.ok(resultIndex < types.lastIndexOf('step/end'));

  assert.deepEqual(events[events.length - 1].data, { turn: 1, reason: { kind: 'completed' } });
  assert.equal(value.output, '改完了：lib/index.js');
});

test('多轮：两个 Pi turn → 两个 step，编号 1、2，只有一个 DSH turn', async () => {
  const fixturePath = await writeFixture({
    stdout: ndjson([
      { type: 'turn_start' },
      assistantEnd({ content: [{ type: 'text', text: '第一步' }], usage: { input: 1, output: 1 } }),
      { type: 'turn_end' },
      { type: 'turn_start' },
      assistantEnd({
        content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: '第二步' }],
        provider: 'p',
        model: 'm',
      }),
      { type: 'turn_end' },
      { type: 'agent_settled', aborted: false },
    ]),
  });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('多轮', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;

  assert.deepEqual(
    session.events.filter((event) => event.type === 'turn/start').map((event) => event.data),
    [{ turn: 1 }],
    'Pi turns are DSH steps, so the log has one DSH turn',
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === 'step/start').map((event) => event.data),
    [{ turn: 1, step: 1 }, { turn: 1, step: 2 }],
  );
  const assistants = session.events.filter((event) => event.type === 'assistant/message');
  assert.deepEqual(assistants.map((event) => [event.data.step, event.data.message.content]), [
    [1, [{ type: 'text', text: '第一步' }]],
    [2, [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '第二步' }]],
  ]);
  assert.deepEqual(assistants[0].data.usage, { inputTokens: 1, outputTokens: 1 });
  assert.equal(assistants[1].data.usage, undefined, '没有 usage 的那条不带 usage 字段');
  assert.deepEqual(session.events[0].data, { turn: 1 });
  assert.deepEqual(session.events[session.events.length - 1].data, { turn: 1, reason: { kind: 'completed' } });
  assert.equal(session.events.filter((event) => event.type === 'user/message').length, 1, '任务只投影一次');
  assert.equal(value.output, '第二步', '最终回答取最后一条非空文本');
});

test('参数与结果映射：thinking→reasoning、toolCall→tool-call、usage、错误结果 isError', async () => {
  const fixturePath = await writeFixture({
    stdout: ndjson([
      { type: 'turn_start' },
      assistantEnd({
        content: [
          { type: 'thinking', thinking: '想一下' },
          { type: 'text', text: '调用工具' },
          { type: 'toolCall', id: 'tc-9', name: 'read', arguments: { path: 'a.txt', lines: 3 } },
        ],
        usage: { input: 7, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
        stopReason: 'toolUse',
      }),
      {
        type: 'tool_execution_end',
        toolCallId: 'tc-9',
        toolName: 'read',
        result: { content: [], structuredContent: { error: 'boom' } },
        isError: true,
        durationMs: 4,
      },
      { type: 'turn_end' },
      { type: 'turn_start' },
      assistantEnd({ content: [{ type: 'text', text: '失败但继续' }] }),
      { type: 'turn_end' },
      { type: 'agent_settled', aborted: false },
    ]),
  });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('映射', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;
  const assistant = session.events.find((event) => event.type === 'assistant/message');

  assert.deepEqual(assistant.data.message.content, [
    { type: 'reasoning', text: '想一下' },
    { type: 'text', text: '调用工具' },
    { type: 'tool-call', id: 'tc-9', name: 'read', arguments: '{"path":"a.txt","lines":3}' },
  ]);
  assert.deepEqual(assistant.data.usage, {
    inputTokens: 7,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
  });
  assert.deepEqual(assistant.data.stream, []);

  const call = session.events.find((event) => event.type === 'tool/call');
  assert.equal(call.data.arguments, '{"path":"a.txt","lines":3}');

  const result = session.events.find((event) => event.type === 'tool/result');
  assert.equal(result.data.message.isError, true);
  assert.deepEqual(result.data.message.content, [{ type: 'text', text: '{"error":"boom"}' }]);
  assert.equal(result.data.message.toolCallId, 'tc-9');
  assert.deepEqual(result.data.message.source, { kind: 'tool', callId: 'tc-9' });

  // The step still closed and the run completed normally.
  const types = session.events.map((event) => event.type);
  assert.ok(types.indexOf('tool/result') < types.indexOf('step/end'));
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '失败但继续');
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
    'turn/start',
    'subagent/descriptor',
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
    'turn/start',
    'subagent/descriptor',
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

test('取消：运行中 abort → 未结算调用补 result、step 关闭、turn/end 是 aborted', async () => {
  const early = ndjson([
    { type: 'turn_start' },
    assistantEnd({
      content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'sleep 30' } }],
      stopReason: 'toolUse',
    }),
  ]);
  const fixturePath = await writeFixture({ stdoutEarly: early, delayMs: 30_000 });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();
  const controller = new AbortController();

  const running = runTool(mounted, parent, { prompt: briefWith('长任务', fixturePath, recorded) }, {
    signal: controller.signal,
  });
  await waitForFile(recorded);
  const session = mounted.sessions.prepared[0].session;
  await waitFor(() => session.events.some((event) => event.type === 'tool/call'));
  controller.abort();
  const value = await running;

  assert.equal(value.stopReason, 'aborted');
  const types = session.events.map((event) => event.type);
  // The advertised call could not finish: a synthetic error result closes it
  // before the step, then the turn ends as aborted.
  assert.deepEqual(types, [
    'turn/start',
    'subagent/descriptor',
    'user/message',
    'step/start',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
    'turn/end',
  ]);
  const result = session.events.find((event) => event.type === 'tool/result');
  assert.equal(result.data.message.toolCallId, 'call-1');
  assert.equal(result.data.message.isError, true);
  assert.match(result.data.message.content[0].text, /did not return a result/);
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

test('降级：sessions.prepare 抛错 → 派活结果照常返回，只 warn 一次', async () => {
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

test('降级：运行中 append 被拒 → 只 warn，结构仍收尾，结果照常', async () => {
  const fixturePath = await writeFixture({
    stdout: ndjson([
      { type: 'turn_start' },
      assistantEnd({ content: [{ type: 'text', text: '改完了' }] }),
      { type: 'turn_end' },
      { type: 'agent_settled', aborted: false },
    ]),
  });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({
    sessionsOptions: { appendError: { type: 'assistant/message', error: new Error('surface append rejected') } },
  });

  const value = await runTool(mounted, parent, { prompt: briefWith('任务', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;

  assert.equal(value.output, '改完了');
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.childSessionId, session.id);
  assert.match(mounted.warned[0], /surface append rejected/);
  // Content after the rejected append is skipped, but the step and turn still
  // close so the stored log is not left structurally open.
  assert.deepEqual(session.events.map((event) => event.type), [
    'turn/start',
    'subagent/descriptor',
    'user/message',
    'step/start',
    'step/end',
    'turn/end',
  ]);
  assert.equal(mounted.sessions.detached.length, 0);
  assert.deepEqual(mounted.persistence.closed, []);
});

test('超长行：丢弃单行并 warn，后续记录照常投影', async () => {
  const oversized = `${'x'.repeat(2 * 1024 * 1024 + 16)}\n`;
  const fixturePath = await writeFixture({
    stdoutEarly: oversized,
    stdout: ndjson(structuredRecords()),
  });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  const value = await runTool(mounted, parent, { prompt: briefWith('超长行', fixturePath, recorded) });
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了：lib/index.js');
  assert.ok(mounted.warned.some((line) => /dropping a \d+-character output line/.test(line)));
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
  const texts = sessions.map((session) => {
    const assistants = session.events.filter((event) => event.type === 'assistant/message');
    return assistants[assistants.length - 1].data.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  });
  assert.deepEqual(texts.sort(), ['run-A', 'run-B']);
  assert.equal(parent.events.filter((event) => event.type === 'subagent/catalog').length, 2, 'each run appends its own catalog row');
});

test('默认值：command 指向 $HOME/.dsh/bin/pi-dev，logDir 是 $HOME/.dsh/pi-logs', async () => {
  // The default command does not exist under the redirected HOME, so the probe
  // and the run both fail by name and the real wrapper is never executed.
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
  const runValue = await runTool(mounted, fakeParent(), { prompt: briefWith('默认日志', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));
  assert.equal(dirname(runValue.logPath), join(homeRoot, '.dsh', 'pi-logs'));
  // Default sessionDir under the same HOME, and the Pi session id always rides along.
  assert.equal(record.argv[record.argv.indexOf('--session-dir') + 1], join(homeRoot, '.dsh', 'pi-sessions'));
  assert.equal(record.argv.includes('--session-id'), true);
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
  assert.throws(() => mount({ config: { logDir, logMode: 'verbose' } }), /logMode must be "summary" or "full"/);
  assert.throws(() => mount({ config: { logDir, sessionDir: '' } }), /sessionDir must be a non-empty string/);
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

test('日志 summary：不传 --log，精简日志含首行、回答、工具行、usage 与 stopReason', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const mounted = mount();

  const value = await runTool(mounted, fakeParent(), { prompt: briefWith('修一个 bug', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  assert.equal(record.argv.includes('--log'), false, 'summary mode must not tee the JSON event stream');
  const lines = (await readFile(value.logPath, 'utf8')).trimEnd().split('\n');
  assert.equal(lines[0], '修一个 bug');
  assert.equal(lines[1], '改完了：lib/index.js');
  assert.ok(lines.includes('tool bash 12ms ok'), `missing tool line in ${JSON.stringify(lines)}`);
  assert.ok(
    lines.some((line) => /^usage input=30 output=7 cacheRead=3 cacheWrite=4 reasoning=1 stopReason=completed session=[0-9a-f-]{36}$/.test(line)),
    `missing usage line in ${JSON.stringify(lines)}`,
  );
  assert.deepEqual(mounted.warned, []);
});

test('日志 full：argv 带 --log，logPath 就是交给封装的那个文件', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const mounted = mount({ config: { logMode: 'full' } });

  const value = await runTool(mounted, fakeParent(), { prompt: briefWith('全量日志', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  const index = record.argv.indexOf('--log');
  assert.ok(index > -1);
  assert.equal(record.argv[index + 1], value.logPath);
  assert.equal(dirname(value.logPath), join(root, 'logs'));
});

test('复用：传 session → 同一个子会话追加 turn 2，不重复 descriptor/catalog，Pi 会话 id 不变', async () => {
  const firstFixture = await writeFixture({ stdout: ndjson(structuredRecords({ text: '第一轮' })) });
  const secondFixture = await writeFixture({ stdout: ndjson(structuredRecords({ text: '第二轮' })) });
  const firstRecord = recordPath();
  const secondRecord = recordPath();
  const mounted = mount();
  const parent = fakeParent(undefined, mounted.log);

  const first = await runTool(mounted, parent, { prompt: briefWith('第一轮', firstFixture, firstRecord) });
  assert.equal(typeof first.session, 'string');
  assert.notEqual(first.session, '');
  const second = await runTool(mounted, parent, {
    prompt: briefWith('第二轮', secondFixture, secondRecord),
    session: first.session,
  });

  assert.equal(second.childSessionId, first.childSessionId);
  assert.equal(second.session, first.session);
  assert.equal(mounted.sessions.prepared.length, 1, 'a continuation must not prepare another child session');
  assert.equal(mounted.persistence.created.length, 1, 'a continuation must not create another log');

  const session = mounted.sessions.prepared[0].session;
  const types = session.events.map((event) => event.type);
  assert.equal(types.filter((type) => type === 'subagent/descriptor').length, 1);
  assert.equal(types.filter((type) => type === 'user/message').length, 2, 'each turn carries its own task text');
  assert.deepEqual(
    session.events.filter((event) => event.type === 'turn/start').map((event) => event.data),
    [{ turn: 1 }, { turn: 2 }],
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === 'turn/end').map((event) => event.data),
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'completed' } }],
  );
  // Steps restart at 1 inside the new turn.
  assert.deepEqual(
    session.events.filter((event) => event.type === 'step/start').map((event) => event.data),
    [
      { turn: 1, step: 1 },
      { turn: 1, step: 2 },
      { turn: 2, step: 1 },
      { turn: 2, step: 2 },
    ],
  );
  assert.equal(
    parent.events.filter((event) => event.type === 'subagent/catalog').length,
    1,
    'the catalog row belongs to the delegation, not to each turn',
  );

  const firstArgv = JSON.parse(await readFile(firstRecord, 'utf8')).argv;
  const secondArgv = JSON.parse(await readFile(secondRecord, 'utf8')).argv;
  const piSessionIdOf = (argv) => argv[argv.indexOf('--session-id') + 1];
  assert.equal(piSessionIdOf(firstArgv), piSessionIdOf(secondArgv), 'Pi continues the same stored session');
  assert.equal(secondArgv[secondArgv.indexOf('--session-dir') + 1], join(homeRoot, '.dsh', 'pi-sessions'));
  assert.equal(firstArgv.includes('--no-session'), false);
  assert.equal(secondArgv.includes('--no-session'), false);

  // Both runs flushed child and parent, and neither released the child.
  assert.equal(mounted.sessions.flushes.length, 4);
  assert.deepEqual(mounted.persistence.closed, []);
  assert.equal(mounted.sessions.detached.length, 0);

  const secondLog = await readFile(second.logPath, 'utf8');
  assert.match(secondLog, /^第二轮/);
  assert.match(secondLog, new RegExp(`session=${second.childSessionId}`));
});

test('复用未知 session：抛清楚错误，不建新会话也不起进程', async () => {
  const recorded = recordPath();
  const mounted = mount();
  const parent = fakeParent();

  await assert.rejects(
    () => runTool(mounted, parent, { prompt: briefWith('未知', join(root, 'no-fixture.json'), recorded), session: 'session-not-here' }),
    /session session-not-here is not continuable in this host process; omit session to start a new one/,
  );
  assert.deepEqual(mounted.sessions.prepared, []);
  assert.equal(existsSync(recorded), false);
});

test('复用并发：同一 session 正在跑时再次调用直接报错', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()), delayMs: 30_000 });
  const recorded = recordPath();
  const mounted = mount();
  const parent = fakeParent();
  const controller = new AbortController();

  const running = runTool(mounted, parent, { prompt: briefWith('长任务', fixturePath, recorded) }, {
    signal: controller.signal,
  });
  await waitForFile(recorded);
  await waitFor(() => mounted.sessions.prepared.length === 1);
  const id = mounted.sessions.prepared[0].session.id;

  await assert.rejects(
    () => runTool(mounted, parent, { prompt: '接着干', session: id }),
    new RegExp(`session ${id} is already running`),
  );
  controller.abort();
  const value = await running;
  assert.equal(value.stopReason, 'aborted');
});

test('卸载：ctx.effect 释放保留的 handle，之后该 session 不再可续', async () => {
  const fixturePath = await writeFixture({ stdout: ndjson(structuredRecords()) });
  const recorded = recordPath();
  const mounted = mount();
  const parent = fakeParent();

  const value = await runTool(mounted, parent, { prompt: briefWith('卸载', fixturePath, recorded) });
  const session = mounted.sessions.prepared[0].session;
  assert.equal(mounted.disposers.length, 1, 'apply must register one unload effect');
  assert.equal(mounted.sessions.detached.length, 0);

  await mounted.disposers[0]();

  assert.deepEqual(mounted.sessions.detached.map((entry) => entry.id), [session.id]);
  assert.deepEqual(mounted.persistence.closed, [session.id]);
  assert.ok(mounted.log.indexOf(`sessions:flush:${session.id}`) < mounted.log.indexOf('sessions:detach'));
  assert.ok(mounted.log.indexOf('sessions:detach') < mounted.log.indexOf('persistence:close'));

  await assert.rejects(
    () => runTool(mounted, parent, { prompt: '再来', session: value.session }),
    /is not continuable in this host process/,
  );
});
