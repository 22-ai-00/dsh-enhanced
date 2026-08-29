# @dsh-enhanced/coding-subscription-provider

将同一台机器、同一 OS 用户已经登录的 Codex、Claude Code、Cursor Agent 与 Grok Build 注册为 DeepSeek Harness 可选择的模型 provider。默认情况下，四条 route 会在经过 live Agent session 工作区校验的调用中，通过官方 CLI 的无 prompt 控制面观察当前账号可见模型；Codex、Claude 与 Grok 还会暴露逐模型 reasoning effort。调用消耗哪个套餐、是否允许额外用量，仍由对应官方客户端和账号决定。

这是一个实验性的 **LLM 兼容层**。默认 `cli` transport 会把完整对话序列化为一次本地 coding-agent 任务，只取回最终助手文本；Codex 另有必须显式开启的 `direct-responses` transport，可绕过 Codex CLI / App Server，流式返回文本、原生 function tool call，并在 attachment service 可用时发送图片。现有 API Key / OpenAI-compatible provider 是另一条路径，本插件不重复实现。

## 当前 provider

| DSH provider | 默认命令 | 成熟度 | 默认模型 |
|---|---|---|---|
| `codex-subscription` | `codex` | stable | `default` |
| `claude-subscription` | `claude` | experimental | `default` |
| `cursor-subscription` | `cursor-agent` | beta | `default` |
| `grok-subscription` | `grok` | beta | `default` |

在默认 CLI 模式中，`default` 不会传 `--model`，因此保留官方 CLI 当前选择。模型选择器首次调用 `listModels` 或 5 分钟缓存过期时，会先执行已有订阅认证门禁，再从配置的 `cwd` 发起一次无 prompt、有界、只读的目录刷新；并发列表请求会共用同一次刷新。刷新成功后返回静态别名与完整动态目录，失败则安全降级到 `models` 中的静态项并记录无凭据诊断。`resolveModel` 仍只读取配置与有效内存缓存，不启动进程。不需要把每个模型手写进配置；目录是提示性的发现信息，不会阻止用户配置新模型，最终可用性仍由官方 CLI 校验。Codex direct 模式不启动 App Server、也不发现动态目录；其中 `default` 会明确映射到 `codex.directModel`。

安全默认值只启用 Codex 与 Cursor。Claude 因第三方分发政策边界默认关闭；Grok 因本地 per-model API Key 可覆盖 OAuth，默认关闭并要求用户先核验后显式确认。四条 connector 都包含在插件中。

## 快速开始（CLI transport，5 步）

以启用 Codex 为例，最短路径如下：

1. **登录官方 CLI**（在运行 DSH 的同一 OS 用户下）：`codex login status` 应输出 `Logged in using ChatGPT`。没登录就先 `codex login`。
2. **安装插件**：`dsh plugin --profile web add @dsh-enhanced/coding-subscription-provider`。
3. **确认命令与工作目录**：`codex --version`。命令名不同就在 `~/.dsh/profiles/web/cordis.patch.yml` 里把 `codex.command` 改成实际路径。bundle 的 `cwd` 默认与标准 Delivery 一样指向 `$DSH_HOME/assistant-workspace`；Codex CLI 要求它是 Git 仓库。若改到其他仓库，必须同时把 Delivery `defaultWorkspace` 改到同一 realpath（相对路径按 DSH 进程启动目录解析）。
4. **开启并落盘配置**：在配置中保持 `codex.enabled: true`（默认已开），执行 `dsh --profile web --dump-config` 检查生效值。
5. **选择模型与 effort**：打开模型选择器时，`listModels` 会先通过认证门禁并进行无 prompt 目录刷新，随后合并当前模型及 reasoning effort；若刷新失败仍可选择配置中的 `default`。目录刷新不创建 thread/session/turn，也不提交用户消息；真实生成调用才会消耗你的订阅推理额度。

Claude / Grok 默认关闭，启用前请阅读下文「订阅认证优先」与「Claude 合规提示」。遇到报错先看下文「排查」表。

如果只使用显式 opt-in 的 Codex `direct-responses`，生成和模型目录都不会启动 Codex CLI/App Server，也不要求 `codex` 可执行文件存在；但运行 DSH 的同一 POSIX 用户必须已经拥有安全的 `CODEX_HOME/auth.json` 或 `~/.codex/auth.json`。这通常由官方 Codex 登录流程产生，插件自身不提供登录 UI。

## 安装

CLI transport 先分别安装需要的官方客户端，并由当前 OS 用户在客户端中完成登录。Codex direct 可跳过客户端安装，但仍要求上述安全 auth 文件。插件不会替用户打开登录页或接管初始登录：

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
    cwd: !!js dshHomePath('assistant-workspace')
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
      transport: cli
      command: codex
      models: [default]
      maxTurns: 1
      directModel: gpt-5.6-sol
      directReasoningEfforts: [low, medium, high, xhigh, max, ultra]
      directDefaultReasoningEffort: low
      maxRequestBytes: 33554432
      maxRequestImageBytes: 25165824
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

如需试用 Codex 私有直连，只把 Codex 的 transport 显式改为下列值；不要把它当成默认或稳定路径：

```yaml
codex:
  enabled: true
  transport: direct-responses
  models: [default]
  directModel: gpt-5.6-sol
  directReasoningEfforts: [low, medium, high, xhigh, max, ultra]
  directDefaultReasoningEffort: low
  maxRequestBytes: 33554432
  maxRequestImageBytes: 25165824
```

- `codex.transport` 默认为 `cli`，维持官方 Codex CLI 的认证、沙箱和模型目录路径。只有显式设置为 `direct-responses` 才会启用下文说明的私有 Responses 协议；该模式绕过 Codex CLI 与 App Server，`command`、`maxTurns` 和 CLI 动态模型目录不参与生成。
- `codex.directModel` 是 direct 模式选择 `default` 时发送给后端的具体模型 id；显式选择其他模型时仍使用所选 id。这个默认值只是本插件的实验性配置，不代表私有后端长期保证该模型可用。
- `codex.directReasoningEfforts` 是 direct route 向 DSH 暴露的可选 effort 列表，`codex.directDefaultReasoningEffort` 是调用未指定 effort 时由 DSH 物化的默认值，并且必须属于前一列表。当前默认暴露 `low` 到 `ultra`；私有 wire 会按官方 Codex 当前行为把 `ultra` 规范化为 `max`，这同样不是稳定承诺。
- `codex.maxRequestBytes` 限制序列化后的完整 direct 请求（包括 base64 图片），`codex.maxRequestImageBytes` 限制请求内累计图片负载，且后者不能大于前者。默认分别为 32 MiB 与 24 MiB；两项只影响 direct 模式。
- `cwd` 是 CLI 子进程允许使用的工作目录，也是 direct 模式的本地 session 授权边界；bundle 默认使用 `$DSH_HOME/assistant-workspace`，与标准 Delivery 默认值一致。相对路径按 DSH 进程启动目录解析，不是按 Web 会话显示的项目目录解析。对每个**带 prompt 的普通对话调用**，插件要求深冻结的 DSH Agent Loop 请求；当模块 marker 因源码 link 或 adapter 克隆不可见时，Host `agents` 服务还会核对仍在运行的精确 Agent、registry/session 对象身份，并从 live Session header/messages 重建请求，只容许 rc.8 `forAdapter()` 删除跨 route `replayState`。随后对 live session cwd 与配置 cwd 做 `realpath` 并要求完全相等。缺失、过期、伪造、辅助/嵌套调用、请求变形、路径不匹配或 symlink escape 都会在认证、网络请求或 CLI 启动前以 `LOCAL_SESSION_CWD_REQUIRED` 拒绝；CLI 模式收到的是该 canonical session cwd。Cordis `config` 是整段替换，覆盖时必须保留 `cwd`；若改目录，还要同步修改 Delivery `defaultWorkspace`。Codex `exec` 要求这里是 Git 仓库；插件不会静默追加 `--skip-git-repo-check` 绕过该检查。修改后需重启 DSH。
- CLI transport 的 `listModels` 在目录缓存冷启动或 5 分钟过期时，会使用配置的 `cwd` 先执行已有认证门禁，再启动一次无 prompt、有界的只读目录探针；它不需要 live session identity，也不会创建生成 turn。相同 provider 的并发请求共享一次 in-flight 刷新；失败只返回配置中的静态 `models` 并记录无凭据分类诊断。生成调用从不触发或等待目录刷新，只执行自身认证和两次 live-session cwd 校验。`resolveModel` 始终是纯缓存/配置读取，不执行认证、目录发现或子进程。Codex `direct-responses` 的 `listModels` 同样保持纯静态且不启动 CLI/App Server。
- `timeoutMs` 是单次调用总时限；取消或超时先发 `SIGINT`，经过 `killGraceMs` 再发 `SIGKILL`，再等待一个等长窗口确认 `close`。仍未关闭时请求以 `teardown=timed-out` 错误结算，保留原始 abort/timeout 分类，并在后台继续引流并跟踪迟到的 `close`；不会伪称子进程已回收。
- `authProbeTimeoutMs` / `maxAuthProbeBytes` 限制 CLI 模式中 `listModels` 与生成调用使用的认证状态检查，以及 `listModels` 的无 prompt 模型目录发现；Codex 目录还受 `killGraceMs`、`maxLineBytes`、`maxOutputBytes`、`maxStderrBytes` 约束。探针输出不会进入模型响应。Codex direct 请求使用总调用的 `timeoutMs`，不运行这些 CLI 探针。
- 三项输出限制和 prompt 限制都按 UTF-8 字节计算。
- `maxTurns` 目前只映射到 Claude Code 和 Grok Build；Codex/Cursor 不会收到它们不支持的参数。
- `models` 是目录探针不可用时仍可展示的静态别名列表；CLI route 会在 `listModels` 的安全刷新后合并动态条目，Codex direct 模式只使用静态别名。通常保留 `[default]` 即可。
- 启用 Grok 前先通过 browser/device flow 完成 `grok login`，确认 `grok models` 报告已登录，再用 `grok inspect` 确认所选模型没有 `api_key` / `env_key` override；随后同时设置 `enabled: true` 与 `userVerifiedSubscription: true`。`inspect` 本身不报告 active credential，该确认是本机用户的显式声明，不是插件读取凭据后的推断。
- `command` 是单个命令名或路径，CLI 模式固定参数数组并使用 `shell: false`，不接受 shell 片段；Codex direct 模式不使用该字段。
- `extraEnvNames` 只填写要额外继承的环境变量名，值只能来自启动 DSH 的环境，配置中不能直接写 secret。
- 目录探针的 stderr 始终只生成固定的无凭据提示，原文不会传给诊断 sink。其他 CLI 的 stderr 在 adapter 诊断边界先经过常见 key/token/邮箱规则脱敏；`logDiagnostics` 默认仍只提示“CLI 写入了 stderr”，显式开启后才记录脱敏后的末尾 2,000 字符，仍不适合高敏感环境。独立于该开关，插件始终会在每次调用结算时记录一条**无凭据**的生命周期诊断（阶段、prompt 是否提交、结果分类、teardown 状态、exit/signal，以及能可靠测得的毫秒级延迟指标），成功走 `debug`、非成功走 `info`。该行不含 prompt、argv、stderr 原文或认证凭据。

加载后，在 DSH 的 provider/model 选择处选择上表中的 provider 和模型即可。真实订阅调用会消耗额度，自动化测试不会使用真实账号。

### 订阅认证优先

CLI 子进程默认只继承运行客户端所需的最小环境，例如 `PATH`、`HOME`、XDG、代理/CA、`CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和 `GROK_HOME`。以下 API 凭据即使写入 `extraEnvNames` 也不会传递：

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

- Codex CLI 模式只有 `codex login status` 精确报告 `Logged in using ChatGPT` 才运行，并以 `--ignore-user-config` 禁止真实生成被本地配置改路由到其他 API。模型发现会另启短生命周期 App Server，强制 `model_provider="openai"`，只执行 `initialize` 与 `model/list`，不会创建 thread 或 turn。
- Codex direct 模式不运行 `codex login status` 或 App Server，而是安全读取 `CODEX_HOME/auth.json`；未设置 `CODEX_HOME` 时读取 `~/.codex/auth.json`。认证路径在启动时固定为绝对路径；文件及其父目录必须由当前 POSIX 用户拥有，父目录不能向 group/other 开放写权限，文件必须是单链接普通文件、不能是 symlink、不能向 group/other 开放权限，并且 `auth_mode` 必须是 `chatgpt`。读取有字节上限并校验前后元数据一致。凭据只用于固定的 Codex Responses 请求；插件不会向调用方暴露 bearer token。
- direct 请求使用与固定官方快照核对过的 `session-id`、`thread-id` 和 `x-client-request-id` 兼容头；originator/version/user-agent 属于本插件固定的 reconstruction dialect 标识，并不冒充官方二进制逐字节相同的 OS/终端 user-agent。
- direct 请求收到 401 时，插件会先重新读取磁盘以复用其他进程已刷新的 session；仍是原 token 时，才向固定 OAuth token endpoint 发起一次 refresh。同一进程内相同认证身份共享一次刷新；写回采用元数据 CAS、同目录 `0600` 临时文件、`fsync` 和原子 rename。随后原请求只重试一次；其他 HTTP 状态不会触发刷新。插件自身并发写受 CAS 保护，但无法强制不遵循同一约定的外部 Codex 进程参与原子比较写，因此跨进程冲突处理是 best-effort。错误与诊断不记录 token。
- Claude 只有 `auth status --json` 报告 first-party `claude.ai` / `oauth_token` 才运行；目录发现只发送 Agent SDK `initialize` 控制帧并读取 `models`，不发送 user message。这是订阅 OAuth 来源的强启发式，不代表插件能证明具体套餐 entitlement。
- Cursor 先要求 `status` 成功，再以 `--list-models` 发现目录；本次生成仍要求 `stream-json` 的 `system/init.apiKeySource` 为 `login`，`env`、`flag` 或缺失字段都会中止。
- Grok 目录发现只发送 ACP `initialize` 并读取 `_meta.modelState`，不创建 session 或提交 prompt。headless 生成暂时无法独立证明 effective credential，因此仍必须由本机用户核对配置并设置 `userVerifiedSubscription: true`。

认证不满足时返回 `SUBSCRIPTION_AUTH_REQUIRED`，不会静默改走 API provider。API Key 调用继续使用 DSH 已有的独立 provider。

> **兼容性警告：** `direct-responses` 使用的是 ChatGPT/Codex 当前的非公开、私有风格协议，不是 OpenAI 面向第三方承诺稳定性的公开 API。endpoint、认证文件、header、模型 id 与 SSE 事件都可能在没有兼容期的情况下变化或失效；该模式必须视为可随时中断的实验功能，不能宣传为 OpenAI 官方支持的集成。默认 `cli` 不依赖这条私有协议。

## 默认执行策略

- Codex CLI（默认）：`codex exec --json --ephemeral --ignore-user-config --sandbox read-only`；选择具体模型时追加 `--model <id>`，选择 effort 时追加 `--config model_reasoning_effort="<effort>"`。
- Codex direct（显式 opt-in）：不启动 CLI/App Server，固定向 `https://chatgpt.com/backend-api/codex/responses` 发送有界 SSE 请求。DSH tool schema 会映射为原生 function tools；插件只保留并返回后端给出的 tool name、原始 arguments 与 `call_id`，**不会自行执行工具**。实际工具调用由 DSH Agent Loop 交给 Policy 鉴权后执行，再以相同 `call_id` 的 tool result 进入下一轮模型请求。开启 attachment service 时可把 DSH image block 投影为图片输入；没有该服务时 provider 只声明 text。
- Claude Code：`-p --output-format stream-json --include-partial-messages --safe-mode --permission-mode dontAsk --tools "" --no-session-persistence`；选择 effort 时追加 `--effort <level>`。
- Cursor Agent：`--print --output-format stream-json`，不传 `--force`。
- Grok Build：`-p <task> --output-format streaming-json --permission-mode dontAsk --no-auto-update --no-memory --no-subagents --disable-web-search --verbatim --tools search_tool --disallowed-tools search_tool,use_tool`；`--verbatim` 保留 DSH 的原始 prompt，后两项按 Grok 1.0.5 的过滤规则把最终生成工具集收敛为空（空 `--tools` 会被当作未过滤），避免兼容层意外探索仓库。选择 effort 时追加 `--reasoning-effort <level>`。解析器按官方原生流读取 `text.data`，以 `end` 确认成功终态、以 `error` 拒绝失败终态。

每次调用都是独立任务，不恢复外部 CLI session。插件不会在失败后自动切换 provider；Codex direct 仅为认证 401 做上述单次刷新与单次原请求重试，不对模型或工具轮次做通用重试。

## 权限与数据边界

| 能力 | 行为 |
|---|---|
| 文件系统 | CLI 模式把经过 live-loop session 身份和 canonical `realpath` 精确校验的 cwd 交给带 prompt 的外部 CLI；`listModels` 的无 prompt 认证/目录探针使用配置的 `cwd`，不创建 turn，`resolveModel` 不启动进程。Codex CLI 使用 read-only sandbox；Claude 禁用内置 tools；Grok 1.0.5 使用 allowlist + denylist 形成空生成工具集；Cursor/Grok 的最终强度仍取决于客户端版本、用户配置和 OS 隔离。Codex direct 不把 cwd 交给模型进程，但会读取并可能以 CAS + 原子替换更新 `CODEX_HOME/auth.json` 或 `~/.codex/auth.json`；与不使用同一 CAS 的外部写者并发时只能 best-effort 避免覆盖。图片字节只通过宿主提供的 attachment service 读取。 |
| 网络 | CLI 模式下插件本身不请求模型端点，官方 CLI 会连接各自的登录、推理、更新或遥测服务。Codex direct 由插件固定请求 `https://chatgpt.com/backend-api/codex/responses`，仅在 401 刷新时请求 `https://auth.openai.com/oauth/token`；不能把凭据用于任意 URL。请求正文会把对话、tool schema/tool result，以及可用时的图片发送给该私有后端。 |
| 子进程 | CLI 模式仅直接启动配置的单个可执行文件，`shell: false`；冷启动或过期的 `listModels` 会在认证通过后短暂启动同一可执行文件的 App Server、SDK/ACP 初始化或列表模式，且不会提交 prompt 或创建生成 turn。POSIX 上为生成调用建立进程组并整体取消；Windows 只能 best-effort 终止直接子进程。官方 CLI 仍可能自行创建脱离进程组的后代。`resolveModel` 和 Codex direct 的模型列表不启动 Codex CLI 或 App Server。 |
| 凭据 | CLI 模式不读取官方 auth 文件、不实现 OAuth，由官方客户端访问凭据。Codex direct 会按上述 POSIX 文件约束直接读取 ChatGPT session，在 401 时至多刷新一次，并以插件自身的 CAS + 原子替换流程写回；它不接受 API key fallback，也不把 token 写入响应或日志。 |
| 浏览器 | 插件不会打开浏览器；用户单独执行官方 login 时可能打开。 |
| 安装脚本 | 本 npm 包没有 install/postinstall 脚本，也不会安装或更新四个官方 CLI。 |
| 日志 | stderr 有界且默认不记录内容；目录探针的 stderr 原文永不传给诊断 sink，只报告固定无凭据提示。其他 CLI 选择 `logDiagnostics` 后会脱敏常见 key、Bearer token 和邮箱，但无法识别任意业务秘密；插件本身不主动记录 prompt。每次调用结算记录一条无凭据生命周期诊断（阶段/提交状态/结果分类/teardown/exit/signal，以及可测得的毫秒级延迟指标），不含 prompt、argv、stderr 原文或认证凭据。 |

CLI 模式的任务正文作为独立 argv 元素传给官方 CLI。它不会经过 shell，但仍受操作系统命令行长度限制，并且在某些系统上可能被同机高权限用户通过进程列表看到；敏感、多用户主机应增加 OS 级隔离。默认 prompt 上限因此保守设为 128 KiB。Codex direct 不把 prompt 放进进程 argv，而是受独立的 `codex.maxRequestBytes` 限制。

DSH 的 skill catalog 更新是完整替换。CLI 模式序列化兼容 prompt 时，若最新目录明确带有 replacement 标记，插件只发送最新目录，不再重复发送它已经取代的旧目录；durable session 历史不会被改写。裁剪后仍超过 `maxPromptBytes` 时，插件返回标准 `CONTEXT_WINDOW_EXCEEDED`；宿主启用了自动 compaction 时，可据此先压缩历史再重试。Codex direct 则发送 typed Responses input，并对完整 JSON 请求和累计图片负载分别做字节限制。

## 排查

调用失败时会返回稳定的 `LlmError` code。常见对应关系：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `SUBSCRIPTION_AUTH_REQUIRED` | 调用前的认证门禁未通过（未登录，或检测到 API key / 非订阅来源） | 在同一 OS 用户下重新 `login`；CLI 模式确认没有把 API key 写进 `extraEnvNames`；Codex direct 还要确认 auth 文件是当前用户拥有的普通文件且权限不向 group/other 开放；Grok 需另设 `userVerifiedSubscription: true`（见「订阅认证优先」）。 |
| `LOCAL_SESSION_CWD_REQUIRED` | 请求没有匹配的 live loop session，或其 canonical cwd 与配置 cwd 不完全一致 | 从真实 DSH Agent Loop 发起调用；确认 session header cwd 与插件配置的 `cwd` 指向同一 realpath，且不要通过 symlink 跨出该目录。 |
| `CLI_NOT_FOUND` | 找不到可执行文件（`ENOENT`） | 核对该 provider 的 `command` 是否为正确的命令名/绝对路径，并确认它在 DSH 进程的 `PATH` 中。 |
| `CLI_WORKING_DIRECTORY` | Codex 拒绝了配置的工作目录，因为它不是可接受的 Git 仓库 | 把 profile 中的 `cwd` 改为目标 Git 仓库的绝对路径并重启 DSH；不要只根据 Web 会话显示的 cwd 推断子进程 cwd。 |
| `CONTEXT_WINDOW_EXCEEDED` | CLI prompt 超过本地限制，或 Codex direct 明确返回 `context_length_exceeded` | 若宿主已启用自动 compaction，可让其压缩后重试；否则手动缩短历史、skill 描述或 tool schema。只有确认对应边界足够时才调大本地限制。 |
| `CLI_TIMEOUT` | 单次 CLI 或 Codex direct 调用超过 `timeoutMs` | 简化 prompt，或调大 `timeoutMs`；CLI 模式还应确认官方客户端未卡在交互式提示上。 |
| `CLI_PROTOCOL_ERROR` | CLI 输出或 Codex private SSE 不符合当前有界协议（含畸形事件、字段冲突或缺失终态） | CLI 模式可手动复现并采集 fixture；direct 模式优先怀疑私有协议漂移。 |
| `CLI_FAILED` | 子进程非零退出或其他未归类失败 | 开 `logDiagnostics` 看脱敏 stderr 尾部；单独运行官方 CLI 复现。 |
| `QUOTA` | Codex direct 明确返回 `insufficient_quota` | 检查当前 ChatGPT/Codex 账号的可用额度；插件不会自动切换 provider。 |
| `EMPTY_RESPONSE` | direct 请求成功终止但没有文本、reasoning 或可执行 tool call | 重试前先检查私有协议是否发生变化；该错误不会伪装成空成功。 |
| `CODEX_DIRECT_PROVIDER_HTTP` | Responses 或 refresh endpoint 返回非认证类 HTTP 错误 | 查看 `failure.status`（如 429/503），按服务状态处理；不会触发通用自动重试。 |
| `CODEX_DIRECT_PROVIDER_FAILURE` | private SSE 明确报告未细分的 provider failure | 私有后端拒绝了本轮；诊断使用固定脱敏文案，不透传 provider message。 |
| `CODEX_DIRECT_CONTENT_FILTER` | private SSE 明确报告内容过滤 | 调整输入；插件不会把过滤结果当作普通空输出。 |
| `CODEX_DIRECT_TRANSPORT_ERROR` | 固定 endpoint 的 fetch/连接失败 | 检查网络、代理和 TLS；凭据与 prompt 不会写入错误。 |
| `CODEX_DIRECT_RESPONSES_FAILED` | 其他未归类的 direct 请求失败 | 确认 `transport` 是有意开启；私有协议可能已变化，不能假定稳定兼容。 |
| `INVALID_PROVIDER` | 选择了本插件未提供的 provider id | 只使用上表四个 `*-subscription` route。 |

插件**不会**在失败后自动切换 provider，也不做通用模型重试；唯一例外是 Codex direct 的 401 认证刷新后原请求单次重试。每次调用结算都会记录一条无凭据生命周期诊断（成功走 `debug`、失败走 `info`），可据此定位失败发生在哪个阶段。

### 采集真实 CLI fixture（维护者）

解析器按 `decode → 各 provider decoder → 归一化事件 → reducer` 分层，需要来自**明确 CLI 版本**的真实输出作为回归 golden。采集脚本已就绪：

```sh
node plugins/coding-subscription-provider/scripts/capture-cli-fixtures.mjs --help
```

脚本默认脱敏、需显式确认会消耗额度，产物落到 `tests/fixtures/<provider>/<version>/<scenario>.json`，`tests/fixtures.spec.ts` 在样本落地后自动激活。细节与脱敏清单见 [`tests/fixtures/README.md`](tests/fixtures/README.md)。

## 已知限制

- DSH `0.1.0-rc.8` 只有 `LlmAdapter` provider 接缝；本版因此是兼容适配，不是完整的 Agent Runtime。
- Claude、Cursor、Grok 以及默认 Codex CLI route 仍是 text-only，不能发出 tool call。请求携带非空 `tools` 时，这些 CLI 路径会在启动子进程前以 `tool_calls_unsupported` 明确失败；对应 route capability 为 `toolCalls: none`。
- 只有显式 opt-in 的 Codex direct route 发布 `toolCalls: native`。它只负责把原生 function call 交还 DSH；工具选择、参数审批、执行和结果回传仍受 Agent Loop / Policy 控制，provider 本身没有绕开策略执行本机工具的权限。
- Codex direct 只有在可选 attachment service 实际可用时才声明 `text + image`；否则仍为 text-only。音频、视频和任意文件都不支持。其图片与完整 JSON 请求有独立字节上限。
- Codex direct 的 auth 文件安全检查依赖 POSIX 所有权、链接数和权限位，因此当前不支持 Windows；Windows 仍使用默认 CLI transport。
- CLI 路径不提供供应商 token usage；`assistant-automations` 的周期 token 预算会按全额预留结算，详见该插件 README。Codex direct 会读取私有 Responses 终态中的 usage，但该字段同样属于不稳定协议。
- CLI 模式下，`temperature`、`stop`、`maxTokens` 等参数只能进入任务约束，不能保证与原生模型 API 等价。当前私有 Codex request schema 没有 `temperature` 或 `max_output_tokens`：direct route 对显式 `temperature` 和非空 `stop` fail closed；DSH Agent Loop 的 `maxTokens` 只作为宿主本地预算消费，不发送到私有 wire。
- Codex JSONL 当前主要提供事件级文本；解析器允许已识别事件旁出现向后兼容扩展，但若整条流只有未知/畸形事件、没有 assistant 文本或缺少规定终态，会返回 `CLI_PROTOCOL_ERROR`，不会产生空成功。
- 仅靠“不传 force / dontAsk / prompt 指令”不是强沙箱。需要处理不可信仓库时，应在容器、只读挂载或独立 OS 账号中运行 DSH。
- 插件没有远程共享、公共 HTTP 代理、token 导入或浏览器抓取能力。Codex direct 只封装一个固定私有 endpoint 与固定 refresh endpoint，不是可配置的通用认证代理。
- Cursor 目前只自动发现模型。其官方 headless CLI 尚未暴露可验证的 effort 参数；Max Mode/Thinking 变体不会伪装成 DSH effort，待上游提供机器可用控制面后再接入。
- Codex CLI 模式的 App Server、Claude SDK control 与 Grok ACP 只用于模型目录发现；这些生成路径仍使用各自一次性 CLI。Codex direct 不使用 App Server，也不做动态模型发现。Grok effective credential 绑定、动态 CLI 版本探测和持久外部会话属于后续阶段。

### Claude 合规提示

Anthropic 的技术文档允许 `claude -p` 使用订阅登录，但其法律与合规页面同时限制第三方产品代用户提供 Claude.ai 登录或路由 Free/Pro/Max 凭据。因此 Claude connector 只作为同机同用户的 experimental 委托：不提供登录、不托管 token、不做多租户。公开或商业部署前应自行取得适用授权；否则使用 DSH 已有的官方 API Key provider。

## 兼容性与调研

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness / `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session` `>=0.1.0-rc.8 <0.2.0`
- Cordis `^4.0.1`
- Codex CLI `0.147.0`（已验证；模型目录基于官方 [Codex App Server](https://developers.openai.com/codex/app-server) 的 `model/list`）
- Codex `direct-responses`（实验性私有协议；不是 OpenAI 面向第三方承诺的公开 API，兼容基线见 [compatibility.md](../../docs/compatibility.md)）
- `@deepseek-ai/dsh-attachment` `>=0.1.0-rc.8 <0.2.0`（可选；Codex direct 图片输入依赖该服务）
- Claude Code `2.1.218`（已验证；目录字段遵循官方 [Agent SDK `supportedModels()`](https://code.claude.com/docs/en/agent-sdk/typescript)）
- Grok Build `1.0.5`（已验证；目录与 effort 来自 ACP `initialize` 的 `modelState`，生成事件遵循官方 [headless `streaming-json`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md#streaming-json)）
- Cursor CLI：目录使用官方 [`--list-models`](https://cursor.com/changelog/cli-jan-08-2026)；本机未安装，依赖 fixture 验证

进一步阅读：[Codex 路由调研](../../docs/grok-bot-codex-router-research.md)、[插件生态与 Hermes/OpenClaw 对比](../../docs/dsh-personal-assistant-plugin-landscape.md)、[兼容基线](../../docs/compatibility.md)。
