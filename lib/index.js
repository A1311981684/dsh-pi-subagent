/**
 * Pi (`pi-dev`) as a DSH subagent backend, with session projection.
 *
 * One `pi-dev` child per delegation, owned here: the plugin registers its own
 * `pi` tool (it no longer goes through `@deepseek-ai/dsh-tool-subagent`), so
 * the same call can do two things that used to be impossible together:
 *
 * 1. run the delegation — write the brief, spawn `pi-dev --mode json`, collect
 *    the child's structured events, and return Pi's final answer;
 * 2. project the run into a real DSH child session — `sessions.prepare` +
 *    `sessionPersistence.create` + `enter`/`announce`, then append the
 *    `subagent/descriptor` (v3), turn/user/assistant/turn-end events, and the
 *    parent's `subagent/catalog` (v0) row. The child then shows up in DSH's
 *    subagent list and opens as read-only history: the user prompt, Pi's
 *    assistant replies with token usage, and the run's end state.
 *
 * Projection is strictly a bonus. Every step is guarded: a missing service, a
 * rejected append, or unparseable child output degrades the projection (or the
 * whole child session) with a `ctx.logger.warn`, while the delegation result is
 * returned unchanged. `pi-dev` itself stays the owner of the run environment:
 * throwaway `PI_CODING_AGENT_DIR`, credential handoff, fixed rules, model pin,
 * `--no-session`, the tee'd log, and the delegation record.
 *
 * No `@deepseek-ai/*` import and no runtime dependency: only `node:` built-ins.
 * `@deepseek-ai/cordis` injects `tools`, `sessions`, and `sessionPersistence`;
 * the event/message payloads below are plain JSON objects matching the
 * 0.2.2-rc.1 type declarations (an event log is JSON by contract).
 *
 * @module dsh-subagent-pi
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Registry name of this plugin. */
export const name = 'subagent-pi';

/**
 * `tools` to register the `pi` tool; `sessions` + `sessionPersistence` to
 * project each run into a durable, inspectable child session.
 */
export const inject = ['tools', 'sessions', 'sessionPersistence'];

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

/** Default SIGTERM → SIGKILL grace for a cancelled child. */
const DEFAULT_GRACE_MS = 5_000;

/** Default in-memory cap for one collected stream (stdout or stderr). */
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

/** The model-facing cap for provider-authored diagnostics. */
const MAX_DIAGNOSTIC_BYTES = 4_096;

/** Longest default label taken from the prompt's first line. */
const LABEL_MAX_CHARS = 60;

/** The provider name stamped into the child descriptor. */
const PROVIDER = 'pi';

/** `SUBAGENT_DESCRIPTOR_VERSION` from `@deepseek-ai/dsh-subagent/descriptor`. */
const DESCRIPTOR_VERSION = 3;

/** `SUBAGENT_CATALOG_VERSION` from `@deepseek-ai/dsh-subagent/catalog`. */
const CATALOG_VERSION = 0;

/** Normalize an unknown thrown value to a message. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Log a projection/run failure without letting the sink break the run. */
function warn(ctx, message, error) {
  try {
    ctx?.logger?.warn?.(`${PREFIX}: ${message}: ${errorMessage(error)}`);
  } catch {
    /* a broken logger must never fail a delegation */
  }
}

/** Whether a value is a plain JSON object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * @param detail - child-owned detail; only its tail survives.
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
 * A fixed-size byte collector: appends every chunk and keeps the tail, so a
 * chatty child cannot grow the plugin's memory without bound and the most
 * relevant diagnostics (usually the end of stderr) survive.
 */
class TailBuffer {
  /** @type {number} */
  #maxBytes;
  /** @type {Buffer} */
  #buffer = Buffer.alloc(0);

  /**
   * @param maxBytes - positive byte budget.
   */
  constructor(maxBytes) {
    this.#maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  /**
   * @param chunk - the next stream chunk.
   */
  push(chunk) {
    if (chunk === undefined || chunk === null || chunk.length === 0) return;
    const merged = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    this.#buffer = merged.length > this.#maxBytes
      ? merged.subarray(merged.length - this.#maxBytes)
      : merged;
  }

  /** @returns the retained text, decoded from a character boundary. */
  text() {
    const buffer = this.#buffer;
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start).toString('utf8');
  }
}

/**
 * Build the child argv. `--brief`, `--cwd`, and `--log` are always present;
 * `--mode json` is added while projection is on; the optional switches follow
 * in a fixed order, and `config.args` goes last so a profile can append
 * anything `pi-dev` grows later.
 * @param config - the resolved plugin config.
 * @param briefPath - where the brief was written.
 * @param cwd - the child's working directory.
 * @param logPath - where `pi-dev` tees the full output.
 * @param json - request Pi's JSON event stream (defaults to the projection
 *   setting); `false` omits `--mode` entirely.
 * @returns the argv handed to the child.
 */
function childArgv(config, briefPath, cwd, logPath, json = config.projection) {
  const argv = [config.command, '--brief', briefPath, '--cwd', cwd, '--log', logPath];
  if (json) argv.push('--mode', 'json');
  if (config.model !== undefined) argv.push('--model', config.model);
  if (config.thinking !== undefined) argv.push('--thinking', config.thinking);
  if (config.tools !== undefined) argv.push('--tools', config.tools);
  if (config.approve) argv.push('--approve');
  argv.push(...config.args);
  return argv;
}

/**
 * Spawn `pi-dev`, collect its streams, and settle the run facts.
 *
 * Cancellation sends SIGTERM and escalates to SIGKILL after `graceMs`, so the
 * tool call can always reach quiescence. Never rejects: a spawn failure is
 * reported through `error` on the returned facts.
 *
 * @param ctx - the plugin context (diagnostics only).
 * @param config - the resolved plugin config.
 * @param spec - argv, child cwd, and the caller's cancellation signal.
 * @returns the child's exit facts and collected output.
 */
function runPiChild(ctx, config, spec) {
  const { argv, cwd, signal } = spec;
  return new Promise((resolve) => {
    const stdout = new TailBuffer(config.maxOutputBytes);
    const stderr = new TailBuffer(config.maxOutputBytes);
    let settled = false;
    let killTimer;

    const settle = (facts) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (signal !== undefined) signal.removeEventListener('abort', terminate);
      resolve({ ...facts, stdout: stdout.text(), stderr: stderr.text(), aborted: signal?.aborted === true });
    };

    /** SIGTERM now, SIGKILL after the grace window. */
    const terminate = () => {
      if (settled) return;
      try {
        child.kill('SIGTERM');
      } catch (error) {
        warn(ctx, 'could not signal the pi-dev child', error);
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, config.graceMs);
      killTimer.unref?.();
    };

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      resolve({ exitCode: null, termSignal: null, error, stdout: '', stderr: '', aborted: signal?.aborted === true });
      return;
    }

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => settle({ exitCode: null, termSignal: null, error }));
    child.once('close', (exitCode, termSignal) => settle({ exitCode, termSignal, error: undefined }));

    if (signal !== undefined) {
      if (signal.aborted) terminate();
      else signal.addEventListener('abort', terminate, { once: true });
    }
  });
}

/**
 * Parse JSONL records from stdout. Records are split only on LF (an optional
 * CR is stripped) and any line that is not a JSON object with a string `type`
 * is skipped, so a stray warning cannot swallow a whole structured run.
 * @param stdout - the child's collected standard output.
 * @returns the parsed records, in order.
 */
function parseJsonRecords(stdout) {
  const records = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.trim() === '') continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(value) || typeof value.type !== 'string') continue;
    records.push(value);
  }
  return records;
}

/**
 * Concatenate the text blocks of one Pi message.
 * @param message - a Pi `message_end.message` value.
 * @returns its visible text; empty when it has no text block.
 */
function piMessageText(message) {
  if (!isRecord(message) || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('').trimEnd();
}

/**
 * Map Pi's `Usage` onto the DSH `TokenUsage` fields. The counts are disjoint on
 * both sides; `totalTokens` and `cost` are derived and stay out of the log.
 * @param usage - Pi's usage object, when present.
 * @returns the DSH usage, or undefined when the message reported none.
 */
function tokenUsageOf(usage) {
  if (!isRecord(usage)) return undefined;
  const count = (key) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0
    ? usage[key]
    : undefined);
  const inputTokens = count('input');
  const outputTokens = count('output');
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const mapped = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
  for (const [from, to] of [
    ['cacheRead', 'cacheReadTokens'],
    ['cacheWrite', 'cacheWriteTokens'],
    ['reasoning', 'reasoningTokens'],
  ]) {
    const value = count(from);
    if (value !== undefined) mapped[to] = value;
  }
  return mapped;
}

/**
 * Fold Pi's JSON-mode records into the turns this projection keeps.
 *
 * Turn boundaries come from `turn_start`; an assistant `message_end` with text
 * becomes one projected message (thinking and tool-call blocks are dropped in
 * this version); `aborted` facts come from `agent_settled` or the message's own
 * `stopReason`. `finalText` is the last non-empty assistant text — the value
 * the parent model receives.
 *
 * @param records - parsed JSONL records.
 * @returns the folded turns and the final answer text.
 */
function foldPiRecords(records) {
  const turns = [];
  let current;
  let finalText = '';
  let aborted = false;
  const ensureTurn = () => {
    if (current === undefined) {
      current = { messages: [] };
      turns.push(current);
    }
    return current;
  };
  for (const record of records) {
    switch (record.type) {
      case 'turn_start':
        current = { messages: [] };
        turns.push(current);
        break;
      case 'message_end': {
        const message = record.message;
        if (!isRecord(message) || message.role !== 'assistant') break;
        if (message.stopReason === 'aborted') aborted = true;
        const text = piMessageText(message);
        if (text === '') break;
        ensureTurn().messages.push({
          text,
          usage: tokenUsageOf(message.usage),
          provider: typeof message.provider === 'string' && message.provider !== '' ? message.provider : PROVIDER,
          model: typeof message.model === 'string' && message.model !== '' ? message.model : 'pi',
        });
        finalText = text;
        break;
      }
      case 'agent_settled':
        if (record.aborted === true) aborted = true;
        break;
      default:
        /* this version projects no other Pi event */
        break;
    }
  }
  return { turns, finalText, aborted };
}

/**
 * Turn one finished child run into the projection input and the tool outcome.
 *
 * A run whose stdout is not JSONL (an older `pi-dev`, `--mode text`, or a
 * wrapper that printed the answer itself) degrades to one turn with the whole
 * stdout as the single assistant text: no error, no lost task.
 *
 * @param config - the resolved plugin config.
 * @param run - the child's collected facts.
 * @returns stop reason, folded turns, answer text, and the failure diagnostic.
 */
function foldRun(config, run) {
  const records = parseJsonRecords(run.stdout);
  const folded = records.length > 0
    ? foldPiRecords(records)
    : (() => {
      const text = run.stdout.trimEnd();
      return {
        turns: text === ''
          ? []
          : [{
            messages: [{
              text,
              usage: undefined,
              provider: PROVIDER,
              model: config.model ?? 'pi',
            }],
          }],
        finalText: text,
        aborted: false,
      };
    })();

  const failure = failureOf(run);
  const stopReason = run.aborted || folded.aborted
    ? 'aborted'
    : (failure === undefined ? 'completed' : 'error');
  return {
    stopReason,
    turns: folded.turns,
    finalText: folded.finalText,
    ...(failure === undefined ? {} : { diagnostic: failure.diagnostic }),
    ...(stopReason === 'error' ? { failure: { message: failure?.message ?? 'pi-dev failed', code: 'UNKNOWN' } } : {}),
    ...(stopReason === 'aborted' ? { aborted: true } : {}),
  };
}

/**
 * Describe a failed run: a spawn error, or a non-zero exit with its stderr.
 * @param run - the child's collected facts.
 * @returns the failure head and its capped diagnostic; or undefined for a
 *   clean or cancelled run.
 */
function failureOf(run) {
  if (run.aborted) return undefined;
  if (run.error !== undefined) {
    const head = `${PREFIX}: could not start the pi-dev child: ${errorMessage(run.error)}`;
    return { message: head, diagnostic: diagnosticText(head, run.stderr) };
  }
  if (run.exitCode === 0) return undefined;
  const term = typeof run.termSignal === 'string' ? ` (${run.termSignal})` : '';
  const head = run.exitCode === null ? `pi-dev exit code null${term}` : `pi-dev exit code ${run.exitCode}`;
  return { message: head, diagnostic: diagnosticText(head, run.stderr) };
}

/** The message-facing description of the `pi` tool. */
const TOOL_DESCRIPTION = [
  'Delegate a development task to the local Pi coding agent (`pi-dev`) and get its final answer back.',
  'Pi runs as a separate process with its own context: it reads and edits files, runs commands, and returns one answer, so use it for self-contained implementation, investigation, or review work that does not build on this conversation.',
  'Each delegation also creates a real child session in DSH (the task text, Pi\'s assistant replies with token usage, and the run end state) that you can inspect afterwards; that child session is read-only history and does not show tool calls in this version.',
].join(' ');

/** The model-facing parameter schema of the `pi` tool. */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'The complete, self-contained task for Pi. Pi does not see this conversation, so include everything it needs.',
    },
    cwd: {
      type: 'string',
      description: 'Absolute working directory for the Pi run; it must exist. Omit to use this session\'s working directory.',
    },
    label: {
      type: 'string',
      description: 'Short label for the child session shown in DSH\'s subagent list. Omit to use the first line of `prompt`, at most 60 characters.',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
};

/** The canonical successful value of the `pi` tool. */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    output: { type: 'string' },
    childSessionId: { type: 'string' },
    logPath: { type: 'string' },
    stopReason: { type: 'string' },
    diagnostic: { type: 'string' },
  },
  required: ['output', 'childSessionId', 'logPath', 'stopReason'],
  additionalProperties: false,
};

/**
 * Render the tool value for the model: the answer, an optional diagnostic, and
 * the two pointers it needs afterwards (child session, full log).
 * @param _args - the (frozen) tool arguments.
 * @param value - the validated canonical value.
 * @returns one text block.
 */
function renderPiResult(_args, value) {
  const lines = [value.output.trim() === '' ? '(pi produced no text)' : value.output];
  if (value.diagnostic !== undefined) lines.push(value.diagnostic);
  if (value.stopReason !== 'completed') lines.push(`pi run status: ${value.stopReason}`);
  lines.push(`subagent session: ${value.childSessionId === '' ? '(not projected)' : value.childSessionId}`);
  lines.push(`full output: ${value.logPath === '' ? '(none)' : value.logPath}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Validate one required string tool argument.
 * @param value - the raw argument.
 * @param field - the field name, for the diagnostic.
 * @returns the non-empty string.
 */
function requiredToolText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PREFIX}: \`${field}\` is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Validate one optional string tool argument.
 * @param value - the raw argument.
 * @param field - the field name, for the diagnostic.
 * @returns the string, or undefined when absent/empty.
 */
function optionalToolText(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${PREFIX}: \`${field}\` must be a string`);
  return value;
}

/**
 * The default child label: the first non-empty line of the prompt, cut to
 * {@link LABEL_MAX_CHARS} characters.
 * @param prompt - the task text.
 * @returns the label.
 */
function defaultLabel(prompt) {
  const line = prompt.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? '';
  return line.length > LABEL_MAX_CHARS ? line.slice(0, LABEL_MAX_CHARS) : line;
}

/**
 * Assert `cwd` can host the child: absolute (it doubles as the workspace
 * identity) and an existing directory (fail here with a clear message instead
 * of as an ambiguous spawn error).
 * @param cwd - the working directory.
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
 * The calling agent, which owns the parent session this tool records into.
 * @param exec - the tool run context.
 * @returns the parent agent.
 */
function parentAgentOf(exec) {
  const agent = exec?.agent;
  if (agent === undefined || agent === null || agent.session === undefined || agent.session === null) {
    throw new Error(`${PREFIX}: the pi tool needs the calling parent agent (exec.agent) to record the child session; it is unavailable in this call`);
  }
  return agent;
}

/**
 * The parent's working directory, used when the call omits `cwd`.
 * @param agent - the parent agent.
 * @returns an absolute path.
 */
function parentWorkingDirectory(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/**
 * Delegation depth for the child: the parent's own depth plus one. The
 * persisted header is the monotone floor; runtime options may deepen it.
 * @param agent - the parent agent.
 * @returns the child's non-negative depth.
 */
function delegationDepthOf(agent) {
  const persisted = agent?.session?.header?.delegationDepth;
  const runtime = agent?.options?.subagentDepth;
  const floor = Number.isSafeInteger(persisted) && persisted >= 0 ? persisted : 0;
  const extra = Number.isSafeInteger(runtime) && runtime >= 0 ? runtime : 0;
  return Math.max(floor, extra) + 1;
}

/**
 * Resolve one injected service without assuming the service exists.
 * @param ctx - the plugin context.
 * @param key - the context property name.
 * @returns the service, or undefined.
 */
function serviceOf(ctx, key) {
  const direct = ctx?.[key];
  if (direct !== undefined && direct !== null) return direct;
  return typeof ctx?.get === 'function' ? ctx.get(key) : undefined;
}

/** An identified user message on the child's surface. */
function userMessageData(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/**
 * One projected assistant message: text blocks only, Pi's route as the model
 * source, and the step's token usage. `stream` is empty — this version records
 * no provider stream.
 * @param turn - the owning turn (1-based).
 * @param step - the owning step (1-based).
 * @param message - the folded message.
 * @returns the `assistant/message` payload.
 */
function assistantMessageData(turn, step, message) {
  return {
    turn,
    step,
    message: {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'model', provider: message.provider, model: message.model },
    },
    stream: [],
    ...(message.usage === undefined ? {} : { usage: message.usage }),
  };
}

/**
 * The `turn/end` reason for a finished run.
 * @param run - the folded run.
 * @returns a `TurnEndReason` shape from `@deepseek-ai/dsh-session`.
 */
function turnEndReason(run) {
  if (run.aborted === true) return { kind: 'aborted', reason: { kind: 'user' } };
  if (run.stopReason === 'error') {
    return { kind: 'error', error: { message: run.failure?.message ?? 'pi-dev failed', code: 'UNKNOWN' } };
  }
  return { kind: 'completed' };
}

/**
 * Append the projected child history in the order the runtime expects.
 *
 * The durable log is relationship-checked on restore, so the projection keeps
 * the loop's brackets: `turn/start` opens a turn, the initial `user/message`
 * lands before the first `step/start`, and every `assistant/message` sits
 * inside its own `step/start`…`step/end` (one step = one model call). The
 * descriptor goes inside the initial turn, before the first request, and
 * `turn/end` carries the real end reason on the last turn.
 *
 * @param session - the live child session.
 * @param input - label, task text, and the folded run.
 */
function appendProjection(session, input) {
  const { label, prompt, run } = input;
  session.append('subagent/descriptor', {
    version: DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: PROVIDER,
    ...(label === '' ? {} : { label }),
  });
  const turns = run.turns.length === 0 ? [{ messages: [] }] : run.turns;
  turns.forEach((turn, index) => {
    const number = index + 1;
    session.append('turn/start', { turn: number });
    if (number === 1) {
      session.append('user/message', userMessageData(prompt), { surfaceOp: 'append' });
    }
    let step = 0;
    for (const message of turn.messages) {
      step += 1;
      session.append('step/start', { turn: number, step });
      session.append('assistant/message', assistantMessageData(number, step, message), { surfaceOp: 'append' });
      session.append('step/end', { turn: number, step });
    }
    session.append('turn/end', {
      turn: number,
      reason: index === turns.length - 1 ? turnEndReason(run) : { kind: 'completed' },
    });
  });
}

/**
 * Create the durable child session for one finished run and append its
 * projection plus the parent's discovery row.
 *
 * Order follows `dsh-agent-loop`: `prepare` → `sessionPersistence.create` →
 * `enter` → `announce` → append → `flush`. The child is detached and its write
 * handle released afterwards, so the store does not keep a synthetic "running"
 * session: DSH reads it back from persistence as read-only history.
 *
 * @param ctx - the plugin context.
 * @param input - child identity, parent agent, run facts.
 * @returns the child session id.
 */
async function recordChildSession(ctx, input) {
  const { childId, parentAgent, cwd, label, prompt, run } = input;
  const sessions = serviceOf(ctx, 'sessions');
  const persistence = serviceOf(ctx, 'sessionPersistence');
  if (sessions === undefined || typeof sessions.prepare !== 'function') {
    throw new Error(`${PREFIX}: the sessions service is unavailable`);
  }
  if (persistence === undefined || typeof persistence.create !== 'function') {
    throw new Error(`${PREFIX}: the sessionPersistence service is unavailable`);
  }
  const parent = parentAgent.session;
  const session = sessions.prepare(childId, {
    meta: {
      cwd,
      parentSession: parent.id,
      origin: 'subagent',
      delegationDepth: delegationDepthOf(parentAgent),
    },
  });
  const handle = await persistence.create(session.header, { inheritedEventCount: 0 });
  let detach;
  try {
    // Events the constructor produced before publication (the session boundary
    // marker) never fire `session/event`, so the persistence backend's live
    // routing cannot see them. `dsh-agent-loop` writes the same suffix through
    // `appendUnstoredSuffix`; without it the stored log would start at a later
    // seq and the backend's contiguity check would reject the first routed
    // event.
    const unstored = session.snapshotEvents();
    if (unstored.length > 0) await handle.append(unstored);
    detach = sessions.enter(session);
    sessions.announce(session);
    appendProjection(session, { label, prompt, run });
    parent.append('subagent/catalog', {
      version: CATALOG_VERSION,
      childId: session.id,
      childCreatedAt: session.header.createdAt,
      mode: 'one-shot',
      label,
    });
  } catch (error) {
    try {
      detach?.();
    } catch {
      /* the detach is best-effort once the projection is being abandoned */
    }
    try {
      await handle.close();
    } catch {
      /* the handle is best-effort once the projection is being abandoned */
    }
    throw error;
  }
  try {
    await sessions.flush(session);
  } catch (error) {
    warn(ctx, 'could not flush the child session', error);
  }
  try {
    await sessions.flush(parent);
  } catch (error) {
    warn(ctx, 'could not flush the parent session', error);
  }
  try {
    detach?.();
  } catch (error) {
    warn(ctx, 'could not detach the child session', error);
  }
  try {
    await handle.close();
  } catch (error) {
    warn(ctx, 'could not close the child session log', error);
  }
  return session.id;
}

/**
 * Whether this run proves the wrapper does not understand `--mode`.
 *
 * The signature is deliberately narrow: a non-zero exit, no stdout at all, and
 * an argument-parsing complaint naming `--mode`. An argument parser rejects the
 * flag before the wrapper reads the brief or starts Pi, so retrying without it
 * cannot run the task twice; anything else keeps its own failure.
 *
 * @param run - the first attempt's collected facts.
 * @returns whether a text-mode retry is safe and useful.
 */
function rejectedModeFlag(run) {
  if (run.error !== undefined || run.aborted === true) return false;
  if (run.exitCode === 0) return false;
  if (run.stdout.trim() !== '') return false;
  return /unknown argument: --mode|unrecognized arguments?:.*--mode/i.test(run.stderr);
}

/**
 * Run one delegation and optionally project it into a child session.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @param args - the model's tool arguments.
 * @param exec - the tool run context (`agent` and `signal`).
 * @returns the canonical tool value.
 */
async function executePi(ctx, config, args, exec) {
  const input = isRecord(args) ? args : {};
  const prompt = requiredToolText(input.prompt, 'prompt');
  const requestedLabel = optionalToolText(input.label, 'label');
  const requestedCwd = optionalToolText(input.cwd, 'cwd');
  const parentAgent = parentAgentOf(exec);
  const signal = exec?.signal;
  const cwd = await assertUsableCwd(requestedCwd ?? parentWorkingDirectory(parentAgent));
  const label = requestedLabel ?? defaultLabel(prompt);
  const childId = randomUUID();
  const logPath = join(config.logDir, `${logStamp(new Date())}-${childId.slice(0, 8)}.log`);
  const scratch = await mkdtemp(join(tmpdir(), `${PREFIX}-`));
  const briefPath = join(scratch, 'brief.md');

  let run;
  try {
    await writeFile(briefPath, prompt, 'utf8');
    try {
      await mkdir(config.logDir, { recursive: true });
    } catch (error) {
      warn(ctx, 'could not create the log directory', error);
    }
    run = await runPiChild(ctx, config, { argv: childArgv(config, briefPath, cwd, logPath), cwd, signal });
    if (config.projection && rejectedModeFlag(run)) {
      warn(
        ctx,
        'the pi-dev wrapper rejected --mode; retrying in text mode, the session projection degrades to text',
        new Error(run.stderr.trim().split('\n')[0] ?? ''),
      );
      run = await runPiChild(ctx, config, { argv: childArgv(config, briefPath, cwd, logPath, false), cwd, signal });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const folded = foldRun(config, run);
  let childSessionId = '';
  if (config.projection) {
    try {
      childSessionId = await recordChildSession(ctx, { childId, parentAgent, cwd, label, prompt, run: folded });
    } catch (error) {
      warn(ctx, 'session projection failed; the delegation result is unaffected', error);
    }
  }

  return {
    output: folded.finalText,
    childSessionId,
    logPath,
    stopReason: folded.stopReason,
    ...(folded.diagnostic === undefined ? {} : { diagnostic: folded.diagnostic }),
  };
}

/**
 * Build the `pi` tool definition. Registered as a plain object (not through
 * `defineTool`) so the plugin keeps its zero-dependency surface.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @returns the registry-ready definition.
 */
function createPiTool(ctx, config) {
  return {
    name: 'pi',
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: renderPiResult,
    },
    execute: (args, exec) => executePi(ctx, config, args, exec),
  };
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
 * bad value is a load error rather than a surprise on the first delegation.
 * @param config - the raw config object from the profile.
 * @returns the resolved config.
 */
function resolveConfig(config) {
  const raw = isRecord(config) ? config : {};

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

  const projection = raw.projection === undefined || raw.projection === null ? true : raw.projection;
  if (typeof projection !== 'boolean') throw new TypeError(`${PREFIX}: projection must be a boolean`);

  const home = typeof process.env.HOME === 'string' && process.env.HOME !== '' ? process.env.HOME : homedir();

  return {
    command: requiredText('command', raw.command, DEFAULT_COMMAND),
    args,
    model: optionalText('model', raw.model),
    thinking: optionalText('thinking', raw.thinking),
    tools: optionalText('tools', raw.tools),
    approve,
    projection,
    logDir: requiredText('logDir', raw.logDir, join(home, DEFAULT_LOG_SUBDIR)),
    graceMs: positiveNumber('graceMs', raw.graceMs, DEFAULT_GRACE_MS),
    maxOutputBytes: positiveNumber('maxOutputBytes', raw.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
  };
}

/**
 * Register the `pi` tool with the tool registry.
 * @param ctx - the plugin context; `tools`, `sessions`, and
 *   `sessionPersistence` are injected.
 * @param config - the profile config (see README for the table).
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  ctx.tools.register(createPiTool(ctx, resolved));
}
