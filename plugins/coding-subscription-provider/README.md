# @dsh-enhanced/coding-subscription-provider

将同一台机器、同一 OS 用户已经登录的 Codex、Claude Code、Cursor Agent 与 Grok Build 注册为 DeepSeek Harness 可选择的模型 provider。四条 route 都会通过官方 CLI 的无 prompt 控制面动态列出当前账号可见模型；Codex、Claude 与 Grok 还会暴露逐模型 reasoning effort。调用消耗哪个套餐、是否允许额外用量，仍由对应官方客户端和账号决定。

这是一个实验性的 **LLM 兼容层**：DSH 把完整对话序列化为一次本地 coding-agent 任务，插件只取回最终助手文本。现有 API Key / OpenAI-compatible provider 是另一条路径，本插件不重复实现。

## 当前 provider

| DSH provider | 默认命令 | 成熟度 | 默认模型 |
|---|---|---|---|
| `codex-subscription` | `codex` | stable | `default` |
| `claude-subscription` | `claude` | experimental | `default` |
| `cursor-subscription` | `cursor-agent` | beta | `default` |
| `grok-subscription` | `grok` | beta | `default` |

`default` 不会传 `--model`，因此保留官方 CLI 当前选择。每条 route 都会把配置中的静态别名与实时目录合并，目录缓存 5 分钟；不需要把每个模型手写进配置。目录是提示性的发现信息，不会阻止用户配置新模型，最终可用性仍由官方 CLI 校验。

安全默认值只启用 Codex 与 Cursor。Claude 因第三方分发政策边界默认关闭；Grok 因本地 per-model API Key 可覆盖 OAuth，默认关闭并要求用户先核验后显式确认。四条 connector 都包含在插件中。

## 快速开始（5 步）

以启用 Codex 为例，最短路径如下：

1. **登录官方 CLI**（在运行 DSH 的同一 OS 用户下）：`codex login status` 应输出 `Logged in using ChatGPT`。没登录就先 `codex login`。
2. **安装插件**：`dsh plugin --profile web add @dsh-enhanced/coding-subscription-provider`。
3. **确认命令与工作目录**：`codex --version`。命令名不同就在 `~/.dsh/profiles/web/cordis.patch.yml` 里把 `codex.command` 改成实际路径；同时把 `cwd` 指向要处理的 Git 仓库（相对路径按 DSH 进程启动目录解析）。
4. **开启并落盘配置**：在配置中保持 `codex.enabled: true`（默认已开），执行 `dsh --profile web --dump-config` 检查生效值。
5. **选择模型与 effort**：在 DSH 的 provider/model 选择处选 route，再从当前账号的实时模型列表中选择模型及其 reasoning effort；也可选 `default` 沿用 CLI 当前模型。加载目录只执行初始化/列举，不会提交 prompt；真实生成调用会消耗你的订阅额度。

Claude / Grok 默认关闭，启用前请阅读下文「订阅认证优先」与「Claude 合规提示」。遇到报错先看下文「排查」表。

## 安装

先分别安装需要的官方客户端，并由当前 OS 用户在客户端中完成登录。插件不会替用户打开登录页或接管 OAuth：

```sh
codex login status
claude auth status --json
cursor-agent status
grok inspect
grok models
```

随后安装 DSH bundle：

```sh
dsh plugin --profile web add @dsh-enhanced/coding-subscription-provider
dsh --profile web --dump-config
```

只需安装准备使用的客户端；其余 provider 可以在配置中关闭。若系统上的命令名不同，应配置准确的可执行文件路径。例如某些 Grok Build 安装可能暴露 `agent`，但这个名称也可能属于 Cursor 或其他程序，必须先用 `--version` 核实，不能盲目复用。

## 配置

下面展示完整配置。Cordis patch 覆盖不是深合并；修改嵌套 provider 时，建议保留该 provider 的完整对象。

```yaml
- id: dsh-enhanced-coding-subscription-provider
  name: '@dsh-enhanced/coding-subscription-provider'
  config:
    cwd: .
    timeoutMs: 600000
    authProbeTimeoutMs: 10000
    maxAuthProbeBytes: 32768
    killGraceMs: 3000
    maxLineBytes: 262144
    maxOutputBytes: 2097152
    maxStderrBytes: 32768
    maxPromptBytes: 131072
    extraEnvNames: []
    logDiagnostics: false
    codex:
      enabled: true
      command: codex
      models: [default]
      maxTurns: 1
    claude:
      enabled: false
      command: claude
      models: [default]
      maxTurns: 1
    cursor:
      enabled: true
      command: cursor-agent
      models: [default]
      maxTurns: 1
    grok:
      enabled: false
      command: grok
      models: [default]
      maxTurns: 1
      userVerifiedSubscription: false
```

- `cwd` 是四个子进程看到的工作目录；相对路径按 DSH 进程启动目录解析，不是按 Web 会话显示的项目目录解析。Codex `exec` 要求这里是 Git 仓库；插件不会静默追加 `--skip-git-repo-check` 绕过该检查。Web profile 可在 `~/.dsh/profiles/web/cordis.patch.yml` 中覆盖此值，修改后需重启 DSH。
- `timeoutMs` 是单次调用总时限；取消或超时先发 `SIGINT`，经过 `killGraceMs` 再发 `SIGKILL`，再等待一个等长窗口确认 `close`。仍未关闭时请求以 `teardown=timed-out` 错误结算，保留原始 abort/timeout 分类，并在后台继续引流并跟踪迟到的 `close`；不会伪称子进程已回收。
- `authProbeTimeoutMs` / `maxAuthProbeBytes` 限制认证状态检查和无 prompt 模型目录发现；探针输出不会进入日志或模型响应。
- 三项输出限制和 prompt 限制都按 UTF-8 字节计算。
- `maxTurns` 目前只映射到 Claude Code 和 Grok Build；Codex/Cursor 不会收到它们不支持的参数。
- `models` 只是可选的静态别名列表；四条 route 都会在这些别名之外合并 CLI 动态目录。通常保留 `[default]` 即可。
- 启用 Grok 前先通过 browser/device flow 完成 `grok login`，确认 `grok models` 报告已登录，再用 `grok inspect` 确认所选模型没有 `api_key` / `env_key` override；随后同时设置 `enabled: true` 与 `userVerifiedSubscription: true`。`inspect` 本身不报告 active credential，该确认是本机用户的显式声明，不是插件读取凭据后的推断。
- `command` 是单个命令名或路径，插件固定参数数组并使用 `shell: false`，不接受 shell 片段。
- `extraEnvNames` 只填写要额外继承的环境变量名，值只能来自启动 DSH 的环境，配置中不能直接写 secret。
- `logDiagnostics` 默认只提示“CLI 写入了 stderr”，不记录内容；显式开启后才记录经过常见 key/token/邮箱规则脱敏的末尾 2,000 字符，仍不适合高敏感环境。独立于该开关，插件始终会在每次调用结算时记录一条**无凭据**的生命周期诊断（阶段、prompt 是否提交、结果分类、teardown 状态、exit/signal，以及能可靠测得的毫秒级延迟指标），成功走 `debug`、非成功走 `info`。该行不含 prompt、argv、stderr 原文或认证凭据。

加载后，在 DSH 的 provider/model 选择处选择上表中的 provider 和模型即可。真实订阅调用会消耗额度，自动化测试不会使用真实账号。

### 订阅认证优先

子进程默认只继承运行客户端所需的最小环境，例如 `PATH`、`HOME`、XDG、代理/CA、`CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和 `GROK_HOME`。以下 API 凭据即使写入 `extraEnvNames` 也不会传递：

```text
CODEX_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
CLAUDE_CODE_OAUTH_TOKEN
CURSOR_API_KEY
XAI_API_KEY
```

已知的自定义 base URL、Claude Bedrock/Vertex/Foundry 切换变量也会被排除；上述变量即使出现在 `extraEnvNames` 也不会传递。插件在每次调用前或调用初始化阶段执行 fail-closed 门禁：

- Codex 只有 `codex login status` 精确报告 `Logged in using ChatGPT` 才运行，并以 `--ignore-user-config` 禁止真实生成被本地配置改路由到其他 API。模型发现会另启短生命周期 App Server，强制 `model_provider="openai"`，只执行 `initialize` 与 `model/list`，不会创建 thread 或 turn。
- Claude 只有 `auth status --json` 报告 first-party `claude.ai` / `oauth_token` 才运行；目录发现只发送 Agent SDK `initialize` 控制帧并读取 `models`，不发送 user message。这是订阅 OAuth 来源的强启发式，不代表插件能证明具体套餐 entitlement。
- Cursor 先要求 `status` 成功，再以 `--list-models` 发现目录；本次生成仍要求 `stream-json` 的 `system/init.apiKeySource` 为 `login`，`env`、`flag` 或缺失字段都会中止。
- Grok 目录发现只发送 ACP `initialize` 并读取 `_meta.modelState`，不创建 session 或提交 prompt。headless 生成暂时无法独立证明 effective credential，因此仍必须由本机用户核对配置并设置 `userVerifiedSubscription: true`。

认证不满足时返回 `SUBSCRIPTION_AUTH_REQUIRED`，不会静默改走 API provider。API Key 调用继续使用 DSH 已有的独立 provider。

## 默认执行策略

- Codex：`codex exec --json --ephemeral --ignore-user-config --sandbox read-only`；选择具体模型时追加 `--model <id>`，选择 effort 时追加 `--config model_reasoning_effort="<effort>"`。
- Claude Code：`-p --output-format stream-json --include-partial-messages --safe-mode --permission-mode dontAsk --tools "" --no-session-persistence`；选择 effort 时追加 `--effort <level>`。
- Cursor Agent：`--print --output-format stream-json`，不传 `--force`。
- Grok Build：`-p <task> --output-format streaming-json --permission-mode dontAsk --no-auto-update --no-memory --no-subagents --disable-web-search --verbatim --tools search_tool --disallowed-tools search_tool,use_tool`；`--verbatim` 保留 DSH 的原始 prompt，后两项按 Grok 1.0.5 的过滤规则把最终生成工具集收敛为空（空 `--tools` 会被当作未过滤），避免兼容层意外探索仓库。选择 effort 时追加 `--reasoning-effort <level>`。解析器按官方原生流读取 `text.data`，以 `end` 确认成功终态、以 `error` 拒绝失败终态。

每次调用都是独立任务，不恢复外部 CLI session。插件不会在失败后自动切换 provider 或重试，因为 coding agent 可能已经读取环境或产生其他不可见副作用。

## 权限与数据边界

| 能力 | 行为 |
|---|---|
| 文件系统 | 插件把 `cwd` 交给外部 CLI。Codex 使用 read-only sandbox；Claude 禁用内置 tools；Grok 1.0.5 使用 allowlist + denylist 形成空生成工具集；Cursor/Grok 的最终强度仍取决于客户端版本、用户配置和 OS 隔离。 |
| 网络 | 插件本身不请求模型端点；四个官方 CLI 会连接各自的登录、推理、更新或遥测服务。 |
| 子进程 | 仅直接启动配置的单个可执行文件，`shell: false`。目录发现会短暂启动同一可执行文件的 App Server、SDK/ACP 初始化或列表模式。POSIX 上为生成调用建立进程组并整体取消；Windows 只能 best-effort 终止直接子进程。官方 CLI 仍可能自行创建脱离进程组的后代。 |
| 凭据 | 不读取官方 auth 文件、不实现 OAuth、不刷新或上传 token。默认继承 `HOME`/配置目录，让官方 CLI 自己访问凭据。 |
| 浏览器 | 插件不会打开浏览器；用户单独执行官方 login 时可能打开。 |
| 安装脚本 | 本 npm 包没有 install/postinstall 脚本，也不会安装或更新四个官方 CLI。 |
| 日志 | stderr 有界且默认不记录内容。选择 `logDiagnostics` 后会脱敏常见 key、Bearer token 和邮箱，但无法识别任意业务秘密；插件本身不主动记录 prompt。每次调用结算记录一条无凭据生命周期诊断（阶段/提交状态/结果分类/teardown/exit/signal，以及可测得的毫秒级延迟指标），不含 prompt、argv、stderr 原文或认证凭据。 |

任务正文当前作为独立 argv 元素传给官方 CLI。它不会经过 shell，但仍受操作系统命令行长度限制，并且在某些系统上可能被同机高权限用户通过进程列表看到；敏感、多用户主机应增加 OS 级隔离。默认 prompt 上限因此保守设为 128 KiB。

DSH 的 skill catalog 更新是完整替换。序列化兼容 prompt 时，若最新目录明确带有 replacement 标记，插件只发送最新目录，不再重复发送它已经取代的旧目录；durable session 历史不会被改写。裁剪后仍超过 `maxPromptBytes` 时，插件返回标准 `CONTEXT_WINDOW_EXCEEDED`；宿主启用了自动 compaction 时，可据此先压缩历史再重试。

## 排查

调用失败时会返回稳定的 `LlmError` code。常见对应关系：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `SUBSCRIPTION_AUTH_REQUIRED` | 调用前的认证门禁未通过（未登录，或检测到 API key / 非订阅来源） | 在同一 OS 用户下重新 `login`；确认没有把 API key 写进 `extraEnvNames`；Grok 需另设 `userVerifiedSubscription: true`（见「订阅认证优先」）。 |
| `CLI_NOT_FOUND` | 找不到可执行文件（`ENOENT`） | 核对该 provider 的 `command` 是否为正确的命令名/绝对路径，并确认它在 DSH 进程的 `PATH` 中。 |
| `CLI_WORKING_DIRECTORY` | Codex 拒绝了配置的工作目录，因为它不是可接受的 Git 仓库 | 把 profile 中的 `cwd` 改为目标 Git 仓库的绝对路径并重启 DSH；不要只根据 Web 会话显示的 cwd 推断子进程 cwd。 |
| `CONTEXT_WINDOW_EXCEEDED` | 去除已被替换的旧 skill catalog 后，序列化请求仍超过 `maxPromptBytes` | 若宿主已启用自动 compaction，可等待其压缩并重试；否则手动缩短/压缩历史或 skill 描述。只有确认 OS 命令行上限足够时才调大 `maxPromptBytes`。 |
| `CLI_TIMEOUT` | 单次调用超过 `timeoutMs` | 简化 prompt，或调大 `timeoutMs`；确认官方 CLI 未卡在交互式提示上。 |
| `CLI_PROTOCOL_ERROR` | 输出流没有可识别的 assistant 文本或缺少规定终态（含畸形/仅未知事件、Cursor 非 `login` 来源） | 手动跑一次官方 CLI 确认其正常输出；若为 CLI 版本漂移导致，见下文 fixture 采集。 |
| `CLI_FAILED` | 子进程非零退出或其他未归类失败 | 开 `logDiagnostics` 看脱敏 stderr 尾部；单独运行官方 CLI 复现。 |
| `INVALID_PROVIDER` | 选择了本插件未提供的 provider id | 只使用上表四个 `*-subscription` route。 |

插件**不会**在失败后自动切换 provider 或重试。每次调用结算都会记录一条无凭据生命周期诊断（成功走 `debug`、失败走 `info`），可据此定位失败发生在哪个阶段。

### 采集真实 CLI fixture（维护者）

解析器按 `decode → 各 provider decoder → 归一化事件 → reducer` 分层，需要来自**明确 CLI 版本**的真实输出作为回归 golden。采集脚本已就绪：

```sh
node plugins/coding-subscription-provider/scripts/capture-cli-fixtures.mjs --help
```

脚本默认脱敏、需显式确认会消耗额度，产物落到 `tests/fixtures/<provider>/<version>/<scenario>.json`，`tests/fixtures.spec.ts` 在样本落地后自动激活。细节与脱敏清单见 [`tests/fixtures/README.md`](tests/fixtures/README.md)。

## 已知限制

- DSH `0.1.0-rc.8` 只有 `LlmAdapter` provider 接缝；本版因此是兼容适配，不是完整的 Agent Runtime。
- DSH tool schema 不会映射成外部 CLI 的 tool call；`temperature`、`stop`、`maxTokens` 等参数只能进入任务约束，不能保证与原生模型 API 等价。
- 暂不转发图片，也不提供供应商 token usage；provider 元数据声明为 text-only。
- Codex JSONL 当前主要提供事件级文本；解析器允许已识别事件旁出现向后兼容扩展，但若整条流只有未知/畸形事件、没有 assistant 文本或缺少规定终态，会返回 `CLI_PROTOCOL_ERROR`，不会产生空成功。
- 仅靠“不传 force / dontAsk / prompt 指令”不是强沙箱。需要处理不可信仓库时，应在容器、只读挂载或独立 OS 账号中运行 DSH。
- 插件没有远程共享、公共 HTTP 代理、token 导入、浏览器抓取或 Hermes 式私有后端直连能力。
- Cursor 目前只自动发现模型。其官方 headless CLI 尚未暴露可验证的 effort 参数；Max Mode/Thinking 变体不会伪装成 DSH effort，待上游提供机器可用控制面后再接入。
- Codex App Server、Claude SDK control 与 Grok ACP 当前只用于模型目录发现；生成仍使用各自一次性 CLI。Grok effective credential 绑定、动态 CLI 版本探测和持久外部会话属于后续阶段。

### Claude 合规提示

Anthropic 的技术文档允许 `claude -p` 使用订阅登录，但其法律与合规页面同时限制第三方产品代用户提供 Claude.ai 登录或路由 Free/Pro/Max 凭据。因此 Claude connector 只作为同机同用户的 experimental 委托：不提供登录、不托管 token、不做多租户。公开或商业部署前应自行取得适用授权；否则使用 DSH 已有的官方 API Key provider。

## 兼容性与调研

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness / `@deepseek-ai/dsh-llm` `>=0.1.0-rc.8 <0.2.0`
- Cordis `^4.0.1`
- Codex CLI `0.147.0`（已验证；模型目录基于官方 [Codex App Server](https://developers.openai.com/codex/app-server) 的 `model/list`）
- Claude Code `2.1.218`（已验证；目录字段遵循官方 [Agent SDK `supportedModels()`](https://code.claude.com/docs/en/agent-sdk/typescript)）
- Grok Build `1.0.5`（已验证；目录与 effort 来自 ACP `initialize` 的 `modelState`，生成事件遵循官方 [headless `streaming-json`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md#streaming-json)）
- Cursor CLI：目录使用官方 [`--list-models`](https://cursor.com/changelog/cli-jan-08-2026)；本机未安装，依赖 fixture 验证

设计证据、官方文档链接以及 Hermes/OpenClaw 对比见 [调研报告](../../docs/coding-subscription-provider-research.md)。仓库兼容基线见 [compatibility.md](../../docs/compatibility.md)。
