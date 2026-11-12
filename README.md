# dsh-subagent-pi

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) bundle that turns a local
[Pi](https://pi.dev) coding agent into an **out-of-process subagent** with an inspectable
child session. DSH's model hands a development task to Pi the same way it hands one to the
official Codex or Claude Code subagents, gets Pi's answer back, and can afterwards open the
run as a real, read-only DSH child session: the task text, Pi's replies with their token
usage, and how the run ended.

The plugin registers its own `pi` tool (it no longer needs
[`@deepseek-ai/dsh-tool-subagent`](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-subagent))
and runs one `pi-dev` child per call. The child session is created before the process
starts, and Pi's structured JSON-mode events are then projected line by line as they
arrive: reasoning, replies, tool calls and their results, one step per model call, with
real timestamps. The parent's catalog row is appended up front too, so the child appears
in DSH's subagent list while the task is still running and opens as read-only history.

## The thin shell

The plugin deliberately owns almost nothing about *how* Pi runs. That stays inside the
`pi-dev` wrapper:

1. a throwaway `PI_CODING_AGENT_DIR` per run, so `~/.pi` is never touched;
2. the credential handoff from Pi's own `auth.json` into the environment (never printed);
3. the fixed rules prepended to every brief;
4. the pinned model (`deepseek-flash` by default);
5. `--no-session`, so delegations leave no Pi session behind;
6. `--log` tee'ing the full output to a file;
7. one line appended to the delegation record after every run.

The plugin itself only does two things:

1. **run the delegation** — validate the arguments, write the brief to a scratch
   directory, spawn `pi-dev` (plain `node:child_process`, no seam needed), parse its stdout
   as NDJSON incrementally, keep only the stderr tail for diagnostics, escalate SIGTERM →
   SIGKILL on cancellation, and take the final answer from Pi's last non-empty assistant
   message;
2. **project the run live** — create a real DSH child session (`sessions.prepare` +
   `sessionPersistence.create` + `enter`/`announce`) and append its opening events plus the
   parent's `subagent/catalog` row *before* spawning the child, then stream one event per
   Pi record: `step/start`…`step/end` per model call, `assistant/message` with
   reasoning/text/tool-call blocks, `tool/call` + `tool/result` for every tool execution,
   and a `turn/end` with the run's real reason; finally flush both sessions and release
   the child.

It imports no `@deepseek-ai/*` package and has no runtime dependencies — only `node:`
built-ins. DSH injects the `tools`, `sessions`, and `sessionPersistence` services. Every
projection step is best-effort: if a service is missing or an append is rejected, the
plugin logs one warning and still returns Pi's answer.

## Requirements

- **Node.js** `^22.19.0 || >=24.0.0` and **DSH** `>= 0.2.2-rc.1`.
- **Pi CLI** installed and usable as `pi` (or via `PI_BIN`).
- **A `pi-dev` wrapper** — the bundled `bin/pi-dev` (see below), or any executable named
  through the `command` config field (default `~/.dsh/bin/pi-dev`).

### The `pi-dev` contract

The plugin knows nothing about Pi's arguments; it only knows this contract:

| Part | Meaning |
| --- | --- |
| `--brief <file>` | Path to the brief. Always passed. The file holds the task text. |
| `--cwd <dir>` | Working directory for the child. Always passed; also the child's process cwd. |
| `--log <file>` | Full-output log file. Always passed; the parent directory may not exist yet. |
| `--model <name>` | Optional, passed only when configured. |
| `--thinking <level>` | Optional, passed only when configured. |
| `--tools <list>` | Optional, passed only when configured. |
| `--mode <text\|json>` | Passed as `--mode json` while session projection is on (the default) and the wrapper's own `--help` advertises the flag. No `--mode` is passed when projection is off or the help text does not mention it, so the wrapper keeps its text behaviour (see [Session projection](#session-projection)). |
| `--help` | Probed once per projected run (stdin ignored, short timeout) to decide whether `--mode json` is safe to pass. |
| `--approve` | Optional, passed only when configured. |
| anything else | `config.args`, appended last, verbatim. |
| **stdout** | The final answer. DSH returns it to the parent agent as the subagent output. |
| **exit code** | `0` means success (`completed`). Anything else means `error`, and stderr becomes the diagnostic (tail-kept within 4096 bytes). |
| **stderr** | Free-form progress and errors; never treated as the answer. |

A minimal wrapper that satisfies the contract:

```bash
#!/usr/bin/env bash
# ~/.dsh/bin/pi-dev — one Pi run per delegation.
set -euo pipefail

PI_BIN=${PI_BIN:-pi}
brief="" cwd="$PWD" log=""
model="" thinking="" tools="" mode="text" approve=0

while [ $# -gt 0 ]; do
  case "$1" in
    --brief)    brief=$2; shift 2 ;;
    --cwd)      cwd=$2; shift 2 ;;
    --log)      log=$2; shift 2 ;;
    --model)    model=$2; shift 2 ;;
    --thinking) thinking=$2; shift 2 ;;
    --tools)    tools=$2; shift 2 ;;
    --mode)     mode=$2; shift 2 ;;
    --approve)  approve=1; shift ;;
    *) echo "pi-dev: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$brief" ] || { echo "pi-dev: --brief is required" >&2; exit 2; }

args=(--print --no-session)
[ "$mode" = text ] || args+=(--mode "$mode")
[ -n "$tools" ] && args+=(--tools "$tools")
[ -n "$model" ] && args+=(--model "$model")
[ -n "$thinking" ] && args+=(--thinking "$thinking")
[ "$approve" = 1 ] && args+=(--approve)

prompt=$(cat "$brief")
cd "$cwd"

if [ -n "$log" ]; then
  mkdir -p "$(dirname "$log")"
  set +e
  "$PI_BIN" "${args[@]}" "$prompt" 2>&1 | tee "$log"
  exit "${PIPESTATUS[0]}"
fi

exec "$PI_BIN" "${args[@]}" "$prompt"
```

Add whatever your own workflow needs on top — rules, a state directory, a model pin. Keep
the contract above intact and the plugin needs no change. A wrapper that does not
advertise `--mode` in its `--help` (or ignores the flag and prints plain text) still works:
the plugin runs it in text mode, keeps the whole stdout as the answer, and degrades the
projection (see [Session projection](#session-projection)).

### Bundled `pi-dev` wrapper

`bin/pi-dev` is a portable copy of the wrapper this plugin was developed against.
`package.json` declares it as a bin, so a package manager that installs this package links
it as `pi-dev`. It keeps the contract above (including `--mode text|json`) and adds the
author's workflow:

- a throwaway `PI_CODING_AGENT_DIR` per run, so `~/.pi` is never touched;
- the DeepSeek key from `$HOME/.pi/agent/auth.json` placed in `DEEPSEEK_API_KEY` (never
  printed; an existing `DEEPSEEK_API_KEY` wins), with a `pi auth login deepseek` hint when
  it is missing;
- `rules/PI-DEV-RULES.md` prepended to the brief — these are the author's own working
  rules, not something the plugin needs; if you use your own wrapper or do not want them,
  ignore that file and this wrapper;
- `deepseek-flash` pinned as the model, `--no-session`, and a default tool list;
- `--mode text|json` passed through to Pi: `text` is the default and adds no `--mode` at
  all, `json` makes Pi emit its NDJSON event stream (what the plugin asks for while
  projection is on);
- `--log` tee'ing the full output;
- one line per run appended to the delegation record
  (`${PI_DEV_RECORD_DIR:-$HOME/.dsh}/pi-delegations.log`);
- the child's exit code passed through unchanged.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_BIN` | `pi` (from `PATH`) | The Pi executable to run. |
| `PI_DEV_RULES` | `<wrapper's real dir>/../rules/PI-DEV-RULES.md` | Fixed rules file to prepend (symlinks to the wrapper are resolved first). |
| `PI_DEV_RECORD_DIR` | `$HOME/.dsh` | Directory for `pi-delegations.log`. |
| `PI_DEV_MODEL` | `deepseek-flash` | Default model pin. |

The plugin's default `command` is still `$HOME/.dsh/bin/pi-dev`. To use the bundled
wrapper, either copy it there or symlink it (the wrapper resolves its own real path, so
the bundled `rules/PI-DEV-RULES.md` is still found) or point `command` at the bundled path, for example
`<...>/node_modules/dsh-subagent-pi/bin/pi-dev`. If you already have your own `pi-dev`,
point `command` at that instead; the contract above is all the plugin needs.

## Install

This package is a DSH bundle: `package.json` declares
`dsh.bundle.patch = ./cordis.patch.yml`, so installing the package is enough — the patch
mounts the plugin, which registers the `pi` tool and projects child sessions, and it shows
up as a card under **Plugins → Installed** in the web app.

```bash
# from GitHub
dsh plugin --profile web add git+https://github.com/A1311981684/dsh-subagent-pi.git

# from a local checkout
dsh plugin --profile web add file:/path/to/dsh-subagent-pi
```

Or add it to the profile manifest `~/.dsh/profiles/<name>/package.json` and let the profile
resolve it from its own `node_modules`:

```json
{
  "dependencies": {
    "dsh-subagent-pi": "git+https://github.com/A1311981684/dsh-subagent-pi.git"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-subagent-pi"]
    }
  }
}
```

After installing, restart DSH (or let HMR reload). The model gains a `pi` tool. No extra
environment variable is needed as long as `pi-dev` can find Pi's credentials itself.

If you would rather compose the rows by hand — for example to set config values — add them
to the profile's own `cordis.patch.yml`. One row is enough; the plugin registers its own
`pi` tool, so nothing from `@deepseek-ai/dsh-tool-subagent` is needed:

```yaml
- insert:
    - id: subagent-pi
      name: dsh-subagent-pi
      config:
        # command: /usr/local/bin/pi-dev
        # model: deepseek-flash
        # tools: read,bash,edit,write,grep,find,ls
        # logDir: /home/me/.dsh/pi-logs
        # graceMs: 5000
        # projection: true
```

## Configuration

All fields are optional; the bundle patch passes none of them.

| Field | Default | Description |
| --- | --- | --- |
| `command` | `$HOME/.dsh/bin/pi-dev` | The wrapper to execute. Set it when yours lives elsewhere. |
| `args` | `[]` | Extra arguments appended after everything else. |
| `model` | — | When set, passed as `--model`; otherwise the wrapper decides. |
| `thinking` | — | When set, passed as `--thinking`. |
| `tools` | — | When set, passed as `--tools`. |
| `approve` | `false` | When `true`, passes `--approve`. |
| `projection` | `true` | Project each run into a DSH child session. `false` skips the projection entirely and passes no `--mode` to the wrapper. |
| `logDir` | `$HOME/.dsh/pi-logs` | Where logs go, named `<YYYYMMDD-HHmmss>-<id 8 chars>.log`. |
| `graceMs` | `5000` | SIGTERM → SIGKILL grace for a cancelled child. |
| `maxOutputBytes` | `262144` | In-memory cap per collected stream (stdout and stderr separately); the tail is kept. |

Validation happens at mount time, so a bad value is a load error rather than a surprise on
the first delegation: `graceMs` and `maxOutputBytes` must be positive finite numbers,
`command` and `logDir` must be non-empty strings, `args` must be an array of strings, and
`approve`/`projection` must be booleans.

## Session projection

Every delegation also produces a real DSH child session (phase 2: live, streamed
projection). The child is created in the calling agent's session *first*, then Pi is
started, and each JSON record is projected as it arrives:

1. `sessions.prepare(childId, { meta })` with the child's `cwd`, `parentSession`, `origin:
   'subagent'`, and `delegationDepth` (the parent's depth + 1), then
   `sessionPersistence.create(session.header, { inheritedEventCount: 0 })`, the
   pre-publication suffix, `enter`, and `announce` — the same order `dsh-agent-loop` uses;
2. the child's opening events, still before the process exists: `turn/start` (DSH turn 1),
   `subagent/descriptor` (version 3, `mode: 'one-shot'`, `provider: 'pi'`, the label), and
   the task text as `user/message`; the parent's `subagent/catalog` row (version 0) follows
   immediately, so the child is listed while Pi works;
3. stdout is parsed line by line (a partial line is buffered; a line over 2 MiB is dropped
   with a warning) and each record becomes one event:
   - `turn_start` opens a new step (`step/start`) — one Pi turn is one model call, so it maps
     to a DSH **step**, not a DSH turn;
   - an assistant `message_end` appends `assistant/message` inside the current step, with
     `thinking` mapped to `reasoning` blocks, text kept, `toolCall` mapped to `tool-call`
     (its arguments serialized once to the raw JSON string DSH stores), the step's `usage`,
     and an empty `stream`; every advertised `tool-call` is then answered by a `tool/call`
     carrying the *identical* argument string;
   - `tool_execution_end` appends `tool/result` with the tool's text (or its serialized
     structured content), `isError` passed through, on the surface;
   - `turn_end` closes the step — any call still pending gets an error result first, so a
     step never closes with an unresolved call;
   - `agent_end`/`agent_settled` just mark the run's abort flag; the `turn/end` with the real
     reason (`completed`, `aborted`, or `error`) is appended once the child exits;
4. both sessions are flushed, the child is detached, and its write handle is released — so
   nothing synthetic stays "running" and DSH reads the log back as read-only history.

The order is not cosmetic: the durable log is relationship-checked when it is restored. A
`step/end` is rejected while an advertised `tool/call` has no `tool/result`, a `turn/end` is
rejected while a step is open, `tool/call` arguments must equal the `tool-call` block's
string exactly, and `step` numbers must run 1, 2, 3… inside the open turn. Normal end,
failure, and cancellation all funnel through the same finalizer, so the log always has
matched brackets and a `turn/end`.

What you can see: the child row in DSH's subagent list from the moment the task starts, and
when you open it, the task text, Pi's reasoning and replies, the tool calls with their
arguments and results, each step's token usage (`inputTokens`/`outputTokens` plus the
cache/reasoning counters Pi reported), real timestamps/durations, and how the run ended.
Because the log is durable, this survives a DSH restart.

Still **not** in this phase:

- **no live running state and no Stop button in the UI** — events stream into the log and
  the row appears immediately, but the web UI does not yet show a spinner or offer a stop
  control for the running child (phase 3).

**Degradation.** The projection is best-effort and never affects the delegation:

- `--mode` support is detected up front by running `pi-dev --help` once (stdin ignored,
  short timeout); a wrapper whose help does not mention `--mode` is run in **text mode**:
  the projection gets the task text, one assistant message holding the whole stdout, and the
  end state, still with real timestamps. A run is never attempted twice;
- if `sessions`/`sessionPersistence` is missing, or `prepare`/`create`/the opening appends
  are rejected, the plugin logs one `warn` and returns the result with an empty
  `childSessionId`;
- if an append is rejected mid-run, the plugin logs one `warn`, stops projecting further
  content, and still appends the structural closers (`step/end`, `turn/end`) so the stored
  log is not left with an open bracket;
- if JSON mode was requested but the wrapper printed plain text anyway, the whole stdout
  becomes the single assistant message and the projection still records the prompt and the
  end state;
- a tool result whose call was never advertised is skipped with a `warn`; a line over the
  2 MiB cap is dropped with a `warn`.

## Behavior details

- **One `pi` tool.** The plugin registers it at mount time; the description tells the model
  it delegates to the local Pi agent and that a child session is created. Parameters are
  `prompt` (required), `cwd` (optional; defaults to the calling session's working
  directory), and `label` (optional; defaults to the first line of `prompt`, at most 60
  characters).
- **The tool value** is `{ output, childSessionId, logPath, stopReason }` (plus
  `diagnostic` when the run failed). The model sees the final answer, an optional
  diagnostic, a `subagent session: <id>` line, and a `full output: <log path>` line.
- **Result mapping.** Exit code `0` → `stopReason: 'completed'`. Any other exit code →
  `'error'`, with `diagnostic` set to `pi-dev exit code N` plus the tail of stderr, capped
  at 4096 bytes. Cancellation through `exec.signal` → `'aborted'` after SIGTERM (and
  SIGKILL after `graceMs`), keeping whatever output was collected. A spawn failure is an
  `'error'` result, never a thrown tool.
- **The final answer** is the text of the last non-empty assistant message Pi reported. If
  no structured record parses, it is the whole stdout (trailing whitespace trimmed).
- **Each run is isolated.** Every run gets its own scratch directory, its own child-session
  id, and its own process state, so concurrent runs cannot observe each other.
- **The scratch directory is always removed**, even when the run fails. It holds the brief,
  which contains the task text; the tee'd log stays in `logDir` because it is the pointer
  returned to the model.

## Development and testing

```bash
git clone <repo> && cd dsh-subagent-pi
node --check lib/index.js
bash -n bin/pi-dev
node --test test/            # 26 unit tests, all green, no network and no model call
node test/real-pi.mjs        # opt-in: one real pi-dev run, costs a model call
```

- `test/tool.test.js` mounts the plugin on a fake `ctx` (`tools.register`, `sessions`,
  `sessionPersistence`, `logger`) and runs real child processes: `test/fake-pi-dev.mjs` is
  copied into the scratch root as the configured `command` and reads its
  `FIXTURE`/`RECORD` directives from the brief, so every test controls the child's stdout,
  stderr, exit code, and timing while the plugin's argv, brief, and child-session events are
  asserted exactly. Covered: tool registration and schema, argv building, argument and
  `cwd` validation, the `--help` capability probe (JSON vs. text mode), the streamed
  projection event order and payloads (descriptor v3, catalog v0 strict keys, step
  brackets, reasoning/text/tool-call blocks, `tool/call`/`tool/result` pairing and argument
  identity, usage mapping, `stream: []`), multi-turn step numbering, plain-text and
  empty-stdout degradation, error/abort end states (including a pending call resolved on
  cancel), SIGKILL escalation, missing-service and rejected-append degradation, an
  oversized line, concurrent runs, config validation, HOME-derived defaults, and
  scratch-directory cleanup.
- `test/real-pi.mjs` is the manual end-to-end check: a real `pi-dev` run whose brief asks
  for one line of text with `--tools read` and no file changes. It has no DSH container, so
  it also exercises the "projection unavailable → warn and continue" path. It exits as a
  no-op when `NODE_TEST_CONTEXT` is set, so `node --test` never spends a model call on it.
- `test/index.js` exists only so the documented `node --test test/` command works on Node
  versions that resolve a positional argument as a module instead of searching the
  directory. The equivalent form is `node --test test/*.test.js`.
- `.github/workflows/test.yml` runs the syntax check and the unit tests on Node 22 and 24.

## License

[MIT](LICENSE) © 2026 Asta Zhao
