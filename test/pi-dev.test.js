/**
 * Unit tests for the bundled `bin/pi-dev` wrapper's session arguments.
 *
 * The wrapper is executed with `bash`, and `PI_BIN` points at a tiny fake that
 * records the argv Pi would have seen. `DEEPSEEK_API_KEY` is set to a dummy
 * value so the wrapper never reads Pi's real credential file, and `HOME` is a
 * scratch directory so the delegation record lands there.
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const WRAPPER = fileURLToPath(new URL('../bin/pi-dev', import.meta.url));

let root = '';
let fakePi = '';
let brief = '';
let sessionsDir = '';
let sequence = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-subagent-wrapper-'));
  fakePi = join(root, 'fake-pi');
  // Record exactly what the wrapper passes to Pi, then print a fake answer.
  await writeFile(
    fakePi,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$PI_ARGS_FILE"\nprintf \'ok\\n\'\n',
    'utf8',
  );
  await chmod(fakePi, 0o755);
  brief = join(root, 'brief.md');
  await writeFile(brief, '写一行文字\n', 'utf8');
  sessionsDir = join(root, 'pi-sessions');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Run the wrapper with the given extra arguments and return the Pi argv. */
async function runWrapper(extra = []) {
  sequence += 1;
  const argsFile = join(root, `pi-args-${sequence}.txt`);
  const result = spawnSync('bash', [WRAPPER, '--brief', brief, '--cwd', root, ...extra], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      PI_BIN: fakePi,
      PI_ARGS_FILE: argsFile,
      PI_DEV_RECORD_DIR: join(root, 'records'),
      DEEPSEEK_API_KEY: 'test-key-not-real',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(argsFile, 'utf8')).trimEnd().split('\n');
  return { args, result };
}

test('pi-dev --session-id：转发 session id 与目录，且不再加 --no-session', async () => {
  const { args, result } = await runWrapper(['--session-id', 'session-abc', '--session-dir', sessionsDir]);

  assert.equal(result.stdout.trim(), 'ok');
  assert.ok(args.includes('--print'));
  assert.equal(args[args.indexOf('--session-id') + 1], 'session-abc');
  assert.equal(args[args.indexOf('--session-dir') + 1], sessionsDir);
  assert.equal(args.includes('--no-session'), false, '--session-id and --no-session are exclusive');
});

test('pi-dev 不传 --session-id：保持原来的 --no-session 行为', async () => {
  const { args } = await runWrapper();
  assert.ok(args.includes('--no-session'));
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args.includes('--session-dir'), false);
});

test('pi-dev --session-id 未给 --session-dir：默认 $HOME/.dsh/pi-sessions', async () => {
  const { args } = await runWrapper(['--session-id', 'session-def']);
  assert.equal(args[args.indexOf('--session-dir') + 1], join(root, '.dsh', 'pi-sessions'));
  assert.equal(args.includes('--no-session'), false);
});

test('pi-dev --session-dir 缺 --session-id：明确报错', async () => {
  const result = spawnSync('bash', [WRAPPER, '--brief', brief, '--cwd', root, '--session-dir', sessionsDir], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, PI_BIN: fakePi, DEEPSEEK_API_KEY: 'test-key-not-real' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--session-dir requires --session-id/);
});
