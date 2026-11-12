/**
 * Pi (`pi-dev`) as a DSH subagent backend, with live session projection.
 *
 * One `pi-dev` child per delegation, owned here: the plugin registers its own
 * `pi` tool (it no longer goes through `@deepseek-ai/dsh-tool-subagent`), so
 * the same call can do two things that used to be impossible together:
 *
 * 1. run the delegation — write the brief, spawn `pi-dev`, and return Pi's
 *    final answer;
 * 2. project the run into a real DSH child session *as it happens* — the child
 *    session is created first (`sessions.prepare` + `sessionPersistence.create`
 *    + `enter`/`announce`), its opening events (`turn/start`, the
 *    `subagent/descriptor`, the task text) and the parent's `subagent/catalog`
 *    row are appended before the child is spawned, and every NDJSON record Pi
 *    emits is then projected line by line: one `step/start`…`step/end` bracket
 *    per Pi turn, `assistant/message` with reasoning/text/tool-call blocks,
 *    `tool/call` + `tool/result` for every tool execution, and a `turn/end`
 *    carrying the real end state. Timestamps are real, long runs do not lose
 *    their early events, and the child row is visible in DSH while Pi works.
 *
 * Projection is strictly a bonus. Every step is guarded: a missing service, a
 * rejected append, or unparseable child output degrades the projection (or the
 * whole child session) with a `ctx.logger.warn`, while the delegation result is
 * returned unchanged. `pi-dev` itself stays the owner of the run environment:
 * throwaway `PI_CODING_AGENT_DIR`, credential handoff, fixed rules, model pin,
 * `--no-session`, the tee'd log, and the delegation record.
 *
 * JSON mode is detected up front by running `pi-dev --help` once (a wrapper
 * that does not advertise `--mode` gets the plain-text contract instead of a
 * failed attempt), so a run is never started twice.
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
import { StringDecoder } from 'node:string_decoder';

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

/** Default in-memory cap for one collected stream. */
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

/** The model-facing cap for provider-authored diagnostics. */
const MAX_DIAGNOSTIC_BYTES = 4_096;

/** Longest default label taken from the prompt's first line. */
const LABEL_MAX_CHARS = 60;

/** The provider name stamped into the child descriptor and messages. */
const PROVIDER = 'pi';

/** `SUBAGENT_DESCRIPTOR_VERSION` from `@deepseek-ai/dsh-subagent/descriptor`. */
const DESCRIPTOR_VERSION = 3;

/** `SUBAGENT_CATALOG_VERSION` from `@deepseek-ai/dsh-subagent/catalog`. */
const CATALOG_VERSION = 0;

/** How long the one-shot `--help` capability probe may take. */
const PROBE_TIMEOUT_MS = 5_000;

/** Longest NDJSON line kept; a longer line is dropped whole. */
const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** Model-facing text for a tool call that never settled before its step closed. */
const UNSETTLED_TOOL_TEXT = 'The tool call did not return a result before the task ended.';

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
 * relevant diagnostics (usually the end of stderr, or the tail of a plain-text
 * answer) survive.
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
 * Split one byte stream into lines without splitting a UTF-8 sequence.
 *
 * A partial line is buffered until its LF arrives; a line longer than
 * `maxBytes` is discarded whole (and reported once) so one pathological record
 * cannot grow the buffer without bound.
 */
class LineSplitter {
  /** @type {StringDecoder} */
  #decoder = new StringDecoder('utf8');
  /** @type {string} */
  #buffer = '';
  /** @type {boolean} */
  #discarding = false;
  /** @type {number} */
  #maxBytes;

  /**
   * @param maxBytes - positive per-line character budget (an approximation of bytes).
   */
  constructor(maxBytes) {
    this.#maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  /**
   * Feed the next chunk and emit every complete line.
   * @param chunk - the next stream chunk.
   * @param onLine - receives each complete line (CR stripped).
   * @param onOverflow - receives the size of a dropped line.
   */
  push(chunk, onLine, onOverflow) {
    if (chunk === undefined || chunk === null || chunk.length === 0) return;
    this.#buffer += this.#decoder.write(chunk);
    this.#drain(onLine, onOverflow);
  }

  /**
   * Emit the final partial line, if any.
   * @param onLine - receives the trailing line.
   */
  flush(onLine) {
    this.#buffer += this.#decoder.end();
    if (this.#buffer === '') return;
    const line = this.#buffer;
    this.#buffer = '';
    const discarding = this.#discarding;
    this.#discarding = false;
    if (discarding) return;
    if (line.length > this.#maxBytes) return;
    onLine(stripCr(line));
  }

  /**
   * Emit all complete lines currently buffered.
   * @param onLine - receives each complete line.
   * @param onOverflow - receives the size of a dropped line.
   */
  #drain(onLine, onOverflow) {
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf('\n');
      if (this.#discarding) {
        this.#discarding = false;
        continue;
      }
      if (line.length > this.#maxBytes) {
        onOverflow(line.length);
        continue;
      }
      onLine(stripCr(line));
    }
    if (this.#buffer.length > this.#maxBytes) {
      const dropped = this.#buffer.length;
      this.#buffer = '';
      if (!this.#discarding) {
        this.#discarding = true;
        onOverflow(dropped);
      }
    }
  }
}

/** Strip one trailing CR from a line. */
function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Build the child argv. `--brief`, `--cwd`, and `--log` are always present;
 * `--mode json` is added only when the wrapper advertised support and
 * projection is on; the optional switches follow in a fixed order, and
 * `config.args` goes last so a profile can append anything `pi-dev` grows
 * later.
 * @param config - the resolved plugin config.
 * @param briefPath - where the brief was written.
 * @param cwd - the child's working directory.
 * @param logPath - where `pi-dev` tees the full output.
 * @param json - request Pi's JSON event stream.
 * @returns the argv handed to the child.
 */
function childArgv(config, briefPath, cwd, logPath, json) {
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
 * Ask the wrapper whether it understands `--mode`, by running `--help` once
 * with stdin ignored and a short timeout. Failure of any kind (spawn error,
 * hang, non-zero exit, help text without the flag) means "text mode": the run
 * must never depend on retrying a failed attempt.
 * @param ctx - the plugin context (diagnostics only).
 * @param config - the resolved plugin config.
 * @param cwd - a validated existing directory for the probe process.
 * @returns whether `--help` mentions `--mode`.
 */
function probeJsonSupport(ctx, config, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.command, ['--help'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      warn(ctx, 'could not probe the pi-dev wrapper for --mode support', error);
      resolve(false);
      return;
    }
    const output = new TailBuffer(config.maxOutputBytes);
    let settled = false;
    const finish = (supported) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(supported);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(output.text().includes('--mode'));
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => output.push(chunk));
    child.stderr?.on('data', (chunk) => output.push(chunk));
    child.once('error', (error) => {
      warn(ctx, 'could not probe the pi-dev wrapper for --mode support', error);
      finish(false);
    });
    child.once('close', () => finish(output.text().includes('--mode')));
  });
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
 * Convert one Pi assistant `message_end.message` into DSH content blocks.
 *
 * Pi's `thinking` becomes `reasoning` and Pi's camel-case `toolCall` becomes
 * DSH's `tool-call`; the block's `arguments` is the raw JSON string DSH
 * requires, produced once and reused verbatim by the matching `tool/call`
 * (the durable log rejects a call whose string differs).
 *
 * @param message - a Pi assistant message.
 * @returns the DSH blocks and the tool calls they advertise.
 */
function piContentBlocks(message) {
  const content = [];
  const calls = [];
  if (!isRecord(message) || !Array.isArray(message.content)) return { content, calls };
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text !== '') content.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'thinking') {
      if (typeof block.thinking === 'string' && block.thinking !== '') {
        content.push({ type: 'reasoning', text: block.thinking });
      }
      continue;
    }
    if (block.type !== 'toolCall') continue;
    const id = typeof block.id === 'string' && block.id !== '' ? block.id : undefined;
    const callName = typeof block.name === 'string' && block.name !== '' ? block.name : undefined;
    if (id === undefined || callName === undefined) continue;
    let args;
    if (typeof block.arguments === 'string') args = block.arguments;
    else {
      try {
        args = JSON.stringify(block.arguments ?? {});
      } catch {
        args = '{}';
      }
    }
    content.push({ type: 'tool-call', id, name: callName, arguments: args });
    calls.push({ id, name: callName, arguments: args });
  }
  return { content, calls };
}

/**
 * The model-facing text of one Pi assistant message.
 * @param content - the DSH blocks already converted from it.
 * @returns the concatenated text blocks, right-trimmed; empty when none.
 */
function contentText(content) {
  const parts = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trimEnd();
}

/**
 * The model-facing text of one `tool_execution_end.result`: its text blocks
 * joined, else the serialized structured content.
 * @param result - Pi's tool result value.
 * @returns the result text; empty when the tool reported neither.
 */
function toolResultText(result) {
  if (!isRecord(result)) return '';
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  const text = parts.join('');
  if (text !== '') return text;
  if (result.structuredContent === undefined) return '';
  try {
    return JSON.stringify(result.structuredContent) ?? '';
  } catch {
    return '';
  }
}

/**
 * Project one live Pi run into the already-open child session.
 *
 * The instance is the whole state machine: it owns the open step, the pending
 * tool calls, the last assistant text, and the run's abort flag. When the
 * session is absent (projection off, or the child session could not be
 * created) every append is a no-op and only the run facts are tracked, so the
 * caller uses one code path for both.
 *
 * Event order is what the durable log's restore-time relationship checks
 * demand: every `assistant/message` (and its `tool/call`s) sits inside the open
 * `step/start`…`step/end` bracket, every advertised `tool/call` is answered by
 * exactly one `tool/result` before that `step/end`, and the single `turn/end`
 * comes after the last step closed.
 */
class ChildProjection {
  /** @type {object|undefined} */
  #ctx;
  /** @type {object|undefined} */
  #session;
  /** @type {boolean} */
  #json;
  /** @type {string} */
  #defaultProvider;
  /** @type {string} */
  #defaultModel;
  /** @type {TailBuffer} */
  #raw;
  /** @type {number} */
  #records = 0;
  /** @type {boolean} */
  #turnOpen = false;
  /** @type {number} */
  #step = 0;
  /** @type {number} */
  #nextStep = 1;
  /** @type {Map<string, {id: string, name: string, arguments: string}>} */
  #pending = new Map();
  /** @type {string} */
  #finalText = '';
  /** @type {boolean} */
  #aborted = false;
  /** @type {boolean} */
  #failed = false;
  /** @type {boolean} */
  #finished = false;

  /**
   * @param options - context, the child session (or undefined), JSON mode, the
   *   raw-output budget, and the fallback provider/model.
   */
  constructor(options) {
    this.#ctx = options.ctx;
    this.#session = options.session;
    this.#json = options.json === true;
    this.#defaultProvider = options.provider;
    this.#defaultModel = options.model;
    this.#raw = new TailBuffer(options.maxOutputBytes);
    // `openChildSession` already appended `turn/start`; without a session there
    // is nothing to close.
    this.#turnOpen = options.session !== undefined;
  }

  /** @returns the last assistant text seen, the value the parent model gets. */
  get finalText() {
    return this.#finalText;
  }

  /** @returns whether the run itself claimed to be aborted. */
  get aborted() {
    return this.#aborted;
  }

  /**
   * Append one event, degrading instead of throwing.
   *
   * A failed content append stops further content (a half-written step must not
   * gain more references), while structural closers are still attempted so a
   * transient rejection cannot leave an open step or turn behind.
   *
   * @param type - the session event type.
   * @param data - the JSON payload.
   * @param opts - surface options.
   * @param structural - whether this event only closes a bracket.
   * @returns whether the event was appended.
   */
  append(type, data, opts, structural = false) {
    if (this.#session === undefined) return false;
    if (this.#failed && !structural) return false;
    try {
      this.#session.append(type, data, opts);
      return true;
    } catch (error) {
      this.#failed = true;
      warn(this.#ctx, `could not append ${type} to the child session; later content is not projected`, error);
      return false;
    }
  }

  /**
   * Project one stdout line: an NDJSON record in JSON mode, or plain answer
   * text (also the fallback when JSON mode was requested but the wrapper printed
   * text anyway).
   * @param line - one complete line without its LF.
   */
  acceptLine(line) {
    if (line.trim() === '') return;
    if (!this.#json) {
      this.#raw.push(Buffer.from(`${line}\n`, 'utf8'));
      return;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      record = undefined;
    }
    if (!isRecord(record) || typeof record.type !== 'string') {
      if (this.#records === 0) this.#raw.push(Buffer.from(`${line}\n`, 'utf8'));
      return;
    }
    this.#records += 1;
    this.handleRecord(record);
  }

  /**
   * Project one parsed Pi record.
   * @param record - a JSON object with a string `type`.
   */
  handleRecord(record) {
    switch (record.type) {
      case 'turn_start':
        // One Pi turn is one model call: one DSH step.
        this.#openStep();
        break;
      case 'message_end': {
        const message = record.message;
        if (isRecord(message) && message.role === 'assistant') this.#acceptMessage(message);
        break;
      }
      case 'tool_execution_end':
        this.#acceptToolResult(record);
        break;
      case 'turn_end':
        this.#closeStep();
        break;
      case 'agent_end':
      case 'agent_settled':
        if (record.aborted === true) this.#aborted = true;
        break;
      default:
        /* message_start, message_update, tool_execution_start, session … */
        break;
    }
  }

  /**
   * Close every bracket and append the turn's real end reason.
   * @param input - the run's stop reason and, for an error, its message.
   * @returns nothing; read {@link finalText} and {@link aborted} afterwards.
   */
  finish(input) {
    if (this.#finished) return;
    this.#finished = true;
    const rawText = this.#records === 0 ? this.#raw.text().trimEnd() : '';
    if (rawText !== '') {
      // Plain-text run, or JSON mode whose output was never JSONL: one
      // assistant message carrying the whole answer.
      this.#openStep();
      if (this.#step !== 0) {
        this.append('assistant/message', {
          turn: 1,
          step: this.#step,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text: rawText }],
            source: { kind: 'model', provider: this.#defaultProvider, model: this.#defaultModel },
          },
          stream: [],
        }, { surfaceOp: 'append' });
      }
      this.#finalText = rawText;
    }
    this.#closeStep();
    if (this.#turnOpen) {
      this.append('turn/end', { turn: 1, reason: this.#endReason(input) }, undefined, true);
      this.#turnOpen = false;
    }
  }

  /**
   * The `turn/end` reason for this run.
   * @param input - stop reason and failure message.
   * @returns a `TurnEndReason` shape from `@deepseek-ai/dsh-session`.
   */
  #endReason(input) {
    if (input.stopReason === 'aborted' || this.#aborted) {
      return { kind: 'aborted', reason: { kind: 'user' } };
    }
    if (input.stopReason === 'error') {
      return { kind: 'error', error: { message: input.failureMessage ?? 'pi-dev failed', code: 'UNKNOWN' } };
    }
    return { kind: 'completed' };
  }

  /**
   * Open the next step, closing an unexpectedly still-open one first.
   */
  #openStep() {
    if (this.#step !== 0) this.#closeStep();
    const step = this.#nextStep;
    if (!this.append('step/start', { turn: 1, step })) return;
    this.#step = step;
    this.#nextStep = step + 1;
  }

  /**
   * Answer any tool call still pending in this step, then close it. The
   * durable log rejects a `step/end` that leaves an advertised call unresolved.
   */
  #closeStep() {
    if (this.#step === 0) return;
    this.#settlePending();
    this.append('step/end', { turn: 1, step: this.#step }, undefined, true);
    this.#step = 0;
  }

  /**
   * Append an error result for every tool call this step advertised but never
   * settled (a crash, a cancel, or a Pi stream that ended mid-tool).
   */
  #settlePending() {
    for (const call of this.#pending.values()) {
      this.append('tool/result', {
        turn: 1,
        step: this.#step,
        message: {
          id: randomUUID(),
          role: 'tool',
          content: [{ type: 'text', text: UNSETTLED_TOOL_TEXT }],
          source: { kind: 'tool', callId: call.id },
          toolCallId: call.id,
          isError: true,
        },
      }, { surfaceOp: 'append' });
    }
    this.#pending.clear();
  }

  /**
   * Project one assistant message and advertise its tool calls.
   * @param message - Pi's assistant message.
   */
  #acceptMessage(message) {
    if (message.stopReason === 'aborted') this.#aborted = true;
    const { content, calls } = piContentBlocks(message);
    if (content.length === 0) return;
    const text = contentText(content);
    // The answer is recorded even when the session cannot be written: the
    // delegation result never depends on the projection.
    if (text !== '') this.#finalText = text;
    if (this.#session === undefined) return;
    if (this.#step === 0) this.#openStep();
    if (this.#step === 0) return;
    const provider = typeof message.provider === 'string' && message.provider !== ''
      ? message.provider
      : this.#defaultProvider;
    const model = typeof message.model === 'string' && message.model !== ''
      ? message.model
      : this.#defaultModel;
    const usage = tokenUsageOf(message.usage);
    const payload = {
      turn: 1,
      step: this.#step,
      message: { id: randomUUID(), role: 'assistant', content, source: { kind: 'model', provider, model } },
      stream: [],
    };
    if (usage !== undefined) payload.usage = usage;
    if (!this.append('assistant/message', payload, { surfaceOp: 'append' })) return;
    for (const call of calls) {
      const appended = this.append('tool/call', {
        turn: 1,
        step: this.#step,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      if (!appended) return;
      this.#pending.set(call.id, call);
    }
  }

  /**
   * Project one finished tool execution against the call its assistant message
   * advertised.
   * @param record - Pi's `tool_execution_end` record.
   */
  #acceptToolResult(record) {
    if (this.#session === undefined) return;
    const callId = record.toolCallId;
    if (typeof callId !== 'string' || callId === '') {
      warn(this.#ctx, 'ignoring a tool result without a call id', new Error(String(record.toolName ?? '')));
      return;
    }
    if (this.#step === 0 || !this.#pending.has(callId)) {
      warn(this.#ctx, `ignoring the result of tool call ${callId}; no matching call is open`, new Error('unmatched tool result'));
      return;
    }
    const appended = this.append('tool/result', {
      turn: 1,
      step: this.#step,
      message: {
        id: randomUUID(),
        role: 'tool',
        content: [{ type: 'text', text: toolResultText(record.result) }],
        source: { kind: 'tool', callId },
        toolCallId: callId,
        ...(record.isError === true ? { isError: true } : {}),
      },
    }, { surfaceOp: 'append' });
    if (appended) this.#pending.delete(callId);
  }
}

/**
 * Spawn `pi-dev`, stream its stdout lines to `onLine`, and settle the run
 * facts. Only stderr is retained (bounded) for diagnostics; stdout is not
 * buffered for projection, so a long run cannot lose its early records.
 *
 * Cancellation sends SIGTERM and escalates to SIGKILL after `graceMs`, so the
 * tool call can always reach quiescence. Never rejects: a spawn failure is
 * reported through `error` on the returned facts.
 *
 * @param ctx - the plugin context (diagnostics only).
 * @param config - the resolved plugin config.
 * @param spec - argv, child cwd, the caller's cancellation signal, and the line sink.
 * @returns the child's exit facts and its retained stderr.
 */
function runPiChild(ctx, config, spec) {
  const { argv, cwd, signal, onLine } = spec;
  return new Promise((resolve) => {
    const stderr = new TailBuffer(config.maxOutputBytes);
    const splitter = new LineSplitter(MAX_LINE_BYTES);
    const safeLine = (line) => {
      try {
        onLine(line);
      } catch (error) {
        warn(ctx, 'could not project a child output line', error);
      }
    };
    const overflow = (bytes) => {
      warn(ctx, `dropping a ${bytes}-character output line (limit ${MAX_LINE_BYTES})`, new Error('oversized line'));
    };
    let settled = false;
    let killTimer;

    const settle = (facts) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (signal !== undefined) signal.removeEventListener('abort', terminate);
      try {
        splitter.flush(safeLine);
      } catch (error) {
        warn(ctx, 'could not flush the child output stream', error);
      }
      resolve({ ...facts, stderr: stderr.text(), aborted: signal?.aborted === true });
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
      resolve({ exitCode: null, termSignal: null, error, stderr: '', aborted: signal?.aborted === true });
      return;
    }

    child.stdout?.on('data', (chunk) => {
      try {
        splitter.push(chunk, safeLine, overflow);
      } catch (error) {
        warn(ctx, 'could not read the child output stream', error);
      }
    });
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
  'Each delegation also creates a real child session in DSH as the task starts, projected live: the task text, Pi\'s reasoning and replies with token usage, its tool calls and their results, one step per model call, and the run end state; that child session is read-only history.',
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
 * Append the child's opening events, before its process exists: the turn
 * bracket, the descriptor, and the task text. Throws on a rejected append so
 * the caller can abandon the whole child session.
 * @param session - the live child session.
 * @param input - label and task text.
 */
function appendOpening(session, input) {
  session.append('turn/start', { turn: 1 });
  session.append('subagent/descriptor', {
    version: DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: PROVIDER,
    ...(input.label === '' ? {} : { label: input.label }),
  });
  session.append('user/message', userMessageData(input.prompt), { surfaceOp: 'append' });
}

/**
 * Append the parent's discovery row for a child that is about to start work.
 * @param parent - the parent session.
 * @param session - the child session.
 * @param label - the child's label.
 */
function appendCatalog(parent, session, label) {
  parent.append('subagent/catalog', {
    version: CATALOG_VERSION,
    childId: session.id,
    childCreatedAt: session.header.createdAt,
    mode: 'one-shot',
    label,
  });
}

/**
 * Create the durable child session for one run and publish it, before the
 * child process starts, so the task (and its catalog row) is visible while Pi
 * works.
 *
 * Order follows `dsh-agent-loop`: `prepare` → `sessionPersistence.create` →
 * `enter` → `announce` → append. The child stays live and detachable, and its
 * write handle stays open until the run is over, so every streamed append lands
 * in the same durable log.
 *
 * @param ctx - the plugin context.
 * @param input - child identity, parent agent, cwd, label, and task text.
 * @returns the live child session plus the resources needed to release it.
 */
async function openChildSession(ctx, input) {
  const { childId, parentAgent, cwd, label, prompt } = input;
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
    appendOpening(session, { label, prompt });
    appendCatalog(parent, session, label);
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
  return { sessions, session, parent, detach, handle };
}

/**
 * Flush both sessions and release the child: detach first, then close the write
 * handle, so the store does not keep a synthetic "running" session. DSH then
 * reads it back from persistence as read-only history.
 * @param ctx - the plugin context.
 * @param opened - what {@link openChildSession} returned.
 */
async function closeChildSession(ctx, opened) {
  const { sessions, session, parent, detach, handle } = opened;
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
}

/**
 * Run one delegation and stream its projection into a child session.
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

  let projection;
  let projector;
  let run;
  let json = false;
  let childSessionId = '';
  try {
    await writeFile(briefPath, prompt, 'utf8');
    try {
      await mkdir(config.logDir, { recursive: true });
    } catch (error) {
      warn(ctx, 'could not create the log directory', error);
    }

    if (config.projection) {
      // The child session exists (and the parent can list it) before the child
      // process does; a rejected opening append abandons it entirely.
      try {
        projection = await openChildSession(ctx, { childId, parentAgent, cwd, label, prompt });
        childSessionId = projection.session.id;
      } catch (error) {
        warn(ctx, 'session projection failed; the delegation result is unaffected', error);
      }
      // Probe once for `--mode`; a wrapper without it still runs, in text mode.
      json = await probeJsonSupport(ctx, config, cwd);
      if (!json) {
        warn(
          ctx,
          'the pi-dev wrapper does not advertise --mode; running in text mode, the session projection degrades to plain text',
          new Error('no --mode in the wrapper help'),
        );
      }
    }

    projector = new ChildProjection({
      ctx,
      session: projection?.session,
      json,
      maxOutputBytes: config.maxOutputBytes,
      provider: PROVIDER,
      model: config.model ?? 'pi',
    });

    run = await runPiChild(ctx, config, {
      argv: childArgv(config, briefPath, cwd, logPath, json),
      cwd,
      signal,
      onLine: (line) => projector.acceptLine(line),
    });
  } catch (error) {
    if (projection !== undefined) await closeChildSession(ctx, projection);
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const failure = failureOf(run);
  const aborted = run.aborted === true || projector.aborted === true;
  const stopReason = aborted ? 'aborted' : (failure === undefined ? 'completed' : 'error');
  projector.finish({ stopReason, failureMessage: failure?.message });
  if (projection !== undefined) await closeChildSession(ctx, projection);

  return {
    output: projector.finalText,
    childSessionId,
    logPath,
    stopReason,
    ...(failure === undefined ? {} : { diagnostic: failure.diagnostic }),
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
