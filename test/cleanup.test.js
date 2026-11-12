/**
 * Unit tests for `scripts/cleanup.mjs`.
 *
 * Each case builds its own `$HOME` under a scratch root and runs the script in
 * a child process with `HOME` overridden, so the real `~/.dsh` is never touched.
 * Old files are simulated with `utimes` instead of waiting.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/cleanup.mjs', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

/** Scratch root shared by the tests; each test makes its own HOME below it. */
let root = '';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-subagent-pi-cleanup-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fresh fake HOME. */
async function makeHome(name) {
  return mkdtemp(join(root, `${name}-`));
}

/** Write one pi log with a chosen age (in days). */
async function makeLog(home, name, ageDays, size = 128) {
  const dir = join(home, '.dsh', 'pi-logs');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, 'x'.repeat(size), 'utf8');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(path, when, when);
  return path;
}

/** Run the script with `HOME` pointed at the fake home. */
function run(args, home) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

test('cleanup --dry-run：只列不删，按 --days 筛选', async () => {
  const home = await makeHome('dry');
  const oldPath = await makeLog(home, 'old.log', 30, 4096);
  const freshPath = await makeLog(home, 'fresh.log', 0, 16);

  const result = run(['--days', '14', '--dry-run'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /old\.log/);
  assert.match(result.stdout, /would delete 1 file/);
  assert.match(result.stdout, /dry run/i);
  assert.doesNotMatch(result.stdout, /fresh\.log/);
  assert.equal(existsSync(oldPath), true, '--dry-run must not delete');
  assert.equal(existsSync(freshPath), true);
});

test('cleanup：删除过期日志、保留新日志并报出数量', async () => {
  const home = await makeHome('delete');
  const oldPath = await makeLog(home, 'old.log', 30, 2048);
  const newPath = await makeLog(home, 'new.log', 0, 16);

  const result = run(['--days', '14'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deleted 1 file/);
  assert.equal(existsSync(oldPath), false);
  assert.equal(existsSync(newPath), true);
});

test('cleanup --days：0 天把所有文件都算作候选', async () => {
  const home = await makeHome('days');
  await makeLog(home, 'a.log', 30);
  await makeLog(home, 'b.log', 5);

  const older = run(['--days', '10', '--dry-run'], home);
  assert.match(older.stdout, /would delete 1 file/);
  assert.match(older.stdout, /a\.log/);

  const everything = run(['--days', '0', '--dry-run'], home);
  assert.match(everything.stdout, /would delete 2 file/);
});

test('cleanup --sessions：列出旧会话候选，只列不删并给出注意事项', async () => {
  const home = await makeHome('sessions');
  const sessionDir = join(home, '.dsh', 'sessions', '--ws--', 'session-abc');
  await mkdir(sessionDir, { recursive: true });
  const logFile = join(sessionDir, 'session.v4.jsonl.zstd');
  await writeFile(logFile, 'zstd-bytes', 'utf8');
  const when = new Date(Date.now() - 30 * DAY_MS);
  await utimes(logFile, when, when);

  const result = run(['--days', '14', '--sessions'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /session-abc/);
  assert.match(result.stdout, /not deleted/);
  assert.match(result.stdout, /out-of-band/);
  assert.match(result.stdout, /stop DSH first/);
  assert.match(result.stdout, /sqlite/);
  assert.equal(existsSync(logFile), true, '--sessions must never delete');
  assert.equal(existsSync(sessionDir), true);
});

test('cleanup --sessions：新会话不算候选', async () => {
  const home = await makeHome('sessions-fresh');
  const sessionDir = join(home, '.dsh', 'sessions', '--ws--', 'session-new');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'zstd-bytes', 'utf8');

  const result = run(['--days', '14', '--sessions'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing older than 14 day\(s\)/);
  assert.doesNotMatch(result.stdout, /session-new/);
});

test('cleanup：缺少目录时正常退出，参数错误时报错', async () => {
  const home = await makeHome('missing');
  const result = run([], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not found/);

  const bad = run(['--days', 'soon'], home);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--days needs a non-negative integer/);

  const unknown = run(['--nope'], home);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown argument/);
});
