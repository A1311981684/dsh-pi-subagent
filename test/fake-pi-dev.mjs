#!/usr/bin/env node
/**
 * A stand-in for `pi-dev` used by the unit tests.
 *
 * The plugin writes the delegation brief to a scratch file and passes it as
 * `--brief`; this script reads the brief for its two test directives:
 *
 * - `FIXTURE <path>` — JSON with `stdout`, `stderr`, `exitCode`, `delayMs`, and
 *   `ignoreTerm` knobs;
 * - `RECORD <path>` — where to write `{ argv, cwd, brief }`, so a test can see
 *   exactly how the plugin invoked the wrapper.
 *
 * `ignoreTerm` installs a no-op SIGTERM handler *before* the record file is
 * written, so a test that waits for the record knows the child will survive the
 * first signal and can only be stopped by the SIGKILL escalation.
 *
 * `rejectMode` emulates an older wrapper that does not know `--mode`: it exits
 * 2 with an argument-parsing complaint instead of running anything.
 *
 * This is a test fixture, not a package entry point.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
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

if (fixture.rejectMode === true && args.includes('--mode')) {
  process.stderr.write('pi-dev: unknown argument: --mode (see --help)\n');
  process.exitCode = 2;
} else if (fixture.ignoreTerm === true) process.on('SIGTERM', () => {});

if (process.exitCode === undefined && recordPath !== undefined && recordPath !== '') {
  writeFileSync(recordPath, JSON.stringify({ argv: args, cwd: process.cwd(), brief }));
}

const finish = () => {
  if (typeof fixture.stdout === 'string') process.stdout.write(fixture.stdout);
  if (typeof fixture.stderr === 'string') process.stderr.write(fixture.stderr);
  process.exitCode = typeof fixture.exitCode === 'number' ? fixture.exitCode : 0;
};

const delayMs = typeof fixture.delayMs === 'number' ? fixture.delayMs : 0;
if (process.exitCode !== undefined) {
  /* the mode rejection already settled the run */
} else if (delayMs > 0) setTimeout(finish, delayMs);
else finish();
