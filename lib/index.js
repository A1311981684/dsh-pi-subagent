/**
 * Pi (`pi-dev`) as an out-of-process DSH subagent backend.
 *
 * Thin shell by design: one `pi-dev` child per run, nothing else. `pi-dev`
 * already owns the parts that matter — a throwaway `PI_CODING_AGENT_DIR`, the
 * DeepSeek credential handoff, the fixed rules prepended to the brief, the
 * pinned `deepseek-flash` model, `--no-session`, the tee'd full log, and the
 * delegation record under `~/.dsh/pi-delegations.log`. This plugin only does
 * what the subagent seam demands of an external backend: validate the request,
 * write the brief, spawn, map the child's exit facts to a `SubagentResult`, and
 * own teardown down to process exit.
 *
 * No `@deepseek-ai/*` import on purpose: a plugin is loaded from the profile's
 * node_modules, where pnpm's strict layout does not expose those packages. The
 * three helpers this backend needs (`assertUsableCwd`,
 * `settleRunResult`, `subprocessRunHandle`) are reimplemented here over the
 * `node:` built-ins alone.
 *
 * @module dsh-subagent-pi
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Registry name of this backend. */
export const name = 'subagent-pi';

/**
 * `subagents` to register the provider; `subprocess` to own the child's
 * process range (this plugin never starts a process by itself).
 */
export const inject = ['subagents', 'subprocess'];

/** Diagnostic prefix, also used for the per-run scratch directory. */
const PREFIX = 'subagent-pi';

/**
 * The wrapper that carries every delegation rule; overridable through config.
 * Built from the current user's home directory so the default works on any
 * machine instead of naming one absolute path.
 */
const DEFAULT_COMMAND = join(homedir(), '.dsh', 'bin', 'pi-dev');

/** Default log directory, relative to `$HOME`. */
const DEFAULT_LOG_SUBDIR = join('.dsh', 'pi-logs');

/** Default SIGTERM → SIGKILL grace handed to the subprocess seam. */
const DEFAULT_GRACE_MS = 5_000;

/** Default in-memory cap for one collected stream (stdout or stderr). */
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

/** The seam's byte cap for provider-authored diagnostics. */
const MAX_DIAGNOSTIC_BYTES = 4_096;

/** Normalize an unknown thrown value to a message. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Log a run-level failure without letting the sink break the run. */
function warn(ctx, message, error) {
  try {
    ctx?.logger?.warn?.(`${PREFIX}: ${message}: ${errorMessage(error)}`);
  } catch {
    /* a broken logger must never fail a subagent run */
  }
}

/**
 * Keep the last `maxBytes` bytes of `text` without splitting a UTF-8
 * sequence, so the result is still valid text and fits the budget.
 * @param text - the source text.
 * @param maxBytes - the byte budget; non-positive means "nothing fits".
 * @returns the tail, at most `maxBytes` bytes.
 */
function utf8Tail(text, maxBytes) {
  if (typeof text !== 'string' || text === '' || !Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - Math.floor(maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/**
 * Build a diagnostic that keeps `head` intact and spends the remaining
 * 4096-byte budget on the tail of `detail` (the child's stderr).
 * @param head - the fixed failure line (exit code, or the internal error).
 * @param detail - provider-owned detail; only its tail survives.
 * @returns the diagnostic, at most {@link MAX_DIAGNOSTIC_BYTES} bytes.
 */
function diagnosticText(head, detail) {
  const headBytes = Buffer.byteLength(head, 'utf8');
  if (headBytes >= MAX_DIAGNOSTIC_BYTES) return utf8Tail(head, MAX_DIAGNOSTIC_BYTES);
  const tail = utf8Tail(detail ?? '', MAX_DIAGNOSTIC_BYTES - headBytes - 1);
  return tail === '' ? head : `${head}\n${tail}`;
}

/**
 * `YYYYMMDD-HHmmss` in local time, the log-name stamp.
 * @param now - the clock reading.
 * @returns the stamp.
 */
function logStamp(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

/**
 * Read one collected stream from its start. Collected output stays readable
 * after exit, so this is also the settlement-time snapshot.
 * @param handle - the child handle.
 * @param stream - which collected stream to read.
 * @returns the retained text, or `''` when the stream was not collected.
 */
function readCollected(handle, stream) {
  try {
    const reader = handle?.collected?.[stream];
    if (reader === undefined || reader === null) return '';
    const read = reader.readFrom(0);
    return typeof read?.text === 'string' ? read.text : '';
  } catch {
    /* an unreadable stream must not decide the result */
    return '';
  }
}

/**
 * Turn the harness prompt into the brief text `pi-dev --brief` expects: the
 * text blocks in order, separated by a blank line. `pi-dev` takes one text
 * brief, so a non-text block (an image, say) is a hard, explicit error rather
 * than a silent drop.
 * @param prompt - the request's ContentBlock array.
 * @returns the brief text.
 */
function briefFromPrompt(prompt) {
  if (!Array.isArray(prompt)) throw new TypeError(`${PREFIX}: prompt must be an array of ContentBlock`);
  const parts = [];
  for (const block of prompt) {
    if (block === null || typeof block !== 'object') {
      throw new TypeError(`${PREFIX}: prompt contains a non-object block`);
    }
    if (block.type !== 'text') {
      throw new Error(
        `${PREFIX}: prompt block type "${String(block.type ?? 'unknown')}" is not supported; `
          + 'the pi-dev backend delivers one text brief only',
      );
    }
    if (typeof block.text !== 'string') {
      throw new TypeError(`${PREFIX}: text prompt block without a string \`text\``);
    }
    parts.push(block.text);
  }
  const brief = parts.join('\n\n');
  if (brief.trim() === '') throw new Error(`${PREFIX}: prompt has no text, pi-dev needs a non-empty brief`);
  return brief;
}

/**
 * Assert `cwd` can host the child: absolute (it doubles as the workspace
 * identity) and an existing directory (fail here with a clear message instead
 * of as an ambiguous spawn error).
 * @param cwd - the request's working directory.
 * @returns `cwd`, validated.
 */
async function assertUsableCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error(`${PREFIX}: child cwd is required`);
  if (!isAbsolute(cwd)) throw new Error(`${PREFIX}: child cwd must be absolute, got "${cwd}"`);
  let info;
  try {
    info = await stat(cwd);
  } catch (error) {
    throw new Error(`${PREFIX}: child cwd is not accessible: "${cwd}" (${errorMessage(error)})`);
  }
  if (!info.isDirectory()) throw new Error(`${PREFIX}: child cwd is not a directory: "${cwd}"`);
  return cwd;
}

/**
 * Build the child argv. `--brief`, `--cwd`, and `--log` are always present;
 * the optional switches follow in a fixed order, and `config.args` goes last so
 * a profile can append anything `pi-dev` grows later.
 * @param config - the resolved plugin config.
 * @param briefPath - where the brief was written.
 * @param cwd - the child's working directory.
 * @param logPath - where `pi-dev` tees the full output.
 * @returns the argv handed to the subprocess seam.
 */
function childArgv(config, briefPath, cwd, logPath) {
  const argv = [config.command, '--brief', briefPath, '--cwd', cwd, '--log', logPath];
  if (config.model !== undefined) argv.push('--model', config.model);
  if (config.thinking !== undefined) argv.push('--thinking', config.thinking);
  if (config.tools !== undefined) argv.push('--tools', config.tools);
  if (config.approve) argv.push('--approve');
  argv.push(...config.args);
  return argv;
}

/**
 * An out-of-process Pi backend: one `pi-dev` child per run, no shared Cordis
 * context, and no start-time capabilities. Per-run state lives in `start`'s
 * closure, so concurrent runs cannot observe each other.
 */
class PiProvider {
  /**
   * @param ctx - the plugin context (uses `subprocess` and `logger`).
   * @param config - the resolved, validated config.
   */
  constructor(ctx, config) {
    this.name = config.providerName;
    this.ctx = ctx;
    this.config = config;
    this.capabilities = Object.freeze({
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    });
    this.inheritsParentContext = false;
  }

  /**
   * Start one `pi-dev` run.
   *
   * Setup failures (bad cwd, unusable prompt, spawn failure) reject after the
   * scratch directory is cleaned up; from the returned handle onward nothing
   * rejects — the child's exit facts settle through `result`.
   *
   * @param request - the resolved start request.
   * @returns the run handle owned by the caller.
   */
  async start(request) {
    const signal = request?.signal;
    if (signal?.aborted === true) {
      throw new Error(`${PREFIX}: subagent request was aborted before the pi-dev child started`);
    }

    const cwd = await assertUsableCwd(request?.cwd);
    const brief = briefFromPrompt(request?.prompt);

    const id = randomUUID();
    const config = this.config;
    const scratch = await mkdtemp(join(tmpdir(), `${PREFIX}-`));
    const briefPath = join(scratch, 'brief.md');
    const logPath = join(config.logDir, `${logStamp(new Date())}-${id.slice(0, 8)}.log`);

    let handle;
    try {
      await writeFile(briefPath, brief, 'utf8');
      await mkdir(config.logDir, { recursive: true });
      handle = this.ctx.subprocess.spawn({
        argv: childArgv(config, briefPath, cwd, logPath),
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: config.maxOutputBytes },
          stderr: { maxBytes: config.maxOutputBytes },
        },
        graceMs: config.graceMs,
        signal,
      });
    } catch (error) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
      throw new Error(`${PREFIX}: could not start the pi-dev child: ${errorMessage(error)}`, { cause: error });
    }

    /** Per-run mutable state; never shared with a sibling run. */
    const flags = { cancelled: false };
    let settleCancel;
    const cancelObserved = new Promise((resolve) => {
      settleCancel = resolve;
    });
    /** The child's exit facts, flattened so a rejection cannot go unhandled. */
    const observed = handle.done.then(
      (outcome) => ({ kind: 'exit', outcome }),
      (error) => ({ kind: 'failed', error }),
    );

    /** Settle local cancellation, then start the terminate escalation. */
    const cancel = () => {
      if (flags.cancelled) return;
      flags.cancelled = true;
      settleCancel();
      try {
        handle.terminate();
      } catch (error) {
        warn(this.ctx, 'terminate failed', error);
      }
    };
    const onAbort = () => {
      cancel();
    };
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

    /** The seam's output shape, with the log pointer appended last. */
    const outputFor = (stdout) => [
      { type: 'text', text: stdout },
      { type: 'text', text: `[full pi-dev output] ${logPath}` },
    ];

    /**
     * Map the child's exit facts to a `SubagentResult`. Never throws: an
     * internal exception becomes `stopReason: 'error'` with a capped diagnostic.
     * @returns the terminal result.
     */
    const settle = async () => {
      let stdout = '';
      try {
        const winner = await Promise.race([
          observed,
          cancelObserved.then(() => ({ kind: 'cancelled' })),
        ]);
        stdout = readCollected(handle, 'stdout');
        const stderr = readCollected(handle, 'stderr');
        if (winner.kind === 'cancelled') return { output: outputFor(stdout), stopReason: 'aborted' };
        if (winner.kind === 'failed') throw winner.error;
        if (flags.cancelled || signal?.aborted === true) {
          return { output: outputFor(stdout), stopReason: 'aborted' };
        }
        const outcome = winner.outcome ?? {};
        const exitCode = typeof outcome.exitCode === 'number' ? outcome.exitCode : null;
        if (exitCode === 0) return { output: outputFor(stdout), stopReason: 'completed' };
        const termSignal = typeof outcome.signal === 'string' ? outcome.signal : undefined;
        const head = exitCode === null
          ? `pi-dev exit code null${termSignal === undefined ? '' : ` (${termSignal})`}`
          : `pi-dev exit code ${exitCode}`;
        return { output: outputFor(stdout), diagnostic: diagnosticText(head, stderr), stopReason: 'error' };
      } catch (error) {
        stdout = stdout === '' ? readCollected(handle, 'stdout') : stdout;
        if (flags.cancelled || signal?.aborted === true) {
          return { output: outputFor(stdout), stopReason: 'aborted' };
        }
        warn(this.ctx, 'pi-dev run failed', error);
        return {
          output: outputFor(stdout),
          diagnostic: diagnosticText(
            `pi-dev run failed: ${errorMessage(error)}`,
            readCollected(handle, 'stderr'),
          ),
          stopReason: 'error',
        };
      }
    };

    const result = settle();
    /* The seam forbids a rejecting `result`; this guards a throw outside `settle`. */
    result.catch(() => {});

    let disposal;
    /** Idempotent: cancel, wait for the managed range, then drop the scratch dir. */
    const teardown = async () => {
      cancel();
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      const failures = [];
      try {
        await handle.waitForExit();
      } catch (error) {
        failures.push(error);
      }
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, `${PREFIX}: pi-dev child teardown failed`);
    };

    return {
      id,
      result,
      dispose: () => (disposal ??= teardown()),
    };
  }
}

/**
 * Validate one optional string config value.
 * @param field - the config field name, for the diagnostic.
 * @param value - the raw value; `undefined`, `null`, and `''` mean "absent".
 * @returns the value, or `undefined` when absent.
 */
function optionalText(field, value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`${PREFIX}: ${field} must be a string`);
  return value;
}

/**
 * Validate one required string config value.
 * @param field - the config field name, for the diagnostic.
 * @param value - the raw value; `undefined` and `null` select the fallback.
 * @param fallback - the default.
 * @returns the configured value or the fallback.
 */
function requiredText(field, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${PREFIX}: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate one numeric config value: it bounds a teardown or drain wait, so
 * zero, negative, or non-finite would skip or wedge it.
 * @param field - the config field name, for the diagnostic.
 * @param value - the raw value; `undefined` and `null` select the fallback.
 * @param fallback - the default.
 * @returns the configured value or the fallback.
 */
function positiveNumber(field, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${PREFIX}: ${field} must be a positive finite number`);
  }
  return value;
}

/**
 * Apply defaults and validate the plugin config. Throws at mount time, so a
 * bad value is a load error rather than a surprise on the first run.
 * @param config - the raw config object from the profile.
 * @returns the resolved config.
 */
function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};

  let args = [];
  if (raw.args !== undefined && raw.args !== null) {
    if (!Array.isArray(raw.args)) throw new TypeError(`${PREFIX}: args must be an array of strings`);
    args = raw.args.map((arg, index) => {
      if (typeof arg !== 'string') throw new TypeError(`${PREFIX}: args[${index}] must be a string`);
      return arg;
    });
  }

  const approve = raw.approve === undefined || raw.approve === null ? false : raw.approve;
  if (typeof approve !== 'boolean') throw new TypeError(`${PREFIX}: approve must be a boolean`);

  const home = typeof process.env.HOME === 'string' && process.env.HOME !== '' ? process.env.HOME : homedir();

  return {
    providerName: requiredText('providerName', raw.providerName, 'pi'),
    command: requiredText('command', raw.command, DEFAULT_COMMAND),
    args,
    model: optionalText('model', raw.model),
    thinking: optionalText('thinking', raw.thinking),
    tools: optionalText('tools', raw.tools),
    approve,
    logDir: requiredText('logDir', raw.logDir, join(home, DEFAULT_LOG_SUBDIR)),
    graceMs: positiveNumber('graceMs', raw.graceMs, DEFAULT_GRACE_MS),
    maxOutputBytes: positiveNumber('maxOutputBytes', raw.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
  };
}

/**
 * Register the Pi backend with the subagent service.
 * @param ctx - the plugin context; `subagents` and `subprocess` are injected.
 * @param config - the profile config (see README for the table).
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  ctx.subagents.registerProvider(new PiProvider(ctx, resolved));
}
