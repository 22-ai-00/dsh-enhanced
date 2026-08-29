# @dsh-enhanced/traex-acp-provider

把同一台机器、同一 OS 用户已经登录的 TraeX / TRAE CLI 注册为 DeepSeek Harness 的 `traex-agent` provider。DSH 在这里是 **ACP client**：每次模型请求都会在校验 live Agent session 工作区后启动新的 `traex acp serve`、完成 ACP v1 握手、创建会话、校验模型/effort，并把握手目录作为非权威展示缓存。普通 `agent_message_chunk` 会映射为 DSH 文本；当请求带 DSH tool schema 时，TraeX 可以返回受控工具信封，插件把它转换成 DSH 原生 tool call，由 Harness 执行后进入下一 step。

启用时，插件会在同一个 `LlmRuntime` 上通过 `@dsh-enhanced/llm-route-capabilities` 发布 `traex-agent` 的 `toolCalls: bridge`，并随 Cordis fiber 撤回。这个字段只描述 adapter 如何把模型输出投影成标准 DSH tool call，不参与 Delivery/Automations 准入，也不改变模型可见的工具或 Skill；真正的工具授权与执行仍由统一的 Agent Loop、Policy、审批和 sandbox 负责。

这不是订阅 OAuth 转接，也不是模型 API provider。认证、模型供应、网络请求和可能产生的费用均由本机 TraeX 负责；插件不读取或托管 token。仓库中的 [`@dsh-enhanced/acp`](../acp) 方向正好相反——它让 DSH 自己成为供编辑器调用的 ACP agent。

## 前置条件

需要包含 ACP server 的 TraeX 版本。先在运行 DSH 的同一用户下检查：

```sh
traex --version
traex acp serve --help
traex login status
```

`--version` 只是人工兼容记录；运行时的机器门禁是精确 `login status` 加 ACP `initialize` 返回的 protocol / agent identity / auth method，不依赖对版本文本的宽松解析。

如命令名是 `trae-cli`，可在插件配置中覆盖 `command`。首次登录应在 DSH 外单独完成，例如本机版本提供的 `traex login --sso` 或 `traex login --sso-device`；插件不会启动交互式登录或打开浏览器。

公开的 ByteDance `trae-agent` Python 项目与这里检测到的 TraeX / TRAE CLI 不是同一个运行时。只有 `acp serve` 可用且握手返回 `agentInfo.name = "traex-acp"` 的实现会被本插件接受。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/traex-acp-provider
dsh --profile web --dump-config
```

该实验性 route 默认关闭。确认本机版本、登录和 ACP 入口后设置 `enabled: true`，再在 DSH 的 provider/model 选择处选择 `traex-agent`。首次打开模型选择器时，`listModels` 会自动执行一次不提交 prompt 的只读 ACP discovery，展示当前账号完整模型目录；并发查询共享同一次发现，短 TTL 内直接复用，过期后刷新。`default` 沿用 TraeX 当前模型。具体模型和 effort 都通过 ACP session config option 选择，不会拼进 shell 命令。

## 快速开始（5 步）

1. **确认 ACP 可用**：`traex acp serve --help` 能打开、`traex login status` 输出 `Logged in using Trae`。命令名是 `trae-cli` 时用它替换下面的 `traex`。
2. **安装插件**：`dsh plugin --profile web add @dsh-enhanced/traex-acp-provider`。
3. **开启 route**：本 route 默认关闭，需在配置里显式设 `enabled: true`（命令名不同则一并改 `command`）。bundle 已把 `cwd` 设为 `$DSH_HOME/assistant-workspace`，与标准 Delivery 的新会话工作区一致；若覆盖整段 `config`，必须保留该值或同时把两端改到同一目录。
4. **落盘检查**：`dsh --profile web --dump-config` 确认 `enabled`、`command` 与 `cwd` 生效。
5. **选择模型调用**：打开 DSH 模型选择器；首次查询会通过安全、无 prompt 的 ACP discovery 加载 `traex-agent` 完整目录。选 `default` 会沿用 TraeX 当前模型，也可直接选目录里的具体模型与 effort。

每次调用会启动一个新的 `traex acp serve` 进程并消耗 TraeX 侧额度。遇到报错先看下文「协议与失败策略」的错误码表。

## 配置

完整配置如下。Cordis `config` 会整段替换，覆盖时请保留仍需使用的字段：

```yaml
- id: dsh-enhanced-traex-acp-provider
  name: '@dsh-enhanced/traex-acp-provider'
  config:
    enabled: true
    command: traex
    cwd: !!js dshHomePath('assistant-workspace')
    models: [default]
    timeoutMs: 600000
    authProbeTimeoutMs: 10000
    maxAuthProbeBytes: 32768
    killGraceMs: 3000
    maxMessageBytes: 262144
    maxProtocolBytes: 16777216
    maxProtocolMessages: 10000
    maxOutputBytes: 2097152
    maxStderrBytes: 32768
    maxPromptBytes: 4194304
    extraEnvNames: []
    logDiagnostics: false
```

- `enabled` 默认 `false`；只在完成本机兼容性与登录检查后显式开启。
- `command` 是单个可执行文件名或绝对路径；插件固定参数数组并使用 `shell: false`，不接受 shell 片段。
- `cwd` 是 ACP `session/new` 允许使用的工作目录；bundle 默认使用 `$DSH_HOME/assistant-workspace`，与标准 Delivery 默认值一致。相对路径按 DSH 进程启动目录解析。每个**带 prompt 的普通对话调用**必须是深冻结的 DSH Agent Loop 请求：同模块 marker 可直接验证；包被源码 link 或 DSH 在 adapter 边界复制请求时，则由 Host `agents` 服务核对仍在运行的精确 Agent、registry/session 对象身份，并从 live Session 的 header 与 derived messages 重建请求，只容许 rc.8 `forAdapter()` 删除跨 route `replayState`。随后插件用同一 live Session 的 header cwd，与配置 cwd 分别 `realpath` 后要求完全相等。缺失、过期、伪造、辅助/嵌套调用、请求变形、cwd mismatch 或 symlink escape 都会在 `traex login status` 和 ACP 启动前以 `LOCAL_SESSION_CWD_REQUIRED` 拒绝；ACP 收到的是 canonical live-session cwd。Cordis `config` 是整段替换，手工覆盖时不要意外删掉 bundle 的 `cwd`；若改用其他目录，还要把创建该会话的 Delivery `defaultWorkspace` 改为同一 realpath。
- `listModels` 在缓存为空、过期或只有不完整的普通 stream 观察时，会通过当前 adapter 的 `probeReadiness` 执行 `traex login status` 和无 prompt 的 ACP discovery。它固定使用配置 cwd、read-only sandbox、`ask-for-approval=never`，不携带消息内容，不声明文件/terminal capability，并拒绝 permission request。并发查询 single-flight；完整目录在短 TTL 内复用，过期后刷新。发现失败时 `/model` 不会整体失败，而是安全回退到 `models` 配置别名，并只记录固定、无错误原文的诊断。
- `resolveModel` 仍然 **不认证、不启动子进程**，只读取配置与当前短 TTL 内存缓存，保证 Agent Loop 的 `prepareCall` 路径 process-free。真实 `stream` 不信任该展示缓存；它继续要求 live session + canonical cwd，并以自己新建 ACP session 的目录重新权威校验模型与 effort。
- 部署工具仍可在启用 route 前显式调用包导出的 `probeTraexReadiness`，主动验证本机登录和完整目录；调用完成后应 shutdown 临时 adapter。adapter shutdown 会 abort 尚未完成的目录发现、清除 single-flight 引用与缓存。
- `models` 是实时 ACP 目录以外需要额外展示的非权威别名列表，默认只有 `default`。它不是执行允许列表；每次请求都会在新的 ACP 会话里重新验证具体模型，模型不可用时失败且不会静默换模型。若 DSH 已放行的 effort 在新会话的 selector 中消失，transport 会保留当前模型并使用该会话的默认档位，绝不重放 prompt。
- `timeoutMs` 覆盖握手、建会话和整轮 prompt。取消或超时时先发 ACP `session/cancel` 和 `SIGINT`，等待 `killGraceMs` 后升级为 `SIGKILL`，再等待一个等长窗口确认 `close`。仍未关闭时以 `teardown=failed` 错误结算，保留原始 abort/timeout 分类，并继续跟踪迟到的 `close`；不会伪称已完成回收。
- `authProbeTimeoutMs` / `maxAuthProbeBytes` 限制每次 live-session 调用以及显式 readiness probe 的 `traex login status`；`authProbeTimeoutMs` 同时作为 `listModels` 的 auth + discovery 整体短时限，目录查询不会沿用生成请求默认 10 分钟的 `timeoutMs`。当前 TraeX 可能把精确文本 `Logged in using Trae` 单独写入 stdout 或 stderr，这两种形式都会被接受，混合输出、ChatGPT、API key、access token、未登录与未知输出全部拒绝。
- `maxMessageBytes` 限制单条 NDJSON，`maxProtocolBytes` / `maxProtocolMessages` 限制整轮 ACP 输入，`maxOutputBytes` 限制助手文本；字节限制均按 UTF-8 计算。
- `maxPromptBytes` 限制序列化后的 DSH 请求，默认 4 MiB。prompt 通过 ACP `session/prompt` 的文本块经 stdin 发送，**不作为 argv 元素**，因此这里不存在操作系统命令行长度限制；该上限只用于约束本机内存与 NDJSON 帧膨胀。真正的上下文边界由 TraeX 侧模型窗口决定。超限时在握手前失败，返回 DSH 标准的 `CONTEXT_WINDOW_EXCEEDED`，prompt 确定未进入 ACP 流；长对话若需要更大值可直接调高本项。
- `extraEnvNames` 只允许填写要从 DSH 启动环境继承的变量名，配置中不能写变量值或 secret。
- API key/token、Authorization/private-key/database credential 以及 OpenAI/Codex 等 provider endpoint 变量，即使列入 `extraEnvNames` 也会被硬排除；代理 URL 中的 userinfo 会被删除，无法安全解析的含 `@` 代理值会被拒绝。
- `logDiagnostics` 默认为 `false`，此时对 stderr 只记录“TraeX 写入 stderr”；启用后仅记录经过常见 token/key/邮箱规则脱敏的有界尾部，仍不适合输出业务秘密。独立于该开关，插件始终会在每次请求结算时记录一条**无凭据**的生命周期诊断（阶段、prompt 是否提交、结果分类、teardown 状态、能可靠测得的毫秒级延迟指标，以及 ACP 返回时的纯数值 usage 快照），成功走 `debug`、非成功走 `info`；并在观测到模型目录时只记录**模型数量**。这些行不含 prompt、stderr 原文、认证凭据或任何 model id 原文；usage 快照可能包含 ACP 报告的 token 数量，但不会映射或转发为 DSH `TokenUsage`。

## 固定安全策略

插件只接受并启动下面这一组 server 参数：

```text
traex --sandbox read-only --ask-for-approval never acp serve
```

不会传 `--yolo`、`bypass_permissions` 或任意用户追加参数。ACP client 不声明文件系统或 terminal capability；TraeX 发起的每个 `session/request_permission` 都返回 `cancelled`。TraeX 子进程自身因此不能通过本插件修改项目或运行命令。模型请求的 DSH tool call 会返回 Harness，由 Harness 既有的工具注册、sandbox、权限和审计链决定是否执行；插件不会替它放行。

安全仍取决于 TraeX 对其配置和沙箱的正确实现。不要把 prompt 约束当作操作系统隔离；处理不可信仓库时，仍应使用只读挂载、容器或独立 OS 账号。

## 权限与数据边界

| 能力 | 行为 |
|---|---|
| 文件系统 | 对 prompt-bearing 调用，只把经过 live-loop session 身份和 canonical `realpath` 精确校验的 cwd 发送给 TraeX，并强制 read-only sandbox。冷/过期的 `listModels` 可在配置的 static cwd 启动无 prompt、read-only/no-approval discovery；`resolveModel` 不启动进程。插件本身不提供 ACP 文件读写接口。 |
| 网络 | 插件本身不直连模型服务；TraeX 会连接自己的认证、推理、更新或遥测服务。 |
| 子进程 | 每次经过 live-session 校验的请求直接启动一个 TraeX ACP stdio 子进程，`shell: false`，并从同一握手观察目录。冷/过期的 `listModels` 或部署者显式调用 `probeTraexReadiness` 时，会另开无 prompt 临时 ACP 会话；并发列表查询只启动一个。取消/shutdown 时先 abort discovery 或走 ACP cancel，再回收进程组；Windows 后代进程回收为 best-effort。 |
| 凭据 | 不读取 TraeX auth 文件、不实现登录、不刷新或上传 token；只让 TraeX 在本机用户配置目录中使用自己的缓存凭据。 |
| 浏览器 | 插件不会打开浏览器；用户在插件外执行 TraeX login 时可能打开。 |
| ACP 权限 | 所有 permission request 均拒绝；不暴露 client-side FS、terminal 或 MCP server。 |
| DSH 工具 | 请求中的 tool schema 会进入模型隐藏的兼容协议；只接受本次实际声明的精确工具名和对象参数，随后映射为 DSH tool call。真正的读写、网络、子进程或外部服务权限仍由对应 DSH 工具及 Harness 策略控制。 |
| 日志 | 不主动记录 prompt；stderr 有界且默认不输出内容。每次请求结算记录一条无凭据生命周期诊断（阶段/提交状态/结果分类/teardown、可测得的毫秒级延迟指标，以及 ACP 返回时的纯数值 usage 快照），并在观测目录时只记录模型数量。均不含 prompt、stderr 原文、认证凭据或 model id 原文；usage 快照可能包含 ACP 报告的 token 数量。 |
| 安装脚本 | 包内没有 install/postinstall 脚本，也不会安装或更新 TraeX。 |

## 协议与失败策略

- 只接受 ACP protocol v1 和 `traex-acp` agent identity；版本或 identity 不符时 fail closed。
- SDK 前的 wire guard 会追踪 JSON-RPC request id；非法 envelope、未知/重复 response id、未声明的 filesystem/terminal request 和未知 notification 都会终止该轮，不交给 SDK 宽松处理。
- 只消费当前 session 的文本 `agent_message_chunk`；普通文本直接成为最终回复，严格匹配 `dsh-tool-calls/v1` 的信封会转换为 DSH tool call。thought、plan 和 TraeX 自己的 tool update 不会伪装成 DSH 输出。
- 工具信封只允许调用本次 `GenerateOptions.tools` 中存在的精确名称，参数必须是 JSON 对象；未知工具、空调用或畸形信封以 `ACP_PROTOCOL_ERROR` fail closed。截断终态不会执行工具信封。若模型误在合法信封前附加一小段进度说明，插件会只提取并隐藏该信封，避免原始 JSON 泄漏到对话界面；不含协议标记的普通 JSON 仍按文本处理。
- `end_turn`、`max_tokens`、`max_turn_requests` 是可完成终态；`refusal`、`cancelled`、断连、畸形/超限 NDJSON、无文本或缺少终态都会失败。
- TraeX 可能仍在 stderr 记录 `unsupported call` 一类内部工具路由告警；这是其内部工具未向本兼容层开放，不等同于 DSH 工具失败。插件会要求模型只返回 `dsh-tool-calls/v1` 信封；若调用仍失败，生命周期日志会同时给出 phase、terminal、exitCode 和 signal，便于区分终态缺失、协议校验与进程退出。
- 已保存的 effort 可能在切换模型、账号权益变化或目录更新后失效。此时插件在 `session/prompt` 前丢弃该陈旧值，使用本次 ACP session 返回的当前默认档位继续执行；不会重放 prompt 或重复计费，生命周期日志会标记 `reasoningFallback=true`。下次打开模型选择器会显示新目录。
- 不自动重试。外部 agent 可能已经读取上下文或产生服务端计费，自动重试会放大副作用。

调用失败时返回的稳定 `LlmError` code 与排查：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `ACP_AUTH_REQUIRED` | 每次调用前的 `traex login status` 未精确报告 `Logged in using Trae` | 在同一 OS 用户下重新 `traex login`；ChatGPT/API key/access token/未登录都会被拒。 |
| `LOCAL_SESSION_CWD_REQUIRED` | 请求没有匹配的 live loop session，或其 canonical cwd 与配置 cwd 不完全一致 | 从真实 DSH Agent Loop 发起调用；确认 session header cwd 与插件 `cwd` 指向同一 realpath，且不要通过 symlink 跨出该目录。 |
| `ACP_ENTITLEMENT_REQUIRED` | 握手成功但当前 Trae 账号没有任何可用模型 | 确认账号权益/套餐，必要时在 TraeX 侧切换账号。 |
| `ACP_MODEL_UNAVAILABLE` | 请求的模型不在本次 ACP 会话的 model selector 中 | 刷新模型列表或用 `default`；账号权益或 TraeX 目录可能已经变化。 |
| `ACP_REFUSAL` | TraeX 明确拒绝了本次请求 | 属模型侧决定，调整 prompt 后重试。 |
| `ACP_TIMEOUT` | 握手+建会话+整轮 prompt 超过 `timeoutMs` | 简化 prompt 或调大 `timeoutMs`。 |
| `ACP_OUTPUT_LIMIT` | 助手文本超过 `maxOutputBytes` | 调大 `maxOutputBytes` 或缩小任务。 |
| `ACP_PROTOCOL_ERROR` | protocol/identity 不符、非法 envelope、无文本或缺终态 | 确认 TraeX 版本仍提供 ACP v1 + `traex-acp` identity；升级后握手变化时插件会拒绝而非猜测。 |
| `ACP_PROCESS_FAILED` | 子进程非零退出或其他未归类失败 | 开 `logDiagnostics` 看脱敏 stderr；单独 `traex acp serve` 复现。 |
| `CONTEXT_WINDOW_EXCEEDED` | 序列化后的 DSH 请求超过 `maxPromptBytes`，在握手前失败 | 调大 `maxPromptBytes`，或压缩/清理对话历史；该上限只防本机内存膨胀，与 argv 长度无关。 |
| `ACP_PROMPT_INVALID` | 请求中含无法序列化的内容（如图片或未知 content block） | 本 route 是 text-only 兼容层；改用纯文本，或换用支持该模态的 provider。 |
| `CLI_NOT_FOUND` | 找不到可执行文件（`ENOENT`） | 核对 `command` 名称/路径及 `PATH`。 |
| `INVALID_PROVIDER` | 选择了非 `traex-agent` 的 provider id | 只使用 `traex-agent`。 |

- 认证不足会返回 `ACP_AUTH_REQUIRED`，无可用权益/模型分别映射为 `ACP_ENTITLEMENT_REQUIRED` / `ACP_MODEL_UNAVAILABLE`，明确拒绝映射为 `ACP_REFUSAL`；其他稳定错误包括 `ACP_PROTOCOL_ERROR`、`ACP_TIMEOUT`、`ACP_OUTPUT_LIMIT`、`ACP_PROCESS_FAILED`、`CONTEXT_WINDOW_EXCEEDED`、`ACP_PROMPT_INVALID` 和 `CLI_NOT_FOUND`。
- 握手前的 prompt 序列化失败（超限或含不支持的 content block）一律带稳定错误码抛出，不会退化为未分类失败；此时 prompt 确定未进入 ACP 流，重试安全。

> 模型目录：`listModels` 在冷启动、TTL 到期或仅有不完整观察时调用 `probeReadiness`，以 prompt-free、read-only/no-approval ACP session 加载完整目录；并发调用 single-flight，成功结果短 TTL 复用，失败则返回配置别名且只留固定诊断。`resolveModel` 始终只读缓存、不做 I/O。每次真实调用仍以自己的 `session/new` 返回值为唯一执行依据，重新选择并核对模型与 effort；auth 失败、reload 或 shutdown 会清除缓存。目录日志只输出模型数量，不含 model id 原文。

## 已知限制

- DSH `0.1.0-rc.8` 暴露的是 `LlmAdapter` seam，因此工具调用通过模型隐藏的严格 JSON 信封桥接，不是 TraeX 原生 tool update，也不是完整 ACP UI。TraeX 的 plan、diff、permission UI、会话列表和富内容不会进入 DSH。
- 每次 DSH 请求使用一个新的 TraeX 进程和 ACP session，不恢复外部历史；完整 DSH 对话会被序列化进 prompt。
- 暂不转发图片、音频或 TraeX token usage。DSH tool schema 会随每一步序列化，工具结果则通过下一步的完整 DSH 对话返回给模型；实验性的 ACP `PromptResponse.usage` 只保留显式数值字段用于内部诊断，不会映射或发送为 DSH usage chunk。
- TraeX 是变化中的开发工具；本实现以本机 `traecli 0.201.1 (internal edition)` 的 ACP v1 握手、逐模型 reasoning selector 与官方 ACP SDK `0.25.1` 为验证基线。升级后若 identity、模型/effort selector 或终态变化，插件会拒绝而不是猜测兼容。

## 兼容性与调研

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness / `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session` `>=0.1.0-rc.8 <0.2.0`
- Cordis `^4.0.1`
- Agent Client Protocol SDK `0.25.1`，protocol version `1`

进一步阅读：[两个 provider 的 ACP 边界与优化调研](../../docs/cliproxyapi-provider-optimization-research.md)、[兼容基线](../../docs/compatibility.md)。
