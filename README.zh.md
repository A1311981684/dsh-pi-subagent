# dsh-subagent-pi

[English](README.md) | 中文

把本机的 [Pi](https://pi.dev) 编码 agent 接成 DSH（DeepSeek Harness）的外部子智能体后端。
装了它，DSH 的模型就能像调用官方的 Codex / Claude Code 子智能体一样，把一项开发任务派给 Pi，
再拿回它的输出。

每次派活起一个 `pi-dev` 子进程。插件在 `ctx.subagents` 里注册的名字是 `pi`，
模型看到的工具名也是 `pi`。

## 薄壳：只做四件事

进程里跑的是 `pi-dev`。怎么跑 Pi，全由它自己决定：

1. 每次一个临时 `PI_CODING_AGENT_DIR`，不碰 `~/.pi`；
2. 从 Pi 自己的 `auth.json` 取凭据放进环境变量，不打印；
3. 把固定规矩拼在任务说明前面；
4. 钉住模型（默认 `deepseek-flash`）；
5. 加 `--no-session`，派活不留会话；
6. 用 `--log` 把完整输出复制一份到文件；
7. 跑完往派活记录里追加一行。

插件自己只做子智能体接口要求的那点事：

1. 校验请求（`cwd` 必须是已存在的绝对路径，`prompt` 只能是 text 块）；
2. 把 text 块拼成任务说明，写进临时目录；
3. 用 `ctx.subprocess.spawn` 起 `pi-dev`，等它退出，把退出结果映射成 `SubagentResult`；
4. `dispose()` 时取消、等进程收干净、删掉临时目录。

插件不 import 任何 `@deepseek-ai/*` 包，也没有运行时依赖，只用 `node:` 内置模块。
`subagents` 和 `subprocess` 由 DSH 注入，插件自己不起任何进程。

## 要求

- **Node.js** `^22.19.0 || >=24.0.0`，**DSH** `>= 0.2.2-rc.1`。
- 本机装了 **Pi CLI**，能当 `pi` 用（或通过 `PI_BIN` 指定）。
- 有一个 **`pi-dev` 封装**：可以用下面自带的 `bin/pi-dev`，也可以用任意可执行文件；
  默认找 `~/.dsh/bin/pi-dev`，放别处就配 `command`。

### `pi-dev` 的契约

插件不懂 Pi 的参数，只认这份契约：

| 部分 | 含义 |
| --- | --- |
| `--brief <文件>` | 任务说明文件，总会传。 |
| `--cwd <目录>` | 工作目录，总会传；子进程也在这个目录下跑。 |
| `--log <文件>` | 完整输出日志，总会传。上级目录可能还不存在。 |
| `--model <名字>` | 可选，配了才传。 |
| `--thinking <档位>` | 可选，配了才传。 |
| `--tools <工具表>` | 可选，配了才传。 |
| `--approve` | 可选，配了才传。 |
| 其它参数 | 配的 `args`，原样追加在最后。 |
| **stdout** | 最终回答，DSH 把它当作子智能体的输出交给上层。 |
| **退出码** | `0` 算成功（`completed`）；非 0 算 `error`，stderr 变成诊断信息（只留尾部，4096 字节以内）。 |
| **stderr** | 进度和报错，不当回答用。 |

满足这份契约的最小封装：

```bash
#!/usr/bin/env bash
# ~/.dsh/bin/pi-dev —— 每次派活跑一次 Pi。
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
    *) echo "pi-dev: 不认识的参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "$brief" ] || { echo "pi-dev: 缺少 --brief" >&2; exit 2; }

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

想加固定规矩、临时状态目录、模型钉死之类的东西，都加在这个封装里。只要上面这份契约不变，
插件就不用改。

### 自带 `pi-dev` 封装

`bin/pi-dev` 是作者本机那套封装的便携版。`package.json` 把它声明成 bin，包管理器安装
这个包时会把它链接成 `pi-dev` 命令。它保持上面的契约，另外做了这些事：

- 每次运行一个临时 `PI_CODING_AGENT_DIR`，不碰 `~/.pi`；
- 从 `$HOME/.pi/agent/auth.json` 取 DeepSeek key 放进 `DEEPSEEK_API_KEY`（不打印；
  环境里已经有了就用环境里的），没有就提示先跑 `pi auth login deepseek`；
- 把 `rules/PI-DEV-RULES.md` 拼在任务说明前面——这是作者自己的固定规矩，插件本身
  不需要它；用别的封装或者不想要这份规矩，忽略这个文件和这个封装即可；
- 钉住 `deepseek-flash` 模型、加 `--no-session`、给一份默认工具表；
- 传 `--log` 时用 `tee` 复制完整输出；
- 每次运行往派活记录 `${PI_DEV_RECORD_DIR:-$HOME/.dsh}/pi-delegations.log` 追加一行；
- 退出码原样透传。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_BIN` | `pi`（走 `PATH`） | 要跑的 Pi 可执行文件。 |
| `PI_DEV_RULES` | `<封装真实目录>/../rules/PI-DEV-RULES.md` | 拼在任务说明前的固定规矩（先解析封装自己的软链）。 |
| `PI_DEV_RECORD_DIR` | `$HOME/.dsh` | 派活记录目录，写 `pi-delegations.log`。 |
| `PI_DEV_MODEL` | `deepseek-flash` | 默认钉住的模型。 |

插件的默认 `command` 仍然是 `$HOME/.dsh/bin/pi-dev`。想用自带封装，就把它复制到这个位置
（或者建软链——封装会先把自己的软链解析成真实路径，包里的 `rules/PI-DEV-RULES.md` 照样
找得到），或者把
`command` 指到包里的 `bin/pi-dev`（例如 `<...>/node_modules/dsh-subagent-pi/bin/pi-dev`）。
你自己已经有 `pi-dev` 的话，把 `command` 指向它就行，插件只认上面那份契约。

## 安装

这个包是 DSH bundle：`package.json` 里声明了 `dsh.bundle.patch = ./cordis.patch.yml`。
装上包就够了，patch 会把后端和工具一起挂上，网页「插件 → 已安装插件」里也会出现它的卡片。

```bash
# 从 GitHub 装
dsh plugin --profile web add git+https://github.com/A1311981684/dsh-subagent-pi.git

# 从本地目录装
dsh plugin --profile web add file:/path/to/dsh-subagent-pi
```

也可以把它写进 profile 的 `~/.dsh/profiles/<名字>/package.json`，让 profile 从自己的
`node_modules` 里找：

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

装完重启 DSH（或者等 HMR 重载），模型就多了一个 `pi` 工具。
只要 `pi-dev` 自己能找到 Pi 的凭据，就不需要额外的环境变量。

想自己手写挂载、顺手配几个参数，就把下面这段加到 profile 的 `cordis.patch.yml`：

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

## 配置

所有配置项都可以不填，bundle patch 一个都不传。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `providerName` | `pi` | 注册到 `ctx.subagents` 的名字，要和 `tool-subagent` 的 `provider` 一致。 |
| `command` | `$HOME/.dsh/bin/pi-dev` | 要跑的封装。放别处就改这里。 |
| `args` | `[]` | 追加在最后的额外参数。 |
| `model` | — | 填了就传 `--model`；不填由封装自己决定。 |
| `thinking` | — | 填了就传 `--thinking`。 |
| `tools` | — | 填了就传 `--tools`。 |
| `approve` | `false` | 为 `true` 就传 `--approve`。 |
| `logDir` | `$HOME/.dsh/pi-logs` | 日志放这里，文件名是 `<YYYYMMDD-HHmmss>-<id 前 8 位>.log`。 |
| `graceMs` | `5000` | 终止宽限期，传给子进程服务的 SIGTERM → SIGKILL 阶梯。 |
| `maxOutputBytes` | `262144` | 单条输出（stdout 和 stderr 各算一条）在内存里的上限，超了留尾部。 |

配置在挂载时就检查，配错当场报错，不会拖到第一次派活。规则：`graceMs` 和
`maxOutputBytes` 必须是正有限数，`command`、`providerName`、`logDir` 必须是非空字符串，
`args` 必须是字符串数组，`approve` 必须是布尔。

## 行为细节

- **四个能力标志都是 `false`**：外部进程拿不到父上下文的 agent 选项、预设、输出 schema
  和深度限制，所以 `capabilities` 全是 `false`，`inheritsParentContext` 也是 `false`。
  需要这些能力的请求，DSH 会在开跑前就拒掉，而不是收下再忽略。
- **只收 text 块**：text 块按顺序用空行拼起来。碰到图片之类的非 text 块直接报错——
  `pi-dev` 只接一份文字说明，默默丢掉更糟。
- **结果怎么映射**：退出码 `0` → `completed`。别的退出码 → `error`，`diagnostic` 是
  `pi-dev exit code N` 加 stderr 尾部，整体不超过 4096 字节。被取消（请求信号或
  `dispose()`）→ `aborted`，已经收到的输出照留。插件内部异常一律变成 `error`。
  `result` 不会 reject。
- **输出最后固定多一条** `[full pi-dev output] <日志路径>`，事后直接翻日志。
- **每次派活互不干扰**：每个 run 有自己的临时目录和状态，并发跑也不会串。
- **`dispose()` 可以重复调用**：先 `terminate()`，再 `waitForExit()`，最后删临时目录。
  任务说明里可能有业务内容，所以用完就删，不留着。

## 开发与自测

```bash
git clone <repo> && cd dsh-subagent-pi
node --check lib/index.js
bash -n bin/pi-dev
node --test test/            # 18 个单元测试，全绿，不联网、不花模型调用
node test/real-pi.mjs        # 手动跑：一次真 pi-dev，会花一次模型调用
```

- `test/provider.test.js` 用假 `ctx.subprocess` 测：argv 拼装、退出码 0/2、诊断截断、
  取消触发 `terminate`、非 text 块报错、`cwd` 校验、并发隔离、配置校验、临时目录清理。
- `test/real-pi.mjs` 是手动端到端：用真 `pi-dev` 跑一条「只回一行字」的短任务，
  传 `--tools read`，说明里明确不许改文件。`NODE_TEST_CONTEXT` 已设置时它直接跳过，
  所以 `node --test` 不会白花一次模型调用。
- `test/index.js` 只是入口。有些 Node 版本把 `node --test` 后面的位置参数当模块路径，
  不写成它就跑不到测试。等价写法是 `node --test test/*.test.js`。
- `.github/workflows/test.yml` 在 Node 22 和 24 上跑语法检查和单元测试。

## 许可

[MIT](LICENSE) © 2026 Asta Zhao
