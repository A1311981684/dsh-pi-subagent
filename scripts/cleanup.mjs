#!/usr/bin/env node
/**
 * Remove old Pi delegation logs, and (optionally) list old session candidates.
 *
 * The plugin writes one log per delegation into `$HOME/.dsh/pi-logs`; nothing
 * removes them, so the directory only grows. This script deletes the files whose
 * mtime is older than `--days` (default 14), and prints how many and how much
 * space was freed. `--dry-run` only lists.
 *
 * `--sessions` additionally lists session directories under
 * `$HOME/.dsh/sessions` older than the same cutoff. Deleting DSH sessions is an
 * out-of-band operation, so it never happens here: the script only prints the
 * candidates and the caveats (stop DSH first; the sqlite index keeps stale rows).
 *
 * Zero runtime dependencies: `node:` built-ins only.
 *
 * Usage:
 *   node scripts/cleanup.mjs [--days 14] [--dry-run] [--sessions]
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Session logs live in this layout below the sessions root. */
const SESSION_LOG = 'session.v4.jsonl.zstd';

/** How deep the session listing walks (workspace dir → session dir → file). */
const SESSION_WALK_DEPTH = 4;

const USAGE = `Usage: node scripts/cleanup.mjs [options]

  --days <n>   Only consider files older than n days (default 14)
  --dry-run    List what would be deleted; change nothing
  --sessions   Also list old session candidates (never deleted)
  -h, --help   Show this text`;

/** Print the usage text and exit 0. */
function help() {
  console.log(USAGE);
}

/** Print a failure and exit 1. */
function fail(message) {
  console.error(`cleanup: ${message}`);
  process.exitCode = 1;
}

/** Parse the command line. Throws on an unknown or malformed option. */
function parseArgs(argv) {
  const options = { days: 14, dryRun: false, sessions: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--sessions') {
      options.sessions = true;
      continue;
    }
    if (arg === '--days' || arg.startsWith('--days=')) {
      const raw = arg === '--days' ? argv[(index += 1)] : arg.slice('--days='.length);
      if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`--days needs a non-negative integer, got: ${raw ?? ''}`);
      options.days = Number.parseInt(raw, 10);
      continue;
    }
    throw new Error(`unknown argument: ${arg} (see --help)`);
  }
  return options;
}

/** Human-readable byte size, one decimal place. */
function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Resolve `$HOME` the same way the plugin does. */
function homeDir() {
  return typeof process.env.HOME === 'string' && process.env.HOME !== '' ? process.env.HOME : homedir();
}

/** Stat a path, returning undefined when it does not exist. */
async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/**
 * Delete (or list) the old regular files directly inside `dir`.
 * @returns `{ count, bytes }` for the files considered.
 */
async function cleanLogs(dir, options) {
  const info = await statOrUndefined(dir);
  if (info === undefined || !info.isDirectory()) {
    console.log(`pi-logs: ${dir} not found; nothing to do`);
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    fail(`could not read ${dir}: ${error.message}`);
    return;
  }
  const cutoff = Date.now() - options.days * DAY_MS;
  const old = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    const fileInfo = await statOrUndefined(path);
    if (fileInfo === undefined || !fileInfo.isFile()) continue;
    if (fileInfo.mtimeMs >= cutoff) continue;
    old.push({ path, size: fileInfo.size });
  }
  const bytes = old.reduce((sum, file) => sum + file.size, 0);
  if (old.length === 0) {
    console.log(`pi-logs: nothing older than ${options.days} day(s) in ${dir}`);
    return;
  }
  for (const file of old) console.log(`  ${file.path}  ${sizeText(file.size)}`);
  if (options.dryRun) {
    console.log(`pi-logs: would delete ${old.length} file(s) (${sizeText(bytes)}) [dry run]`);
    return;
  }
  let removed = 0;
  let freed = 0;
  for (const file of old) {
    try {
      await rm(file.path, { force: true });
      removed += 1;
      freed += file.size;
    } catch (error) {
      fail(`could not delete ${file.path}: ${error.message}`);
    }
  }
  console.log(`pi-logs: deleted ${removed} file(s) (${sizeText(freed)} freed)`);
}

/** Collect directories that hold a session log and look like a session. */
async function walkSessions(dir, depth, found) {
  if (depth > SESSION_WALK_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const logInfo = entries.some((entry) => entry.name === SESSION_LOG && entry.isFile());
  if (logInfo) {
    const info = await statOrUndefined(join(dir, SESSION_LOG));
    if (info !== undefined && info.isFile()) found.push({ path: dir, size: info.size, mtimeMs: info.mtimeMs });
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await walkSessions(join(dir, entry.name), depth + 1, found);
  }
}

/**
 * List old session directories. This is deliberately list-only: removing them
 * behind DSH's back needs the process stopped and can leave stale sqlite rows.
 */
async function listSessions(dir, options) {
  const info = await statOrUndefined(dir);
  if (info === undefined || !info.isDirectory()) {
    console.log(`sessions: ${dir} not found; nothing to list`);
    return;
  }
  const found = [];
  try {
    await walkSessions(dir, 1, found);
  } catch (error) {
    fail(`could not walk ${dir}: ${error.message}`);
    return;
  }
  const cutoff = Date.now() - options.days * DAY_MS;
  const old = found.filter((session) => session.mtimeMs < cutoff);
  if (old.length === 0) {
    console.log(`sessions: nothing older than ${options.days} day(s) in ${dir}`);
    return;
  }
  console.log(`sessions: ${old.length} candidate(s) older than ${options.days} day(s) (not deleted)`);
  for (const session of old) console.log(`  ${session.path}  ${sizeText(session.size)}`);
  console.log('note: deleting sessions is an out-of-band operation; stop DSH first, and the sqlite index may keep stale rows.');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
    return;
  }
  if (options.help) {
    help();
    return;
  }
  const home = homeDir();
  await cleanLogs(join(home, '.dsh', 'pi-logs'), options);
  if (options.sessions) await listSessions(join(home, '.dsh', 'sessions'), options);
}

await main();
