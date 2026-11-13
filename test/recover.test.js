/**
 * Unit tests for the opt-in legacy backfill tool (`pi_recover_legacy`).
 *
 * DSH is not loaded: the fake `ctx` below records what the plugin asks of
 * `tools`, `sessions`, and `sessionPersistence`, and the fake parent session
 * serves `snapshotEvents()` the way a real one would by exposing its own
 * catalog rows. Legacy logs live in a scratch directory passed as `logDir`, so
 * the real `~/.dsh` is never read or written.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'dsh-pi-subagent-recover-'));
const { apply } = await import('../lib/index.js');

/** Logs written for the shared legacy fixtures. */
const TEXT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const MISSING_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const JSONL_ID = 'a11097f7-801a-4ad4-bd70-492b02e7e1f0';

/** The text log's content. */
const TEXT_ANSWER = '旧派活的最终回答\n第二行';

/** The JSONL log's answer (the last non-empty assistant message). */
const JSONL_ANSWER = '一期完整回答\n补回来的第二行';

let logDir = '';
let sequence = 0;

/** One fake session: id, header, and appended events in order. */
function makeSession(id, meta, log) {
  sequence += 1;
  const events = [];
  const header = { version: 4, id, createdAt: 1_760_000_000_000 + sequence, isSeeded: false, ...meta };
  return {
    id,
    header,
    events,
    snapshotEvents() {
      // The pre-publication boundary marker plus everything appended so far.
      return [{ type: 'session/end-seed', data: {}, seq: 0 }, ...structuredClone(events)];
    },
    append(type, data, opts) {
      log.push(`append:${id === 'parent-1' ? 'parent' : 'child'}:${type}`);
      if (typeof this.appendError === 'function' && this.appendError(type, data) === true) {
        throw new Error(`rejected ${type}`);
      }
      events.push({
        type,
        data: structuredClone(data),
        ...(opts === undefined ? {} : { opts: structuredClone(opts) }),
      });
      return { type, data, seq: events.length };
    },
  };
}

/** The fake parent session: seeded with the catalog rows the test needs. */
function fakeParent(catalogRows, log) {
  const parent = makeSession('parent-1', { cwd: root, delegationDepth: 1 }, log);
  for (const row of catalogRows) {
    parent.events.push({
      type: 'subagent/catalog',
      data: {
        version: 0,
        childCreatedAt: 1_760_000_000_000,
        mode: 'one-shot',
        ...row,
      },
    });
  }
  return parent;
}

/** The injected session store. */
class FakeSessions {
  constructor(log) {
    this.log = log;
    this.prepared = [];
    this.entered = [];
    this.announced = [];
    this.detached = [];
    this.flushes = [];
  }

  prepare(id, options) {
    this.log.push('sessions:prepare');
    const session = makeSession(id, options?.meta, this.log);
    this.prepared.push({ id, options, session });
    return session;
  }

  enter(session) {
    this.log.push('sessions:enter');
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
  }
}

/** The injected persistence service. */
class FakePersistence {
  constructor(log) {
    this.log = log;
    this.created = [];
    this.appended = [];
    this.closed = [];
  }

  async create(header, options) {
    this.log.push('persistence:create');
    this.created.push({ header, options });
    const log = this.log;
    const appended = this.appended;
    return {
      async append(events) {
        log.push('persistence:append');
        appended.push(structuredClone(events));
      },
      async flush() {},
      async close() {
        log.push('persistence:close');
        appended.push([]);
      },
    };
  }
}

/**
 * Mount the plugin on a fake context.
 * @param options - `config` overrides.
 */
function mount(options = {}) {
  const log = [];
  const sessions = new FakeSessions(log);
  const persistence = new FakePersistence(log);
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
    effect(callback) {
      callback();
    },
    sessions,
    sessionPersistence: persistence,
  };
  apply(ctx, { logDir, ...(options.config ?? {}) });
  return { ctx, sessions, persistence, warned, registered, log };
}

/** Find one registered tool by name. */
function toolNamed(mounted, name) {
  return mounted.registered.find((definition) => definition.name === name);
}

/** Invoke the backfill tool with a parent agent. */
function runRecover(mounted, parent, args = {}) {
  return toolNamed(mounted, 'pi_recover_legacy').execute(args, {
    agent: { id: parent.id, session: parent, options: {} },
    callId: 'call-recover',
  });
}

/** The three catalog rows shared by most cases. */
function defaultCatalog() {
  return [
    { childId: TEXT_ID, mode: 'external', label: '旧派活甲' },
    { childId: MISSING_ID, mode: 'external', label: '旧派活乙' },
    { childId: JSONL_ID, mode: 'one-shot', label: '第一期残缺' },
  ];
}

/** One JSONL log mixing bad lines, an early answer, a tool summary, and the answer. */
function jsonlLog() {
  const records = [
    { type: 'session', version: 3, id: 'pi-legacy' },
    { type: 'turn_start' },
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '早期草稿，不该被采用' }] },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: false,
      durationMs: 12,
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-2',
      toolName: 'read',
      isError: true,
      durationMs: 3,
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: JSONL_ANSWER },
          { type: 'thinking', thinking: '不投影' },
        ],
      },
    },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '任务' }] } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] } },
  ];
  const lines = records.map((record) => JSON.stringify(record));
  // A truncated record must be skipped, not abort the parse.
  lines.splice(4, 0, '{"type":"message_end","message":');
  return `${lines.join('\n')}\n`;
}

before(async () => {
  logDir = join(root, 'logs');
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, `20260101-101010-${TEXT_ID.slice(0, 8)}.log`), TEXT_ANSWER, 'utf8');
  await writeFile(join(logDir, `20261112-144547-${JSONL_ID.slice(0, 8)}.log`), jsonlLog(), 'utf8');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('配置开关：默认不注册回填工具，recoverLegacy: true 才注册', () => {
  const off = mount();
  assert.deepEqual(off.registered.map((definition) => definition.name), ['pi']);

  const on = mount({ config: { recoverLegacy: true } });
  assert.deepEqual(on.registered.map((definition) => definition.name), ['pi', 'pi_recover_legacy']);

  const definition = toolNamed(on, 'pi_recover_legacy');
  assert.match(definition.description, /Maintenance tool/);
  assert.match(definition.description, /disabled by default/);
  assert.match(definition.description, /idempotent/i);
  assert.deepEqual(Object.keys(definition.parameters.properties), ['dryRun', 'ids']);
  assert.equal(definition.parameters.required, undefined);
  assert.equal(definition.parameters.properties.dryRun.type, 'boolean');
  assert.equal(definition.parameters.properties.ids.type, 'array');
  assert.equal(typeof definition.output.render, 'function');
  assert.deepEqual(definition.output.schema.required, [
    'dryRun',
    'recovered',
    'planned',
    'skipped',
    'failed',
    'items',
  ]);

  assert.throws(() => mount({ config: { recoverLegacy: 'yes' } }), /recoverLegacy must be a boolean/);
});

test('回填：external 行 + ids 指定的 one-shot 行各建一个可点开的只读子会话', async () => {
  const mounted = mount({ config: { recoverLegacy: true } });
  const parent = fakeParent(defaultCatalog(), mounted.log);

  const value = await runRecover(mounted, parent, { ids: [JSONL_ID] });

  assert.equal(value.dryRun, false);
  assert.equal(value.recovered, 3);
  assert.equal(value.planned, 0);
  assert.equal(value.skipped, 0);
  assert.equal(value.failed, 0);
  assert.equal(mounted.sessions.prepared.length, 3);
  assert.deepEqual(mounted.warned, []);

  const byLegacy = new Map(value.items.map((item) => [item.legacyChildId, item]));
  for (const [legacyId, label] of [
    [TEXT_ID, '旧派活甲'],
    [MISSING_ID, '旧派活乙'],
    [JSONL_ID, '第一期残缺'],
  ]) {
    const item = byLegacy.get(legacyId);
    assert.equal(item.status, 'recovered');
    assert.equal(item.label, label);
    assert.equal(typeof item.newChildId, 'string');
    assert.notEqual(item.newChildId, legacyId);

    const prepared = mounted.sessions.prepared.find((entry) => entry.id === item.newChildId);
    assert.ok(prepared, 'the report must name the created session');

    // v4 event order, with the descriptor outside the turn.
    assert.deepEqual(prepared.session.events.map((event) => event.type), [
      'subagent/descriptor',
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ]);
    assert.deepEqual(prepared.session.events[0].data, {
      version: 3,
      mode: 'one-shot',
      provider: 'pi',
      label: `recovered ${legacyId.slice(0, 8)}`,
    });
    assert.deepEqual(prepared.session.events[1].data, { turn: 1 });
    assert.equal(
      prepared.session.events[2].data.content[0].text,
      `[backfilled legacy delegation]\n${label}`,
    );
    assert.deepEqual(prepared.session.events[3].data, { turn: 1, step: 1 });
    assert.deepEqual(prepared.session.events[5].data, { turn: 1, step: 1 });
    assert.deepEqual(prepared.session.events[6].data, { turn: 1, reason: { kind: 'completed' } });

    const { message, step, turn } = prepared.session.events[4].data;
    assert.equal(turn, 1);
    assert.equal(step, 1);
    assert.equal(message.role, 'assistant');
    assert.deepEqual(message.source, { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' });
    assert.deepEqual(prepared.session.events[4].data.stream, []);

    // The parent catalog payload is the exact v0 shape.
    const catalog = parent.events
      .filter((event) => event.type === 'subagent/catalog')
      .map((event) => event.data)
      .find((row) => row.childId === item.newChildId);
    assert.deepEqual(catalog, {
      version: 0,
      childId: item.newChildId,
      childCreatedAt: prepared.session.header.createdAt,
      mode: 'one-shot',
      label: `（回填 ${legacyId.slice(0, 8)}）${label}`,
    });
  }

  // Text log: the whole file.
  const text = byLegacy.get(TEXT_ID);
  assert.equal(text.format, 'text');
  assert.match(text.logPath, /20260101-101010-aaaaaaaa\.log$/);
  assert.equal(text.chars, TEXT_ANSWER.length);
  const textSession = mounted.sessions.prepared.find((entry) => entry.id === text.newChildId).session;
  assert.deepEqual(textSession.events[4].data.message.content, [{ type: 'text', text: TEXT_ANSWER }]);

  // Missing log: the session is still created, with the documented notice.
  const missing = byLegacy.get(MISSING_ID);
  assert.equal(missing.format, 'missing');
  assert.equal(missing.logPath, '');
  assert.equal(missing.chars, '（原日志缺失，未能恢复内容）'.length);
  const missingSession = mounted.sessions.prepared.find((entry) => entry.id === missing.newChildId).session;
  assert.deepEqual(missingSession.events[4].data.message.content, [
    { type: 'text', text: '（原日志缺失，未能恢复内容）' },
  ]);

  // JSONL log: the last non-empty assistant answer plus the tool appendix, and
  // never the earlier draft.
  const jsonl = byLegacy.get(JSONL_ID);
  assert.equal(jsonl.format, 'jsonl');
  assert.match(jsonl.logPath, /20261112-144547-a11097f7\.log$/);
  const jsonlSession = mounted.sessions.prepared.find((entry) => entry.id === jsonl.newChildId).session;
  const jsonlText = jsonlSession.events[4].data.message.content[0].text;
  assert.ok(jsonlText.startsWith(JSONL_ANSWER));
  assert.match(jsonlText, /工具摘要/);
  assert.match(jsonlText, /tool bash 12ms ok/);
  assert.match(jsonlText, /tool read 3ms error/);
  assert.doesNotMatch(jsonlText, /早期草稿/);

  // Each new child is created, published, and closed (read-only history).
  assert.equal(mounted.sessions.detached.length, 3);
  assert.equal(mounted.persistence.created.length, 3);
  assert.equal(mounted.persistence.appended.length, 6, 'one boundary marker and one close per session');
  const position = (needle) => mounted.log.indexOf(needle);
  assert.ok(position('sessions:enter') < position('append:child:subagent/descriptor'));
  assert.ok(position('append:child:turn/end') < position('append:parent:subagent/catalog'));
  assert.ok(position('append:parent:subagent/catalog') < position('sessions:detach'));
  assert.ok(position('sessions:flush:parent-1') < position('sessions:detach'));
  assert.ok(position('sessions:detach') < position('persistence:close'));
});

test('labelPrefix 不影响回填 label：descriptor 与 catalog 保持回填格式', async () => {
  const mounted = mount({ config: { recoverLegacy: true, labelPrefix: '[Pi] ' } });
  const parent = fakeParent([{ childId: TEXT_ID, mode: 'external', label: '旧派活甲' }], mounted.log);

  const value = await runRecover(mounted, parent, {});
  assert.equal(value.recovered, 1);

  const item = value.items[0];
  const catalog = parent.events.find(
    (event) => event.type === 'subagent/catalog' && event.data.childId === item.newChildId,
  );
  assert.equal(catalog.data.label, `（回填 ${TEXT_ID.slice(0, 8)}）旧派活甲`);
  const prepared = mounted.sessions.prepared.find((entry) => entry.id === item.newChildId);
  assert.equal(
    prepared.session.events.find((event) => event.type === 'subagent/descriptor').data.label,
    `recovered ${TEXT_ID.slice(0, 8)}`,
  );
});

test('幂等：第二次运行跳过已回填的行，不再建会话', async () => {
  const mounted = mount({ config: { recoverLegacy: true } });
  const parent = fakeParent(defaultCatalog(), mounted.log);

  const first = await runRecover(mounted, parent, { ids: [JSONL_ID] });
  assert.equal(first.recovered, 3);
  const createdAfterFirst = mounted.sessions.prepared.length;
  const catalogAfterFirst = parent.events.filter((event) => event.type === 'subagent/catalog').length;

  const second = await runRecover(mounted, parent, { ids: [JSONL_ID] });
  assert.equal(second.recovered, 0);
  assert.equal(second.skipped, 3);
  assert.equal(second.failed, 0);
  for (const item of second.items) {
    assert.equal(item.status, 'skipped');
    assert.equal(item.reason, 'already backfilled');
  }
  assert.equal(mounted.sessions.prepared.length, createdAfterFirst, 'no new session on a repeat run');
  assert.equal(
    parent.events.filter((event) => event.type === 'subagent/catalog').length,
    catalogAfterFirst,
    'no catalog row is appended twice',
  );

  // The skip is driven by the label prefix the first run wrote.
  const labels = parent.events
    .filter((event) => event.type === 'subagent/catalog')
    .map((event) => event.data.label)
    .filter((label) => typeof label === 'string' && label.startsWith('（回填 '));
  assert.equal(labels.length, 3);
});

test('dryRun：只报告，不建会话、不写父会话', async () => {
  const mounted = mount({ config: { recoverLegacy: true } });
  const parent = fakeParent(defaultCatalog(), mounted.log);
  const before = parent.events.length;

  const value = await runRecover(mounted, parent, { dryRun: true, ids: [JSONL_ID] });

  assert.equal(value.dryRun, true);
  assert.equal(value.planned, 3);
  assert.equal(value.recovered, 0);
  assert.equal(value.failed, 0);
  assert.equal(mounted.sessions.prepared.length, 0);
  assert.equal(mounted.persistence.created.length, 0);
  assert.equal(parent.events.length, before);
  assert.deepEqual(mounted.warned, []);
  for (const item of value.items) {
    assert.equal(item.status, 'planned');
    assert.equal(item.newChildId, undefined);
  }
});

test('单条失败不影响其余：warn 后继续下一条', async () => {
  const mounted = mount({ config: { recoverLegacy: true } });
  const parent = fakeParent(defaultCatalog(), mounted.log);
  const textShort = TEXT_ID.slice(0, 8);
  parent.appendError = (type, data) => (
    type === 'subagent/catalog' && typeof data.label === 'string' && data.label.startsWith(`（回填 ${textShort}）`)
  );

  const value = await runRecover(mounted, parent, { ids: [JSONL_ID] });

  assert.equal(value.failed, 1);
  assert.equal(value.recovered, 2);
  assert.equal(mounted.sessions.prepared.length, 3);
  const failed = value.items.find((item) => item.status === 'failed');
  assert.equal(failed.legacyChildId, TEXT_ID);
  assert.match(failed.error, /rejected subagent\/catalog/);
  assert.equal(mounted.warned.length, 1);
  assert.match(mounted.warned[0], /could not backfill the legacy delegation/);
});

test('参数校验：dryRun 必须是布尔，ids 必须是字符串数组', async () => {
  const mounted = mount({ config: { recoverLegacy: true } });
  const parent = fakeParent([], mounted.log);

  await assert.rejects(() => runRecover(mounted, parent, { dryRun: 'yes' }), /`dryRun` must be a boolean/);
  await assert.rejects(() => runRecover(mounted, parent, { ids: 'a' }), /`ids` must be an array of strings/);
  await assert.rejects(() => runRecover(mounted, parent, { ids: [''] }), /`ids\[0\]` must be a non-empty string/);
});

test('日志目录不存在时仍能恢复（内容为缺失说明）', async () => {
  const mounted = mount({ config: { recoverLegacy: true, logDir: join(root, 'no-such-dir') } });
  const parent = fakeParent([{ childId: TEXT_ID, mode: 'external', label: '旧派活甲' }], mounted.log);

  const value = await runRecover(mounted, parent);

  assert.equal(value.recovered, 1);
  const item = value.items[0];
  assert.equal(item.logPath, '');
  assert.equal(item.format, 'missing');
  const session = mounted.sessions.prepared[0].session;
  assert.equal(
    session.events[4].data.message.content[0].text,
    '（原日志缺失，未能恢复内容）',
  );
});

test('模型可见文本：一行汇总加每行状态与目标', async () => {
  const mounted = mount({ config: { recoverLegacy: true } });
  const parent = fakeParent(defaultCatalog(), mounted.log);
  const value = await runRecover(mounted, parent);
  const rendered = toolNamed(mounted, 'pi_recover_legacy').output.render({}, value);

  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /legacy backfill: 2 recovered/);
  assert.match(rendered[0].text, new RegExp(TEXT_ID));
  assert.match(rendered[0].text, /recovered/);
  assert.match(rendered[0].text, /aaaaaaaa\.log/);
});
