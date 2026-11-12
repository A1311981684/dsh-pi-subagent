# dsh-subagent-pi

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) bundle that turns a local
[Pi](https://pi.dev) coding agent into an out-of-process **subagent backend**. DSH's model
can hand a development task to Pi the same way it hands one to the official Codex or
Claude Code subagents, and gets Pi's answer back as an ordinary subagent result.

The provider runs one `pi-dev` child per delegation. It is registered under the name `pi`
and exposed to the model as the `pi` tool by
[`@deepseek-ai/dsh-tool-subagent`](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-subagent).

## The thin shell

The plugin deliberately owns almost nothing. Everything that decides *how* Pi runs stays
inside the `pi-dev` wrapper:

1. a throwaway `PI_CODING_AGENT_DIR` per run, so `~/.pi` is never touched;
2. the credential handoff from Pi's own `auth.json` into the environment (never printed);
3. the fixed rules prepended to every brief;
4. the pinned model (`deepseek-flash` by default);
5. `--no-session`, so delegations leave no session behind;
6. `--log` tee'ing the full output to a file;
7. one line appended to the delegation record after every run.

The plugin only does what the subagent seam demands of an external backend:

1. validate the request (`cwd` must be an existing absolute path, `prompt` may hold text
   blocks only);
2. join the text blocks into a brief and write it to a scratch directory;
3. spawn `pi-dev` through `ctx.subprocess.spawn`, wait for the exit facts, map them onto a
   `SubagentResult`;
4. on `dispose()`: cancel, wait for the process range to drain, remove the scratch
   directory.

It imports no `@deepseek-ai/*` package and has no runtime dependencies — only `node:`
built-ins. DSH injects the `subagents` and `subprocess` services; the plugin starts no
process by itself.

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
model="" thinking="" tools="" approve=0

while [ $# -gt 0 ]; do
  case "$1" in
    --brief)    brief=$2; shift 2 ;;
    --cwd)      cwd=$2; shift 2 ;;
    --log)      log=$2; shift 2 ;;
    --model)    model=$2; shift 2 ;;
    --thinking) thinking=$2; shift 2 ;;
    --tools)    tools=$2; shift 2 ;;
    --approve)  approve=1; shift ;;
    *) echo "pi-dev: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$brief" ] || { echo "pi-dev: --brief is required" >&2; exit 2; }

args=(--print --no-session)
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
the contract above intact and the plugin needs no change.

### Bundled `pi-dev` wrapper

`bin/pi-dev` is a portable copy of the wrapper this plugin was developed against.
`package.json` declares it as a bin, so a package manager that installs this package links
it as `pi-dev`. It keeps the contract above and adds the author's workflow:

- a throwaway `PI_CODING_AGENT_DIR` per run, so `~/.pi` is never touched;
- the DeepSeek key from `$HOME/.pi/agent/auth.json` placed in `DEEPSEEK_API_KEY` (never
  printed; an existing `DEEPSEEK_API_KEY` wins), with a `pi auth login deepseek` hint when
  it is missing;
- `rules/PI-DEV-RULES.md` prepended to the brief — these are the author's own working
  rules, not something the plugin needs; if you use your own wrapper or do not want them,
  ignore that file and this wrapper;
- `deepseek-flash` pinned as the model, `--no-session`, and a default tool list;
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
mounts the provider and the tool together, and the plugin shows up as a card under
**Plugins → Installed** in the web app.

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
to the profile's own `cordis.patch.yml`:

```yaml
- insert:
    - id: subagent-pi
      name: dsh-subagent-pi
      config:
        providerName: pi
        # command: /usr/local/bin/pi-dev
        # model: deepseek-flash
        # tools: read,bash,edit,write,grep,find,ls
        # logDir: /home/me/.dsh/pi-logs
        # graceMs: 5000
    - id: tool-subagent-pi
      name: "@deepseek-ai/dsh-tool-subagent"
      config:
        provider: pi
        toolName: pi
        maxDepth: provider-managed
```

## Configuration

All fields are optional; the bundle patch passes none of them.

| Field | Default | Description |
| --- | --- | --- |
| `providerName` | `pi` | Name registered with `ctx.subagents`. Keep it equal to `tool-subagent`'s `provider`. |
| `command` | `$HOME/.dsh/bin/pi-dev` | The wrapper to execute. Set it when yours lives elsewhere. |
| `args` | `[]` | Extra arguments appended after everything else. |
| `model` | — | When set, passed as `--model`; otherwise the wrapper decides. |
| `thinking` | — | When set, passed as `--thinking`. |
| `tools` | — | When set, passed as `--tools`. |
| `approve` | `false` | When `true`, passes `--approve`. |
| `logDir` | `$HOME/.dsh/pi-logs` | Where logs go, named `<YYYYMMDD-HHmmss>-<id 8 chars>.log`. |
| `graceMs` | `5000` | SIGTERM → SIGKILL grace handed to the subprocess service. |
| `maxOutputBytes` | `262144` | In-memory cap per collected stream (stdout and stderr separately); the tail is kept. |

Validation happens at mount time, so a bad value is a load error rather than a surprise on
the first delegation: `graceMs` and `maxOutputBytes` must be positive finite numbers,
`command`, `providerName`, and `logDir` must be non-empty strings, `args` must be an array
of strings, `approve` must be a boolean.

## Behavior details

- **Every capability is `false`.** An external process has no access to the parent's agent
  options, presets, output schema, or depth limit, so `capabilities` reports all four as
  `false` and `inheritsParentContext` is `false`. DSH rejects requests that need them up
  front instead of silently ignoring them.
- **Text blocks only.** Text blocks are joined in order with a blank line between them. A
  non-text block (an image, say) is a hard error: `pi-dev` takes one text brief, and
  dropping content silently would be worse.
- **Result mapping.** Exit code `0` → `stopReason: 'completed'`. Any other exit code →
  `'error'`, with `diagnostic` set to `pi-dev exit code N` plus the tail of stderr, capped
  at 4096 bytes. Cancellation through the request signal or `dispose()` → `'aborted'`,
  keeping whatever output was collected. An internal exception becomes `'error'`. The
  `result` promise never rejects.
- **The output always ends with** a `[full pi-dev output] <log path>` text block, so the
  full log is one path lookup away.
- **Each run is isolated.** Every run gets its own scratch directory and its own closure
  state, so concurrent runs cannot observe each other's cancellation or cleanup.
- **`dispose()` is idempotent**: `terminate()`, then `waitForExit()`, then remove the
  scratch directory. The brief contains no secrets, but it does contain the task text, so
  it is deleted rather than kept.

## Development and testing

```bash
git clone <repo> && cd dsh-subagent-pi
node --check lib/index.js
bash -n bin/pi-dev
node --test test/            # 18 unit tests, all green, no network and no model call
node test/real-pi.mjs        # opt-in: one real pi-dev run, costs a model call
```

- `test/provider.test.js` drives the plugin through a fake `ctx.subprocess`: argv building,
  exit codes 0/2, diagnostic truncation, abort → `terminate`, non-text prompt rejection,
  `cwd` validation, per-run isolation, config validation, scratch-directory cleanup.
- `test/real-pi.mjs` is the manual end-to-end check: a real `pi-dev` run whose brief asks
  for one line of text with `--tools read` and no file changes. It exits as a no-op when
  `NODE_TEST_CONTEXT` is set, so `node --test` never spends a model call on it.
- `test/index.js` exists only so the documented `node --test test/` command works on Node
  versions that resolve a positional argument as a module instead of searching the
  directory. The equivalent form is `node --test test/*.test.js`.
- `.github/workflows/test.yml` runs the syntax check and the unit tests on Node 22 and 24.

## License

[MIT](LICENSE) © 2026 Asta Zhao
