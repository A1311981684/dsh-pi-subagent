# dsh-subagent-pi

[English](README.md) | 中文

把本机的 [Pi](https://pi.dev) 编码 agent 接成 DSH（DeepSeek Harness）里**可查看过程的子智能体**。
装了它，DSH 的模型就能像调用官方的 Codex / Claude Code 子智能体一样，把一项开发任务派给 Pi，
拿回它的最终回答；事后还能在 DSH 的子智能体目录里点开这次派活，看到任务原文、Pi 的回复
（含 token 用量）和结束状态。

插件自己注册 `pi` 工具（不再需要
[`@deepseek-ai/dsh-tool-subagent`](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-subagent)），
每次调用起一个 `pi-dev` 子进程。子进程跑的时候插件收集 Pi 的结构化 JSON 事件；跑完以后把
这些事件投影成一个真实的 DSH 子会话，并在父会话里追加一条目录记录，于是子会话出现在
子智能体目录里、能点开、是只读历史。

## 薄壳：只做两件事

怎么跑 Pi，插件几乎不管，全由 `pi-dev` 决定：

1. 每次一个临时 `PI_CODING_AGENT_DIR`，不碰 `~/.pi`；
2. 从 Pi 自己的 `auth.json` 取凭据放进环境变量，不打印；
3. 把固定规矩拼在任务说明前面；
4. 钉住模型（默认 `deepseek-flash`）；
5. 加 `--no-session`，派活不留 Pi 会话；
6. 用 `--log` 把完整输出复制一份到文件；
7. 跑完往派活记录里追加一行。

插件自己只做两件事：

1. **跑这次派活**：校验参数，把任务说明写进临时目录，直接起 `pi-dev`（用 `node:child_process`，
   不依赖子进程服务），按上限收集 stdout/stderr，取消时先 SIGTERM、宽限期后 SIGKILL，
   最终回答取 Pi 最后一条非空助手消息；
2. **投影这次运行**：创建一个真实的 DSH 子会话（`sessions.prepare` +
   `sessionPersistence.create` + `enter`/`announce`），追加子智能体描述符、用户提示、
   助手回复（文本 + token 用量）和轮次结束，再往父会话追加 `subagent/catalog` 目录记录，
   最后 flush 两个会话并释放子会话。

插件不 import 任何 `@deepseek-ai/*` 包，也没有运行时依赖，只用 `node:` 内置模块。
`tools`、`sessions`、`sessionPersistence` 由 DSH 注入。投影每一步都是尽力而为：服务缺失或
追加被拒时只记一条 warn，派活结果照常返回。

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
| `--mode <text\|json>` | 投影开启（默认）时传 `--mode json`；投影关闭时不传 `--mode`，封装保持纯文本行为。 |
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
    *) echo "pi-dev: 不认识的参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "$brief" ] || { echo "pi-dev: 缺少 --brief" >&2; exit 2; }

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

想加固定规矩、临时状态目录、模型钉死之类的东西，都加在这个封装里。只要上面这份契约不变，
插件就不用改。不认识 `--mode json`（或者忽略它、只打纯文本）的封装也能用：插件会把整段
stdout 当回答，投影自动降级（见「会话投影」）。

### 自带 `pi-dev` 封装

`bin/pi-dev` 是作者本机那套封装的便携版。`package.json` 把它声明成 bin，包管理器安装
这个包时会把它链接成 `pi-dev` 命令。它保持上面的契约（包括 `--mode text|json`），另外做了这些事：

- 每次运行一个临时 `PI_CODING_AGENT_DIR`，不碰 `~/.pi`；
- 从 `$HOME/.pi/agent/auth.json` 取 DeepSeek key 放进 `DEEPSEEK_API_KEY`（不打印；
  环境里已经有了就用环境里的），没有就提示先跑 `pi auth login deepseek`；
- 把 `rules/PI-DEV-RULES.md` 拼在任务说明前面——这是作者自己的固定规矩，插件本身
  不需要它；用别的封装或者不想要这份规矩，忽略这个文件和这个封装即可；
- 钉住 `deepseek-flash` 模型、加 `--no-session`、给一份默认工具表；
- 把 `--mode text|json` 透传给 Pi：默认 `text` 完全不传 `--mode`，`json` 让 Pi 输出 NDJSON
  事件流（投影开启时插件要的就是这个）；
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
装上包就够了，patch 会把插件挂上——它自己注册 `pi` 工具、自己投影子会话，网页
「插件 → 已安装插件」里也会出现它的卡片。

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

想自己手写挂载、顺手配几个参数，就把下面这段加到 profile 的 `cordis.patch.yml`。
一行就够：插件自己注册 `pi` 工具，不再需要 `@deepseek-ai/dsh-tool-subagent`。

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

## 配置

所有配置项都可以不填，bundle patch 一个都不传。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `command` | `$HOME/.dsh/bin/pi-dev` | 要跑的封装。放别处就改这里。 |
| `args` | `[]` | 追加在最后的额外参数。 |
| `model` | — | 填了就传 `--model`；不填由封装自己决定。 |
| `thinking` | — | 填了就传 `--thinking`。 |
| `tools` | — | 填了就传 `--tools`。 |
| `approve` | `false` | 为 `true` 就传 `--approve`。 |
| `projection` | `true` | 把每次派活投影成 DSH 子会话。`false` 完全不投影，也不给封装传 `--mode`。 |
| `logDir` | `$HOME/.dsh/pi-logs` | 日志放这里，文件名是 `<YYYYMMDD-HHmmss>-<id 前 8 位>.log`。 |
| `graceMs` | `5000` | 取消子进程时的 SIGTERM → SIGKILL 宽限期（毫秒）。 |
| `maxOutputBytes` | `262144` | 单条输出（stdout 和 stderr 各算一条）在内存里的上限，超了留尾部。 |

配置在挂载时就检查，配错当场报错，不会拖到第一次派活。规则：`graceMs` 和
`maxOutputBytes` 必须是正有限数，`command`、`logDir` 必须是非空字符串，`args` 必须是
字符串数组，`approve`/`projection` 必须是布尔。

## 会话投影

每次派活除了返回结果，还会在 DSH 里生成一个真实的子会话（投影第 1 期）。工具会在调用它的
agent 的会话里创建这个子会话，把 Pi 的这次运行写进去，再给父会话加一条目录记录：

1. `sessions.prepare(childId, { meta })`，meta 带子会话的 `cwd`、`parentSession`、
   `origin: 'subagent'`、`delegationDepth`（父的 + 1），然后
   `sessionPersistence.create(session.header, { inheritedEventCount: 0 })`、写掉发布前的
   seed 尾巴、`enter`、`announce`——和 `dsh-agent-loop` 里一样的顺序；
2. 子会话的事件：`subagent/descriptor`（第 3 版，`mode: 'one-shot'`，`provider: 'pi'`，
   带 label）；Pi 每一轮一个 `turn/start`；任务原文作为 `user/message`；每条含 text 的
   助手回复用一对 `step/start` / `assistant/message` / `step/end` 包住（只留 text 块，
   `thinking` 和工具调用块这期丢掉）；`turn/end` 写真实的结束原因（`completed` /
   `aborted` / `error`）；
3. 父会话的 `subagent/catalog` 事件（第 0 版，`mode: 'one-shot'`，`label`），最后 flush
   两个会话。

能看到什么：子智能体目录里多一行，点开就是任务原文、Pi 的回复和对应的 token 用量
（`inputTokens`/`outputTokens` 以及 Pi 报的 cache/reasoning 计数）、运行结束状态。日志是
持久化的，DSH 重启后依然看得见。

本期**不做**的：

- **不投影工具调用**——`tool_execution_start`/`tool_execution_end` 直接忽略，子会话里
  只有对话，没有工具流水（第 2 期）；
- **不做运行中状态、不做 Stop 按钮**——事件在运行结束后一次性投影，投影完就把子会话从
  活跃 store 里摘下，所以它看起来是已结束的历史（第 3 期）。

**降级。** 投影是尽力而为的，永远不会影响派活本身：

- `sessions`/`sessionPersistence` 缺失，或者 `prepare`/`create`/追加被拒：记一条 `warn`，
  结果照常返回，`childSessionId` 为空；
- `pi-dev` 产不出 JSON 记录（老封装不认 `--mode json`、封装自己只打纯文本、真跑了文本
  模式）：整段 stdout 当唯一一条助手消息，投影仍会记录任务原文和结束状态；
- 封装直接**拒掉** `--mode json`（非 0 退出、stdout 为空、stderr 是参数解析不认 `--mode`
  的报错）：插件会去掉这个参数重跑一次，任务按文本模式继续，投影按上一条降级。其他失败
  不会被重试，保持它自己的错误，所以同一项任务不会被跑两遍。

## 行为细节

- **只有一个 `pi` 工具**：挂载时注册。工具描述告诉模型它在把任务派给本机 Pi，期间会产生一个
  可查看的子会话。参数是 `prompt`（必填）、`cwd`（可选，默认用调用方会话的工作目录）、
  `label`（可选，默认取 `prompt` 第一行，最多 60 字）。
- **工具返回值**是 `{ output, childSessionId, logPath, stopReason }`（失败时多一个
  `diagnostic`）。模型看到的文字是：最终回答、可选的诊断、`subagent session: <id>` 一行、
  `full output: <日志路径>` 一行。
- **结果怎么映射**：退出码 `0` → `completed`。别的退出码 → `error`，`diagnostic` 是
  `pi-dev exit code N` 加 stderr 尾部，整体不超过 4096 字节。`exec.signal` 取消 → 先
  SIGTERM，宽限期后 SIGKILL，结果 `aborted`，已经收到的输出照留。起进程失败也是 `error`
  结果，不会抛出去。
- **最终回答**取 Pi 最后一条非空助手消息的文本；一条结构化记录都解析不出来时，用整段
  stdout（去掉尾部空白）。
- **每次派活互不干扰**：每个 run 有自己的临时目录、自己的子会话 id、自己的进程状态，并发
  跑也不会串。
- **临时目录一定会删**，失败也删。里面是任务说明，可能含业务内容；`logDir` 里的日志不删，
  因为它是返回给模型的指针。

## 开发与自测

```bash
git clone <repo> && cd dsh-subagent-pi
node --check lib/index.js
bash -n bin/pi-dev
node --test test/            # 24 个单元测试，全绿，不联网、不花模型调用
node test/real-pi.mjs        # 手动跑：一次真 pi-dev，会花一次模型调用
```

- `test/tool.test.js` 用假 `ctx`（`tools.register`、`sessions`、`sessionPersistence`、
  `logger`）挂插件，跑真的子进程：`test/fake-pi-dev.mjs` 被复制到临时根目录当 `command`，
  从任务说明里读 `FIXTURE`/`RECORD` 指令，于是每个用例都能控制子进程的 stdout、stderr、
  退出码和时长，同时逐字断言插件拼的 argv、写的 brief、追加的子会话事件。覆盖：工具注册与
  schema、argv 拼装、参数与 `cwd` 校验、投影事件顺序与 payload（描述符 v3、目录 v0 严格
  字段、step 括号、usage 映射、`stream: []`）、多轮编号、纯文本与空 stdout 降级、
  `--mode` 被拒后的重试、error / abort 结束状态、SIGKILL 升级、服务缺失与追加被拒降级、
  并发隔离、配置校验、HOME 派生的默认值、临时目录清理。
- `test/real-pi.mjs` 是手动端到端：用真 `pi-dev` 跑一条「只回一行字」的短任务，
  传 `--tools read`，说明里明确不许改文件。它没有 DSH 容器，所以顺带验证「投影不可用 →
  只 warn、继续返回」这条降级路径。`NODE_TEST_CONTEXT` 已设置时它直接跳过，
  所以 `node --test` 不会白花一次模型调用。
- `test/index.js` 只是入口。有些 Node 版本把 `node --test` 后面的位置参数当模块路径，
  不写成它就跑不到测试。等价写法是 `node --test test/*.test.js`。
- `.github/workflows/test.yml` 在 Node 22 和 24 上跑语法检查和单元测试。

## 许可

[MIT](LICENSE) © 2026 Asta Zhao
