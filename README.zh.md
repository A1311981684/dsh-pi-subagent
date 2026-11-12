# dsh-pi-subagent

[English](README.md) | 中文

把本机的 [Pi](https://pi.dev) 编码 agent 接成 DSH（DeepSeek Harness）里**可查看过程的子智能体**。
装了它，DSH 的模型就能像调用官方的 Codex / Claude Code 子智能体一样，把一项开发任务派给 Pi，
拿回它的最终回答；事后还能在 DSH 的子智能体目录里点开这次派活，看到任务原文、Pi 的回复
（含 token 用量）和结束状态。

插件自己注册 `pi` 工具（不再需要
[`@deepseek-ai/dsh-tool-subagent`](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-subagent)），
每次调用起一个 `pi-dev` 子进程。子会话在进程启动之前就建好，Pi 的 JSON 事件流按行边收边投影：
思考、回复、工具调用与结果、一次模型调用一个 step，时间戳是真的；父会话的目录行同样在任务
开始时追加，所以任务还在跑，子会话就已经出现在 DSH 的子智能体目录里，点开是只读历史。

## 薄壳：只做两件事

怎么跑 Pi，插件几乎不管，全由 `pi-dev` 决定：

1. 每次一个临时 `PI_CODING_AGENT_DIR`，不碰 `~/.pi`；
2. 从 Pi 自己的 `auth.json` 取凭据放进环境变量，不打印；
3. 把固定规矩拼在任务说明前面；
4. 钉住模型（默认 `deepseek-flash`）；
5. Pi 自己的会话存储：插件传 `--session-id` 和 `--session-dir`，所以下一次派活可以接着用 Pi
   的记忆；封装在不带 id 时仍然加 `--no-session`；
6. 用 `--log` 把完整输出复制一份到文件（插件只在 `logMode: "full"` 时要求）；
7. 跑完往派活记录里追加一行。

插件自己只做两件事：

1. **跑这次派活**：校验参数，把任务说明写进临时目录，直接起 `pi-dev`（用 `node:child_process`，
   不依赖子进程服务），stdout 按行增量解析、stderr 只留尾部做诊断，取消时先 SIGTERM、
   宽限期后 SIGKILL，最终回答取 Pi 最后一条非空助手消息；
2. **边跑边投影**：先创建一个真实的 DSH 子会话（`sessions.prepare` +
   `sessionPersistence.create` + `enter`/`announce`），在起进程之前追加开场事件和父会话的
   `subagent/catalog` 目录行；然后每收到一条 Pi 记录就追加对应事件：一次模型调用一对
   `step/start`…`step/end`、`assistant/message`（思考/文本/工具调用块）、每次工具执行一对
   `tool/call` + `tool/result`，最后 `turn/end` 写真实结束原因；收尾 flush 两个会话（保留的
   子会话不 detach、不关句柄，留给下一次复用，插件卸载时统一释放）。

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
| `--log <文件>` | 完整输出日志，只在 `logMode: "full"` 时传。上级目录可能还不存在。 |
| `--model <名字>` | 可选，配了才传。 |
| `--thinking <档位>` | 可选，配了才传。 |
| `--tools <工具表>` | 可选，配了才传。 |
| `--mode <text\|json>` | 投影开启（默认）且封装的 `--help` 里提到这个参数时，传 `--mode json`。投影关闭、或帮助里没这个参数时不传，封装保持纯文本行为（见「会话投影」）。 |
| `--session-id <id>` | 要续跑的 Pi 会话（不存在就创建）。总与 `--session-dir` 一起传，且不会同时传 `--no-session`。 |
| `--session-dir <目录>` | Pi 存放和查找该会话的目录。 |
| `--help` | 每次开启投影的派活前先探测一次（stdin 忽略、短超时），据此决定能不能安全地传 `--mode json`。 |
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
brief="" cwd="$PWD" log="" session_id="" session_dir=""
model="" thinking="" tools="" mode="text" approve=0

while [ $# -gt 0 ]; do
  case "$1" in
    --brief)    brief=$2; shift 2 ;;
    --cwd)      cwd=$2; shift 2 ;;
    --log)      log=$2; shift 2 ;;
    --session-id) session_id=$2; shift 2 ;;
    --session-dir) session_dir=$2; shift 2 ;;
    --model)    model=$2; shift 2 ;;
    --thinking) thinking=$2; shift 2 ;;
    --tools)    tools=$2; shift 2 ;;
    --mode)     mode=$2; shift 2 ;;
    --approve)  approve=1; shift ;;
    *) echo "pi-dev: 不认识的参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "$brief" ] || { echo "pi-dev: 缺少 --brief" >&2; exit 2; }

args=(--print)
if [ -n "$session_id" ]; then
  args+=(--session-id "$session_id" --session-dir "${session_dir:-$HOME/.dsh/pi-sessions}")
else
  args+=(--no-session)
fi
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
插件就不用改。`--help` 里不提 `--mode`（或者忽略它、只打纯文本）的封装也能用：插件按文本
模式跑，把整段 stdout 当回答，投影自动降级（见「会话投影」）。

### 自带 `pi-dev` 封装

`bin/pi-dev` 是作者本机那套封装的便携版。`package.json` 把它声明成 bin，包管理器安装
这个包时会把它链接成 `pi-dev` 命令。它保持上面的契约（包括 `--mode text|json`），另外做了这些事：

- 每次运行一个临时 `PI_CODING_AGENT_DIR`，不碰 `~/.pi`；
- 从 `$HOME/.pi/agent/auth.json` 取 DeepSeek key 放进 `DEEPSEEK_API_KEY`（不打印；
  环境里已经有了就用环境里的），没有就提示先跑 `pi auth login deepseek`；
- 把 `rules/PI-DEV-RULES.md` 拼在任务说明前面——这是作者自己的固定规矩，插件本身
  不需要它；用别的封装或者不想要这份规矩，忽略这个文件和这个封装即可；
- 钉住 `deepseek-flash` 模型、给一份默认工具表；
- `--session-id <id>` / `--session-dir <目录>` 续跑（或创建）那个已存的 Pi 会话，不再加
  `--no-session`；没给 `--session-dir` 时用 `$PI_DEV_SESSION_DIR` 或
  `$HOME/.dsh/pi-sessions`；没给 `--session-id` 时仍保持原来的 `--no-session` 行为；
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
| `PI_DEV_SESSION_DIR` | `$HOME/.dsh/pi-sessions` | 没传 `--session-dir` 时 `--session-id` 的默认存储目录。 |

插件的默认 `command` 仍然是 `$HOME/.dsh/bin/pi-dev`。想用自带封装，就把它复制到这个位置
（或者建软链——封装会先把自己的软链解析成真实路径，包里的 `rules/PI-DEV-RULES.md` 照样
找得到），或者把
`command` 指到包里的 `bin/pi-dev`（例如 `<...>/node_modules/dsh-pi-subagent/bin/pi-dev`）。
你自己已经有 `pi-dev` 的话，把 `command` 指向它就行，插件只认上面那份契约。

## 安装

这个包是 DSH bundle：`package.json` 里声明了 `dsh.bundle.patch = ./cordis.patch.yml`。
装上包就够了，patch 会把插件挂上——它自己注册 `pi` 工具、自己投影子会话，网页
「插件 → 已安装插件」里也会出现它的卡片。

```bash
# 从 npm 装
dsh plugin --profile web add dsh-pi-subagent

# 从 GitHub 装
dsh plugin --profile web add git+https://github.com/A1311981684/dsh-pi-subagent.git

# 从本地目录装
dsh plugin --profile web add file:/path/to/dsh-pi-subagent
```

也可以把它写进 profile 的 `~/.dsh/profiles/<名字>/package.json`，让 profile 从自己的
`node_modules` 里找：

```json
{
  "dependencies": {
    "dsh-pi-subagent": "git+https://github.com/A1311981684/dsh-pi-subagent.git"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-pi-subagent"]
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
      name: dsh-pi-subagent
      config:
        # command: /usr/local/bin/pi-dev
        # model: deepseek-flash
        # tools: read,bash,edit,write,grep,find,ls
        # logDir: /home/me/.dsh/pi-logs
        # logMode: summary
        # sessionDir: /home/me/.dsh/pi-sessions
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
| `recoverLegacy` | `false` | 注册维护工具 `pi_recover_legacy`，把旧的 `mode: "external"` 派活回填成真实子会话。默认关，见 [旧派活回填（维护工具）](#旧派活回填维护工具)。 |
| `logMode` | `summary` | `summary`（默认）插件自己写精简日志：任务首行、最终回答、每个工具一行、usage/stopReason/子会话 id。`full` 让封装 tee 完整输出（`--log`），JSON 模式下就是原始事件流，可能几十 MB。 |
| `logDir` | `$HOME/.dsh/pi-logs` | 日志放这里，文件名是 `<YYYYMMDD-HHmmss>-<id 前 8 位>.log`。 |
| `sessionDir` | `$HOME/.dsh/pi-sessions` | 续跑时要复用的 Pi 会话放这里，作为 `--session-dir` 传给封装。 |
| `graceMs` | `5000` | 取消子进程时的 SIGTERM → SIGKILL 宽限期（毫秒）。 |
| `maxOutputBytes` | `262144` | 单条输出（stdout 和 stderr 各算一条）在内存里的上限，超了留尾部。 |

配置在挂载时就检查，配错当场报错，不会拖到第一次派活。规则：`graceMs` 和
`maxOutputBytes` 必须是正有限数，`command`、`logDir`、`sessionDir` 必须是非空字符串，
`logMode` 只能是 `"summary"` 或 `"full"`，`args` 必须是字符串数组，
`approve`/`projection`/`recoverLegacy` 必须是布尔。

## 会话投影

每次派活除了返回结果，还会在 DSH 里生成一个真实的子会话（投影第 2 期：边跑边投影）。
**先建子会话、再起进程**，然后来一条 JSON 记录投影一条：

1. `sessions.prepare(childId, { meta })`，meta 带子会话的 `cwd`、`parentSession`、
   `origin: 'subagent'`、`delegationDepth`（父的 + 1），然后
   `sessionPersistence.create(session.header, { inheritedEventCount: 0 })`、写掉发布前的
   seed 尾巴、`enter`、`announce`——和 `dsh-agent-loop` 里一样的顺序；
2. 进程还不存在时先追加开场事件：`turn/start`（DSH 的第 1 个 turn）、`subagent/descriptor`
   （第 3 版，`mode: 'one-shot'`，`provider: 'pi'`，带 label）、任务原文 `user/message`；
   紧接着追加父会话的 `subagent/catalog` 目录行（第 0 版），于是 Pi 刚开工目录里就有这一行；
3. stdout 按行增量解析（半行自己缓冲；单行超过 2 MiB 直接丢弃并 warn），每条记录映射成事件：
   - `turn_start` 开一个新 step（`step/start`）——Pi 的 turn 对应 DSH 的 **step**，不是 turn；
   - 助手 `message_end` 在当前 step 里追加 `assistant/message`：`thinking` → `reasoning` 块、
     text 原样保留、`toolCall` → `tool-call`（参数只序列化一次，作为 DSH 要的原始 JSON 字符串），
     带该 step 的 `usage`，`stream` 为空；随后每个工具调用追加 `tool/call`，参数串与块里**完全一致**；
   - `tool_execution_end` 追加 `tool/result`：内容取结果里的 text 块拼接，没有就用序列化的
     structuredContent，`isError` 透传，走 surface append；
   - `turn_end` 关掉这个 step——还有没结算的工具调用就先补一条 error 结果，所以 step 不会
     带着未结算的调用关闭；
   - `agent_end`/`agent_settled` 只记下的中止标志；真正的 `turn/end`（`completed` / `aborted` /
     `error`）在子进程退出后统一追加；
4. 最后 flush 两个会话；子会话保留为 live（不 detach、写句柄不关），下一次调用可以直接追加
   新 turn，插件卸载时统一释放。

这个顺序不是好看：持久化日志回读时会逐条校验关系。`step/end` 时若还有已登记未结算的
`tool/call` 会被拒；`turn/end` 时若还有打开的 step 会被拒；`tool/call` 的参数串必须和
`tool-call` 块里的字符串一模一样；`step` 号必须在打开的 turn 里从 1 连续递增。正常结束、失败、
取消都走同一个收尾函数，所以日志总是括号配对、并有一个 `turn/end`。

能看到什么：任务一开始，子智能体目录里就多一行；点开是任务原文、Pi 的思考与回复、工具调用
（参数与结果）、每个 step 的 token 用量（`inputTokens`/`outputTokens` 以及 Pi 报的
cache/reasoning 计数）、真实的耗时与时间戳、运行结束状态。日志是持久化的，DSH 重启后依然
看得见。

**限制。**

- **子会话没有独立 Stop**。只有主对话里取消派活才会中止工具调用：SIGTERM 掉 Pi（宽限期后
  SIGKILL），并把子会话的 turn 收成 `aborted`。网页把子会话当只读历史展示，没有单个子会话的
  停止按钮。独立 Stop 需要可续跑的 activation 形态，这期不做，留给以后。
- **保留的子会话在插件卸载前一直是 live**。复用靠的就是这一点，所以 DSH 里会一直看到这行。
  DSH 重启后就不能续了：插件只认自己进程里开过的会话。

## 会话复用

每个 `pi` 结果都带 `session`（子会话 id）。下一次调用把它传回来就是续跑：

- 同一个 DSH 子会话追加一个新 turn（编号 = 已记录的最后一个 turn + 1），带自己的任务原文和
  自己的 step 编号（每个 turn 的 step 从 1 开始）；不会再写 `subagent/descriptor`，也不会再写
  父会话的 `subagent/catalog`；
- Pi 用 `--session-id <id> --session-dir <sessionDir>` 起进程，Pi 自己的对话（读过的文件、
  做过的决定、工具历史）都还在，一般更省 token，也不用重读项目；
- 子会话在每次 run 结束后保留（flush 但不 detach、不 close），直到下一次续跑或插件卸载时由
  `ctx.effect` 释放；
- 只有在本进程里开过的会话能续。DSH 重启后插件会返回清楚的错误：
  `session <id> is not continuable in this host process; omit session to start a new one`；
- 同一个 session 同一时间只能跑一个任务；并发调用会报
  `session <id> is already running`。

Pi 自己的会话文件会堆在 `sessionDir` 下；它们不是 DSH 日志，清理脚本不会删。

**降级。** 投影是尽力而为的，永远不会影响派活本身：

- 起进程前先跑一次 `pi-dev --help`（stdin 忽略、短超时）探测 `--mode`；帮助里没提这个参数的
  封装按**文本模式**跑：投影只有任务原文、一条装下整段 stdout 的助手消息和结束状态，时间戳
  仍然是真实的。同一项任务不会被跑两遍；
- `sessions`/`sessionPersistence` 缺失，或者 `prepare`/`create`/开场追加被拒：记一条 `warn`，
  结果照常返回，`childSessionId` 为空；
- 运行中某次追加被拒：记一条 `warn`，后续内容不再投影，但仍会补上结构性收尾
  （`step/end`、`turn/end`），不至于在日志里留下没收的括号；
- 要了 JSON 模式、封装却还是打了纯文本：整段 stdout 当唯一一条助手消息，投影仍会记录任务
  原文和结束状态；
- 收到找不到对应调用的工具结果、或单行超过 2 MiB：跳过并 `warn`。

## 行为细节

- **默认只有一个 `pi` 工具**：挂载时注册（配置 `recoverLegacy: true` 时会额外注册维护工具
  `pi_recover_legacy`，见下文）。工具描述告诉模型它在把任务派给本机 Pi，期间会产生一个
  可查看的子会话。参数是 `prompt`（必填）、`cwd`（可选，默认用调用方会话的工作目录）、
  `label`（可选，默认取 `prompt` 第一行，最多 60 字）、`session`（可选，之前某次调用返回的
  子会话 id，用来接着干）。
- **工具返回值**是 `{ output, childSessionId, session, logPath, stopReason }`（失败时多一个
  `diagnostic`）。模型看到的文字是：最终回答、可选的诊断、`subagent session: <id>` 一行、
  `to continue this delegation, pass session: <id>` 提示、`full output: <日志路径>` 一行。
- **结果怎么映射**：退出码 `0` → `completed`。别的退出码 → `error`，`diagnostic` 是
  `pi-dev exit code N` 加 stderr 尾部，整体不超过 4096 字节。`exec.signal` 取消 → 先
  SIGTERM，宽限期后 SIGKILL，结果 `aborted`，已经收到的输出照留。起进程失败也是 `error`
  结果，不会抛出去。
- **最终回答**取 Pi 最后一条非空助手消息的文本；一条结构化记录都解析不出来时，用整段
  stdout（去掉尾部空白）。
- **每次新派活互不干扰**：每个新 run 有自己的临时目录、自己的子会话 id、自己的进程状态，
  并发跑也不会串；续跑按设计共享它自己的会话，同一个会话的两次 run 不会重叠。
- **临时目录一定会删**，失败也删。里面是任务说明，可能含业务内容；`logDir` 里的日志不删，
  因为它是返回给模型的指针。

## 日志与清理

`logMode`（默认 `summary`）决定一次派活往
`<logDir>/<YYYYMMDD-HHmmss>-<id 前 8 位>.log` 写什么：

- `summary`——插件自己写：任务首行（最多 100 字）、最终回答全文、每个工具一行
  `tool <name> <durationMs>ms <ok|error>`，最后一行是汇总 usage、`stopReason` 和子会话 id。
  一般几 KB。
- `full`——让封装 tee Pi 的完整输出（`--log`），JSON 模式下就是原始事件流，长任务可能几十 MB。

工具返回的 `logPath` 始终指向真正写出来的文件（summary 写失败时为空）。旧日志不会自动删：

```bash
node scripts/cleanup.mjs [--days 14] [--dry-run] [--sessions]
```

默认删除 `$HOME/.dsh/pi-logs` 下超过 N 天的文件，打印删除数量和释放空间；`--dry-run` 只列不删。
`--sessions` 额外**列出**（绝不删除）`$HOME/.dsh/sessions` 下超过 N 天、且含
`session.v4.jsonl.zstd` 的会话目录，并提示：删会话属于带外操作，最好先停 DSH，sqlite 索引
可能留下陈旧记录。候选里父会话和子会话都有（origin 在压缩日志里，脚本不做区分）。

## 旧派活回填（维护工具）

投影功能上线前，一次派活在父会话里只有一条 `mode: "external"` 的 `subagent/catalog` 记录，
背后没有子会话，DSH 的子智能体面板点不开。可选的 `pi_recover_legacy` 维护工具会为每条旧派活
补一个**新的、可点开的只读子会话**：

- **候选**：所有 `mode: "external"` 的目录行，加上 `ids` 里点名的 childId（例如投影只剩用户
  消息的那条 one-shot 会话）。
- **内容**：按 childId 前 8 位在 `logDir` 里找旧日志。纯文本日志整段使用；JSON 事件流取最后
  一条非空助手文本，并附上工具摘要。找不到日志也照样建会话，内容写“原日志缺失”的说明。
  内容上限 1 MB，超了保留尾部并注明截断。
- **幂等**：已经有回填目录行（`（回填 <旧 id 前 8 位>）…`）的旧行直接跳过，所以可以重复运行；
  `dryRun: true` 只报告不落盘。

该工具只在 `recoverLegacy: true` 时注册，正常安装里看不到。要在某台机器上跑一次，把开关加进
profile patch（`~/.dsh/profiles/web/cordis.patch.yml`），重载 DSH，调用工具，再把开关删掉重载：

```yaml
- insert: [{ id: subagent-pi, name: dsh-pi-subagent, config: { recoverLegacy: true } }]
```

旧目录行删不掉，会原样留在新行旁边。

## 开发与自测

```bash
git clone <repo> && cd dsh-pi-subagent
node --check lib/index.js
bash -n bin/pi-dev
node --test test/            # 50 个单元测试，全绿，不联网、不花模型调用
node test/real-pi.mjs        # 手动跑：一次真 pi-dev，会花一次模型调用
```

- `test/tool.test.js` 用假 `ctx`（`tools.register`、`sessions`、`sessionPersistence`、
  `logger`）挂插件，跑真的子进程：`test/fake-pi-dev.mjs` 被复制到临时根目录当 `command`，
  从任务说明里读 `FIXTURE`/`RECORD` 指令，于是每个用例都能控制子进程的 stdout、stderr、
  退出码和时长，同时逐字断言插件拼的 argv、写的 brief、追加的子会话事件。覆盖：工具注册与
  schema、argv 拼装、参数与 `cwd` 校验、`--help` 探测（JSON 流 / 文本模式）、流式投影的事件
  顺序与 payload（描述符 v3、目录 v0 严格字段、step 括号、reasoning/text/tool-call 块、
  `tool/call` 与 `tool/result` 的配对与参数一致性、usage 映射、`stream: []`）、多轮 step 编号、
  纯文本与空 stdout 降级、error / abort 结束状态（含取消时为未结算调用补结果）、SIGKILL 升级、
  服务缺失与追加被拒降级、超长行、并发隔离、配置校验、HOME 派生的默认值、临时目录清理；
  第 3 期新增：精简/完整日志、会话复用（turn 编号、不重复 descriptor/catalog、Pi 会话参数）、
  未知和并发 `session`、卸载时释放句柄。
- `test/cleanup.test.js` 用临时 `$HOME` 跑 `scripts/cleanup.mjs`：`--dry-run` 不删、`--days`
  筛选、删除时保留新文件、`--sessions` 只列不删。
- `test/recover.test.js` 用 `recoverLegacy: true` 挂插件，假父会话的 `snapshotEvents()` 返回旧
  目录行，检查：默认不注册；每条候选都建只读子会话且 v4 事件顺序、父目录 payload 严格匹配；
  纯文本日志与 JSONL 日志（最后一条助手文本 + 工具附录）；日志缺失说明；重复运行跳过；
  `dryRun` 不写任何东西；单条失败不影响其余。
- `test/pi-dev.test.js` 用假 `PI_BIN` 跑自带封装，检查 Pi 的 argv：`--session-id`/`--session-dir`
  取代 `--no-session`、默认会话目录、以及不带 id 时原来的 `--no-session` 行为。
- `test/real-pi.mjs` 是手动端到端：用真 `pi-dev` 跑一条「只回一行字」的短任务，
  传 `--tools read`，说明里明确不许改文件。它没有 DSH 容器，所以顺带验证「投影不可用 →
  只 warn、继续返回」这条降级路径。`NODE_TEST_CONTEXT` 已设置时它直接跳过，
  所以 `node --test` 不会白花一次模型调用。
- `test/index.js` 只是入口。有些 Node 版本把 `node --test` 后面的位置参数当模块路径，
  不写成它就跑不到测试。等价写法是 `node --test test/*.test.js`。
- `.github/workflows/test.yml` 在 Node 22 和 24 上跑语法检查和单元测试。

## 许可

[MIT](LICENSE) © 2026 Asta Zhao
