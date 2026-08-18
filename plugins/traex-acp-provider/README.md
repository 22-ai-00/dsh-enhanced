# @dsh-enhanced/traex-acp-provider

把同一台机器、同一 OS 用户已经登录的 TraeX / TRAE CLI 注册为 DeepSeek Harness 的 `traex-agent` provider。DSH 在这里是 **ACP client**：每次模型请求都会启动 `traex acp serve`、完成 ACP v1 握手、创建会话、发送 prompt，并只把 `agent_message_chunk` 文本映射回 DSH。

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

该实验性 route 默认关闭。确认本机版本、登录和 ACP 入口后设置 `enabled: true`，再在 DSH 的 provider/model 选择处选择 `traex-agent/default`。`default` 保留 TraeX 当前模型；配置其他模型 id 后，插件会通过 ACP 的 `category: model` 会话选项选择它，不会把模型拼进 shell 命令。

## 快速开始（5 步）

1. **确认 ACP 可用**：`traex acp serve --help` 能打开、`traex login status` 输出 `Logged in using Trae`。命令名是 `trae-cli` 时用它替换下面的 `traex`。
2. **安装插件**：`dsh plugin --profile web add @dsh-enhanced/traex-acp-provider`。
3. **开启 route**：本 route 默认关闭，需在配置里显式设 `enabled: true`（命令名不同则一并改 `command`）。
4. **落盘检查**：`dsh --profile web --dump-config` 确认 `enabled` 与 `command` 生效。
5. **选择模型调用**：在 DSH 里选 `traex-agent` + `default`（沿用 TraeX 当前模型）。要用具体模型，先把它加进 `models` 允许列表，且该 id 必须同时出现在 TraeX 会话的 model selector 中。

每次调用会启动一个新的 `traex acp serve` 进程并消耗 TraeX 侧额度。遇到报错先看下文「协议与失败策略」的错误码表。

## 配置

完整配置如下。Cordis `config` 会整段替换，覆盖时请保留仍需使用的字段：

```yaml
- id: dsh-enhanced-traex-acp-provider
  name: '@dsh-enhanced/traex-acp-provider'
  config:
    enabled: true
    command: traex
    cwd: .
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
    maxPromptBytes: 131072
    extraEnvNames: []
    logDiagnostics: false
```

- `enabled` 默认 `false`；只在完成本机兼容性与登录检查后显式开启。
- `command` 是单个可执行文件名或绝对路径；插件固定参数数组并使用 `shell: false`，不接受 shell 片段。
- `cwd` 是 ACP `session/new` 的工作目录；相对路径按 DSH 进程启动目录解析。
- `models` 是部署者配置的允许列表（插件策略，非 DSH 要求）。`default` 使用 TraeX 当前模型；非 `default` 值必须同时出现在本列表和 TraeX 会话返回的 ACP model selector 中，否则请求失败，不会静默换模型。
- `timeoutMs` 覆盖握手、建会话和整轮 prompt。取消或超时时先发 ACP `session/cancel` 和 `SIGINT`，等待 `killGraceMs` 后升级为 `SIGKILL`，再等待一个等长窗口确认 `close`。仍未关闭时以 `teardown=failed` 错误结算，保留原始 abort/timeout 分类，并继续跟踪迟到的 `close`；不会伪称已完成回收。
- `authProbeTimeoutMs` / `maxAuthProbeBytes` 限制每次调用前的 `traex login status`；只有精确报告 `Logged in using Trae` 才会进入 ACP，ChatGPT、API key、access token、未登录与未知输出全部拒绝。
- `maxMessageBytes` 限制单条 NDJSON，`maxProtocolBytes` / `maxProtocolMessages` 限制整轮 ACP 输入，`maxOutputBytes` 限制助手文本；字节限制均按 UTF-8 计算。
- `extraEnvNames` 只允许填写要从 DSH 启动环境继承的变量名，配置中不能写变量值或 secret。
- API key/token、Authorization/private-key/database credential 以及 OpenAI/Codex 等 provider endpoint 变量，即使列入 `extraEnvNames` 也会被硬排除；代理 URL 中的 userinfo 会被删除，无法安全解析的含 `@` 代理值会被拒绝。
- `logDiagnostics` 默认为 `false`，此时对 stderr 只记录“TraeX 写入 stderr”；启用后仅记录经过常见 token/key/邮箱规则脱敏的有界尾部，仍不适合输出业务秘密。独立于该开关，插件始终会在每次请求结算时记录一条**无凭据**的生命周期诊断（阶段、prompt 是否提交、结果分类、teardown 状态、能可靠测得的毫秒级延迟指标，以及 ACP 返回时的纯数值 usage 快照），成功走 `debug`、非成功走 `info`；并在观测到模型目录时只记录**模型数量**。这些行不含 prompt、stderr 原文、认证凭据或任何 model id 原文；usage 快照可能包含 ACP 报告的 token 数量，但不会映射或转发为 DSH `TokenUsage`。

## 固定安全策略

插件只接受并启动下面这一组 server 参数：

```text
traex --sandbox read-only --ask-for-approval never acp serve
```

不会传 `--yolo`、`bypass_permissions` 或任意用户追加参数。ACP client 不声明文件系统或 terminal capability；TraeX 发起的每个 `session/request_permission` 都返回 `cancelled`。这让兼容 provider 默认只能读取上下文并返回文本，不应修改项目或运行需要授权的操作。

安全仍取决于 TraeX 对其配置和沙箱的正确实现。不要把 prompt 约束当作操作系统隔离；处理不可信仓库时，仍应使用只读挂载、容器或独立 OS 账号。

## 权限与数据边界

| 能力 | 行为 |
|---|---|
| 文件系统 | 把规范化后的 `cwd` 发送给 TraeX，并强制 read-only sandbox；插件本身不提供 ACP 文件读写接口。TraeX 可以读取工作区以完成任务。 |
| 网络 | 插件本身不直连模型服务；TraeX 会连接自己的认证、推理、更新或遥测服务。 |
| 子进程 | 每次请求直接启动一个 TraeX ACP stdio 子进程，`shell: false`。取消时先走 ACP，再回收进程组；Windows 后代进程回收为 best-effort。 |
| 凭据 | 不读取 TraeX auth 文件、不实现登录、不刷新或上传 token；只让 TraeX 在本机用户配置目录中使用自己的缓存凭据。 |
| 浏览器 | 插件不会打开浏览器；用户在插件外执行 TraeX login 时可能打开。 |
| ACP 权限 | 所有 permission request 均拒绝；不暴露 client-side FS、terminal 或 MCP server。 |
| 日志 | 不主动记录 prompt；stderr 有界且默认不输出内容。每次请求结算记录一条无凭据生命周期诊断（阶段/提交状态/结果分类/teardown、可测得的毫秒级延迟指标，以及 ACP 返回时的纯数值 usage 快照），并在观测目录时只记录模型数量。均不含 prompt、stderr 原文、认证凭据或 model id 原文；usage 快照可能包含 ACP 报告的 token 数量。 |
| 安装脚本 | 包内没有 install/postinstall 脚本，也不会安装或更新 TraeX。 |

## 协议与失败策略

- 只接受 ACP protocol v1 和 `traex-acp` agent identity；版本或 identity 不符时 fail closed。
- SDK 前的 wire guard 会追踪 JSON-RPC request id；非法 envelope、未知/重复 response id、未声明的 filesystem/terminal request 和未知 notification 都会终止该轮，不交给 SDK 宽松处理。
- 只转发当前 session 的文本 `agent_message_chunk`；thought、plan、tool update 不会伪装成模型文本。
- `end_turn`、`max_tokens`、`max_turn_requests` 是可完成终态；`refusal`、`cancelled`、断连、畸形/超限 NDJSON、无文本或缺少终态都会失败。
- 不自动重试。外部 agent 可能已经读取上下文或产生服务端计费，自动重试会放大副作用。

调用失败时返回的稳定 `LlmError` code 与排查：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `ACP_AUTH_REQUIRED` | 每次调用前的 `traex login status` 未精确报告 `Logged in using Trae` | 在同一 OS 用户下重新 `traex login`；ChatGPT/API key/access token/未登录都会被拒。 |
| `ACP_ENTITLEMENT_REQUIRED` | 握手成功但当前 Trae 账号没有任何可用模型 | 确认账号权益/套餐，必要时在 TraeX 侧切换账号。 |
| `ACP_MODEL_UNAVAILABLE` | 请求的模型不在本次 ACP 会话的 model selector 中 | 用 `default`，或确认该 model id 同时在 `models` 允许列表和 TraeX 当前 selector 里。 |
| `MODEL_NOT_FOUND` | 请求的模型不在部署者 `models` 允许列表中 | 把该 id 加入 `models`（它仍需被 TraeX 会话提供）。 |
| `ACP_REFUSAL` | TraeX 明确拒绝了本次请求 | 属模型侧决定，调整 prompt 后重试。 |
| `ACP_TIMEOUT` | 握手+建会话+整轮 prompt 超过 `timeoutMs` | 简化 prompt 或调大 `timeoutMs`。 |
| `ACP_OUTPUT_LIMIT` | 助手文本超过 `maxOutputBytes` | 调大 `maxOutputBytes` 或缩小任务。 |
| `ACP_PROTOCOL_ERROR` | protocol/identity 不符、非法 envelope、无文本或缺终态 | 确认 TraeX 版本仍提供 ACP v1 + `traex-acp` identity；升级后握手变化时插件会拒绝而非猜测。 |
| `ACP_PROCESS_FAILED` | 子进程非零退出或其他未归类失败 | 开 `logDiagnostics` 看脱敏 stderr；单独 `traex acp serve` 复现。 |
| `CLI_NOT_FOUND` | 找不到可执行文件（`ENOENT`） | 核对 `command` 名称/路径及 `PATH`。 |
| `INVALID_PROVIDER` | 选择了非 `traex-agent` 的 provider id | 只使用 `traex-agent`。 |

- 认证不足会返回 `ACP_AUTH_REQUIRED`，无可用权益/模型分别映射为 `ACP_ENTITLEMENT_REQUIRED` / `ACP_MODEL_UNAVAILABLE`，明确拒绝映射为 `ACP_REFUSAL`；其他稳定错误包括 `ACP_PROTOCOL_ERROR`、`ACP_TIMEOUT`、`ACP_OUTPUT_LIMIT`、`ACP_PROCESS_FAILED` 和 `CLI_NOT_FOUND`。

> 模型目录诊断：插件会在正常握手中观察 TraeX 的 model selector，并在内存里做一份**完全非权威**、带短 TTL 的缓存，仅供诊断/展示。它**不**参与模型解析、**不**放行或拒绝请求——每次调用仍以本次 `session/new` 返回的目录为唯一依据；auth 失败、reload 或版本变化时该缓存失效。日志只输出观察到的**模型数量**，不含 model id 原文。

## 已知限制

- DSH `0.1.0-rc.6` 暴露的是 `LlmAdapter` seam，因此本版是 text-only 兼容层，不是完整 ACP UI。TraeX 的 plan、tool call、diff、permission UI、会话列表和富内容不会进入 DSH。
- 每次 DSH 请求使用一个新的 TraeX 进程和 ACP session，不恢复外部历史；完整 DSH 对话会被序列化进 prompt。
- 暂不转发图片、音频、DSH tool schema 或 TraeX token usage。实验性的 ACP `PromptResponse.usage` 只保留显式数值字段用于内部诊断，不会映射或发送为 DSH usage chunk。
- TraeX 是变化中的开发工具；本实现以本机 `traecli 0.200.19 (internal edition)` 的 ACP v1 握手与官方 ACP SDK `0.25.1` 为验证基线。升级后若 identity、模型 selector 或终态变化，插件会拒绝而不是猜测兼容。

## 兼容性与调研

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness / `@deepseek-ai/dsh-llm` `>=0.1.0-rc.6 <0.2.0`
- Cordis `^4.0.1`
- Agent Client Protocol SDK `0.25.1`，protocol version `1`

TraeX、本机能力探测、公开 `trae-agent` 与 ACP 边界见 [调研记录](../../docs/traex-acp-connector-research.md)；仓库基线见 [compatibility.md](../../docs/compatibility.md)。
