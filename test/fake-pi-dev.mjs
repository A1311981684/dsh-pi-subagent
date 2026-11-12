#!/usr/bin/env node
/**
 * A stand-in for `pi-dev` used by the unit tests.
 *
 * The plugin probes the wrapper with `--help` before every projected run and
 * only asks for `--mode json` when the help text mentions it. This fixture
 * decides that from its own file name: a copy whose name contains `old` (or
 * `no-mode`) prints a usage line without `--mode`, everything else advertises
 * it. No brief is read on the help path.
 *
 * The plugin writes the delegation brief to a scratch file and passes it as
 * `--brief`; this script reads the brief for its test directives:
 *
 * - `FIXTURE <path>` — JSON with `stdout`, `stdoutEarly`, `stderr`, `exitCode`,
 *   `delayMs`, and `ignoreTerm` knobs;
 * - `RECORD <path>` — where to write `{ argv, cwd, brief }`, so a test can see
 *   exactly how the plugin invoked the wrapper.
 *
 * `stdoutEarly` is written *before* the delay, so a cancellation test can leave
 * the projection mid-step (an advertised tool call with no result yet).
 *
 * `ignoreTerm` installs a no-op SIGTERM handler *before* the record file is
 * written, so a test that waits for the record knows the child will survive the
 * first signal and can only be stopped by the SIGKILL escalation.
 *
 * This is a test fixture, not a package entry point.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  const supportsMode = !/old|no-mode/.test(basename(import.meta.filename));
  process.stdout.write(supportsMode
    ? 'Usage: pi-dev --brief <file|-> [--mode text|json] [--log <file>]\n'
    : 'Usage: pi-dev --brief <file|-> [--log <file>]\n');
  process.exit(0);
}

const flagValue = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const briefPath = flagValue('--brief');
const brief = briefPath === undefined ? '' : readFileSync(briefPath, 'utf8');
const directive = (name) => brief
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line.startsWith(`${name} `));
const trimmed = (name) => {
  const line = directive(name);
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
};
const fixturePath = trimmed('FIXTURE');
const recordPath = trimmed('RECORD');
const fixture = fixturePath === undefined || fixturePath === ''
  ? {}
  : JSON.parse(readFileSync(fixturePath, 'utf8'));

if (fixture.ignoreTerm === true) process.on('SIGTERM', () => {});

if (recordPath !== undefined && recordPath !== '') {
  writeFileSync(recordPath, JSON.stringify({ argv: args, cwd: process.cwd(), brief }));
}

if (typeof fixture.stdoutEarly === 'string') process.stdout.write(fixture.stdoutEarly);

const finish = () => {
  if (typeof fixture.stdout === 'string') process.stdout.write(fixture.stdout);
  if (typeof fixture.stderr === 'string') process.stderr.write(fixture.stderr);
  process.exitCode = typeof fixture.exitCode === 'number' ? fixture.exitCode : 0;
};

const delayMs = typeof fixture.delayMs === 'number' ? fixture.delayMs : 0;
if (delayMs > 0) setTimeout(finish, delayMs);
else finish();
